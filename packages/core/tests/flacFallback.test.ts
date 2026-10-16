import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodePcmToWav } from '../src/runtime/audioBuffer';
import { encodeWavToFlac } from '../src/runtime/flac';

const { createEncoder } = vi.hoisted(() => ({ createEncoder: vi.fn() }));
vi.mock('@audio/encode-flac', () => ({ default: createEncoder }));
const wav = encodePcmToWav(new Uint8Array(32_000), { sampleRate: 16_000, bitsPerSample: 16, channels: 1 });
const fakeEncoder = () => ({ encode: vi.fn(() => new Uint8Array(8)), flush: vi.fn(() => new Uint8Array(8)), free: vi.fn() });

beforeEach(() => { vi.useFakeTimers(); createEncoder.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('compression failure and cancellation', () => {
  it('falls back when the encoder cannot initialize', async () => {
    createEncoder.mockRejectedValue(new Error('WASM initialization failed'));
    expect(await encodeWavToFlac(wav)).toBeNull();
  });

  it('bounds startup to one second and frees an encoder that arrives late', async () => {
    const encoder = fakeEncoder();
    let ready!: (value: typeof encoder) => void;
    createEncoder.mockReturnValue(new Promise(resolve => { ready = resolve; }));
    const pending = encodeWavToFlac(wav);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBeNull();
    ready(encoder);
    await vi.advanceTimersByTimeAsync(0);
    expect(encoder.free).toHaveBeenCalledOnce();
    expect(encoder.encode).not.toHaveBeenCalled();
  });

  it('cancels startup immediately and frees a late encoder', async () => {
    const encoder = fakeEncoder();
    let ready!: (value: typeof encoder) => void;
    createEncoder.mockReturnValue(new Promise(resolve => { ready = resolve; }));
    const controller = new AbortController();
    const pending = encodeWavToFlac(wav, controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejection;
    ready(encoder);
    await vi.advanceTimersByTimeAsync(0);
    expect(encoder.free).toHaveBeenCalledOnce();
  });

  it('keeps WAV if encoding fails or produces a larger file', async () => {
    const encoder = fakeEncoder();
    createEncoder.mockResolvedValue(encoder);
    encoder.encode.mockImplementationOnce(() => { throw new Error('encoding failed'); });
    expect(await encodeWavToFlac(wav)).toBeNull();
    expect(encoder.free).toHaveBeenCalledOnce();
    encoder.encode.mockReturnValue(new Uint8Array(wav.length));
    expect(await encodeWavToFlac(wav)).toBeNull();
    expect(encoder.free).toHaveBeenCalledTimes(2);
  });

  it('stops encoding when its time budget is exhausted', async () => {
    const encoder = fakeEncoder();
    encoder.encode.mockImplementation(() => { vi.advanceTimersByTime(1001); return new Uint8Array(8); });
    createEncoder.mockResolvedValue(encoder);
    const pending = encodeWavToFlac(wav);
    await vi.advanceTimersByTimeAsync(1010);
    expect(await pending).toBeNull();
    expect(encoder.free).toHaveBeenCalledOnce();
  });

  it('preserves cancellation during encoding', async () => {
    const encoder = fakeEncoder();
    const controller = new AbortController();
    encoder.encode.mockImplementation(() => { controller.abort(); return new Uint8Array(8); });
    createEncoder.mockResolvedValue(encoder);
    await expect(encodeWavToFlac(wav, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(encoder.free).toHaveBeenCalledOnce();
  });
});
