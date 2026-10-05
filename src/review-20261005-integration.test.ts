import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotManager } from './bot/manager.js';
import { TS3Client } from './ts-protocol/client.js';
import { createDatabase } from './data/database.js';
import { getDefaultConfig } from './data/config.js';
import { createIntegrationStore, leaseAllowsRun } from './data/integration.js';
import { createPermissionStore, CAPABILITIES } from './data/permissions.js';
import { createUserStore } from './data/users.js';
import { createSessionStore } from './data/sessions.js';
import { createIntegrationRouter } from './web/api/integration.js';
import { requireAdmin } from './web/middleware/requireAdmin.js';
import { createWebServer } from './web/server.js';

vi.mock('@discordjs/opus', () => ({ default: { OpusEncoder: class {
  encode(b: Buffer) { return b; } decode(b: Buffer) { return b; }
} } }));

const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  // Every manager/bot remains real, but a TS handshake is never sent.
  vi.spyOn(TS3Client.prototype, 'connect').mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.useRealTimers();
});
const params = () => ({ name: 'Managed music bot', serverAddress: 'fixture.invalid', serverPort: 9987, nickname: 'Fixture' });
const liveLease = (revision = 1) => ({ expiresAt: Date.now() + 60_000, suspended: false, revision });
const body = (serviceId = 'service_fixture_001') => ({ serviceId, bot: params(), lease: liveLease() });

function fixture(file = ':memory:') {
  const db = createDatabase(file);
  cleanups.push(() => { if (db.db.open) db.close(); });
  const config = getDefaultConfig(); config.guestMode.enabled = true;
  const provider: any = { platform: 'netease', getCookie: () => '', getQuality: () => 'standard', setQuality() {} };
  const manager = new BotManager(provider, provider, provider, db, config, logger,
    { read: () => null } as any, createPermissionStore(db.db), 'unused-fixture-config.json');
  cleanups.push(() => manager.shutdown());
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'fixture-admin', username: 'admin', role: 'admin' }; next(); });
  app.use('/api/integration/v1', requireAdmin, createIntegrationRouter(manager));
  return { db, config, provider, manager, app, store: createIntegrationStore(db.db) };
}

function persistentFile() {
  const dir = mkdtempSync(join(tmpdir(), 'tsmb-integration-review-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'data.sqlite');
}

it('integration: duplicate and concurrent POSTs create one durable bot/service mapping', async () => {
  const { app, db, manager } = fixture();
  const input = body();
  const replies = await Promise.all(Array.from({ length: 3 }, () => request(app).post('/api/integration/v1/bots').send(input)));
  expect(replies.map(r => r.status).sort()).toEqual([200, 200, 201]);
  expect(new Set(replies.map(r => r.body.id)).size).toBe(1);
  expect(db.getBotInstances()).toHaveLength(1); expect(manager.getAllBots()).toHaveLength(1);
  expect(manager.getManagedService(input.serviceId)?.botId).toBe(replies[0].body.id);
  expect(TS3Client.prototype.connect).not.toHaveBeenCalled();
});

it('integration: a different normalized bot payload for the same service is rejected', async () => {
  const { app, db } = fixture(); const input = body();
  expect((await request(app).post('/api/integration/v1/bots').send(input)).status).toBe(201);
  const changed = { ...input, bot: { ...input.bot, nickname: 'Different' } };
  expect((await request(app).post('/api/integration/v1/bots').send(changed)).status).toBe(409);
  expect(db.getBotInstances()).toHaveLength(1); expect(db.getBotInstances()[0].nickname).toBe('Fixture');
});

it('integration: bot creation rolls back if durable lease insertion fails', async () => {
  const { app, db } = fixture();
  db.db.exec("CREATE TRIGGER fixture_reject_service BEFORE INSERT ON integration_services BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END");
  const input = body();
  expect((await request(app).post('/api/integration/v1/bots').send(input)).status).toBe(500);
  expect(db.getBotInstances()).toHaveLength(0);
  expect(db.db.prepare('SELECT COUNT(*) AS n FROM integration_services').get()).toEqual({ n: 0 });
  db.db.exec('DROP TRIGGER fixture_reject_service');
  expect((await request(app).post('/api/integration/v1/bots').send(input)).status).toBe(201);
});

it('integration: persisted mapping and latest lease survive database close/reopen', async () => {
  const file = persistentFile(), first = fixture(file), input = body();
  const created = await request(first.app).post('/api/integration/v1/bots').send(input);
  const lease = { ...input.lease, revision: 4, expiresAt: input.lease.expiresAt + 60_000 };
  expect((await request(first.app).put(`/api/integration/v1/bots/${created.body.id}/lease`).send(lease)).status).toBe(200);
  first.manager.shutdown(); first.db.close();
  const second = fixture(file);
  await second.manager.loadSavedBots();
  const replay = await request(second.app).post('/api/integration/v1/bots').send(input);
  expect(replay.status).toBe(200); expect(replay.body.id).toBe(created.body.id);
  expect(second.manager.getManagedService(input.serviceId)).toMatchObject(lease);
  expect(second.db.getBotInstances()).toHaveLength(1);
  expect(TS3Client.prototype.connect).not.toHaveBeenCalled();
});

it('integration: cancellation tombstone survives restart and blocks a late create', async () => {
  const file = persistentFile(), first = fixture(file), input = body();
  expect((await request(first.app).delete(`/api/integration/v1/services/${input.serviceId}`)).status).toBe(204);
  expect((await request(first.app).delete(`/api/integration/v1/services/${input.serviceId}`)).status).toBe(204);
  first.manager.shutdown(); first.db.close();
  const second = fixture(file);
  expect((await request(second.app).post('/api/integration/v1/bots').send(input)).status).toBe(410);
  expect(second.db.getBotInstances()).toHaveLength(0);
  expect(second.manager.getManagedService(input.serviceId)).toMatchObject({ deleted: true, suspended: true });
});

it('integration: cancelling an existing running service disconnects and keeps a tombstone', async () => {
  const { app, manager, db } = fixture(); const input = body();
  const created = await request(app).post('/api/integration/v1/bots').send(input);
  await manager.startBot(created.body.id); const bot = manager.getBot(created.body.id)!;
  expect(bot.isConnected()).toBe(true);
  expect((await request(app).delete(`/api/integration/v1/services/${input.serviceId}`)).status).toBe(204);
  expect(bot.isConnected()).toBe(false); expect(manager.getBot(created.body.id)).toBeUndefined();
  expect(db.getBotInstances()).toHaveLength(0);
  expect((await request(app).post('/api/integration/v1/bots').send(input)).status).toBe(410);
  expect(manager.canRunBot(created.body.id)).toBe(false);
});

it('integration: lease revision permits exact retry and rejects same-revision conflict/older revision', async () => {
  const { app, manager } = fixture(); const input = body();
  const created = await request(app).post('/api/integration/v1/bots').send(input);
  const url = `/api/integration/v1/bots/${created.body.id}/lease`;
  const lease = { ...input.lease, revision: 3 };
  expect((await request(app).put(url).send(lease)).status).toBe(200);
  expect((await request(app).put(url).send(lease)).status).toBe(200);
  expect((await request(app).put(url).send({ ...lease, suspended: true })).status).toBe(409);
  expect((await request(app).put(url).send({ ...lease, expiresAt: lease.expiresAt + 1 })).status).toBe(409);
  expect((await request(app).put(url).send({ ...lease, revision: 2 })).status).toBe(409);
  expect(manager.getManagedService(input.serviceId)).toMatchObject(lease);
});

it.each(['expired', 'suspended'])('integration: %s leases reject manual start and startup auto-connect', async reason => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-05T00:00:00Z'));
  const { manager, db } = fixture();
  const lease = { expiresAt: reason === 'expired' ? Date.now() : null, suspended: reason === 'suspended', revision: 1 };
  const { bot } = await manager.createManagedBot('service_denied_001', 'fixture-hash', params(), lease);
  await expect(manager.startBot(bot.id)).rejects.toMatchObject({ status: 403 });
  manager.updateBot(bot.id, { autoStart: true });
  await manager.loadSavedBots();
  expect(TS3Client.prototype.connect).not.toHaveBeenCalled();
  expect(manager.getBot(bot.id)?.isConnected()).toBe(false);
  expect(db.getBotInstances()).toHaveLength(1);
});

it('integration: the lease monitor disconnects at expiry and is cleared by shutdown', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-05T00:00:00Z'));
  const { manager } = fixture();
  const { bot } = await manager.createManagedBot('service_monitor_001', 'fixture-hash', params(),
    { expiresAt: Date.now() + 1500, suspended: false, revision: 1 });
  await manager.startBot(bot.id);
  expect(manager.getBot(bot.id)?.isConnected()).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(manager.getBot(bot.id)?.isConnected()).toBe(false);
  expect(manager.getBotConfig(bot.id)?.autoStart).toBe(false);
  manager.shutdown(); expect((manager as any).leaseTimer).toBeUndefined();
});

it('integration: a higher revision can renew and explicitly restart an expired bot', async () => {
  const { manager } = fixture();
  const { bot } = await manager.createManagedBot('service_renew_001', 'fixture-hash', params(),
    { expiresAt: Date.now() - 1, suspended: false, revision: 1 });
  manager.setBotLease(bot.id, liveLease(2)); await manager.startBot(bot.id);
  expect(manager.getBot(bot.id)?.isConnected()).toBe(true);
});

it.each(['suspend', 'cancel'])('integration: %s during a pending handshake prevents late activation', async action => {
  const { manager, db } = fixture();
  const lease = liveLease();
  const { bot } = await manager.createManagedBot('service_pending_001', 'fixture-hash', params(), lease);
  let complete!: () => void;
  const handshake = new Promise<void>(resolve => { complete = resolve; });
  vi.mocked(TS3Client.prototype.connect).mockImplementationOnce(() => handshake);
  const starting = manager.startBot(bot.id);
  const expectation = expect(starting).rejects.toThrow();
  const pendingBot = manager.getBot(bot.id)!;
  if (action === 'suspend') manager.setBotLease(bot.id, { ...lease, revision: 2, suspended: true });
  else await manager.cancelManagedService('service_pending_001');
  complete(); await expectation;
  expect(pendingBot.isConnected()).toBe(false);
  expect(manager.canRunBot(bot.id)).toBe(false);
  if (action === 'cancel') expect(db.getBotInstances()).toHaveLength(0);
  else expect(manager.getBotConfig(bot.id)?.autoStart).toBe(false);
});

it('integration: adopting a legacy bot enforces its lease without changing unrelated legacy bots', async () => {
  const { manager, store } = fixture();
  const adopted = await manager.createBot(params()), unrelated = await manager.createBot({ ...params(), name: 'Unrelated' });
  await manager.startBot(adopted.id); await manager.startBot(unrelated.id);
  manager.setBotLease(adopted.id, { expiresAt: null, suspended: true, revision: 1 });
  expect(manager.getBot(adopted.id)?.isConnected()).toBe(false);
  expect(manager.getBot(unrelated.id)?.isConnected()).toBe(true);
  expect(store.getByBot(adopted.id)?.serviceId).toBe(`adopted:${adopted.id}`);
  expect(store.getByBot(unrelated.id)).toBeNull();
});

it('integration: legacy standalone bots remain startable, auto-startable and unleased', async () => {
  vi.useFakeTimers();
  const { manager, store } = fixture();
  const bot = await manager.createBot(params());
  expect(store.getByBot(bot.id)).toBeNull(); expect(manager.canRunBot(bot.id)).toBe(true);
  await manager.startBot(bot.id); expect(manager.getBot(bot.id)?.isConnected()).toBe(true);
  manager.shutdown();
  const load = manager.loadSavedBots(); await vi.advanceTimersByTimeAsync(1100); await load;
  expect(manager.getBot(bot.id)?.isConnected()).toBe(true); expect(store.getByBot(bot.id)).toBeNull();
  expect(TS3Client.prototype.connect).toHaveBeenCalledTimes(2);
});

it('integration: a recovered idempotent creation starts the expiry monitor after initial construction failure', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-05T00:00:00Z'));
  const { manager } = fixture();
  const lease = { expiresAt: Date.now() + 1500, suspended: false, revision: 1 };
  vi.spyOn(manager as any, 'buildBotInstance').mockImplementationOnce(() => { throw new Error('fixture constructor failure'); });
  await expect(manager.createManagedBot('service_recovery_001', 'fixture-hash', params(), lease)).rejects.toThrow('fixture constructor failure');
  const recovered = await manager.createManagedBot('service_recovery_001', 'fixture-hash', params(), lease);
  expect(recovered.created).toBe(false);
  await manager.startBot(recovered.bot.id);
  await vi.advanceTimersByTimeAsync(2000);
  expect(manager.getBot(recovered.bot.id)?.isConnected()).toBe(false);
});

it('integration: real server mount enforces admin despite member bot.create/bot.manage capabilities', async () => {
  const { manager, provider, db, config } = fixture();
  const createdServers = vi.spyOn(http, 'createServer');
  const web = createWebServer({ port: 0, botManager: manager, database: db, config,
    configPath: 'unused-fixture-config.json', logger, avatarStore: { read: () => null } as any,
    neteaseProvider: provider, qqProvider: provider, bilibiliProvider: provider, localProvider: provider,
    kugouProvider: provider, spotifyProvider: provider, jellyfinProvider: provider });
  cleanups.push(() => web.stop());
  const server = createdServers.mock.results[0].value as http.Server;
  await web.start();
  const users = createUserStore(db.db), sessions = createSessionStore(db.db);
  const admin = await users.createUser('fixture_admin', 'fixture-password', 'admin');
  const member = await users.createUser('fixture_member', 'fixture-password', 'member', { capabilities: [...CAPABILITIES], bots: 'all' });
  const guest = await users.createUser('fixture_guest', 'fixture-password', 'guest');
  const cookie = (id: string) => `tsmb_session=${sessions.createSession(id).token}`;
  const adminCookie = cookie(admin.id), memberCookie = cookie(member.id), guestCookie = cookie(guest.id);
  const base = '/api/integration/v1';
  expect((await request(server).get(`${base}/capabilities`)).status).toBe(401);
  expect((await request(server).get(`${base}/capabilities`).set('Cookie', memberCookie)).status).toBe(403);
  expect((await request(server).get(`${base}/capabilities`).set('Cookie', guestCookie)).status).toBe(403);
  expect((await request(server).get(`${base}/capabilities`).set('Cookie', adminCookie)).body.leases).toBe(true);
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const input = body();
  expect((await request(server).post(`${base}/bots`).set('Cookie', memberCookie).set('Origin', origin).send(input)).status).toBe(403);
  const created = await request(server).post(`${base}/bots`).set('Cookie', adminCookie).set('Origin', origin).send(input);
  expect(created.status).toBe(201);
  expect((await request(server).put(`${base}/bots/${created.body.id}/lease`).set('Cookie', memberCookie).set('Origin', origin).send(liveLease(2))).status).toBe(403);
  expect((await request(server).delete(`${base}/services/${input.serviceId}`).set('Cookie', memberCookie).set('Origin', origin)).status).toBe(403);
  const status = await request(server).get(`${base}/services/${input.serviceId}`).set('Cookie', adminCookie);
  expect(status.status).toBe(200); expect(status.body.payloadHash).toBeUndefined();
  expect(TS3Client.prototype.connect).not.toHaveBeenCalled();
}, 15_000);

it('integration: null expiry is unlimited, exact expiry boundary is denied', () => {
  expect(leaseAllowsRun(null, 100)).toBe(true);
  expect(leaseAllowsRun({ expiresAt: null, suspended: false, revision: 1 }, 100)).toBe(true);
  expect(leaseAllowsRun({ expiresAt: 100, suspended: false, revision: 1 }, 100)).toBe(false);
});
