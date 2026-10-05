import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import pino from 'pino';
import bcrypt from 'bcryptjs';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from './data/database.js';
import { createUserStore, CredentialsChangedError } from './data/users.js';
import { createSessionStore } from './data/sessions.js';
import { createAuditStore } from './data/audit.js';
import { createPermissionStore } from './data/permissions.js';
import { createAvatarStore } from './data/avatars.js';
import { getDefaultConfig } from './data/config.js';
import { hashPassword, verifyPassword, isLegacyPasswordHash, DUMMY_PASSWORD_HASH } from './data/passwords.js';
import { createBotRouter } from './web/api/bot.js';
import { createSessionRouter } from './web/api/session.js';
import { createUsersRouter } from './web/api/users.js';
import { createAuthRouter } from './web/api/auth.js';
import { createMusicRouter } from './web/api/music.js';

const cleanup: Array<() => void> = [];
const logger = pino({ level: 'silent' });
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'api-repair-20261005-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const database = createDatabase(':memory:');
  cleanup.push(() => database.close());
  return { directory, database };
}
function appAs(user: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  return app;
}
function provider(platform: string) {
  return { platform, getCookie: () => '', getQuality: () => 'standard', setCookie: vi.fn() } as any;
}
const admin = { id: 'admin', username: 'admin', role: 'admin', bots: 'all' };

describe('2026-10-05 API regression protections', () => {
  it('unknown-account dummy hash is valid and actually runs the current KDF', async () => {
    expect(await verifyPassword('tsmusicbot-nonexistent-user-placeholder', DUMMY_PASSWORD_HASH)).toBe(true);
    expect(await verifyPassword('wrong', DUMMY_PASSWORD_HASH)).toBe(false);
  });
  it('A01 denies every process-wide settings write to a scoped bot manager', async () => {
    const { directory, database } = fixture();
    const config = getDefaultConfig();
    const before = structuredClone(config);
    const applyOther = vi.fn();
    const manager = { getAllBots: () => [{ id: 'other', updateAutoPause: applyOther }] } as any;
    const app = appAs({ id: 'tenant-a', role: 'member', capabilities: new Set(['bot.manage']), bots: new Set(['own']) });
    const configPath = join(directory, 'config.json');
    app.use('/api/bot', createBotRouter(manager, config, configPath, logger, database, createAvatarStore(directory)));
    for (const body of [{ autoPauseOnEmpty: false }, { enabledProviders: [] }, { commandPrefix: '?' }, { defaultPlatform: 'qq' }]) {
      expect((await request(app).post('/api/bot/settings').send(body)).status).toBe(403);
    }
    expect(config).toEqual(before);
    expect(applyOther).not.toHaveBeenCalled();
    expect(existsSync(configPath)).toBe(false);
  });

  it('A02 a persistence error leaves config and guest/live policy unchanged', async () => {
    const { directory, database } = fixture();
    const config = getDefaultConfig();
    const before = structuredClone(config);
    const apply = vi.fn();
    const changed = vi.fn();
    const configPath = join(directory, 'blocked-config-target');
    mkdirSync(configPath);
    const app = appAs(admin);
    app.use('/api/bot', createBotRouter({ getAllBots: () => [{ updateAutoPause: apply }] } as any, config, configPath, logger, database, createAvatarStore(directory), changed));
    app.use((err: any, _req: any, res: any, _next: any) => { res.status(500).json({ error: err.code }); });
    const result = await request(app).post('/api/bot/settings').send({ autoPauseOnEmpty: !before.autoPauseOnEmpty, guestMode: { enabled: true, bots: ['tenant-a'] }, spotify: { clientId: 'new' } });
    expect(result.status).toBe(500);
    expect(config).toEqual(before);
    expect(apply).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect((await request(app).get('/api/bot/settings')).body.autoPauseOnEmpty).toBe(before.autoPauseOnEmpty);
  });

  it('A02 successful save preserves shared config identity and publishes after disk commit', async () => {
    const { directory, database } = fixture();
    const config = getDefaultConfig();
    const original = config;
    const configPath = join(directory, 'config.json');
    const changed = vi.fn(() => expect(JSON.parse(readFileSync(configPath, 'utf8')).guestMode.enabled).toBe(true));
    const app = appAs(admin);
    app.use('/api/bot', createBotRouter({ getAllBots: () => [] } as any, config, configPath, logger, database, createAvatarStore(directory), changed));
    expect((await request(app).post('/api/bot/settings').send({ guestMode: { enabled: true } })).status).toBe(200);
    expect(config).toBe(original);
    expect(config.guestMode.enabled).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
  });

  it('A03 rejects unsupported/unknown Cookie platforms without any account write', async () => {
    const netease = provider('netease');
    const spotify = provider('spotify');
    const save = vi.fn();
    const app = appAs(admin);
    app.use('/api/auth', createAuthRouter(netease, provider('qq'), provider('bilibili'), logger, { save } as any, undefined, spotify));
    for (const platform of ['spotify', 'invalid', '', null]) {
      expect((await request(app).post('/api/auth/cookie').send({ platform, cookie: 'FIXTURE' })).status).toBe(400);
    }
    expect(spotify.setCookie).not.toHaveBeenCalled();
    expect(netease.setCookie).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect((await request(app).post('/api/auth/cookie').send({ platform: 'netease', cookie: 'GOOD_FIXTURE' })).status).toBe(200);
    expect(save).toHaveBeenCalledWith('netease', 'GOOD_FIXTURE');
  });

  it('A04 rejects a pending old-password login after password reset completes', async () => {
    const { database } = fixture();
    const users = createUserStore(database.db);
    const sessions = createSessionStore(database.db);
    const audit = createAuditStore(database.db);
    const permissions = createPermissionStore(database.db);
    const user = await users.createUser('tenant', 'OLD_PASSWORD_FIXTURE', 'member');
    const actor = await users.createUser('admin', 'ADMIN_PASSWORD_FIXTURE', 'admin');
    const realVerify = users.verifyPassword.bind(users);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const delayed = { ...users, verifyPassword: async (plain: string, hash: string) => { const ok = await realVerify(plain, hash); entered(); await gate; return ok; } };
    const app = express();
    app.use(express.json());
    app.use('/api/session', createSessionRouter(delayed, sessions, audit, logger, permissions, () => getDefaultConfig().guestMode));
    app.use('/api/users', (req, _res, next) => { req.user = { id: actor.id, username: actor.username, role: 'admin' }; next(); }, createUsersRouter(users, sessions, audit, logger, permissions));
    const pending = request(app).post('/api/session/login').send({ username: 'tenant', password: 'OLD_PASSWORD_FIXTURE' }).then(x => x);
    await ready;
    try {
      expect((await request(app).post(`/api/users/${user.id}/reset-password`).send({ newPassword: 'NEW_PASSWORD_FIXTURE' })).status).toBe(204);
    } finally { release(); }
    const result = await pending;
    expect(result.status).toBe(401);
    expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('A04 compare-and-set prevents a stale self-change from overwriting newer credentials', async () => {
    const { database } = fixture();
    const users = createUserStore(database.db);
    const user = await users.createUser('tenant', 'ORIGINAL_PASSWORD', 'member');
    await users.changePassword(user.id, 'ADMIN_RESET_PASSWORD', user.passwordHash);
    await expect(users.changePassword(user.id, 'STALE_CHANGE_PASSWORD', user.passwordHash)).rejects.toBeInstanceOf(CredentialsChangedError);
    expect(await users.verifyPassword('ADMIN_RESET_PASSWORD', users.findById(user.id)!.passwordHash)).toBe(true);
  });

  it('A05 new accounts and explicit password changes protect the entire UTF-8 input', async () => {
    const { database } = fixture();
    const users = createUserStore(database.db);
    for (const prefix of ['A'.repeat(72), '中'.repeat(30)]) {
      const hash = await hashPassword(prefix + 'ORIGINAL_SUFFIX');
      expect(hash).toMatch(/^\$scrypt\$v1\$/);
      expect(await verifyPassword(prefix + 'ORIGINAL_SUFFIX', hash)).toBe(true);
      expect(await verifyPassword(prefix + 'DIFFERENT_SUFFIX', hash)).toBe(false);
    }
    const user = await users.createUser('tenant', 'A'.repeat(72) + 'original', 'member');
    expect(await users.verifyPassword('A'.repeat(72) + 'different', user.passwordHash)).toBe(false);
    await users.changePassword(user.id, 'A'.repeat(72) + 'changed');
    expect(await users.verifyPassword('A'.repeat(72) + 'original', users.findById(user.id)!.passwordHash)).toBe(false);
  });

  it('A05 retains legacy long bcrypt passwords until an explicit upgrade and signals that upgrade', async () => {
    const { database } = fixture();
    const users = createUserStore(database.db);
    const user = await users.createUser('legacy', 'TEMP_PASSWORD', 'member');
    const fullPassword = 'A'.repeat(72) + 'HISTORICAL_SUFFIX';
    const legacyHash = await bcrypt.hash(fullPassword, 4);
    database.db.prepare('UPDATE users SET passwordHash=? WHERE id=?').run(legacyHash, user.id);
    const app = express();
    app.use(express.json());
    app.use('/api/session', createSessionRouter(users, createSessionStore(database.db), createAuditStore(database.db), logger, createPermissionStore(database.db), () => getDefaultConfig().guestMode));
    const login = await request(app).post('/api/session/login').send({ username: 'legacy', password: fullPassword });
    expect(login.status).toBe(200);
    expect(login.body.passwordUpgradeRecommended).toBe(true);
    expect(users.findById(user.id)!.passwordHash).toBe(legacyHash);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    expect((await request(app).post('/api/session/change-password').set('Cookie', cookie).send({ oldPassword: fullPassword, newPassword: fullPassword })).status).toBe(204);
    const upgradedHash = users.findById(user.id)!.passwordHash;
    expect(isLegacyPasswordHash(upgradedHash)).toBe(false);
    expect(await verifyPassword('A'.repeat(72) + 'WRONG_SUFFIX', upgradedHash)).toBe(false);
    expect((await request(app).get('/api/session/me').set('Cookie', cookie)).body.passwordUpgradeRecommended).toBe(false);
  });

  it('A06 disabled Bilibili makes zero upstream popular requests, enabled limit is bounded', async () => {
    const config = getDefaultConfig();
    config.enabledProviders = [];
    const bilibili = provider('bilibili');
    bilibili.getPopularVideos = vi.fn().mockResolvedValue([]);
    const app = appAs({ id: 'guest', role: 'guest' });
    app.use('/api/music', createMusicRouter(provider('netease'), provider('qq'), bilibili, logger, undefined, config));
    expect((await request(app).get('/api/music/bilibili/popular')).status).toBe(400);
    expect(bilibili.getPopularVideos).not.toHaveBeenCalled();
    config.enabledProviders = ['bilibili'];
    expect((await request(app).get('/api/music/bilibili/popular?limit=1000000')).status).toBe(200);
    expect(bilibili.getPopularVideos).toHaveBeenLastCalledWith(100);
  });

  it('A07 creation starts deny-all or commits explicitly requested initial grants atomically', async () => {
    const { database } = fixture();
    const users = createUserStore(database.db);
    const sessions = createSessionStore(database.db);
    const permissions = createPermissionStore(database.db);
    const audit = createAuditStore(database.db);
    const app = appAs(admin);
    app.use('/api/users', createUsersRouter(users, sessions, audit, logger, permissions));
    const denied = await request(app).post('/api/users').send({ username: 'denied', password: 'TENANT_PASSWORD', role: 'member' });
    expect(denied.status).toBe(201);
    expect(permissions.getBotAccess(denied.body.id)).toEqual([]);
    expect(permissions.getCapabilities(denied.body.id)).toEqual([]);
    const granted = await request(app).post('/api/users').send({ username: 'scoped', password: 'TENANT_PASSWORD', role: 'member', permissions: { capabilities: ['player.control', 'player.queue'], bots: ['own-bot'] } });
    expect(granted.status).toBe(201);
    expect(permissions.getBotAccess(granted.body.id)).toEqual(['own-bot']);
    expect(permissions.getCapabilities(granted.body.id)).toEqual(['player.control', 'player.queue']);
    for (const permissions of [{ capabilities: ['unknown'], bots: [] }, { capabilities: [], bots: null }, null]) {
      expect((await request(app).post('/api/users').send({ username: 'invalid', password: 'TENANT_PASSWORD', permissions })).status).toBe(400);
    }
    expect(users.findByUsername('invalid')).toBeNull();
  });

  it('A07 rolls back user creation if an initial grant fails', async () => {
    const { database } = fixture();
    const users = createUserStore(database.db);
    database.db.exec("CREATE TRIGGER reject_grant BEFORE INSERT ON user_bot_access BEGIN SELECT RAISE(ABORT, 'fixture grant failed'); END;");
    await expect(users.createUser('rollback', 'TENANT_PASSWORD', 'member', { capabilities: ['player.control'], bots: ['own-bot'] })).rejects.toThrow('fixture grant failed');
    expect(users.findByUsername('rollback')).toBeNull();
    expect(database.db.prepare('SELECT COUNT(*) AS n FROM user_permissions').get()).toEqual({ n: 0 });
  });
});
