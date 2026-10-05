import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { setupWebSocket } from './websocket.js';
import { createWebServer } from './server.js';
import { createDatabase } from '../data/database.js';
import { createUserStore } from '../data/users.js';
import { createSessionStore } from '../data/sessions.js';
import { getDefaultConfig } from '../data/config.js';

vi.mock('@discordjs/opus', () => ({ default: { OpusEncoder: class {
  encode(b: Buffer) { return b; } decode(b: Buffer) { return b; }
} } }));
const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.useRealTimers();
});

it.each(['revoked', 'expired'])('cleanup terminates %s sockets removed from the broadcast set but still tracked by WSS', async reason => {
  vi.useFakeTimers();
  const wss: any = Object.assign(new EventEmitter(), { clients: new Set() });
  const manager: any = Object.assign(new EventEmitter(), { getAllBots: () => [] });
  const controller = setupWebSocket(wss, manager, logger, () => reason !== 'expired');
  cleanups.push(controller.cleanup);
  const ws: any = Object.assign(new EventEmitter(), {
    userId: 'fixture-user', readyState: WebSocket.OPEN, send: vi.fn(), ping: vi.fn(),
    close: vi.fn(() => { ws.readyState = WebSocket.CLOSING; }),
    terminate: vi.fn(() => { ws.readyState = WebSocket.CLOSED; wss.clients.delete(ws); }),
  });
  wss.clients.add(ws); wss.emit('connection', ws);
  if (reason === 'revoked') controller.closeUserSockets('fixture-user');
  else await vi.advanceTimersByTimeAsync(30_000);
  expect(ws.readyState).toBe(WebSocket.CLOSING);
  expect(wss.clients.has(ws)).toBe(true);
  controller.cleanup();
  expect(ws.terminate).toHaveBeenCalledTimes(1);
  expect(wss.clients.size).toBe(0);
});

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`operation did not complete within ${ms}ms`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** A real upgraded TCP client that reads frames but deliberately NEVER answers Close. */
async function nonResponsiveWebSocket(port: number, cookie: string) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  cleanups.push(() => { socket.destroy(); });
  let bytes: Buffer = Buffer.alloc(0), upgraded = false;
  let accept!: () => void, rejectUpgrade!: (err: Error) => void, receivedClose!: (code: number) => void;
  const ready = new Promise<void>((resolve, reject) => { accept = resolve; rejectUpgrade = reject; });
  const closeFrame = new Promise<number>(resolve => { receivedClose = resolve; });
  socket.on('error', err => { if (!upgraded) rejectUpgrade(err); });
  socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    if (!upgraded) {
      const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) return;
      const headers = bytes.subarray(0, end).toString('utf8');
      if (!headers.startsWith('HTTP/1.1 101 ')) { rejectUpgrade(new Error(headers)); return; }
      bytes = bytes.subarray(end + 4); upgraded = true; accept();
    }
    while (bytes.length >= 2) {
      const opcode = bytes[0] & 0x0f;
      let size = bytes[1] & 0x7f, offset = 2;
      if (size === 126) { if (bytes.length < 4) return; size = bytes.readUInt16BE(2); offset = 4; }
      else if (size === 127) { if (bytes.length < 10) return; size = Number(bytes.readBigUInt64BE(2)); offset = 10; }
      if (bytes.length < offset + size) return;
      const payload = bytes.subarray(offset, offset + size);
      bytes = bytes.subarray(offset + size);
      if (opcode === 8) receivedClose(payload.length >= 2 ? payload.readUInt16BE(0) : 1005);
      // Intentionally no close acknowledgement, ping response or FIN.
    }
  });
  socket.once('connect', () => socket.write([
    'GET /ws HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: Zml4dHVyZXdlYnNvY2tldA==',
    `Origin: http://127.0.0.1:${port}`, `Cookie: ${cookie}`, '', '',
  ].join('\r\n')));
  await within(ready, 1000);
  return { socket, closeFrame };
}

it('real server stops promptly with a revoked WS peer that never answers Close, plus idle HTTP keep-alive', async () => {
  const db = createDatabase(':memory:'); cleanups.push(() => db.close());
  const manager: any = Object.assign(new EventEmitter(), { getAllBots: () => [], getBot: () => undefined });
  const provider: any = { platform: 'netease', getCookie: () => '', getQuality: () => 'standard' };
  const servers = vi.spyOn(http, 'createServer');
  const web = createWebServer({ port: 0, botManager: manager, database: db, config: getDefaultConfig(),
    configPath: 'unused-shutdown-fixture-config.json', logger, avatarStore: {} as any,
    neteaseProvider: provider, qqProvider: provider, bilibiliProvider: provider, localProvider: provider,
    kugouProvider: provider, spotifyProvider: provider, jellyfinProvider: provider });
  cleanups.push(() => web.stop());
  const server = servers.mock.results[0].value as http.Server;
  await web.start();
  const port = (server.address() as net.AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const users = createUserStore(db.db), sessions = createSessionStore(db.db);
  const user = await users.createUser('shutdown_fixture', 'fixture-password', 'admin');
  const cookie = `tsmb_session=${sessions.createSession(user.id).token}`;
  const peer = await nonResponsiveWebSocket(port, cookie);
  const logout = await fetch(`${base}/api/session/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: base } });
  expect(logout.status).toBe(204);
  expect(await within(peer.closeFrame, 1000)).toBe(4009);
  // This client consumed the server's Close frame but never echoed it or ended TCP.
  expect(peer.socket.destroyed).toBe(false);
  const health = await fetch(`${base}/api/health`); expect(health.status).toBe(200); await health.json();
  const stopping = web.stop();
  try {
    await within(stopping, 1000);
    expect(server.listening).toBe(false);
  } finally {
    // The unfixed implementation stalls until this forced client teardown;
    // keep the regression bounded instead of waiting ws's 30-second timeout.
    peer.socket.destroy();
    await stopping;
  }
}, 10_000);
