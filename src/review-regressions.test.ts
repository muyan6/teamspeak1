// Correct-behaviour regressions for every reproduced review finding.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ncm = vi.hoisted(() => ({ options: null as any, close: vi.fn((cb?: () => void) => cb?.()) }));
vi.mock('NeteaseCloudMusicApi', () => ({
  server: { serveNcmApi: async (options: any) => {
    ncm.options = options;
    return { server: { close: ncm.close } }; // Actual package returns Express app.server
  } },
}));
vi.mock('@discordjs/opus', () => ({ default: { OpusEncoder: class {
  encode(b: Buffer) { return b; } decode(b: Buffer) { return b; }
} } }));

import { BotProfileManager, isSafeCoverUrl } from './bot/profile.js';
import { BotManager } from './bot/manager.js';
import { BotInstance } from './bot/instance.js';
import { createDatabase, SHARED_QUEUE_OWNER } from './data/database.js';
import { createPermissionStore } from './data/permissions.js';
import { getDefaultConfig } from './data/config.js';
import { createMusicRouter } from './web/api/music.js';
import { createPlayerRouter } from './web/api/player.js';
import { createSavedQueuesRouter } from './web/api/saved-queues.js';
import { createSessionRouter } from './web/api/session.js';
import { createSessionStore } from './data/sessions.js';
import { createUserStore } from './data/users.js';
import { createAuditStore } from './data/audit.js';
import { JellyfinProvider } from './music/jellyfin.js';
import { LocalMusicProvider } from './music/local.js';
import { PlayQueue } from './audio/queue.js';
import { createApiServerManager } from './music/api-server.js';

const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); vi.useRealTimers(); });
const song = (id: string, platform = 'netease'): any => ({
  id, platform, name: id, artist: 'artist', album: 'album', coverUrl: '', duration: 120,
});
const dbFixture = () => {
  const db = createDatabase(':memory:'); cleanups.push(() => db.close()); return db;
};
const configFixture = () => {
  const c = getDefaultConfig();
  c.enabledProviders = ['netease', 'qq', 'bilibili', 'youtube', 'kugou', 'jellyfin'];
  c.autoSourceFallback = false; return c;
};
const providerFixture = (platform = 'netease'): any => ({
  platform, search: vi.fn(async () => ({ songs: [song(platform, platform)], albums: [], playlists: [] })),
  getSongUrl: vi.fn(async (id: string) => ({ url: `https://fixture.invalid/${id}` })),
});
function makeBot(provider = providerFixture(), db = dbFixture(), config = configFixture()): any {
  const b: any = new BotInstance({
    id: 'b', name: 'b', tsOptions: { host: '127.0.0.1', port: 9987, queryPort: 10011, nickname: 'b' },
    neteaseProvider: provider, qqProvider: provider, bilibiliProvider: provider, youtubeProvider: provider,
    database: db, config, logger, avatarStore: { read() { return null; } } as any,
  });
  b.connected = true;
  vi.spyOn(b.profileManager, 'onSongChange').mockResolvedValue(undefined);
  vi.spyOn(b.player, 'play').mockImplementation(() => {});
  b.preFetchNextTrack = () => {};
  cleanups.push(() => { b.disconnect(); b.removeAllListeners(); });
  return b;
}
const mountMusic = (config: any, ne: any, qq: any, jf?: any) => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'fixture-guest', username: 'guest', role: 'guest', bots: 'all' }; next(); });
  app.use('/api/music', createMusicRouter(ne, qq, providerFixture('bilibili'), logger, undefined, config, undefined, undefined, jf));
  return app;
};

describe('Review regression: confirmed backend defects', () => {
  it('R16: REST query text cannot override the selected source', async () => {
    const ne = providerFixture('netease'), bili = providerFixture('bilibili'); const b = makeBot(ne);
    b.bilibiliProvider = bili;
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'u', username: 'alice', role: 'admin', bots: 'all' }; next(); });
    app.use('/api/player', createPlayerRouter({ getBot: () => b } as any, logger));
    const res = await request(app).post('/api/player/b/play').send({ platform: 'netease', query: 'title -b' });
    expect(res.status).toBe(200); expect(ne.search).toHaveBeenCalledWith('title -b', 1, 0, 'song');
    expect(bili.search).not.toHaveBeenCalled(); expect(b.queue.current().platform).toBe('netease');
  });
  it.each(['add-song', 'play-next-song'])('R15: %s publishes and persists its queue mutation', async (route) => {
    vi.useFakeTimers(); const db = dbFixture(), c = configFixture(); c.savedQueuesEnabled = true;
    const b = makeBot(providerFixture(), db, c); b.queue.add(song('original')); b.queue.play();
    b.persistQueueSnapshot(); vi.spyOn(b.player, 'getState').mockReturnValue('playing');
    const stateChange = vi.fn(); b.on('stateChange', stateChange);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'u', username: 'alice', role: 'admin', bots: 'all' }; next(); });
    app.use('/api/player', createPlayerRouter({ getBot: () => b } as any, logger, db));
    const res = await request(app).post(`/api/player/b/${route}`).send({ song: song('added') });
    await vi.advanceTimersByTimeAsync(1500);
    expect(res.status).toBe(200); expect(b.queue.size()).toBe(2); expect(stateChange).toHaveBeenCalledTimes(1);
    expect(db.getQueueState('b')?.songs.length).toBe(2);
  });
  it('R01: rejects mapped loopback', () => {
    expect(isSafeCoverUrl('http://127.0.0.1/private')).toBe(false);
    expect(isSafeCoverUrl('http://[::ffff:127.0.0.1]/private')).toBe(false);
  });

  it('R01: blocks redirects from configured cover resources', async () => {
    let privateHits = 0;
    const server = createServer((req, res) => {
      if (req.url === '/Items/a/Images/Primary') {
        res.writeHead(302, { Location: `http://localhost:${(server.address() as any).port}/private` }); res.end();
      } else { privateHits++; res.end('FIXTURE_PRIVATE_IMAGE'); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as any).port;
      const profile: any = new BotProfileManager({} as any, logger, {} as any, 'b', [`http://127.0.0.1:${port}`]);
      expect(isSafeCoverUrl(`http://localhost:${port}/private`)).toBe(false);
      const body = await profile.downloadImage(`http://127.0.0.1:${port}/Items/a/Images/Primary`);
      expect(body).toBeNull(); expect(privateHits).toBe(0);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });

  it('R02: guest metadata contains only a credential-free cover resource', async () => {
    const c = configFixture(); const jf: any = new JellyfinProvider(logger);
    jf.configure({ serverUrl: 'https://jellyfin.fixture.invalid', authMode: 'apikey', apiKey: 'FIXTURE_SECRET', userId: 'u', username: '', password: '' });
    vi.spyOn(jf.api, 'request').mockResolvedValue({ data: { Items: [{ Id: 'a', Name: 'a', ImageTags: { Primary: 'tag' } }] } });
    const res = await request(mountMusic(c, providerFixture(), providerFixture('qq'), jf))
      .get('/api/music/search').query({ platform: 'jellyfin', q: 'a' });
    expect(res.status).toBe(200);
    expect(res.body.songs[0].coverUrl).toBe('/api/music/jellyfin/cover/a?tag=tag'); expect(JSON.stringify(res.body)).not.toContain('FIXTURE_SECRET');
  });

  it('R03: stale track-end cannot overtake a queued manual play', async () => {
    let release!: (v: any) => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>(r => { enteredResolve = r; });
    const p = providerFixture();
    p.getSongUrl.mockImplementation((id: string) => id === 'b' ? new Promise(r => { release = r; enteredResolve(); }) : Promise.resolve({ url: `url:${id}` }));
    const b = makeBot(p); b.queue.addMany([song('a'), song('c')]); b.queue.play();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'u', username: 'alice', role: 'admin', bots: 'all' }; next(); });
    app.use('/api/player', createPlayerRouter({ getBot: () => b } as any, logger));
    const pending = request(app).post('/api/player/b/play-now-song').send({ song: song('b') }).then(r => r);
    await entered; // Real route has changed currentIndex while URL resolution waits.
    b.player.emit('trackEnd');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(b.queue.current().id).toBe('b');
    release({ url: 'url:b' }); expect((await pending).status).toBe(200);
    expect(b.player.play.mock.calls.map((x: any) => x[0])).toEqual(['url:b']);
  });

  it('R04: stopped startup stays stopped after failure', async () => {
    vi.useFakeTimers();
    const db = dbFixture(); const c = configFixture(); const p = providerFixture();
    db.saveBotInstance({ id: 'b', name: 'b', serverAddress: '127.0.0.1', serverPort: 9987, nickname: 'b', defaultChannel: '', channelId: '', channelPassword: '', serverProtocol: '', ts6ApiKey: '', serverPassword: '', autoStart: true });
    let fail!: (e: Error) => void;
    vi.spyOn(BotInstance.prototype, 'connect').mockImplementation(() => new Promise((_r, reject) => { fail = reject; }));
    const m: any = new BotManager(p, p, p, db, c, logger, {} as any, createPermissionStore(db.db), 'unused-fixture.json');
    cleanups.push(() => m.shutdown());
    await m.loadSavedBots({ awaitConnections: false }); m.stopBot('b');
    expect(m.getBot('b').isManualDisconnect()).toBe(true);
    fail(new Error('fixture handshake failure'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(db.getBotInstances()[0].autoStart).toBe(false);
    expect(m.getBot('b').isManualDisconnect()).toBe(true);
    expect(m.getBot('b').isReconnecting()).toBe(false);
    vi.clearAllTimers();
  });

  it('R05: saved references protect local files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsmb-review-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const filePath = join(dir, 'local.mp3'); writeFileSync(filePath, Buffer.from('fixture'));
    const record = { ...song('local', 'local'), filePath, originalName: 'local.mp3', uploadedAt: '2026-01-01T00:00:00.000Z', size: 7, mimeType: 'audio/mpeg' };
    writeFileSync(join(dir, 'index.json'), JSON.stringify([record]), 'utf8');
    const db = dbFixture(); db.saveQueue('user', 'saved', [song('local', 'local')]);
    db.saveQueueState({ botId: 'b', songs: [song('local', 'local')], currentIndex: 0, mode: 'seq', isFmMode: false, fmPlatform: '' });
    const p = providerFixture(); const local = new LocalMusicProvider(dir);
    const m = new BotManager(p, p, p, db, configFixture(), logger, {} as any, createPermissionStore(db.db), 'unused', local);
    await local.getSongUrl('local'); // Previously played, no longer in a live queue.
    const deleted = local.sweepUnreferenced();
    expect(deleted).toEqual([]); expect(existsSync(filePath)).toBe(true);
    expect(db.getQueueState('b')?.songs[0].id).toBe('local');
    expect(db.listSavedQueues('user', false)[0].songCount).toBe(1);
  });

  it('R06: shared overwrite preserves creator and rejects other members', async () => {
    const db = dbFixture(); const saved = db.saveQueue(SHARED_QUEUE_OWNER, 'party', [song('original')], 'alice');
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'bob', username: 'bob', role: 'member', bots: 'all', capabilities: new Set(['player.queue']) }; next(); });
    app.use('/api/saved-queues', createSavedQueuesRouter(db, { getBot: () => ({ getQueueManager: () => ({ list: () => [song('replacement')] }) }) } as any, () => true, logger));
    expect((await request(app).delete(`/api/saved-queues/${saved.id}`)).status).toBe(403);
    expect((await request(app).post('/api/saved-queues').send({ botId: 'b', name: 'party', shared: true })).status).toBe(403);
    expect(db.getSavedQueue(saved.id)?.creatorId).toBe('alice');
    expect((await request(app).delete(`/api/saved-queues/${saved.id}`)).status).toBe(403);
  });

  it('R07: default source change invalidates cached search', async () => {
    const c = configFixture(); c.defaultPlatform = 'netease';
    const ne = providerFixture('netease'), qq = providerFixture('qq'); const app = mountMusic(c, ne, qq);
    const first = await request(app).get('/api/music/search?q=fixture');
    c.defaultPlatform = 'qq'; const second = await request(app).get('/api/music/search?q=fixture');
    expect(first.body.songs[0].platform).toBe('netease'); expect(second.body.songs[0].platform).toBe('qq');
    expect(qq.search).toHaveBeenCalledTimes(1);
  });

  it('R08: a single failed chunk no longer forces a whole-batch fallback (P2-26)', async () => {
    const { QQMusicProvider } = await import('./music/qq.js');
    const qq: any = new QQMusicProvider('http://fixture.invalid');
    vi.spyOn(qq.api, 'get').mockImplementation((_url: any, opts: any) => {
      if (opts.params.songmid === 'last') return Promise.reject(new Error('fixture transient error'));
      return Promise.resolve({ data: { data: { playUrl: { first: { url: 'url:first' } } } } });
    });
    const result = await qq.getPlayableSongIds(['first', ...Array.from({ length: 99 }, (_, i) => `m${i}`), 'last']);
    // Only "every chunk failed" yields null (which means: fall back to per-song
    // probing). A single transient failure must keep the authoritative Set.
    expect(result).toEqual(new Set(['first']));
  });

  it('R09: password change revokes old sockets while retaining current session', async () => {
    const db = dbFixture(), users = createUserStore(db.db), sessions = createSessionStore(db.db);
    const u = await users.createUser('alice', 'password-old', 'admin');
    const current = sessions.createSession(u.id), other = sessions.createSession(u.id), revoke = vi.fn();
    const app = express(); app.use(express.json());
    app.use('/api/session', createSessionRouter(users, sessions, createAuditStore(db.db), logger, createPermissionStore(db.db), () => configFixture().guestMode, revoke));
    const res = await request(app).post('/api/session/change-password').set('Cookie', `tsmb_session=${current.token}`).send({ oldPassword: 'password-old', newPassword: 'password-new' });
    expect(res.status).toBe(204); expect(sessions.validateAndTouch(other.token)).toBeNull(); expect(revoke).toHaveBeenCalledWith(u.id, current.token);
  });

  it('R10: embedded API binds loopback and closes the actual server', async () => {
    ncm.close.mockClear();
    const m = createApiServerManager({ neteasePort: 0, qqMusicPort: 0, neteaseEnabled: true, qqEnabled: false }, logger);
    await m.start(); await m.stop();
    expect(ncm.options.host).toBe('127.0.0.1'); expect(ncm.close).toHaveBeenCalledTimes(1);
  });

  it('R11: live and persisted queues share one capacity limit', () => {
    const q = new PlayQueue(); expect(() => q.addMany(Array.from({ length: 1001 }, (_, i) => song(String(i))))).toThrow(/1000/);
    expect(q.size()).toBe(0); q.addMany(Array.from({ length: 1000 }, (_, i) => song(String(i))));
    const db = dbFixture(); expect(() => q.add(song('extra'))).toThrow(/1000/);
    expect(db.saveQueue('user', 'bounded', q.list()).songCount).toBe(1000);
  });
});
