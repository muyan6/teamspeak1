import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createAuthRouter } from './web/api/auth.js';
import { LocalMusicProvider } from './music/local.js';
import { createDatabase } from './data/database.js';
import { createMusicRouter } from './web/api/music.js';
import { PlaybackCoordinator } from './bot/playback-coordinator.js';
import { PlayQueue } from './audio/queue.js';
import { csrfOriginCheck } from './web/middleware/csrf.js';

const logger: any = { info() {}, warn() {}, debug() {}, error() {} };
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(f => f()); vi.restoreAllMocks(); });
const song = (id: string): any => ({ id, platform: 'local', name: id, artist: '', album: '', coverUrl: '', duration: 1 });
function local(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tsmb-quota-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { p: new LocalMusicProvider(dir, opts), dir };
}
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve };
}

describe('QR confirmation transactions', () => {
  function mount() {
    const provider: any = { platform: 'netease', getQrCode: vi.fn(async () => ({ key: 'qr', qrUrl: 'fixture' })),
      checkQrCodeStatus: vi.fn(async () => 'confirmed'), getCookie: () => 'FIXTURE_COOKIE' };
    const save = vi.fn(), app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'admin', username: 'admin', role: 'admin' }; next(); });
    app.use(createAuthRouter(provider, provider, provider, logger, { save } as any));
    return { app, provider, save };
  }
  it('binds a generated key to the generating session and consumes confirmation once', async () => {
    const { app, provider, save } = mount();
    await request(app).post('/qrcode').set('Cookie', 'tsmb_session=A').send({ platform: 'netease' }).expect(200);
    await request(app).post('/qrcode/status').set('Cookie', 'tsmb_session=B').send({ platform: 'netease', key: 'qr' }).expect(403);
    expect(provider.checkQrCodeStatus).not.toHaveBeenCalled();
    await request(app).get('/qrcode/status?key=qr').set('Cookie', 'tsmb_session=A').expect(405);
    await request(app).post('/qrcode/status').set('Cookie', 'tsmb_session=A').send({ platform: 'netease', key: 'qr' }).expect(200);
    expect(save).toHaveBeenCalledTimes(1);
    await request(app).post('/qrcode/status').set('Cookie', 'tsmb_session=A').send({ platform: 'netease', key: 'qr' }).expect(403);
  });
  it('rejects simultaneous confirmation before calling the credential-mutating provider twice', async () => {
    const { app, provider } = mount(); const reply = deferred<any>(), entered = deferred();
    provider.checkQrCodeStatus.mockImplementation(() => { entered.resolve(); return reply.promise; });
    await request(app).post('/qrcode').send({ platform: 'netease' });
    const first = request(app).post('/qrcode/status').send({ platform: 'netease', key: 'qr' }).then(r => r);
    await entered.promise;
    await request(app).post('/qrcode/status').send({ platform: 'netease', key: 'qr' }).expect(409);
    reply.resolve('confirmed'); expect((await first).status).toBe(200);
    expect(provider.checkQrCodeStatus).toHaveBeenCalledTimes(1);
  });
});

describe('Streaming uploads and hard quotas', () => {
  it('reserves file slots while a stream is still being received', async () => {
    const { p } = local({ maxFiles: 1 }); const gate = deferred(), entered = deferred();
    async function* stream() { entered.resolve(); yield Buffer.alloc(8); await gate.promise; yield Buffer.alloc(8); }
    const first = p.uploadStream({ stream: stream(), originalName: 'first.mp3' });
    await entered.promise;
    await expect(p.uploadAudio({ buffer: Buffer.alloc(8), originalName: 'second.mp3' })).rejects.toMatchObject({ status: 507 });
    gate.resolve(); await first;
  });
  it('removes cancelled partial files and releases reserved capacity', async () => {
    const { p, dir } = local({ maxFiles: 1, maxTotalBytes: 64 }); const abort = new AbortController();
    async function* stream() { yield Buffer.alloc(8); abort.abort(new Error('fixture cancel')); yield Buffer.alloc(8); }
    await expect(p.uploadStream({ stream: stream(), originalName: 'cancel.mp3', signal: abort.signal })).rejects.toThrow('fixture cancel');
    expect(readdirSync(dir)).toEqual([]);
    expect((await p.uploadAudio({ buffer: Buffer.alloc(8), originalName: 'retry.mp3' })).id).toBeTruthy();
  });
  it('routes actual HTTP uploads to the streaming provider instead of buffering', async () => {
    const { p } = local(); const spy = vi.spyOn(p, 'uploadAudio'); const app = express();
    app.use((req, _res, next) => { req.user = { id: 'a', username: 'a', role: 'admin' }; next(); });
    app.use(createMusicRouter({} as any, {} as any, {} as any, logger, p));
    const res = await request(app).post('/local/upload').set('Content-Type', 'audio/mpeg').set('X-Filename', 'music.mp3').send(Buffer.alloc(64));
    expect(res.status).toBe(200); expect(res.body.song.platform).toBe('local'); expect(spy).not.toHaveBeenCalled();
  });
});

it('queue reference cache is invalidated by SQL mutations', () => {
  const db = createDatabase(':memory:'); cleanup.push(() => db.close());
  const saved = db.saveQueue('user', 'a', [song('first')]);
  expect([...db.getReferencedLocalSongIds()]).toEqual(['first']);
  db.db.prepare('UPDATE saved_queues SET songs=? WHERE id=?').run(JSON.stringify([song('second')]), saved.id);
  expect([...db.getReferencedLocalSongIds()]).toEqual(['second']);
  db.deleteSavedQueue(saved.id); expect(db.getReferencedLocalSongIds().size).toBe(0);
});

it('cancel invalidates active and queued playback intents, but permits later commands', async () => {
  const c = new PlaybackCoordinator(), gate = deferred(), started = deferred();
  const first = c.run(async () => { started.resolve(); await gate.promise; c.assertCurrent(); });
  const firstResult = expect(first).rejects.toThrow('cancelled');
  await started.promise;
  const queued = c.run(async () => 'old'); const queuedResult = expect(queued).rejects.toThrow('cancelled');
  c.cancel(); const next = c.run(async () => 'new'); gate.resolve();
  await firstResult; await queuedResult; expect(await next).toBe('new');
});

it.each([1, 100, 1000])('publishes one addMany event for %i songs', count => {
  const onChange = vi.fn(), q = new PlayQueue(onChange);
  q.addMany(Array.from({ length: count }, (_, i) => song(String(i))));
  expect(onChange).toHaveBeenCalledTimes(1); expect(q.size()).toBe(count);
});

it('shared Node version check matches the supported engine boundaries', () => {
  const { supported } = createRequire(import.meta.url)('../scripts/check-node-version.cjs');
  for (const version of ['20.19.0', '22.12.0', '24.0.0']) expect(supported(version)).toBe(true);
  for (const version of ['18.20.0', '20.18.9', '21.7.0', '22.11.9', '23.5.0']) expect(supported(version)).toBe(false);
});

it('a non-trusted peer cannot set the CSRF host through forwarded headers', async () => {
  const app = express(); app.set('trust proxy', ['10.0.0.0/8']);
  app.use(csrfOriginCheck); app.post('/', (_req, res) => res.sendStatus(200));
  await request(app).post('/').set('Host', 'expected.test').set('X-Forwarded-Host', 'other.test').set('Origin', 'https://other.test').expect(403);
});
