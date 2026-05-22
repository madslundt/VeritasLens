// src/runtime/vad/silero.ts
//
// Silero VAD wrapper around @ricky0123/vad-web's NonRealTimeVAD.
//
// The library is loaded lazily via a dynamic import so the Node-based vitest
// environment never has to resolve onnxruntime-web (which would fail when
// trying to instantiate WASM with no `window`). Production code calls
// `getSileroVAD().init()` from the HUD warmup path so the first user tap
// doesn't pay cold-start cost.

import type { VoiceBufferAnalysis } from '@/runtime/audioBuffer';

/**
 * Where the bundled ONNX model and ORT WASM live relative to the WebView's
 * document. Vite's static-copy step (see `vite.config.ts`) places these
 * files alongside `index.html` at build time.
 */
const MODEL_URL = './silero_vad_legacy.onnx';

/**
 * RMS floor (int16 units) below which a 250 ms frame is considered silence
 * rather than noise. Mirrors the threshold used by the FFT fallback so the
 * `silence-vs-noise` distinction surfaced to the HUD glyph (`○` vs `~`) is
 * consistent regardless of which path produced the verdict.
 */
const SILENCE_RMS_FLOOR = 200;
const ENERGY_FRAME_SAMPLES = 4000; // 250 ms at 16 kHz

interface NonRealTimeVAD {
  run(
    input: Float32Array,
    sampleRate: number,
  ): AsyncGenerator<{ audio: Float32Array; start: number; end: number }>;
  /** Some versions of @ricky0123/vad-web expose a release hook for the ORT session. */
  destroy?: () => void | Promise<void>;
  /** Older alias kept defensively — same intent as destroy(). */
  release?: () => void | Promise<void>;
}

/**
 * `@ricky0123/vad-web` exposes the model via a static `new(options)` factory
 * on the `NonRealTimeVAD` class (not the JS `new` operator) — we capture
 * exactly that shape here so the call below is type-safe without an `any`.
 */
interface NonRealTimeVADStatic {
  new: (options: {
    modelURL: string;
    modelFetcher: (path: string) => Promise<ArrayBuffer>;
  }) => Promise<NonRealTimeVAD>;
}

let instance: SileroVADSession | null = null;

export function getSileroVAD(): SileroVADSession {
  if (!instance) instance = new SileroVADSession();
  return instance;
}

export class SileroVADSession {
  private vad: NonRealTimeVAD | null = null;
  private initPromise: Promise<void> | null = null;
  private failed = false;

  /**
   * Load the Silero model and configure onnxruntime-web. Idempotent;
   * concurrent callers share the same in-flight promise. Marks the session
   * as failed on any error so subsequent `predict()` calls short-circuit
   * to the FFT fallback rather than re-trying the load on every tap.
   */
  init(): Promise<void> {
    if (this.vad) return Promise.resolve();
    if (this.failed) return Promise.reject(new Error('SileroVAD: previous init failed'));
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit().catch((err) => {
      this.failed = true;
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    // Dynamic imports — keep these out of the module-load path so the Node
    // test environment (vitest with `environment: 'node'`) doesn't try to
    // load the ORT WASM at import time.
    const ort = (await import('onnxruntime-web')) as unknown as {
      env: { wasm: { numThreads: number; proxy: boolean } };
    };
    // Single-threaded — mobile WebViews typically lack the COOP/COEP headers
    // needed for SharedArrayBuffer, and our model is tiny enough that
    // threading offers no real win. The Vite alias (see vite.config.ts)
    // already pins us to the pure-WASM ORT build, so the wasm asset path
    // is auto-resolved by ORT from `import.meta.url` and we don't override.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;

    const mod = await import('@ricky0123/vad-web');
    const Ctor = (mod as unknown as { NonRealTimeVAD: NonRealTimeVADStatic }).NonRealTimeVAD;

    this.vad = await Ctor.new({
      modelURL: MODEL_URL,
      // Fetch from the same origin (the WebView document). Default fetcher
      // does this already but we name the function explicitly so a future
      // contributor sees where the model loads from.
      modelFetcher: (path: string) => fetch(path).then((r) => r.arrayBuffer()),
    });
  }

  /**
   * Score a raw little-endian 16-bit PCM buffer for the presence of voice.
   *
   * Strategy:
   * 1. Cheap RMS pass to count `silenceFrames` vs `energeticFrames`. If
   *    everything is silent, return without invoking the model.
   * 2. Convert int16 PCM to Float32 in [-1, 1] and stream through
   *    `NonRealTimeVAD.run()`. The async generator yields a segment as soon
   *    as one complete speech region (≥ `minSpeechMs`) is finished — we
   *    break on the first yield, so the inference stops mid-buffer.
   * 3. If no segment ever yields, all energetic frames are reported as
   *    `noiseFrames` so the HUD picks the `~` (too-noisy) glyph rather than
   *    `○` (silence).
   *
   * Init must have resolved before this is called; the public `predict()`
   * waits on `init()` so callers don't need to sequence themselves.
   */
  async predict(pcm: Uint8Array, sampleRate: number): Promise<VoiceBufferAnalysis> {
    await this.init();
    if (!this.vad) throw new Error('SileroVAD: not initialized');

    const totalSamples = pcm.length >> 1;
    if (totalSamples === 0) {
      return { voiceFrames: 0, silenceFrames: 0, noiseFrames: 0, totalFrames: 0 };
    }

    const energy = countEnergyFrames(pcm);
    if (energy.energeticFrames === 0) {
      return {
        voiceFrames: 0,
        silenceFrames: energy.silenceFrames,
        noiseFrames: 0,
        totalFrames: energy.totalFrames,
      };
    }

    const float32 = int16ToFloat32(pcm);
    for await (const _segment of this.vad.run(float32, sampleRate)) {
      // Early-exit on the first speech segment — callers only care whether
      // any voice exists.
      return {
        voiceFrames: 1,
        silenceFrames: energy.silenceFrames,
        noiseFrames: 0,
        totalFrames: energy.totalFrames,
      };
    }
    // Generator drained without yielding — no voice found anywhere.
    return {
      voiceFrames: 0,
      silenceFrames: energy.silenceFrames,
      noiseFrames: energy.energeticFrames,
      totalFrames: energy.totalFrames,
    };
  }

  /**
   * Release the underlying ORT session and clear cached state. The wrapped
   * NonRealTimeVAD doesn't have a stable disposer across library versions —
   * probe for `destroy` / `release` and call whichever exists; fall back to
   * just dropping the reference so GC eventually reclaims the ORT WASM heap.
   */
  dispose(): void {
    const v = this.vad;
    this.vad = null;
    this.initPromise = null;
    this.failed = false;
    if (!v) return;
    try {
      const fn = v.destroy ?? v.release;
      if (fn) void fn.call(v);
    } catch {
      // Best-effort; the reference is already cleared so a throw here would
      // just bubble up at teardown for no benefit.
    }
  }

  /** Test-only: did the last init attempt fail? */
  get isFailed(): boolean { return this.failed; }
}

/** Reset the module-level instance. Test-only. */
export function __resetSileroVADForTests(): void {
  instance = null;
}

/**
 * Quick energy pass over a 16-bit LE PCM buffer. Frames below
 * `SILENCE_RMS_FLOOR` count as silence; the rest count as energetic.
 * Used to short-circuit Silero on fully-silent buffers and to populate the
 * silence/noise distinction expected by the HUD.
 */
function countEnergyFrames(pcm: Uint8Array): {
  silenceFrames: number;
  energeticFrames: number;
  totalFrames: number;
} {
  const totalSamples = pcm.length >> 1;
  const frameSamples = Math.min(ENERGY_FRAME_SAMPLES, totalSamples);
  if (frameSamples === 0) {
    return { silenceFrames: 0, energeticFrames: 0, totalFrames: 0 };
  }
  const frameCount = Math.max(1, Math.floor(totalSamples / frameSamples));
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let silenceFrames = 0;
  let energeticFrames = 0;
  for (let f = 0; f < frameCount; f++) {
    const start = f * frameSamples;
    let sumSq = 0;
    for (let i = 0; i < frameSamples; i++) {
      const s = dv.getInt16((start + i) * 2, true);
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / frameSamples);
    if (rms < SILENCE_RMS_FLOOR) silenceFrames++;
    else energeticFrames++;
  }
  return { silenceFrames, energeticFrames, totalFrames: frameCount };
}

/** Convert little-endian int16 PCM to a Float32Array scaled to [-1, 1]. */
function int16ToFloat32(pcm: Uint8Array): Float32Array {
  const samples = pcm.length >> 1;
  const out = new Float32Array(samples);
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < samples; i++) {
    out[i] = dv.getInt16(i * 2, true) / 32768;
  }
  return out;
}
