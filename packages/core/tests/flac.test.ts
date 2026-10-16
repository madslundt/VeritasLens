import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodePcmToWav } from '../src/runtime/audioBuffer';
import { encodeWavToFlac } from '../src/runtime/flac';

afterEach(() => { vi.unstubAllGlobals(); });

function speechLikeWav(sampleRate = 16_000): { pcm: Uint8Array; wav: Uint8Array } {
  const pcm = new Uint8Array(sampleRate * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < sampleRate; i++) view.setInt16(i * 2, Math.round(7000 * Math.sin(i * 0.04)), true);
  // Include signed PCM boundary values to detect float conversion changes.
  [-32768, -32767, -1, 0, 1, 32767].forEach((n, i) => view.setInt16(i * 2, n, true));
  return { pcm, wav: encodePcmToWav(pcm, { sampleRate, bitsPerSample: 16, channels: 1 }) };
}

describe('lossless transcription compression', () => {
  it.each([16_000, 48_000])('compresses %i Hz PCM with exact sample count and PCM checksum', async sampleRate => {
    const { pcm, wav } = speechLikeWav(sampleRate);
    const flac = await encodeWavToFlac(wav);
    expect(flac).not.toBeNull();
    expect(new TextDecoder().decode(flac!.subarray(0, 4))).toBe('fLaC');
    expect(flac!.length).toBeLessThan(wav.length / 2);
    const header = new DataView(flac!.buffer, flac!.byteOffset);
    expect(header.getUint32(18) >>> 12).toBe(sampleRate);
    expect(header.getUint32(22)).toBe(sampleRate);
    expect(Buffer.from(flac!.subarray(26, 42)).toString('hex')).toBe(createHash('md5').update(pcm).digest('hex'));
  });

  it('reads WAV chunks and nonzero byte offsets without assuming a fixed header', async () => {
    const { wav } = speechLikeWav();
    const padded = new Uint8Array(wav.length + 10);
    padded.set(wav.subarray(0, 36));
    padded.set([74, 85, 78, 75, 1, 0, 0, 0, 9, 0], 36); // odd JUNK chunk + padding
    padded.set(wav.subarray(36), 46);
    new DataView(padded.buffer).setUint32(4, padded.length - 8, true);
    const backing = new Uint8Array(padded.length + 7);
    backing.set(padded, 7);
    expect(await encodeWavToFlac(backing.subarray(7))).toEqual(await encodeWavToFlac(wav));
  });

  it('keeps WAV for unsupported, malformed, or too-small inputs', async () => {
    expect(await encodeWavToFlac(new Uint8Array(4))).toBeNull();
    const { wav } = speechLikeWav();
    expect(await encodeWavToFlac(wav.subarray(0, wav.length - 1))).toBeNull();
    const stereo = wav.slice();
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(await encodeWavToFlac(stereo)).toBeNull();
    expect(await encodeWavToFlac(encodePcmToWav(new Uint8Array(2), { sampleRate: 16_000, bitsPerSample: 16, channels: 1 }))).toBeNull();
  });

  it('keeps WAV when WebAssembly is unavailable', async () => {
    vi.stubGlobal('WebAssembly', undefined);
    expect(await encodeWavToFlac(speechLikeWav().wav)).toBeNull();
  });

  it('honors cancellation before encoding', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(encodeWavToFlac(speechLikeWav().wav, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps simultaneous caption and analysis encoders independent', async () => {
    const first = speechLikeWav(16_000);
    const second = speechLikeWav(48_000);
    const results = await Promise.all([encodeWavToFlac(first.wav), encodeWavToFlac(second.wav)]);
    [first, second].forEach((input, i) => {
      expect(Buffer.from(results[i]!.subarray(26, 42)).toString('hex')).toBe(createHash('md5').update(input.pcm).digest('hex'));
    });
  });
});
