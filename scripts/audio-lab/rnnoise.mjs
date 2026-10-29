import createSmallModule from '@jitsi/rnnoise-wasm/dist/rnnoise.js';
import { processNoiseSnapshot } from '../../packages/even-g2/src/runtime/noiseReductionEngine.ts';

// The smaller async build is RNNoise 0.1; the sync build contains RNNoise 0.2.
// Load only the selected model. Keep one WASM module but fresh recurrent state
// for each independent snapshot. All inference stays in the lab's worker.
const modules = new Map();
function loadModule(variant) {
  if (!modules.has(variant)) {
    modules.set(variant, (async () => {
      if (variant === 'modern') return (await import('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js')).default();
      if (variant !== 'small') throw new Error('Unknown RNNoise variant');
      const response = await fetch(new URL('../../node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm', import.meta.url));
      if (!response.ok) throw new Error(`RNNoise WASM: HTTP ${response.status}`);
      return createSmallModule({ wasmBinary: new Uint8Array(await response.arrayBuffer()) });
    })().catch((error) => { modules.delete(variant); throw error; }));
  }
  return modules.get(variant);
}
const rounded = (value) => Math.round(value * 100) / 100;

export async function denoiseRnnoise(input, { delay = 0, strength = 1, normalizeQuiet = true, variant = 'small' } = {}) {
  if (!(strength >= 0 && strength <= 1)) throw new Error('Invalid RNNoise strength');
  const start = performance.now();
  const module = await loadModule(variant);
  const loadingMs = performance.now() - start;
  const result = processNoiseSnapshot(module, input, { delay, strength, normalizeQuiet });
  result.timing.initMs = rounded(result.timing.initMs + loadingMs);
  result.timing.totalMs = rounded(result.timing.totalMs + loadingMs);
  result.timing.rtf = rounded(result.timing.totalMs / (input.length / 16));
  return result;
}
