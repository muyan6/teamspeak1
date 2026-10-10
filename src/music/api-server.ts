import net from "node:net";
import type { Logger } from "../logger.js";
import type { Server } from "node:http";

export interface ApiServerOptions {
  neteasePort: number;
  qqMusicPort: number;
  /** Provider gating (#enabledProviders): when false, the corresponding
   *  embedded sidecar API server is never started and its port never bound. */
  neteaseEnabled?: boolean;
  qqEnabled?: boolean;
  /**
   * P2-30: by default the manager refuses to adopt a sidecar port it did not
   * bind itself (`getNeteaseBaseUrl()`/`getQQMusicBaseUrl()` point straight at
   * a loopback port; any local process that bound it first would receive the
   * account cookie). Set this — or `TSMB_ALLOW_EXTERNAL_MUSIC_API=1` — only
   * when you deliberately front an external NetEase/QQ API instance.
   */
  allowExternalApi?: boolean;
}

export interface ApiServerManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  getNeteaseBaseUrl(): string;
  getQQMusicBaseUrl(): string;
}

/**
 * Classify a QQ Music API (@sansenjian/qq-music-api) startup failure into
 * actionable operator guidance, or null when it isn't a recognised
 * dependency/runtime mismatch. Exported for testing.
 *
 * Background: the package became ESM in 2.3.x. A loose `^` range could pull an
 * ESM-only build (2.3.0/2.3.1) that throws ERR_REQUIRE_ESM, or a 2.4.x build
 * that needs Node >=20.17 — either way the embedded server never binds, so
 * every QQ request fails downstream with ECONNREFUSED on the API port.
 */
export function describeQqApiStartupError(err: unknown): string | null {
  const e = (err ?? {}) as { code?: string; message?: string };
  const code = String(e.code ?? "");
  const msg = String(e.message ?? "");
  if (code === "ERR_REQUIRE_ESM" || /ERR_REQUIRE_ESM|require\(\) of ES ?Module/i.test(msg)) {
    return (
      "an incompatible @sansenjian/qq-music-api build is installed (ERR_REQUIRE_ESM). " +
      "Pin it to ~2.4.0 (needs Node >=20.17) or ~2.2.10 in package.json, then reinstall"
    );
  }
  if (/Unsupported engine|EBADENGINE|requires Node|Node\.js version/i.test(msg)) {
    return "@sansenjian/qq-music-api 2.4.x requires Node >=20.17 (or >=22.9) — upgrade Node, or pin the package to ~2.2.10";
  }
  return null;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      server.close(() => resolve(false));
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

export function createApiServerManager(
  options: ApiServerOptions,
  logger: Logger
): ApiServerManager {
  let neteaseServer: Server | null = null;
  let qqMusicServer: Server | null = null;

  const neteaseBaseUrl = `http://127.0.0.1:${options.neteasePort}`;
  const qqMusicBaseUrl = `http://127.0.0.1:${options.qqMusicPort}`;

  return {
    async start(): Promise<void> {
      // Provider gating: with the jellyfin-only default config neither legacy
      // sidecar starts, so ports 3001/3200 are never opened.
      if (options.neteaseEnabled === false && options.qqEnabled === false) {
        logger.info("NetEase/QQ providers disabled — embedded music API servers not started");
        return;
      }
      logger.info("Starting embedded music API servers...");

      // P2-30: we cannot run a real identity handshake against the third-party
      // sidecars (NeteaseCloudMusicApi / qq-music-api expose no probe endpoint),
      // so the safe default is to only serve on ports THIS process bound. An
      // occupied port is treated as "some foreign process owns it" and NOT
      // adopted, because the client sends the account cookie to that port.
      const allowExternalApi =
        options.allowExternalApi ?? process.env.TSMB_ALLOW_EXTERNAL_MUSIC_API === "1";

      // Start NetEase Cloud Music API
      if (options.neteaseEnabled !== false) {
        try {
          const portFree = await isPortFree(options.neteasePort);
          if (!portFree) {
            if (allowExternalApi) {
              logger.warn(
                { port: options.neteasePort },
                "NetEase API port already in use — reusing the external instance (TSMB_ALLOW_EXTERNAL_MUSIC_API enabled). The account cookie will be sent to whatever process owns this port."
              );
            } else {
              logger.error(
                { port: options.neteasePort },
                "NetEase API port already in use by a process we did not start — refusing to reuse it (the login cookie would be sent there). Set TSMB_ALLOW_EXTERNAL_MUSIC_API=1 to opt in, or free the port. NetEase features are unavailable."
              );
            }
          } else {
            const ncmModule = await import("NeteaseCloudMusicApi") as any;
            const serverObj = ncmModule.server ?? ncmModule.default?.server;
            const app = await serverObj.serveNcmApi({ port: options.neteasePort, host: '127.0.0.1' });
            neteaseServer = app.server ?? app;
            if (neteaseServer && !neteaseServer.listening && typeof neteaseServer.once === 'function') {
              await new Promise<void>((resolve, reject) => { neteaseServer!.once('listening', resolve); neteaseServer!.once('error', reject); });
            }
            logger.info(
              { port: options.neteasePort },
              "NetEase Cloud Music API started"
            );
          }
        } catch (err) {
          logger.error({ err }, "Failed to start NetEase Cloud Music API");
        }
      }

      // Start QQ Music API. Older versions auto-started on import; the
      // current fork (2.2.11+) only listens when run as `require.main`,
      // so we explicitly call .listen() on the imported Koa app and keep
      // the server handle for clean shutdown.
      if (options.qqEnabled === false) return;
      try {
        // P2-30: probe BEFORE importing the sidecar. If the port is already
        // occupied here, the owner is a foreign process (we have not imported
        // anything yet), so refuse to adopt it. The post-import probe below is
        // the only legitimate "reuse": it means the sidecar auto-listened on
        // import and is our own.
        const portFreeBeforeImport = await isPortFree(options.qqMusicPort);
        if (!portFreeBeforeImport) {
          if (allowExternalApi) {
            logger.warn(
              { port: options.qqMusicPort },
              "QQ Music API port already in use — reusing the external instance (TSMB_ALLOW_EXTERNAL_MUSIC_API enabled). The account cookie will be sent to whatever process owns this port."
            );
          } else {
            logger.error(
              { port: options.qqMusicPort },
              "QQ Music API port already in use by a process we did not start — refusing to reuse it (the login cookie would be sent there). Set TSMB_ALLOW_EXTERNAL_MUSIC_API=1 to opt in, or free the port. QQ features are unavailable."
            );
          }
          return;
        }
        {
          // Pin the upstream server to the configured port before importing.
          // The package derives its default port from process.env.PORT (falling
          // back to 3200) and, in some historical versions, auto-started that
          // server as an import side effect. Aligning PORT with qqMusicApiPort
          // guarantees the sidecar can never bind a different port than the one
          // the client base URL (getQQMusicBaseUrl) targets — the root cause of
          // issue #122, where an old build listened on 3300 while the client
          // requested 3200. Restore the previous value right after import so we
          // never leak the override into the rest of the process (e.g. the web
          // server or the NetEase sidecar, which also read PORT as a fallback).
          const prevPortEnv = process.env.PORT;
          process.env.PORT = String(options.qqMusicPort);
          let qqModule: any;
          try {
            qqModule = (await import("@sansenjian/qq-music-api")) as any;
          } finally {
            if (prevPortEnv === undefined) delete process.env.PORT;
            else process.env.PORT = prevPortEnv;
          }
          // The module's export structure varies between versions:
          //   2.2.11+: default → Koa app (has .listen)
          //   2.2.10:  default → wrapper object whose .default is the Koa app
          //   older:   module itself may be the Koa app
          const candidate = qqModule.default ?? qqModule;
          const koaApp = typeof candidate.listen === "function"
            ? candidate
            : candidate.default ?? null;
          if (koaApp && typeof koaApp.listen === "function") {
            // A version that auto-started on import has already bound the
            // configured port (thanks to the PORT alignment above); reuse it
            // rather than racing a second listen that would fail EADDRINUSE.
            const stillFree = await isPortFree(options.qqMusicPort);
            if (!stillFree) {
              logger.info(
                { port: options.qqMusicPort },
                "QQ Music API already listening on the configured port (auto-started on import) — reusing embedded instance"
              );
            } else {
              qqMusicServer = await new Promise<Server>((resolve, reject) => {
                const srv = koaApp.listen(options.qqMusicPort, "127.0.0.1", () =>
                  resolve(srv)
                );
                srv.on("error", reject);
              });
              // Log the port actually bound (read from the socket) rather than
              // the requested one, so operators can spot a mismatch in the logs.
              const addr = qqMusicServer.address();
              const boundPort =
                addr && typeof addr === "object" && addr !== null
                  ? addr.port
                  : options.qqMusicPort;
              logger.info(
                { port: boundPort },
                "QQ Music API started"
              );
            }
          } else {
            logger.warn("QQ Music API module does not expose a Koa app");
          }
        }
      } catch (err) {
        const hint = describeQqApiStartupError(err);
        if (hint) {
          logger.error(
            { err },
            `QQ Music API failed to start — ${hint}. QQ features (search/play/login) will be unavailable until fixed; port ${options.qqMusicPort} is down.`
          );
        } else {
          logger.warn(
            { err },
            "QQ Music API not available — QQ Music features may be limited"
          );
        }
      }
    },

    async stop(): Promise<void> {
      logger.info("Stopping music API servers");
      const servers = [neteaseServer, qqMusicServer];
      neteaseServer = null;
      qqMusicServer = null;
      await Promise.all(servers.map(s => new Promise<void>(resolve => {
        if (!s || typeof s.close !== 'function') { resolve(); return; }
        s.close(() => resolve()); s.closeIdleConnections?.();
      })));
    },

    getNeteaseBaseUrl(): string {
      return neteaseBaseUrl;
    },

    getQQMusicBaseUrl(): string {
      return qqMusicBaseUrl;
    },
  };
}
