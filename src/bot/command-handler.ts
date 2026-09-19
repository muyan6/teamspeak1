import { BotInstance } from "./instance.js";
import type { ParsedCommand } from "./commands.js";
import type { TS3TextMessage } from "../ts-protocol/client.js";
import type { Song, Platform, MusicProvider } from "../music/provider.js";
import { defaultPlatform, isProviderEnabled } from "../data/config.js";
import { PlayMode, parsePlayMode } from "../audio/queue.js";
import { SHARED_QUEUE_OWNER } from "../data/database.js";
import { parseSongRef, parseSelectionIndex } from "./song-ref.js";

export class BotCommandHandler {
  private lastSearchResults: Song[] = [];

  constructor(private readonly bot: BotInstance) {}

  clearLastSearchResults(): void {
    this.lastSearchResults = [];
  }

  getLastSearchResults(): Song[] {
    return [...this.lastSearchResults];
  }

  async execute(
    cmd: ParsedCommand,
    msg?: TS3TextMessage,
    requesterName?: string,
  ): Promise<string | null> {
    const AUDIO_COMMANDS = new Set([
      "play",
      "add",
      "playnext",
      "pn",
      "next",
      "skip",
      "prev",
      "playlist",
      "album",
      "fm",
      "artist",
    ]);

    if (!this.bot.connected && AUDIO_COMMANDS.has(cmd.name)) {
      throw new Error("Bot is not connected to TeamSpeak");
    }

    switch (cmd.name) {
      case "search":
      case "find":
        return this.cmdSearch(cmd);
      case "play":
        return this.cmdPlay(cmd, requesterName);
      case "add":
        return this.cmdAdd(cmd, requesterName);
      case "playnext":
      case "pn":
        return this.cmdPlayNext(cmd, requesterName);
      case "pause":
        return this.cmdPause();
      case "resume":
        return this.cmdResume();
      case "stop":
        return this.cmdStop();
      case "next":
      case "skip":
        return this.cmdNext();
      case "prev":
        return this.cmdPrev();
      case "vol":
        return this.cmdVol(cmd);
      case "now":
        return this.cmdNow();
      case "queue":
      case "list":
        return this.cmdQueue();
      case "clear":
        return this.cmdClear();
      case "remove":
        return this.cmdRemove(cmd);
      case "mode":
        return this.cmdMode(cmd);
      case "playlist":
        return this.cmdPlaylist(cmd, requesterName);
      case "album":
        return this.cmdAlbum(cmd, requesterName);
      case "fm":
        return this.cmdFm(cmd, requesterName);
      case "artist":
        return this.cmdArtist(cmd, requesterName);
      case "vote":
        return this.cmdVote(msg);
      case "lyrics":
        return this.cmdLyrics();
      case "move":
        return this.cmdMove(cmd);
      case "home":
      case "default":
        return this.cmdHome();
      case "follow":
        return this.cmdFollow(msg);
      case "save":
        return this.cmdSaveQueue(cmd);
      case "load":
        return this.cmdLoadQueue(cmd);
      case "queues":
        return this.cmdListQueues();
      case "help":
        return this.cmdHelp();
      default:
        return `Unknown command: ${cmd.name}. Type ${this.bot.config.commandPrefix}help for help.`;
    }
  }

  async resolvePlayQuery(cmd: ParsedCommand): Promise<{ song?: Song; error?: string }> {
    const args = (cmd.args ?? "").trim();
    const p = this.bot.config.commandPrefix;

    const sel = parseSelectionIndex(args);
    if (sel !== null) {
      if (this.lastSearchResults.length === 0)
        return { error: `No recent search. Use ${p}search <name> first.` };
      if (sel > this.lastSearchResults.length)
        return { error: `Invalid selection #${sel}. ${p}search returned ${this.lastSearchResults.length} results.` };
      return { song: this.lastSearchResults[sel - 1] };
    }

    const ref = parseSongRef(args);
    if (ref) {
      if (ref.platform) this.bot.assertProviderEnabled(ref.platform);
      const provider = ref.platform ? this.bot.getProviderFor(ref.platform) : this.bot.getProvider(cmd.flags);
      const song = await provider.getSongDetail(ref.id);
      if (!song) return { error: `No song found for ${ref.platform ?? provider.platform} id: ${ref.id}` };
      return { song: { ...song, platform: provider.platform } };
    }

    const provider = this.bot.getProvider(cmd.flags);
    const result = await provider.search(args, 1, 0, "song");
    if (result.songs.length === 0) return { error: `No results found for: ${args}` };
    return { song: { ...result.songs[0], platform: provider.platform } };
  }

  async cmdSearch(cmd: ParsedCommand): Promise<string> {
    const p = this.bot.config.commandPrefix;
    if (!cmd.args) return `Usage: ${p}search <name> [-q|-k|-b|-y]`;
    const provider = this.bot.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 8, 0, "song");
    if (result.songs.length === 0) return `No results found for: ${cmd.args}`;
    this.lastSearchResults = result.songs.map((s) => ({ ...s, platform: provider.platform }));
    const lines = this.lastSearchResults.map(
      (s, i) => `${i + 1}. ${s.name} - ${s.artist}${s.album ? ` 《${s.album}》` : ""} [id:${s.id}]`,
    );
    return [
      `搜索结果（用 ${p}play #序号 播放，或 ${p}play id <id>）:`,
      ...lines,
    ].join("\n");
  }

  async cmdPlay(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    if (!cmd.args) return `Usage: ${this.bot.config.commandPrefix}play <song name | #N | id <id> | URL>`;
    const { song, error } = await this.resolvePlayQuery(cmd);
    if (error) return error;
    const song0 = song!;
    const ok = await this.bot.playSingleSong(song0, requesterName);
    if (!ok) return `Cannot play: ${song0.name}`;
    return `Now playing: ${song0.name} - ${song0.artist}`;
  }

  async cmdAdd(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    if (!cmd.args) return `Usage: ${this.bot.config.commandPrefix}add <song name | #N | id <id> | URL>`;
    const { song, error } = await this.resolvePlayQuery(cmd);
    if (error) return error;
    const s = song!;

    const wasIdle = this.bot.player.getState() === "idle";
    this.bot.queue.add(this.bot.withRequester(s, requesterName));

    if (wasIdle) {
      this.bot.queue.playAt(this.bot.queue.size() - 1);
      this.bot.player.resetFailures();
      await this.bot.resolveAndPlay(this.bot.queue.current()!);
      this.bot.emit("stateChange");
      return `Now playing: ${s.name} - ${s.artist}`;
    }

    this.bot.emit("stateChange");
    return `Added to queue: ${s.name} - ${s.artist} (position ${this.bot.queue.size()})`;
  }

  async cmdPlayNext(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    if (!cmd.args) return `Usage: ${this.bot.config.commandPrefix}playnext <song name | #N | id <id> | URL>`;
    const { song, error } = await this.resolvePlayQuery(cmd);
    if (error) return error;
    const s = song!;

    const wasIdle = this.bot.player.getState() === "idle";
    const insertedAt =
      this.bot.queue.getCurrentIndex() < 0
        ? this.bot.queue.size()
        : this.bot.queue.getCurrentIndex() + 1;
    this.bot.queue.addNext(this.bot.withRequester(s, requesterName));

    if (wasIdle) {
      this.bot.queue.playAt(insertedAt);
      this.bot.player.resetFailures();
      const ok = await this.bot.resolveAndPlay(this.bot.queue.current()!);
      this.bot.emit("stateChange");
      if (!ok) return `Cannot play: ${s.name}`;
      return `Now playing: ${s.name} - ${s.artist}`;
    }

    this.bot.emit("stateChange");
    return `Up next: ${s.name} - ${s.artist}`;
  }

  cmdPause(): string {
    this.bot.player.pause();
    if (this.bot.queue.current()?.platform === "spotify") {
      this.bot.spotifyController.pause().catch((err) =>
        this.bot.logger.warn({ err }, "Spotify pause failed"));
    }
    this.bot.autoPaused = false;
    this.bot.emit("stateChange");
    return "Paused";
  }

  cmdResume(): string {
    this.bot.player.resume();
    if (this.bot.queue.current()?.platform === "spotify") {
      this.bot.spotifyController.resume().catch((err) =>
        this.bot.logger.warn({ err }, "Spotify resume failed"));
    }
    this.bot.autoPaused = false;
    this.bot.emit("stateChange");
    return "Resumed";
  }

  cmdStop(): string {
    if (this.bot.queue.current()?.platform === "spotify") {
      this.bot.spotifyController.stop();
    }
    this.bot.currentSourceIsSpotify = false;
    this.bot.player.stop();
    this.bot.jellyfinReporter?.onStop();
    this.bot.autoPaused = false;
    this.bot.queue.clear();
    this.bot.sweepLocalAudio("stopped");
    this.bot.disableFmMode();
    this.bot.profileManager.onSongChange(null).catch((err) => {
      this.bot.logger.warn({ err }, "Profile restore failed on stop");
    });
    this.bot.emit("stateChange");
    return "Stopped and queue cleared";
  }

  async cmdNext(): Promise<string> {
    await this.bot.playNext();
    const current = this.bot.queue.current();
    if (current)
      return `Now playing: ${current.name} - ${current.artist}`;
    return "Queue is empty";
  }

  async cmdPrev(): Promise<string> {
    for (let i = 0; i < 4; i++) {
      const prev = this.bot.queue.prev();
      if (!prev) return "No previous song";
      const ok = await this.bot.resolveAndPlay(prev);
      if (ok) return `Now playing: ${prev.name} - ${prev.artist}`;
    }
    return "Cannot play any previous songs (all failed to resolve)";
  }

  cmdVol(cmd: ParsedCommand): string {
    const vol = parseInt(cmd.args, 10);
    if (isNaN(vol) || vol < 0 || vol > 100) return "Usage: !vol <0-100>";
    this.bot.player.setVolume(vol);
    this.bot.persistVolume();
    this.bot.emit("stateChange");
    return `Volume set to ${vol}%`;
  }

  cmdNow(): string {
    const song = this.bot.queue.current();
    if (!song) return "Nothing is playing";
    return `Now playing: ${song.name} - ${song.artist} [${song.album}] (${song.platform})`;
  }

  cmdQueue(): string {
    const songs = this.bot.queue.list();
    if (songs.length === 0) return "Queue is empty";
    const currentIdx = this.bot.queue.getCurrentIndex();
    const lines = songs.map((s, i) => {
      const marker = i === currentIdx ? "▶ " : "  ";
      return `${marker}${i + 1}. ${s.name} - ${s.artist}`;
    });
    return `Queue (${songs.length} songs, mode: ${this.bot.queue.getMode()}):\n${lines.join("\n")}`;
  }

  cmdClear(): string {
    this.bot.spotifyController.stop();
    this.bot.currentSourceIsSpotify = false;
    this.bot.player.stop();
    this.bot.jellyfinReporter?.onStop();
    this.bot.queue.clear();
    this.bot.sweepLocalAudio("queue_cleared");
    this.bot.disableFmMode();
    this.bot.profileManager.onSongChange(null).catch((err) => {
      this.bot.logger.warn({ err }, "Profile restore failed on clear");
    });
    this.bot.emit("stateChange");
    return "Queue cleared";
  }

  async cmdRemove(cmd: ParsedCommand): Promise<string> {
    const index = parseInt(cmd.args, 10) - 1;
    if (isNaN(index) || index < 0) return "Usage: !remove <number>";
    const removingCurrentSpotify =
      index === this.bot.queue.getCurrentIndex() && this.bot.currentSourceIsSpotify;
    const removed = this.bot.queue.remove(index);
    if (!removed) return "Invalid position";
    if (removingCurrentSpotify) {
      this.bot.spotifyController.stop();
      this.bot.currentSourceIsSpotify = false;
      this.bot.player.stop();
      await this.bot.playNext();
    }
    this.bot.sweepLocalAudio("removed_from_queue");
    this.bot.emit("stateChange");
    return `Removed: ${removed.name}`;
  }

  cmdMode(cmd: ParsedCommand): string {
    const mode = parsePlayMode(cmd.args);
    if (mode === null) return "Usage: !mode <seq|loop|random|rloop>";
    this.bot.queue.setMode(mode);
    this.bot.persistPlayMode();
    this.bot.emit("stateChange");
    return `Play mode set to: ${cmd.args}`;
  }

  async cmdPlaylist(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    if (!cmd.args) return "Usage: !playlist <playlist name or ID>";
    const provider = this.bot.getProvider(cmd.flags);

    const id = this.bot.extractId(cmd.args);
    const isDirectId = this.bot.looksLikeCollectionId(cmd.args);

    let playlistId: string;

    if (isDirectId || id !== cmd.args) {
      playlistId = id;
    } else {
      const result = await provider.search(cmd.args);
      let playlists = result.playlists ?? [];

      if (provider.getUserPlaylists) {
        try {
          const userPlaylists = await provider.getUserPlaylists();
          const query = cmd.args.toLowerCase();
          const matched = userPlaylists.filter(
            p => p.name.toLowerCase().includes(query)
          );
          playlists = [...playlists, ...matched];
        } catch {
          // User playlists unavailable
        }
      }

      if (playlists.length === 0)
        return `No playlists found for: ${cmd.args}`;
      playlistId = playlists[0].id;
    }

    const songs = await provider.getPlaylistSongs(playlistId);
    if (songs.length === 0) return "Playlist is empty or not found";

    this.bot.player.stop();
    this.bot.queue.clear();
    this.bot.disableFmMode();
    for (const song of songs) {
      this.bot.queue.add(this.bot.withRequester({ ...song, platform: provider.platform }, requesterName));
    }
    const first = this.bot.queue.play();
    if (first) await this.bot.resolveAndPlay(first);
    this.bot.sweepLocalAudio("queue_replaced");
    this.bot.emit("stateChange");
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  async cmdAlbum(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    if (!cmd.args) return "Usage: !album <album name or ID>";
    const provider = this.bot.getProvider(cmd.flags);

    const id = this.bot.extractId(cmd.args);
    const isDirectId = this.bot.looksLikeCollectionId(cmd.args);

    let albumId: string;

    if (isDirectId || id !== cmd.args) {
      albumId = id;
    } else {
      const result = await provider.search(cmd.args);
      const albums = result.albums ?? [];
      if (albums.length === 0)
        return `No albums found for: ${cmd.args}`;
      albumId = albums[0].id;
    }

    const songs = await provider.getAlbumSongs(albumId);
    if (songs.length === 0) return "Album is empty or not found";

    this.bot.player.stop();
    this.bot.queue.clear();
    this.bot.disableFmMode();
    for (const song of songs) {
      this.bot.queue.add(this.bot.withRequester({ ...song, platform: provider.platform }, requesterName));
    }
    const first = this.bot.queue.play();
    if (first) await this.bot.resolveAndPlay(first);
    this.bot.sweepLocalAudio("queue_replaced");
    this.bot.emit("stateChange");
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  async cmdFm(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    return this.bot.startFm(this.bot.getProvider(cmd.flags), requesterName);
  }

  async cmdArtist(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    if (!cmd.args) return "Usage: !artist <artist name>";
    const provider = this.bot.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 50);
    if (result.songs.length === 0)
      return `No results found for artist: ${cmd.args}`;

    const query = cmd.args.toLowerCase();
    let filtered = result.songs.filter(
      s => s.artist.toLowerCase().includes(query)
    );

    if (filtered.length === 0) {
      filtered = result.songs.slice(0, 20);
    }

    this.bot.player.stop();
    this.bot.queue.clear();
    this.bot.disableFmMode();
    for (const song of filtered) {
      this.bot.queue.add(this.bot.withRequester({ ...song, platform: provider.platform }, requesterName));
    }
    this.bot.queue.setMode(PlayMode.Loop);
    this.bot.player.resetFailures();

    const first = this.bot.queue.play();
    if (first) await this.bot.resolveAndPlay(first);
    this.bot.sweepLocalAudio("queue_replaced");
    this.bot.emit("stateChange");
    return `Artist mode: ${cmd.args} — ${filtered.length} songs loaded. Now playing: ${first?.name ?? "unknown"}`;
  }

  async cmdVote(msg?: TS3TextMessage): Promise<string> {
    if (!msg) return "Vote can only be used in TeamSpeak";
    this.bot.voteSkipUsers.add(msg.invokerUid);
    const clients = await this.bot.tsClient.getClientsInChannel();
    const totalUsers = clients.length - 1;
    const needed = Math.max(1, Math.ceil(totalUsers / 2));
    const votes = this.bot.voteSkipUsers.size;

    if (votes >= needed) {
      this.bot.voteSkipUsers.clear();
      this.bot.playNext().catch((err) => {
        this.bot.logger.error({ err }, "playNext failed after vote skip");
      });
      return `Vote passed (${votes}/${needed}). Skipping to next song.`;
    }
    return `Vote to skip: ${votes}/${needed} (need ${needed - votes} more)`;
  }

  async cmdLyrics(): Promise<string> {
    const song = this.bot.queue.current();
    if (!song) return "Nothing is playing";
    const provider = this.bot.getProviderFor(song.platform);
    const lyrics = await provider.getLyrics(song.id);
    if (lyrics.length === 0) return "No lyrics available";
    const MAX_LYRIC_LINES = 200;
    const lines = lyrics.slice(0, MAX_LYRIC_LINES).map((l) => l.text);
    return `Lyrics for ${song.name}:\n${lines.join("\n")}`;
  }

  async cmdMove(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !move <channel name or ID>";
    await this.bot.tsClient.joinChannel(cmd.args);
    return `Moved to channel: ${cmd.args}`;
  }

  async cmdHome(): Promise<string> {
    if (this.bot.tsClient.isInDefaultChannel()) {
      return "机器人当前已在默认频道";
    }
    const ok = await this.bot.returnToDefaultChannel();
    if (ok) {
      const target = this.bot.tsClient.getDefaultChannelIdentifier() || "默认频道";
      return `已返回默认频道: ${target}`;
    }
    return "未配置默认频道或返回失败";
  }

  async cmdFollow(msg?: TS3TextMessage): Promise<string> {
    if (!msg) return "Follow can only be used in TeamSpeak";
    const targetCid = await this.bot.tsClient.getClientChannelId(msg.invokerId);
    if (!targetCid) {
      return "无法确定你所在的频道";
    }
    if (this.bot.tsClient.getChannelId() === targetCid) {
      return "机器人当前已在你的频道";
    }
    await this.bot.tsClient.joinChannel(targetCid.toString());
    return "已跟随你进入频道";
  }

  savedQueuesGuard(): string | null {
    return this.bot.config.savedQueuesEnabled ? null : "此功能未启用";
  }

  cmdSaveQueue(cmd: ParsedCommand): string {
    const off = this.savedQueuesGuard();
    if (off) return off;
    const name = cmd.args.trim();
    if (!name) return `Usage: ${this.bot.config.commandPrefix}save <名称>`;
    const songs = this.bot.queue.list();
    if (songs.length === 0) return "队列为空，无法保存";
    try {
      const saved = this.bot.database.saveQueue(SHARED_QUEUE_OWNER, name, songs);
      return `已保存队列「${name}」（${saved.songCount} 首）`;
    } catch (err) {
      return `保存失败：${(err as Error).message}`;
    }
  }

  async cmdLoadQueue(cmd: ParsedCommand): Promise<string> {
    const off = this.savedQueuesGuard();
    if (off) return off;
    const name = cmd.args.trim();
    if (!name) return `Usage: ${this.bot.config.commandPrefix}load [-a] <名称>`;
    const meta = this.bot.database
      .listSavedQueues(SHARED_QUEUE_OWNER, false)
      .find((q) => q.name === name);
    const full = meta ? this.bot.database.getSavedQueue(meta.id) : null;
    if (!full) return `找不到已保存队列「${name}」`;
    const mode = cmd.flags.has("a") ? "append" : "replace";
    await this.bot.loadSavedQueue(full.songs, mode);
    return mode === "append"
      ? `已追加「${name}」（${full.songs.length} 首）到队列`
      : `已加载「${name}」（${full.songs.length} 首）`;
  }

  cmdListQueues(): string {
    const off = this.savedQueuesGuard();
    if (off) return off;
    const list = this.bot.database.listSavedQueues(SHARED_QUEUE_OWNER, false);
    if (list.length === 0) return "还没有已保存的队列";
    return ["已保存队列：", ...list.map((q) => `• ${q.name}（${q.songCount} 首）`)].join("\n");
  }

  cmdHelp(): string {
    const p = this.bot.config.commandPrefix;
    const def = defaultPlatform(this.bot.config);
    const flagHelp = BotInstance.FLAG_PLATFORMS.filter(([, platform]) =>
      isProviderEnabled(this.bot.config, platform),
    )
      .map(([flag, platform]) => `-${flag}=${platform}`)
      .join(" ");
    return [
      "TSMusicBot Commands:",
      `${p}play <song>  — Search and play (default source: ${def})`,
      ...(flagHelp ? [`  Source flags: ${flagHelp}`] : []),
      `${p}search <name> — List top matches to pick a specific (same-name) song`,
      `${p}play #N       — Play the Nth result of the last ${p}search`,
      `${p}play id <id> — Play an exact song by id / URL`,
      `${p}add <song>   — Add to queue (also accepts #N / id <id> / URL)`,
      `${p}playnext <song> — Insert as next song (alias: ${p}pn)`,
      `${p}pause/resume — Pause/resume`,
      `${p}next/prev    — Next/previous`,
      `${p}stop         — Stop and clear queue`,
      `${p}vol <0-100>  — Set volume`,
      `${p}queue        — Show queue`,
      `${p}remove <pos> — Remove song at position (see ${p}queue)`,
      `${p}mode <seq|loop|random|rloop> — Play mode`,
      `${p}playlist <name or id> — Load playlist by name or ID`,
      `${p}album <name or id> — Load album`,
      `${p}fm           — Personal FM (default source: ${def}; source flags work too)`,
      `${p}artist <name> — Play songs by artist (loop)`,
      ...(this.bot.config.savedQueuesEnabled
        ? [
            `${p}save <名称>  — Save current queue`,
            `${p}load [-a] <名称> — Load a saved queue (-a appends)`,
            `${p}queues       — List saved queues`,
          ]
        : []),
      `${p}vote         — Vote to skip`,
      `${p}lyrics       — Show lyrics`,
      `${p}move <ch>    — Move bot to channel`,
      `${p}home         — Return bot to default channel (alias: ${p}default)`,
      `${p}now          — Current song info`,
      `${p}help         — This help message`,
    ].join("\n");
  }
}
