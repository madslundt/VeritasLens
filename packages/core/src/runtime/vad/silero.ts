// src/runtime/vad/silero.ts
//
// Silero v6 confirms speech candidates from the lightweight Earshot model.
// Both models run locally in single-threaded WASM. Warmup keeps model loading
// off the first tap; FFT remains the fallback if assets cannot load.

import type { VoiceBufferAnalysis } from '@/runtime/audioBuffer';
import type { FluidVad } from '@fluidinference/fluidvad';

/**
 * Earshot is copied beside index.html; FluidVad's JS glue resolves its own
 * bundled WASM/model asset using import.meta.url (Vite emits that asset).
 */
const CANDIDATE_MODEL_URL = './earshot-1.2.2.wasm';

/**
 * Default RMS floor used when callers don't pass one through. Production
 * code reads the user-configured floor from `settings()` and forwards it
 * to `predict()` / `extractSpeechSegments()`; this default exists so unit
 * tests and ad-hoc callers don't have to thread the parameter.
 */
const DEFAULT_RMS_FLOOR = 200;
const ENERGY_FRAME_SAMPLES = 4000; // 250 ms at 16 kHz
const MODEL_FRAME_SAMPLES = 512; // Silero v6, at its internal 16 kHz rate
const CANDIDATE_FRAME_SAMPLES = 256; // Earshot, 16 ms at 16 kHz
const CANDIDATE_BLOCK_FRAMES = 64;
const MIN_SPEECH_MS = 200;
const SPEECH_END_MS = 1400;
const MIN_SPEECH_FRAMES = Math.ceil(MIN_SPEECH_MS / 16);
const SILENCE_FRAMES = Math.ceil(SPEECH_END_MS / 16);
const VALIDATION_PAD_SAMPLES = 3200; // 200 ms of context around candidates
const INFERENCE_SLICE_MS = 8;

interface LocalVadEngine {
  run: (input: Float32Array, sampleRate: number) => AsyncGenerator<{
    audio: Float32Array; start: number; end: number;
  }>;
  frameProcessor: { endSegment: (callback: () => void) => unknown };
  destroy?: () => void | Promise<void>;
  /** Older alias kept defensively — same intent as destroy(). */
  release?: () => void | Promise<void>;
}

let instance: SileroVADSession | null = null;

export function getSileroVAD(): SileroVADSession {
  if (!instance) instance = new SileroVADSession();
  return instance;
}

export class SileroVADSession {
  private vad: LocalVadEngine | null = null;
  private initPromise: Promise<void> | null = null;
  private failed = false;
  private runQueue: Promise<void> = Promise.resolve();
  private generation = 0;

  /**
   * Load the two local WASM models. Idempotent;
   * concurrent callers share the same in-flight promise. Marks the session
   * as failed on any error so subsequent `predict()` calls short-circuit
   * to the FFT fallback rather than re-trying the load on every tap.
   */
  init(): Promise<void> {
    if (this.vad) return Promise.resolve();
    if (this.failed) return Promise.reject(new Error('SileroVAD: previous init failed'));
    if (this.initPromise) return this.initPromise;
    const generation = this.generation;
    this.initPromise = this.doInit(generation).catch((err) => {
      if (generation === this.generation) {
        this.failed = true;
        this.initPromise = null;
      }
      throw err;
    });
    return this.initPromise;
  }

  private async doInit(generation: number): Promise<void> {
    const vad = await createCascadeVAD();
    if (generation !== this.generation) {
      releaseVad(vad);
      throw new Error('SileroVAD: disposed during initialization');
    }
    this.vad = vad;
  }

  /** Snapshots are independent, but the library shares recurrent model state. */
  private withVad<T>(scan: (vad: LocalVadEngine) => Promise<T>): Promise<T> {
    const generation = this.generation;
    const result = this.runQueue.then(async () => {
      if (generation !== this.generation) throw new Error('SileroVAD: disposed');
      await this.init();
      const vad = this.vad;
      if (!vad || generation !== this.generation) throw new Error('SileroVAD: disposed');
      // Clear both models' state, including after an early generator return.
      vad.frameProcessor.endSegment(() => {});
      try {
        const value = await scan(vad);
        if (generation !== this.generation) throw new Error('SileroVAD: disposed');
        return value;
      } finally {
        vad.frameProcessor.endSegment(() => {});
      }
    });
    // A failed snapshot must not poison the queue for subsequent callers.
    this.runQueue = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Score a raw little-endian 16-bit PCM buffer for the presence of voice.
   *
   * Strategy:
   * 1. Cheap RMS pass to count `silenceFrames` vs `energeticFrames`. If
   *    everything is silent, return without invoking the model.
   * 2. Convert int16 PCM to Float32 in [-1, 1] and stream through
   *    the candidate model. Silero v6 confirms each candidate before it is
   *    yielded. Break on the first confirmed region to stop mid-buffer.
   * 3. If no segment ever yields, all energetic frames are reported as
   *    `noiseFrames` so the HUD picks the `~` (too-noisy) glyph rather than
   *    `○` (silence).
   *
   * Non-silent snapshots wait on `init()` inside the scan queue. Empty and
   * silent snapshots return without loading the model.
   */
  async predict(
    pcm: Uint8Array,
    sampleRate: number,
    rmsFloor: number = DEFAULT_RMS_FLOOR,
  ): Promise<VoiceBufferAnalysis> {
    const totalSamples = pcm.length >> 1;
    if (totalSamples === 0) {
      return { voiceFrames: 0, silenceFrames: 0, noiseFrames: 0, totalFrames: 0 };
    }

    const energy = countEnergyFrames(pcm, rmsFloor);
    if (energy.energeticFrames === 0) {
      return {
        voiceFrames: 0,
        silenceFrames: energy.silenceFrames,
        noiseFrames: 0,
        totalFrames: energy.totalFrames,
      };
    }

    return this.withVad(async (vad) => {
      const float32 = int16ToFloat32(pcm, sampleRate);
      for await (const _segment of vad.run(float32, sampleRate)) {
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
    });
  }

  /**
   * Drain the Silero generator over the full buffer and return every detected
   * speech segment as `{ start, end }` **sample offsets** (inclusive start,
   * exclusive end). Unlike `predict()` — which early-exits on the first
   * segment — this awaits the full run so trimming downstream sees every
   * region. Returns `[]` when no speech is found or the buffer is empty.
   * Initialization/inference errors propagate to the public fallback wrapper.
   *
   * The model adapter yields `start` / `end` in milliseconds. We convert
   * to source samples at the boundary so downstream consumers (e.g.
   * `trimPcmToSegments`) can operate in their natural unit.
   */
  async extractSpeechSegments(
    pcm: Uint8Array,
    sampleRate: number,
    rmsFloor: number = DEFAULT_RMS_FLOOR,
  ): Promise<Array<{ start: number; end: number }>> {
    const totalSamples = pcm.length >> 1;
    if (totalSamples === 0) return [];

    const energy = countEnergyFrames(pcm, rmsFloor);
    if (energy.energeticFrames === 0) return [];

    return this.withVad(async (vad) => {
      const float32 = int16ToFloat32(pcm, sampleRate);
      const segments: Array<{ start: number; end: number }> = [];
      for await (const segment of vad.run(float32, sampleRate)) {
        // ms → samples; clamp end to the buffer so a rounding overshoot at the
        // tail (the library extrapolates from the last frame's end) can't push
        // past `totalSamples`.
        const startSamples = Math.max(0, Math.floor((segment.start / 1000) * sampleRate));
        const endSamples = Math.min(totalSamples, Math.floor((segment.end / 1000) * sampleRate));
        if (endSamples > startSamples) segments.push({ start: startSamples, end: endSamples });
      }
      return segments;
    });
  }

  /**
   * Free the Silero model and clear cached state after pending scans settle.
   */
  dispose(): void {
    this.generation++;
    const v = this.vad;
    this.vad = null;
    this.initPromise = null;
    this.failed = false;
    if (!v) return;
    // Do not release a session while an in-flight run is still using it.
    void this.runQueue.then(() => releaseVad(v));
  }

  /** Test-only: did the last init attempt fail? */
  get isFailed(): boolean { return this.failed; }
}

function releaseVad(vad: LocalVadEngine): void {
  try {
    const release = vad.destroy ?? vad.release;
    if (release) void Promise.resolve(release.call(vad)).catch(() => {});
  } catch {
    // Best-effort teardown, including asynchronous release failures.
  }
}

/** Reset the module-level instance. Test-only. */
export function __resetSileroVADForTests(): void {
  instance = null;
}

/**
 * Quick energy pass over a 16-bit LE PCM buffer. Frames below `rmsFloor`
 * count as silence; the rest count as energetic. Used to short-circuit
 * Silero on fully-silent buffers and to populate the silence/noise
 * distinction expected by the HUD. `rmsFloor` comes from the user-tunable
 * voice-gate sensitivity setting; production callers always pass it
 * through explicitly so test/default behaviour and live behaviour cannot
 * silently diverge.
 */
function countEnergyFrames(pcm: Uint8Array, rmsFloor: number): {
  silenceFrames: number;
  energeticFrames: number;
  totalFrames: number;
} {
  const totalSamples = pcm.length >> 1;
  const frameSamples = Math.min(ENERGY_FRAME_SAMPLES, totalSamples);
  if (frameSamples === 0) {
    return { silenceFrames: 0, energeticFrames: 0, totalFrames: 0 };
  }
  const frameCount = Math.ceil(totalSamples / frameSamples);
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let silenceFrames = 0;
  let energeticFrames = 0;
  for (let f = 0; f < frameCount; f++) {
    const start = f * frameSamples;
    const samplesInFrame = Math.min(frameSamples, totalSamples - start);
    let sumSq = 0;
    for (let i = 0; i < samplesInFrame; i++) {
      const s = dv.getInt16((start + i) * 2, true);
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / samplesInFrame);
    if (rms < rmsFloor) silenceFrames++;
    else energeticFrames++;
  }
  return { silenceFrames, energeticFrames, totalFrames: frameCount };
}

/** Convert PCM to [-1, 1], padding the partial frame the library would drop. */
function int16ToFloat32(pcm: Uint8Array, sampleRate: number): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 16_000) {
    throw new Error('SileroVAD: sample rate must be at least 16000 Hz');
  }
  const samples = pcm.length >> 1;
  const outputSamples = Math.ceil((samples * 16_000) / sampleRate);
  const out = new Float32Array(Math.ceil(outputSamples / MODEL_FRAME_SAMPLES) * MODEL_FRAME_SAMPLES);
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  // G2 already supplies 16 kHz PCM. Avoid resampling arithmetic and an inner
  // loop for every sample on the phone's UI thread.
  if (sampleRate === 16_000) {
    for (let i = 0; i < samples; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
    return out;
  }
  for (let i = 0; i < outputSamples; i++) {
    const start = Math.ceil((i * sampleRate) / 16_000);
    const end = Math.min(samples, Math.ceil(((i + 1) * sampleRate) / 16_000));
    let sum = 0;
    for (let j = start; j < end; j++) sum += dv.getInt16(j * 2, true);
    out[i] = end > start ? sum / (end - start) / 32768 : 0;
  }
  return out;
}

interface CandidateExports {
  memory: WebAssembly.Memory;
  input_ptr: () => number;
  predict: (frames: number) => number;
  reset: () => void;
}

// wasm-bindgen's generated initializer has no in-flight promise cache. Share
// initialization across old/new sessions so two loads cannot replace its
// global WASM instance while model objects still belong to the first one.
let fluidInitialization: Promise<typeof import('@fluidinference/fluidvad/dist/fluidvad.js')> | null = null;

function loadFluidVad(): NonNullable<typeof fluidInitialization> {
  if (!fluidInitialization) {
    fluidInitialization = (async () => {
      const mod = await import('@fluidinference/fluidvad/dist/fluidvad.js');
      await mod.default();
      return mod;
    })().catch((error) => { fluidInitialization = null; throw error; });
  }
  return fluidInitialization;
}

/** Independent Earshot instances; Silero's compiled WASM module is shared. */
async function createCascadeVAD(): Promise<LocalVadEngine> {
  const response = await fetch(CANDIDATE_MODEL_URL);
  if (!response.ok) throw new Error(`VAD candidate model: HTTP ${response.status}`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
  const exports = instance.exports;
  if (!(exports.memory instanceof WebAssembly.Memory) ||
      typeof exports.input_ptr !== 'function' || typeof exports.predict !== 'function' ||
      typeof exports.reset !== 'function') throw new Error('VAD candidate model: incompatible WASM');
  const candidate = exports as unknown as CandidateExports;
  // Import the browser-only glue: the package's convenience entry also has
  // Node filesystem imports that should not enter a WebView/RN bundle.
  const { FluidVad, VadOptions } = await loadFluidVad();
  const options = new VadOptions();
  let silero: FluidVad;
  let transferred = false;
  try {
    options.threshold = 0.5;
    options.negativeThreshold = 0.35;
    options.minSpeechDuration = MIN_SPEECH_MS / 1000;
    options.minSilenceDuration = SPEECH_END_MS / 1000;
    options.maxSpeechDuration = Infinity;
    options.speechPadding = 0;
    // The wasm-bindgen constructor takes ownership of VadOptions, including
    // on constructor errors. Only free options that were never transferred.
    transferred = true;
    silero = new FluidVad(options);
  } finally {
    if (!transferred) options.free();
  }
  const reset = (): void => { candidate.reset(); silero.reset(); };
  return {
    frameProcessor: { endSegment: reset },
    destroy: () => silero.free(),
    run: async function* (audio) {
      const yieldIfNeeded = createInferenceBudget();
      const blockSamples = CANDIDATE_BLOCK_FRAMES * CANDIDATE_FRAME_SAMPLES;
      let start = -1;
      let positives = 0;
      let silence = 0;
      for (let offset = 0; offset < audio.length; offset += blockSamples) {
        const count = Math.min(blockSamples, audio.length - offset);
        const frames = Math.ceil(count / CANDIDATE_FRAME_SAMPLES);
        const input = new Float32Array(candidate.memory.buffer, candidate.input_ptr(), blockSamples);
        input.fill(0);
        input.set(audio.subarray(offset, offset + count));
        const output = candidate.predict(frames);
        const probabilities = new Float32Array(candidate.memory.buffer, output, frames);
        for (let f = 0; f < frames; f++) {
          const frameStart = offset + f * CANDIDATE_FRAME_SAMPLES;
          const probability = probabilities[f]!;
          if (probability >= 0.5) {
            if (start < 0) start = frameStart;
            positives++;
            silence = 0;
          }
          if (start >= 0 && probability < 0.35 && ++silence >= SILENCE_FRAMES) {
            const end = Math.min(audio.length, frameStart + CANDIDATE_FRAME_SAMPLES);
            if (positives >= MIN_SPEECH_FRAMES && await confirmSpeech(silero, audio, start, end, yieldIfNeeded)) {
              yield { audio: audio.subarray(start, end), start: start / 16, end: end / 16 };
            }
            start = -1;
            positives = 0;
            silence = 0;
          }
        }
        // Elapsed time matters on slower phones; a fixed number of blocks
        // can otherwise monopolize the UI thread for tens of milliseconds.
        const pause = yieldIfNeeded();
        if (pause) await pause;
      }
      if (start >= 0 && positives >= MIN_SPEECH_FRAMES && await confirmSpeech(silero, audio, start, audio.length, yieldIfNeeded)) {
        yield { audio: audio.subarray(start), start: start / 16, end: audio.length / 16 };
      }
    },
  };
}

/** V6 checks only until 200 ms of speech is confirmed, then stops inference. */
async function confirmSpeech(
  silero: FluidVad, audio: Float32Array, start: number, end: number,
  yieldIfNeeded: () => Promise<void> | undefined,
): Promise<boolean> {
  silero.reset();
  const from = Math.max(0, start - VALIDATION_PAD_SAMPLES);
  const to = Math.min(audio.length, end + VALIDATION_PAD_SAMPLES);
  for (let offset = from; offset < to; offset += MODEL_FRAME_SAMPLES) {
    let frame = audio.subarray(offset, Math.min(to, offset + MODEL_FRAME_SAMPLES));
    if (frame.length < MODEL_FRAME_SAMPLES) {
      const padded = new Float32Array(MODEL_FRAME_SAMPLES);
      padded.set(frame);
      frame = padded;
    }
    const events = silero.push(frame);
    try {
      if (events.some((event) => event.isStart)) return true;
    } finally {
      for (const event of events) event.free();
    }
    const pause = yieldIfNeeded();
    if (pause) await pause;
  }
  return false;
}

/** Share one wall-clock budget across candidate and confirmation inference. */
function createInferenceBudget(): () => Promise<void> | undefined {
  let deadline = performance.now() + INFERENCE_SLICE_MS;
  return () => {
    if (performance.now() < deadline) return undefined;
    return new Promise<void>((resolve) => setTimeout(() => {
      deadline = performance.now() + INFERENCE_SLICE_MS;
      resolve();
    }, 0));
  };
}
