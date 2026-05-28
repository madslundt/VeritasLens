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
  /**
   * Total bytes ever appended over the lifetime of this buffer. Monotonic;
   * not clamped to capacity. Used by callers that need to ask "what audio has
   * arrived since a previous logical position" (e.g. the no-voice gate
   * looking at audio captured since the last analysis trigger).
   */
  private produced = 0;

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

  /**
   * Monotonic count of total bytes appended over the buffer's lifetime.
   * Not affected by wraparound or `clear()`. Callers snapshot this value to
   * mark a logical position they can later ask the buffer about via
   * `linearPcmSince(offset)`.
   */
  get bytesProduced(): number {
    return this.produced;
  }

  /** Append a PCM chunk. Wraps around if it exceeds capacity. */
  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;

    // Track lifetime byte count BEFORE clamping the view, so callers tracking
    // "produced bytes" see every appended byte even if the ring wrapped them
    // out of currently-retained storage.
    this.produced += chunk.length;

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

  /**
   * Return the PCM bytes appended since the given logical `byteOffset`
   * (a value previously read from `bytesProduced`). Clamped to whatever is
   * still in the ring — if `byteOffset` is older than the eviction horizon,
   * the full retained buffer is returned. If `byteOffset` is ≥ `bytesProduced`
   * (nothing new has arrived) returns an empty buffer.
   */
  linearPcmSince(byteOffset: number): Uint8Array {
    const wanted = Math.max(0, this.produced - byteOffset);
    if (wanted === 0) return new Uint8Array(0);
    const linear = this.toLinearPcm();
    if (wanted >= linear.length) return linear;
    return linear.subarray(linear.length - wanted);
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

/** Per-frame voice-activity tallies from `analyzeBufferForVoice`. */
export interface VoiceBufferAnalysis {
  voiceFrames: number;
  silenceFrames: number;
  noiseFrames: number;
  totalFrames: number;
}

/**
 * FFT-based voice-activity heuristic. Kept as the fallback path for the
 * Silero-backed gate in `src/runtime/vad`; the runtime always tries Silero
 * first and only invokes this when the model cannot load.
 *
 * Algorithm: ~250 ms frames; cheap RMS pass first; for non-silent frames a
 * 1024-point FFT with Hann window classifies "voice" vs "noise" by the share
 * of magnitude in the 85–3000 Hz band. Returns early as soon as one voice
 * frame is found — the only consumer cares about presence, not exact counts.
 */
export function analyzeBufferForVoiceFFT(
  pcm: Uint8Array,
  sampleRate: number,
  rmsFloor: number = 200,
): VoiceBufferAnalysis {
  const totalSamples = pcm.length >> 1;
  if (totalSamples === 0) {
    return { voiceFrames: 0, silenceFrames: 0, noiseFrames: 0, totalFrames: 0 };
  }
  const FRAME_SAMPLES = 4000; // ~250 ms at 16 kHz
  const FFT_SIZE = 1024;
  // `rmsFloor` is supplied by the caller (live: the user-tunable voice-gate
  // setting; tests/default: 200, the historical value). Tracks the same
  // semantics as the Silero path so the FFT fallback and the primary path
  // agree on what counts as silence — speech vs noise discrimination
  // happens downstream (band ratio here, neural model there).
  const SILENCE_RMS_FLOOR = rmsFloor;   // int16 units
  const VOICE_BAND_LO_HZ = 85;
  const VOICE_BAND_HI_HZ = 3000;
  const VOICE_BAND_RATIO_THRESHOLD = 0.55;

  const frameSamples = Math.min(FRAME_SAMPLES, totalSamples);
  const frameCount = Math.max(1, Math.floor(totalSamples / frameSamples));

  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);

  // FFT scratch reused across frames.
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);

  const binHz = sampleRate / FFT_SIZE;
  const loBin = Math.max(1, Math.floor(VOICE_BAND_LO_HZ / binHz));
  const hiBin = Math.min((FFT_SIZE >> 1) - 1, Math.ceil(VOICE_BAND_HI_HZ / binHz));

  let voiceFrames = 0;
  let silenceFrames = 0;
  let noiseFrames = 0;
  let totalFrames = 0;

  for (let f = 0; f < frameCount; f++) {
    const sampleStart = f * frameSamples;
    let sumSq = 0;
    for (let i = 0; i < frameSamples; i++) {
      const s = dv.getInt16((sampleStart + i) * 2, true);
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / frameSamples);
    totalFrames++;
    if (rms < SILENCE_RMS_FLOOR) {
      silenceFrames++;
      continue;
    }

    // FFT path: window + transform the first FFT_SIZE samples of the frame.
    const fftSamples = Math.min(FFT_SIZE, frameSamples);
    for (let i = 0; i < fftSamples; i++) {
      const s = dv.getInt16((sampleStart + i) * 2, true);
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSamples - 1));
      real[i] = s * w;
      imag[i] = 0;
    }
    for (let i = fftSamples; i < FFT_SIZE; i++) {
      real[i] = 0;
      imag[i] = 0;
    }
    fftInPlace(real, imag, FFT_SIZE);

    let voiceMag = 0;
    let totalMag = 0;
    const halfN = FFT_SIZE >> 1;
    for (let k = 1; k < halfN; k++) {
      const re = real[k]!;
      const im = imag[k]!;
      const mag = Math.sqrt(re * re + im * im);
      totalMag += mag;
      if (k >= loBin && k <= hiBin) voiceMag += mag;
    }
    const ratio = totalMag > 0 ? voiceMag / totalMag : 0;
    if (ratio >= VOICE_BAND_RATIO_THRESHOLD) {
      voiceFrames++;
      // Early-exit — callers only care whether voice exists at all.
      return { voiceFrames, silenceFrames, noiseFrames, totalFrames };
    }
    noiseFrames++;
  }

  return { voiceFrames, silenceFrames, noiseFrames, totalFrames };
}

/** Radix-2 Cooley–Tukey FFT, in-place. `n` must be a power of two. */
function fftInPlace(re: Float64Array, im: Float64Array, n: number): void {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k]!;
        const aIm = im[i + k]!;
        const bRe = re[i + k + half]!;
        const bIm = im[i + k + half]!;
        const tRe = curRe * bRe - curIm * bIm;
        const tIm = curRe * bIm + curIm * bRe;
        re[i + k + half] = aRe - tRe;
        im[i + k + half] = aIm - tIm;
        re[i + k] = aRe + tRe;
        im[i + k] = aIm + tIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

/**
 * Concatenate the speech segments of a PCM buffer into a single shorter PCM
 * buffer, dropping the non-speech runs between them. Segments are first sorted
 * + merged when their gap is below `mergeGapMs`, then padded on both sides by
 * `padMs` (clamped to the PCM bounds). Adjacent merged regions are joined with
 * a short `joinSilenceMs` gap of zeros so the LLM's audio decoder sees brief
 * pauses instead of hard jump cuts.
 *
 * Returns the original `pcm` if `segments` is empty or merging would not
 * shrink the buffer — the caller can use the result unconditionally without a
 * size-comparison branch.
 *
 * Pure / synchronous / no allocation beyond the returned buffer.
 */
export function trimPcmToSegments(
  pcm: Uint8Array,
  segments: ReadonlyArray<{ start: number; end: number }>,
  params: {
    sampleRate: number;
    /** Bytes per sample. Defaults to 2 (16-bit). */
    bytesPerSample?: number;
    /** Merge segments whose gap is ≤ this many ms. Default 500. */
    mergeGapMs?: number;
    /** Pad each merged segment by this many ms on both sides. Default 200. */
    padMs?: number;
    /** Silence inserted between non-adjacent merged regions. Default 50. */
    joinSilenceMs?: number;
  },
): Uint8Array {
  if (segments.length === 0) return pcm;
  const bytesPerSample = params.bytesPerSample ?? 2;
  const totalSamples = Math.floor(pcm.length / bytesPerSample);
  if (totalSamples === 0) return pcm;

  const msToSamples = (ms: number): number => Math.floor((ms / 1000) * params.sampleRate);
  const mergeGap = msToSamples(params.mergeGapMs ?? 500);
  const pad = msToSamples(params.padMs ?? 200);
  const joinSilenceSamples = msToSamples(params.joinSilenceMs ?? 50);

  // Sort, clamp, drop empty/invalid, then merge close neighbours.
  const sorted = segments
    .map((s) => ({
      start: Math.max(0, Math.min(totalSamples, s.start)),
      end: Math.max(0, Math.min(totalSamples, s.end)),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return pcm;

  const merged: Array<{ start: number; end: number }> = [];
  for (const seg of sorted) {
    const last = merged[merged.length - 1];
    if (last && seg.start - last.end <= mergeGap) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ start: seg.start, end: seg.end });
    }
  }

  // Pad and clamp each merged region.
  const padded = merged.map((s) => ({
    start: Math.max(0, s.start - pad),
    end: Math.min(totalSamples, s.end + pad),
  }));

  // Compute output size: sum of region lengths in bytes, plus join-silence
  // gaps between consecutive non-overlapping regions.
  let outSamples = 0;
  for (let i = 0; i < padded.length; i++) {
    outSamples += padded[i]!.end - padded[i]!.start;
    if (i < padded.length - 1) outSamples += joinSilenceSamples;
  }
  const outBytes = outSamples * bytesPerSample;

  // No shrink: fall back to the original so callers don't pay a copy.
  if (outBytes >= pcm.length) return pcm;

  const out = new Uint8Array(outBytes);
  let writeOffset = 0;
  for (let i = 0; i < padded.length; i++) {
    const seg = padded[i]!;
    const segBytes = (seg.end - seg.start) * bytesPerSample;
    const srcStart = seg.start * bytesPerSample;
    out.set(pcm.subarray(srcStart, srcStart + segBytes), writeOffset);
    writeOffset += segBytes;
    if (i < padded.length - 1) {
      // Join silence: zeros are already in the freshly allocated buffer; just
      // advance the write head.
      writeOffset += joinSilenceSamples * bytesPerSample;
    }
  }
  return out;
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
