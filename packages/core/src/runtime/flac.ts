import type { StreamEncoder } from '@audio/encode-flac';
import { throwIfAborted } from '@/llm/fetchTimeout';

// Compression must not turn a slow upload into a long wait on the phone.
const ENCODE_BUDGET_MS = 1_000;
const BLOCK_SAMPLES = 16_384;

/** Encode our PCM16 mono WAVs without changing samples. Null keeps the WAV. */
export async function encodeWavToFlac(wav: Uint8Array, signal?: AbortSignal): Promise<Uint8Array | null> {
  throwIfAborted(signal);
  const audio = readPcmWav(wav);
  if (!audio || typeof WebAssembly === 'undefined') return null;

  const startedAt = performance.now();
  let encoder: StreamEncoder | undefined;
  try {
    const pending = import('@audio/encode-flac').then(({ default: createEncoder }) => createEncoder({
      sampleRate: audio.sampleRate, channels: 1, bitDepth: 16,
      compression: 3, frames: audio.samples,
    }));
    encoder = await boundedEncoder(pending, signal);
    if (!encoder) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    let lastYield = performance.now();
    for (let offset = 0; offset < audio.samples; offset += BLOCK_SAMPLES) {
      throwIfAborted(signal);
      if (performance.now() - startedAt >= ENCODE_BUDGET_MS) return null;
      const count = Math.min(BLOCK_SAMPLES, audio.samples - offset);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = audio.pcm.getInt16((offset + i) * 2, true) / 32768;
      const chunk = encoder.encode([samples]);
      chunks.push(chunk); size += chunk.length;
      if (size >= wav.length) return null;
      // Yield on long recordings so gestures and cancellation still work.
      if (performance.now() - lastYield >= 8) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
    throwIfAborted(signal);
    const tail = encoder.flush();
    chunks.push(tail); size += tail.length;
    if (size >= wav.length || performance.now() - startedAt >= ENCODE_BUDGET_MS) return null;
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    const header = encoder.head?.();
    if (header) result.set(header);
    return result;
  } catch {
    throwIfAborted(signal);
    return null;
  } finally {
    releaseEncoder(encoder);
  }
}

function releaseEncoder(encoder?: StreamEncoder): void {
  try { encoder?.free(); } catch { /* Cleanup must not prevent the WAV fallback. */ }
}

/** Bound async WASM startup and release an encoder that arrives after cancellation/timeout. */
function boundedEncoder(pending: Promise<StreamEncoder>, signal?: AbortSignal): Promise<StreamEncoder | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: StreamEncoder, error?: unknown) => {
      if (settled) { releaseEncoder(value); return; }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => {
      try { throwIfAborted(signal); } catch (error) { finish(undefined, error); }
    };
    const timer = setTimeout(() => finish(), ENCODE_BUDGET_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    pending.then(value => finish(value), error => finish(undefined, error));
  });
}

/** Parse chunk offsets rather than assuming every WAV has a 44-byte header. */
function readPcmWav(wav: Uint8Array): { pcm: DataView; sampleRate: number; samples: number } | null {
  if (wav.length < 44) return null;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  if (view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) return null;
  let sampleRate = 0;
  let pcm: DataView | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = view.getUint32(offset);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (length > wav.length - start) return null;
    if (id === 0x666d7420) {
      if (length < 16 || view.getUint16(start, true) !== 1
        || view.getUint16(start + 2, true) !== 1 || view.getUint16(start + 14, true) !== 16
        || view.getUint16(start + 12, true) !== 2) return null;
      sampleRate = view.getUint32(start + 4, true);
    } else if (id === 0x64617461) {
      if (length % 2 !== 0) return null;
      pcm = new DataView(wav.buffer, wav.byteOffset + start, length);
    }
    offset = start + length + (length % 2);
  }
  if (!pcm?.byteLength || sampleRate < 8_000 || sampleRate > 192_000) return null;
  return { pcm, sampleRate, samples: pcm.byteLength / 2 };
}
