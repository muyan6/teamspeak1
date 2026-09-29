import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => dns);
import { downloadCoverImage, isPublicAddress, isSafeCoverUrl } from './music/image-download.js';
import { publicSong, normalizeSong } from './music/media-dto.js';
import { createDatabase } from './data/database.js';
import { createSessionStore } from './data/sessions.js';
import { getDefaultConfig, loadConfig } from './data/config.js';
import { createBotRouter } from './web/api/bot.js';
import { setupWebSocket } from './web/websocket.js';
import { SpotifyProvider } from './music/spotify/provider.js';
import { SpotifyWebApi } from './music/spotify/webapi.js';
import { JellyfinProvider } from './music/jellyfin.js';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(f => f()); vi.useRealTimers(); vi.restoreAllMocks(); });
const logger: any = { info() {}, debug() {}, warn() {}, error() {}, child() { return this; } };
function database() { const db = createDatabase(':memory:'); cleanup.push(() => db.close()); return db; }
const song = { id: 'a', name: 'a', artist: 'artist', album: '', duration: 120, coverUrl: '', platform: 'jellyfin' as const };

describe('Review hardening and missing-feature regression tests', () => {
  it('blocks private DNS answers, including mixed public/private answers', async () => {
    dns.lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    expect(await downloadCoverImage('https://cover.example.com/image')).toBeNull();
    dns.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    expect(await downloadCoverImage('https://cover.example.com/image')).toBeNull();
  });

  it('rejects all local IP forms and limits configured origins to image paths/ports', () => {
    for (const ip of ['::ffff:7f00:1', '::', '::1', 'fe90::1', 'fc00::1', 'ff02::1', '127.0.0.2', '100.64.0.1', '169.254.169.254', '192.168.0.1']) expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(isSafeCoverUrl('http://192.168.0.1:8096/Items/a/Images/Primary', ['http://192.168.0.1:8096'])).toBe(true);
    expect(isSafeCoverUrl('http://192.168.0.1:8096/admin', ['http://192.168.0.1:8096'])).toBe(false);
    expect(isSafeCoverUrl('http://192.168.0.1:80/Items/a/Images/Primary', ['http://192.168.0.1:8096'])).toBe(false);
  });

  it('strips internal URLs and legacy Jellyfin credentials from public/stored DTOs', () => {
    const output = publicSong({ ...song, url: 'http://private/Audio/a?api_key=SECRET', coverUrl: 'http://private/Items/a/Images/Primary?api_key=SECRET&tag=tag' });
    expect(JSON.stringify(output)).not.toContain('SECRET'); expect(output).not.toHaveProperty('url');
    expect(output.coverUrl).toBe('/api/music/jellyfin/cover/a?tag=tag');
    expect(() => normalizeSong({ ...song, duration: -1 })).toThrow();
    expect(() => normalizeSong({ ...song, id: {} })).toThrow();
  });

  it('read-only socket validation never extends TTL or updates lastSeenAt', () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const db = database(), sessions = createSessionStore(db.db);
    const { token } = sessions.createSession('__guest__', { ttlMs: 1000 });
    const before = db.db.prepare('SELECT expiresAt, lastSeenAt FROM sessions').get();
    vi.setSystemTime(100500); expect(sessions.validate(token)?.role).toBe('guest');
    expect(db.db.prepare('SELECT expiresAt, lastSeenAt FROM sessions').get()).toEqual(before);
    vi.setSystemTime(101001); expect(sessions.validate(token)).toBeNull();
  });

  it('retains the current socket and expires invalid sockets on heartbeat', async () => {
    vi.useFakeTimers(); const wss: any = new EventEmitter(), manager: any = new EventEmitter(); manager.getAllBots = () => [];
    const controller = setupWebSocket(wss, manager, logger, (ws: any) => ws.valid);
    cleanup.push(controller.cleanup);
    const socket = (token: string) => Object.assign(new EventEmitter(), { readyState: 1, userId: 'u', sessionToken: token, valid: true, send: vi.fn(), ping: vi.fn(), close: vi.fn(), terminate: vi.fn() });
    const old = socket('old'), current = socket('current'); wss.emit('connection', old); wss.emit('connection', current);
    controller.closeUserSockets('u', 'current'); expect(old.close).toHaveBeenCalledWith(4009, 'access changed'); expect(current.close).not.toHaveBeenCalled();
    current.valid = false; await vi.advanceTimersByTimeAsync(30000);
    expect(current.close).toHaveBeenCalledWith(4401, 'session expired');
  });

  it('saves the command prefix durably and rejects invalid prefixes atomically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsmb-prefix-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const config = getDefaultConfig(), file = join(dir, 'config.json'); const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'u', username: 'admin', role: 'admin' }; next(); });
    app.use('/api/bot', createBotRouter({ getAllBots: () => [] } as any, config, file, logger, database(), {} as any));
    expect((await request(app).post('/api/bot/settings').send({ commandPrefix: '!!' })).body.commandPrefix).toBe('!!');
    expect(loadConfig(file).commandPrefix).toBe('!!');
    const before = readFileSync(file, 'utf8');
    expect((await request(app).post('/api/bot/settings').send({ commandPrefix: 'bad prefix', autoPauseOnEmpty: true })).status).toBe(400);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('passes Spotify pagination through both provider and upstream request', async () => {
    const http: any = { get: vi.fn(async () => ({ data: { tracks: { items: [] } } })) }, auth: any = { post: vi.fn(async () => ({ data: { access_token: 'app-token', expires_in: 3600 } })) };
    const api = new SpotifyWebApi(() => ({ clientId: 'id', clientSecret: 'secret' }), { http, auth });
    await new SpotifyProvider(api).search('queen', 20, 40);
    expect(http.get).toHaveBeenCalledWith('/v1/search', expect.objectContaining({ params: expect.objectContaining({ offset: 40, limit: 20 }) }));
  });

  it('serves Jellyfin image bytes using private headers and never forwards redirects', async () => {
    const provider: any = new JellyfinProvider(logger);
    provider.configure({ serverUrl: 'http://192.168.0.1:8096', authMode: 'apikey', apiKey: 'SECRET', userId: 'u', username: '', password: '' });
    const get = vi.spyOn(provider.api, 'get').mockResolvedValue({ data: Buffer.from('image'), headers: { 'content-type': 'image/png' } });
    expect((await provider.getCoverImage('a', 'tag')).buffer.toString()).toBe('image');
    expect(get).toHaveBeenCalledWith('http://192.168.0.1:8096/Items/a/Images/Primary', expect.objectContaining({ maxRedirects: 0, headers: { 'X-Emby-Token': 'SECRET' } }));
    expect(await provider.getCoverImageFromUrl('http://attacker/Items/a')).toBeNull();
    expect(await provider.getCoverImage('../secret')).toBeNull();
  });

  it('preserves local data when stored reference metadata is corrupt', () => {
    const db = database(); const saved = db.saveQueue('u', 'a', [{ ...song, platform: 'local' }]);
    db.db.prepare('UPDATE saved_queues SET songs = ? WHERE id = ?').run('broken json', saved.id);
    expect(() => db.getReferencedLocalSongIds()).toThrow();
  });
});
