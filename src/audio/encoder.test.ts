import { describe, it, expect, vi } from "vitest";
import {
  createOpusEncoder,
  applyMusicEncoderSettings,
  isNativeOpusEncoderAvailable,
  OPUS_SET_APPLICATION_REQUEST,
  OPUS_APPLICATION_AUDIO,
  OPUS_DEFAULT_BITRATE,
} from "./encoder.js";

// These two exercise the genuine native encoder, so they can only run where the
// addon matches the running Node ABI. Skip (rather than fail) elsewhere — the
// rest of the suite uses the stub installed by src/vitest.setup.ts.
const hasNativeOpus = isNativeOpusEncoderAvailable();

describe("OpusEncoder", () => {
  it.skipIf(!hasNativeOpus)("encodes PCM buffer to Opus frame", () => {
    const encoder = createOpusEncoder();
    // 20ms of silence at 48kHz stereo = 960 frames * 2 channels * 2 bytes = 3840 bytes
    const silence = Buffer.alloc(3840, 0);
    const opus = encoder.encode(silence);
    expect(opus).toBeInstanceOf(Buffer);
    expect(opus.length).toBeGreaterThan(0);
    expect(opus.length).toBeLessThan(3840);
  });

  it.skipIf(!hasNativeOpus)("decodes Opus frame back to PCM", () => {
    const encoder = createOpusEncoder();
    const silence = Buffer.alloc(3840, 0);
    const opus = encoder.encode(silence);
    const pcm = encoder.decode(opus);
    expect(pcm).toBeInstanceOf(Buffer);
    expect(pcm.length).toBe(3840);
  });
});

describe("applyMusicEncoderSettings", () => {
  // Regression guard for the ctl-constant mix-up: OPUS_SET_APPLICATION_REQUEST
  // is 4000, not 4004 (4004 = OPUS_SET_MAX_BANDWIDTH_REQUEST). Passing 4004 with
  // 2049 makes opus_encoder_ctl reject the value, and because the old code kept
  // both calls in ONE try block the bitrate call never ran.
  it("uses OPUS_SET_APPLICATION_REQUEST (4000) with OPUS_APPLICATION_AUDIO (2049)", () => {
    const applyEncoderCTL = vi.fn();
    const setBitrate = vi.fn();

    applyMusicEncoderSettings({ applyEncoderCTL, setBitrate });

    expect(applyEncoderCTL).toHaveBeenCalledWith(OPUS_SET_APPLICATION_REQUEST, OPUS_APPLICATION_AUDIO);
    expect(OPUS_SET_APPLICATION_REQUEST).toBe(4000);
    expect(OPUS_APPLICATION_AUDIO).toBe(2049);
    expect(applyEncoderCTL).not.toHaveBeenCalledWith(4004, expect.anything());
  });

  it("still applies the bitrate when the application ctl throws", () => {
    const applyEncoderCTL = vi.fn(() => {
      throw new TypeError("Invalid ctl / value");
    });
    const setBitrate = vi.fn();
    const onError = vi.fn();

    applyMusicEncoderSettings({ applyEncoderCTL, setBitrate }, onError);

    expect(setBitrate).toHaveBeenCalledWith(OPUS_DEFAULT_BITRATE);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("reports a failing setBitrate without throwing", () => {
    const applyEncoderCTL = vi.fn();
    const setBitrate = vi.fn(() => {
      throw new RangeError("bad bitrate");
    });
    const onError = vi.fn();

    expect(() => applyMusicEncoderSettings({ applyEncoderCTL, setBitrate }, onError)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("tolerates a binding that exposes neither method", () => {
    expect(() => applyMusicEncoderSettings({})).not.toThrow();
  });
});

