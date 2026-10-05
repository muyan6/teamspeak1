import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from '../../node_modules/pinia/dist/pinia.mjs';
import axios from '../../node_modules/axios/index.js';
import { usePlayerStore } from './player.js';
import { useTargetEditor } from '../composables/useTargetEditor.js';

// Exercise the real event expressions/router/editor callbacks without a DOM.
// Compiler extraction avoids keeping a second, simplified implementation here.
function source(path: string) { return readFileSync(new URL(path, import.meta.url), 'utf8'); }
function ast(path: string) {
  const text = source(path), script = path.endsWith('.vue') ? text.split('<script setup lang="ts">')[1].split('</script>')[0] : text;
  return ts.createSourceFile(path + '.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function evaluate(text: string, dependencies: Record<string, any>) {
  const js = ts.transpileModule(`const selected = ${text};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), js + '\nreturn selected;')(...Object.values(dependencies));
}
function callback(path: string, callee: string, argument: number, contains: string, dependencies: Record<string, any>) {
  const tree = ast(path);
  const node = tree.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
    && n.expression.expression.getText(tree) === callee && n.getText(tree).includes(contains)) as ts.ExpressionStatement;
  return evaluate((node.expression as ts.CallExpression).arguments[argument].getText(tree), dependencies);
}
function settingsFunction(name: string, dependencies: Record<string, any>) {
  const tree = ast('../views/Settings.vue');
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)!;
  return evaluate(node.getText(tree), dependencies);
}
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; }
function bot(id: string) { return { id, name: id, connected: true, playing: true, paused: false,
  currentSong: { id: id + '-song', platform: 'netease', duration: 300 }, queueSize: 1, volume: 75, playMode: 'seq' } as any; }
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); });

it('F01 Navbar B card controls and pause clock belong to B, not selected A', async () => {
  vi.useFakeTimers(); vi.setSystemTime(20000); setActivePinia(createPinia()); const store = usePlayerStore();
  store.bots = [bot('A'), bot('B')]; store.activeBotId = 'A';
  store.timings.A = { serverElapsed: 90, serverSyncTime: 10000, wasPlaying: true };
  store.timings.B = { serverElapsed: 10, serverSyncTime: 10000, wasPlaying: true };
  const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: {} });
  const handlers = [...source('../components/Navbar.vue').matchAll(/@click\.stop="(store\.(?:pause|resume|next)\(bot\.id\))"/g)].map(m => m[1]);
  expect(handlers).toHaveLength(3);
  await new Function('store', 'bot', `return ${handlers[0]};`)(store, bot('B'));
  expect(store.timings.B.serverElapsed).toBe(20); expect(store.timings.A.serverElapsed).toBe(90);
  for (const handler of handlers.slice(1)) await new Function('store', 'bot', `return ${handler};`)(store, bot('B'));
  expect(post.mock.calls.map(c => c[0])).toEqual(['/api/player/B/pause', '/api/player/B/resume', '/api/player/B/next']);
  expect(store.activeBotId).toBe('A');
});

it('F02 real settings callbacks save only B permission data after A completes late', async () => {
  const a = deferred(), b = deferred(), editor = useTargetEditor(() => ({ capabilities: [] as string[], botsAll: true, selectedBotIds: [] as string[] }));
  const fetch = vi.fn((url: string, init?: any) => init?.method === 'PUT' ? Promise.resolve({ ok: true, status: 204 }) : url.includes('/A/') ? a.promise : b.promise);
  const state = { permissionEditor: editor, permEditingId: editor.targetId, fetch };
  const open = settingsFunction('onTogglePermEditor', state), save = settingsFunction('onSavePermissions', state);
  const old = open({ id: 'A' }), current = open({ id: 'B' });
  b.resolve({ ok: true, json: async () => ({ capabilities: ['player.control'], bots: ['B-bot'] }) }); await current;
  a.resolve({ ok: true, json: async () => ({ capabilities: ['bot.manage'], bots: 'all' }) }); await old;
  await save({ id: 'B' });
  const submitted = fetch.mock.calls.find(c => c[1]?.method === 'PUT')!;
  expect(submitted[0]).toBe('/api/users/B/permissions');
  expect(JSON.parse(submitted[1].body)).toEqual({ capabilities: ['player.control'], bots: ['B-bot'] });
});

it('F03 real settings callbacks block premature saves and preserve B config after canceled A', async () => {
  const a = deferred(), b = deferred(), editor = useTargetEditor(() => ({ name: '', serverAddress: '', serverPort: 9987, nickname: '', defaultChannel: '', channelId: '', channelPassword: '', serverPassword: '' }));
  const api = { get: vi.fn((url: string) => url.includes('/A/') ? a.promise : b.promise), put: vi.fn(async () => {}) };
  const state = { botEditor: editor, editingBot: editor.targetId, axios: api, store: { fetchBots: vi.fn(async () => {}) } };
  const open = settingsFunction('openEditBot', state), save = settingsFunction('saveEditBot', state);
  const old = open({ id: 'A', name: 'A' }); editor.close();
  const current = open({ id: 'B', name: 'B' }); await save(); expect(api.put).not.toHaveBeenCalled();
  b.resolve({ data: { serverAddress: 'b.invalid', nickname: 'B', defaultChannel: 'B-channel', hasServerPassword: true } }); await current;
  a.resolve({ data: { serverAddress: 'a.invalid', nickname: 'A', defaultChannel: 'A-channel', hasServerPassword: true } }); await old;
  await save();
  expect(api.put).toHaveBeenCalledWith('/api/bot/B', expect.objectContaining({ serverAddress: 'b.invalid', nickname: 'B', defaultChannel: 'B-channel', serverPassword: '' }));
});

function scopeHarness(query: Record<string, string> = {}) {
  setActivePinia(createPinia()); const store = usePlayerStore();
  const session = { ready: { value: true }, needsSetup: { value: false }, isAuthenticated: { value: true }, isGuest: { value: false } };
  const router = { currentRoute: { value: { query } } };
  const login = callback('../App.vue', 'watch', 1, 'session.currentUser.value?.id', { playerStore: store, session, router, connect() {}, disconnect() {} });
  const guard = callback('../router/index.ts', 'router.beforeEach', 0, 'scopedBotId', { useSession: () => session, usePlayerStore: () => store, PUBLIC_NAMES: new Set(['login', 'first-run']) });
  return { store, login, guard };
}
it('F04 login return to ?bot=B binds both scope and controls to B', async () => {
  const { store, login, guard } = scopeHarness();
  vi.spyOn(axios, 'get').mockImplementation(async url => url === '/api/bot' ? { data: { bots: [bot('A'), bot('B')] } } : { data: {} });
  login('user', undefined); await Promise.resolve(); await Promise.resolve();
  expect(await guard({ name: 'home', path: '/', query: { bot: 'B' }, fullPath: '/?bot=B' })).toBe(true);
  expect(store.scopedBotId).toBe('B'); expect(store.activeBotId).toBe('B');
  const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: {} }); await store.pause();
  expect(post.mock.calls[0][0]).toBe('/api/player/B/pause');
});
it('F04 initial query scope is restored before bot snapshot resolves and survives reconnect', async () => {
  const { store, login } = scopeHarness({ bot: 'B' }), request = deferred();
  vi.spyOn(axios, 'get').mockImplementation(url => url === '/api/bot' ? request.promise : Promise.resolve({ data: {} }));
  login('user', undefined);
  expect(store.scopedBotId).toBe('B'); expect(store.activeBotId).toBe('B'); expect(store.activeBot).toBeNull();
  request.resolve({ data: { bots: [bot('A'), bot('B')] } }); await Promise.resolve(); await Promise.resolve();
  expect(store.activeBot?.id).toBe('B');
  store.acceptBotList([bot('A'), bot('B')]); expect(store.activeBotId).toBe('B');
  store.acceptBotList([bot('A')]); expect(store.scopedBotId).toBeNull(); expect(store.activeBotId).toBe('A');
  expect(source('../composables/useWebSocket.ts')).toContain('store.acceptBotList(data.bots)');
});
it('F04 subsequent query changes reconcile immediately against the loaded bot list', async () => {
  const { store, guard } = scopeHarness(); vi.spyOn(axios, 'get').mockResolvedValue({ data: {} });
  store.acceptBotList([bot('A'), bot('B')]);
  await guard({ name: 'home', path: '/', query: { bot: 'B' } }); expect(store.activeBotId).toBe('B');
  await guard({ name: 'home', path: '/', query: { bot: 'A' } }); expect(store.activeBotId).toBe('A');
  await guard({ name: 'home', path: '/', query: { bot: 'missing' } }); expect(store.scopedBotId).toBeNull();
});
it('global bot-settings controls require admin while per-bot management remains delegated', () => {
  const sections = [...source('../views/Settings.vue').matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/g)];
  for (const title of ['默认音源', '命令设置', '行为设置', 'Jellyfin 音乐库（可选）', 'Spotify 播放（实验性）', '命令权限']) {
    const section = sections.find(m => m[2].includes(`<h2 class="section-title">${title}</h2>`));
    expect(section?.[1]).toContain('v-if="session.isAdmin.value"');
  }
  expect(sections.filter(m => m[1].includes("can('bot.manage')"))).toHaveLength(2);
});

it('successful password change refreshes the public password-upgrade status', async () => {
  const state = { ownPw: { old: 'old-password', new: 'new-password', confirm: 'new-password' },
    ownPwError: { value: '' }, ownPwSuccess: { value: '' }, changingOwnPw: { value: false },
    fetch: vi.fn(async () => ({ ok: true, status: 204 })), session: { refresh: vi.fn(async () => {}) } };
  await settingsFunction('onChangeOwnPassword', state)();
  expect(state.session.refresh).toHaveBeenCalledOnce(); expect(state.ownPwSuccess.value).toBe('密码已更新');
  expect(source('../views/Settings.vue')).toContain('session.currentUser.value?.passwordUpgradeRecommended');
});
