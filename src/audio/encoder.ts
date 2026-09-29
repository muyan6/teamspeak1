import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20;
export const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960 samples
export const PCM_FRAME_BYTES = FRAME_SIZE * CHANNELS * 2; // 3840 bytes (16-bit stereo)

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

let cachedOpusEncoderClass: OpusEncoderConstructor | null = null;
let loadAttempted = false;

function loadOpusEncoderClass(): OpusEncoderConstructor | null {
  if (cachedOpusEncoderClass) return cachedOpusEncoderClass;
  loadAttempted = true;
  try {
    const mod = require("@discordjs/opus");
    const Cls = (mod?.OpusEncoder ?? mod?.default?.OpusEncoder ?? mod) as OpusEncoderConstructor;
    if (typeof Cls === "function") {
      cachedOpusEncoderClass = Cls;
      return Cls;
    }
  } catch {
    // Native addon not available in current environment (e.g. ABI mismatch or missing build tools)
  }
  return null;
}

export function createOpusEncoder(): Encoder {
  const OpusEncoderClass = loadOpusEncoderClass();
  if (OpusEncoderClass) {
    const opus = new OpusEncoderClass(SAMPLE_RATE, CHANNELS);
    try {
      if (typeof (opus as any).applyEncoderCTL === "function") {
        // OPUS_SET_APPLICATION_REQUEST (4004), OPUS_APPLICATION_AUDIO (2049) for fullband music
        (opus as any).applyEncoderCTL(4004, 2049);
      }
      if (typeof (opus as any).setBitrate === "function") {
        (opus as any).setBitrate(128000);
      }
    } catch {
      // ignore if CTL not supported by underlying native addon build
    }
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
