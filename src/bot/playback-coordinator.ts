import { AsyncLocalStorage } from 'node:async_hooks';

export class PlaybackCancelledError extends Error {
  readonly status = 409;
  constructor() { super('Playback operation cancelled'); }
}

/** One queue for all playback entry points; stop invalidates active and queued work. */
export class PlaybackCoordinator {
  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<number>();

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
      return this.context.run(ticket, task);
    });
    this.tail = next.catch(() => {});
    return next;
  }
}
