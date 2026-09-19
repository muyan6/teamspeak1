import { ref, onUnmounted } from 'vue';
import { usePlayerStore } from '../stores/player.js';
import { devLog, devWarn } from '../utils/log.js';

export function useWebSocket() {
  const connected = ref(false);
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Set by disconnect(). Without it, closing the socket fires onclose, whose
  // handler re-arms the 3s reconnect — so a deliberate teardown (route change /
  // unmount) silently resurrected the connection and leaked a socket + timer.
  let disposed = false;

  function connect() {
    if (disposed) return;
    // Never leave a previous socket open: a second connect() (e.g. a manual
    // retry) used to overwrite `ws` while the old one stayed subscribed.
    if (ws && ws.readyState !== WebSocket.CLOSED) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      connected.value = true;
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

    ws.onclose = () => {
      connected.value = false;
      ws = null;
      if (disposed) return;
      // Reconnect after 3 seconds
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  function disconnect() {
    disposed = true;
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
