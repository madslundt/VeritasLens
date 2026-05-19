import { describe, it, expect } from 'vitest';
import { PcmRingBuffer, encodePcmToWav, uint8ToBase64 } from '../src/runtime/audioBuffer';

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
