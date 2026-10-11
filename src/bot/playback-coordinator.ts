import { AsyncLocalStorage } from 'node:async_hooks';

export class PlaybackCancelledError extends Error {
  readonly status = 409;
  constructor() { super('Playback operation cancelled'); }
}

/** A queued playback operation exceeded its budget and was abandoned. */
export class PlaybackTimeoutError extends Error {
  readonly status = 504;
  constructor(ms: number) { super(`Playback operation timed out after ${ms}ms`); }
}

interface PlaybackRunToken {
  epoch: number;
  valid: boolean;
}

/**
 * One queue for all playback entry points; stop invalidates active and queued work.
 *
 * Every entry point (play / next / prev / resume, plus the web API and the chat
 * command handler) funnels through `run`, so a single task that never settles —
 * a provider HTTP call that hangs, a sidecar that stops answering — used to
 * block the promise chain forever, and every later operation queued behind it
 * with no way out. `timeoutMs` bounds that: the offending task is abandoned with
 * a PlaybackTimeoutError and the chain advances so the next operation can still
 * run. The abandoned task itself cannot be cancelled from here; its run token
 * is invalidated so existing `isCurrent()` / `assertCurrent()` checkpoints
 * reject any late continuation before it mutates playback state.
 */
export class PlaybackCoordinator {
  /** Generous by default: a real play may legitimately resolve a URL and spawn
   *  ffmpeg across several provider calls. This is a deadlock breaker, not an SLA. */
  static readonly DEFAULT_TIMEOUT_MS = 120_000;

  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<PlaybackRunToken>();

  constructor(private readonly timeoutMs: number = PlaybackCoordinator.DEFAULT_TIMEOUT_MS) {}

  cancel(): void { this.epoch++; }
  ticket(): () => boolean { const epoch = this.epoch; return () => epoch === this.epoch; }
  isCurrent(): boolean {
    const token = this.context.getStore();
    return token === undefined || (token.valid && token.epoch === this.epoch);
  }
  assertCurrent(): void { if (!this.isCurrent()) throw new PlaybackCancelledError(); }
  run<T>(task: () => Promise<T>): Promise<T> {
    const ticket = this.epoch;
    const token: PlaybackRunToken = { epoch: ticket, valid: true };
    const next = this.tail.then(() => {
      if (ticket !== this.epoch) throw new PlaybackCancelledError();
      return this.withTimeout(this.context.run(token, task), token);
    });
    // Swallow here only: `tail` must always settle so a rejected (or timed-out)
    // task never poisons the chain. The caller still receives `next`.
    this.tail = next.catch(() => {});
    return next;
  }

  private withTimeout<T>(work: Promise<T>, token: PlaybackRunToken): Promise<T> {
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) return work;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Keep the queue moving, but poison only this operation. A global epoch
        // bump would also cancel work already queued behind this timeout.
        token.valid = false;
        reject(new PlaybackTimeoutError(this.timeoutMs));
      }, this.timeoutMs);
      timer.unref?.();
      work.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }
}
