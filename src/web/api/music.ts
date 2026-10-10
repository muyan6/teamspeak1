import express, { Router, type Response } from "express";
import type { MusicProvider, Song, Album, LyricLine, SearchResult, SearchType } from "../../music/provider.js";
import { YouTubeProvider } from "../../music/youtube.js";
import type { Logger } from "../../logger.js";
import { isProviderEnabled, defaultPlatform, saveConfig, type BotConfig } from "../../data/config.js";
import { LRUCache } from "../../data/cache.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { authorize } from "../middleware/authorize.js";
import { musicContext } from '../../music/media-dto.js';
import { localViewerFor, scopedSearch, scopedSongDetail } from '../../music/local.js';

/**
 * Per-upload cap. Production uploads stream to disk with backpressure and
 * aggregate quota reservations. Only legacy injected Buffer-based providers
 * use the bounded raw-body compatibility parser below.
 */
export const LOCAL_UPLOAD_LIMIT = "500mb";
/** Keep concurrent raw-body buffers bounded across slow disk/ffmpeg uploads. */
export const LOCAL_UPLOAD_MAX_CONCURRENCY = 2;

/**
 * Body parser for the local-upload route.
 *
 * `type` includes "video/*" (#149): the browser sends the File's own MIME
 * type, so an .mp4 arrives as video/mp4 and used to be rejected by this
 * filter before ever reaching the provider. Only the audio track is kept —
 * uploadAudio remuxes it out on the way in.
 *
 * express.raw hands an oversize body to the default error handler, which
 * answers with an HTML page carrying a stack trace and absolute server paths
 * (unless NODE_ENV=production, which this project never sets). Video makes
 * hitting the cap far more likely than audio did, so that one case is
 * translated into the same JSON shape the rest of this route returns. Any
 * other body-parser error is passed on untouched.
 *
 * Exported as a factory so tests can drive the identical path with a small
 * limit instead of allocating half a gigabyte.
 */
export function createLocalUploadBody(limit: string): express.RequestHandler {
  const raw = express.raw({
    type: ["audio/*", "video/*", "application/octet-stream"],
    limit,
  });
  return (req, res, next) => {
    raw(req, res, (err?: unknown) => {
      if (!err) {
        next();
        return;
      }
      const e = err as { type?: string; status?: number };
      if (e?.type === "entity.too.large" || e?.status === 413) {
        res.status(413).json({ error: `文件太大，单个文件上限 ${limit}` });
        return;
      }
      next(err);
    });
  };
}

const localUploadBody = createLocalUploadBody(LOCAL_UPLOAD_LIMIT);

/**
 * Every audio-quality tier recognized by at least one provider, as accepted by
 * POST /api/music/quality. This is the union across sources — a platform-less
 * "broadcast" sends one value to all of them and each keeps only the tiers it
 * knows (jellyfin ignores `lossless`, netease ignores `direct`).
 *
 * NetEase/QQ: standard | higher | exhigh | lossless | hires | jymaster
 * Jellyfin:   direct | 320 | 192 | 128
 * Kugou:      standard | higher | exhigh | lossless | hires | 128 | 320 | flac | high
 * Bilibili / Spotify: free-form passthrough, so they accept any of the above.
 */
const KNOWN_QUALITY_VALUES = new Set([
  "standard",
  "higher",
  "exhigh",
  "lossless",
  "hires",
  "jymaster",
  "direct",
  "128",
  "192",
  "320",
  "flac",
  "high",
]);

export function createMusicRouter(
  neteaseProvider: MusicProvider,
  qqProvider: MusicProvider,
  bilibiliProvider: MusicProvider,
  logger: Logger,
  localProvider?: MusicProvider,
  config?: BotConfig,
  kugouProvider?: MusicProvider,
  spotifyProvider?: MusicProvider,
  jellyfinProvider?: MusicProvider,
  // When set (alongside config), a quality change is persisted to config.json so
  // it survives a restart (#125). Omitted by unit-test routers → no persistence.
  configPath?: string,
): Router {
  const router = Router();
  const youtubeProvider: MusicProvider = new YouTubeProvider();
  let activeLocalUploads = 0;

  const lyricsCache = new LRUCache<string, LyricLine[]>({
    maxSize: 500,
    defaultTtlMs: 6 * 60 * 60 * 1000, // 6 hours
  });
  const albumCache = new LRUCache<string, Song[]>({
    maxSize: 200,
    defaultTtlMs: 60 * 60 * 1000, // 1 hour
  });
  const songDetailCache = new LRUCache<string, Song>({
    maxSize: 500,
    defaultTtlMs: 60 * 60 * 1000, // 1 hour
  });
  const playlistSongsCache = new LRUCache<string, Song[]>({
    maxSize: 200,
    defaultTtlMs: 15 * 60 * 1000, // 15 minutes
  });
  const searchCache = new LRUCache<string, SearchResult>({
    maxSize: 200,
    defaultTtlMs: 3 * 60 * 1000, // 3 minutes
  });

  let cacheContext = '';
  router.use((_req, res, next) => {
    const context = musicContext(config, [neteaseProvider, qqProvider, bilibiliProvider,
      localProvider, kugouProvider, spotifyProvider, jellyfinProvider].filter((p): p is MusicProvider => !!p));
    if (context !== cacheContext) {
      for (const cache of [lyricsCache, albumCache, songDetailCache, playlistSongsCache, searchCache]) cache.clear();
      cacheContext = context;
    }
    res.locals.musicContext = context;
    next();
  });

  router.get('/jellyfin/cover/:id', async (req, res) => {
    if (config && !isProviderEnabled(config, 'jellyfin')) { res.status(404).end(); return; }
    const p = jellyfinProvider as MusicProvider & { getCoverImage?: (id: string, tag?: string) => Promise<{ buffer: Buffer; mime: string } | null> };
    if (!p?.getCoverImage) { res.status(404).end(); return; }
    try {
      const image = await p.getCoverImage(req.params.id, typeof req.query.tag === 'string' ? req.query.tag : '');
      if (!image) { res.status(404).end(); return; }
      res.set('Cache-Control', 'private, max-age=300').type(image.mime).send(image.buffer);
    } catch { res.status(502).end(); }
  });

  const reserveLocalUploadSlot: express.RequestHandler = (_req, res, next) => {
    if (activeLocalUploads >= LOCAL_UPLOAD_MAX_CONCURRENCY) {
      res.status(503).json({ error: "本地上传繁忙，请稍后重试" });
      return;
    }

    activeLocalUploads++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeLocalUploads = Math.max(0, activeLocalUploads - 1);
    };
    res.once("finish", release);
    res.once("close", () => { if (!res.locals.uploadProcessing) release(); });
    res.locals.releaseUploadSlot = release;
    next();
  };

  function isLocalAudioEnabled(): boolean {
    return config?.localAudioEnabled !== false;
  }

  function getProvider(platform?: string): MusicProvider {
    if (platform === "bilibili") return bilibiliProvider;
    if (platform === "youtube") return youtubeProvider;
    if (platform === "local" && localProvider) return localProvider;
    if (platform === "kugou" && kugouProvider) return kugouProvider;
    if (platform === "spotify" && spotifyProvider) return spotifyProvider;
    if (platform === "jellyfin" && jellyfinProvider) return jellyfinProvider;
    return platform === "qq" ? qqProvider : neteaseProvider;
  }

  /**
   * Provider gating for user-supplied platform params. No platform → the
   * configured default (see defaultPlatform(); netease in the default config).
   * A disabled platform gets a friendly 400 and null back — the handler must
   * return immediately. Without a config (unit-test routers), everything
   * stays enabled.
   */
  function resolveProvider(platform: unknown, res: Response): MusicProvider | null {
    const requested = typeof platform === "string" && platform ? platform : undefined;
    const target = requested ?? (config ? defaultPlatform(config) : "netease");
    if (config && !isProviderEnabled(config, target)) {
      res.status(400).json({ error: `音源未启用：${target} (provider disabled)` });
      return null;
    }
    return getProvider(target);
  }

  router.post(
    "/local/upload",
    authorize({ capability: "player.queue", guestFlag: "addToQueue" }),
    (_req, res, next) => {
      if (!isLocalAudioEnabled()) {
        res.status(403).json({ error: "本地音频播放已关闭" });
        return;
      }
      next();
    },
    reserveLocalUploadSlot,
    (req, res, next) => {
      // Legacy injected providers may still consume a Buffer; the production provider streams.
      if (typeof (localProvider as any)?.uploadStream === 'function') {
        if (!req.is(['audio/*', 'video/*', 'application/octet-stream'])) {
          res.status(415).json({ error: 'raw audio body is required' }); return;
        }
        if (Number(req.headers['content-length']) > 500 * 1024 * 1024) {
          res.set('Connection', 'close').status(413).json({ error: '单个文件上限 500 MB' }); return;
        }
        next();
      } else localUploadBody(req, res, next);
    },
    async (req, res) => {
      res.locals.uploadProcessing = true;
      try {
        if (!localProvider) {
          res.status(501).json({ error: "Local upload is not configured" });
          return;
        }
        const uploadCapable = localProvider as MusicProvider & {
          uploadStream?: (input: { stream: AsyncIterable<Uint8Array>; originalName: string; mimeType?: string; signal?: AbortSignal; ownerId?: string }) => Promise<unknown>;
          uploadAudio?: (input: { buffer: Buffer; originalName: string; mimeType?: string; ownerId?: string }) => Promise<unknown>;
        };
        if (!uploadCapable.uploadStream && typeof uploadCapable.uploadAudio !== "function") {
          res.status(501).json({ error: "Local upload is not supported" });
          return;
        }
        if (!uploadCapable.uploadStream && !Buffer.isBuffer(req.body)) {
          res.status(400).json({ error: "raw audio body is required" });
          return;
        }
        const headerName = req.header("x-filename") || req.header("x-file-name") || "audio";
        let originalName = headerName;
        try {
          originalName = decodeURIComponent(headerName);
        } catch {
          // Keep the raw header value if it is not URI encoded.
        }
        const abort = new AbortController();
        const onClose = () => { if (!res.writableFinished) abort.abort(new Error('Upload cancelled')); };
        res.once('close', onClose);
        let song: unknown;
        try {
          // Stamp the upload with its owner so the library can be filtered per
          // viewer. Without this every member could list/play/queue any upload.
          const metadata = { originalName, mimeType: req.header('content-type') || undefined, ownerId: req.user?.id };
          song = uploadCapable.uploadStream
            ? await uploadCapable.uploadStream({ ...metadata, stream: req.iterator({ destroyOnReturn: false }), signal: abort.signal })
            : await uploadCapable.uploadAudio!({ ...metadata, buffer: req.body });
        } finally { res.off('close', onClose); }

        res.json({ song });
      } catch (err) {
        logger.warn({ err }, "Local audio upload failed");
        req.resume();
        if (!req.complete) res.set("Connection", "close");
        const status = (err as { status?: number }).status;
        res.status(status === 413 || status === 507 ? status : 400).json({ error: (err as Error).message });
      } finally { res.locals.releaseUploadSlot?.(); }
    },
  );

  router.get("/search", async (req, res) => {
    try {
      const { q, platform, limit, offset, type } = req.query;
      if (!q) {
        res.status(400).json({ error: "q (query) is required" });
        return;
      }
      if (platform === "local" && !isLocalAudioEnabled()) {
        res.json({ songs: [], playlists: [], albums: [] });
        return;
      }
      const provider = resolveProvider(platform, res);
      if (!provider) return;
      // Server-side pagination: offset lets the web load past the first page.
      // Clamp to >= 0 so a bad/negative value falls back to the first page.
      const parsedOffset = Math.max(0, parseInt(offset as string) || 0);
      const parsedLimit = Math.min(100, Math.max(1, parseInt(limit as string) || 20));
      const parsedType = (typeof type === "string" && ["song", "playlist", "album", "all"].includes(type))
        ? (type as SearchType)
        : "all";
      // The local library is viewer-scoped, while the search cache is shared
      // across users (keyed on config + provider credentials). Fold the viewer
      // into the key for local results, or one member's upload list would be
      // served to the next requester from cache.
      const localScope = provider.platform === "local"
        ? `:u=${req.user?.role === "admin" ? "*" : req.user?.id ?? "-"}`
        : "";
      const cacheKey = `${res.locals.musicContext}:${provider.platform}:${String(q).trim().toLowerCase()}:${parsedLimit}:${parsedOffset}:${parsedType}${localScope}`;
      const cached = searchCache.get(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }
      const viewer = provider.platform === "local" ? localViewerFor(req.user) : undefined;
      const result = viewer
        ? await scopedSearch(provider, viewer, q as string, parsedLimit, parsedOffset, parsedType)
        : parsedType && parsedType !== "all"
          ? await provider.search(
              q as string,
              parsedLimit,
              parsedOffset,
              parsedType
            )
          : await provider.search(
              q as string,
              parsedLimit,
              parsedOffset
            );
      searchCache.set(cacheKey, result);
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Search failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/search/all", async (req, res) => {
    try {
      const { q, limit } = req.query;
      if (!q) {
        res.status(400).json({ error: "q (query) is required" });
        return;
      }
      const parsedLimit = Math.min(100, Math.max(1, parseInt(limit as string) || 20));
      // The merged result embeds the (per-viewer) local library, so the shared
      // cache must be segmented by viewer or one member's uploads leak to the next.
      const viewerScope = `:u=${req.user?.role === "admin" ? "*" : req.user?.id ?? "-"}`;
      const cacheKey = `${res.locals.musicContext}:all:${String(q).trim().toLowerCase()}:${parsedLimit}${viewerScope}`;
      const cached = searchCache.get(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }
      // Spotify is intentionally EXCLUDED from unified /search/all in Stage 1:
      // its tracks are metadata-only (not yet playable) until the librespot audio
      // backend lands (Stage 2/3), so surfacing them in the default all-sources
      // view would only yield results that get skipped. Spotify search remains
      // available from its own tab via /search?platform=spotify.
      // Provider gating (#enabledProviders): disabled sources are skipped, not
      // searched. Jellyfin (an opt-in source) leads the merged results when
      // enabled — a self-hosted library match is almost always the wanted one.
      const enabled = (p: string) => !config || isProviderEnabled(config, p);
      const none = { songs: [], albums: [], playlists: [] };
      const localViewer = localViewerFor(req.user);
      const [jellyfinResult, neteaseResult, qqResult, bilibiliResult, localResult, kugouResult] = await Promise.allSettled([
        jellyfinProvider && enabled("jellyfin") ? jellyfinProvider.search(q as string, parsedLimit) : Promise.resolve(none),
        enabled("netease") ? neteaseProvider.search(q as string, parsedLimit) : Promise.resolve(none),
        enabled("qq") ? qqProvider.search(q as string, parsedLimit) : Promise.resolve(none),
        enabled("bilibili") ? bilibiliProvider.search(q as string, parsedLimit) : Promise.resolve(none),
        localProvider && isLocalAudioEnabled()
          ? scopedSearch(localProvider, localViewer, q as string, parsedLimit, 0)
          : Promise.resolve(none),
        kugouProvider && enabled("kugou") ? kugouProvider.search(q as string, parsedLimit) : Promise.resolve(none),
      ]);

      const songs = [
        ...(jellyfinResult.status === "fulfilled" ? jellyfinResult.value.songs : []),
        ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.songs : []),
        ...(qqResult.status === "fulfilled" ? qqResult.value.songs : []),
        ...(bilibiliResult.status === "fulfilled" ? bilibiliResult.value.songs : []),
        ...(localResult.status === "fulfilled" ? localResult.value.songs : []),
        ...(kugouResult.status === "fulfilled" ? kugouResult.value.songs : []),
      ];
      const albums = [
        ...(jellyfinResult.status === "fulfilled" ? jellyfinResult.value.albums : []),
        ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.albums : []),
        ...(qqResult.status === "fulfilled" ? qqResult.value.albums : []),
      ];
      const playlists = [
        ...(jellyfinResult.status === "fulfilled" ? jellyfinResult.value.playlists : []),
        ...(neteaseResult.status === "fulfilled" ? neteaseResult.value.playlists : []),
        ...(qqResult.status === "fulfilled" ? qqResult.value.playlists : []),
      ];

      const errors: Record<string, string> = {};
      const checkError = (plat: string, res: PromiseSettledResult<SearchResult>) => {
        if (res.status === "rejected") {
          errors[plat] = (res.reason as Error)?.message || `${plat} search failed`;
        } else if (res.value?.error) {
          errors[plat] = res.value.error.message;
        }
      };
      checkError("jellyfin", jellyfinResult);
      checkError("netease", neteaseResult);
      checkError("qq", qqResult);
      checkError("bilibili", bilibiliResult);
      checkError("local", localResult);
      checkError("kugou", kugouResult);

      const result: SearchResult & { errors?: Record<string, string> } = {
        songs,
        albums,
        playlists,
        ...(Object.keys(errors).length > 0 ? { errors } : {}),
      };
      searchCache.set(cacheKey, result);
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Unified search failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/song/:id", async (req, res) => {
    try {
      if (req.query.platform === "local" && !isLocalAudioEnabled()) {
        res.status(403).json({ error: "本地音频播放已关闭" });
        return;
      }
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      const platKey = String(req.query.platform ?? "default");
      // Local detail is ownership-gated, so it must not share a cache entry
      // across viewers (same reasoning as the search cache above).
      const detailScope = provider.platform === "local"
        ? `:u=${req.user?.role === "admin" ? "*" : req.user?.id ?? "-"}`
        : "";
      const cacheKey = `${res.locals.musicContext}:${platKey}:${req.params.id}${detailScope}`;
      const cached = songDetailCache.get(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }
      const song = await scopedSongDetail(provider, localViewerFor(req.user), req.params.id);
      if (!song) {
        res.status(404).json({ error: "Song not found" });
        return;
      }
      songDetailCache.set(cacheKey, song);
      res.json(song);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/playlist/:id", async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      const platKey = String(req.query.platform ?? "default");
      const cacheKey = `${res.locals.musicContext}:${platKey}:${req.params.id}`;
      const cached = playlistSongsCache.get(cacheKey);
      if (cached) {
        res.json({ songs: cached });
        return;
      }
      const songs = await provider.getPlaylistSongs(req.params.id);
      playlistSongsCache.set(cacheKey, songs);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/playlists", async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      const playlists = await provider.getRecommendPlaylists();
      res.json({ playlists });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/album/:id", async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      const platKey = String(req.query.platform ?? "default");
      const cacheKey = `${res.locals.musicContext}:${platKey}:${req.params.id}`;
      const cached = albumCache.get(cacheKey);
      if (cached) {
        res.json({ songs: cached });
        return;
      }
      const songs = await provider.getAlbumSongs(req.params.id);
      albumCache.set(cacheKey, songs);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/lyrics/:id", async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      const platKey = String(req.query.platform ?? "default");
      const cacheKey = `${res.locals.musicContext}:${platKey}:${req.params.id}`;
      const cached = lyricsCache.get(cacheKey);
      if (cached) {
        res.json({ lyrics: cached });
        return;
      }
      const lyrics = await provider.getLyrics(req.params.id);
      lyricsCache.set(cacheKey, lyrics);
      res.json({ lyrics });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/songs", requireNotGuest, async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      if (!provider.getDailyRecommendSongs) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const songs = await provider.getDailyRecommendSongs();
      res.json({ songs });
    } catch (err) {
      logger.error({ err }, "Get daily recommend songs failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/personal/fm", requireNotGuest, async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      if (!provider.getPersonalFm) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const songs = await provider.getPersonalFm();
      res.json({ songs });
    } catch (err) {
      logger.error({ err }, "Get personal FM failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/user/playlists", requireNotGuest, async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      if (!provider.getUserPlaylists) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const playlists = await provider.getUserPlaylists();
      res.json({ playlists });
    } catch (err) {
      logger.error({ err }, "Get user playlists failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/playlist/:id/detail", async (req, res) => {
    try {
      const provider = resolveProvider(req.query.platform, res);
      if (!provider) return;
      if (!provider.getPlaylistDetail) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const detail = await provider.getPlaylistDetail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: "Playlist not found" });
        return;
      }
      res.json({ playlist: detail });
    } catch (err) {
      logger.error({ err }, "Get playlist detail failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // B站热门视频
  router.get("/bilibili/popular", async (req, res) => {
    try {
      if (!resolveProvider('bilibili', res)) return;
      const provider = bilibiliProvider as any;
      if (provider.getPopularVideos) {
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const songs = await provider.getPopularVideos(limit);
        res.json({ songs });
      } else {
        res.json({ songs: [] });
      }
    } catch (err) {
      logger.error({ err }, "Get bilibili popular failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Enabled sources + default platform, for the web UI (source tabs, default
  // search/playback source). Without a config (unit-test routers) everything
  // reports enabled with the legacy netease default.
  router.get("/providers", (_req, res) => {
    const ALL_PLATFORMS = [
      "jellyfin",
      "netease",
      "qq",
      "bilibili",
      "youtube",
      "kugou",
      "spotify",
      "local",
    ];
    res.json({
      enabled: config ? ALL_PLATFORMS.filter((p) => isProviderEnabled(config, p)) : ALL_PLATFORMS,
      default: config ? defaultPlatform(config) : "netease",
    });
  });

  // ─── Jellyfin home-page data ───────────────────────────────────────────
  // The concrete JellyfinProvider surface these endpoints consume; the router
  // only knows the MusicProvider interface, so narrow structurally (same
  // pattern as localProvider.uploadAudio above).
  type JellyfinHomeProvider = MusicProvider & {
    getLatestAlbums?: (limit?: number) => Promise<Album[]>;
    getMostPlayed?: (limit?: number) => Promise<Song[]>;
    getFavoriteSongs?: (limit?: number) => Promise<Song[]>;
    getGenres?: (limit?: number) => Promise<{ id: string; name: string }[]>;
    getGenreSongs?: (genreId: string, limit?: number) => Promise<Song[]>;
  };
  const jellyfinHome = jellyfinProvider as JellyfinHomeProvider | undefined;

  /** 501 when no provider is wired, 400 when the source is disabled. */
  function jellyfinOrReject(res: Response): JellyfinHomeProvider | null {
    if (!jellyfinHome) {
      res.status(501).json({ error: "Jellyfin provider not configured" });
      return null;
    }
    if (config && !isProviderEnabled(config, "jellyfin")) {
      res.status(400).json({ error: "音源未启用：jellyfin (provider disabled)" });
      return null;
    }
    return jellyfinHome;
  }

  router.get("/jellyfin/latest-albums", async (req, res) => {
    try {
      const p = jellyfinOrReject(res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 12;
      res.json({ albums: (await p.getLatestAlbums?.(limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin latest albums failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/jellyfin/most-played", async (req, res) => {
    try {
      const p = jellyfinOrReject(res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 12;
      res.json({ songs: (await p.getMostPlayed?.(limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin most played failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Favorites are account-level data — guests don't get them (matches the
  // requireNotGuest gate on /user/playlists).
  router.get("/jellyfin/favorites", requireNotGuest, async (req, res) => {
    try {
      const p = jellyfinOrReject(res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 100;
      res.json({ songs: (await p.getFavoriteSongs?.(limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin favorites failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/jellyfin/genres", async (req, res) => {
    try {
      const p = jellyfinOrReject(res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 30;
      res.json({ genres: (await p.getGenres?.(limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin genres failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/jellyfin/genre/:id/songs", async (req, res) => {
    try {
      const p = jellyfinOrReject(res);
      if (!p) return;
      const limit = parseInt(req.query.limit as string) || 100;
      res.json({ songs: (await p.getGenreSongs?.(req.params.id, limit)) ?? [] });
    } catch (err) {
      logger.error({ err }, "Jellyfin genre songs failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get current quality
  router.get("/quality", requireNotGuest, (_req, res) => {
    res.json({
      netease: neteaseProvider.getQuality(),
      qq: qqProvider.getQuality(),
      bilibili: bilibiliProvider.getQuality(),
      local: localProvider?.getQuality() ?? "original",
      kugou: kugouProvider?.getQuality() ?? "128",
      spotify: spotifyProvider?.getQuality() ?? "320",
      jellyfin: jellyfinProvider?.getQuality() ?? "direct",
    });
  });

  // Set quality
  //
  // P2-21: `requirePermission("quality")` is a GRANTABLE capability, but the
  // provider instances are process-wide — one member holding it silently changed
  // the audio quality for every bot and every other user. That is platform
  // administration (same reasoning as `/api/bot/settings`, which is admin-only),
  // so it requires admin now.
  router.post("/quality", requireAdmin, (req, res) => {
    const { quality, platform } = req.body;
    if (!quality) {
      res.status(400).json({ error: "quality is required" });
      return;
    }
    // Validate the value here rather than trusting each provider's setQuality()
    // to ignore junk. Some of them (bilibili, spotify) store the string verbatim
    // and feed it straight into an upstream API parameter, so an object or a
    // 10 KB string reached the request URL. The union below is every tier any
    // provider recognizes; a provider silently ignores a tier that isn't its own
    // (jellyfin drops `lossless`, netease drops `direct`), which is the intended
    // cross-platform broadcast behavior.
    if (typeof quality !== "string" || !KNOWN_QUALITY_VALUES.has(quality)) {
      res.status(400).json({ error: "invalid quality" });
      return;
    }
    // Snapshot the LIVE per-provider values before applying, so a failed
    // persist can be rolled back — the in-memory change would otherwise outlive
    // the request while the on-disk config still held the old tier, leaving the
    // two disagreeing until the next successful save.
    const previous = {
      netease: neteaseProvider.getQuality(),
      qq: qqProvider.getQuality(),
      bilibili: bilibiliProvider.getQuality(),
      kugou: kugouProvider?.getQuality(),
      spotify: spotifyProvider?.getQuality(),
      jellyfin: jellyfinProvider?.getQuality(),
    };
    if (!platform || platform === "netease") {
      neteaseProvider.setQuality(quality);
    }
    if (!platform || platform === "qq") {
      qqProvider.setQuality(quality);
    }
    if (!platform || platform === "bilibili") {
      bilibiliProvider.setQuality(quality);
    }
    if ((!platform || platform === "kugou") && kugouProvider) {
      kugouProvider.setQuality(quality);
    }
    if ((!platform || platform === "spotify") && spotifyProvider) {
      spotifyProvider.setQuality(quality);
    }
    // Safe in the platform-less broadcast: JellyfinProvider.setQuality ignores
    // values outside its own tier list (direct/320/192/128).
    if ((!platform || platform === "jellyfin") && jellyfinProvider) {
      jellyfinProvider.setQuality(quality);
    }

    // Persist the (post-apply) per-provider quality so it survives a restart
    // (#125). Snapshotting each provider's getQuality() AFTER setQuality captures
    // exactly what each one accepted (jellyfin ignores foreign tiers, kugou maps
    // aliases), so replaying these on startup reproduces this state faithfully.
    if (config && configPath) {
      const next = {
        netease: neteaseProvider.getQuality(),
        qq: qqProvider.getQuality(),
        bilibili: bilibiliProvider.getQuality(),
        kugou: kugouProvider?.getQuality() ?? config.audioQuality.kugou,
        jellyfin: jellyfinProvider?.getQuality() ?? config.audioQuality.jellyfin,
        spotify: spotifyProvider?.getQuality() ?? config.audioQuality.spotify,
      };
      const savedQuality = config.audioQuality;
      config.audioQuality = next;
      try {
        saveConfig(configPath, config);
      } catch (err) {
        logger.error({ err }, "Failed to persist audio quality — rolling back");
        config.audioQuality = savedQuality;
        if (previous.netease !== undefined) neteaseProvider.setQuality(previous.netease);
        if (previous.qq !== undefined) qqProvider.setQuality(previous.qq);
        if (previous.bilibili !== undefined) bilibiliProvider.setQuality(previous.bilibili);
        if (previous.kugou !== undefined && kugouProvider) kugouProvider.setQuality(previous.kugou);
        if (previous.spotify !== undefined && spotifyProvider) spotifyProvider.setQuality(previous.spotify);
        if (previous.jellyfin !== undefined && jellyfinProvider) jellyfinProvider.setQuality(previous.jellyfin);
        res.status(500).json({ error: "failed to persist audio quality" });
        return;
      }
    }

    logger.info({ quality, platform }, "Audio quality changed");
    res.json({ success: true, quality });
  });

  return router;
}
