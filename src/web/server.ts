import express from "express";
import http from "node:http";
import path from "node:path";
import cookieParser from "cookie-parser";
import { WebSocketServer } from "ws";
import type { BotManager } from "../bot/manager.js";
import type { MusicProvider } from "../music/provider.js";
import type { BotDatabase } from "../data/database.js";
import type { BotConfig, GuestModeConfig } from "../data/config.js";
import type { Logger } from "../logger.js";
import type { CookieStore } from "../music/auth.js";
import type { AvatarStore } from "../data/avatars.js";
import { createBotRouter } from "./api/bot.js";
import { createMusicRouter } from "./api/music.js";
import { createPlayerRouter } from "./api/player.js";
import { createAuthRouter } from "./api/auth.js";
import { createSessionRouter } from "./api/session.js";
import { createUsersRouter } from "./api/users.js";
import { createAuditStore } from "../data/audit.js";
import { createAuditRouter } from "./api/audit.js";
import { createFavoritesRouter } from "./api/favorites.js";
import { createSavedQueuesRouter } from "./api/saved-queues.js";
import { createSpotifyRouter } from "./api/spotify.js";
import type { SpotifyOAuth } from "../music/spotify/spotify-oauth.js";
import type { SpotifyProvider } from "../music/spotify/provider.js";
import type { JellyfinProvider } from "../music/jellyfin.js";
import { resolveSpotifyBackendKind } from "../music/spotify/backend-select.js";
import {
  isGoLibrespotPresent,
  isLibrespotPresent,
} from "../music/spotify/binary.js";
import { setupWebSocket } from "./websocket.js";
import { createUserStore } from "../data/users.js";
import { createSessionStore } from "../data/sessions.js";
import { createPermissionStore } from "../data/permissions.js";
import { createRequireAuth } from "./middleware/requireAuth.js";
import { requireAdmin } from "./middleware/requireAdmin.js";
import { requireNotGuest } from "./middleware/requireNotGuest.js";
import { csrfOriginCheck } from "./middleware/csrf.js";
import { createRateLimit } from "./middleware/rateLimit.js";
import { validateSessionFromHeaders } from "./auth/validateSession.js";

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface WebServerOptions {
  port: number;
  botManager: BotManager;
  neteaseProvider: MusicProvider;
  qqProvider: MusicProvider;
  bilibiliProvider: MusicProvider;
  localProvider: MusicProvider;
  kugouProvider: MusicProvider;
  spotifyProvider: MusicProvider;
  jellyfinProvider: MusicProvider;
  database: BotDatabase;
  config: BotConfig;
  configPath: string;
  logger: Logger;
  cookieStore?: CookieStore;
  avatarStore: AvatarStore;
  staticDir?: string;
  /** Process-wide shared Spotify OAuth (single account, Stage 3). When set, the
   *  /api/spotify {login,callback,status} router is mounted. */
  spotifyOAuth?: SpotifyOAuth;
}

export interface WebServer {
  start(): Promise<void>;
  stop(): void;
}

export function createWebServer(options: WebServerOptions): WebServer {
  const app = express();
  const server = http.createServer(app);
  const logger = options.logger.child({ component: "web" });

  if (options.config.trustProxy) {
    // Keep Express's permissive `true` so multi-hop deployments
    // (Cloudflare -> nginx -> app) resolve req.ip to the REAL client and every
    // user keeps their own rate-limit bucket. Pinning this to a hop count (1)
    // would make req.ip the CDN/proxy address for two-or-more-hop setups and
    // collapse /setup and /guest into ONE shared bucket for all visitors.
    //
    // Known trade-off, documented rather than silently changed: with `true`
    // Express uses the LEFTMOST X-Forwarded-For entry, which a client can set.
    // That only matters if the fronting proxy APPENDS to XFF instead of
    // replacing it; nginx's `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`
    // does append, so bind the app to the proxy (do not expose webPort publicly)
    // if per-IP throttling must be trustworthy.
    app.set("trust proxy", true);
  }

  // Canonical origin for CSRF host comparison (config.publicUrl when set), so
  // the check does not compare two client-supplied headers against each other.
  const canonicalHost = (() => {
    const raw = (options.config.publicUrl ?? "").trim();
    if (!raw) return null;
    try {
      return new URL(raw).host;
    } catch {
      logger.warn({ publicUrl: raw }, "publicUrl is not a valid URL — ignoring for CSRF host check");
      return null;
    }
  })();
  if (canonicalHost) app.set("canonicalHost", canonicalHost);

  // Security headers:
  //  • X-Frame-Options / CSP frame-ancestors — prevent the WebUI from being
  //    embedded in a third-party iframe (clickjacking defence). CSP
  //    frame-ancestors is the modern equivalent of X-Frame-Options; both are
  //    set for compatibility across browsers.
  //  • X-Robots-Tag — keep deployed instances out of search-engine indexes
  //    (issue #128: searching "TsmusicBot" surfaced strangers' WebUI URLs).
  //    Set on EVERY response so JSON/API responses and the SPA shell are all
  //    covered; complements /robots.txt and the <meta name="robots"> tag.
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    // The SPA renders provider-supplied metadata (song/artist/album names), so
    // these are the cheap second line of defence against stored XSS.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  app.use(express.json({ limit: "400kb" }));
  app.use(cookieParser());

  const users = createUserStore(options.database.db);
  const sessions = createSessionStore(options.database.db);
  const audit = createAuditStore(options.database.db);
  const permissions = createPermissionStore(options.database.db);

  // ─── Public routes (no auth, no CSRF) ───────────────────────────────────
  // Disallow every crawler (issue #128). Declared before the static SPA
  // fallback so this wins over index.html for /robots.txt. Belt-and-braces
  // with the X-Robots-Tag header above and the <meta name="robots"> tag.
  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /\n");
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version: "0.1.0" });
  });

  // Public on purpose: the login/guest screen needs the base URL before it has a
  // session. Only the ORIGIN is disclosed — an unauthenticated caller must not
  // learn internal paths or a proxied hostname.
  app.get("/api/config/public-url", (_req, res) => {
    const raw = (options.config.publicUrl ?? "").trim();
    if (!raw) {
      res.json({ publicUrl: null });
      return;
    }
    // Return the operator-configured URL as-is (minus trailing slashes). An
    // earlier revision reduced this to `new URL(raw).origin`, which silently
    // dropped a sub-path deployment (https://host/music -> https://host) and
    // broke the share links built from it.
    res.json({ publicUrl: raw.replace(/\/+$/, "") });
  });

  // ─── CSRF protection for all mutating API requests ──────────────────────
  app.use("/api", csrfOriginCheck);

  // Anti-DoS: throttle auth endpoints.
  // 5 req per minute per (IP + username) for /login to avoid subnet-wide lockouts.
  // 3 req per minute per IP for /setup (more limited; first-run is rare).
  // 10 req per minute per IP for /guest.
  const loginLimit = createRateLimit({
    capacity: 5,
    refillPerSec: 5 / 60,
    keyFn: (req) => `${req.ip}:${String(req.body?.username ?? "").trim().toLowerCase()}`,
  });
  const setupLimit = createRateLimit({ capacity: 3, refillPerSec: 3 / 60 });
  const guestLimit = createRateLimit({ capacity: 10, refillPerSec: 10 / 60 });
  app.use("/api/session/login", loginLimit);
  app.use("/api/session/setup", setupLimit);
  app.use("/api/session/guest", guestLimit);

  // WebSocket sockets authenticate ONCE at upgrade, so a logout / permission
  // revocation never reached the already-open socket. Both routers below are
  // mounted before the WS controller exists, so bridge them with a mutable
  // indirection wired to the real implementation once setupWebSocket runs.
  let onUserAccessRevoked: (userId: string) => void = () => {};

  app.use(
    "/api/session",
    createSessionRouter(
      users,
      sessions,
      audit,
      logger,
      permissions,
      () => options.config.guestMode,
      (userId) => onUserAccessRevoked(userId),
    ),
  );

  // ─── Gates for everything else under /api ───────────────────────────────
  const requireAuth = createRequireAuth(sessions, permissions, () => options.config.guestMode);
  app.use("/api", requireAuth);

  // ─── Protected routes ───────────────────────────────────────────────────
  // The bot router is mounted BEFORE setupWebSocket runs, but its /settings
  // handler needs to trigger a guest-policy refresh on the (later-created) WS
  // controller. Bridge the two with a mutable indirection that starts as a
  // no-op and is wired to the real refreshGuestPolicy once the WS is set up.
  let onGuestPolicyChanged: (cfg: GuestModeConfig) => void = () => {};
  app.use(
    "/api/bot",
    createBotRouter(
      options.botManager,
      options.config,
      options.configPath,
      logger,
      options.database,
      options.avatarStore,
      (cfg) => onGuestPolicyChanged(cfg),
      // I2: so saving a Client ID in Settings re-configures the live OAuth
      // (no restart needed for the UI-entered-creds -> Connect flow).
      options.spotifyOAuth,
      // R2-4: so saving Spotify creds in Settings also refreshes the live Web API
      // search provider (search + getAuthStatus) without a process restart. The
      // runtime object is a SpotifyProvider (see index.ts); WebServerOptions types
      // it as the wider MusicProvider, so narrow it here for the setCreds contract.
      options.spotifyProvider as SpotifyProvider,
      // Same live-reconfigure contract for Jellyfin: a Settings save re-points
      // the connection without a restart. Runtime object is a JellyfinProvider
      // (see index.ts); WebServerOptions types it as the wider MusicProvider.
      options.jellyfinProvider as JellyfinProvider,
    )
  );
  app.use(
    "/api/music",
    createMusicRouter(options.neteaseProvider, options.qqProvider, options.bilibiliProvider, logger, options.localProvider, options.config, options.kugouProvider, options.spotifyProvider, options.jellyfinProvider, options.configPath)
  );
  app.use("/api/player", createPlayerRouter(
    options.botManager, logger, options.database,
    options.neteaseProvider, options.qqProvider, options.bilibiliProvider,
  ));
  app.use(
    "/api/auth",
    createAuthRouter(options.neteaseProvider, options.qqProvider, options.bilibiliProvider, logger, options.cookieStore, options.kugouProvider, options.spotifyProvider, options.jellyfinProvider, options.config)
  );
  if (options.spotifyOAuth) {
    app.use(
      "/api/spotify",
      createSpotifyRouter({
        oauth: options.spotifyOAuth,
        logger,
        getBackendInfo: () => {
          // PATH-aware presence (Bug m1): a PATH-installed binary (bare name)
          // is resolved against $PATH, not existsSync()'d against cwd.
          const goPresent = isGoLibrespotPresent();
          const rustPresent = isLibrespotPresent();
          const resolved = resolveSpotifyBackendKind(
            options.config.spotify.backend,
            goPresent,
            rustPresent,
          );
          return {
            backend: resolved ?? "none",
            deviceName: options.config.spotify.deviceName,
            binaryAvailable: resolved !== null,
          };
        },
        webUiRedirect: "/",
      }),
    );
  }
  app.use("/api/favorites", requireNotGuest, createFavoritesRouter(options.database, logger));
  // Saved queues (Feature 1, #119). Members + admins only (requireNotGuest);
  // the router itself 403s every route unless savedQueuesEnabled is on.
  app.use(
    "/api/saved-queues",
    requireNotGuest,
    createSavedQueuesRouter(
      options.database,
      options.botManager,
      () => options.config.savedQueuesEnabled,
      logger,
    ),
  );

  // admin-only routes
  app.use(
    "/api/users",
    requireAdmin,
    createUsersRouter(users, sessions, audit, logger, permissions, (userId) =>
      onUserAccessRevoked(userId),
    ),
  );
  app.use("/api/audit", requireAdmin, createAuditRouter(audit));

  // ─── Terminal error handler ─────────────────────────────────────────────
  // Express 5 forwards rejected async handlers here. WITHOUT this handler they
  // reach Express's default one, which (unless NODE_ENV=production, which this
  // project never sets) answers with an HTML page containing the stack trace
  // and absolute server paths. Always answer JSON, and log the detail
  // server-side instead of shipping it to the client.
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = (err as { status?: number; statusCode?: number })?.status
      ?? (err as { statusCode?: number })?.statusCode;
    const code = typeof status === "number" && status >= 400 && status < 600 ? status : 500;
    logger.error({ err, method: req.method, url: req.originalUrl }, "Unhandled request error");
    res.status(code).json({ error: code >= 500 ? "internal error" : "request failed" });
  });

  // ─── Static SPA (public) ────────────────────────────────────────────────
  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.get(/^(?!\/api|\/ws)/, (_req, res) => {
      res.sendFile(path.join(options.staticDir!, "index.html"));
    });
  }

  server.on("error", (err) => {
    logger.error({ err }, "HTTP server error");
  });

  // ─── WebSocket with manual upgrade auth ────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });
  wss.on("error", (err) => {
    logger.error({ err }, "WebSocket server error");
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }
    const reqHost = req.headers.host;
    const originHeader = req.headers.origin;
    if (originHeader) {
      let originHost: string | null = null;
      try {
        originHost = new URL(originHeader).host;
      } catch {
        // fall through; treat as missing/invalid origin
      }
      if (!originHost || originHost !== reqHost) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const result = validateSessionFromHeaders(req.headers.cookie as string | undefined, sessions);
    if (!result) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Guest sessions are only valid while guest mode is enabled.
    if (result.role === "guest" && !options.config.guestMode.enabled) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const guestBots = options.config.guestMode.bots;
    let botScope: "all" | Set<string> = "all";
    if (result.role === "guest") {
      botScope = guestBots === "all" ? "all" : new Set(guestBots);
    } else if (result.role === "member") {
      const access = permissions.getBotAccess(result.userId);
      botScope = access === "all" ? "all" : new Set(access);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const w = ws as unknown as { userId: string; isGuest: boolean; botScope: "all" | Set<string> };
      w.userId = result.userId;
      w.isGuest = result.role === "guest";
      w.botScope = botScope;
      wss.emit("connection", ws, req);
    });
  });
  const controller = setupWebSocket(wss, options.botManager, logger);
  onGuestPolicyChanged = controller.refreshGuestPolicy;
  // Now that the WS controller exists, wire the logout / permission-revocation
  // sweep. The client's useWebSocket auto-reconnects, so the socket comes back
  // with freshly-resolved scope instead of the stale upgrade-time snapshot.
  onUserAccessRevoked = (userId) => controller.closeUserSockets(userId);

  // ─── Session cleanup interval ──────────────────────────────────────────
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  return {
    async start(): Promise<void> {
      if (server.listening) return;
      return new Promise((resolve, reject) => {
        const onError = (err: Error) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          logger.info({ port: options.port }, "Web server started");
          cleanupTimer = setInterval(() => {
            try {
              sessions.cleanupExpired();
            } catch (err) {
              logger.error({ err }, "session cleanup failed");
            }
          }, SESSION_CLEANUP_INTERVAL_MS);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        try {
          server.listen(options.port);
        } catch (err) {
          server.removeListener("error", onError);
          server.removeListener("listening", onListening);
          reject(err);
        }
      });
    },
    stop(): void {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      controller.cleanup();
      wss.close();
      server.close();
    },
  };
}
