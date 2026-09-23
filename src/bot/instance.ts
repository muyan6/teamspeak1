import { EventEmitter } from "node:events";
import {
  TS3Client,
  type TS3ClientOptions,
  type TS3TextMessage,
  type TS3VoiceActivity,
  type ClientInfo,
} from "../ts-protocol/client.js";
import { AudioPlayer } from "../audio/player.js";
import { PlayQueue, PlayMode, parsePlayMode, type QueuedSong } from "../audio/queue.js";
import type { MusicProvider, Platform, Song } from "../music/provider.js";
import {
  parseCommand,
  canRunCommand,
  type ParsedCommand,
} from "./commands.js";
import { splitTextIntoChunks } from "./text-chunk.js";
import type { Logger } from "../logger.js";
import { SHARED_QUEUE_OWNER, type BotDatabase, type ProfileConfig, type StoredSong } from "../data/database.js";
import { LRUCache } from "../data/cache.js";
import {
  isProviderEnabled,
  defaultPlatform,
  type BotConfig,
  type SpotifyConfig,
  type VoiceDuckingConfig,
} from "../data/config.js";
import type { JellyfinPlaybackReporter } from "../music/jellyfin.js";
import { BotProfileManager } from "./profile.js";
import { BotCommandHandler } from "./command-handler.js";
import type { AvatarStore } from "../data/avatars.js";
import {
  decideOccupancyAction,
  shouldResumeOnReturn,
} from "./auto-pause.js";
import { isSpotifyUri } from "../music/spotify/webapi.js";
import path from "node:path";
import { SpotifyController } from "../music/spotify/controller.js";
import type { SpotifyTrackEndedEvent } from "../music/spotify/backend.js";
import type { SpotifyOAuth } from "../music/spotify/spotify-oauth.js";
import { VoiceDuckingController } from "./voice-ducking.js";
import {
  ManagedVoiceClientRegistry,
  type ManagedVoiceClientOwnerToken,
  type ManagedVoiceClientScope,
} from "./managed-voice-clients.js";

/** Reply sent when a non-admin invokes an admin-only chat command. */
export const COMMAND_DENIED_MESSAGE = "⛔ 需要管理员权限（该命令仅限管理员服务器组）";

interface ReconnectSnapshot {
  channelId?: string;
  songs: StoredSong[];
  currentIndex: number;
  mode: PlayMode;
  isFmMode: boolean;
  fmPlatform: string;
  wasPlaying: boolean;
}

// Keep a disconnected bot id classified as managed briefly so UDP packets
// already in flight cannot make another local bot duck during teardown.
const MANAGED_VOICE_CLIENT_RELEASE_GRACE_MS = 1_000;

/** Fallback message when Spotify audio can't be served (backend unavailable
 *  OR a per-track playTrack failure against a dead/failed sidecar). */
const SPOTIFY_UNAVAILABLE_MESSAGE =
  "⚠️ Spotify 播放尚未启用（需要 librespot 音频后端，将在后续版本支持）。";

/** FNV-1a deterministic string hash (unsigned 32-bit). Stable across restarts
 *  and processes, unlike a random/insertion-order value — used to derive
 *  per-bot go-librespot ports. */
function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * STABLE per-bot go-librespot ports derived from the bot id, kept fixed across
 * restarts. The two ranges (37xx / 87xx) are disjoint so a single bot's API and
 * callback ports never clash with each other.
 *
 * BotManager uses this stable pair as the starting point for a process-wide
 * allocator. Directly constructed BotInstance objects (for example in tests)
 * still get deterministic ports from this helper.
 */
export function spotifyPortsForBotId(id: string): { apiPort: number; callbackPort: number } {
  const off = stableHash(id) % 1000;
  return { apiPort: 3700 + off, callbackPort: 8700 + off };
}

export interface BotInstanceOptions {
  id: string;
  name: string;
  tsOptions: TS3ClientOptions;
  neteaseProvider: MusicProvider;
  qqProvider: MusicProvider;
  bilibiliProvider: MusicProvider;
  youtubeProvider: MusicProvider;
  localProvider?: MusicProvider;
  kugouProvider?: MusicProvider;
  spotifyProvider?: MusicProvider;
  jellyfinProvider?: MusicProvider;
  database: BotDatabase;
  config: BotConfig;
  logger: Logger;
  avatarStore: AvatarStore;
  /** Shared across one manager so its bots do not trigger one another. */
  managedVoiceClients?: ManagedVoiceClientRegistry;
  /** Base dir (under DATA_DIR) for per-bot go-librespot work/config trees. */
  spotifyDataDir?: string;
  /** Process-wide shared Spotify OAuth (single account); injected into the
   *  SpotifyController so web-login authorization is visible to playback (C3.1). */
  spotifyOAuth?: SpotifyOAuth;
  /** Optional manager-assigned ports; omitted callers use spotifyPortsForBotId. */
  spotifyPorts?: { apiPort: number; callbackPort: number };
  /** Test seam: build a fake controller instead of a real go-librespot one. */
  spotifyControllerFactory?: (o: {
    config: SpotifyConfig;
    workDir: string;
    configDir: string;
    logger: Logger;
    instanceId: string;
    apiPort: number;
    callbackPort: number;
    oauth?: SpotifyOAuth;
  }) => SpotifyController;
}

export interface BotStatus {
  id: string;
  name: string;
  connected: boolean;
  playing: boolean;
  paused: boolean;
  currentSong: QueuedSong | null;
  queueSize: number;
  volume: number;
  playMode: PlayMode;
  elapsed: number; // ground truth elapsed seconds from frame count
  /** 当前曲实际播放时长（秒）。试听片段=试听秒数；完整曲=duration。缺失时前端回退 currentSong.duration。 */
  effectiveDuration?: number;
}

function getOrCreateHandler(target: any): BotCommandHandler {
  if (target && target.commandHandler) return target.commandHandler;
  return new BotCommandHandler(target);
}

export class BotInstance extends EventEmitter {
  readonly id: string;
  name: string;

  readonly tsClient: TS3Client;
  readonly player: AudioPlayer;
  private voiceDucking: VoiceDuckingController;
  private managedVoiceClients: ManagedVoiceClientRegistry;
  private readonly configuredVoiceServerScope: ManagedVoiceClientScope;
  private voiceServerScope: ManagedVoiceClientScope;
  private registeredVoiceClientId = 0;
  private registeredVoiceClientOwner: ManagedVoiceClientOwnerToken | null = null;
  private registeredVoiceClientScope: ManagedVoiceClientScope | null = null;
  private registeredVoiceClientUid: string | null = null;
  readonly spotifyController: SpotifyController;
  readonly queue: PlayQueue;
  private neteaseProvider: MusicProvider;
  private qqProvider: MusicProvider;
  private bilibiliProvider: MusicProvider;
  private youtubeProvider: MusicProvider;
  private localProvider: MusicProvider;
  private kugouProvider: MusicProvider;
  private spotifyProvider: MusicProvider;
  private jellyfinProvider: MusicProvider;
  readonly database: BotDatabase;
  readonly config: BotConfig;
  readonly logger: Logger;
  private avatarStore: AvatarStore;
  private tsOptions: TS3ClientOptions;
  connected = false;
  private disconnectEmitted = false;
  private manualDisconnect = false;
  private autoReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private reconnectSnapshot: ReconnectSnapshot | null = null;
  voteSkipUsers = new Set<string>();
  private isAdvancing = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idlePollTimer: ReturnType<typeof setTimeout> | null = null;
  private jellyfinReportPollTimer: ReturnType<typeof setTimeout> | null = null;
  private occupancyRefreshInFlight = false;
  private occupancyRefreshPending = false;
  private occupancyGeneration = 0;
  private channelUserCount = 0;
  autoPaused = false;
  private occupancyConsecutiveFailures = 0;
  private lastLoggedOccupancy: {
    channelId: string;
    clientsInChannel: number;
    otherUsers: number;
    playerState: string;
    autoPaused: boolean;
  } | null = null;
  /** True while the audible track is served by the Spotify sidecar (external
   *  PCM mode) — drives fence/handoff decisions in resolveAndPlay + cmdStop. */
  currentSourceIsSpotify = false;
  readonly profileManager: BotProfileManager;
  isFmMode = false;
  fmProvider: MusicProvider | null = null;
  fmRequesterName: string | undefined;
  readonly commandHandler: BotCommandHandler;
  /** 当前曲实际播放时长（试听片段秒数或完整 duration）；resolveAndPlay 赋值。 */
  private effectiveDuration: number | undefined;
  private playGate: Promise<unknown> = Promise.resolve();
  /** Serializes chunked chat replies (see enqueueReply / sendChunked). */
  private replyGate: Promise<unknown> = Promise.resolve();
  /** Per-bot Jellyfin playback-report session (start / ~10s progress / stop).
   *  null when the wired provider has no reporting capability. */
  jellyfinReporter: JellyfinPlaybackReporter | null = null;
  /** Debounce handle for the live-queue snapshot writer (Feature 2, #119). */
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private autoReturnTimer: ReturnType<typeof setTimeout> | null = null;
  private urlCache = new LRUCache<string, { url: string; trialDuration?: number }>({
    maxSize: 500,
    defaultTtlMs: 15 * 60 * 1000,
  });

  constructor(options: BotInstanceOptions) {
    super();
    this.id = options.id;
    this.name = options.name;
    this.tsOptions = options.tsOptions;
    this.neteaseProvider = options.neteaseProvider;
    this.qqProvider = options.qqProvider;
    this.bilibiliProvider = options.bilibiliProvider;
    this.youtubeProvider = options.youtubeProvider;
    this.localProvider = options.localProvider ?? options.neteaseProvider;
    this.kugouProvider = options.kugouProvider ?? options.neteaseProvider;
    this.spotifyProvider = options.spotifyProvider ?? options.neteaseProvider;
    this.jellyfinProvider = options.jellyfinProvider ?? options.neteaseProvider;
    this.database = options.database;
    this.config = options.config;
    this.logger = options.logger.child({ botId: this.id });
    this.avatarStore = options.avatarStore;

    this.tsClient = new TS3Client(options.tsOptions, this.logger);
    this.player = new AudioPlayer(this.logger);
    this.player.setLoudnessNormalization(this.config.loudnessNormalization !== false);
    this.player.setAudioFade(this.config.audioFade !== false);
    this.voiceDucking = new VoiceDuckingController(
      this.player,
      this.config.voiceDucking ?? { enabled: false, volumePercent: 30 },
    );
    this.managedVoiceClients =
      options.managedVoiceClients ?? new ManagedVoiceClientRegistry();
    this.configuredVoiceServerScope = {
      host: options.tsOptions.host,
      voicePort: options.tsOptions.port,
    };
    this.voiceServerScope = { ...this.configuredVoiceServerScope };
    this.queue = new PlayQueue();

    // Restore persisted per-bot player settings (#125): volume + play mode
    // survive restarts. getPlayerSettings returns validated values (the in-memory
    // defaults when the row/column is absent), so this is a harmless no-op for a
    // brand-new bot and reproduces the saved state for an existing one.
    try {
      const settings = this.database.getPlayerSettings(this.id);
      this.player.setVolume(settings.volume);
      const restoredMode = parsePlayMode(settings.playMode);
      if (restoredMode) this.queue.setMode(restoredMode);
    } catch (err) {
      this.logger.warn({ err }, "Failed to restore player settings — using defaults");
    }

    // Structural typing (like localProvider.sweepUnreferenced): only the real
    // JellyfinProvider exposes createPlaybackReporter, so the netease fallback
    // provider simply leaves reporting off.
    const jfReportable = this.jellyfinProvider as MusicProvider & {
      createPlaybackReporter?: () => JellyfinPlaybackReporter;
    };
    this.jellyfinReporter = jfReportable.createPlaybackReporter?.() ?? null;

    // One long-lived Spotify sidecar controller per bot. Construction is
    // cheap and side-effect-free — nothing spawns until ensureStarted().
    const spotifyBase =
      options.spotifyDataDir ?? path.join(process.cwd(), "data", "spotify");
    const spotifyWorkDir = path.join(spotifyBase, this.id, "work");
    const spotifyConfigDir = path.join(spotifyBase, this.id, "config");
    // Stable per-bot ports for the go-librespot control API / OAuth callback.
    // BotManager resolves in-process collisions; direct/test construction falls
    // back to the deterministic helper for backwards compatibility.
    const { apiPort: spotifyApiPort, callbackPort: spotifyCallbackPort } =
      options.spotifyPorts ?? spotifyPortsForBotId(this.id);
    const buildController =
      options.spotifyControllerFactory ??
      ((o) => new SpotifyController({ ...o }));
    this.spotifyController = buildController({
      config: this.config.spotify,
      workDir: spotifyWorkDir,
      configDir: spotifyConfigDir,
      logger: this.logger,
      // Per-bot id → unique Spotify Connect device name ("<base>-<id>"), so two
      // bots under the one shared account never register the same name and
      // misroute Connect commands (corner-case R2-5).
      instanceId: this.id,
      apiPort: spotifyApiPort,
      callbackPort: spotifyCallbackPort,
      oauth: options.spotifyOAuth,
    });

    const profileConfig = this.database.getProfileConfig(this.id);
    this.profileManager = new BotProfileManager(
      this.tsClient,
      this.logger,
      profileConfig,
      options.tsOptions.nickname,
    );

    // Best-effort: a corrupted/locked avatar file must not block bot startup.
    try {
      const relPath = this.database.getCustomAvatarPath(this.id);
      if (relPath) {
        const buf = this.avatarStore.read(relPath);
        // loadCustomAvatar, NOT setCustomAvatar (#148): we are still in the
        // constructor, so tsClient has not connected. setCustomAvatar would
        // start a file transfer right here and fail. profileManager.onConnect()
        // uploads it for real once the handshake completes.
        // `length > 0` because avatarStore.write is delete-then-write, so a
        // crash mid-write leaves a 0-byte file that is truthy as a Buffer.
        if (buf && buf.length > 0) this.profileManager.loadCustomAvatar(buf);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to load custom avatar — skipping");
    }

    this.setupPlayerEvents();
    this.setupTsEvents();
    this.commandHandler = new BotCommandHandler(this);

    // Feature 2 (#119): persist a debounced snapshot of the live queue whenever
    // it changes, so it can be restored + resumed after a restart. Inert unless
    // config.savedQueuesEnabled is on (checked inside the scheduler).
    this.on("stateChange", () => this.scheduleQueueSnapshot());
  }

  private setupPlayerEvents(): void {
    this.player.on("frame", (opusFrame: Buffer) => {
      this.tsClient.sendVoiceData(opusFrame);
    });

    this.player.on("trackEnd", () => {
      this.logger.debug("Track ended, advancing queue");
      this.playNext().catch((err) => {
        this.logger.error({ err }, "playNext failed after trackEnd");
      });
    });

    this.player.on("error", (err: Error) => {
      this.logger.error({ err }, "Player error");
      this.playNext().catch((err2) => {
        this.logger.error({ err: err2 }, "playNext failed after player error");
      });
    });

    // Spotify advances exclusively via the sidecar's WebSocket "trackEnded"
    // (the continuous go-librespot→ffmpeg pipe never EOFs per track, so the
    // player's own underrun "trackEnd" is suppressed in external mode). Guard
    // on the current song being spotify so a stray event can't double-advance
    // a URL track; playNext()'s isAdvancing guard covers any residual race.
    this.spotifyController.on("trackEnded", (_e: SpotifyTrackEndedEvent) => {
      if (this.queue.current()?.platform !== "spotify") return;
      this.logger.debug("Spotify track ended, advancing queue");
      this.playNext().catch((err) => {
        this.logger.error({ err }, "playNext failed after spotify trackEnded");
      });
    });
  }

  isLocalAudioEnabled(): boolean {
    return this.config.localAudioEnabled !== false;
  }

  /**
   * Reference-aware cleanup of uploaded local audio files. Delegates to the
   * local provider, which deletes a file only when it has been played AND is
   * no longer referenced by ANY bot's queue — so loop replays, prev, the song
   * being re-started, and the same upload queued on another bot are all safe.
   * Call this AFTER the queue mutation, so released songs are unreferenced
   * (and deleted) while songs that remain queued are preserved.
   */
  cleanupQueuedLocalSongs(reason: string): void {
    this.sweepLocalAudio(reason);
  }

  sweepLocalAudio(reason: string): void {
    const provider = this.localProvider as MusicProvider & {
      sweepUnreferenced?: () => string[];
    };
    if (typeof provider.sweepUnreferenced !== "function") return;
    try {
      const deleted = provider.sweepUnreferenced();
      if (deleted.length) {
        this.logger.info({ count: deleted.length, reason }, "Cleaned up local audio files");
      }
    } catch (err) {
      this.logger.warn({ err, reason }, "Local audio cleanup failed");
    }
  }

  private isSameSong(a: QueuedSong | Song | null | undefined, b: QueuedSong | Song | null | undefined): boolean {
    return !!a && !!b && a.platform === b.platform && a.id === b.id;
  }

  private setupTsEvents(): void {
    this.tsClient.on("textMessage", (msg: TS3TextMessage) => {
      this.handleTextMessage(msg).catch((err) => {
        this.logger.error({ err }, "Unhandled error in text message handler");
      });
    });

    this.tsClient.on("disconnected", () => {
      // Capture pre-disconnect state snapshot for auto-reconnect if not manual disconnect
      const wasUnexpected = !this.manualDisconnect;
      if (wasUnexpected) {
        const currentCid = this.tsClient.getChannelId();
        const playerState = this.player.getState();
        const songs = this.queue.list();
        this.reconnectSnapshot = {
          channelId: currentCid !== 0n ? currentCid.toString() : undefined,
          songs: songs.map((s) => ({
            id: s.id,
            name: s.name,
            artist: s.artist,
            album: s.album,
            duration: s.duration,
            platform: s.platform,
            coverUrl: s.coverUrl,
            requestedBy: s.requestedBy,
          })),
          currentIndex: this.queue.getCurrentIndex(),
          mode: this.queue.getMode(),
          isFmMode: this.isFmMode,
          fmPlatform: this.isFmMode && this.fmProvider ? (this.fmProvider as any).platform || "" : "",
          wasPlaying: playerState === "playing",
        };
      }

      // Always reset local state — covers the case where connect() never
      // completed (hanging handshake → 60s library idle timeout) and
      // this.connected was never flipped to true. Previously this handler
      // short-circuited on !this.connected, leaving player stuck as "playing".
      this.connected = false;
      this.occupancyGeneration++;
      this.occupancyRefreshPending = false;
      // Reset the backoff counter: it drives the next poller's delay, and a
      // fresh connection must probe at the normal 30s cadence instead of
      // inheriting a 5-minute backoff from the previous session's failures.
      this.occupancyConsecutiveFailures = 0;
      this._clearLifecycleTimers();
      this.unregisterManagedVoiceClient(MANAGED_VOICE_CLIENT_RELEASE_GRACE_MS);
      this.voiceDucking.reset(true);
      // Cancel any pending live-queue snapshot BEFORE clearing the queue: a
      // debounced snapshot firing after clear() would persist an empty queue
      // (clearQueueState), wiping the state we want to restore on reconnect —
      // and since a manual stop→start reuses the same botId, that would clobber
      // the new instance's restored row (#119).
      if (this.snapshotTimer) {
        clearTimeout(this.snapshotTimer);
        this.snapshotTimer = null;
      }
      this.spotifyController.stop();
      this.currentSourceIsSpotify = false;
      this.player.stop();
      this.jellyfinReporter?.onStop();
      this.queue.clear();
      this.sweepLocalAudio("disconnected");
      // A lifecycle change must not leave a stale auto-resume armed.
      this.autoPaused = false;
      // Only emit externally once per lifecycle so clients don't see a
      // duplicate "disconnected" after an explicit disconnect() call.
      if (!this.disconnectEmitted) {
        this.disconnectEmitted = true;
        this.emit("disconnected");
      }

      if (wasUnexpected) {
        this._scheduleAutoReconnect();
      }
    });

    this.tsClient.on("connected", () => {
      // Fresh connection — clear any stale auto-pause flag from a prior session.
      this.autoPaused = false;
      this._startIdlePoller();
      this._startJellyfinReportPoller();
      void this.refreshOccupancy();
    });

    this.tsClient.on("voiceActivity", (activity: TS3VoiceActivity) => {
      if (!this.connected) return;
      if (
        this.managedVoiceClients.hasClientUid(activity.clientUid) ||
        this.managedVoiceClients.has(this.voiceServerScope, activity.clientId)
      ) {
        return;
      }
      this.voiceDucking.handleVoiceActivity(activity.clientId);
    });

    // React near-instantly to channel membership changes. The 30s idle
    // poller remains the fallback if any of these events are missed.
    this.tsClient.on("clientEnter", () => {
      // A returning listener must resume IMMEDIATELY, not after the next 30s
      // occupancy poll. The full-client `clientlist` query is exactly what
      // times out while another client is present, so relying on it here would
      // leave an auto-paused track silent for up to half a minute. The push
      // event is authoritative for "someone appeared", and _resumeIfReturning
      // only ever resumes (never pauses), so a spurious enter is harmless.
      this._resumeIfReturning();
      void this.refreshOccupancy();
    });
    this.tsClient.on("clientLeave", (event: { id: number }) => {
      this.voiceDucking.removeSpeaker(event.id);
      void this.refreshOccupancy();
    });
    this.tsClient.on("clientMoved", (event: { id: number }) => {
      if (event.id === this.tsClient.getClientId()) {
        // Moving the bot invalidates every activity deadline from its old
        // channel even if no individual leave events arrive.
        this.voiceDucking.reset(false);
      } else {
        this.voiceDucking.removeSpeaker(event.id);
      }
      void this.refreshOccupancy();
    });
  }

  private registerManagedVoiceClient(): void {
    this.unregisterManagedVoiceClient();
    const clientId = this.tsClient.getClientId();
    if (!Number.isSafeInteger(clientId) || clientId <= 0) return;

    const owner = {};
    const scope = { ...this.voiceServerScope };
    const clientUid = this.tsClient.getClientUid();
    if (this.managedVoiceClients.register(scope, clientId, owner, clientUid)) {
      this.registeredVoiceClientId = clientId;
      this.registeredVoiceClientOwner = owner;
      this.registeredVoiceClientScope = scope;
      this.registeredVoiceClientUid = clientUid;
    }
  }

  private unregisterManagedVoiceClient(graceMs = 0): void {
    const clientId = this.registeredVoiceClientId;
    const owner = this.registeredVoiceClientOwner;
    const clientUid = this.registeredVoiceClientUid ?? undefined;
    const scope = this.registeredVoiceClientScope
      ? { ...this.registeredVoiceClientScope }
      : { ...this.voiceServerScope };
    this.registeredVoiceClientId = 0;
    this.registeredVoiceClientOwner = null;
    this.registeredVoiceClientScope = null;
    this.registeredVoiceClientUid = null;
    if (clientId <= 0 || owner === null) return;

    const unregister = () => {
      this.managedVoiceClients.unregister(scope, clientId, owner, clientUid);
    };
    if (graceMs > 0) {
      const timer = setTimeout(unregister, graceMs);
      timer.unref?.();
    } else {
      unregister();
    }
  }

  /**
   * Resume playback when a listener returns after an auto-pause, driven by the
   * clientEnter push event rather than a (timing-out) occupancy query.
   *
   * We only auto-pause while alone on the server, so `autoPaused` is a reliable
   * "paused because empty" flag; any client appearing while it's set means a
   * listener returned. Delegating to handleOccupancy(1) routes through
   * decideOccupancyAction (resume iff autoPaused && paused) and also cancels the
   * idle-disconnect timer. This path NEVER pauses — userCount is always > 0 —
   * so a spurious or unrelated enter can only (harmlessly) resume, never stop
   * playback. Pause remains exclusively on the authoritative clientlist path.
   */
  private _resumeIfReturning(): void {
    if (!this.connected) return;
    if (shouldResumeOnReturn(this.autoPaused, this.player.getState())) {
      this.handleOccupancy(1);
    }
  }

  /** Filter channel clients down to real human listeners, excluding bots and queries. */
  getHumanListenersInChannel(clients: ClientInfo[]): ClientInfo[] {
    return clients.filter((c) => {
      if (c.id === this.tsClient.getClientId()) return false;
      if (c.type === 1) return false; // Exclude ServerQuery / Query bots
      if (c.uid && this.managedVoiceClients.hasClientUid(c.uid)) return false; // Exclude other managed music bots
      if (this.managedVoiceClients.has(this.voiceServerScope, c.id)) return false;
      return true;
    });
  }

  private async refreshOccupancy(): Promise<void> {
    if (!this.connected) return;
    if (this.occupancyRefreshInFlight) {
      this.occupancyRefreshPending = true;
      return;
    }
    this.occupancyRefreshInFlight = true;
    const generation = this.occupancyGeneration;
    try {
      const clients = await this.tsClient.getClientsInChannel();
      if (!this.connected || generation !== this.occupancyGeneration) return;
      const realListeners = this.getHumanListenersInChannel(clients);
      const userCount = realListeners.length;
      this.handleOccupancy(userCount);
      const channelId = this.tsClient.getChannelId().toString();
      const playerState = this.player.getState();
      const hasChanged =
        !this.lastLoggedOccupancy ||
        this.lastLoggedOccupancy.channelId !== channelId ||
        this.lastLoggedOccupancy.clientsInChannel !== clients.length ||
        this.lastLoggedOccupancy.otherUsers !== userCount ||
        this.lastLoggedOccupancy.playerState !== playerState ||
        this.lastLoggedOccupancy.autoPaused !== this.autoPaused;

      const logPayload = {
        channelId,
        clientsInChannel: clients.length,
        listeners: realListeners.map((l) => ({ id: l.id, name: l.nickname, type: l.type })),
        otherUsers: userCount,
        playerState,
        autoPauseOnEmpty: this.config.autoPauseOnEmpty,
        autoPaused: this.autoPaused,
      };

      this.occupancyConsecutiveFailures = 0;
      if (hasChanged) {
        this.lastLoggedOccupancy = {
          channelId,
          clientsInChannel: clients.length,
          otherUsers: userCount,
          playerState,
          autoPaused: this.autoPaused,
        };
        this.logger.info(logPayload, "Channel occupancy evaluated");
      } else {
        this.logger.debug(logPayload, "Channel occupancy evaluated (unchanged)");
      }
    } catch (err) {
      this.occupancyConsecutiveFailures++;
      // The next poll's delay is derived from this counter by
      // _occupancyPollDelayMs(); log the same value so the two can't drift.
      const backoffSec = this._occupancyPollDelayMs() / 1000;
      this.logger.warn({ err, consecutiveFailures: this.occupancyConsecutiveFailures, backoffSec }, "refreshOccupancy failed");
    } finally {
      this.occupancyRefreshInFlight = false;
      if (this.occupancyRefreshPending) {
        this.occupancyRefreshPending = false;
        if (this.connected && generation === this.occupancyGeneration) {
          void this.refreshOccupancy();
        }
      }
    }
  }

  async connect(): Promise<void> {
    this.manualDisconnect = false;
    this._cancelReconnect();
    this.disconnectEmitted = false;
    await this.tsClient.connect();
    const resolvedEndpoint = this.tsClient.getResolvedVoiceEndpoint();
    this.voiceServerScope = {
      host:
        resolvedEndpoint?.host ?? this.configuredVoiceServerScope.host,
      voicePort:
        resolvedEndpoint?.port ?? this.configuredVoiceServerScope.voicePort,
    };
    // Race guard: if disconnect() was called while the handshake was
    // awaiting, don't flip connected back to true — that would leave the
    // bot in an inconsistent state (externally "connected" but the tsClient
    // has already been torn down).
    if (this.disconnectEmitted) {
      throw new Error("Connect aborted by concurrent disconnect");
    }
    this.connected = true;
    // Register only after the outer lifecycle race guard succeeds. The TS
    // wrapper emits its own "connected" event before connect() resolves, so
    // registering in that callback could let a cancelled, late handshake
    // overwrite a newer instance that reused the same client id.
    this.voiceDucking.reset(true);
    this.registerManagedVoiceClient();
    this.profileManager.onConnect();
    this.emit("connected");
    // Feature 2 (#119): restore + resume the live queue persisted before the
    // last shutdown. Best-effort and gated on savedQueuesEnabled; runs after
    // the bot is fully connected so resolveAndPlay can actually push audio.
    void this.restoreQueueFromSnapshot();
  }

  disconnect(): void {
    this.manualDisconnect = true;
    this._cancelReconnect();
    this.reconnectSnapshot = null;
    this.reconnectAttempts = 0;
    this.occupancyGeneration++;
    this.occupancyRefreshPending = false;
    this._clearLifecycleTimers();
    this._cancelIdleTimer();
    this.lastLoggedOccupancy = null;
    if (this.autoReturnTimer) {
      clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = null;
    }
    this.voiceDucking.reset(true);
    // Cancel any pending live-queue snapshot before clearing so it can't fire
    // afterwards and persist an empty queue over the state we keep for restore
    // (#119). The disconnected handler cancels too, but do it here as well for
    // the path where tsClient.disconnect() doesn't re-emit "disconnected".
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.spotifyController.stop();
    this.currentSourceIsSpotify = false;
    this.player.stop();
    this.jellyfinReporter?.onStop();
    this.queue.clear();
    this.sweepLocalAudio("disconnected");
    this.connected = false;
    if (!this.disconnectEmitted) {
      this.disconnectEmitted = true;
      this.emit("disconnected");
    }
    this.tsClient.disconnect();
    // Stop outbound PCM and initiate the TeamSpeak disconnect before removing
    // our id from the shared registry, minimizing the window in which another
    // managed bot could mistake our final packet for a human speaker.
    this.unregisterManagedVoiceClient(MANAGED_VOICE_CLIENT_RELEASE_GRACE_MS);
  }

  /** 外部更新 idleTimeoutMinutes（由 API 保存时调用） */
  updateIdleTimeout(minutes: number): void {
    this.config.idleTimeoutMinutes = minutes;
    if (minutes === 0) this._cancelIdleTimer();
  }

  /** 外部更新 autoPauseOnEmpty（由 API 保存时调用） */
  updateAutoPause(enabled: boolean): void {
    this.config.autoPauseOnEmpty = enabled;
    if (!enabled && this.autoPaused && this.player.getState() === "paused") {
      this.player.resume();
      if (this.queue.current()?.platform === "spotify") {
        this.spotifyController.resume().catch((err) =>
          this.logger.warn({ err }, "Spotify resume failed (auto-pause disabled)"));
      }
      this.autoPaused = false;
      this.emit("stateChange");
    } else if (enabled && this.connected) {
      void this.refreshOccupancy();
    }
  }

  /** Hot-apply voice ducking without mutating the user's base player volume. */
  updateVoiceDucking(settings: VoiceDuckingConfig): void {
    this.config.voiceDucking = { ...settings };
    this.voiceDucking.updateSettings(settings);
  }

  updateLoudnessNormalization(enabled: boolean): void {
    this.config.loudnessNormalization = enabled;
    this.player.setLoudnessNormalization(enabled);
  }

  updateAudioFade(enabled: boolean): void {
    this.config.audioFade = enabled;
    this.player.setAudioFade(enabled);
  }

  private _startIdlePoller(): void {
    // 每 30 秒检查一次频道人数
    if (this.idlePollTimer) return;
    this.idlePollTimer = setTimeout(() => this._runIdlePoll(), this._occupancyPollDelayMs());
    this.idlePollTimer.unref?.();
  }

  /**
   * Delay before the NEXT occupancy poll.
   *
   * The base cadence is 30s, but a failing `clientlist` (the documented
   * library limitation when other clients are connected) must not be retried
   * at full rate forever: every consecutive failure backs off exponentially up
   * to 5 minutes. The previous implementation computed this backoff, logged it,
   * and then threw it away — the poller unconditionally rescheduled at 30s.
   * Success resets the counter, so recovery is immediate.
   */
  private _occupancyPollDelayMs(): number {
    if (this.occupancyConsecutiveFailures <= 0) return 30_000;
    const backoffSec = Math.min(
      300,
      30 * Math.pow(2, Math.min(4, this.occupancyConsecutiveFailures - 1)),
    );
    return backoffSec * 1000;
  }

  private _runIdlePoll(): void {
    this.idlePollTimer = null;
    if (!this.connected) return;
    void this.refreshOccupancy().finally(() => {
      if (!this.connected) return;
      this.idlePollTimer = setTimeout(() => this._runIdlePoll(), this._occupancyPollDelayMs());
      this.idlePollTimer.unref?.();
    });
  }

  async returnToDefaultChannel(): Promise<boolean> {
    if (this.autoReturnTimer) {
      clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = null;
    }
    if (!this.tsClient || this.tsClient.isInDefaultChannel()) return false;
    const ok = await this.tsClient.returnToDefaultChannel();
    if (ok) {
      this.logger.info({ botId: this.id }, "Returned to default channel");
      void this.refreshOccupancy();
    }
    return ok;
  }

  private handleOccupancy(userCount: number): void {
    // idle-disconnect (unchanged behavior)
    if (userCount <= 0) this._scheduleIdleCheck();
    else this._cancelIdleTimer();

    // Auto-return to default channel if room is empty and bot is in a temporary room
    if (userCount <= 0 && this.tsClient && !this.tsClient.isInDefaultChannel()) {
      if (!this.autoReturnTimer) {
        this.autoReturnTimer = setTimeout(() => {
          this.autoReturnTimer = null;
          if (this.tsClient && !this.tsClient.isInDefaultChannel()) {
            void this.returnToDefaultChannel();
          }
        }, 2000);
      }
    } else if (userCount > 0 && this.autoReturnTimer) {
      clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = null;
    }

    // auto-pause
    const action = decideOccupancyAction(
      this.player.getState(),
      this.autoPaused,
      this.config.autoPauseOnEmpty,
      userCount,
    );
    if (action === "pause") {
      this.player.pause();
      // Occupancy paths drive player.pause()/resume() DIRECTLY (bypassing the
      // cmd handlers), so they must ALSO stop/resume the sidecar — else it
      // keeps decoding into an empty channel.
      if (this.queue.current()?.platform === "spotify") {
        this.spotifyController.pause().catch((err) =>
          this.logger.warn({ err }, "Spotify pause failed (occupancy)"));
      }
      this.autoPaused = true;
      this.emit("stateChange");
    } else if (action === "resume") {
      this.player.resume();
      if (this.queue.current()?.platform === "spotify") {
        this.spotifyController.resume().catch((err) =>
          this.logger.warn({ err }, "Spotify resume failed (occupancy)"));
      }
      this.autoPaused = false;
      this.emit("stateChange");
    }
  }

  /**
   * ~10s Jellyfin progress reporting. The timer is explicitly cleared on
   * disconnect, and onStop() idempotently closes any open report session when
   * the current track is not (or no longer) a Jellyfin item.
   */
  private _startJellyfinReportPoller(): void {
    if (!this.jellyfinReporter) return;
    if (this.jellyfinReportPollTimer) return;
    const tick = () => {
      this.jellyfinReportPollTimer = null;
      if (!this.connected) return;
      const reporter = this.jellyfinReporter!;
      const current = this.queue.current();
      const state = this.player.getState();
      if (current?.platform === "jellyfin" && (state === "playing" || state === "paused")) {
        reporter.onTick(current.id, this.player.getElapsed(), state === "paused");
      } else {
        reporter.onStop();
      }
      this.jellyfinReportPollTimer = setTimeout(tick, 10_000);
      this.jellyfinReportPollTimer.unref?.();
    };
    this.jellyfinReportPollTimer = setTimeout(tick, 10_000);
    this.jellyfinReportPollTimer.unref?.();
  }

  private _clearLifecycleTimers(): void {
    if (this.idlePollTimer) {
      clearTimeout(this.idlePollTimer);
      this.idlePollTimer = null;
    }
    if (this.jellyfinReportPollTimer) {
      clearTimeout(this.jellyfinReportPollTimer);
      this.jellyfinReportPollTimer = null;
    }
  }

  private _scheduleIdleCheck(): void {
    if (this.idleTimer !== null) return; // 已经在倒计时，不重复创建
    const minutes = this.config.idleTimeoutMinutes ?? 0;
    if (!this.connected || minutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (!this.connected) return;
      this.logger.info({ idleMinutes: minutes }, "Channel empty, disconnecting due to idle timeout");
      this.disconnect();
    }, minutes * 60 * 1000);
  }

  private _cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private _cancelReconnect(): void {
    if (this.autoReconnectTimer) {
      clearTimeout(this.autoReconnectTimer);
      this.autoReconnectTimer = null;
    }
  }

  scheduleAutoReconnect(initialDelayMs?: number): void {
    this.manualDisconnect = false;
    this.connected = false;
    this._scheduleAutoReconnect(initialDelayMs);
  }

  private _scheduleAutoReconnect(initialDelayMs?: number): void {
    if (this.manualDisconnect || this.connected) return;
    this._cancelReconnect();

    // Exponential backoff: 3s, 5s, 10s, 20s, 30s, capped at 60s
    const delays = [3000, 5000, 10000, 20000, 30000];
    const delay = initialDelayMs ?? delays[this.reconnectAttempts] ?? 60000;
    this.reconnectAttempts++;

    this.logger.warn(
      { attempt: this.reconnectAttempts, nextDelayMs: delay, botId: this.id },
      "Scheduling auto-reconnect",
    );

    this.autoReconnectTimer = setTimeout(() => {
      void this._attemptAutoReconnect();
    }, delay);
    this.autoReconnectTimer.unref?.();
  }

  private async _attemptAutoReconnect(): Promise<void> {
    if (this.manualDisconnect || this.connected) return;
    this.logger.info(
      { attempt: this.reconnectAttempts, botId: this.id },
      "Attempting auto-reconnect...",
    );
    try {
      await this.connect();
      this.reconnectAttempts = 0;
      this.logger.info({ botId: this.id }, "Auto-reconnect succeeded");

      if (this.reconnectSnapshot) {
        const snap = this.reconnectSnapshot;
        this.reconnectSnapshot = null;
        if (snap.channelId && snap.channelId !== this.tsOptions.channelId) {
          try {
            await this.tsClient.joinChannel(snap.channelId);
          } catch (err) {
            this.logger.warn({ err, channelId: snap.channelId }, "Failed to restore channel after auto-reconnect");
          }
        }
        if (!this.config.savedQueuesEnabled && snap.songs.length > 0) {
          this.queue.restore({
            songs: snap.songs,
            currentIndex: snap.currentIndex,
            mode: snap.mode,
          });
          if (snap.isFmMode && snap.fmPlatform) {
            this.isFmMode = true;
            this.fmProvider = this.getProviderFor(snap.fmPlatform as Platform);
          }
          if (snap.wasPlaying) {
            const current = this.queue.current();
            if (current) {
              this.player.resetFailures();
              await this.resolveAndPlay(current);
            }
          }
        }
      }
    } catch (err) {
      this.logger.warn(
        { err, attempt: this.reconnectAttempts, botId: this.id },
        "Auto-reconnect attempt failed, scheduling next retry",
      );
      this._scheduleAutoReconnect();
    }
  }

  isManualDisconnect(): boolean {
    return this.manualDisconnect;
  }

  isReconnecting(): boolean {
    return this.autoReconnectTimer !== null;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  private async handleTextMessage(msg: TS3TextMessage): Promise<void> {
    const parsed = parseCommand(
      msg.message,
      this.config.commandPrefix,
      this.config.commandAliases
    );
    if (!parsed) return;

    if (!(await this.isCommandAllowed(parsed.name, msg))) {
      this.logger.info(
        { command: parsed.name, invoker: msg.invokerName },
        "Command denied: invoker not in adminGroups"
      );
      try {
        await this.tsClient.sendTextMessage(COMMAND_DENIED_MESSAGE);
      } catch (sendErr) {
        this.logger.error({ err: sendErr }, "Failed to send permission-denied message to chat");
      }
      return;
    }

    this.logger.info(
      { command: parsed.name, args: parsed.args, invoker: msg.invokerName },
      "Command received"
    );

    try {
      const response = await this.executeCommand(parsed, msg);
      if (response) {
        // A single long reply (e.g. full lyrics) would exceed TeamSpeak's
        // per-message byte cap, so split it and send the chunks in order with
        // an anti-flood pacing delay between chunks.
        //
        // The send loop runs inside its OWN serialization gate, separate from
        // the command gate: a 40-chunk !lyrics reply takes ~8s of paced sends,
        // and two users issuing long commands at once used to interleave their
        // chunks into one garbled stream. Queueing whole replies keeps each
        // command's output contiguous, while holding the PLAY lock through the
        // pacing would stall every unrelated transport command for those 8s.
        //
        // `replyGate` is read through `?? Promise.resolve()` so lightweight
        // test doubles (which only provide the handful of members a command
        // touches) keep working unchanged.
        const sendReply = async () => {
          const chunks = splitTextIntoChunks(response);
          for (let i = 0; i < chunks.length; i++) {
            if (i > 0) {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            await this.tsClient.sendTextMessage(chunks[i]);
          }
        };
        const previous = this.replyGate ?? Promise.resolve();
        const queued = previous.then(sendReply, sendReply);
        // Settled-void chain: one failed send must not wedge later replies.
        this.replyGate = queued.catch(() => {});
        await queued;
      }
    } catch (err) {
      this.logger.error({ err, command: parsed.name }, "Command execution error");
      try {
        await this.tsClient.sendTextMessage(
          `Error: ${(err as Error).message}`
        );
      } catch (sendErr) {
        this.logger.error({ err: sendErr }, "Failed to send error message to chat");
      }
    }
  }

  /**
   * Decide whether a chat command may run for this sender. Reads adminGroups
   * live from this.config. Public commands and the enforcement-off case are
   * allowed with NO query. For an ENFORCED admin command we resolve the
   * sender's CURRENT server groups with a targeted server-wide lookup rather
   * than trusting the text event's cached groups — those are empty for
   * out-of-channel senders and stale after a live promotion/demotion. Fails
   * closed when the groups can't be determined.
   */
  private async isCommandAllowed(commandName: string, msg: TS3TextMessage): Promise<boolean> {
    const adminGroups = this.config.adminGroups;
    // Public command, or enforcement off → allow without any lookup.
    // (canRunCommand with empty groups is true iff the command is public OR
    // adminGroups is empty.)
    if (canRunCommand(commandName, [], adminGroups)) return true;
    // Enforced admin command: authoritative decision uses freshly-resolved,
    // server-wide groups. Fail closed if they can't be determined.
    const groups = await this.lookupInvokerGroups(msg.invokerId);
    return canRunCommand(commandName, groups, adminGroups);
  }

  /**
   * Resolve the sender's current server groups by client id, server-wide.
   * Returns [] on a bad id or query failure (→ fail-closed deny upstream).
   */
  private async lookupInvokerGroups(invokerId: string): Promise<string[]> {
    const clid = Number(invokerId);
    if (!Number.isFinite(clid) || clid <= 0) return [];
    try {
      return await this.tsClient.getClientServerGroups(clid);
    } catch {
      return [];
    }
  }

  async executeCommand(
    cmd: ParsedCommand,
    msg?: TS3TextMessage,
    requesterName = this.requesterNameFromMessage(msg),
  ): Promise<string | null> {
    return this.runExclusive(() => this.executeCommandInternal(cmd, msg, requesterName));
  }

  private async executeCommandInternal(
    cmd: ParsedCommand,
    msg?: TS3TextMessage,
    requesterName?: string,
  ): Promise<string | null> {
    return this.commandHandler.execute(cmd, msg, requesterName);
  }

  getProviderFor(platform: Platform): MusicProvider {
    if (platform === "bilibili") return this.bilibiliProvider;
    if (platform === "youtube") return this.youtubeProvider;
    if (platform === "local") return this.localProvider;
    if (platform === "kugou") return this.kugouProvider;
    if (platform === "spotify") return this.spotifyProvider;
    if (platform === "jellyfin") return this.jellyfinProvider;
    return platform === "qq" ? this.qqProvider : this.neteaseProvider;
  }

  getDefaultPlatform(): Platform {
    const platform = defaultPlatform(this.config);
    this.assertProviderEnabled(platform);
    return platform;
  }

  /** Friendly gate for user-selected platforms (flags / URLs / REST params). */
  assertProviderEnabled(platform: Platform): void {
    if (!isProviderEnabled(this.config, platform)) {
      throw new Error(
        `音源未启用：${platform}（provider disabled — 需在配置 enabledProviders 中开启）`,
      );
    }
  }

  disableFmMode(): void {
    this.isFmMode = false;
    this.fmProvider = null;
    this.fmRequesterName = undefined;
  }

  /** Chat-command source flags. No flag → the configured default platform
   *  (netease in the default config; otherwise the first enabled source by
   *  fixed priority — see defaultPlatform()). */
  public static readonly FLAG_PLATFORMS: ReadonlyArray<[string, Platform]> = [
    ["b", "bilibili"],
    ["q", "qq"],
    ["y", "youtube"],
    ["k", "kugou"],
    ["s", "spotify"],
    ["l", "local"],
    ["n", "netease"],
    ["j", "jellyfin"],
  ];

  getProvider(flags: Set<string>): MusicProvider {
    for (const [flag, platform] of BotInstance.FLAG_PLATFORMS) {
      if (flags.has(flag)) {
        this.assertProviderEnabled(platform);
        return this.getProviderFor(platform);
      }
    }
    const def = defaultPlatform(this.config);
    this.assertProviderEnabled(def);
    return this.getProviderFor(def);
  }

  private requesterNameFromMessage(msg?: TS3TextMessage): string | undefined {
    const name = msg?.invokerName?.trim();
    return name || undefined;
  }

  withRequester<T extends Song | QueuedSong>(
    song: T,
    requesterName?: string,
  ): T & { requestedBy?: string } {
    const requestedBy = requesterName?.trim();
    return requestedBy ? { ...song, requestedBy } : { ...song };
  }

  private async fallbackResolveSong(
    song: QueuedSong,
  ): Promise<{ url: string; trialDuration?: number } | null> {
    const candidatePlatforms = (["netease", "qq", "kugou", "bilibili", "youtube"] as const).filter(
      (p) => p !== song.platform && isProviderEnabled(this.config, p),
    );

    if (candidatePlatforms.length === 0) return null;

    const query = `${song.name} ${song.artist}`.trim();

    const checkCandidate = async (p: (typeof candidatePlatforms)[number]) => {
      try {
        const candidateProvider = this.getProviderFor(p);
        const searchResults = await candidateProvider.search(query, 1, 0, "song");
        if (searchResults?.songs && searchResults.songs.length > 0) {
          const match = searchResults.songs[0];
          const candidateResult = await candidateProvider.getSongUrl(match.id);
          if (candidateResult?.url) {
            return {
              platform: p,
              url: candidateResult.url,
              trialDuration: candidateResult.trialDuration,
            };
          }
        }
      } catch (err) {
        this.logger.debug({ err, platform: p }, "Fallback candidate search failed");
      }
      return null;
    };

    for (const p of candidatePlatforms) {
      const chosen = await checkCandidate(p);
      if (chosen) {
        this.logger.info(
          { original: song.platform, fallback: chosen.platform, song: song.name },
          "Auto-source fallback succeeded",
        );
        await this.tsClient
          .sendTextMessage(
            `🔄 [自动换源] 原音源无法播放，已自动切换至 ${chosen.platform} 播放《${song.name}》`,
          )
          .catch(() => {});
        return {
          url: chosen.url,
          trialDuration: chosen.trialDuration,
        };
      }
    }
    return null;
  }

  private preFetchNextTrack(): void {
    const nextSong = this.queue.peekNext();
    if (!nextSong || nextSong.platform === "spotify" || nextSong.platform === "local") return;

    const cacheKey = `${nextSong.platform}:${nextSong.id}`;
    if (this.urlCache.has(cacheKey)) return;

    const provider = this.getProviderFor(nextSong.platform);
    provider.getSongUrl(nextSong.id).then((res) => {
      if (res?.url) {
        this.urlCache.set(cacheKey, res);
        this.logger.debug({ songId: nextSong.id }, "Pre-resolved next track URL");
      }
    }).catch(() => {});
  }

  /** Resolve URL for a song and start playing it. Skips to next if URL fails. */
  async resolveAndPlay(song: QueuedSong): Promise<boolean> {
    if (!this.connected) {
      this.logger.warn({ songId: song.id, name: song.name }, "resolveAndPlay called on disconnected bot — skipping");
      return false;
    }
    if (song.platform === "local" && !this.isLocalAudioEnabled()) {
      this.logger.warn({ songId: song.id, name: song.name }, "Local audio playback disabled — refusing track");
      return false;
    }
    // Keep lightweight test doubles and older integrations usable; real
    // BotInstance instances always provide this gate.
    //
    // The gate THROWS for a disabled source, and playNext()'s retry loop calls
    // this method without a try/catch — so a queued song left over from a
    // since-disabled provider used to abort the whole advance and stop playback
    // silently. A disabled source is a "cannot play this track", not a fatal
    // error: report it as a skip (false) like any other unresolvable URL.
    try {
      this.assertProviderEnabled?.(song.platform);
    } catch (err) {
      this.logger.warn(
        { err, songId: song.id, platform: song.platform },
        "Provider disabled — skipping track instead of aborting the queue",
      );
      return false;
    }
    // Clear any accumulated skip votes — every fresh track starts with a
    // clean slate, regardless of which code path loaded it (cmdPlay,
    // cmdPlaylist, cmdAlbum, cmdFm, trackEnd auto-advance, etc.).
    this.voteSkipUsers.clear();
    const provider = this.getProviderFor(song.platform);
    try {
      const cacheKey = `${song.platform}:${song.id}`;
      let result: { url: string; trialDuration?: number } | null = this.urlCache?.get(cacheKey) ?? null;

      if (!result?.url) {
        result = await provider.getSongUrl(song.id);
        if (result?.url) {
          this.urlCache?.set(cacheKey, result);
        }
      }

      if (!result?.url && this.config.autoSourceFallback !== false && song.platform !== "local") {
        const fallback = await this.fallbackResolveSong(song);
        if (fallback) {
          result = fallback;
          this.urlCache?.set(cacheKey, fallback);
        }
      }

      if (!result?.url) {
        this.logger.warn({ songId: song.id, name: song.name }, "No URL available, skipping");
        return false;
      }
      // Re-check connection state AFTER the network round-trip — the URL
      // resolve can take multiple seconds and the user may have called stop
      // during that window. Without this, we'd spawn ffmpeg on a
      // disconnected bot and land back in the same "connected=false but
      // playing=true" inconsistency that Bug C was about.
      if (!this.connected) {
        this.logger.warn(
          { songId: song.id, name: song.name },
          "bot disconnected during URL resolve — aborting playback",
        );
        return false;
      }
      // Stage 2: a `spotify:` sentinel URI means the go-librespot sidecar
      // serves the audio, NOT ffmpeg. Start the per-bot sidecar on demand; if
      // it can't run (disabled / non-Linux / binary missing) keep the Stage-1
      // fallback message + skip so the queue keeps moving.
      if (isSpotifyUri(result.url)) {
        const ready = await this.spotifyController.ensureStarted();
        if (!ready) {
          this.logger.info({ songId: song.id, name: song.name }, "Spotify backend unavailable — skipping");
          await this.tsClient.sendTextMessage(SPOTIFY_UNAVAILABLE_MESSAGE);
          return false;
        }
        // `spotify:track:<id>` is the URI. go-librespot decodes into a SINGLE
        // continuous FIFO/PCM stream, so per-track playback is just a REST
        // playTrack — the stream keeps flowing. A false result means the
        // sidecar failed the play (dead/errored backend): never attach the
        // player to a dead stream — send the same fallback and skip.
        const played = await this.spotifyController.playTrack(result.url);
        if (!played) {
          this.logger.info({ songId: song.id, name: song.name }, "Spotify playTrack failed — skipping");
          await this.tsClient.sendTextMessage(SPOTIFY_UNAVAILABLE_MESSAGE);
          return false;
        }
        // Only ATTACH the persistent PCM stream when the player is NOT already
        // attached to it. Gate on the player's ACTUAL external state, not the
        // currentSourceIsSpotify flag: command paths (cmdPlay/cmdPlaylist/…)
        // call player.stop() (which detaches the external stream) WITHOUT
        // clearing the flag, so a stale-true flag would skip the re-attach and
        // silence playback. playPcmStream internally fences the prior url-ffmpeg
        // (so NO player.stop() here). On the gapless auto-advance path the
        // player is still attached (isExternalActive() === true) so we do NOT
        // re-attach — the sidecar rolls the SAME FIFO into the next track.
        if (!this.player.isExternalActive()) {
          this.player.playPcmStream(this.spotifyController.getPcmStream(), {
            // The sidecar PCM pipe is long-lived; per-track end arrives via the
            // controller "trackEnded" WS event, not stream EOF. A real EOF here
            // means the sidecar died mid-session — RECOVER instead of emitting
            // silence forever (which would also leave the player stuck in
            // externalMode, so the re-attach gate skips every future track).
            // Tear the controller down (next ensureStarted() rebuilds a fresh
            // backend), stop the player (drop external mode so it re-attaches),
            // and clear the flag so a non-spotify track isn't mis-handled.
            onExternalEnd: () => {
              this.logger.warn("Spotify PCM stream ended unexpectedly — recovering");
              this.spotifyController.stop();
              this.player.stop();
              this.currentSourceIsSpotify = false;
            },
          });
        } else {
          // External-stream-reuse path: the persistent PCM stream is still
          // attached (e.g. we arrived here via pause → skip-within-spotify,
          // where the stream stays attached through the pause). playPcmStream —
          // which is what puts the player into the 'playing' state — is skipped,
          // so without this the player would stay 'paused' and emit silence
          // while the sidecar decodes the new track (corner-case R3-3). resume()
          // is a no-op on an already-playing player, so the normal (non-paused)
          // spotify→spotify handoff is unaffected.
          this.player.resume();
        }
        // The PCM stream is continuous, but elapsed is per-track. Reset the
        // local frame clock on every Spotify handoff, including gapless ones.
        this.player.resetTrackElapsed?.(song.duration);
        this.currentSourceIsSpotify = true;
        this.jellyfinReporter?.onStop();
        song.url = result.url;
        // No trial clip for Spotify — full-track duration only (the near-end
        // stall watchdog is disabled for the external stream anyway).
        this.effectiveDuration = song.duration;
        this.autoPaused = false;
        this.database.addPlayHistory({
          botId: this.id,
          songId: song.id,
          songName: song.name,
          artist: song.artist,
          album: song.album,
          platform: song.platform,
          coverUrl: song.coverUrl,
          requestedBy: song.requestedBy,
        });
        await this.syncProfileToSong(song);
        this.emit("stateChange");
        return true;
      }
      // Non-Spotify track: if we were on Spotify, pause the sidecar so it stops
      // decoding ahead before the URL ffmpeg reclaims the PCM buffer.
      if (this.currentSourceIsSpotify) {
        this.spotifyController.pause().catch((err) =>
          this.logger.warn({ err }, "Failed to pause Spotify sidecar on source switch"));
        this.currentSourceIsSpotify = false;
      }
      song.url = result.url;
      // 试听片段用试听时长（让 player nearEnd 正确触发自动切歌）；完整曲回退 song.duration
      this.effectiveDuration = result.trialDuration ?? song.duration;
      this.player.play(result.url, 0, this.effectiveDuration);
      this.preFetchNextTrack?.();
      // Jellyfin playback reporting: open a session for jellyfin tracks (the
      // reporter closes the previous one itself); close any open session when
      // playback moves to another source. Fire-and-forget — never blocks play.
      if (song.platform === "jellyfin") this.jellyfinReporter?.onTrackStart(song.id);
      else this.jellyfinReporter?.onStop();
      // Fresh playback (re)start — clear auto-pause so a later occupancy
      // change won't try to "resume" a track the user already restarted.
      this.autoPaused = false;
      this.database.addPlayHistory({
        botId: this.id,
        songId: song.id,
        songName: song.name,
        artist: song.artist,
        album: song.album,
        platform: song.platform,
        coverUrl: song.coverUrl,
        requestedBy: song.requestedBy,
      });
      // Keep TeamSpeak-side profile updates on the same path for play/next/FM.
      await this.syncProfileToSong(song);
      this.emit("stateChange");
      return true;
    } catch (err) {
      this.logger.error({ err, songId: song.id }, "Failed to resolve URL");
      return false;
    }
  }

  private async syncProfileToSong(song: QueuedSong | null): Promise<void> {
    try {
      await this.profileManager.onSongChange(song);
    } catch (err) {
      this.logger.warn({ err }, "Profile update failed after song change");
    }
  }

  /**
   * Play a single resolved song immediately, honoring config.playKeepsQueue:
   *  - false (default): clear the queue and play only this song — today's
   *    behavior. The prior track is stopped and released local uploads swept.
   *  - true (and the queue is non-empty): insert the song after the current
   *    track and jump to it (reusing addNext + playAt — no new queue logic), so
   *    the rest of the queue survives and continues after it. FM auto-refill is
   *    stopped (manual takeover), but existing queued songs are preserved.
   *
   * Shared by chat !play and the web /play-song route so the toggle decision
   * lives in exactly one place (#119). Returns true if a track started playing.
   */
  async playSingleSong(song: QueuedSong, requesterName?: string): Promise<boolean> {
    const s = this.withRequester(song, requesterName);
    if (this.config.playKeepsQueue && !this.queue.isEmpty()) {
      const insertedAt =
        this.queue.getCurrentIndex() < 0
          ? this.queue.size()
          : this.queue.getCurrentIndex() + 1;
      this.player.stop();
      this.disableFmMode();
      this.queue.addNext(s);
      this.queue.playAt(insertedAt);
      this.player.resetFailures();
      // No sweep here: the queue is kept, so no local uploads were released.
      return this.resolveAndPlay(this.queue.current()!);
    }
    // Legacy replace behavior (default).
    const previous = this.queue.current();
    if (previous && !this.isSameSong(previous, s)) {
      this.player.stop();
    }
    this.queue.clear();
    this.disableFmMode();
    this.queue.add(s);
    this.queue.play();

    // Reset failure counter on user-initiated play
    this.player.resetFailures();
    const ok = await this.resolveAndPlay(this.queue.current()!);
    // Sweep AFTER the new song is queued+resolved: the replaced songs are no
    // longer referenced (and get deleted), but the song — if it is the same
    // local upload that was already playing — stays referenced and is preserved.
    this.sweepLocalAudio("replaced");
    return ok;
  }

  /**
   * Load a saved song list into this bot's queue (#119). `replace` clears +
   * plays from the first track (exits FM, like a fresh collection load);
   * `append` adds to the end and only starts playing if the bot was idle
   * (never interrupts a playing track). Loaded songs are re-tagged with the
   * loader's name so play-history attribution stays correct.
   */
  async loadSavedQueue(
    songs: StoredSong[],
    mode: "replace" | "append",
    requesterName?: string,
  ): Promise<void> {
    const tagged = songs.map((s) =>
      this.withRequester({ ...(s as QueuedSong) }, requesterName),
    );
    if (mode === "replace") {
      this.player.stop();
      this.queue.clear();
      this.disableFmMode();
      for (const s of tagged) this.queue.add(s);
      this.sweepLocalAudio("queue_replaced");
      const first = this.queue.play();
      this.player.resetFailures();
      if (first) await this.resolveAndPlay(first);
    } else {
      const wasIdle = this.player.getState() === "idle";
      const startAt = this.queue.size();
      for (const s of tagged) this.queue.add(s);
      if (wasIdle && this.queue.size() > startAt) {
        this.queue.playAt(startAt);
        this.player.resetFailures();
        await this.resolveAndPlay(this.queue.current()!);
      }
    }
    this.emit("stateChange");
  }

  /** Persist the current volume (#125). Best-effort: a DB error must never break
   *  the volume change itself. */
  persistVolume(): void {
    try {
      this.database.saveVolume(this.id, this.player.getVolume());
    } catch (err) {
      this.logger.warn({ err }, "Failed to persist volume");
    }
  }

  /** Persist the current play mode (#125). Best-effort, mirrors persistVolume.
   *  Called ONLY from the explicit !mode command — NOT from FM/artist mode, whose
   *  Random/Loop switch is a transient side effect that must not overwrite the
   *  user's saved preference. */
  persistPlayMode(): void {
    try {
      this.database.savePlayMode(this.id, this.queue.getMode());
    } catch (err) {
      this.logger.warn({ err }, "Failed to persist play mode");
    }
  }

  async startFm(provider: MusicProvider = this.neteaseProvider, requesterName?: string): Promise<string> {
    // Match the !fm chat-command guard: refuse before mutating the queue when
    // offline, so the web /fm route can't wipe the queue + flip into FM mode
    // while nothing can actually play.
    if (!this.connected) {
      return "Bot is not connected to TeamSpeak";
    }
    if (!provider.getPersonalFm) {
      return `Personal FM is not available for ${provider.platform}`;
    }
    const songs = await provider.getPersonalFm();
    if (songs.length === 0)
      return "No FM songs available (need to login first)";

    this.player.stop();
    this.queue.clear();
    for (const song of songs) {
      this.queue.add(this.withRequester({ ...song, platform: provider.platform }, requesterName));
    }
    this.queue.setMode(PlayMode.Random);
    this.isFmMode = true;
    this.fmProvider = provider;
    this.fmRequesterName = requesterName?.trim() || undefined;
    this.player.resetFailures();

    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.sweepLocalAudio("queue_replaced");
    this.emit("stateChange");
    const label = provider.platform === "qq" ? "QQ Radar FM" : "Personal FM";
    return `${label} started: ${first?.name ?? "unknown"} - ${first?.artist ?? ""}`;
  }

  async refillFm(): Promise<void> {
    const provider = this.fmProvider;
    if (!this.isFmMode || !provider?.getPersonalFm) return;
    try {
      const songs = await provider.getPersonalFm();
      if (songs.length === 0) return;
      for (const song of songs) {
        this.queue.add(this.withRequester({ ...song, platform: provider.platform }, this.fmRequesterName));
      }
      this.logger.debug({ count: songs.length, platform: provider.platform }, "FM queue refilled");
    } catch (err) {
      this.logger.error({ err }, "Failed to refill FM queue");
    }
  }

  // ─── Live-queue persistence (Feature 2, #119) ────────────────────────────

  /** Synchronous snapshot writer. Persists the live queue (or clears the row
   *  when empty). Best-effort — a DB failure logs and never interrupts play. */
  private persistQueueSnapshot(): void {
    if (!this.config.savedQueuesEnabled) return;
    try {
      const snap = this.queue.snapshot();
      if (snap.songs.length === 0) {
        this.database.clearQueueState(this.id);
        return;
      }
      this.database.saveQueueState({
        botId: this.id,
        songs: snap.songs,
        currentIndex: snap.currentIndex,
        mode: snap.mode,
        isFmMode: this.isFmMode,
        fmPlatform: this.isFmMode && this.fmProvider ? this.fmProvider.platform : "",
      });
    } catch (err) {
      this.logger.warn({ err }, "queue snapshot persist failed");
    }
  }

  /** Debounce the snapshot writer (~1s) off the stateChange firehose. */
  private scheduleQueueSnapshot(): void {
    if (!this.config.savedQueuesEnabled) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => this.persistQueueSnapshot(), 1000);
    // Don't keep the event loop alive just for a pending snapshot.
    this.snapshotTimer.unref?.();
  }

  /** Restore + resume the live queue after (re)connect. Best-effort: resumes
   *  the current track from its START (URLs are re-resolved; no persisted
   *  elapsed). Spotify resume depends on the sidecar being available. */
  private async restoreQueueFromSnapshot(): Promise<void> {
    if (!this.config.savedQueuesEnabled) return;
    let st;
    try {
      st = this.database.getQueueState(this.id);
    } catch (err) {
      this.logger.warn({ err }, "queue snapshot restore failed to read state");
      return;
    }
    if (!st || st.songs.length === 0) return;
    this.queue.restore({
      songs: st.songs,
      currentIndex: st.currentIndex,
      mode: st.mode as PlayMode,
    });
    if (st.isFmMode && st.fmPlatform) {
      this.isFmMode = true;
      this.fmProvider = this.getProviderFor(st.fmPlatform as Platform);
    }
    const current = this.queue.current();
    if (current) {
      this.player.resetFailures();
      await this.resolveAndPlay(current);
      void this.refreshOccupancy?.();
    }
    this.logger.info(
      { count: st.songs.length, index: st.currentIndex },
      "Restored live queue from snapshot",
    );
  }

  cmdPause(): string {
    return getOrCreateHandler(this).cmdPause();
  }
  cmdResume(): string {
    return getOrCreateHandler(this).cmdResume();
  }
  cmdStop(): string {
    return getOrCreateHandler(this).cmdStop();
  }
  cmdNext(): Promise<string> {
    return getOrCreateHandler(this).cmdNext();
  }
  cmdPrev(): Promise<string> {
    return getOrCreateHandler(this).cmdPrev();
  }
  cmdVol(cmd: ParsedCommand): string {
    return getOrCreateHandler(this).cmdVol(cmd);
  }
  cmdNow(): string {
    return getOrCreateHandler(this).cmdNow();
  }
  cmdQueue(): string {
    return getOrCreateHandler(this).cmdQueue();
  }
  cmdClear(): string {
    return getOrCreateHandler(this).cmdClear();
  }
  cmdRemove(cmd: ParsedCommand): Promise<string> {
    return getOrCreateHandler(this).cmdRemove(cmd);
  }
  cmdMode(cmd: ParsedCommand): string {
    return getOrCreateHandler(this).cmdMode(cmd);
  }
  cmdPlaylist(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    return getOrCreateHandler(this).cmdPlaylist(cmd, requesterName);
  }
  cmdAlbum(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    return getOrCreateHandler(this).cmdAlbum(cmd, requesterName);
  }
  cmdFm(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    return getOrCreateHandler(this).cmdFm(cmd, requesterName);
  }
  cmdArtist(cmd: ParsedCommand, requesterName?: string): Promise<string> {
    return getOrCreateHandler(this).cmdArtist(cmd, requesterName);
  }
  cmdVote(msg?: TS3TextMessage): Promise<string> {
    return getOrCreateHandler(this).cmdVote(msg);
  }
  cmdLyrics(): Promise<string> {
    return getOrCreateHandler(this).cmdLyrics();
  }
  cmdMove(cmd: ParsedCommand): Promise<string> {
    return getOrCreateHandler(this).cmdMove(cmd);
  }
  cmdHome(): Promise<string> {
    return getOrCreateHandler(this).cmdHome();
  }
  cmdFollow(msg?: TS3TextMessage): Promise<string> {
    return getOrCreateHandler(this).cmdFollow(msg);
  }
  savedQueuesGuard(): string | null {
    return getOrCreateHandler(this).savedQueuesGuard();
  }
  cmdSaveQueue(cmd: ParsedCommand): string {
    return getOrCreateHandler(this).cmdSaveQueue(cmd);
  }
  cmdLoadQueue(cmd: ParsedCommand): Promise<string> {
    return getOrCreateHandler(this).cmdLoadQueue(cmd);
  }
  cmdListQueues(): string {
    return getOrCreateHandler(this).cmdListQueues();
  }
  cmdHelp(): string {
    return getOrCreateHandler(this).cmdHelp();
  }

  /**
   * Advance the queue and play the next song. If the resolved URL fails
   * more songs looking for a playable one. Public so REST endpoints that
   * seed the queue can fall back to this retry-skip behavior.
   *
   * Returns true if a song actually started playing, false otherwise.
   */
  async playNext(maxRetries = 3): Promise<boolean> {
    if (this.isAdvancing || !this.connected) return false;
    this.isAdvancing = true;
    let started = false;
    try {
      this.voteSkipUsers.clear();
      const next = this.queue.next();
      if (next) {
        started = await this.resolveAndPlay(next);
        if (!started) {
          for (let i = 0; i < maxRetries && this.connected; i++) {
            const retry = this.queue.next();
            if (!retry) break;
            if (await this.resolveAndPlay(retry)) {
              started = true;
              break;
            }
          }
        }
        if (!started) {
          this.player.stop();
          this.profileManager.onSongChange(null).catch(() => {});
        } else if (this.isFmMode && this.queue.unplayedCount() <= 3) {
          // Proactive refill: when queue is running low, fetch more FM songs
          this.refillFm().catch(err => this.logger.error({ err }, "Proactive FM refill failed"));
        }
      } else {
        // Queue exhausted — in FM Random mode, refill and continue
        if (this.isFmMode) {
          await this.refillFm();
          const refillNext = this.queue.next();
          if (refillNext) {
            started = await this.resolveAndPlay(refillNext);
          }
          if (!started) {
            this.player.stop();
            this.profileManager.onSongChange(null).catch(() => {});
          }
        } else {
          // Queue exhausted on a non-FM source (skip-past-end or natural
          // last-track end via trackEnded→playNext). If the ending track was
          // served by the Spotify sidecar, tear it down like cmdStop —
          // otherwise the go-librespot Connect device stays active with the
          // track loaded (decoding into a detached/backpressured stream) and
          // currentSourceIsSpotify stays stale (corner-case R3-6).
          if (this.currentSourceIsSpotify) {
            this.spotifyController.stop();
            this.currentSourceIsSpotify = false;
          }
          this.player.stop();
          this.profileManager.onSongChange(null).catch(() => {});
        }
      }
      this.emit("stateChange");
      return started;
    } finally {
      // Reference-aware sweep: a finished local song that still sits in the
      // queue (sequential history, loop/repeat, or queued on another bot) is
      // preserved; only uploads no longer referenced anywhere are deleted.
      this.sweepLocalAudio("playback_finished");
      this.isAdvancing = false;
    }
  }

  extractId(input: string): string {
    const trimmed = input.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      const match = trimmed.match(/[?&]id=(\d+)/);
      if (match) return match[1];
      const pathMatch = trimmed.match(/\/(\d+)(?:[/?#]|$)/);
      if (pathMatch) return pathMatch[1];
    } else {
      const match = trimmed.match(/[?&]id=(\d+)/);
      if (match) return match[1];
    }
    return input;
  }

  /** Direct collection ids: numeric (NetEase/QQ) or Jellyfin GUID ItemIds
   *  (32 hex chars, optionally dashed) — never treat those as name searches. */
  looksLikeCollectionId(raw: string): boolean {
    const t = raw.trim();
    return (
      /^\d+$/.test(t) ||
      /^[0-9a-fA-F]{32}$/.test(t) ||
      /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(t)
    );
  }

  /** Serialize queue-mutation + play sequences so concurrent requests can't
   *  interleave (audible track must match queue.currentIndex). */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.playGate.then(fn, fn);
    this.playGate = next.catch(() => {});
    return next;
  }

  

  getStatus(): BotStatus {
    return {
      id: this.id,
      name: this.name,
      connected: this.connected,
      playing: this.player.getState() === "playing",
      paused: this.player.getState() === "paused",
      currentSong: this.queue.current(),
      queueSize: this.queue.size(),
      volume: this.player.getVolume(),
      playMode: this.queue.getMode(),
      elapsed: this.player.getElapsed(),
      effectiveDuration: this.effectiveDuration,
    };
  }

  getQueue(): QueuedSong[] {
    return this.queue.list();
  }

  getPlayer(): AudioPlayer {
    return this.player;
  }

  /** The per-bot Spotify sidecar controller. Exposed like getPlayer()/
   *  getQueueManager() so the shared, process-wide OAuth threaded in at
   *  construction (C3.1) is observable to callers/tests via getOAuth(). */
  getSpotifyController(): SpotifyController {
    return this.spotifyController;
  }

  /**
   * Route a seek to the Spotify sidecar for a spotify track (its PCM stream is
   * external — AudioPlayer.seek would respawn ffmpeg on the `spotify:` sentinel
   * and collide with the running stream), otherwise to the URL player.
   */
  seek(seconds: number): void {
    if (this.queue.current()?.platform === "spotify") {
      // The web route + AudioPlayer.seek are seconds-based, but
      // SpotifyController.seek expects milliseconds — convert here.
      this.spotifyController.seek(seconds * 1000).catch((err) =>
        this.logger.warn({ err }, "Spotify seek failed"));
      return;
    }
    this.player.seek(seconds);
  }

  getQueueManager(): PlayQueue {
    return this.queue;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getProfileManager(): BotProfileManager {
    return this.profileManager;
  }

  getIdentityExport(): string | undefined {
    return this.tsClient.getIdentityExport();
  }
}
