import assert from 'node:assert/strict';
import { spawnSync, fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import net from 'node:net';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { getDefaultConfig, saveConfig } from '../dist/data/config.js';
import { getFfmpegCommand } from '../dist/audio/player.js';
import { createOpusEncoder, PCM_FRAME_BYTES } from '../dist/audio/encoder.js';

const ffmpeg = spawnSync(getFfmpegCommand(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { windowsHide: true });
assert.equal(ffmpeg.status, 0, ffmpeg.stderr?.toString());
const encoder = createOpusEncoder(); let frames = 0, decodedBytes = 0;
for (let offset = 0; offset + PCM_FRAME_BYTES <= ffmpeg.stdout.length; offset += PCM_FRAME_BYTES) {
  const encoded = encoder.encode(ffmpeg.stdout.subarray(offset, offset + PCM_FRAME_BYTES));
  assert.ok(encoded.length > 0 && encoded.length < PCM_FRAME_BYTES);
  const decoded = encoder.decode(encoded); assert.equal(decoded.length, PCM_FRAME_BYTES);
  decodedBytes += decoded.length; frames++;
}
assert.equal(frames, 5);
console.log(`NATIVE_SMOKE opusFrames=${frames} decodedBytes=${decodedBytes} ffmpegExit=${ffmpeg.status}`);

const dir = mkdtempSync(join(tmpdir(), 'tsmusicbot-app-smoke-'));
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const config = getDefaultConfig(); config.webPort = port; config.enabledProviders = [];
saveConfig(join(dir, 'config.json'), config);
let child, output = '', sockets = [];
const base = `http://127.0.0.1:${port}`;
const deadline = async (promise, ms = 5000) => {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('smoke timed out')), ms); })]); }
  finally { clearTimeout(timer); }
};
async function call(route, cookie, body) {
  return fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
}
function cookieOf(res) { return res.headers.get('set-cookie').split(';')[0]; }
async function socket(cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie, Origin: base } }); sockets.push(ws);
  const init = once(ws, 'message'); await deadline(once(ws, 'open')); await deadline(init); return ws;
}
try {
  child = fork(resolve('dist/index.js'), [], { silent: true, env: { ...process.env, NODE_ENV: 'production', TSMB_DATA_DIR: dir } });
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  let health;
  for (let i = 0; i < 100; i++) {
    try { health = await call('/api/health'); if (health.ok) break; } catch {}
    if (child.exitCode !== null) throw new Error(output);
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(health?.status, 200, output);
  const setup = await call('/api/session/setup', null, { username: 'smoke_admin', password: 'smoke-old-password' }); assert.equal(setup.status, 200);
  const currentCookie = cookieOf(setup);
  const login = await call('/api/session/login', null, { username: 'smoke_admin', password: 'smoke-old-password' }); assert.equal(login.status, 200);
  const oldCookie = cookieOf(login), current = await socket(currentCookie), old = await socket(oldCookie);
  const oldClosed = once(old, 'close');
  const changed = await call('/api/session/change-password', currentCookie, { oldPassword: 'smoke-old-password', newPassword: 'smoke-new-password' }); assert.equal(changed.status, 204);
  const [closeCode] = await deadline(oldClosed); assert.equal(closeCode, 4009);
  const oldMe = await call('/api/session/me', oldCookie); assert.equal(oldMe.status, 401);
  assert.equal((await call('/api/session/me', currentCookie)).status, 200);
  assert.equal(current.readyState, WebSocket.OPEN);
  const exit = once(child, 'exit'); child.send({ type: 'shutdown' });
  const [exitCode] = await deadline(exit, 7000); assert.equal(exitCode, 0, output);
  console.log('APP_SMOKE health=200 setup=200 passwordChange=204 oldSession=401 oldSocket=4009 retainedSocket=OPEN shutdownExit=0');
} finally {
  for (const ws of sockets) ws.terminate();
  if (child && child.exitCode === null) { child.kill(); await deadline(once(child, 'exit')).catch(() => {}); }
  // Only the directory returned by mkdtempSync is removed, never app data.
  rmSync(dir, { recursive: true, force: true });
}
