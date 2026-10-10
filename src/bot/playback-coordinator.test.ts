import { describe, it, expect } from "vitest";
import {
  PlaybackCoordinator,
  PlaybackCancelledError,
  PlaybackTimeoutError,
} from "./playback-coordinator.js";

describe("PlaybackCoordinator", () => {
  it("serializes tasks in submission order", async () => {
    const coordinator = new PlaybackCoordinator();
    const order: string[] = [];
    const a = coordinator.run(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("a");
    });
    const b = coordinator.run(async () => { order.push("b"); });
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });

  it("cancels queued work but lets an already-running task finish", async () => {
    const coordinator = new PlaybackCoordinator();
    let markStarted!: () => void;
    const started = new Promise<void>((r) => { markStarted = r; });
    const slow = coordinator.run(async () => {
      markStarted();
      await new Promise((r) => setTimeout(r, 20));
      return "slow";
    });
    const queued = coordinator.run(async () => "queued");
    // Wait until `slow` is genuinely in flight: cancel() only rejects work that
    // has not started yet (a running task is expected to observe the epoch via
    // assertCurrent() itself — see review-20261001-hardening.test.ts).
    await started;
    coordinator.cancel();
    await expect(queued).rejects.toBeInstanceOf(PlaybackCancelledError);
    await expect(slow).resolves.toBe("slow");
  });

  it("rejects a task that never got to start before cancel()", async () => {
    const coordinator = new PlaybackCoordinator();
    const queued = coordinator.run(async () => "queued");
    coordinator.cancel();
    await expect(queued).rejects.toBeInstanceOf(PlaybackCancelledError);
  });

  // Regression guard: a task that never settles used to block `tail` forever, so
  // every later playback operation queued behind it with no escape.
  it("times out a hung task and lets the next task through", async () => {
    const coordinator = new PlaybackCoordinator(30);
    const hung = coordinator.run(() => new Promise<never>(() => {}));
    const followUp = coordinator.run(async () => "recovered");

    await expect(hung).rejects.toBeInstanceOf(PlaybackTimeoutError);
    await expect(followUp).resolves.toBe("recovered");
  });

  it("does not time out a task that finishes in time", async () => {
    const coordinator = new PlaybackCoordinator(200);
    await expect(coordinator.run(async () => 42)).resolves.toBe(42);
  });

  it("propagates a task rejection to the caller without poisoning the chain", async () => {
    const coordinator = new PlaybackCoordinator();
    const failing = coordinator.run(async () => { throw new Error("boom"); });
    await expect(failing).rejects.toThrow("boom");
    await expect(coordinator.run(async () => "still works")).resolves.toBe("still works");
  });

  it("treats timeoutMs <= 0 as 'no timeout'", async () => {
    const coordinator = new PlaybackCoordinator(0);
    await expect(coordinator.run(async () => "ok")).resolves.toBe("ok");
  });
});
