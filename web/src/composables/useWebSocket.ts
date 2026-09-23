import { ref, onUnmounted } from 'vue';
import { usePlayerStore } from '../stores/player.js';
import { devLog, devWarn } from '../utils/log.js';

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;
/**
 * Close codes that mean "do not retry". The server rejects a bad/expired session
 * during the upgrade handshake, which the browser surfaces as a close — retrying
 * every 3s from a logged-out tab hammered the server's session lookup forever.
 */
const NO_RETRY_CODES = new Set([1008, 4001, 4401, 4403]);
/** Handshake failures in a row before we stop retrying and re-check the session. */
const MAX_FAILED_HANDSHAKES = 4;

export function useWebSocket() {
  const connected = ref(false);
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let consecutiveFailedHandshakes = 0;
  // Set by disconnect(). Without it, closing the socket fires onclose, whose
  // handler re-arms the reconnect — so a deliberate teardown (route change /
  // unmount) silently resurrected the connection and leaked a socket + timer.
  let disposed = false;

  function connect() {
    if (disposed) return;
    // Never leave a previous socket open: a second connect() (e.g. a manual
    // retry) used to overwrite `ws` while the old one stayed subscribed.
    if (ws && ws.readyState !== WebSocket.CLOSED) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;

    // Whether THIS attempt ever reached onopen. A handshake the server rejected
    // (expired cookie, revoked session, guest mode off) closes before opening,
    // and the browser reports it as a generic close — so the code alone cannot
    // distinguish it from a transient failure. Counting opens-per-attempt does.
    let openedThisAttempt = false;
    ws = new WebSocket(url);

    ws.onopen = () => {
      connected.value = true;
      openedThisAttempt = true;
      reconnectAttempts = 0;
      consecutiveFailedHandshakes = 0;
      devLog('WebSocket connected');
    };

    ws.onmessage = (event) => {
      // A malformed/unexpected frame must not abort the handler mid-switch.
      // The payload shape is server-defined and consumed field-by-field below,
      // so keep the existing untyped access the rest of the handler relies on.
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        devWarn('Ignoring non-JSON WebSocket frame');
        return;
      }
      const store = usePlayerStore();

      switch (data.type) {
        case 'init':
          for (const bot of data.bots) {
            store.updateBotStatus(bot.id, bot);
          }
          break;
        case 'stateChange':
          store.updateBotStatus(data.botId, data.status);
          if (data.queue) {
            store.setQueue(data.botId, data.queue);
          } else {
            // Queue not included in event; refresh for this specific bot
            store.fetchQueueForBot(data.botId);
          }
          break;
        case 'botConnected':
          store.updateBotStatus(data.botId, data.status);
          break;
        case 'botDisconnected':
          // Bot disconnected from TS3 but still exists — update status, don't remove
          if (data.status) {
            store.updateBotStatus(data.botId, data.status);
          } else {
            const existing = store.bots.find((b) => b.id === data.botId);
            if (existing) {
              store.updateBotStatus(data.botId, {
                ...existing,
                connected: false,
                playing: false,
                paused: false,
                currentSong: null,
              });
            }
          }
          break;
        case 'botRemoved':
          // Bot was deleted from the server — drop from local state entirely
          store.removeBotStatus(data.botId);
          if (store.activeBotId === data.botId) {
            store.activeBotId = store.bots[0]?.id ?? null;
          }
          break;
      }
    };

    ws.onclose = (event) => {
      connected.value = false;
      ws = null;
      if (disposed) return;
      // A rejected handshake (expired/revoked session, guest mode turned off) is
      // not transient: stop retrying and let the next API call's 401 handler
      // send the user to /login. Everything else backs off exponentially so a
      // server restart or a flaky network cannot turn every open tab into a
      // fixed-rate reconnect loop.
      if (NO_RETRY_CODES.has(event?.code)) {
        devWarn('WebSocket closed by policy; not reconnecting', event?.code);
        return;
      }
      // Repeated handshake rejections mean the session is no longer valid (the
      // server answers an unauthenticated upgrade with a plain HTTP error, so
      // there is no meaningful close code). Stop retrying, refresh the session,
      // and let the shared 401 handler route the user to /login instead of
      // hammering the upgrade endpoint forever from a stale tab.
      if (!openedThisAttempt) {
        consecutiveFailedHandshakes += 1;
        if (consecutiveFailedHandshakes >= MAX_FAILED_HANDSHAKES) {
          devWarn('WebSocket handshake rejected repeatedly; stopping reconnect');
          import('../composables/useSession.js')
            .then(({ useSession }) => useSession().refresh())
            .catch(() => {});
          return;
        }
      } else {
        consecutiveFailedHandshakes = 0;
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
      reconnectAttempts = Math.min(reconnectAttempts + 1, 10);
      reconnectTimer = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  function disconnect() {
    disposed = true;
    reconnectAttempts = 0;
    consecutiveFailedHandshakes = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
    ws = null;
    connected.value = false;
  }

  onUnmounted(disconnect);

  return { connected, connect, disconnect };
}
