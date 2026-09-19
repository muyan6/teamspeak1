import { WebSocketServer, WebSocket } from "ws";
import type { BotManager } from "../bot/manager.js";
import type { BotInstance } from "../bot/instance.js";
import type { Logger } from "../logger.js";

export interface WebSocketController {
  cleanup: () => void;
  /**
   * Re-apply the current guest-mode policy to every already-open guest socket.
   * If guest mode is disabled, in-flight guest sockets are force-closed; otherwise
   * each guest socket is live re-scoped so out-of-scope bots stop streaming.
   */
  refreshGuestPolicy: (cfg: { enabled: boolean; bots: "all" | string[] }) => void;
  /**
   * Drop every socket belonging to `userId`.
   *
   * A member's bot scope is stamped ONCE at upgrade from their permissions, so
   * revoking access (or deleting the account, or logging out) left the existing
   * socket streaming that bot's state/queue until the client reconnected on its
   * own. The session row is already gone server-side by then, so the socket is
   * the last thing still honouring a revoked grant.
   */
  closeUserSockets: (userId: string) => void;
}

export function setupWebSocket(
  wss: WebSocketServer,
  botManager: BotManager,
  logger: Logger
): WebSocketController {
  const clients = new Set<WebSocket>();

  /**
   * Whether a given bot is visible to a WebSocket client. Clients with full
   * scope ("all" or unset) see everything; scoped clients (restricted members
   * or guests) only see bots in their allowed set.
   */
  function visibleToClient(ws: WebSocket, botId: string): boolean {
    const w = ws as unknown as { isGuest?: boolean; botScope?: "all" | Set<string> };
    if (!w.botScope || w.botScope === "all") return true;
    return w.botScope.has(botId);
  }

  

  /** Track which bot instances have listeners attached (keyed by id, storing ref) */
  const attachedBots = new Map<string, {
    bot: BotInstance;
    stateChange: () => void;
    connected: () => void;
    disconnected: () => void;
  }>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    const socket = ws as WebSocket & { isAlive?: boolean };
    socket.isAlive = true;
    ws.on("pong", () => {
      socket.isAlive = true;
    });
    logger.debug("WebSocket client connected");

    const bots = botManager
      .getAllBots()
      .filter((b) => visibleToClient(ws, b.id))
      .map((b) => b.getStatus());
    try {
      ws.send(JSON.stringify({ type: "init", bots }));
    } catch (err) {
      clients.delete(ws);
      logger.warn({ err }, "Failed to send WebSocket init payload");
      try { ws.terminate(); } catch { /* already closed */ }
      return;
    }

    ws.on("close", () => {
      clients.delete(ws);
      logger.debug("WebSocket client disconnected");
    });

    ws.on("error", (err) => {
      logger.error({ err }, "WebSocket error");
      clients.delete(ws);
    });
  });

  const heartbeatInterval = setInterval(() => {
    for (const ws of clients) {
      const socket = ws as WebSocket & { isAlive?: boolean };
      if (socket.isAlive === false) {
        clients.delete(ws);
        try { ws.terminate(); } catch {}
        continue;
      }
      socket.isAlive = false;
      try {
        ws.ping();
      } catch {
        clients.delete(ws);
      }
    }
  }, 30_000);
  if (typeof (heartbeatInterval as any).unref === "function") {
    (heartbeatInterval as any).unref();
  }

  const MAX_WS_BUFFERED_AMOUNT = 1024 * 1024; // 1 MB backpressure limit

  const broadcast = (data: object, botId?: string) => {
    const message = JSON.stringify(data);
    for (const client of clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > MAX_WS_BUFFERED_AMOUNT) {
        logger.warn("WebSocket client buffer overflow; terminating connection");
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
        clients.delete(client);
        continue;
      }
      if (botId !== undefined && !visibleToClient(client, botId)) continue;
      try {
        client.send(message);
      } catch {
        clients.delete(client);
      }
    }
  };

  function detachBotListener(id: string): void {
    const existing = attachedBots.get(id);
    if (!existing) return;
    existing.bot.removeListener("stateChange", existing.stateChange);
    existing.bot.removeListener("connected", existing.connected);
    existing.bot.removeListener("disconnected", existing.disconnected);
    attachedBots.delete(id);
  }

  function attachBotListener(bot: BotInstance): void {
    const existing = attachedBots.get(bot.id);
    if (existing) {
      if (existing.bot === bot) return; // already attached to this instance
      // Bot instance was replaced (e.g. startBot re-created it) — re-attach
      detachBotListener(bot.id);
    }

    // The queue is deliberately NOT part of this broadcast. `getQueue()` returns
    // a fresh copy of every QueuedSong (id/name/artist/album/coverUrl/duration/
    // requestedBy ≈ 300 bytes each, capped at MAX_QUEUE_SONGS = 1000), and
    // "stateChange" fires on ~9 different paths — including volume and play-mode
    // changes that do not touch the queue at all. A 500-song queue therefore
    // meant re-serialising ~150 KB and pushing it to every connected client for
    // a single volume nudge. Clients already handle the queue-less shape by
    // fetching on demand (see useWebSocket.ts's `else store.fetchQueueForBot`),
    // which also keeps the payload correct for the events that DO change it.
    const onStateChange = () => {
      broadcast({
        type: "stateChange",
        botId: bot.id,
        status: bot.getStatus(),
      }, bot.id);
    };

    const onConnected = () => {
      broadcast({
        type: "botConnected",
        botId: bot.id,
        status: bot.getStatus(),
      }, bot.id);
    };

    const onDisconnected = () => {
      broadcast({
        type: "botDisconnected",
        botId: bot.id,
        status: bot.getStatus(),
      }, bot.id);
    };

    bot.on("stateChange", onStateChange);
    bot.on("connected", onConnected);
    bot.on("disconnected", onDisconnected);

    attachedBots.set(bot.id, {
      bot,
      stateChange: onStateChange,
      connected: onConnected,
      disconnected: onDisconnected,
    });
  }

  /** Attach listeners for any new bots that don't have them yet */
  function ensureAllBotsAttached(): void {
    for (const bot of botManager.getAllBots()) {
      attachBotListener(bot);
    }
  }

  // React immediately when a bot instance is created or replaced
  const onBotInstance = (bot: BotInstance) => attachBotListener(bot);
  botManager.on("botInstance", onBotInstance);

  // React when a bot is removed: detach its listener and tell clients to drop it
  const onBotInstanceRemoved = (id: string) => {
    detachBotListener(id);
    broadcast({ type: "botRemoved", botId: id }, id);
  };
  botManager.on("botInstanceRemoved", onBotInstanceRemoved);

  // BotManager emits botInstance/botInstanceRemoved for every lifecycle change,
  // so listener attachment is event-driven instead of scanning all bots forever.
  ensureAllBotsAttached();

  const cleanup = () => {
    clearInterval(heartbeatInterval);
    botManager.removeListener("botInstance", onBotInstance);
    botManager.removeListener("botInstanceRemoved", onBotInstanceRemoved);
    // Clean up all attached listeners (detach from stored bot refs, not live map)
    for (const id of Array.from(attachedBots.keys())) {
      detachBotListener(id);
    }
  };

  // When the admin changes guestMode (disable / narrow scope), already-open guest
  // sockets must stop streaming immediately — their isGuest/botScope were stamped
  // once at upgrade and would otherwise keep receiving bot state.
  const refreshGuestPolicy = (cfg: { enabled: boolean; bots: "all" | string[] }) => {
    for (const ws of clients) {
      const w = ws as unknown as { isGuest?: boolean; botScope?: "all" | Set<string> };
      if (!w.isGuest) continue;
      if (!cfg.enabled) {
        try {
          ws.close(1008, "guest mode disabled");
        } catch {
          // socket may already be closing; ignore
        }
      } else {
        w.botScope = cfg.bots === "all" ? "all" : new Set(cfg.bots);
      }
    }
  };

  /** Close every open socket whose upgrade was authenticated as `userId`. */
  const closeUserSockets = (userId: string) => {
    for (const ws of clients) {
      const w = ws as unknown as { userId?: string };
      if (w.userId !== userId) continue;
      try {
        ws.close(1008, "session revoked");
      } catch {
        // socket may already be closing; ignore
      }
      clients.delete(ws);
    }
  };

  return { cleanup, refreshGuestPolicy, closeUserSockets };
}
