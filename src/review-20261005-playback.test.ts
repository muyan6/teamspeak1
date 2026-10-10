// Correct-behavior regressions for playback findings PB01-PB05 and the lease guard.
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

vi.mock('@discordjs/opus', () => ({ default: { OpusEncoder: class {
  encode(b: Buffer) { return b; } decode(b: Buffer) { return b; }
} } }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<any>();
  return { ...actual, spawn: vi.fn(() => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new PassThrough(); child.kill = vi.fn(); child.unref = vi.fn();
    return child;
  }) };
});
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';

/**
 * Promise-based spawn collecting stdout/stderr, run through the REAL
 * `spawn` implementation passed in (this file mocks node:child_process).
 *
 * PB02's live powershell check used to be `spawnSync`, but its SYNCHRONOUS
 * pipe setup can fail with EBUSY on every single call on some Windows
 * configurations (observed machine-wide, across Node 22 and 24, while async
 * `spawn` with the same pipes kept working). Going through async `spawn`
 * behaves identically everywhere.
 */
interface CollectResult {
  status: number | null;
  stdout: Buffer | string;
  stderr: string;
}

function spawnCollect(
  spawnFn: typeof spawn,
  cmd: string,
  args: string[],
  opts: SpawnOptions & { encoding?: 'utf8' } = {},
): Promise<CollectResult> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (status) => {
      const stdout = Buffer.concat(out);
      resolve({
        status,
        stdout: opts.encoding === 'utf8' ? stdout.toString('utf8') : stdout,
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

import { BotInstance } from './bot/instance.js';
import { AudioPlayer } from './audio/player.js';
import { PlayMode } from './audio/queue.js';
import { createDatabase } from './data/database.js';
import { getDefaultConfig } from './data/config.js';
import { parseCommand } from './bot/commands.js';

const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const song = (id: string): any => ({ id, platform: 'netease', name: id, artist: 'artist', album: '', coverUrl: '', duration: 120 });
function fixture(canRun?: () => boolean) {
  const db = createDatabase(':memory:'); cleanups.push(() => db.close());
  const config = getDefaultConfig(); config.autoSourceFallback = false;
  const provider: any = {
    platform: 'netease', getSongUrl: vi.fn(async (id: string) => ({ url: `fixture:${id}` })),
    search: vi.fn(async () => ({ songs: [song('late-song')] })),
  };
  const b: any = new BotInstance({
    id: 'review-bot', name: 'review-bot', tsOptions: { host: '127.0.0.1', port: 9987, queryPort: 10011, nickname: 'review-bot' },
    neteaseProvider: provider, qqProvider: provider, bilibiliProvider: provider, youtubeProvider: provider,
    database: db, config, logger, avatarStore: { read() { return null; } } as any,
    canRun,
  });
  b.connected = true;
  vi.spyOn(b.profileManager, 'onSongChange').mockResolvedValue(undefined);
  vi.spyOn(b.player, 'play').mockImplementation((...args: unknown[]) => { b.player.state = 'playing'; b.player.currentUrl = args[0]; return true; });
  b.preFetchNextTrack = () => {};
  cleanups.push(() => { b.disconnect(); b.removeAllListeners(); });
  return { b, db, config, provider };
}

it.each(['add', 'playnext'])('PB01: cancelled !%s leaves the cleared queue empty', async command => {
  const { b, provider } = fixture();
  const entered = deferred(), search = deferred();
  provider.search.mockImplementation(() => { entered.resolve(null); return search.promise; });
  const pending = b.executeCommand(parseCommand(`!${command} delayed`, '!'));
  await entered.promise;
  await b.executeCommand(parseCommand('!stop', '!'));
  expect(b.queue.size()).toBe(0);
  search.resolve({ songs: [song('late-song')] });
  await expect(pending).rejects.toMatchObject({ status: 409 });
  expect(b.queue.list()).toEqual([]);
  expect(b.player.getState()).toBe('idle');
  expect(provider.getSongUrl).not.toHaveBeenCalled();
});

it.each([false, true])('PB03: download completion preserves the latest transport state (startPaused=%s)', startPaused => {
  vi.useFakeTimers(); vi.stubEnv('FFMPEG_PATH', 'fixture-ffmpeg');
  vi.mocked(spawn).mockClear();
  const p: any = new AudioPlayer(logger); cleanups.push(() => p.stop());
  p.playViaPowerShellDownload('https://fixture.invalid/jdymusic/song.mp3', 0, p.sessionId, startPaused);
  const download: any = vi.mocked(spawn).mock.results[0].value;
  if (startPaused) p.resume(); else p.pause();
  const latestState = p.getState();
  download.emit('exit', 0, null);
  expect(p.getState()).toBe(latestState);
});

it('PB04: failed previous-track lookup stops the old audio and publishes idle', async () => {
  const { b, provider } = fixture();
  b.queue.addMany([song('a'), song('b')]); b.queue.play();
  b.queue.next(); await b.resolveAndPlay(b.queue.current());
  provider.getSongUrl.mockResolvedValue(null);
  b.urlCache.clear();
  const stateChange = vi.fn(); b.on('stateChange', stateChange);
  const response = await b.executeCommand(parseCommand('!prev', '!'));
  expect(b.queue.current().id).toBe('a');
  expect(b.player.currentUrl).toBe('');
  expect(b.player.getState()).toBe('idle');
  expect(b.profileManager.onSongChange).toHaveBeenLastCalledWith(null);
  expect(stateChange).toHaveBeenCalled();
  expect(response).toContain('failed to resolve');
});

it.each([PlayMode.Loop, PlayMode.RandomLoop])('PB05: open FFmpeg circuit stops automatic %s advance and false history', async mode => {
  const { b, db } = fixture();
  vi.mocked(b.player.play).mockRestore(); // Exercise real AudioPlayer.play and real BotInstance event wiring.
  vi.mocked(b.profileManager.onSongChange).mockRestore();
  b.profileManager.updateConfig({ avatarEnabled: false, descriptionEnabled: false,
    nicknameEnabled: false, awayStatusEnabled: false, channelDescEnabled: false, nowPlayingMsgEnabled: false });
  b.queue.add(song('bad-stream')); b.queue.setMode(mode); b.queue.play();
  b.player.consecutiveFailures = 3; // State reached after three real FFmpeg failures.
  let errors = 0, timerRan = false;
  const timerDone = deferred();
  const timer = setTimeout(() => { timerRan = true; timerDone.resolve(null); }, 0);
  cleanups.push(() => clearTimeout(timer));
  b.player.on('error', () => {
    errors++;
    if (errors === 100) b.connected = false; // Bounds failure when running this against unfixed code.
  });
  const started = await b.runExclusive(() => b.resolveAndPlay(b.queue.current()));
  await timerDone.promise;
  await b.runExclusive(async () => {});
  expect(started).toBe(false);
  expect(errors).toBeLessThanOrEqual(1);
  expect(timerRan).toBe(true);
  expect(db.getPlayHistory(b.id, 200)).toHaveLength(0);
  expect(b.player.getState()).toBe('idle');
  expect(b.connected).toBe(true);
});

it('PB02: generated downloader initializes HttpClient in a fresh Windows PowerShell process', async () => {
  vi.mocked(spawn).mockClear();
  const p: any = new AudioPlayer(logger); cleanups.push(() => p.stop());
  p.playViaPowerShellDownload('https://fixture.invalid/jdymusic/song.mp3', 0, p.sessionId, false);
  const args = vi.mocked(spawn).mock.calls[0][1] as string[];
  const script = args[args.indexOf('-Command') + 1];
  expect(script.indexOf('Add-Type -AssemblyName System.Net.Http')).toBeGreaterThanOrEqual(0);
  expect(script.indexOf('Add-Type -AssemblyName System.Net.Http')).toBeLessThan(script.indexOf('New-Object System.Net.Http.HttpClient'));
  if (process.platform === 'win32') {
    // Run only construction/disposal: never execute the URL/download portion.
    const prefix = script.slice(0, script.indexOf('$client.Timeout'));
    const { spawn: realSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const result = await spawnCollect(
      realSpawn,
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', prefix + '$client.Dispose(); Write-Output HTTPCLIENT_CREATED'],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('HTTPCLIENT_CREATED');
  }
});

it('PB01: add reports a failed initial URL instead of Now playing', async () => {
  const { b, provider } = fixture(); provider.getSongUrl.mockResolvedValue(null);
  expect(await b.executeCommand(parseCommand('!add unavailable', '!'))).toContain('Cannot play');
  expect(b.player.getState()).toBe('idle');
});

it('PB04: previous at the start of the queue does not stop the existing song', async () => {
  const { b } = fixture(); b.queue.add(song('a')); b.queue.play(); await b.resolveAndPlay(b.queue.current());
  expect(await b.executeCommand(parseCommand('!prev', '!'))).toBe('No previous song');
  expect(b.player.currentUrl).toBe('fixture:a');
});

it('PB04: previous-track resolution cancelled by stop does not walk another queue entry', async () => {
  const { b, provider } = fixture();
  b.queue.addMany([song('a'), song('b'), song('c')]); b.queue.play(); b.queue.next(); b.queue.next();
  await b.resolveAndPlay(b.queue.current());
  const entered = deferred(), lookup = deferred();
  provider.getSongUrl.mockImplementation(() => { entered.resolve(null); return lookup.promise; });
  const pending = b.executeCommand(parseCommand('!prev', '!'));
  await entered.promise;
  await b.executeCommand(parseCommand('!stop', '!'));
  lookup.resolve(null);
  await expect(pending).rejects.toMatchObject({ status: 409 });
  expect(b.queue.size()).toBe(0); expect(b.player.getState()).toBe('idle');
});

it('PB05: explicit play resets a previously open backend circuit', async () => {
  vi.useFakeTimers(); vi.stubEnv('FFMPEG_PATH', 'fixture-ffmpeg');
  const { b, db } = fixture(); vi.mocked(b.player.play).mockRestore();
  b.player.consecutiveFailures = 3;
  const started = await b.runExclusive(() => b.playSingleSong(song('recovery')));
  expect(started).toBe(true); expect(b.player.getState()).toBe('playing');
  expect(b.player.consecutiveFailures).toBe(0);
  expect(db.getPlayHistory(b.id, 10)).toHaveLength(1);
});

it('PB05: three actual startup failure events reach a bounded circuit-open stop', async () => {
  vi.useFakeTimers(); vi.stubEnv('FFMPEG_PATH', 'fixture-ffmpeg'); vi.mocked(spawn).mockClear();
  const { b } = fixture(); vi.mocked(b.player.play).mockRestore();
  b.queue.add(song('bad-stream')); b.queue.setMode(PlayMode.Loop); b.queue.play();
  await b.runExclusive(() => b.resolveAndPlay(b.queue.current()));
  let errors = 0;
  b.player.on('error', () => { if (++errors > 10) b.connected = false; });
  for (let failure = 0; failure < 3; failure++) {
    const processes = vi.mocked(spawn).mock.results;
    const child = processes[processes.length - 1].value as EventEmitter;
    child.emit('exit', 1, null);
    await b.runExclusive(async () => {});
  }
  await b.runExclusive(async () => {});
  expect(errors).toBe(4); // Three failed spawns, then one fatal circuit-open signal.
  expect(vi.mocked(spawn)).toHaveBeenCalledTimes(3);
  expect(b.connected).toBe(true); expect(b.player.getState()).toBe('idle');
});

it('lease: rejected connect never begins a handshake', async () => {
  const { b } = fixture(() => false);
  const handshake = vi.spyOn(b.tsClient, 'connect').mockResolvedValue(undefined);
  await expect(b.connect()).rejects.toThrow('not permitted');
  expect(handshake).not.toHaveBeenCalled(); expect(b.connected).toBe(false);
});

it('lease: expiration during handshake disconnects rather than publishing connected', async () => {
  let allowed = true;
  const { b } = fixture(() => allowed); b.connected = false;
  const handshake = deferred(); vi.spyOn(b.tsClient, 'connect').mockImplementation(() => handshake.promise);
  const connected = vi.fn(); b.on('connected', connected);
  const pending = b.connect(); allowed = false; handshake.resolve(null);
  await expect(pending).rejects.toThrow('not permitted');
  expect(connected).not.toHaveBeenCalled(); expect(b.connected).toBe(false);
});

it('lease: rejected automatic reconnect neither schedules nor handshakes', async () => {
  vi.useFakeTimers();
  const { b } = fixture(() => false); b.connected = false;
  const connect = vi.spyOn(b, 'connect').mockResolvedValue(undefined);
  b.scheduleAutoReconnect(1);
  await b._attemptAutoReconnect(); await vi.advanceTimersByTimeAsync(60_000);
  expect(connect).not.toHaveBeenCalled(); expect(b.isReconnecting()).toBe(false);
});

it.each(['before', 'during'])('lease: denied %s URL lookup never starts playback', async when => {
  let allowed = when !== 'before';
  const { b, provider } = fixture(() => allowed);
  const lookup = deferred(); provider.getSongUrl.mockImplementation(() => lookup.promise);
  b.queue.add(song('a')); b.queue.play();
  const pending = b.resolveAndPlay(b.queue.current()); allowed = false;
  lookup.resolve({ url: 'fixture:a' });
  expect(await pending).toBe(false); expect(b.player.play).not.toHaveBeenCalled();
});
