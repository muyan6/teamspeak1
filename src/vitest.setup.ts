import { isNativeOpusEncoderAvailable, setOpusEncoderClassForTests } from "./audio/encoder.js";

/**
 * Keep the suite runnable on a machine whose `@discordjs/opus` native addon was
 * built for a different Node ABI (a very common local setup: `node_modules` is
 * installed under one Node major and tests are run under another).
 *
 * The addon is loaded through a real `require`, so `vi.mock("@discordjs/opus")`
 * cannot intercept it; without this every suite that builds an AudioPlayer (and
 * therefore a BotInstance) fails for an environmental reason rather than the
 * behaviour under test.
 *
 * This is a FALLBACK ONLY: when the real addon is loadable — which is the case
 * in CI and in production — nothing is overridden and encoding tests exercise
 * the genuine implementation.
 */
if (!isNativeOpusEncoderAvailable()) {
  setOpusEncoderClassForTests(
    class {
      encode(_pcm: Buffer): Buffer { return Buffer.alloc(100); }
      decode(_opus: Buffer): Buffer { return Buffer.alloc(3840); }
      applyEncoderCTL(): void {}
      setBitrate(): void {}
    },
  );
}
