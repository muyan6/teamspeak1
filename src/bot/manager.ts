import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  BotInstance,
  type BotInstanceOptions,
  spotifyPortsForBotId,
} from "./instance.js";
import type { MusicProvider } from "../music/provider.js";
import { YouTubeProvider } from "../music/youtube.js";
import type { BotDatabase } from "../data/database.js";
import { saveConfig, type BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";

import type { ServerProtocol } from "../ts-protocol/client.js";
import type { AvatarStore } from "../data/avatars.js";
import type { PermissionStore } from "../data/permissions.js";
import type { SpotifyOAuth } from "../music/spotify/spotify-oauth.js";
import { ManagedVoiceClientRegistry } from "./managed-voice-clients.js";

/**
 * Run bot.connect() with a hard deadline. If the handshake hangs (e.g. the
 * server silently drops the connection after initivexpand2), we tear the
 * instance down instead of waiting for the library's 60s idle timeout, so
 * the HTTP /start call returns promptly and the UI doesn't lock up.
 */
async function connectWithTimeout(
  bot: BotInstance,
  ms: number,
  logger: Logger
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`connect timeout after ${ms}ms`)),
      ms
    );
  });
  try {
    await Promise.race([bot.connect(), timeout]);
  } catch (err) {
    logger.warn(
      { err, botId: bot.id },
      "Connect failed or timed out — tearing down instance"
    );
    try {
      bot.disconnect();
    } catch {
      // ignore teardown errors
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Normalize serverAddress and serverPort:
 * If user entered "host:port" or "[ipv6]:port" in serverAddress,
 * intelligently extract the pure host and port.
 */
export function normalizeServerAddress(
  serverAddress: string,
  defaultPort = 9987
): { host: string; port: number } {
  let host = (serverAddress ?? "").trim();
  let port = Number.isInteger(defaultPort) && defaultPort > 0 && defaultPort <= 65_535
    ? defaultPort
    : 9987;

  if (host.startsWith("[")) {
    const closing = host.indexOf("]");
    if (closing > 0) {
      if (host[closing + 1] === ":") {
        const rawPort = Number(host.slice(closing + 2));
        if (Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535) {
          port = rawPort;
        }
      }
      host = host.slice(1, closing);
    }
  } else if (host.includes(":")) {
    const parts = host.split(":");
    if (parts.length === 2) {
      const rawPort = Number(parts[1]);
      if (Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535) {
        host = parts[0];
        port = rawPort;
      }
    }
  }

  return { host, port };
}

export interface CreateBotParams {
  name: string;
  serverAddress: string;
  serverPort: number;
  queryPort?: number;
  nickname: string;
  defaultChannel?: string;
  channelId?: string;
  channelPassword?: string;
  autoStart?: boolean;
  /** Force TS3 or TS6 protocol; omit or "unknown" for auto-detect. */
  serverProtocol?: ServerProtocol | "";
  /** API key for TS6 HTTP Query (port 10080/10443). */
  ts6ApiKey?: string;
  /** Password required to join the TS server. */
  serverPassword?: string;
}

export class BotManager extends EventEmitter {
  private bots = new Map<string, BotInstance>();
  private readonly managedVoiceClients = new ManagedVoiceClientRegistry();
  private neteaseProvider: MusicProvider;
  private qqProvider: MusicProvider;
  private bilibiliProvider: MusicProvider;
  private youtubeProvider: MusicProvider;
  private localProvider: MusicProvider;
  private kugouProvider: MusicProvider;
  private spotifyProvider: MusicProvider;
  private jellyfinProvider: MusicProvider;
  private spotifyDataDir: string;
  private readonly spotifyOAuth?: SpotifyOAuth;
  private database: BotDatabase;
  private config: BotConfig;
  private logger: Logger;
  private avatarStore: AvatarStore;
  private permissions: PermissionStore;
  private configPath: string;
  private readonly spotifyPortAllocations = new Map<
    string,
    ReturnType<typeof spotifyPortsForBotId>
  >();

  constructor(
    neteaseProvider: MusicProvider,
    qqProvider: MusicProvider,
    bilibiliProvider: MusicProvider,
    database: BotDatabase,
    config: BotConfig,
    logger: Logger,
    avatarStore: AvatarStore,
    permissions: PermissionStore,
    configPath: string,
    localProvider?: MusicProvider,
    kugouProvider?: MusicProvider,
    spotifyProvider?: MusicProvider,
    spotifyDataDir?: string,
    spotifyOAuth?: SpotifyOAuth,
    jellyfinProvider?: MusicProvider
  ) {
    super();
    this.neteaseProvider = neteaseProvider;
    this.qqProvider = qqProvider;
    this.bilibiliProvider = bilibiliProvider;
    this.youtubeProvider = new YouTubeProvider();
    this.localProvider = localProvider ?? neteaseProvider;
    this.kugouProvider = kugouProvider ?? neteaseProvider;
    this.spotifyProvider = spotifyProvider ?? neteaseProvider;
    this.jellyfinProvider = jellyfinProvider ?? neteaseProvider;
    this.spotifyDataDir = spotifyDataDir ?? path.join(process.cwd(), "data", "spotify");
    this.spotifyOAuth = spotifyOAuth;
    // Let the local provider see which uploads are still referenced by any
    // bot's queue, so it never deletes a file another queue/bot still needs.
    const referenceable = this.localProvider as Partial<{
      setInUseResolver: (resolver: () => Set<string>) => void;
    }>;
    referenceable.setInUseResolver?.(() => this.getReferencedLocalSongIds());
    this.database = database;
    this.config = config;
    this.logger = logger;
    this.avatarStore = avatarStore;
    this.permissions = permissions;
    this.configPath = configPath;
  }

  async createBot(params: CreateBotParams): Promise<BotInstance> {
    const id = crypto.randomUUID();
    const { host: serverAddress, port: serverPort } = normalizeServerAddress(
      params.serverAddress,
      params.serverPort ?? 9987
    );

    const savedRecord = {
      id,
      name: params.name,
      serverAddress,
      serverPort,
      queryPort: params.queryPort,
      nickname: params.nickname,
      defaultChannel: params.defaultChannel ?? "",
      channelId: params.channelId ?? "",
      channelPassword: params.channelPassword ?? "",
      autoStart: params.autoStart ?? true,
      serverProtocol: params.serverProtocol ?? "",
      ts6ApiKey: params.ts6ApiKey ?? "",
      serverPassword: params.serverPassword ?? "",
    };
    this.database.saveBotInstance(savedRecord);

    const bot = this.buildBotInstance(savedRecord);
    this.bots.set(id, bot);
    this.emit("botInstance", bot);

    this.logger.info({ botId: id, name: params.name }, "Bot instance created");
    return bot;
  }

  async removeBot(id: string): Promise<void> {
    const bot = this.bots.get(id);
    if (bot) {
      bot.disconnect();
      this.bots.delete(id);
    }
    this.spotifyPortAllocations.delete(id);
    this.database.deleteBotInstance(id);
    this.permissions.pruneBot(id);
    // Prune the deleted bot from the guest scope allow-list (mirrors permissions.pruneBot).
    if (Array.isArray(this.config.guestMode.bots) && this.config.guestMode.bots.includes(id)) {
      this.config.guestMode.bots = this.config.guestMode.bots.filter((b) => b !== id);
      saveConfig(this.configPath, this.config);
    }
    this.emit("botInstanceRemoved", id);
    this.logger.info({ botId: id }, "Bot instance removed");
  }

  updateBot(id: string, params: Partial<CreateBotParams>): void {
    const instances = this.database.getBotInstances();
    const existing = instances.find((i) => i.id === id);
    if (!existing) throw new Error(`Bot ${id} not found`);

    let serverAddress = params.serverAddress ?? existing.serverAddress;
    let serverPort = params.serverPort ?? existing.serverPort;
    if (params.serverAddress !== undefined) {
      const normalized = normalizeServerAddress(params.serverAddress, serverPort);
      serverAddress = normalized.host;
      serverPort = normalized.port;
    }

    this.database.saveBotInstance({
      ...existing,
      name: params.name ?? existing.name,
      serverAddress,
      serverPort,
      queryPort: params.queryPort ?? existing.queryPort,
      nickname: params.nickname ?? existing.nickname,
      defaultChannel: params.defaultChannel ?? existing.defaultChannel,
      channelId: params.channelId ?? existing.channelId,
      channelPassword: params.channelPassword ?? existing.channelPassword,
      serverProtocol: params.serverProtocol ?? existing.serverProtocol,
      ts6ApiKey: params.ts6ApiKey ?? existing.ts6ApiKey,
      serverPassword: params.serverPassword ?? existing.serverPassword,
      autoStart: params.autoStart !== undefined ? params.autoStart : existing.autoStart,
    });
    // Update in-memory name immediately (other fields need reconnect)
    const bot = this.bots.get(id);
    if (bot && params.name) {
      bot.name = params.name;
    }
    this.logger.info({ botId: id }, "Bot instance config updated (connection changes need restart)");
  }

  getBotConfig(id: string): import("../data/database.js").BotInstance | undefined {
    return this.database.getBotInstances().find((i) => i.id === id);
  }

  getBot(id: string): BotInstance | undefined {
    return this.bots.get(id);
  }

  getAllBots(): BotInstance[] {
    return Array.from(this.bots.values());
  }

  /** Local upload ids still referenced by any bot's queue. The local provider
   *  uses this to avoid deleting a file another queue/bot is still using. */
  getReferencedLocalSongIds(): Set<string> {
    const ids = new Set<string>();
    for (const bot of this.bots.values()) {
      for (const song of bot.getQueueManager().list()) {
        if (song.platform === "local") ids.add(song.id);
      }
    }
    return ids;
  }

  async startBot(id: string): Promise<void> {
    const oldBot = this.bots.get(id);
    if (!oldBot) throw new Error(`Bot ${id} not found`);

    // Always tear down the outgoing instance before creating a replacement.
    // Covers three cases:
    //   1. oldBot is fully connected (manual restart)
    //   2. oldBot is mid-handshake from a prior rapid start (isConnected()
    //      still returns false but the library client is live and will leak
    //      a TS session if we abandon it)
    //   3. oldBot was just created by createBot but never connected — the
    //      disconnect call is a cheap no-op here.
    // Calling disconnect() is idempotent (disconnectEmitted guards event
    // emission), so this is safe in all states.
    oldBot.disconnect();

    // Reload config from database so updated settings (channel, nickname, etc.) take effect
    const saved = this.database.getBotInstances().find((i) => i.id === id);
    if (saved) {
      const bot = this.buildBotInstance(saved);
      this.bots.set(id, bot);
      this.emit("botInstance", bot);
      await connectWithTimeout(bot, 25_000, this.logger);
      // Mark as autoStart so it reconnects on Docker / service restart, and persist identity
      const identity = bot.getIdentityExport() || saved.identity;
      this.database.saveBotInstance({ ...saved, autoStart: true, identity });
    } else {
      await connectWithTimeout(oldBot, 25_000, this.logger);
    }
  }

  stopBot(id: string): void {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot ${id} not found`);
    bot.disconnect();

    // Mark as not autoStart so it stays stopped on Docker restart
    const saved = this.database.getBotInstances().find((i) => i.id === id);
    if (saved) {
      this.database.saveBotInstance({ ...saved, autoStart: false });
    }
  }

  async batchStartBots(ids: string[]): Promise<{ started: string[]; failed: Array<{ id: string; error: string }> }> {
    const started: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      try {
        await this.startBot(id);
        started.push(id);
        if (i < ids.length - 1) {
          // Stagger start slightly to avoid flooding TS server
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
      }
    }

    return { started, failed };
  }

  batchStopBots(ids: string[]): { stopped: string[]; failed: Array<{ id: string; error: string }> } {
    const stopped: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      try {
        this.stopBot(id);
        stopped.push(id);
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
      }
    }

    return { stopped, failed };
  }

  /**
   * Instantiate every saved bot (synchronously, so they are immediately present
   * in getAllBots()) and optionally drive their auto-connect handshakes.
   *
   * `awaitConnections: false` (used by the boot path) returns as soon as the
   * instances exist, with the connects running in the background. The old
   * all-awaited behaviour meant the boot sequence — which calls this BEFORE
   * starting the web server — was blocked for up to 25s per unreachable bot
   * plus a fixed 1s stagger: ten auto-start bots with a few dead hosts left the
   * WebUI unreachable for minutes and tripped container health checks. Waiting
   * for handshakes was never required for the web layer to be correct; it only
   * needs the instances to exist, which the synchronous pass guarantees.
   */
  async loadSavedBots(opts: { awaitConnections?: boolean } = {}): Promise<void> {
    const awaitConnections = opts.awaitConnections !== false;
    const savedInstances = this.database.getBotInstances();

    // ── Synchronous pass: register every instance before any await ──
    const pendingConnects: Array<{
      saved: import("../data/database.js").BotInstance;
      bot: BotInstance;
    }> = [];
    for (const saved of savedInstances) {
      const bot = this.buildBotInstance(saved);
      this.bots.set(saved.id, bot);
      this.emit("botInstance", bot);

      if (saved.autoStart) {
        pendingConnects.push({ saved, bot });
      } else {
        this.logger.info(
          { botId: saved.id, name: saved.name },
          "Loaded bot (autoStart disabled, not connecting)"
        );
      }
    }

    const connectAll = async () => {
      for (const { saved, bot } of pendingConnects) {
        try {
          await connectWithTimeout(bot, 25_000, this.logger);
          this.persistBotIdentity(saved, bot);
          this.logger.info(
            { botId: saved.id, name: saved.name },
            "Auto-connected saved bot"
          );
        } catch (err) {
          this.logger.error(
            { err, botId: saved.id, name: saved.name },
            "Failed to auto-connect bot on startup (will retry in background)"
          );
          bot.scheduleAutoReconnect(3000);
        }

        // Stagger connections to avoid overwhelming the TS server
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };

    if (awaitConnections) {
      await connectAll();
    } else {
      // Detached on purpose: the caller must not wait on remote handshakes.
      // Every path inside connectAll() handles its own errors, so this promise
      // cannot reject and become an unhandled rejection.
      void connectAll();
    }

    this.logger.info(
      { count: savedInstances.length, autoConnect: pendingConnects.length },
      "Loaded saved bot instances"
    );
  }

  private persistBotIdentity(saved: import("../data/database.js").BotInstance, bot: BotInstance): void {
    const identity = bot.getIdentityExport();
    if (identity && identity !== saved.identity) {
      this.database.saveBotInstance({ ...saved, identity });
    }
  }

  /**
   * Keep Spotify sidecar ports unique inside this Node process. The stable hash
   * remains the starting point so a single bot keeps the same ports across
   * restarts, while collisions are resolved by the manager instead of making
   * the second bot permanently unusable.
   */
  private allocateSpotifyPorts(id: string): ReturnType<typeof spotifyPortsForBotId> {
    const existing = this.spotifyPortAllocations.get(id);
    if (existing) return existing;

    const base = spotifyPortsForBotId(id);
    const used = new Set<number>();
    for (const ports of this.spotifyPortAllocations.values()) {
      used.add(ports.apiPort);
      used.add(ports.callbackPort);
    }

    let apiPort = base.apiPort;
    let callbackPort = base.callbackPort;
    while (used.has(apiPort) || used.has(callbackPort)) {
      apiPort++;
      callbackPort++;
      if (callbackPort > 65_535) {
        throw new Error("No free Spotify sidecar port pair is available");
      }
    }

    const allocated = { apiPort, callbackPort };
    this.spotifyPortAllocations.set(id, allocated);
    return allocated;
  }

  shutdown(): void {
    for (const bot of this.bots.values()) {
      bot.disconnect();
    }
    this.bots.clear();
    this.spotifyPortAllocations.clear();
  }

  private buildBotInstance(saved: import("../data/database.js").BotInstance): BotInstance {
    const proto = saved.serverProtocol as "ts3" | "ts6" | "" | undefined;
    const { host: serverAddress, port: serverPort } = normalizeServerAddress(
      saved.serverAddress,
      saved.serverPort ?? 9987
    );
    return new BotInstance({
      id: saved.id,
      name: saved.name,
      tsOptions: {
        host: serverAddress,
        port: serverPort,
        queryPort: saved.queryPort ?? (proto === "ts6" ? 10080 : 10011),
        nickname: saved.nickname,
        identity: saved.identity || undefined,
        defaultChannel: saved.defaultChannel || undefined,
        channelId: saved.channelId || undefined,
        channelPassword: saved.channelPassword || undefined,
        serverPassword: saved.serverPassword || undefined,
        serverProtocol: proto === "ts3" || proto === "ts6" ? proto : undefined,
        ts6ApiKey: saved.ts6ApiKey || undefined,
      },
      neteaseProvider: this.neteaseProvider,
      qqProvider: this.qqProvider,
      bilibiliProvider: this.bilibiliProvider,
      youtubeProvider: this.youtubeProvider,
      localProvider: this.localProvider,
      kugouProvider: this.kugouProvider,
      spotifyProvider: this.spotifyProvider,
      jellyfinProvider: this.jellyfinProvider,
      database: this.database,
      config: this.config,
      logger: this.logger,
      avatarStore: this.avatarStore,
      managedVoiceClients: this.managedVoiceClients,
      spotifyDataDir: this.spotifyDataDir,
      spotifyOAuth: this.spotifyOAuth,
      spotifyPorts: this.allocateSpotifyPorts(saved.id),
    });
  }
}
