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

/**
 * One queue for all playback entry points; stop invalidates active and queued work.
 *
 * Every entry point (play / next / prev / resume, plus the web API and the chat
 * command handler) funnels through `run`, so a single task that never settles —
 * a provider HTTP call that hangs, a sidecar that stops answering — used to
 * block the promise chain forever, and every later operation queued behind it
 * with no way out. `timeoutMs` bounds that: the offending task is abandoned with
 * a PlaybackTimeoutError and the chain advances so the next operation can still
 * run. The abandoned task itself cannot be cancelled from here; callers keep
 * their own provider/socket timeouts for the underlying work.
 */
export class PlaybackCoordinator {
  /** Generous by default: a real play may legitimately resolve a URL and spawn
   *  ffmpeg across several provider calls. This is a deadlock breaker, not an SLA. */
  static readonly DEFAULT_TIMEOUT_MS = 120_000;

  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<number>();

  constructor(private readonly timeoutMs: number = PlaybackCoordinator.DEFAULT_TIMEOUT_MS) {}

  cancel(): void { this.epoch++; }
  ticket(): () => boolean { const epoch = this.epoch; return () => epoch === this.epoch; }
  isCurrent(): boolean {
    const ticket = this.context.getStore();
    return ticket === undefined || ticket === this.epoch;
  }
  assertCurrent(): void { if (!this.isCurrent()) throw new PlaybackCancelledError(); }
  run<T>(task: () => Promise<T>): Promise<T> {
    const ticket = this.epoch;
    const next = this.tail.then(() => {
      if (ticket !== this.epoch) throw new PlaybackCancelledError();
      return this.withTimeout(this.context.run(ticket, task));
    });
    // Swallow here only: `tail` must always settle so a rejected (or timed-out)
    // task never poisons the chain. The caller still receives `next`.
    this.tail = next.catch(() => {});
    return next;
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) return work;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PlaybackTimeoutError(this.timeoutMs)), this.timeoutMs);
      timer.unref?.();
      work.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }
}
