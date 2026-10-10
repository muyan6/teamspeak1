import { createRequire } from "node:module";
import type { Logger } from "../logger.js";

const require = createRequire(import.meta.url);

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20;
export const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960 samples
export const PCM_FRAME_BYTES = FRAME_SIZE * CHANNELS * 2; // 3840 bytes (16-bit stereo)

/**
 * Opus encoder control request codes.
 *
 * These are NOT arbitrary: they come from
 * `@discordjs/opus/deps/opus/include/opus_defines.h`.
 *   OPUS_SET_APPLICATION_REQUEST   = 4000
 *   OPUS_SET_BITRATE_REQUEST       = 4002
 *   OPUS_SET_MAX_BANDWIDTH_REQUEST = 4004
 *   OPUS_APPLICATION_AUDIO         = 2049
 *
 * Mixing up 4000 and 4004 makes `opus_encoder_ctl` reject the value (2049 is
 * outside the valid bandwidth range 1101..1105), which throws a TypeError from
 * the native binding. That is why the calls below must stay in separate
 * try blocks — a failed application-mode call must never skip the bitrate call.
 */
export const OPUS_SET_APPLICATION_REQUEST = 4000;
export const OPUS_APPLICATION_AUDIO = 2049;
export const OPUS_DEFAULT_BITRATE = 128000;

export interface Encoder {
  encode(pcm: Buffer): Buffer;
  decode(opus: Buffer): Buffer;
}

interface OpusEncoderInstance {
  encode(pcm: Buffer): Buffer;
  decode(opusData: Buffer): Buffer;
}

interface OpusEncoderConstructor {
  new (sampleRate: number, channels: number): OpusEncoderInstance;
}

/** Minimal shape needed to configure an Opus encoder instance. */
export interface OpusCtlTarget {
  applyEncoderCTL?: (ctl: number, value: number) => void;
  setBitrate?: (bitrate: number) => void;
}

/**
 * Switch an Opus encoder to the music-tuned configuration (application=AUDIO,
 * 128 kbps).
 *
 * Each control call is isolated in its own try so that a binding which rejects
 * one cannot silently skip the other, and every failure is reported through
 * `onError` instead of being swallowed. Exported for unit testing.
 */
export function applyMusicEncoderSettings(
  opus: OpusCtlTarget,
  onError?: (message: string, err: unknown) => void,
): void {
  if (typeof opus.applyEncoderCTL === "function") {
    try {
      opus.applyEncoderCTL(OPUS_SET_APPLICATION_REQUEST, OPUS_APPLICATION_AUDIO);
    } catch (err) {
      onError?.("Opus OPUS_SET_APPLICATION(AUDIO) failed", err);
    }
  }
  if (typeof opus.setBitrate === "function") {
    try {
      opus.setBitrate(OPUS_DEFAULT_BITRATE);
    } catch (err) {
      onError?.("Opus setBitrate failed", err);
    }
  }
}

let cachedOpusEncoderClass: OpusEncoderConstructor | null = null;

/** Raw `require` of the native addon, with no cache or test override applied. */
function loadNativeOpusEncoderClass(): OpusEncoderConstructor | null {
  try {
    const mod = require("@discordjs/opus");
    const Cls = (mod?.OpusEncoder ?? mod?.default?.OpusEncoder ?? mod) as OpusEncoderConstructor;
    if (typeof Cls === "function") return Cls;
  } catch {
    // Native addon not available in current environment (e.g. ABI mismatch or missing build tools)
  }
  return null;
}

/**
 * True when the real native addon is loadable in this process (i.e. it was built
 * for the running Node ABI). Used to decide whether encoding tests can run for
 * real or must be skipped, and whether the test stub should be installed.
 */
export function isNativeOpusEncoderAvailable(): boolean {
  return loadNativeOpusEncoderClass() !== null;
}

function loadOpusEncoderClass(): OpusEncoderConstructor | null {
  if (cachedOpusEncoderClass) return cachedOpusEncoderClass;
  const Cls = loadNativeOpusEncoderClass();
  if (Cls) cachedOpusEncoderClass = Cls;
  return Cls;
}

/**
 * Test seam.
 *
 * A `.node` addon is loaded through a real `require`, so a module mock
 * (`vi.mock("@discordjs/opus")`) cannot intercept it. Without this hook every
 * test that constructs an AudioPlayer fails on a machine whose addon was built
 * for a different Node ABI, instead of exercising the player logic they target.
 */
export function setOpusEncoderClassForTests(
  cls: (new (sampleRate: number, channels: number) => OpusEncoderInstance & OpusCtlTarget) | null,
): void {
  cachedOpusEncoderClass = cls as OpusEncoderConstructor | null;
}

export function createOpusEncoder(logger?: Logger): Encoder {
  const OpusEncoderClass = loadOpusEncoderClass();
  if (OpusEncoderClass) {
    const opus = new OpusEncoderClass(SAMPLE_RATE, CHANNELS) as OpusEncoderInstance & OpusCtlTarget;
    applyMusicEncoderSettings(opus, (message, err) => {
      // Never swallow silently: a wrong ctl constant quietly degrades every
      // track to VOIP-mode encoding, which is otherwise very hard to notice.
      logger?.warn({ err }, message);
    });
    return {
      encode(pcm: Buffer): Buffer {
        return opus.encode(pcm);
      },
      decode(opusData: Buffer): Buffer {
        return opus.decode(opusData);
      },
    };
  }

  throw new Error('Opus native encoder is missing or incompatible; run scripts/setup.bat or scripts/setup.sh');
}
