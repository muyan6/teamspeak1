import { Router } from "express";
import type { MusicProvider } from "../../music/provider.js";
import { YouTubeProvider } from "../../music/youtube.js";
import type { CookieStore } from "../../music/auth.js";
import type { Logger } from "../../logger.js";
import type { BotConfig, JellyfinConfig } from "../../data/config.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

/**
 * True only for an http(s) URL. The "test connection" probe issues an
 * authenticated request, so a `file:` / `gopher:` / other scheme must never
 * reach the provider.
 *
 * Note there is deliberately NO private-range block here: a self-hosted
 * Jellyfin normally lives on a LAN address, and the operator configuring that
 * is the intended use. The containment for the grantable `platform.auth`
 * capability is that a NON-admin may only re-test the URL the operator already
 * saved (see the route below) — so no request-supplied host is ever fetched
 * with anything less than admin authority.
 */
export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function createAuthRouter(
  neteaseProvider: MusicProvider,
  qqProvider: MusicProvider,
  bilibiliProvider: MusicProvider,
  logger: Logger,
  cookieStore?: CookieStore,
  kugouProvider?: MusicProvider,
  spotifyProvider?: MusicProvider,
  jellyfinProvider?: MusicProvider,
  config?: BotConfig
): Router {
  const router = Router();
  // YouTube is auth-less; we only use this instance so /auth/status can
  // report whether yt-dlp is actually installed (loggedIn=false otherwise).
  const youtubeProvider: MusicProvider = new YouTubeProvider();

  function getProvider(platform?: string): MusicProvider {
    if (platform === "bilibili") return bilibiliProvider;
    if (platform === "youtube") return youtubeProvider;
    if (platform === "kugou" && kugouProvider) return kugouProvider;
    if (platform === "spotify" && spotifyProvider) return spotifyProvider;
    if (platform === "jellyfin" && jellyfinProvider) return jellyfinProvider;
    return platform === "qq" ? qqProvider : neteaseProvider;
  }

  router.get("/status", requireNotGuest, async (req, res) => {
    try {
      const platform = req.query.platform as string;
      const provider = getProvider(platform);
      const status = await provider.getAuthStatus();
      logger.debug({ platform, status }, "Auth status check");
      res.json({ platform: provider.platform, ...status });
    } catch (err) {
      logger.error({ err }, "Auth status check failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Starting a QR login ultimately persists a credential (see /qrcode/status),
  // so it carries the same admin gate as POST /cookie.
  router.post("/qrcode", requireAdmin, async (req, res) => {
    try {
      const { platform } = req.body;
      const provider = getProvider(platform);
      const qr = await provider.getQrCode();
      logger.info({ platform, key: qr.key }, "QR code generated");
      res.json(qr);
    } catch (err) {
      logger.error({ err }, "QR code generation failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/qrcode/status", requireNotGuest, async (req, res) => {
    try {
      const { key, platform } = req.query;
      if (!key) {
        res.status(400).json({ error: "key is required" });
        return;
      }
      const provider = getProvider(platform as string);
      const status = await provider.checkQrCodeStatus(key as string);
      logger.info({ platform, status, key }, "QR status check");

      // When confirmed, persist cookie
      if (status === "confirmed") {
        const cookie = provider.getCookie();
        const plat = (platform as string) === "bilibili" ? "bilibili" as const
          : (platform as string) === "kugou" ? "kugou" as const
          : (platform as string) === "qq" ? "qq" as const : "netease" as const;
        if (cookie && cookieStore) {
          cookieStore.save(plat, cookie);
          logger.info({ platform: plat }, "Cookie persisted to disk");
        }
      }

      res.json({ status });
    } catch (err) {
      logger.error({ err }, "QR status check failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Jellyfin has no QR/cookie flow — the connection is admin-configured. This
  // round-trips /System/Info so Settings can verify form values BEFORE saving.
  // Empty/missing credential fields fall back to the stored config, so a
  // masked (not re-entered) password still tests the live setup.
  router.post("/jellyfin/test", requirePermission("platform.auth"), async (req, res) => {
    const testable = jellyfinProvider as
      | (MusicProvider & {
          testConnection?: (
            candidate?: JellyfinConfig,
          ) => Promise<{ ok: boolean; serverName?: string; version?: string; error?: string }>;
        })
      | undefined;
    if (!testable?.testConnection) {
      res.status(501).json({ error: "Jellyfin provider not available" });
      return;
    }
    try {
      const body = (req.body ?? {}) as Partial<JellyfinConfig>;
      const stored = config?.jellyfin;
      const str = (v: unknown, fallback: string) =>
        typeof v === "string" && v.trim() !== "" ? v.trim() : fallback;

      // SSRF containment: an admin may point the probe anywhere (self-hosted
      // Jellyfin normally lives on a private address). A non-admin holding the
      // grantable `platform.auth` capability may only re-test the URL the
      // OPERATOR already saved — otherwise they could aim this authenticated
      // request at loopback / link-local / any intranet host and read the
      // upstream ServerName/Version/error back out of the response.
      const isAdmin = req.user?.role === "admin";
      let serverUrl = str(body.serverUrl, stored?.serverUrl ?? "");
      if (!isAdmin) {
        const requestedUrl = str(body.serverUrl, "");
        const storedUrl = stored?.serverUrl ?? "";
        if (requestedUrl && requestedUrl !== storedUrl) {
          res.status(403).json({ error: "admin required to test a new server URL" });
          return;
        }
        serverUrl = storedUrl;
        if (!serverUrl) {
          res.status(400).json({ error: "no stored Jellyfin server URL to test" });
          return;
        }
      } else if (!isHttpUrl(serverUrl)) {
        // An admin can still typo their way into a non-http scheme; that is a
        // configuration error rather than an attack, so answer 400 plainly.
        res.status(400).json({ error: "serverUrl must be an http(s) URL" });
        return;
      }

      const candidate: JellyfinConfig = {
        serverUrl,
        authMode:
          body.authMode === "apikey" || body.authMode === "userpass"
            ? body.authMode
            : stored?.authMode ?? "userpass",
        username: str(body.username, stored?.username ?? ""),
        password: str(body.password, stored?.password ?? ""),
        apiKey: str(body.apiKey, stored?.apiKey ?? ""),
        userId: str(body.userId, stored?.userId ?? ""),
      };
      res.json(await testable.testConnection(candidate));
    } catch (err) {
      logger.error({ err }, "Jellyfin test connection failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/sms/send", requirePermission("platform.auth"), async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) {
        res.status(400).json({ error: "phone is required" });
        return;
      }
      if (!neteaseProvider.sendSmsCode) {
        res
          .status(400)
          .json({ error: "SMS login not supported for this platform" });
        return;
      }
      const success = await neteaseProvider.sendSmsCode(phone);
      res.json({ success });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/sms/verify", requirePermission("platform.auth"), async (req, res) => {
    try {
      const { phone, code } = req.body;
      if (!phone || !code) {
        res.status(400).json({ error: "phone and code are required" });
        return;
      }
      if (!neteaseProvider.loginWithSms) {
        res.status(400).json({ error: "SMS login not supported" });
        return;
      }
      const success = await neteaseProvider.loginWithSms(phone, code);
      if (success && cookieStore) {
        cookieStore.save("netease", neteaseProvider.getCookie());
      }
      res.json({ success });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Credential WRITE. Admin-only: this replaces the process-wide music account
  // cookie that every user of the bot plays through, so a mere `platform.auth`
  // grant was enough to hijack the operator's logged-in account.
  router.post("/cookie", requireAdmin, (req, res) => {
    const { platform, cookie } = req.body;
    if (!cookie) {
      res.status(400).json({ error: "cookie is required" });
      return;
    }
    // YouTube has no cookie concept — reject instead of falling through and
    // clobbering the NetEase cookie entry.
    if (platform === "youtube") {
      res
        .status(400)
        .json({ error: "YouTube does not use cookies (uses yt-dlp binary)" });
      return;
    }
    // Jellyfin auth is server-configured (Settings → connection card), not
    // cookie-based; falling through would clobber the NetEase cookie entry.
    if (platform === "jellyfin") {
      res
        .status(400)
        .json({ error: "Jellyfin 通过 Settings 配置连接，不支持手动 Cookie" });
      return;
    }
    const provider = getProvider(platform);
    provider.setCookie(cookie);
    const plat = platform === "bilibili" ? "bilibili" as const
      : platform === "kugou" ? "kugou" as const
      : platform === "qq" ? "qq" as const : "netease" as const;
    if (cookieStore) {
      cookieStore.save(plat, cookie);
    }
    res.json({ success: true });
  });

  return router;
}
