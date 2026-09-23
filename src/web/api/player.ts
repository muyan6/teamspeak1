import { Router } from "express";
import type { Request, Response } from "express";
import type { BotManager } from "../../bot/manager.js";
import type { BotDatabase } from "../../data/database.js";
import type { MusicProvider, Platform, Song } from "../../music/provider.js";
import type { Logger } from "../../logger.js";
import type { BotInstance } from "../../bot/instance.js";
import { parseCommand } from "../../bot/commands.js";
import { requireBotAccess } from "../middleware/requirePermission.js";
import { authorize } from "../middleware/authorize.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";

declare module "express-serve-static-core" {
  interface Request {
    bot?: BotInstance;
  }
}

export function createPlayerRouter(
  botManager: BotManager,
  logger: Logger,
  database?: BotDatabase,
  neteaseProvider?: MusicProvider,
  qqProvider?: MusicProvider,
  bilibiliProvider?: MusicProvider,
): Router {
  const router = Router();

  // Access check runs BEFORE the existence/resolver check so a member who is
  // not allowed a bot always gets a uniform 403 — whether or not the bot
  // exists — instead of a 404 that would leak which bot IDs are real.
  // requireBotAccess only needs req.params.botId and req.user (set by the
  // global requireAuth mounted earlier), so it works before the resolver.
  router.use("/:botId", requireBotAccess("botId"));

  router.use("/:botId", (req, res, next) => {
    const bot = botManager.getBot(req.params.botId);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    req.bot = bot;
    next();
  });

  const SUPPORTED_PLATFORMS = new Set<Platform>([
    "netease",
    "qq",
    "bilibili",
    "youtube",
    "local",
    "kugou",
    "spotify",
    "jellyfin",
  ]);

  function requestBot(req: Request): BotInstance {
    if (!req.bot) throw new Error("Bot context is unavailable");
    return req.bot;
  }

  function selectPlatform(bot: BotInstance, platform: unknown, res: Response): Platform | null {
    const requested = platform === undefined || platform === null || platform === ""
      ? undefined
      : platform;
    if (requested !== undefined && (typeof requested !== "string" || !SUPPORTED_PLATFORMS.has(requested as Platform))) {
      res.status(400).json({ error: "invalid platform" });
      return null;
    }
    try {
      const selected = (requested as Platform | undefined) ?? bot.getDefaultPlatform();
      bot.assertProviderEnabled(selected);
      return selected;
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return null;
    }
  }

  /** Map API platform string to the corresponding command flag. */
  const platformFlag = (platform: unknown): string => {
    if (platform === "bilibili") return "-b";
    if (platform === "qq") return "-q";
    if (platform === "youtube") return "-y";
    if (platform === "kugou") return "-k";
    if (platform === "local") return "-l";
    if (platform === "spotify") return "-s";
    if (platform === "jellyfin") return "-j";
    // The flag-less default is now the configured default platform (jellyfin
    // unless disabled), so netease needs an explicit flag.
    if (platform === "netease") return "-n";
    return "";
  };

  function isLocalAudioDisabled(bot: BotInstance, platform: unknown): boolean {
    return platform === "local" &&
      typeof bot.isLocalAudioEnabled === "function" &&
      !bot.isLocalAudioEnabled();
  }

  function rejectDisabledLocalAudio(res: Response): void {
    res.status(403).json({ error: "本地音频播放已关闭" });
  }

  /**
   * Reject free-text that would be re-parsed as command syntax. The command
   * parser splits on whitespace and treats any 2-char "-x" token as a flag, so
   * a query of "song -b" silently switched the provider and a playlistId of
   * "x -q" did the same. Newlines are rejected too — they would split one
   * request into several commands.
   */
  function invalidCommandText(value: unknown): boolean {
    return (
      typeof value !== "string" ||
      value.trim() === "" ||
      /[\r\n]/.test(value) ||
      value.trim().startsWith("-")
    );
  }

  function requesterName(req: Request): string {
    const name = req.user?.username;
    return typeof name === "string" && name.trim() ? name.trim() : "游客";
  }

  function executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs = 25000,
    errorMsg = "Operation timed out",
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(errorMsg));
      }, timeoutMs);
      timer.unref?.();
      promise.then(
        (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  router.post("/:botId/play", authorize({ capability: "player.control" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { query, platform } = req.body;
      if (invalidCommandText(query)) {
        res.status(400).json({ error: "query is required" });
        return;
      }
      if (selectPlatform(bot, platform, res) === null) return;
      const cmd = parseCommand(`!play ${platformFlag(platform)} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }
      const response = await executeWithTimeout(bot.executeCommand(cmd, undefined, requesterName(req)));
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/add", authorize({ capability: "player.queue", guestFlag: "addToQueue" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { query, platform } = req.body;
      if (invalidCommandText(query)) {
        res.status(400).json({ error: "query is required" });
        return;
      }
      if (selectPlatform(bot, platform, res) === null) return;
      const cmd = parseCommand(`!add ${platformFlag(platform)} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }
      const response = await executeWithTimeout(bot.executeCommand(cmd, undefined, requesterName(req)));
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const simpleCommand = (cmdStr: string) => async (req: Request, res: Response) => {
    try {
      const bot = requestBot(req);
      const cmd = parseCommand(cmdStr, "!")!;
      const response = await executeWithTimeout(bot.executeCommand(cmd));
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  };

  router.post("/:botId/pause", authorize({ capability: "player.control", guestFlag: "transport" }), simpleCommand("!pause"));
  router.post("/:botId/resume", authorize({ capability: "player.control", guestFlag: "transport" }), simpleCommand("!resume"));
  router.post("/:botId/next", authorize({ capability: "player.control", guestFlag: "skip" }), simpleCommand("!next"));
  router.post("/:botId/prev", authorize({ capability: "player.control" }), simpleCommand("!prev"));
  router.post("/:botId/stop", authorize({ capability: "player.control" }), simpleCommand("!stop"));
  router.post("/:botId/clear", authorize({ capability: "player.queue", guestFlag: "removeClear" }), simpleCommand("!clear"));

  router.post("/:botId/fm", authorize({ capability: "player.control", guestFlag: "playMode" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { platform } = req.body;
      const selectedPlatform = selectPlatform(bot, platform, res);
      if (selectedPlatform === null) return;
      if (isLocalAudioDisabled(bot, platform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      const provider = bot.getProviderFor(selectedPlatform);
      const message = await executeWithTimeout(bot.startFm(provider, requesterName(req)));
      res.json({
        ok:
          !message.startsWith("No FM songs") &&
          !message.includes("not available") &&
          !message.includes("not connected"),
        message,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/volume", authorize({ capability: "player.control", guestFlag: "transport" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { volume } = req.body;
      // Reject bad input with a proper 4xx instead of letting cmdVol
      // return a "Usage:" string inside a 200 body — API clients can't
      // detect that failure mode, and the UI would silently swallow it.
      if (
        typeof volume !== "number" ||
        !Number.isFinite(volume) ||
        volume < 0 ||
        volume > 100
      ) {
        res
          .status(400)
          .json({ error: "volume must be a number between 0 and 100" });
        return;
      }
      const cmd = parseCommand(`!vol ${Math.round(volume)}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const VALID_MODES = new Set(["seq", "loop", "random", "rloop"]);

  router.post("/:botId/mode", authorize({ capability: "player.control", guestFlag: "playMode" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { mode } = req.body;
      if (typeof mode !== "string" || !VALID_MODES.has(mode)) {
        res
          .status(400)
          .json({ error: "mode must be one of: seq, loop, random, rloop" });
        return;
      }
      const cmd = parseCommand(`!mode ${mode}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get current elapsed time (ground truth from server)
  // Read-only, but still gated on requireNotGuest: guests are scoped to a
  // whitelist of playback ACTIONS, and exposing live progress/queue/history to
  // a login-less visitor is data these routes were never meant to publish.
  router.get("/:botId/elapsed", requireNotGuest, (req, res) => {
      const bot = requestBot(req);
    res.json({ elapsed: bot.getPlayer().getElapsed() });
  });

  // Seek to position
  router.post("/:botId/seek", authorize({ capability: "player.control", guestFlag: "transport" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { position } = req.body; // seconds
      // typeof NaN === "number" and NaN < 0 is false, so a plain range
      // check lets NaN/Infinity through and later corrupts seekOffset.
      if (typeof position !== "number" || !Number.isFinite(position) || position < 0) {
        res
          .status(400)
          .json({ error: "position must be a finite non-negative number" });
        return;
      }
      bot.seek(position);
      res.json({ message: `Seeked to ${Math.floor(position)}s`, seekOffset: position });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:botId/queue", requireNotGuest, (req, res) => {
      const bot = requestBot(req);
    res.json({ queue: bot.getQueue(), status: bot.getStatus() });
  });

  router.delete("/:botId/queue/:index", authorize({ capability: "player.queue", guestFlag: "removeClear" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      // The index is interpolated into a command string, so a non-numeric value
      // (e.g. "1 -b") would be parsed as extra flags/args instead of an index.
      if (!/^\d+$/.test(req.params.index)) {
        res.status(400).json({ error: "index must be a non-negative integer" });
        return;
      }
      const cmd = parseCommand(`!remove ${req.params.index}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Jump to a specific index in the queue (without clearing it)
  router.post("/:botId/play-at", authorize({ capability: "player.control" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { index } = req.body;
      if (!Number.isInteger(index) || index < 0) {
        res.status(400).json({ error: "Valid integer index is required" });
        return;
      }
      // Serialize the index-validation + stop/reset/playAt/resolveAndPlay so a
      // concurrent request can't interleave between mutating the queue and
      // starting playback (audible track must match queue.currentIndex).
      const result = await bot.runExclusive(async () => {
        const queue = bot.getQueueManager();
        // Validate the index BEFORE stopping current playback — otherwise an
        // invalid index silently kills the user's current song and leaves the
        // queue idle.
        if (index >= queue.size()) {
          return { status: 400 as const, body: { error: "Invalid queue index" } };
        }
        bot.getPlayer().stop();
        bot.getPlayer().resetFailures();
        const song = queue.playAt(index);
        if (!song) {
          return { status: 400 as const, body: { error: "Invalid queue index" } };
        }
        const ok = await bot.resolveAndPlay(song);
        if (!ok) {
          return { body: { message: `Cannot play: ${song.name}` } };
        }
        return { body: { message: `Now playing: ${song.name} - ${song.artist}` } };
      });
      if (result.status) {
        res.status(result.status).json(result.body);
        return;
      }
      res.json(result.body);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/playlist", authorize({ capability: "player.queue" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { playlistId, platform } = req.body;
      if (invalidCommandText(playlistId)) {
        res.status(400).json({ error: "playlistId is required" });
        return;
      }
      if (selectPlatform(bot, platform, res) === null) return;
      const cmd = parseCommand(
        `!playlist ${platformFlag(platform)} ${playlistId}`.trim(),
        "!"
      )!;
      const response = await bot.executeCommand(cmd, undefined, requesterName(req));
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play a playlist by ID — stores metadata only, resolves URL for first song
  // Respects current play mode (random = pick random first song)
  router.post("/:botId/play-playlist", authorize({ capability: "player.control", guestFlag: "playCollection" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { playlistId, platform } = req.body;
      if (invalidCommandText(playlistId)) {
        res.status(400).json({ error: "playlistId is required" });
        return;
      }
      const selectedPlatform = selectPlatform(bot, platform, res);
      if (selectedPlatform === null) return;
      if (isLocalAudioDisabled(bot, platform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      const provider = bot.getProviderFor(selectedPlatform);

      const songs = await provider.getPlaylistSongs(playlistId);
      if (songs.length === 0) {
        res.json({ message: "Playlist is empty" });
        return;
      }

      // QQ-specific optimization: many users' QQ playlists contain a
      // large fraction of songs that return result=104003 (region/copyright
      // restricted). Batch-resolve URLs once and only queue the playable
      // ones, otherwise the playback retry loop wastes time guessing.
      let queueable: Song[] = songs;
      const totalCount = songs.length;
      const qqLike = provider as { getPlayableSongIds?: (ids: string[]) => Promise<Set<string> | null> };
      if (typeof qqLike.getPlayableSongIds === "function") {
        const playable = await qqLike.getPlayableSongIds(songs.map((s: { id: string }) => s.id));
        if (playable !== null) {
          // Authoritative answer from upstream — even an empty set means
          // "we know none are playable", short-circuit immediately rather
          // than wasting 20+ retries.
          queueable = songs.filter((s: { id: string }) => playable.has(s.id));
        }
        // If null, the batch endpoint itself errored — fall through to
        // the sequential retry path, which still has a chance.
      }
      if (queueable.length === 0) {
        res.json({ ok: false, message: `歌单 ${totalCount} 首歌曲均无版权可播放（区域/版权限制）` });
        return;
      }

      const loadedMsg = queueable.length < totalCount
        ? `已加载 ${queueable.length}/${totalCount} 首（其余区域/版权限制）`
        : `已加载 ${queueable.length} 首`;
      const result = await bot.runExclusive(async () => {
        bot.getPlayer().stop();
        bot.getPlayer().resetFailures();
        const queue = bot.getQueueManager();
        queue.clear();
        for (const song of queueable) {
          queue.add({ ...song, platform: provider.platform, requestedBy: requesterName(req) });
        }
        bot.cleanupQueuedLocalSongs?.("queue_replaced");

        const mode = queue.getMode();
        let first;
        if (mode === "random" || mode === "rloop") {
          const idx = Math.floor(Math.random() * queue.size());
          first = queue.playAt(idx);
        } else {
          first = queue.play();
        }

        let started = first ? await bot.resolveAndPlay(first) : false;
        if (first && !started) started = await bot.playNext(20);
        return { started, playing: queue.current() };
      });
      if (result.started && result.playing) {
        res.json({ ok: true, message: `${loadedMsg}，正在播放：${result.playing.name}` });
      } else {
        res.json({ ok: false, message: `${loadedMsg}，但无法开始播放。` });
      }
    } catch (err) {
      logger.error({ err }, "Play playlist failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play an album by ID — mirrors play-playlist but calls getAlbumSongs
  router.post("/:botId/play-album", authorize({ capability: "player.control", guestFlag: "playCollection" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { albumId, platform } = req.body;
      if (!albumId || typeof albumId !== "string") {
        res.status(400).json({ error: "albumId is required" });
        return;
      }
      const selectedPlatform = selectPlatform(bot, platform, res);
      if (selectedPlatform === null) return;
      if (isLocalAudioDisabled(bot, platform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      const provider = bot.getProviderFor(selectedPlatform);

      const songs = await provider.getAlbumSongs(albumId);
      if (songs.length === 0) {
        res.json({ message: "Album is empty" });
        return;
      }

      // QQ-specific optimization: batch-resolve playable IDs to avoid
      // wasting retries on region/copyright-restricted tracks.
      let queueable: Song[] = songs;
      const totalCount = songs.length;
      const qqLike = provider as { getPlayableSongIds?: (ids: string[]) => Promise<Set<string> | null> };
      if (typeof qqLike.getPlayableSongIds === "function") {
        const playable = await qqLike.getPlayableSongIds(songs.map((s: { id: string }) => s.id));
        if (playable !== null) {
          queueable = songs.filter((s: { id: string }) => playable.has(s.id));
        }
      }
      if (queueable.length === 0) {
        res.json({ ok: false, message: `专辑 ${totalCount} 首歌曲均无版权可播放（区域/版权限制）` });
        return;
      }

      const loadedMsg = queueable.length < totalCount
        ? `已加载 ${queueable.length}/${totalCount} 首（其余区域/版权限制）`
        : `已加载 ${queueable.length} 首`;
      const result = await bot.runExclusive(async () => {
        bot.getPlayer().stop();
        bot.getPlayer().resetFailures();
        const queue = bot.getQueueManager();
        queue.clear();
        for (const song of queueable) {
          queue.add({ ...song, platform: provider.platform, requestedBy: requesterName(req) });
        }
        bot.cleanupQueuedLocalSongs?.("queue_replaced");

        const mode = queue.getMode();
        let first;
        if (mode === "random" || mode === "rloop") {
          const idx = Math.floor(Math.random() * queue.size());
          first = queue.playAt(idx);
        } else {
          first = queue.play();
        }

        let started = first ? await bot.resolveAndPlay(first) : false;
        if (first && !started) started = await bot.playNext(20);
        return { started, playing: queue.current() };
      });
      if (result.started && result.playing) {
        res.json({ ok: true, message: `${loadedMsg}，正在播放：${result.playing.name}` });
      } else {
        res.json({ ok: false, message: `${loadedMsg}，但无法开始播放。` });
      }
    } catch (err) {
      logger.error({ err }, "play-album failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play a single song by ID — resolves URL on demand. Funnels through
  // bot.playSingleSong so the config.playKeepsQueue decision (clear-and-play vs
  // insert-and-jump, keeping the queue) lives in one place shared with chat
  // !play. Serialized via runExclusive like /play-now-song so concurrent
  // requests can't interleave the queue mutation + playback (#119).
  router.post("/:botId/play-by-id", authorize({ capability: "player.control" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { songId, platform } = req.body;
      if (!songId || typeof songId !== "string") {
        res.status(400).json({ error: "songId is required" });
        return;
      }
      const selectedPlatform = selectPlatform(bot, platform, res);
      if (selectedPlatform === null) return;
      if (isLocalAudioDisabled(bot, selectedPlatform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      const provider = bot.getProviderFor(selectedPlatform);
      const song = await provider.getSongDetail(songId);
      if (!song) {
        res.status(404).json({ error: "Song not found" });
        return;
      }
      const body = await bot.runExclusive(async () => {
        const ok = await bot.playSingleSong({ ...song, platform: selectedPlatform }, requesterName(req));
        return ok
          ? { ok: true, message: `正在播放：${song.name || songId} - ${song.artist || ""}` }
          : { ok: false, message: `无法播放「${song.name || songId}」（区域/版权限制）` };
      });
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/play-song", authorize({ capability: "player.control" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
      const selectedPlatform = selectPlatform(bot, song.platform, res);
      if (selectedPlatform === null) return;
      if (isLocalAudioDisabled(bot, selectedPlatform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      // The cleanupQueuedLocalSongs sweep now lives inside playSingleSong's
      // clear branch — do NOT also call it here, or it would delete retained
      // local uploads in keep-queue mode.
      const body = await bot.runExclusive(async () => {
        const ok = await bot.playSingleSong({ ...song, platform: selectedPlatform }, requesterName(req));
        return ok
          ? { ok: true, message: `正在播放：${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` }
          : { ok: false, message: `无法播放「${song.name || song.id}」（区域/版权限制）` };
      });
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Insert a single song to play right after the current one.
  // If nothing is playing, behaves like /play-song (start immediately).
  router.post("/:botId/play-next-song", authorize({ capability: "player.control", guestFlag: "playNext" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
      const selectedPlatform = selectPlatform(bot, song.platform, res);
      if (selectedPlatform === null) return;
      if (isLocalAudioDisabled(bot, selectedPlatform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      // Serialize the queue mutation + playback so concurrent requests can't
      // interleave (audible track must match queue.currentIndex).
      const body = await bot.runExclusive(async () => {
        const queue = bot.getQueueManager();
        const wasIdle = bot.getPlayer().getState() === "idle";
        // Capture the slot addNext WILL insert at, before mutating the queue.
        // addNext pushes when currentIndex<0 (slot = size); otherwise splices
        // at currentIndex+1. Using size-1 after addNext was wrong when the
        // queue had stale currentIndex>=0 while the player was idle (e.g.,
        // after natural track end without queue.clear()).
        const insertedAt =
          queue.getCurrentIndex() < 0 ? queue.size() : queue.getCurrentIndex() + 1;
        queue.addNext({ ...song, platform: selectedPlatform, requestedBy: requesterName(req) });

        if (wasIdle) {
          // Promote the just-added song to current and start it.
          queue.playAt(insertedAt);
          bot.getPlayer().resetFailures();
          const ok = await bot.resolveAndPlay(queue.current()!);
          if (!ok) {
            return { ok: false, message: `无法播放「${song.name || song.id}」（区域/版权限制）` };
          }
          return { ok: true, message: `正在播放：${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` };
        }

        return { ok: true, message: `已加入下一首：${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` };
      });
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play a song "now" without clearing the queue: insert after current, then
  // promote to current and start it. Non-destructive (unlike /play-song which
  // clears the whole queue) — this is the guest-safe "play now".
  router.post("/:botId/play-now-song", authorize({ capability: "player.control", guestFlag: "playNow" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
      const selectedPlatform = selectPlatform(bot, song.platform, res);
      if (selectedPlatform === null) return;
      if (isLocalAudioDisabled(bot, selectedPlatform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      // Serialize the insert-after-current + promote + playback so concurrent
      // requests can't interleave (audible track must match queue.currentIndex).
      const body = await bot.runExclusive(async () => {
        const queue = bot.getQueueManager();
        const insertedAt =
          queue.getCurrentIndex() < 0 ? queue.size() : queue.getCurrentIndex() + 1;
        queue.addNext({ ...song, platform: selectedPlatform, requestedBy: requesterName(req) });
        queue.playAt(insertedAt);
        bot.getPlayer().resetFailures();
        const ok = await bot.resolveAndPlay(queue.current()!);
        if (!ok) {
          return { ok: false, message: `无法播放「${song.name || song.id}」（区域/版权限制）` };
        }
        return { ok: true, message: `正在播放：${song.name || "Unknown"} - ${song.artist || "Unknown"}` };
      });
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/add-song", authorize({ capability: "player.queue", guestFlag: "addToQueue" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { song } = req.body;
      if (!song || !song.id || !song.platform) {
        res.status(400).json({ error: "song object with id and platform is required" });
        return;
      }
      const selectedPlatform = selectPlatform(bot, song.platform, res);
      if (selectedPlatform === null) return;
      if (isLocalAudioDisabled(bot, selectedPlatform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      // Serialize the queue mutation + (possible) playback so concurrent
      // requests can't interleave (audible track must match queue.currentIndex).
      const body = await bot.runExclusive(async () => {
        const queue = bot.getQueueManager();
        const wasIdle = bot.getPlayer().getState() === "idle";
        queue.add({ ...song, platform: selectedPlatform, requestedBy: requesterName(req) });

        // If nothing was playing, start this newly-added song immediately.
        if (wasIdle) {
          queue.playAt(queue.size() - 1);
          bot.getPlayer().resetFailures();
          await bot.resolveAndPlay(queue.current()!);
          return { message: `Now playing: ${song.name || 'Unknown'} - ${song.artist || 'Unknown'}` };
        }

        return { message: `Added to queue: ${song.name || 'Unknown'} - ${song.artist || 'Unknown'} (position ${queue.size()})` };
      });
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Add a song to queue by ID — metadata only
  router.post("/:botId/add-by-id", authorize({ capability: "player.queue", guestFlag: "addToQueue" }), async (req, res) => {
    try {
      const bot = requestBot(req);
      const { songId, platform } = req.body;
      if (!songId || typeof songId !== "string") {
        res.status(400).json({ error: "songId is required" });
        return;
      }
      const selectedPlatform = selectPlatform(bot, platform, res);
      if (selectedPlatform === null) return;
      if (isLocalAudioDisabled(bot, selectedPlatform)) {
        rejectDisabledLocalAudio(res);
        return;
      }
      const provider = bot.getProviderFor(selectedPlatform);

      const song = await provider.getSongDetail(songId);
      if (!song) {
        res.json({ message: "Song not found" });
        return;
      }

      const queue = bot.getQueueManager();
      const body = await bot.runExclusive(async () => {
        const wasIdle = bot.getPlayer().getState() === "idle";
        queue.add({ ...song, platform: selectedPlatform, requestedBy: requesterName(req) });

        // If nothing was playing, start this newly-added song immediately.
        if (wasIdle) {
          queue.playAt(queue.size() - 1);
          bot.getPlayer().resetFailures();
          await bot.resolveAndPlay(queue.current()!);
          return { message: `Now playing: ${song.name || "Unknown"} - ${song.artist || "Unknown"}` };
        }

        return { message: `Added: ${song.name} - ${song.artist} (position ${queue.size()})` };
      });

      res.json(body);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Profile config endpoints ---

  router.get("/:botId/profile", requireNotGuest, (req, res) => {
    const bot = requestBot(req);
    res.json(bot.getProfileManager().getConfig());
  });

  router.put("/:botId/profile", authorize({ capability: "bot.manage" }), (req, res) => {
    try {
      const bot = requestBot(req);
      const pm = bot.getProfileManager();
      pm.updateConfig(req.body);
      if (database) {
        database.saveProfileConfig(bot.id, pm.getConfig());
      }
      res.json(pm.getConfig());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:botId/history", requireNotGuest, (req, res) => {
    if (!database) {
      res.json({ history: [] });
      return;
    }
    // Clamp the limit. `parseInt(x) || 50` let a NEGATIVE value through (only
    // 0/NaN fall back), and SQLite reads `LIMIT -1` as "no limit" — so
    // `?limit=-1` dumped the bot's entire play history in one response. An
    // absurdly large positive value had the same effect.
    const rawLimit = parseInt(req.query.limit as string, 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(500, Math.max(1, rawLimit))
      : 50;
    // String() because attaching an extra RequestHandler above widens the
    // inferred params type to ParamsDictionary (string | string[]).
    const records = database.getPlayHistory(String(req.params.botId), limit);
    const history = records.map((r) => ({
      id: r.songId,
      name: r.songName,
      artist: r.artist,
      album: r.album,
      duration: 0,
      coverUrl: r.coverUrl,
      platform: r.platform,
      playedAt: r.playedAt,
      requestedBy: r.requestedBy,
    }));
    res.json({ history });
  });

  return router;
}
