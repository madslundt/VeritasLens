// src/runtime/vad/index.ts
//
// Public VAD entrypoint. Tries Silero first (ONNX model via onnxruntime-web),
// falls back to the FFT heuristic in `../audioBuffer` if the model cannot
// load (test environment without `window`, missing assets, etc.). Callers
// import only from here.

import { analyzeBufferForVoiceFFT, type VoiceBufferAnalysis } from '@/runtime/audioBuffer';
import { pushDebugEvent } from '@/state/store';
import { getSileroVAD } from './silero';

export type { VoiceBufferAnalysis } from '@/runtime/audioBuffer';

/**
 * Whether Silero is reachable from this environment. Once `init()` rejects
 * we keep this `false` for the rest of the runtime so subsequent calls
 * don't re-attempt module imports on every user tap.
 */
let sileroAvailable: boolean | null = null;

/**
 * Fire-and-forget Silero init, used from `startHudRuntime()` so the model is
 * already warm by the time the user double-taps for the first analysis.
 * Safe to call multiple times; the underlying init is idempotent. Both
 * success and failure are written to the debug log so the on-glasses /
 * settings panel can show whether the runtime is on the model path or the
 * lenient FFT fallback.
 */
export async function warmupVAD(): Promise<void> {
  try {
    pushDebugEvent({ label: 'vad-warmup', detail: 'Silero init starting…' });
    if (import.meta.env.DEV) console.log('[vad] Silero init starting');
    await getSileroVAD().init();
    sileroAvailable = true;
    pushDebugEvent({ label: 'vad-warmup', detail: 'Silero ready' });
    if (import.meta.env.DEV) console.log('[vad] Silero ready');
  } catch (err) {
    sileroAvailable = false;
    const msg = describeError(err);
    pushDebugEvent({ label: 'vad-warmup', detail: `Silero failed, FFT fallback active — ${msg}` });
    if (import.meta.env.DEV) {
      console.error('[vad] Silero failed, FFT fallback active —', msg);
      console.error('[vad] raw error object:', err);
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const base = `${err.name}: ${err.message}`;
    const cause = (err as { cause?: unknown }).cause;
    return cause ? `${base} (cause: ${describeError(cause)})` : base;
  }
  if (err && typeof err === 'object') {
    try { return JSON.stringify(err, Object.getOwnPropertyNames(err as object)); }
    catch { return Object.prototype.toString.call(err); }
  }
  return String(err);
}

/**
 * Score a 16-bit LE PCM buffer for voice presence. Async; the wrapper awaits
 * Silero if available, otherwise runs the synchronous FFT fallback inline.
 * Both paths return the same `VoiceBufferAnalysis` shape so callers don't
 * have to branch. The path actually used (silero vs fft) and the resulting
 * frame tallies are written to the debug log so the user can verify what
 * the gate is doing for each tap.
 */
export async function analyzeBufferForVoice(
  pcm: Uint8Array,
  sampleRate: number,
  rmsFloor: number = 200,
): Promise<VoiceBufferAnalysis> {
  // Skip Silero entirely if we already know it isn't available — avoids
  // paying the rejected-promise round-trip on every tap.
  if (sileroAvailable === false) {
    const r = analyzeBufferForVoiceFFT(pcm, sampleRate, rmsFloor);
    logVad('fft', r, pcm.length);
    return r;
  }
  try {
    const result = await getSileroVAD().predict(pcm, sampleRate, rmsFloor);
    sileroAvailable = true;
    logVad('silero', result, pcm.length);
    return result;
  } catch (err) {
    sileroAvailable = false;
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    pushDebugEvent({ label: 'vad-error', detail: `Silero predict failed, FFT fallback — ${msg}` });
    const r = analyzeBufferForVoiceFFT(pcm, sampleRate, rmsFloor);
    logVad('fft', r, pcm.length);
    return r;
  }
}

function logVad(path: 'silero' | 'fft', r: VoiceBufferAnalysis, byteLength: number): void {
  const seconds = (byteLength >> 1) / 16_000;
  const detail = `${path} | ${seconds.toFixed(1)}s | voice=${r.voiceFrames} silence=${r.silenceFrames} noise=${r.noiseFrames}`;
  pushDebugEvent({ label: 'vad-decision', detail });
  if (import.meta.env.DEV) console.log('[vad]', detail);
}

/**
 * Extract every speech segment in the PCM buffer (Silero only — the FFT
 * fallback has no segment-level output, so we report "not available" and
 * callers ship the full WAV instead of a trimmed one). Returns `null` to
 * signal "trim not possible, use full PCM" — distinct from `[]` ("ran, found
 * nothing"), which also defeats trimming but tells the caller the buffer
 * really did not contain speech regions.
 */
export async function extractSpeechSegments(
  pcm: Uint8Array,
  sampleRate: number,
  rmsFloor: number = 200,
): Promise<Array<{ start: number; end: number }> | null> {
  if (sileroAvailable === false) return null;
  try {
    const segments = await getSileroVAD().extractSpeechSegments(pcm, sampleRate, rmsFloor);
    sileroAvailable = true;
    return segments;
  } catch (err) {
    sileroAvailable = false;
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    pushDebugEvent({ label: 'vad-error', detail: `Silero segment extract failed — ${msg}` });
    return null;
  }
}

/**
 * Reset the cached availability flag so the next `analyzeBufferForVoice` call
 * re-probes Silero. Used by both the runtime (on `stopHudRuntime`, so a
 * subsequent `startHudRuntime` doesn't inherit a stale "FFT only" decision
 * from the previous session) and by the test suite (each case starts fresh).
 */
export function resetVADAvailability(): void {
  sileroAvailable = null;
}

/** @deprecated alias kept for the existing test imports. */
export const __resetVADAvailabilityForTests = resetVADAvailability;
