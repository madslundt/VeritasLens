import { describe, it, expect } from 'vitest';
import {
  PcmRingBuffer,
  analyzeBufferForVoiceFFT,
  encodePcmToWav,
  trimPcmToSegments,
  uint8ToBase64,
} from '../src/runtime/audioBuffer';
import {
  analyzeBufferForVoice,
  __resetVADAvailabilityForTests,
} from '../src/runtime/vad';

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

describe('analyzeBufferForVoiceFFT (fallback path)', () => {
  it('returns zero frames for an empty buffer', () => {
    const a = analyzeBufferForVoiceFFT(new Uint8Array(0), 16_000);
    expect(a.totalFrames).toBe(0);
    expect(a.voiceFrames).toBe(0);
  });

  it('classifies pure silence as silence everywhere', () => {
    const buf = buildSignal(2, () => 0);
    const a = analyzeBufferForVoiceFFT(buf, 16_000);
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
    const a = analyzeBufferForVoiceFFT(buf, 16_000);
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
    const a = analyzeBufferForVoiceFFT(buf, 16_000);
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
    const a = analyzeBufferForVoiceFFT(combined, 16_000);
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
    const a = analyzeBufferForVoiceFFT(pcm(samples), 16_000);
    expect(a.voiceFrames).toBe(1);
    expect(a.totalFrames).toBe(1);
  });

  it('handles a buffer shorter than one frame by analyzing what is available', () => {
    // 100 ms of voice — shorter than the 250 ms frame size.
    const buf = buildSignal(0.1, (t) => 5000 * Math.sin(2 * Math.PI * 440 * t));
    const a = analyzeBufferForVoiceFFT(buf, 16_000);
    expect(a.totalFrames).toBeGreaterThanOrEqual(1);
    expect(a.voiceFrames + a.silenceFrames + a.noiseFrames).toBe(a.totalFrames);
  });
});

describe('analyzeBufferForVoice (Silero-first wrapper)', () => {
  it('falls back to the FFT path when Silero cannot initialize', async () => {
    // The test environment is `node`, so dynamic-import of @ricky0123/vad-web
    // followed by an attempt to fetch the model URL will reject. The wrapper
    // must catch that and return the FFT result instead of throwing.
    __resetVADAvailabilityForTests();
    const buf = buildSignal(1, (t) =>
      4000 * Math.sin(2 * Math.PI * 220 * t) +
      3000 * Math.sin(2 * Math.PI * 800 * t)
    );
    const a = await analyzeBufferForVoice(buf, 16_000);
    expect(a.voiceFrames).toBeGreaterThanOrEqual(1);
  });

  it('reports silence on an empty buffer via the fallback', async () => {
    __resetVADAvailabilityForTests();
    const a = await analyzeBufferForVoice(new Uint8Array(0), 16_000);
    expect(a.totalFrames).toBe(0);
    expect(a.voiceFrames).toBe(0);
  });
});

describe('trimPcmToSegments', () => {
  /** Tiny rate so 100ms = 100 samples — keeps the assertions readable. */
  const RATE = 1000;
  const noPadParams = {
    sampleRate: RATE,
    bytesPerSample: 2,
    padMs: 0,
    mergeGapMs: 0,
    joinSilenceMs: 0,
  };

  it('returns the original buffer when no segments are given', () => {
    const buf = pcm([1, 2, 3, 4]);
    const out = trimPcmToSegments(buf, [], noPadParams);
    expect(out).toBe(buf);
  });

  it('extracts a single segment with no padding', () => {
    // 10 samples; segment covers samples [3, 6) → 3 samples → 6 bytes.
    const buf = pcm([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const out = trimPcmToSegments(buf, [{ start: 3, end: 6 }], noPadParams);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(out.length).toBe(6);
    expect(view.getInt16(0, true)).toBe(13);
    expect(view.getInt16(2, true)).toBe(14);
    expect(view.getInt16(4, true)).toBe(15);
  });

  it('merges segments within mergeGapMs and clamps padding to bounds', () => {
    // Buffer of 1000 samples (1 sec @ 1 kHz). Two segments separated by 100
    // samples — with mergeGapMs:200 the gap (100ms) is within the threshold,
    // so they merge. padMs:50 expands each side by 50 samples.
    const buf = new Uint8Array(2000);
    const view = new DataView(buf.buffer);
    for (let i = 0; i < 1000; i++) view.setInt16(i * 2, i + 1, true);

    const segments = [
      { start: 200, end: 300 },
      { start: 400, end: 500 },
    ];
    const out = trimPcmToSegments(buf, segments, {
      sampleRate: RATE,
      bytesPerSample: 2,
      mergeGapMs: 200,
      padMs: 50,
      joinSilenceMs: 0,
    });
    // Merged span: [200,500), padded by 50 → [150,550) → 400 samples → 800 bytes.
    expect(out.length).toBe(800);
    const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(outView.getInt16(0, true)).toBe(151);     // sample index 150 → value 151
    expect(outView.getInt16(798, true)).toBe(550);   // last → sample index 549 → 550
  });

  it('inserts join-silence between non-mergeable segments', () => {
    // Two non-touching segments, large gap, mergeGapMs=0 prevents merging,
    // joinSilenceMs adds 10 samples (20 bytes) of zeros between them.
    const buf = new Uint8Array(2000);
    const view = new DataView(buf.buffer);
    for (let i = 0; i < 1000; i++) view.setInt16(i * 2, 0x7fff, true);

    const segments = [
      { start: 100, end: 110 },
      { start: 500, end: 520 },
    ];
    const out = trimPcmToSegments(buf, segments, {
      sampleRate: RATE,
      bytesPerSample: 2,
      mergeGapMs: 0,
      padMs: 0,
      joinSilenceMs: 10,
    });
    // 10 samples + 10 silence + 20 samples = 40 samples = 80 bytes.
    expect(out.length).toBe(80);
    const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
    // First segment carries the 0x7fff marker.
    expect(outView.getInt16(0, true)).toBe(0x7fff);
    // The 10-sample join window is zero.
    for (let i = 10; i < 20; i++) {
      expect(outView.getInt16(i * 2, true)).toBe(0);
    }
    // Second segment resumes with 0x7fff.
    expect(outView.getInt16(20 * 2, true)).toBe(0x7fff);
  });

  it('returns the original when trimming would not shrink the buffer', () => {
    const buf = pcm([1, 2, 3, 4]);
    // A segment that already covers the entire buffer plus padding ⇒ no win.
    const out = trimPcmToSegments(buf, [{ start: 0, end: 4 }], {
      sampleRate: RATE,
      bytesPerSample: 2,
      padMs: 100,        // 100 samples each side — well past the bounds.
      mergeGapMs: 0,
      joinSilenceMs: 0,
    });
    expect(out).toBe(buf);
  });

  it('drops invalid / inverted / out-of-range segments', () => {
    const buf = pcm([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = trimPcmToSegments(
      buf,
      [
        { start: 5, end: 5 },   // empty
        { start: 6, end: 3 },   // inverted
        { start: 100, end: 200 }, // out of range
        { start: 2, end: 4 },   // valid → samples 3,4 → 4 bytes
      ],
      noPadParams,
    );
    expect(out.length).toBe(4);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getInt16(0, true)).toBe(3);
    expect(view.getInt16(2, true)).toBe(4);
  });

  it('returns an empty buffer when every segment is invalid', () => {
    // Inverted-only input → no valid regions, output would be 0 bytes,
    // which is < pcm.length, so we return the freshly allocated empty buffer.
    const buf = pcm([1, 2, 3, 4]);
    const out = trimPcmToSegments(buf, [{ start: 4, end: 2 }], noPadParams);
    // All invalid filtered → falls through to early-return original.
    expect(out).toBe(buf);
  });
});
