// Expected-correct regressions for the September review.
import { afterEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from '../../node_modules/pinia/dist/pinia.mjs';
import axios from '../../node_modules/axios/index.js';
import { usePlayerStore } from './player.js';
import { useWebSocket } from '../composables/useWebSocket.js';
import { useSession } from '../composables/useSession.js';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('F01: four temporary failed handshakes resume reconnect while the session remains valid', async () => {
  vi.useFakeTimers(); const sockets: any[] = [];
  class Socket {
    static CLOSED = 3; readyState = 1; onopen: any; onclose: any; onerror: any; onmessage: any;
    constructor(public url: string) { sockets.push(this); }
    close() { this.readyState = 3; }
  }
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'fixture.invalid' } });
  vi.stubGlobal('WebSocket', Socket);
  const fetch = vi.fn(async (url: string) => ({ status: 200, ok: true,
    json: async () => url.includes('needs-setup') ? { needsSetup: false } : { id: 'u', username: 'alice', role: 'admin', bots: 'all' } }));
  vi.stubGlobal('fetch', fetch);
  await useSession().refresh(); // Already-authenticated app: rechecking the same user does not trigger App's id watcher.
  const c = useWebSocket(); c.connect();
  for (const delay of [3000, 6000, 12000]) {
    sockets.at(-1).onclose({ code: 1006 }); await vi.advanceTimersByTimeAsync(delay);
  }
  sockets.at(-1).onclose({ code: 1006 }); await vi.advanceTimersByTimeAsync(300000);
  expect(fetch).toHaveBeenCalled(); expect(sockets.length).toBe(5); sockets[4].onopen(); expect(c.connected.value).toBe(true);
  c.disconnect();
});

it('F02: delayed play on A does not advance newly-selected idle bot B', async () => {
  vi.useFakeTimers(); setActivePinia(createPinia()); const store = usePlayerStore();
  let release!: (v: any) => void;
  vi.spyOn(axios, 'post').mockImplementation(() => new Promise(r => { release = r; }));
  const song = { id: 's', platform: 'netease', name: 's', artist: '', album: '', duration: 120, coverUrl: '' } as any;
  store.bots = ['A', 'B'].map(id => ({ id, name: id, connected: true, playing: false, paused: false, currentSong: song, queueSize: 1, volume: 75, playMode: 'seq' }));
  store.activeBotId = 'A'; const pending = store.playSong(song);
  store.activeBotId = 'B'; release({ data: { ok: true } }); await pending;
  expect(store.timings.B?.wasPlaying ?? false).toBe(false); expect(store.activeBot?.playing).toBe(false);
  await vi.advanceTimersByTimeAsync(10000);
  expect(store.liveElapsed()).toBe(0);
});

it('F03: switching active bot mid-genre action keeps the atomic collection on the original bot', async () => {
  vi.useFakeTimers(); setActivePinia(createPinia()); const store = usePlayerStore();
  const songs = [1, 2, 3].map(id => ({ id: String(id), name: String(id), platform: 'jellyfin' }));
  vi.spyOn(axios, 'get').mockResolvedValue({ data: { songs } });
  let release!: (v: any) => void, entered!: () => void;
  const firstPost = new Promise<void>(r => { entered = r; });
  const post = vi.spyOn(axios, 'post').mockImplementationOnce(() => { entered(); return new Promise(r => { release = r; }); })
    .mockResolvedValue({ data: {} });
  vi.spyOn(store, 'fetchQueue').mockResolvedValue(undefined);
  store.activeBotId = 'A'; const pending = store.playJellyfinGenre('genre');
  await firstPost; store.activeBotId = 'B'; release({ data: { ok: true } }); await pending;
  expect(post.mock.calls.map(c => c[0])).toEqual(['/api/player/A/play-songs']);
});
