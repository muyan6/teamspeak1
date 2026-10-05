// Correct-behavior regressions for the 2026-09-30 review.
import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { BotInstance } from './bot/instance.js';
import { BotManager } from './bot/manager.js';
import { createPermissionStore } from './data/permissions.js';
import { createDatabase, SHARED_QUEUE_OWNER } from './data/database.js';
import { getDefaultConfig } from './data/config.js';
import { parseCommand, canRunCommand } from './bot/commands.js';
import { createPlayerRouter } from './web/api/player.js';
import { createMusicRouter } from './web/api/music.js';
import { createAuthRouter } from './web/api/auth.js';
import { NeteaseProvider } from './music/netease.js';
import { SpotifyOAuth } from './music/spotify/spotify-oauth.js';
import { LocalMusicProvider } from './music/local.js';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

vi.mock('@discordjs/opus', () => ({ default: { OpusEncoder: class {
  encode(b: Buffer) { return b; } decode(b: Buffer) { return b; }
} } }));
const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); vi.restoreAllMocks(); });
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const song = (id: string): any => ({ id, platform: 'netease', name: id, artist: 'artist', album: '', coverUrl: '', duration: 120 });
function fixture() {
  const db = createDatabase(':memory:'); cleanups.push(() => db.close());
  const config = getDefaultConfig(); config.autoSourceFallback = false;
  const provider: any = {
    platform: 'netease', getSongUrl: vi.fn(async (id: string) => ({ url: `fixture:${id}` })),
    getPersonalFm: vi.fn(async () => [song('fm')]),
    getPlaylistSongs: vi.fn(async () => [song('collection')]),
    getAlbumSongs: vi.fn(async () => [song('collection')]),
  };
  const b: any = new BotInstance({
    id: 'b', name: 'b', tsOptions: { host: '127.0.0.1', port: 9987, queryPort: 10011, nickname: 'b' },
    neteaseProvider: provider, qqProvider: provider, bilibiliProvider: provider, youtubeProvider: provider,
    database: db, config, logger, avatarStore: { read() { return null; } } as any,
  });
  b.connected = true;
  vi.spyOn(b.profileManager, 'onSongChange').mockResolvedValue(undefined);
  vi.spyOn(b.player, 'play').mockImplementation((...args: unknown[]) => { b.player.state = 'playing'; b.player.currentUrl = args[0]; return true; });
  b.preFetchNextTrack = () => {};
  cleanups.push(() => { b.disconnect(); b.removeAllListeners(); });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'u', username: 'alice', role: 'admin', bots: 'all' }; next(); });
  app.use('/api/player', createPlayerRouter({ getBot: () => b } as any, logger, db));
  return { b, db, config, provider, app };
}

it('B01: pending REST FM stays stopped after cancellation', async () => {
  const { b, provider, app } = fixture();
  const fm = deferred(), entered = deferred();
  provider.getPersonalFm.mockImplementation(() => { entered.resolve(null); return fm.promise; });
  const pending = request(app).post('/api/player/b/fm').send({ platform: 'netease' }).then(r => r);
  await entered.promise;
  expect((await request(app).post('/api/player/b/stop').send({})).status).toBe(200);
  expect(b.queue.size()).toBe(0);
  fm.resolve([song('late-fm')]);
  expect((await pending).body.ok).toBe(false);
  expect(b.queue.current()).toBeNull();
  expect(b.player.getState()).toBe('idle');
});

it('B02: vote awaits advance and preserves the subsequent manual song', async () => {
  const { b, provider } = fixture(); const resolveB = deferred(), entered = deferred();
  provider.getSongUrl.mockImplementation((id: string) => {
    if (id === 'b') { entered.resolve(null); return resolveB.promise; }
    return Promise.resolve({ url: `fixture:${id}` });
  });
  b.config.playKeepsQueue = true;
  b.queue.addMany([song('a'), song('b'), song('d')]); b.queue.play();
  vi.spyOn(b.tsClient, 'getClientsInChannel').mockResolvedValue([]);
  const advancement = vi.spyOn(b, 'playNext');
  const vote = b.executeCommand(parseCommand('!vote', '!'), { invokerUid: 'voter', invokerName: 'voter' });
  await entered.promise;
  const manual = b.runExclusive(() => b.playSingleSong(song('c')));
  resolveB.resolve({ url: 'fixture:b' });
  expect(await vote).toContain('Vote passed');
  await manual;
  expect(b.queue.current().id).toBe('c'); expect(b.player.currentUrl).toBe('fixture:c');
});

it.each(['play-playlist', 'play-album'])('B03: %s exits FM and keeps only collection songs', async route => {
  const { b, provider, app } = fixture();
  b.isFmMode = true; b.fmProvider = provider;
  const body = route === 'play-album' ? { albumId: '1' } : { playlistId: '1' };
  const res = await request(app).post(`/api/player/b/${route}`).send({ ...body, platform: 'netease' });
  expect(res.body.ok).toBe(true); expect(b.isFmMode).toBe(false);
  await b.playNext();
  expect(b.queue.list().map((s: any) => s.id)).toEqual(['collection']);
  expect(b.player.getState()).toBe('idle');
});

it('B04: failed play-now silences old audio and reports idle', async () => {
  const { b, provider, app } = fixture();
  b.queue.add(song('a')); b.queue.play(); await b.resolveAndPlay(b.queue.current());
  provider.getSongUrl.mockResolvedValue(null);
  const res = await request(app).post('/api/player/b/play-now-song').send({ song: song('b') });
  expect(res.body.ok).toBe(false); expect(b.queue.current().id).toBe('b');
  expect(b.player.getState()).toBe('idle'); expect(b.player.currentUrl).toBe('');
});

it('B05: ordinary member cannot confirm QR or replace shared credentials', async () => {
  const provider: any = new NeteaseProvider('http://fixture.invalid');
  provider.setCookie('OLD_FIXTURE_COOKIE');
  vi.spyOn(provider.api, 'get').mockResolvedValue({ data: { code: 803, cookie: 'NEW_FIXTURE_COOKIE' } });
  const save = vi.fn(); const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'member', username: 'member', role: 'member', bots: new Set(), capabilities: new Set() }; next(); });
  app.use('/api/auth', createAuthRouter(provider, provider, provider, logger, { save } as any));
  expect((await request(app).post('/api/auth/cookie').send({ platform: 'netease', cookie: 'x' })).status).toBe(403);
  const res = await request(app).post('/api/auth/qrcode/status').send({ key: 'fixture-confirmed-key', platform: 'netease' });
  expect(res.status).toBe(403); expect(provider.getCookie()).toBe('OLD_FIXTURE_COOKIE');
  expect(save).not.toHaveBeenCalled();
});

it('B06: old in-flight search stays outside the new credential namespace', async () => {
  let cookie = 'old'; const oldSearch = deferred(), entered = deferred();
  const provider: any = { platform: 'netease', getCookie: () => cookie,
    search: vi.fn((q: string) => {
      if (q === 'target' && cookie === 'old') { entered.resolve(null); return oldSearch.promise; }
      return Promise.resolve({ songs: [song('new-account')], albums: [], playlists: [] });
    }) };
  const app = express(); app.use('/api/music', createMusicRouter(provider, provider, provider, logger, undefined, getDefaultConfig()));
  const pending = request(app).get('/api/music/search?q=target').then(r => r); await entered.promise;
  cookie = 'new'; await request(app).get('/api/music/search?q=other'); // clears prior cache, starts new context
  oldSearch.resolve({ songs: [song('old-account')], albums: [], playlists: [] }); await pending;
  const result = await request(app).get('/api/music/search?q=target');
  expect(result.body.songs[0].id).toBe('new-account'); expect(provider.search).toHaveBeenCalledTimes(3);
});

it('B07: in-flight OAuth refresh is discarded after configure', async () => {
  const pending = deferred(); let tokens: any = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 0, scope: '' };
  const oauth = new SpotifyOAuth({ clientId: 'old-client', redirectUri: 'http://fixture.invalid/callback',
    store: { load: () => tokens, save: t => { tokens = t; }, clear: () => { tokens = null; } },
    deps: { http: { post: () => pending.promise } as any } });
  const first = oauth.getAccessToken(); oauth.configure('new-client', 'http://fixture.invalid/callback');
  expect(oauth.isAuthorized()).toBe(false);
  pending.resolve({ data: { access_token: 'old-app-response', refresh_token: 'old-app-refresh', expires_in: 3600 } });
  await first;
  expect(oauth.getClientId()).toBe('new-client'); expect(oauth.isAuthorized()).toBe(false);
  expect(await oauth.getAccessToken()).toBeNull();
});

it('B08: public TS save preserves existing shared queues', async () => {
  const { b, db, config } = fixture(); config.savedQueuesEnabled = true; config.adminGroups = [6];
  const saved = db.saveQueue(SHARED_QUEUE_OWNER, 'party', [song('original')], 'alice');
  b.queue.add(song('replacement'));
  expect(canRunCommand('save', [], [6])).toBe(true);
  const result = await b.executeCommand(parseCommand('!save party', '!'), { invokerUid: 'outsider', invokerName: 'outsider' });
  expect(result).toContain('已存在');
  expect(db.getSavedQueue(saved.id)?.creatorId).toBe('alice');
  expect(db.getSavedQueue(saved.id)?.songs[0].id).toBe('original');
});

it('B09: SMS login exchanges the captcha for actual credentials', async () => {
  const require = createRequire(import.meta.url);
  const verifyModule = require('NeteaseCloudMusicApi/module/login_cellphone.js');
  let upstreamPath = '';
  const upstream = await verifyModule({ phone: 'FIXTURE_PHONE', captcha: 'FIXTURE_CODE' }, async (path: string) => {
    upstreamPath = path; return { body: { code: 200 }, cookie: ['FIXTURE_LOGIN_COOKIE'] };
  });
  const ne: any = new NeteaseProvider('http://fixture.invalid');
  vi.spyOn(ne.api, 'get').mockResolvedValue({ data: upstream.body });
  expect(await ne.loginWithSms('FIXTURE_PHONE', 'FIXTURE_CODE')).toBe(true);
  expect(upstreamPath).toBe('/api/w/login/cellphone');
  expect(ne.api.get).toHaveBeenCalledWith('/login/cellphone', expect.anything());
  expect(ne.getCookie()).toBe('FIXTURE_LOGIN_COOKIE');
});

it('B10: referenced uploads cause an over-quota new upload to be rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsmb-review-quota-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const p = new LocalMusicProvider(dir, { maxFiles: 1, maxTotalBytes: 250 });
  const inUse = new Set<string>(); p.setInUseResolver(() => inUse);
  const wav = Buffer.alloc(204);
  wav.write('RIFF', 0); wav.writeUInt32LE(196, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(160, 40);
  const first = await p.uploadAudio({ buffer: wav, originalName: 'first.wav' }); inUse.add(first.id);
  await expect(p.uploadAudio({ buffer: wav, originalName: 'second.wav' })).rejects.toMatchObject({ status: 507 });
  const files = readdirSync(dir).filter(f => f.endsWith('.wav'));
  expect(files.length).toBe(1); expect(files.reduce((n, f) => n + statSync(join(dir, f)).size, 0)).toBe(204);
});

it('B11: unexpected disconnect preserves local file in reconnect snapshot', async () => {
  const { b, db, config, provider } = fixture();
  expect(config.savedQueuesEnabled).toBe(false);
  const dir = mkdtempSync(join(tmpdir(), 'tsmb-review-reconnect-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'fixture.mp3'); writeFileSync(filePath, 'fixture audio');
  const record = { ...song('local'), platform: 'local', filePath, originalName: 'fixture.mp3',
    uploadedAt: new Date().toISOString(), size: 13, mimeType: 'audio/mpeg' };
  writeFileSync(join(dir, 'index.json'), JSON.stringify([record]));
  const local = new LocalMusicProvider(dir);
  const manager: any = new BotManager(provider, provider, provider, db, config, logger, {} as any,
    createPermissionStore(db.db), 'unused', local);
  manager.bots.set('b', b); b.localProvider = local;
  b.queue.add({ ...song('local'), platform: 'local' }); b.queue.play();
  await b.resolveAndPlay(b.queue.current());
  expect(existsSync(filePath)).toBe(true);
  b.tsClient.emit('disconnected');
  b.tsClient.emit('disconnected'); // duplicate transport notification must retain the first snapshot
  expect(b.reconnectSnapshot.songs[0].id).toBe('local');
  expect(existsSync(filePath)).toBe(true); expect(await local.getSongUrl('local')).not.toBeNull();
});

it('B12: return-to-default propagates server rejection', async () => {
  const { b } = fixture();
  const client = b.tsClient;
  client.options.channelId = '2'; client.currentChannelId = 1n; client.initialDefaultChannelId = 2n;
  const exec = vi.fn().mockRejectedValue(new Error('fixture invalid channel password'));
  client.client = { execCommand: exec, channelID: () => 1n };
  try {
    await expect(client.returnToDefaultChannel()).rejects.toThrow('invalid channel password');
    expect(exec).toHaveBeenCalled(); expect(client.getChannelId()).toBe(1n);
  } finally { client.client = null; }
});

it('B13: clear-enabled guest uses clear instead of administrator stop', async () => {
  const { b } = fixture(); b.queue.add(song('a'));
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'guest', username: 'guest', role: 'guest', bots: 'all',
    capabilities: new Set(), guest: { removeClear: true } as any }; next(); });
  app.use('/api/player', createPlayerRouter({ getBot: () => b } as any, logger));
  expect((await request(app).post('/api/player/b/stop').send({})).status).toBe(403);
  expect(b.queue.size()).toBe(1);
  expect((await request(app).post('/api/player/b/clear').send({})).status).toBe(200);
  expect(b.queue.size()).toBe(0);
});
