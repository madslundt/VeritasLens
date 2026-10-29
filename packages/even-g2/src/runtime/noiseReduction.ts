export const NOISE_REDUCTION_TIMEOUT_MS = 1000;
// Full-snapshot resampling allocates 48 kHz float buffers. Bound memory before
// creating a worker; the timeout alone cannot prevent a large allocation burst.
export const MAX_NOISE_REDUCTION_DURATION_SEC = 30;

export interface SnapshotAudioFormat {
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
}

export interface NoiseReductionResult {
  pcm: Uint8Array;
  status: 'off' | 'filtered' | 'unsupported' | 'unavailable' | 'busy' | 'timeout' | 'failed' | 'reset';
  ms: number;
}

let unavailable = false;
let pending: (() => void) | null = null;

/** Release captured audio/model memory; a new session or toggle can retry. */
export function resetNoiseReduction(): void {
  pending?.();
  unavailable = false;
}

/**
 * Optional, bounded enhancement of one frozen PCM snapshot. Keep the original
 * in this realm and transfer only a copy. A timeout/model failure disables
 * further attempts until reset, avoiding a recurring one-second penalty on
 * unsupported/slow WebViews. Only one worker may hold audio at a time.
 */
export function reduceSnapshotNoise(
  pcm: Uint8Array,
  { enabled, signal, sampleRate, bitsPerSample, channels }: SnapshotAudioFormat & { enabled: boolean; signal: AbortSignal },
): Promise<NoiseReductionResult> {
  if (signal.aborted) return Promise.reject(new DOMException('Analysis cancelled', 'AbortError'));
  const raw = (status: NoiseReductionResult['status']): Promise<NoiseReductionResult> => Promise.resolve({ pcm, status, ms: 0 });
  if (!enabled) return raw('off');
  if (sampleRate !== 16000 || bitsPerSample !== 16 || channels !== 1 || pcm.length < 2 || pcm.length % 2) return raw('unsupported');
  if (pcm.length > MAX_NOISE_REDUCTION_DURATION_SEC * sampleRate * 2) return raw('unsupported');
  if (unavailable || typeof Worker === 'undefined') return raw('unavailable');
  if (pending) return raw('busy');
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: NoiseReductionResult['status'], filtered?: Uint8Array, aborted = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      pending = null;
      if (worker) {
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
        worker.terminate();
      }
      if (status === 'timeout' || status === 'failed') unavailable = true;
      if (aborted) reject(new DOMException('Analysis cancelled', 'AbortError'));
      else resolve({ pcm: filtered ?? pcm, status, ms: performance.now() - started });
    };
    const abort = (): void => finish('reset', undefined, true);
    pending = () => finish('reset');
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish('timeout'), NOISE_REDUCTION_TIMEOUT_MS);
    try {
      worker = new Worker(new URL('./noiseReduction.worker.ts', import.meta.url), { type: 'module' });
      worker.onerror = (event) => { event.preventDefault(); finish('failed'); };
      worker.onmessageerror = () => finish('failed');
      worker.onmessage = ({ data }: MessageEvent<{ pcm?: unknown }>) => {
        if (signal.aborted) { abort(); return; }
        // A delayed UI event loop must not accept a result outside the budget.
        if (performance.now() - started >= NOISE_REDUCTION_TIMEOUT_MS) { finish('timeout'); return; }
        if (!(data?.pcm instanceof ArrayBuffer) || data.pcm.byteLength !== pcm.byteLength) { finish('failed'); return; }
        finish('filtered', new Uint8Array(data.pcm));
      };
      const copy = pcm.slice();
      worker.postMessage({ pcm: copy.buffer }, [copy.buffer]);
    } catch { finish('failed'); }
  });
}
