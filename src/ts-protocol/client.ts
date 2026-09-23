import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import dgram from "node:dgram";
import {
  Client as TS3FullClient,
  generateIdentity as genTS3Identity,
  getUidFromPublicKey,
  identityFromString,
  sendTextMessage,
  listChannels,
  listClients,
  clientMove,
  getClientInfo,
  fileTransferDeleteFile,
  type Identity,
  type TextMessage,
  type ClientInfo,
  type ClientLeftViewEvent,
  type ClientMovedEvent,
  type VoiceData,
  type FileUploadInfo,
} from "@honeybbq/teamspeak-client";
import type { Logger } from "../logger.js";
import {
  detectServerProtocol,
  type ServerProtocol,
} from "./protocol-detect.js";
import { TS6HttpQuery } from "./http-query.js";
import {
  TrackingVoiceEndpointResolver,
  type ResolvedVoiceEndpoint,
} from "./voice-endpoint.js";

export { CODEC_OPUS_MUSIC } from "./voice.js";
export type { ServerProtocol } from "./protocol-detect.js";
export type { FileUploadInfo, ClientInfo } from "@honeybbq/teamspeak-client";

/** Escape a string for use in TS3 ServerQuery-style commands. */
export function escapeTS3(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/ /g, "\\s")
    .replace(/\//g, "\\/")
    .replace(/\|/g, "\\p")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

export interface TS3ClientOptions {
  host: string;
  port: number; // Voice/virtual server port (default 9987)
  queryPort: number; // ServerQuery port (10011 for TS3, 10080 for TS6 HTTP)
  nickname: string;
  identity?: string; // Exported identity string, or undefined to generate new
  defaultChannel?: string;
  channelId?: string; // Numeric channel ID (takes precedence over defaultChannel)
  channelPassword?: string;
  serverPassword?: string;
  /** Force a specific protocol instead of auto-detecting. */
  serverProtocol?: ServerProtocol;
  /** API key for TS6 HTTP Query authentication. */
  ts6ApiKey?: string;
}

export interface TS3TextMessage {
  invokerName: string;
  invokerId: string;
  invokerUid: string;
  message: string;
  targetMode: number; // 1=private, 2=channel, 3=server
  invokerGroups: string[]; // sender's TS server-group ids; [] when not in view cache
}

/** Lightweight voice-packet signal used for activity detection. The encoded
 * payload is intentionally not forwarded beyond this protocol wrapper. */
export interface TS3VoiceActivity {
  clientId: number;
  codec: number;
  /** Stable TeamSpeak identity when the sender is present in the client view. */
  clientUid?: string;
}

// Command notifications and UDP voice packets can be reordered in flight.
// Retain a leaving client's UID briefly so its final packet is still
// attributable; a new clientEnter for the same id cancels and overwrites it.
const VISIBLE_CLIENT_UID_RELEASE_GRACE_MS = 1_000;

/**
 * Map the library's TextMessage to our wrapper. Preserves invokerGroups (the
 * sender's TS server groups), which the library populates only when the sender
 * is in the bot's client-view cache; otherwise it is []. Used by the chat
 * command permission gate.
 */
export function toTS3TextMessage(msg: TextMessage): TS3TextMessage {
  return {
    invokerName: msg.invokerName,
    invokerId: String(msg.invokerID),
    invokerUid: msg.invokerUID,
    message: msg.message,
    targetMode: msg.targetMode,
    invokerGroups: msg.invokerGroups ?? [],
  };
}

export class TS3Client extends EventEmitter {
  private client: TS3FullClient | null = null;
  private identity: Identity;
  private readonly clientUid: string;
  private clientId = 0;
  private currentChannelId: bigint = 0n;
  private initialDefaultChannelId: bigint = 0n;
  private readonly visibleClients = new Map<number, ClientInfo>();
  private readonly visibleClientUids = new Map<number, string>();
  private readonly visibleClientUidReleaseTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();
  private logger: Logger;
  private disconnecting = false;
  private detectedProtocol: ServerProtocol = "unknown";
  private httpQuery: TS6HttpQuery | null = null;
  private udpErrorTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly voiceEndpointResolver = new TrackingVoiceEndpointResolver();

  constructor(private options: TS3ClientOptions, logger: Logger) {
    super();
    this.logger = logger;

    if (options.identity) {
      this.identity = identityFromString(options.identity);
    } else {
      this.identity = genTS3Identity(8);
    }
    this.clientUid = getUidFromPublicKey(this.identity.publicKeyBase64());
  }

  /** The detected (or forced) server protocol after connect(). */
  getServerProtocol(): ServerProtocol {
    return this.detectedProtocol;
  }

  /** TS6 HTTP Query client (available after connecting to a TS6 server). */
  getHttpQuery(): TS6HttpQuery | null {
    return this.httpQuery;
  }

  async connect(): Promise<void> {
    this.disconnecting = false;
    this.voiceEndpointResolver.reset();
    this.clearVisibleClientUids();
    this.visibleClients.clear();
    // Clean up any existing connection before creating a new one
    if (this.client) {
      this.logger.info("Cleaning up previous connection before reconnecting");
      try {
        await this.client.disconnect();
      } catch {
        // Ignore errors during cleanup
      }
      this.client = null;
      this.clientId = 0;
    }

    let parsedHost = (this.options.host ?? "").trim();
    let parsedPort = this.options.port;
    if (parsedHost.startsWith("[")) {
      const closing = parsedHost.indexOf("]");
      if (closing > 0) {
        if (parsedHost[closing + 1] === ":") {
          const rawP = parseInt(parsedHost.slice(closing + 2), 10);
          if (Number.isInteger(rawP) && rawP > 0 && rawP <= 65535) {
            parsedPort = rawP;
          }
        }
        parsedHost = parsedHost.slice(1, closing);
      }
    } else if (parsedHost.includes(":")) {
      const parts = parsedHost.split(":");
      if (parts.length === 2) {
        const rawP = parseInt(parts[1], 10);
        if (Number.isInteger(rawP) && rawP > 0 && rawP <= 65535) {
          parsedHost = parts[0];
          parsedPort = rawP;
        }
      }
    }

    const addr = parsedHost.includes(":")
      ? `[${parsedHost}]:${parsedPort}`
      : `${parsedHost}:${parsedPort}`;

    // Detect or use forced protocol
    if (this.options.serverProtocol && this.options.serverProtocol !== "unknown") {
      this.detectedProtocol = this.options.serverProtocol;
      this.logger.info(
        { addr, protocol: this.detectedProtocol },
        "Using forced server protocol",
      );
    } else {
      this.logger.info({ addr }, "Detecting server protocol (TS3/TS6)...");
      // The default installation exposes TS3 Query on 10011 and TS6 HTTP
      // Query on 10080. A user-supplied queryPort is different: probe that
      // same port as both protocols so non-default deployments are detected.
      const queryPort = this.options.queryPort;
      const detectionPorts =
        queryPort === 10011 || queryPort === 10080
          ? { ts3QueryPort: 10011, ts6HttpPort: 10080 }
          : { ts3QueryPort: queryPort, ts6HttpPort: queryPort };
      const detection = await detectServerProtocol(
        parsedHost,
        parsedPort,
        3000,
        detectionPorts,
      );
      this.detectedProtocol = detection.protocol;
      if (this.detectedProtocol === "unknown") {
        this.logger.warn(
          { addr },
          "Could not detect server protocol (query ports 10011/10080 unreachable). " +
            "Will attempt voice connection anyway. Use serverProtocol option to force TS3 or TS6.",
        );
      } else {
        this.logger.info(
          { addr, protocol: this.detectedProtocol, queryPort: detection.queryPort },
          `Server protocol detected: ${this.detectedProtocol.toUpperCase()}`,
        );
      }
    }

    // Set up TS6 HTTP Query if applicable
    if (this.detectedProtocol === "ts6") {
      const queryPort = this.options.queryPort !== 10011 ? this.options.queryPort : 10080;
      this.httpQuery = new TS6HttpQuery({
        host: parsedHost,
        port: queryPort,
        apiKey: this.options.ts6ApiKey,
      });
    }

    this.logger.info(
      { addr, protocol: this.detectedProtocol },
      "Connecting to TeamSpeak server (full client protocol)",
    );

    // Throttle repeated "udp send error" warnings (fires every 20ms during playback if UDP breaks)
    let udpErrorCount = 0;
    const throttledWarn = (msg: string, ...args: unknown[]) => {
      if (typeof msg === "string" && msg.includes("udp send error")) {
        udpErrorCount++;
        if (udpErrorCount === 1) {
          this.logger.warn(msg);
          // After 2 seconds, log a summary and reset.
          // Clear any previous timer to avoid leaking it.
          if (this.udpErrorTimer) clearTimeout(this.udpErrorTimer);
          this.udpErrorTimer = setTimeout(() => {
            if (udpErrorCount > 1) {
              this.logger.warn(`udp send error (repeated ${udpErrorCount} times, connection may be lost)`);
            }
            udpErrorCount = 0;
            this.udpErrorTimer = null;
          }, 2000);
        }
        return;
      }
      this.logger.warn(msg);
    };

    this.client = new TS3FullClient(this.identity, addr, this.options.nickname, {
      // Forward server password to the protocol library so it can be
      // included in clientinit for password-protected servers
      serverPassword: this.options.serverPassword,
      resolver: this.voiceEndpointResolver,
      logger: {
        debug: (msg) => this.logger.debug(msg),
        info: (msg) => this.logger.info(msg),
        warn: throttledWarn,
        error: (msg) => this.logger.error(msg),
      },
    });

    const patchHandler = (h: any) => {
      if (!h) return;
      if (typeof h.connect === "function" && !h._safeConnectPatched) {
        h._safeConnectPatched = true;
        h.connect = (targetAddr: string) => {
          return new Promise<void>((resolve, reject) => {
            let targetHost: string;
            let targetRawPort: string;
            if (targetAddr.startsWith("[")) {
              const closing = targetAddr.indexOf("]");
              if (closing > 0 && targetAddr[closing + 1] === ":") {
                targetHost = targetAddr.slice(1, closing);
                targetRawPort = targetAddr.slice(closing + 2);
              } else {
                targetHost = targetAddr;
                targetRawPort = "9987";
              }
            } else {
              const sep = targetAddr.lastIndexOf(":");
              if (sep > 0) {
                targetHost = targetAddr.slice(0, sep);
                targetRawPort = targetAddr.slice(sep + 1);
              } else {
                targetHost = targetAddr;
                targetRawPort = "9987";
              }
            }

            const targetPort = parseInt(targetRawPort, 10);
            if (isNaN(targetPort) || targetPort <= 0 || targetPort > 65535) {
              reject(new Error(`Invalid TeamSpeak port: "${targetRawPort}"`));
              return;
            }

            const socket = dgram.createSocket("udp4");
            let settled = false;
            const onError = (err: Error) => {
              if (settled) return;
              settled = true;
              try { socket.close(); } catch {}
              reject(err);
            };

            socket.once("error", onError);
            socket.connect(targetPort, targetHost, (connectErr?: any) => {
              if (settled) return;
              socket.off("error", onError);

              let isConnected = false;
              try {
                socket.remoteAddress();
                isConnected = true;
              } catch {
                isConnected = false;
              }

              if (connectErr || !isConnected) {
                settled = true;
                try { socket.close(); } catch {}
                reject(
                  connectErr ||
                    new Error(
                      `Failed to connect UDP socket to ${targetHost}:${targetPort} (unresolvable hostname or network error)`
                    )
                );
                return;
              }
              try {
                h.start(socket);
                settled = true;
                resolve();
              } catch (err) {
                settled = true;
                try { socket.close(); } catch {}
                reject(err);
              }
            });
          });
        };
      }

      if (typeof h.onPacket === "function" && !h._safeOnPacketPatched) {
        h._safeOnPacketPatched = true;
        const origOnPacket = h.onPacket.bind(h);
        h.onPacket = (pkt: any) => {
          try {
            const type = pkt.typeFlagged & 15;
            if ((type === 2 || type === 3) && pkt.data && pkt.data.length > 0) {
              const text = Buffer.from(pkt.data).toString("utf8");
              const lines = text.split(/[\n\0]/);
              for (const line of lines) {
                const clean = line.replace(/\r$/, "");
                if (clean) {
                  this.handleRawNotification(clean);
                }
              }
            }
          } catch {
            // ignore parsing error
          }
          return origOnPacket(pkt);
        };
      }
    };

    let currentHandler = (this.client as any).handler;
    patchHandler(currentHandler);
    Object.defineProperty(this.client, "handler", {
      get: () => currentHandler,
      set: (newHandler) => {
        currentHandler = newHandler;
        patchHandler(newHandler);
      },
      configurable: true,
      enumerable: true,
    });

    this.client.on("textMessage", (msg: TextMessage) => {
      if (msg.invokerID === this.clientId) return;
      if (msg.targetMode === 2) {
        const myCid = this.getChannelId();
        const existing = this.visibleClients.get(msg.invokerID) ?? {
          id: msg.invokerID,
          nickname: msg.invokerName,
          uid: msg.invokerUID,
          serverGroups: msg.invokerGroups ?? [],
          channelID: myCid,
          type: 0,
        };
        if (myCid !== 0n) existing.channelID = myCid;
        this.visibleClients.set(msg.invokerID, existing);
      }
      if (this.client) {
        getClientInfo(this.client, msg.invokerID)
          .then((info) => {
            if (info && (info.cid || (info as any).client_channel_id)) {
              const cid = BigInt(info.cid || (info as any).client_channel_id);
              const existing = this.visibleClients.get(msg.invokerID) ?? {
                id: msg.invokerID,
                nickname: msg.invokerName,
                uid: msg.invokerUID,
                serverGroups: msg.invokerGroups ?? [],
                channelID: cid,
                type: 0,
              };
              existing.channelID = cid;
              this.visibleClients.set(msg.invokerID, existing);
            }
          })
          .catch(() => {});
      }
      this.emit("textMessage", toTS3TextMessage(msg));
    });

    this.client.on("voiceData", (voice: VoiceData) => {
      // The library normally suppresses our own packets; retain the explicit
      // guard so a future protocol change cannot make a bot duck itself.
      if (voice.clientId === this.clientId) return;
      const myCid = this.getChannelId();
      const existing = this.visibleClients.get(voice.clientId);
      if (existing && myCid !== 0n) {
        existing.channelID = myCid;
      }
      const clientUid = this.visibleClientUids.get(voice.clientId);
      const activity: TS3VoiceActivity = {
        clientId: voice.clientId,
        codec: voice.codec,
        ...(clientUid ? { clientUid } : {}),
      };
      this.emit("voiceActivity", activity);
    });

    this.client.on("disconnected", (err) => {
      this.logger.warn({ err: err?.message }, "Connection closed");
      this.clientId = 0;
      this.clearVisibleClientUids();
      this.visibleClients.clear();
      this.emit("disconnected");
    });

    this.client.on("clientEnter", (info: ClientInfo) => {
      const existing = this.visibleClients.get(info.id);
      const channelID = (info.channelID && info.channelID !== 0n)
        ? BigInt(info.channelID)
        : (existing?.channelID ?? 0n);

      this.visibleClients.set(info.id, {
        ...info,
        channelID,
      });
      this.rememberVisibleClientUid(info.id, info.uid);
      this.logger.debug(
        { nickname: info.nickname, id: info.id, channelID: channelID.toString() },
        "Client entered"
      );
      this.emit("clientEnter", { ...info, channelID });
    });

    this.client.on("clientLeave", (ev: ClientLeftViewEvent) => {
      this.visibleClients.delete(ev.id);
      this.releaseVisibleClientUid(ev.id);
      this.logger.debug({ id: ev.id }, "Client left");
      this.emit("clientLeave", ev);
    });

    this.client.on("clientMoved", (ev: ClientMovedEvent) => {
      const targetCid = BigInt(ev.targetChannelID);
      const existing = this.visibleClients.get(ev.id);
      if (existing) {
        existing.channelID = targetCid;
      } else {
        this.visibleClients.set(ev.id, {
          id: ev.id,
          nickname: ev.invokerName ?? "",
          uid: ev.invokerUID ?? "",
          serverGroups: [],
          channelID: targetCid,
          type: 0,
        });
      }
      if (ev.id === this.clientId) {
        this.currentChannelId = targetCid;
      }
      this.logger.debug(
        { id: ev.id, targetChannelID: targetCid.toString() },
        "Client moved"
      );
      this.emit("clientMoved", ev);
    });

    await this.client.connect();
    // Note: @honeybbq/teamspeak-client 0.2.x ships a universal clientinit
    // (client_version "3.?.? [Build: 5680278000]" + matching signature)
    // that works against both TS3 and TS6 servers. The old 3.6.2 monkey-
    // patch on handler.sendPacket was removed when we bumped to 0.2.1 — it
    // would have replaced the library's new correct version with a stale
    // signature and made TS6 handshakes fail.
    await this.client.waitConnected();
    this.clientId = this.client.clientID();
    this.voiceFramesSent = 0;
    this.disconnecting = false;
    this.logger.info(
      { clientId: this.clientId, protocol: this.detectedProtocol },
      `Logged in (visible client, ${this.detectedProtocol.toUpperCase()} server)`,
    );

    try {
      const info = await getClientInfo(this.client, this.clientId);
      if (info && (info.cid || (info as any).client_channel_id)) {
        const rawCid = info.cid || (info as any).client_channel_id;
        this.currentChannelId = BigInt(rawCid);
        this.logger.info({ currentChannelId: this.currentChannelId.toString() }, "Resolved bot channel ID via clientinfo");
      }
    } catch (err) {
      this.logger.warn({ err }, "Could not resolve initial bot channel ID via clientinfo");
    }

    try {
      await this.sendCommandNoWait("channelsubscribeall");
    } catch {
      // Ignore if channelsubscribeall is not permitted
    }

    // Join channel by numeric ID (takes precedence) or by name
    if (this.options.channelId) {
      await this.joinChannel(this.options.channelId, this.options.channelPassword);
    } else if (this.options.defaultChannel) {
      await this.joinChannel(
        this.options.defaultChannel,
        this.options.channelPassword
      );
    }

    this.initialDefaultChannelId = this.currentChannelId;
    this.emit("connected");
  }

  isInDefaultChannel(): boolean {
    if (this.initialDefaultChannelId === 0n) return true;
    return this.currentChannelId === this.initialDefaultChannelId;
  }

  getDefaultChannelIdentifier(): string {
    return (
      this.options.channelId ||
      this.options.defaultChannel ||
      (this.initialDefaultChannelId !== 0n ? this.initialDefaultChannelId.toString() : "")
    );
  }

  async returnToDefaultChannel(): Promise<boolean> {
    if (!this.client) return false;
    if (this.options.channelId) {
      await this.joinChannel(this.options.channelId, this.options.channelPassword);
      return true;
    }
    if (this.options.defaultChannel) {
      await this.joinChannel(this.options.defaultChannel, this.options.channelPassword);
      return true;
    }
    if (this.initialDefaultChannelId !== 0n) {
      await this.joinChannel(this.initialDefaultChannelId.toString(), this.options.channelPassword);
      return true;
    }
    return false;
  }

  async joinChannel(channelName: string, password?: string): Promise<void> {
    if (!this.client) return;

    const isNumeric = /^\d+$/.test(channelName);
    if (isNumeric) {
      const targetCid = BigInt(channelName);
      if (this.currentChannelId === targetCid) {
        return;
      }
      try {
        await clientMove(this.client, this.clientId, targetCid, password);
        this.currentChannelId = targetCid;
        try {
          await this.sendCommandNoWait(`channelsubscribe cid=${channelName}`);
        } catch {}
        this.logger.info({ channelName }, "Joined channel");
      } catch (err: any) {
        if (err?.id === "770" || String(err?.message || "").includes("already member of channel")) {
          this.currentChannelId = targetCid;
          return;
        }
        this.logger.error({ err, channelName }, "Failed to join channel");
      }
      return;
    }

    try {
      const channels = await listChannels(this.client);
      const channel = channels.find((ch) => ch.name === channelName);

      if (!channel) {
        this.logger.warn({ channelName }, "Channel not found");
        return;
      }

      if (this.currentChannelId === channel.id) {
        return;
      }

      try {
        await clientMove(this.client, this.clientId, channel.id, password);
        this.currentChannelId = channel.id;
        try {
          await this.sendCommandNoWait(`channelsubscribe cid=${channel.id}`);
        } catch {}
        this.logger.info(
          { channelName, cid: channel.id.toString() },
          "Joined channel"
        );
      } catch (err: any) {
        if (err?.id === "770" || String(err?.message || "").includes("already member of channel")) {
          this.currentChannelId = channel.id;
          return;
        }
        this.logger.error({ err, channelName }, "Failed to join channel");
      }
    } catch (err) {
      this.logger.error({ err, channelName }, "Failed to join channel");
    }
  }

  async sendTextMessage(
    message: string,
    targetMode: number = 2
  ): Promise<void> {
    if (!this.client) return;
    // targetMode 2 = channel, target 0 = current channel
    const target = targetMode === 2 ? BigInt(0) : BigInt(this.clientId);
    await sendTextMessage(this.client, targetMode, target, message);
  }

  async getClientsInChannel(): Promise<ClientInfo[]> {
    if (!this.client || this.clientId === 0) return [];

    try {
      const list = await listClients(this.client);
      if (Array.isArray(list)) {
        // Authoritative list from server: clear stale entries and synchronize
        this.visibleClients.clear();
        for (const item of list) {
          this.visibleClients.set(item.id, item);
        }

        // Dynamically resolve the bot's current channel from the authoritative client list
        const botSelf = list.find((c) => c.id === this.clientId);
        if (botSelf && botSelf.channelID && botSelf.channelID > 0n) {
          this.currentChannelId = botSelf.channelID;
        }

        const myChannelId = this.getChannelId();
        const myChannelStr = myChannelId.toString();

        return list.filter(
          (c) => c.channelID !== undefined && c.channelID.toString() === myChannelStr
        );
      }
    } catch {
      // Fall through to memory cache if listClients fails
    }

    if (this.currentChannelId === 0n) {
      try {
        const info = await getClientInfo(this.client, this.clientId);
        if (info && (info.cid || (info as any).client_channel_id)) {
          const rawCid = info.cid || (info as any).client_channel_id;
          this.currentChannelId = BigInt(rawCid);
        }
      } catch {}
    }

    const myChannelId = this.getChannelId();
    if (myChannelId === 0n) return [];
    const myChannelStr = myChannelId.toString();

    if (this.clientId > 0) {
      this.visibleClients.set(this.clientId, {
        id: this.clientId,
        nickname: this.options.nickname,
        uid: this.clientUid,
        serverGroups: [],
        channelID: myChannelId,
        type: 0,
      });
    }

    const clients: ClientInfo[] = [];
    for (const c of this.visibleClients.values()) {
      if (c.channelID !== undefined && c.channelID.toString() === myChannelStr) {
        clients.push(c);
      }
    }
    return clients;
  }

  /**
   * Resolve a client's CURRENT server groups by client id, server-wide (works
   * regardless of channel/view) via a targeted `clientinfo` query. The raw
   * `client_servergroups` field is a comma-separated list (same field
   * `listClients` parses). Returns [] if the client can't be resolved or the
   * query fails, so callers fail closed.
   */
  async getClientServerGroups(clid: number): Promise<string[]> {
    if (!this.client) return [];
    try {
      const info = await getClientInfo(this.client, clid);
      // `client_servergroups`: comma-separated server-group ids (verified in
      // @honeybbq/teamspeak-client dist/index.mjs; listClients parses the same).
      const raw = info.client_servergroups ?? "";
      return raw ? raw.split(",") : [];
    } catch {
      return [];
    }
  }

  /**
   * Resolve a client's current channel ID.
   * Checks the visible client cache first, then falls back to `clientinfo`.
   */
  async getClientChannelId(clid: number | string): Promise<bigint | null> {
    if (!this.client) return null;
    const numericId = typeof clid === "number" ? clid : parseInt(clid, 10);
    if (!Number.isFinite(numericId) || numericId <= 0) return null;
    const cached = this.visibleClients.get(numericId);
    if (cached?.channelID !== undefined && cached.channelID > 0n) {
      return cached.channelID;
    }
    try {
      const info = await getClientInfo(this.client, numericId);
      const rawCid = info?.cid ?? (info as any)?.client_channel_id;
      if (rawCid) {
        return BigInt(rawCid);
      }
    } catch {}
    return null;
  }

  // --- Raw command & file transfer pass-through ---

  async execCommand(cmd: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.execCommand(cmd);
  }

  /** Fire a command without waiting for the server's response. */
  async sendCommandNoWait(cmd: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.sendCommandNoWait(cmd);
  }

  async execCommandWithResponse(cmd: string): Promise<Record<string, string>[]> {
    if (!this.client) throw new Error("Not connected");
    return this.client.execCommandWithResponse(cmd);
  }

  async fileTransferInitUpload(
    channelID: bigint,
    path: string,
    password: string,
    size: bigint,
    overwrite = true,
  ): Promise<FileUploadInfo> {
    if (!this.client) throw new Error("Not connected");
    return this.client.fileTransferInitUpload(channelID, path, password, size, overwrite);
  }

  async uploadFileData(host: string, info: FileUploadInfo, data: Readable): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.uploadFileData(host, info, data);
  }

  async fileTransferDeleteFile(channelID: bigint, paths: string[]): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await fileTransferDeleteFile(this.client, channelID, paths);
  }

  /** The server host (needed for file transfer TCP connections). */
  getHost(): string {
    const resolved = this.voiceEndpointResolver.getEndpoint()?.host;
    if (resolved) return resolved;
    let host = (this.options.host ?? "").trim();
    if (host.startsWith("[")) {
      const closing = host.indexOf("]");
      if (closing > 0) return host.slice(1, closing);
    }
    const sep = host.lastIndexOf(":");
    if (sep > 0 && !host.includes("]")) {
      return host.slice(0, sep);
    }
    return host;
  }

  /** The current channel ID of this client. */
  getChannelId(): bigint {
    const libCid = this.client ? BigInt(this.client.channelID() ?? 0n) : 0n;
    if (libCid > 0n) {
      this.currentChannelId = libCid;
      return libCid;
    }
    return this.currentChannelId;
  }

  private voiceFramesSent = 0;
  private voiceSendErrors = 0;

  sendVoiceData(opusFrame: Buffer): void {
    if (!this.client || this.disconnecting) return;
    try {
      this.client.sendVoice(opusFrame, 5);
      this.voiceFramesSent++;
      if (this.voiceFramesSent === 1) {
        this.logger.info({ opusBytes: opusFrame.length, clientId: this.clientId }, "First voice packet sent to TeamSpeak");
      }
    } catch (err) {
      this.voiceSendErrors++;
      // Only the FIRST failure and the first failure of each subsequent
      // power-of-two batch are logged. Previously everything after frame 1 was
      // swallowed, so a bot that had gone silent while its status still read
      // "playing" produced no evidence at all; logging every frame would emit
      // ~50 lines/second from a broken transport.
      if (this.voiceFramesSent === 0 || (this.voiceSendErrors & (this.voiceSendErrors - 1)) === 0) {
        this.logger.error(
          { err, consecutiveErrors: this.voiceSendErrors, framesSent: this.voiceFramesSent },
          "Failed to send voice packet to TeamSpeak",
        );
      }
    }
  }

  getIdentityExport(): string {
    return this.identity.toString();
  }

  getClientId(): number {
    return this.clientId;
  }

  /** Actual endpoint selected by the SDK's SRV/TSDNS discovery and DNS lookup. */
  getResolvedVoiceEndpoint(): ResolvedVoiceEndpoint | null {
    return this.voiceEndpointResolver.getEndpoint();
  }

  /** Stable identity of this managed TeamSpeak client. */
  getClientUid(): string {
    return this.clientUid;
  }

  private rememberVisibleClientUid(clientId: number, clientUid: string): void {
    const pendingRelease = this.visibleClientUidReleaseTimers.get(clientId);
    if (pendingRelease) clearTimeout(pendingRelease);
    this.visibleClientUidReleaseTimers.delete(clientId);

    if (clientId > 0 && clientUid) {
      this.visibleClientUids.set(clientId, clientUid);
    } else {
      this.visibleClientUids.delete(clientId);
    }
  }

  private releaseVisibleClientUid(clientId: number): void {
    const clientUid = this.visibleClientUids.get(clientId);
    if (!clientUid) return;

    const previous = this.visibleClientUidReleaseTimers.get(clientId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (this.visibleClientUids.get(clientId) === clientUid) {
        this.visibleClientUids.delete(clientId);
      }
      this.visibleClientUidReleaseTimers.delete(clientId);
    }, VISIBLE_CLIENT_UID_RELEASE_GRACE_MS);
    timer.unref?.();
    this.visibleClientUidReleaseTimers.set(clientId, timer);
  }

  private clearVisibleClientUids(): void {
    for (const timer of this.visibleClientUidReleaseTimers.values()) {
      clearTimeout(timer);
    }
    this.visibleClientUidReleaseTimers.clear();
    this.visibleClientUids.clear();
  }

  private handleRawNotification(rawLine: string): void {
    const spaceIdx = rawLine.indexOf(" ");
    if (spaceIdx < 0) return;
    const cmdName = rawLine.substring(0, spaceIdx);
    if (!cmdName.startsWith("notify")) return;

    const rest = rawLine.substring(spaceIdx + 1);
    const items = rest.split("|");

    for (const item of items) {
      const params: Record<string, string> = {};
      const parts = item.trim().split(/\s+/);
      for (const part of parts) {
        const eqIdx = part.indexOf("=");
        if (eqIdx !== -1) {
          const k = part.substring(0, eqIdx);
          const rawV = part.substring(eqIdx + 1);
          params[k] = rawV
            .replace(/\\s/g, " ")
            .replace(/\\p/g, "|")
            .replace(/\\\//g, "/")
            .replace(/\\\\/g, "\\");
        }
      }
      this.applyNotificationItem(cmdName, params);
    }
  }

  private applyNotificationItem(cmdName: string, params: Record<string, string>): void {
    if (cmdName === "notifycliententerview") {
      const clid = parseInt(params.clid ?? "0", 10);
      const targetCidStr = params.ctid ?? params.cid ?? "";
      const targetCid = targetCidStr ? BigInt(targetCidStr) : 0n;
      const clientType = parseInt(params.client_type ?? "0", 10);
      if (clid > 0) {
        const nickname = params.client_nickname ?? "";
        const uid = params.client_unique_identifier ?? "";
        const serverGroups = params.client_servergroups ? params.client_servergroups.split(",") : [];
        const existing = this.visibleClients.get(clid) ?? {
          id: clid,
          nickname,
          uid,
          serverGroups,
          channelID: targetCid,
          type: clientType,
        };
        if (nickname) existing.nickname = nickname;
        if (uid) existing.uid = uid;
        if (targetCid !== 0n) existing.channelID = targetCid;
        existing.type = clientType;
        if (uid) this.rememberVisibleClientUid(clid, uid);
        this.visibleClients.set(clid, existing);
      }
    } else if (cmdName === "notifyclientmoved") {
      const clid = parseInt(params.clid ?? "0", 10);
      const targetCidStr = params.ctid ?? "";
      const targetCid = targetCidStr ? BigInt(targetCidStr) : 0n;
      if (clid > 0) {
        const existing = this.visibleClients.get(clid) ?? {
          id: clid,
          nickname: "",
          uid: "",
          serverGroups: [],
          channelID: targetCid,
          type: 0,
        };
        if (targetCid !== 0n) existing.channelID = targetCid;
        if (clid === this.clientId && targetCid !== 0n) {
          this.currentChannelId = targetCid;
        }
        this.visibleClients.set(clid, existing);
      }
    } else if (cmdName === "notifyclientleftview") {
      const clid = parseInt(params.clid ?? "0", 10);
      if (clid > 0) {
        this.visibleClients.delete(clid);
        this.releaseVisibleClientUid(clid);
      }
    }
  }

  disconnect(): void {
    if (this.client && !this.disconnecting) {
      this.disconnecting = true;
      const client = this.client;
      client.disconnect().catch(() => {}).finally(() => {
        if (this.client === client) {
          this.client = null;
        }
        this.disconnecting = false;
      });
    }
    this.clientId = 0;
    this.clearVisibleClientUids();
    this.visibleClients.clear();
    this.httpQuery = null;
    this.detectedProtocol = "unknown";
    if (this.udpErrorTimer) {
      clearTimeout(this.udpErrorTimer);
      this.udpErrorTimer = null;
    }
    this.logger.info("Disconnected from TeamSpeak server");
  }
}
