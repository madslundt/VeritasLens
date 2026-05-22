import { describe, it, expect } from 'vitest';
import {
  PcmRingBuffer,
  analyzeBufferForVoice,
  encodePcmToWav,
  uint8ToBase64,
} from '../src/runtime/audioBuffer';

/** Build a Uint8Array of LE int16 samples from a number[] of samples. */
function pcm(samples: number[] | Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    dv.setInt16(i * 2, samples[i]!, true);
  }
  return out;
}

/** Build a signal of `seconds` at 16 kHz from a per-sample function. */
function buildSignal(seconds: number, fn: (t: number) => number): Uint8Array {
  const n = seconds * 16_000;
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = fn(i / 16_000);
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return pcm(samples);
}

function decodeBase64(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }
  const nodeBuffer = (globalThis as { Buffer?: { from(input: string, enc: string): Uint8Array } }).Buffer;
  if (!nodeBuffer) throw new Error('No base64 decoder available.');
  return new Uint8Array(nodeBuffer.from(b64, 'base64'));
}

describe('PcmRingBuffer', () => {
  it('starts empty', () => {
    const buf = new PcmRingBuffer({ durationSec: 1, sampleRate: 8000 });
    expect(buf.bytesBuffered).toBe(0);
    expect(buf.secondsBuffered).toBe(0);
    expect(buf.toLinearPcm()).toEqual(new Uint8Array(0));
  });

  it('accumulates and reports seconds', () => {
    const buf = new PcmRingBuffer({ durationSec: 1, sampleRate: 8000 }); // capacity = 16000 bytes
    buf.append(new Uint8Array(8000));
    expect(buf.bytesBuffered).toBe(8000);
    expect(buf.secondsBuffered).toBeCloseTo(0.5, 5);
  });

  it('evicts oldest data when exceeding capacity', () => {
    const buf = new PcmRingBuffer({ durationSec: 1, sampleRate: 8000 }); // capacity = 16000 bytes
    const chunkA = new Uint8Array(10_000).fill(0xaa);
    const chunkB = new Uint8Array(10_000).fill(0xbb);
    buf.append(chunkA);
    buf.append(chunkB);
    expect(buf.bytesBuffered).toBe(16_000);

    const linear = buf.toLinearPcm();
    // Expected: 4000 trailing bytes of A (the last 4000), then all 10000 of B,
    // wait — total appended is 20000, capacity is 16000, so the oldest 4000
    // bytes of A are evicted; we expect 6000 bytes of A (0xaa) followed by
    // 10000 bytes of B (0xbb).
    expect(linear.length).toBe(16_000);
    expect(linear[0]).toBe(0xaa);
    expect(linear[5_999]).toBe(0xaa);
    expect(linear[6_000]).toBe(0xbb);
    expect(linear[15_999]).toBe(0xbb);
  });

  it('handles a single chunk larger than capacity by keeping only the tail', () => {
    const buf = new PcmRingBuffer({ durationSec: 1, sampleRate: 8000 }); // capacity 16000
    const chunk = new Uint8Array(20_000);
    for (let i = 0; i < chunk.length; i++) chunk[i] = i & 0xff;
    buf.append(chunk);
    expect(buf.bytesBuffered).toBe(16_000);
    const linear = buf.toLinearPcm();
    // First retained byte is at original index 4000.
    expect(linear[0]).toBe(4000 & 0xff);
    expect(linear[15_999]).toBe(19_999 & 0xff);
  });

  it('clear() resets to empty', () => {
    const buf = new PcmRingBuffer({ durationSec: 1, sampleRate: 8000 });
    buf.append(new Uint8Array(1234));
    buf.clear();
    expect(buf.bytesBuffered).toBe(0);
    expect(buf.toLinearPcm().length).toBe(0);
  });

  it('tracks bytesProduced monotonically across wraparound and clears', () => {
    const buf = new PcmRingBuffer({ durationSec: 1, sampleRate: 8000 }); // 16000-byte capacity
    expect(buf.bytesProduced).toBe(0);
    buf.append(new Uint8Array(8000));
    expect(buf.bytesProduced).toBe(8000);
    buf.append(new Uint8Array(12000));
    // Capacity is 16000 bytes but produced keeps counting every appended byte.
    expect(buf.bytesProduced).toBe(20000);
    expect(buf.bytesBuffered).toBe(16000);
    buf.clear();
    // clear() does NOT reset produced — callers tracking offsets across clear
    // would otherwise see their offset move into the "future".
    expect(buf.bytesProduced).toBe(20000);
    buf.append(new Uint8Array(1000));
    expect(buf.bytesProduced).toBe(21000);
  });

  it('linearPcmSince(offset) returns audio appended after the offset', () => {
    const buf = new PcmRingBuffer({ durationSec: 1, sampleRate: 8000 }); // 16000-byte capacity
    const first = new Uint8Array(4000).fill(0xaa);
    const second = new Uint8Array(4000).fill(0xbb);
    buf.append(first);
    const mark = buf.bytesProduced;
    buf.append(second);
    const since = buf.linearPcmSince(mark);
    expect(since.length).toBe(4000);
    expect(since[0]).toBe(0xbb);
    expect(since[since.length - 1]).toBe(0xbb);
  });

  it('linearPcmSince(offset) returns empty when no new audio has arrived', () => {
    const buf = new PcmRingBuffer({ durationSec: 1, sampleRate: 8000 });
    buf.append(new Uint8Array(4000));
    const mark = buf.bytesProduced;
    expect(buf.linearPcmSince(mark).length).toBe(0);
  });

  it('linearPcmSince(offset) caps at what is still in the ring after wraparound', () => {
    const buf = new PcmRingBuffer({ durationSec: 1, sampleRate: 8000 }); // 16000 cap
    // Stamp an offset, then append more than capacity worth of audio. The
    // bytes between the offset and "now" exceed what the ring retains.
    buf.append(new Uint8Array(1000));
    const mark = buf.bytesProduced;
    buf.append(new Uint8Array(20000).fill(0xcc));
    const since = buf.linearPcmSince(mark);
    // The full retained buffer is 16000 bytes; only that much is "since"-able.
    expect(since.length).toBe(16000);
    expect(since[0]).toBe(0xcc);
  });

  it('snapshotWav() prepends a valid 44-byte PCM/mono/16kHz header', () => {
    const buf = new PcmRingBuffer({ durationSec: 1, sampleRate: 16_000 });
    const pcm = new Uint8Array(3200); // 0.1 s of 16-bit 16kHz mono
    for (let i = 0; i < pcm.length; i++) pcm[i] = i & 0xff;
    buf.append(pcm);

    const wav = buf.snapshotWav();
    expect(wav.length).toBe(44 + 3200);

    // ASCII tags
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE');
    expect(String.fromCharCode(...wav.subarray(12, 16))).toBe('fmt ');
    expect(String.fromCharCode(...wav.subarray(36, 40))).toBe('data');

    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(dv.getUint32(4, true)).toBe(36 + 3200); // file size minus 8
    expect(dv.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(dv.getUint16(20, true)).toBe(1); // PCM
    expect(dv.getUint16(22, true)).toBe(1); // mono
    expect(dv.getUint32(24, true)).toBe(16_000); // sample rate
    expect(dv.getUint32(28, true)).toBe(32_000); // byte rate
    expect(dv.getUint16(32, true)).toBe(2); // block align
    expect(dv.getUint16(34, true)).toBe(16); // bits per sample
    expect(dv.getUint32(40, true)).toBe(3200); // data size

    // First and last data bytes preserved
    expect(wav[44]).toBe(0);
    expect(wav[44 + 3199]).toBe(3199 & 0xff);
  });
});

describe('encodePcmToWav', () => {
  it('encodes an empty buffer correctly', () => {
    const wav = encodePcmToWav(new Uint8Array(0), { sampleRate: 16_000, bitsPerSample: 16, channels: 1 });
    expect(wav.length).toBe(44);
    const dv = new DataView(wav.buffer);
    expect(dv.getUint32(40, true)).toBe(0);
  });
});

describe('uint8ToBase64', () => {
  it('round-trips small payloads', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const b64 = uint8ToBase64(bytes);
    const decoded = decodeBase64(b64);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('handles payloads larger than the 32K chunking threshold', () => {
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const b64 = uint8ToBase64(bytes);
    const decoded = decodeBase64(b64);
    expect(decoded.length).toBe(bytes.length);
    expect(decoded[0]).toBe(bytes[0]);
    expect(decoded[bytes.length - 1]).toBe(bytes[bytes.length - 1]);
  });
});

describe('analyzeBufferForVoice', () => {
  it('returns zero frames for an empty buffer', () => {
    const a = analyzeBufferForVoice(new Uint8Array(0), 16_000);
    expect(a.totalFrames).toBe(0);
    expect(a.voiceFrames).toBe(0);
  });

  it('classifies pure silence as silence everywhere', () => {
    const buf = buildSignal(2, () => 0);
    const a = analyzeBufferForVoice(buf, 16_000);
    expect(a.totalFrames).toBeGreaterThan(0);
    expect(a.voiceFrames).toBe(0);
    expect(a.silenceFrames).toBe(a.totalFrames);
    expect(a.noiseFrames).toBe(0);
  });

  it('classifies white-band noise above the RMS floor as noise (not voice)', () => {
    // Random samples spanning the full int16 range — flat spectrum across
    // 0..8 kHz means the 85–3000 Hz band carries ~36% of magnitude, well
    // below the voice-band ratio threshold.
    let seed = 1;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return ((seed >>> 0) / 0xffffffff) * 2 - 1;
    };
    const buf = buildSignal(2, () => rand() * 8000);
    const a = analyzeBufferForVoice(buf, 16_000);
    expect(a.totalFrames).toBeGreaterThan(0);
    expect(a.voiceFrames).toBe(0);
    expect(a.noiseFrames).toBeGreaterThan(0);
  });

  it('classifies a voice-band sine-mix at speech RMS as voice (early-exit)', () => {
    // Three sines in the 85-3000 Hz voice band sum to a strong voice-band
    // ratio. Amplitude well above the silence floor.
    const buf = buildSignal(2, (t) =>
      4000 * Math.sin(2 * Math.PI * 220 * t) +
      3000 * Math.sin(2 * Math.PI * 800 * t) +
      2000 * Math.sin(2 * Math.PI * 1500 * t)
    );
    const a = analyzeBufferForVoice(buf, 16_000);
    expect(a.voiceFrames).toBeGreaterThanOrEqual(1);
    // Early-exit returns as soon as voice is found, so totalFrames is small.
    expect(a.totalFrames).toBeGreaterThanOrEqual(1);
  });

  it('returns voiceFrames > 0 when voice exists anywhere in the buffer (tail silent)', () => {
    // Concatenate 1 second of voice-band sine + 1 second of silence.
    const voicePart = buildSignal(1, (t) => 5000 * Math.sin(2 * Math.PI * 440 * t));
    const silentPart = new Uint8Array(1 * 16_000 * 2);
    const combined = new Uint8Array(voicePart.length + silentPart.length);
    combined.set(voicePart, 0);
    combined.set(silentPart, voicePart.length);
    const a = analyzeBufferForVoice(combined, 16_000);
    expect(a.voiceFrames).toBeGreaterThanOrEqual(1);
  });

  it('early-exits on the first voice frame even with a long buffer', () => {
    // Build 30 s of audio where only the first frame contains voice and the
    // rest is silence. With early-exit, totalFrames should be 1.
    const total = 30 * 16_000;
    const samples = new Int16Array(total);
    for (let i = 0; i < 4000; i++) {
      samples[i] = Math.round(5000 * Math.sin((2 * Math.PI * 440 * i) / 16_000));
    }
    const a = analyzeBufferForVoice(pcm(samples), 16_000);
    expect(a.voiceFrames).toBe(1);
    expect(a.totalFrames).toBe(1);
  });

  it('handles a buffer shorter than one frame by analyzing what is available', () => {
    // 100 ms of voice — shorter than the 250 ms frame size.
    const buf = buildSignal(0.1, (t) => 5000 * Math.sin(2 * Math.PI * 440 * t));
    const a = analyzeBufferForVoice(buf, 16_000);
    expect(a.totalFrames).toBeGreaterThanOrEqual(1);
    expect(a.voiceFrames + a.silenceFrames + a.noiseFrames).toBe(a.totalFrames);
  });
});
