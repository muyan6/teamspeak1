import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from '../../node_modules/pinia/dist/pinia.mjs';
import axios from '../../node_modules/axios/index.js';
import { usePlayerStore } from './player.js';
import { useWebSocket } from '../composables/useWebSocket.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('Review regression: confirmed frontend defects', () => {
  it('R14: newer queue events trigger a trailing refresh', async () => {
    setActivePinia(createPinia()); const store = usePlayerStore();
    let release!: (v: any) => void;
    const get = vi.spyOn(axios, 'get').mockImplementationOnce(() => new Promise(r => { release = r; })).mockResolvedValueOnce({ data: { queue: [{ id: 'new-song' }] } });
    const first = store.fetchQueueForBot('A'); // Server serialized its response before a later mutation.
    await store.fetchQueueForBot('A'); // Later stateChange after mutation, lost by in-flight guard.
    release({ data: { queue: [{ id: 'old-song' }] } }); await first;
    expect(get).toHaveBeenCalledTimes(2); expect(store.queues.A[0].id).toBe('new-song');
  });
  it('R12: late queue responses stay attached to the requested bot', async () => {
    setActivePinia(createPinia()); const store = usePlayerStore();
    let release!: (v: any) => void;
    vi.spyOn(axios, 'get').mockImplementation(() => new Promise(r => { release = r; }));
    store.activeBotId = 'A'; const p = store.fetchQueue(); store.activeBotId = 'B';
    release({ data: { queue: [{ id: 'A-song' }] } }); await p;
    expect(store.queues.A[0].id).toBe('A-song'); expect(store.queues.B).toBeUndefined();
  });

  it('R13: access-change close refreshes identity and reconnects', async () => {
    vi.useFakeTimers(); const sockets: any[] = [];
    class Socket {
      static CLOSED = 3; readyState = 1; onopen: any; onclose: any; onerror: any; onmessage: any;
      constructor(public url: string) { sockets.push(this); }
      close() { this.readyState = 3; }
    }
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'fixture.invalid' } });
    vi.stubGlobal('WebSocket', Socket);
    vi.stubGlobal('fetch', async (url: string) => ({ status: 200, ok: true, json: async () => url.includes('needs-setup') ? { needsSetup: false } : { id: 'u', username: 'alice', role: 'admin', bots: 'all' } }));
    const c = useWebSocket(); c.connect(); sockets[0].onopen(); sockets[0].onclose({ code: 4009 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets.length).toBe(2); sockets[1].onopen(); expect(c.connected.value).toBe(true); c.disconnect(); vi.clearAllTimers();
  });
});
