import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  saveConfig,
  migrateLegacyConfig,
  isProviderEnabled,
  spotifyRedirectUri,
} from "./data/config.js";
import { createDatabase, backupDatabase } from "./data/database.js";
import { createLogger } from "./logger.js";
import { createApiServerManager } from "./music/api-server.js";
import { NeteaseProvider } from "./music/netease.js";
import { QQMusicProvider } from "./music/qq.js";
import { BiliBiliProvider } from "./music/bilibili.js";
import { LocalMusicProvider } from "./music/local.js";
import { KugouProvider } from "./music/kugou.js";
import { JellyfinProvider } from "./music/jellyfin.js";
import { SpotifyProvider } from "./music/spotify/provider.js";
import { SpotifyOAuth, createFileOAuthTokenStore } from "./music/spotify/spotify-oauth.js";
import { createCookieStore } from "./music/auth.js";
import { createAvatarStore } from "./data/avatars.js";
import { createPermissionStore } from "./data/permissions.js";
import { BotManager } from "./bot/manager.js";
import { createWebServer } from "./web/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
// config.json lives under the persisted data dir (the Docker volume) alongside the
// DB/cookies/logs, so it survives container restarts and manual edits take effect
// (#86). LEGACY_CONFIG_PATH is the old root-level location we migrate from once.
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const LEGACY_CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const DB_PATH = path.join(DATA_DIR, "tsmusicbot.db");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const LOG_DIR = path.join(DATA_DIR, "logs");
const COOKIE_DIR = path.join(DATA_DIR, "cookies");
const AVATAR_DIR = path.join(DATA_DIR, "avatars");
const LOCAL_AUDIO_DIR = path.join(DATA_DIR, "local-audio");
const SPOTIFY_DATA_DIR = path.join(DATA_DIR, "spotify");
const STATIC_DIR = path.join(ROOT_DIR, "web", "dist");

async function main() {
  // Migrate a pre-#86 root-level config.json into the data dir so existing
  // installs keep their settings; no-op if already migrated or none exists.
  migrateLegacyConfig(LEGACY_CONFIG_PATH, CONFIG_PATH);
  const config = loadConfig(CONFIG_PATH);
  saveConfig(CONFIG_PATH, config);

  const logger = createLogger(LOG_DIR);

  // An uncaught exception leaves shared clients and queues in an unknown state.
  // Record it, then terminate so the service manager can restart a clean process
  // instead of keeping a half-functional bot alive.
  let fatalExitScheduled = false;
  const scheduleFatalExit = (message: string, fields: Record<string, unknown>) => {
    if (fatalExitScheduled) return;
    fatalExitScheduled = true;
    logger.error(fields, message);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 100).unref();
  };
  process.on("uncaughtException", (err) => {
    scheduleFatalExit("Uncaught exception", { err });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
  });
  const db = createDatabase(DB_PATH);

  // Automated database backup (on startup & every 24h)
  backupDatabase(db.db, BACKUP_DIR)
    .then((backupFile) => logger.info({ backupFile }, "Database backup created"))
    .catch((err) => logger.warn({ err }, "Failed to create database backup"));

  setInterval(() => {
    backupDatabase(db.db, BACKUP_DIR)
      .then((backupFile) => logger.info({ backupFile }, "Scheduled database backup created"))
      .catch((err) => logger.warn({ err }, "Scheduled database backup failed"));
  }, 24 * 60 * 60 * 1000).unref();

  const apiServer = createApiServerManager(
    {
      neteasePort: config.neteaseApiPort,
      qqMusicPort: config.qqMusicApiPort,
      // Provider gating: a sidecar only starts (and binds 3001/3200) when its
      // source is listed in enabledProviders — both are on in the default config.
      neteaseEnabled: isProviderEnabled(config, "netease"),
      qqEnabled: isProviderEnabled(config, "qq"),
    },
    logger
  );
  await apiServer.start();

  const neteaseProvider = new NeteaseProvider(apiServer.getNeteaseBaseUrl());
  const qqProvider = new QQMusicProvider(apiServer.getQQMusicBaseUrl());
  const bilibiliProvider = new BiliBiliProvider();
  const localProvider = new LocalMusicProvider(LOCAL_AUDIO_DIR);
  const kugouProvider = new KugouProvider();
  const spotifyProvider = new SpotifyProvider();
  // Safety gate (spec §7): the source is inert unless EXPLICITLY enabled.
  // Only feed credentials when enabled — otherwise the provider has no creds,
  // hasCreds() is false, search returns empty, and getAuthStatus() is loggedIn:false,
  // so setting a Client ID/Secret alone (enabled:false) never activates Spotify.
  if (config.spotify.enabled && config.spotify.clientId) {
    spotifyProvider.setCreds(config.spotify.clientId, config.spotify.clientSecret);
  }

  const cookieStore = createCookieStore(COOKIE_DIR);
  const avatarStore = createAvatarStore(AVATAR_DIR);
  const neteaseCookie = cookieStore.load("netease");
  if (neteaseCookie) neteaseProvider.setCookie(neteaseCookie);
  const qqCookie = cookieStore.load("qq");
  if (qqCookie) qqProvider.setCookie(qqCookie);
  qqProvider.setPersist((cookie) => cookieStore.save("qq", cookie));
  qqProvider.startKeepAlive();
  const bilibiliCookie = cookieStore.load("bilibili");
  if (bilibiliCookie) bilibiliProvider.setCookie(bilibiliCookie);
  const kugouCookie = cookieStore.load("kugou");
  if (kugouCookie) kugouProvider.setCookie(kugouCookie);

  // Jellyfin: admin-configured connection (no QR). The persisted blob carries
  // AccessToken + User.Id + DeviceId and lives alongside the other platform
  // cookies; a Jellyfin server that is unreachable at boot must not block
  // startup — the provider authenticates lazily on first use.
  const jellyfinProvider = new JellyfinProvider(logger);
  jellyfinProvider.configure(config.jellyfin);
  const jellyfinAuth = cookieStore.load("jellyfin");
  if (jellyfinAuth) jellyfinProvider.setCookie(jellyfinAuth);
  jellyfinProvider.setPersist((serialized) => cookieStore.save("jellyfin", serialized));

  // Restore the persisted per-provider audio quality (#125) onto the shared,
  // process-wide providers so a restart keeps the user's choice. setQuality()
  // normalizes/ignores unknown values, so a stale entry can never break playback.
  neteaseProvider.setQuality(config.audioQuality.netease);
  qqProvider.setQuality(config.audioQuality.qq);
  bilibiliProvider.setQuality(config.audioQuality.bilibili);
  kugouProvider.setQuality(config.audioQuality.kugou);
  jellyfinProvider.setQuality(config.audioQuality.jellyfin);
  spotifyProvider.setQuality(config.audioQuality.spotify);

  const permissions = createPermissionStore(db.db);

  // Single process-wide Spotify authorization (one Premium account for Stage 3).
  // Threaded into BOTH the web OAuth router and every bot's SpotifyController so
  // a web login immediately authorizes playback (C3.1). Own-app clientId => the
  // redirect points at this bot's web callback; empty clientId leaves OAuth
  // disabled (isAuthorized() stays false and the Rust backend never starts).
  // The redirect URI comes from spotifyRedirectUri() so it is byte-identical to
  // the one the Settings save path re-registers (and honours publicUrl).
  const spotifyOAuthClientId = config.spotify.clientId.trim();
  const spotifyOAuth = new SpotifyOAuth({
    clientId: spotifyOAuthClientId || undefined,
    redirectUri: spotifyRedirectUri(config),
    store: createFileOAuthTokenStore(
      path.join(SPOTIFY_DATA_DIR, "oauth", "oauth-tokens.json"),
    ),
  });

  const botManager = new BotManager(
    neteaseProvider,
    qqProvider,
    bilibiliProvider,
    db,
    config,
    logger,
    avatarStore,
    permissions,
    CONFIG_PATH,
    localProvider,
    kugouProvider,
    spotifyProvider,
    SPOTIFY_DATA_DIR,
    spotifyOAuth,
    jellyfinProvider
  );
  // Register every saved bot synchronously, but do NOT block startup on the
  // TeamSpeak handshakes: an unreachable host costs up to 25s each, which used
  // to delay the WebUI (and the container health check) by minutes. The bots are
  // in the manager's map immediately; connects finish in the background.
  await botManager.loadSavedBots({ awaitConnections: false });

  const webServer = createWebServer({
    port: config.webPort,
    botManager,
    neteaseProvider,
    qqProvider,
    bilibiliProvider,
    localProvider,
    kugouProvider,
    spotifyProvider,
    jellyfinProvider,
    database: db,
    avatarStore,
    config,
    configPath: CONFIG_PATH,
    logger,
    cookieStore,
    staticDir: STATIC_DIR,
    spotifyOAuth,
  });
  await webServer.start();

  logger.info({ webPort: config.webPort }, "TSMusicBot started");
  const publicUrl = (config.publicUrl ?? "").trim().replace(/\/+$/, "");
  logger.info(
    `WebUI: ${publicUrl || `http://localhost:${config.webPort}`}`
  );

  // Graceful shutdown. Previously this called process.exit(0) as soon as the
  // synchronous stops returned, which truncated anything still settling —
  // notably the Spotify sidecar child processes (their kill is asynchronous) and
  // any in-flight DB write. Now we let the event loop drain, with a hard cap so a
  // wedged child can never keep the process alive forever.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down...");
    try {
      qqProvider.stopKeepAlive();
      botManager.shutdown();
      webServer.stop();
      apiServer.stop();
    } catch (err) {
      logger.warn({ err }, "Error while stopping services");
    }

    // Give pending async teardown (sidecar kills, WAL checkpoint) a moment to
    // finish, then close the DB and exit.
    const forceExit = setTimeout(() => {
      logger.warn("Shutdown timed out — forcing exit");
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    }, 5000);
    forceExit.unref();

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      db.close();
    } catch (err) {
      logger.warn({ err }, "Error while closing database");
    }
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
