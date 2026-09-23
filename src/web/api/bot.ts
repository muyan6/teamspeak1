import { Router } from "express";
import type { BotManager } from "../../bot/manager.js";
import type { BotConfig, GuestModeConfig, SpotifyConfig, JellyfinConfig, GateableProvider } from "../../data/config.js";
import { saveConfig, GATEABLE_PROVIDERS, spotifyRedirectUri } from "../../data/config.js";
import type { Logger } from "../../logger.js";
import type { BotDatabase } from "../../data/database.js";
import type { AvatarStore } from "../../data/avatars.js";
import { requirePermission, requireBotAccess } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";
import { GUEST_PERMISSION_FLAGS } from "../../data/permissions.js";
import type { ServerProtocol } from "../../ts-protocol/client.js";

class InvalidBotInputError extends Error {}

/**
 * Minimal magic-byte check for the three avatar formats the store accepts
 * (png / jpeg / webp). Used to reject a payload whose declared data-URL MIME
 * does not match its actual bytes.
 */
function looksLikeImage(buf: Buffer, mime: string): boolean {
  if (buf.length < 12) return false;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  // "RIFF" .... "WEBP"
  const webp =
    buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
  if (mime === "image/png") return png;
  if (mime === "image/jpeg") return jpeg;
  if (mime === "image/webp") return webp;
  return false;
}

function requiredBotText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidBotInputError(`${field} is required`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new InvalidBotInputError(`${field} exceeds ${maxLength} characters`);
  }
  return text;
}

function optionalBotText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new InvalidBotInputError(`${field} must be a string`);
  }
  if (value.length > maxLength) {
    throw new InvalidBotInputError(`${field} exceeds ${maxLength} characters`);
  }
  return value;
}

function optionalRequiredBotText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredBotText(value, field, maxLength);
}

function botPort(value: unknown, field: string, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new InvalidBotInputError(`${field} must be an integer between 1 and 65535`);
  }
  return value;
}

function botProtocol(value: unknown): ServerProtocol | "" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "") return "";
  if (value === "ts3" || value === "ts6") return value;
  throw new InvalidBotInputError("serverProtocol must be ts3, ts6, or empty");
}

function botBoolean(value: unknown, field: string, fallback?: boolean): boolean | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new InvalidBotInputError(`${field} must be boolean`);
  return value;
}

export function createBotRouter(
  botManager: BotManager,
  config: BotConfig,
  configPath: string,
  logger: Logger,
  botDb: BotDatabase,
  avatarStore: AvatarStore,
  onGuestPolicyChanged?: (cfg: GuestModeConfig) => void,
  // I2: the single process-wide OAuth, so a UI-entered Client ID reaches the
  // live instance on save (no restart). Structural type = SpotifyOAuth.configure.
  spotifyOAuth?: { configure(clientId?: string, redirectUri?: string): void },
  // R2-4: the process-wide Web API SEARCH provider. Boot only wires creds when
  // spotify.enabled is already true, so a fresh install that enables Spotify via
  // Settings must push creds here too, or search stays empty until a restart.
  // Structural type = SpotifyProvider.setCreds.
  spotifyProvider?: { setCreds(clientId: string, clientSecret: string): void },
  // The live JellyfinProvider, so a Settings save re-points the connection
  // without a restart (configure() drops the cached token only when
  // credential-relevant fields actually changed). Structural type =
  // JellyfinProvider.configure.
  jellyfinProvider?: { configure(cfg: JellyfinConfig): void },
): Router {
  const router = Router();

  // Masked spotify view shared by the GET response and the POST echo. The raw
  // clientSecret is write-only and NEVER serialized — only whether one is stored.
  const maskedSpotify = () => ({
    enabled: config.spotify.enabled,
    backend: config.spotify.backend,
    clientId: config.spotify.clientId,
    deviceName: config.spotify.deviceName,
    bitrate: config.spotify.bitrate,
    hasClientSecret: config.spotify.clientSecret.length > 0,
  });

  // Masked jellyfin view: password and apiKey are write-only — only their
  // presence is reported (mirrors maskedSpotify's clientSecret handling).
  const maskedJellyfin = () => ({
    serverUrl: config.jellyfin.serverUrl,
    authMode: config.jellyfin.authMode,
    username: config.jellyfin.username,
    userId: config.jellyfin.userId,
    hasPassword: config.jellyfin.password.length > 0,
    hasApiKey: config.jellyfin.apiKey.length > 0,
  });

  router.get("/", (req, res) => {
    const all = botManager.getAllBots().map((b) => b.getStatus());
    const u = req.user!;
    const bots =
      u.role === "admin" || u.bots === "all"
        ? all
        : all.filter((b) => u.bots instanceof Set && u.bots.has(b.id));
    res.json({ bots });
  });

  // GET /api/bot/settings — 读取全局 bot 行为设置
  // NOTE: must be registered before "/:id" so it isn't shadowed by the param route.
  router.get("/settings", requireNotGuest, (req, res) => {
    const isAdmin = req.user?.role === "admin";
    res.json({
      idleTimeoutMinutes: config.idleTimeoutMinutes ?? 0,
      autoPauseOnEmpty: config.autoPauseOnEmpty,
      voiceDucking: config.voiceDucking,
      localAudioEnabled: config.localAudioEnabled,
      savedQueuesEnabled: config.savedQueuesEnabled,
      playKeepsQueue: config.playKeepsQueue,
      loudnessNormalization: config.loudnessNormalization,
      audioFade: config.audioFade,
      autoSourceFallback: config.autoSourceFallback,
      adminGroups: isAdmin ? (config.adminGroups ?? []) : [],
      guestMode: config.guestMode,
      spotify: maskedSpotify(),
      jellyfin: maskedJellyfin(),
      enabledProviders: config.enabledProviders,
      defaultPlatform: config.defaultPlatform,
    });
  });

  /**
   * Settings blocks that rewrite PROCESS-WIDE security state rather than
   * cosmetic bot behaviour. `bot.manage` is a grantable capability, so allowing
   * it to write these let a non-admin member open guest mode, change the
   * enabled-source set / default platform, edit the admin TS groups, or replace
   * the Spotify secret and the Jellyfin URL + credentials.
   */
  // NOTE: `defaultPlatform` and `enabledProviders` are deliberately NOT in this
  // list. The Settings UI exposes the "默认音源" picker to every `bot.manage`
  // holder (Settings.vue), so gating those here would 403 a legitimate member
  // action. Every remaining key lives in a section the UI already hides behind
  // `platform.auth` or `session.isAdmin`, so this gate is defence-in-depth
  // against a future grant rather than a change to any reachable action.
  const ADMIN_ONLY_SETTINGS_KEYS = [
    "guestMode",
    "adminGroups",
    "spotify",
    "jellyfin",
  ] as const;

  // POST /api/bot/settings — 保存全局 bot 行为设置
  // A bot.manage member may toggle cosmetic playback behaviour; anything that
  // touches credentials, guest policy, provider gating or admin groups is
  // admin-only.
  router.post("/settings", requirePermission("bot.manage"), (req, res) => {
    const isAdmin = req.user?.role === "admin";
    if (!isAdmin) {
      const touched = ADMIN_ONLY_SETTINGS_KEYS.filter(
        (k) => req.body?.[k] !== undefined,
      );
      if (touched.length > 0) {
        res.status(403).json({
          error: `admin required to change: ${touched.join(", ")}`,
        });
        return;
      }
    }

    const {
      idleTimeoutMinutes,
      autoPauseOnEmpty,
      localAudioEnabled,
      voiceDucking,
      guestMode,
      adminGroups,
    } = req.body;

    const hasIdle = idleTimeoutMinutes !== undefined;
    if (hasIdle && (typeof idleTimeoutMinutes !== "number" || idleTimeoutMinutes < 0)) {
      res.status(400).json({ error: "idleTimeoutMinutes must be a non-negative number" });
      return;
    }

    const hasAutoPause = typeof autoPauseOnEmpty === "boolean";
    const hasLocalAudioEnabled = typeof localAudioEnabled === "boolean";
    const hasLoudness = typeof req.body.loudnessNormalization === "boolean";
    const hasFade = typeof req.body.audioFade === "boolean";

    if (hasIdle) config.idleTimeoutMinutes = idleTimeoutMinutes;
    if (hasAutoPause) config.autoPauseOnEmpty = autoPauseOnEmpty;
    if (hasLocalAudioEnabled) config.localAudioEnabled = localAudioEnabled;
    if (hasLoudness) config.loudnessNormalization = req.body.loudnessNormalization;
    if (hasFade) config.audioFade = req.body.audioFade;
    if (typeof req.body.autoSourceFallback === "boolean") {
      config.autoSourceFallback = req.body.autoSourceFallback;
    }

    // Voice ducking is a partial settings block. Merge only known, strictly
    // valid fields so malformed JSON cannot replace the object or inject NaN /
    // out-of-range gain values into the live audio path.
    const hasVoiceDucking =
      voiceDucking !== null &&
      typeof voiceDucking === "object" &&
      !Array.isArray(voiceDucking);
    if (hasVoiceDucking) {
      if (typeof voiceDucking.enabled === "boolean") {
        config.voiceDucking.enabled = voiceDucking.enabled;
      }
      if (
        typeof voiceDucking.volumePercent === "number" &&
        Number.isFinite(voiceDucking.volumePercent) &&
        voiceDucking.volumePercent >= 0 &&
        voiceDucking.volumePercent <= 100
      ) {
        config.voiceDucking.volumePercent = voiceDucking.volumePercent;
      }
    }

    // Saved-queues + play-keeps-queue toggles (default off). Both read live from
    // config by BotInstance / the saved-queues router, so no per-bot push needed;
    // only a literal boolean mutates the stored value (junk is ignored).
    if (typeof req.body.savedQueuesEnabled === "boolean") {
      config.savedQueuesEnabled = req.body.savedQueuesEnabled;
    }
    if (typeof req.body.playKeepsQueue === "boolean") {
      config.playKeepsQueue = req.body.playKeepsQueue;
    }

    const hasGuestMode = guestMode !== undefined && guestMode !== null && typeof guestMode === "object";
    if (hasGuestMode) {
      const gm = config.guestMode;
      if (typeof guestMode.enabled === "boolean") gm.enabled = guestMode.enabled;
      if (guestMode.bots === "all") {
        gm.bots = "all";
      } else if (Array.isArray(guestMode.bots)) {
        gm.bots = guestMode.bots.filter((id: unknown): id is string => typeof id === "string");
      }
      if (guestMode.permissions && typeof guestMode.permissions === "object") {
        for (const f of GUEST_PERMISSION_FLAGS) {
          if (typeof guestMode.permissions[f] === "boolean") {
            gm.permissions[f] = guestMode.permissions[f];
          }
        }
      }
    }

    if (Array.isArray(adminGroups)) {
      config.adminGroups = adminGroups.filter(
        (g: unknown): g is number =>
          typeof g === "number" && Number.isInteger(g) && g >= 0,
      );
    }

    // Partial-merge the spotify block (mirrors config.ts validation). Invalid
    // sub-fields are ignored rather than 400-ing the whole request. Omitting
    // `spotify` entirely leaves config.spotify untouched.
    const VALID_BACKENDS = ["auto", "go-librespot", "librespot"] as const;
    const VALID_BITRATES = [96, 160, 320];
    const sp = req.body?.spotify;
    if (sp && typeof sp === "object") {
      const t = config.spotify;
      if (typeof sp.enabled === "boolean") t.enabled = sp.enabled;
      if (typeof sp.backend === "string" && (VALID_BACKENDS as readonly string[]).includes(sp.backend)) {
        t.backend = sp.backend as SpotifyConfig["backend"];
      }
      if (typeof sp.clientId === "string") t.clientId = sp.clientId;
      // Secret is write-only + set-on-non-empty so a blank field never wipes it.
      if (typeof sp.clientSecret === "string" && sp.clientSecret.length > 0) {
        t.clientSecret = sp.clientSecret;
      }
      if (typeof sp.deviceName === "string" && sp.deviceName.trim().length > 0) {
        t.deviceName = sp.deviceName.trim();
      }
      if (typeof sp.bitrate === "number" && VALID_BITRATES.includes(sp.bitrate)) {
        t.bitrate = sp.bitrate;
      }
    }

    // Partial-merge the jellyfin block (same contract as spotify): invalid
    // sub-fields are ignored; password/apiKey are write-only and only stored
    // when non-empty so a blank (masked) field never wipes them.
    const jf = req.body?.jellyfin;
    if (jf && typeof jf === "object") {
      const t = config.jellyfin;
      if (typeof jf.serverUrl === "string") {
        t.serverUrl = jf.serverUrl.trim().replace(/\/+$/, "");
      }
      if (jf.authMode === "userpass" || jf.authMode === "apikey") t.authMode = jf.authMode;
      if (typeof jf.username === "string") t.username = jf.username;
      if (typeof jf.password === "string" && jf.password.length > 0) t.password = jf.password;
      if (typeof jf.apiKey === "string" && jf.apiKey.length > 0) t.apiKey = jf.apiKey;
      if (typeof jf.userId === "string") t.userId = jf.userId;
    }

    // enabledProviders: full replace, known providers only (mirrors loadConfig).
    // An empty array is a valid "all gateable sources off". NOTE: the NetEase/QQ
    // sidecar API servers are only started at boot, so newly enabling those two
    // still needs a restart; jellyfin and the rest take effect immediately.
    const ep = req.body?.enabledProviders;
    if (Array.isArray(ep)) {
      config.enabledProviders = ep.filter((p: unknown): p is GateableProvider =>
        (GATEABLE_PROVIDERS as readonly string[]).includes(p as string),
      );
    }

    // defaultPlatform (issue #126): the operator-chosen default source for
    // platform-less commands/REST/WebUI calls. Reconciled AFTER enabledProviders
    // so both are validated against the same (possibly updated) enabled list:
    //   1) Drop a stored default that the new enabledProviders no longer allows,
    //      keeping the persisted config consistent with loadConfig's invariant.
    //   2) Apply an explicit change — `null`/`""` clears it (back to priority
    //      order); a known+enabled provider sets it; anything else is ignored.
    if (config.defaultPlatform && !config.enabledProviders.includes(config.defaultPlatform)) {
      config.defaultPlatform = null;
    }
    if ("defaultPlatform" in req.body) {
      const dp = req.body.defaultPlatform;
      if (dp === null || dp === "") {
        config.defaultPlatform = null;
      } else if (
        typeof dp === "string" &&
        (GATEABLE_PROVIDERS as readonly string[]).includes(dp) &&
        config.enabledProviders.includes(dp as GateableProvider)
      ) {
        config.defaultPlatform = dp as GateableProvider;
      }
    }

    saveConfig(configPath, config);

    // Hot-apply the (possibly re-pointed) Jellyfin connection to the live
    // provider — a Settings save must work without a restart.
    if (jf && typeof jf === "object") {
      jellyfinProvider?.configure(config.jellyfin);
    }

    // I2: only when the spotify block was present, push the (possibly UI-entered)
    // Client ID into the live process-wide OAuth so Connect works without a
    // restart. Empty clientId => undefined redirect => configure() disables OAuth.
    if (sp && typeof sp === "object") {
      // Shared builder so this redirect URI is byte-identical to the one
      // index.ts registered at boot (and honours publicUrl behind a proxy).
      const redirectUri = spotifyRedirectUri(config);
      spotifyOAuth?.configure(config.spotify.clientId, redirectUri);
      // R2-4: also refresh the live Web API search provider so search/getAuthStatus
      // work without a restart. Uses the post-merge values so a masked/omitted
      // secret keeps the stored one. The secret is never logged.
      spotifyProvider?.setCreds(config.spotify.clientId, config.spotify.clientSecret);
    }

    // Guest-mode changed: tear down / re-scope in-flight guest WS sockets so a
    // disabled or narrowed scope takes effect immediately (matches requireAuth's
    // "disabling immediately invalidates in-flight guest sessions" invariant).
    if (hasGuestMode) {
      onGuestPolicyChanged?.(config.guestMode);
    }

    // 通知所有 bot 实例更新
    for (const bot of botManager.getAllBots()) {
      if (hasIdle) bot.updateIdleTimeout(config.idleTimeoutMinutes);
      if (hasAutoPause) bot.updateAutoPause(config.autoPauseOnEmpty);
      if (hasVoiceDucking) bot.updateVoiceDucking(config.voiceDucking);
      if (hasLoudness) bot.updateLoudnessNormalization(config.loudnessNormalization);
      if (hasFade) bot.updateAudioFade(config.audioFade);
    }

    res.json({
      idleTimeoutMinutes: config.idleTimeoutMinutes ?? 0,
      autoPauseOnEmpty: config.autoPauseOnEmpty,
      voiceDucking: config.voiceDucking,
      localAudioEnabled: config.localAudioEnabled,
      savedQueuesEnabled: config.savedQueuesEnabled,
      playKeepsQueue: config.playKeepsQueue,
      loudnessNormalization: config.loudnessNormalization,
      audioFade: config.audioFade,
      autoSourceFallback: config.autoSourceFallback,
      adminGroups: config.adminGroups ?? [],
      guestMode: config.guestMode,
      spotify: maskedSpotify(),
      jellyfin: maskedJellyfin(),
      enabledProviders: config.enabledProviders,
      defaultPlatform: config.defaultPlatform,
    });
  });

  // POST /api/bot/batch/start — 批量启动机器人
  router.post("/batch/start", requirePermission("bot.manage"), async (req, res) => {
    try {
      const u = req.user!;
      const allBots = botManager.getAllBots();
      const accessibleIds =
        u.role === "admin" || u.bots === "all"
          ? allBots.map((b) => b.id)
          : allBots.map((b) => b.id).filter((id) => u.bots instanceof Set && u.bots.has(id));

      const reqIds = Array.isArray(req.body?.ids)
        ? (req.body.ids as unknown[]).filter((id): id is string => typeof id === "string")
        : accessibleIds;

      const targetIds = reqIds.filter((id) => accessibleIds.includes(id));
      const result = await botManager.batchStartBots(targetIds);
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error({ err }, "Failed to batch start bots");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/bot/batch/stop — 批量停止机器人
  router.post("/batch/stop", requirePermission("bot.manage"), (req, res) => {
    try {
      const u = req.user!;
      const allBots = botManager.getAllBots();
      const accessibleIds =
        u.role === "admin" || u.bots === "all"
          ? allBots.map((b) => b.id)
          : allBots.map((b) => b.id).filter((id) => u.bots instanceof Set && u.bots.has(id));

      const reqIds = Array.isArray(req.body?.ids)
        ? (req.body.ids as unknown[]).filter((id): id is string => typeof id === "string")
        : accessibleIds;

      const targetIds = reqIds.filter((id) => accessibleIds.includes(id));
      const result = botManager.batchStopBots(targetIds);
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error({ err }, "Failed to batch stop bots");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:id", requireBotAccess("id"), (req, res) => {
    const bot = botManager.getBot(req.params.id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    res.json(bot.getStatus());
  });

  // Get saved config for a bot
  router.get("/:id/config", requirePermission("bot.manage"), requireBotAccess("id"), (req, res) => {
    const saved = botManager.getBotConfig(req.params.id);
    if (!saved) {
      res.status(404).json({ error: "Bot config not found" });
      return;
    }
    // Never expose ANY connection secret to the client: TS identity, TS6 API
    // key, and the server/channel passwords used to join. The edit form only
    // needs to know WHETHER one is stored, so it can render "已保存" and let
    // the operator leave the field untouched. Previously serverPassword and
    // channelPassword survived the strip and were returned in cleartext.
    const {
      ts6ApiKey: _ts6ApiKey,
      identity: _identity,
      serverPassword: _serverPassword,
      channelPassword: _channelPassword,
      ...safe
    } = saved as unknown as Record<string, unknown>;
    res.json({
      ...safe,
      hasTs6ApiKey: Boolean(saved.ts6ApiKey),
      hasServerPassword: Boolean(saved.serverPassword),
      hasChannelPassword: Boolean(saved.channelPassword),
    });
  });

  router.get("/:id/avatar", requirePermission("bot.manage"), requireBotAccess("id"), (req, res) => {
    const path = botDb.getCustomAvatarPath(req.params.id);
    if (!path) {
      res.status(404).end();
      return;
    }
    const buf = avatarStore.read(path);
    if (!buf) {
      res.status(404).end();
      return;
    }
    const ext = path.split(".").pop() ?? "";
    const mime = ext === "png"
      ? "image/png"
      : ext === "webp"
        ? "image/webp"
        : "image/jpeg";
    res.set("Content-Type", mime);
    res.set("Cache-Control", "no-cache");
    res.send(buf);
  });

  router.put("/:id/avatar", requirePermission("bot.manage"), requireBotAccess("id"), (req, res) => {
    const exists =
      botManager.getBot(req.params.id) ||
      botDb.getBotInstances().some((b) => b.id === req.params.id);
    if (!exists) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    const { dataUrl } = req.body as { dataUrl?: string };
    if (typeof dataUrl !== "string") {
      res.status(400).json({ error: "dataUrl required" });
      return;
    }
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
    if (!m) {
      res.status(400).json({ error: "dataUrl must be image/png|jpeg|webp base64" });
      return;
    }
    const mime = m[1] as string;
    const buf = Buffer.from(m[2] ?? "", "base64");
    if (buf.length === 0) {
      res.status(400).json({ error: "empty image" });
      return;
    }
    if (buf.length > 200 * 1024) {
      res.status(413).json({ error: "avatar exceeds 200KB limit" });
      return;
    }
    // Verify the bytes really are the claimed image type. The MIME comes from
    // the data-URL prefix, i.e. from the client, and the result is written to
    // data/avatars/ and later shipped with that Content-Type — so a `bot.manage`
    // holder could previously store arbitrary non-image content under
    // "image/png". Magic bytes are a cheap sanity check, not a full decoder.
    if (!looksLikeImage(buf, mime)) {
      res.status(400).json({ error: "dataUrl content does not match its declared image type" });
      return;
    }
    const rel = avatarStore.write(req.params.id, mime, buf);
    botDb.setCustomAvatarPath(req.params.id, rel);
    botManager.getBot(req.params.id)?.getProfileManager().setCustomAvatar(buf);
    res.json({ path: rel });
  });

  router.delete("/:id/avatar", requirePermission("bot.manage"), requireBotAccess("id"), (req, res) => {
    const path = botDb.getCustomAvatarPath(req.params.id);
    if (path) avatarStore.remove(path);
    botDb.setCustomAvatarPath(req.params.id, null);
    botManager.getBot(req.params.id)?.getProfileManager().setCustomAvatar(null);
    res.status(204).end();
  });

  router.post("/", requirePermission("bot.create"), async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const name = requiredBotText(body.name, "name", 100);
      const serverAddress = requiredBotText(body.serverAddress, "serverAddress", 255);
      const nickname = requiredBotText(body.nickname, "nickname", 100);
      const serverPort = botPort(body.serverPort, "serverPort", 9987)!;
      const queryPort = botPort(body.queryPort, "queryPort");
      const defaultChannel = optionalBotText(body.defaultChannel, "defaultChannel", 512);
      const channelId = optionalBotText(body.channelId, "channelId", 128);
      const channelPassword = optionalBotText(body.channelPassword, "channelPassword", 1024);
      const serverPassword = optionalBotText(body.serverPassword, "serverPassword", 1024);
      const autoStart = botBoolean(body.autoStart, "autoStart", true)!;
      const normalizedProtocol = botProtocol(body.serverProtocol);
      const ts6ApiKey = optionalBotText(body.ts6ApiKey, "ts6ApiKey", 4096);
      const bot = await botManager.createBot({
        name,
        serverAddress,
        serverPort,
        queryPort,
        nickname,
        defaultChannel,
        channelId,
        channelPassword,
        serverPassword,
        autoStart,
        serverProtocol: normalizedProtocol,
        ts6ApiKey: ts6ApiKey || undefined,
      });
      res.status(201).json(bot.getStatus());
    } catch (err) {
      if (err instanceof InvalidBotInputError) {
        res.status(400).json({ error: err.message });
        return;
      }
      logger.error({ err }, "Failed to create bot");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Update bot config (must be stopped first to apply connection changes)
  router.put("/:id", requirePermission("bot.manage"), requireBotAccess("id"), async (req, res) => {
    try {
      const bot = botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: "Bot not found" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const name = optionalRequiredBotText(body.name, "name", 100);
      const serverAddress = optionalRequiredBotText(body.serverAddress, "serverAddress", 255);
      const serverPort = botPort(body.serverPort, "serverPort");
      const queryPort = botPort(body.queryPort, "queryPort");
      const nickname = optionalRequiredBotText(body.nickname, "nickname", 100);
      const defaultChannel = optionalBotText(body.defaultChannel, "defaultChannel", 512);
      const channelId = optionalBotText(body.channelId, "channelId", 128);
      // GET /:id/config no longer echoes stored passwords (they are write-only),
      // so the edit form arrives with empty password inputs. Treat "" as "leave
      // the stored secret alone" instead of wiping it. (manager.updateBot's
      // `?? existing` does the actual keep; undefined is how we signal it.)
      // "" (empty input in the edit form) means "leave the stored secret alone",
      // while an explicit null means "clear it". Previously "" cleared it, but
      // GET /:id/config no longer echoes the stored value, so an untouched empty
      // input must not wipe the password.
      const keepOrClear = (v: unknown, field: string): string | undefined => {
        if (v === null) return "";
        return optionalBotText(v, field, 1024) || undefined;
      };
      const channelPassword = keepOrClear(body.channelPassword, "channelPassword");
      const serverPassword = keepOrClear(body.serverPassword, "serverPassword");
      const autoStart = botBoolean(body.autoStart, "autoStart");
      const normalizedProtocol = botProtocol(body.serverProtocol);
      const ts6ApiKey = optionalBotText(body.ts6ApiKey, "ts6ApiKey", 4096);
      // Update in database
      botManager.updateBot(req.params.id, {
        name,
        serverAddress,
        serverPort,
        queryPort,
        nickname,
        defaultChannel,
        channelId,
        channelPassword,
        serverPassword,
        autoStart,
        serverProtocol: normalizedProtocol,
        ts6ApiKey: ts6ApiKey || undefined,
      });
      res.json({ success: true });
    } catch (err) {
      if (err instanceof InvalidBotInputError) {
        res.status(400).json({ error: err.message });
        return;
      }
      logger.error({ err }, "Failed to update bot");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/:id", requirePermission("bot.manage"), requireBotAccess("id"), async (req, res) => {
    try {
      await botManager.removeBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/start", requirePermission("bot.manage"), requireBotAccess("id"), async (req, res) => {
    try {
      await botManager.startBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/stop", requirePermission("bot.manage"), requireBotAccess("id"), (req, res) => {
    try {
      botManager.stopBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
