/**
 * Fixed-capacity rolling buffer for 16-bit PCM mono audio.
 *
 * The Even App delivers PCM as `Uint8Array` chunks through
 * `onEvenHubEvent → audioEvent.audioPcm`. We retain the most recent
 * `durationSec` worth of bytes; older bytes are silently evicted.
 *
 * Storage is a single `Uint8Array` of fixed capacity with a head/length pair —
 * no copying on append, no `Array.shift` perf trap.
 */
export class PcmRingBuffer {
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  readonly channels: number;
  readonly capacity: number;

  private readonly storage: Uint8Array;
  /** Index into `storage` where the next byte will be written. */
  private head = 0;
  /** Bytes currently buffered (≤ capacity). */
  private size = 0;

  constructor(options: {
    durationSec?: number;
    sampleRate?: number;
    bitsPerSample?: number;
    channels?: number;
  } = {}) {
    this.sampleRate = options.sampleRate ?? 16_000;
    this.bitsPerSample = options.bitsPerSample ?? 16;
    this.channels = options.channels ?? 1;
    const durationSec = options.durationSec ?? 30;
    this.capacity = durationSec * this.sampleRate * (this.bitsPerSample / 8) * this.channels;
    this.storage = new Uint8Array(this.capacity);
  }

  /** Currently retained byte length. */
  get bytesBuffered(): number {
    return this.size;
  }

  /** Seconds of audio currently retained. */
  get secondsBuffered(): number {
    return this.size / (this.sampleRate * (this.bitsPerSample / 8) * this.channels);
  }

  /** Append a PCM chunk. Wraps around if it exceeds capacity. */
  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;

    // If the chunk is larger than capacity, only the tail (most-recent capacity bytes) matters.
    let view: Uint8Array;
    if (chunk.length >= this.capacity) {
      view = chunk.subarray(chunk.length - this.capacity);
    } else {
      view = chunk;
    }

    const first = Math.min(view.length, this.capacity - this.head);
    this.storage.set(view.subarray(0, first), this.head);
    if (first < view.length) {
      this.storage.set(view.subarray(first), 0);
    }
    this.head = (this.head + view.length) % this.capacity;
    this.size = Math.min(this.capacity, this.size + view.length);
  }

  /** Reset to empty. The underlying buffer is retained for reuse. */
  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  /**
   * Copy the buffered PCM into a linear `Uint8Array` (oldest byte first).
   * Returned buffer is a fresh allocation; the ring is unaffected.
   */
  toLinearPcm(): Uint8Array {
    const out = new Uint8Array(this.size);
    if (this.size === 0) return out;

    // Oldest byte sits at `head - size`, modulo capacity.
    const start = (this.head - this.size + this.capacity) % this.capacity;
    const tail = Math.min(this.size, this.capacity - start);
    out.set(this.storage.subarray(start, start + tail), 0);
    if (tail < this.size) {
      out.set(this.storage.subarray(0, this.size - tail), tail);
    }
    return out;
  }

  /** Encode the current contents as a WAV file (RIFF / PCM / mono). */
  snapshotWav(): Uint8Array {
    const pcm = this.toLinearPcm();
    return encodePcmToWav(pcm, {
      sampleRate: this.sampleRate,
      bitsPerSample: this.bitsPerSample,
      channels: this.channels,
    });
  }
}

/**
 * Encode raw little-endian PCM samples into a WAV (RIFF) container.
 *
 * Format spec: http://soundfile.sapp.org/doc/WaveFormat/
 */
export function encodePcmToWav(
  pcm: Uint8Array,
  params: { sampleRate: number; bitsPerSample: number; channels: number },
): Uint8Array {
  const { sampleRate, bitsPerSample, channels } = params;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const fileSize = 36 + dataSize;

  const buffer = new Uint8Array(44 + dataSize);
  const view = new DataView(buffer.buffer);

  // RIFF header
  writeAscii(buffer, 0, 'RIFF');
  view.setUint32(4, fileSize, true);
  writeAscii(buffer, 8, 'WAVE');

  // fmt chunk
  writeAscii(buffer, 12, 'fmt ');
  view.setUint32(16, 16, true); // subchunk1 size (16 for PCM)
  view.setUint16(20, 1, true); // audio format (1 = PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeAscii(buffer, 36, 'data');
  view.setUint32(40, dataSize, true);
  buffer.set(pcm, 44);

  return buffer;
}

function writeAscii(buffer: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    buffer[offset + i] = text.charCodeAt(i);
  }
}

/** Base64 encoder usable in both browser and Node. Avoids dependency on `Buffer`. */
export function uint8ToBase64(bytes: Uint8Array): string {
  // For very large buffers, build in chunks to avoid call-stack overflow on `String.fromCharCode`.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  if (typeof btoa === 'function') return btoa(binary);
  // Node fallback (vitest environment may run without `btoa`).
  const nodeBuffer = (globalThis as { Buffer?: { from(input: string, enc: string): { toString(enc: string): string } } }).Buffer;
  if (!nodeBuffer) throw new Error('No base64 encoder available.');
  return nodeBuffer.from(binary, 'binary').toString('base64');
}
