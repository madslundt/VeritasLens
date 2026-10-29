// Windowed-sinc polyphase resampling, including an antialiasing filter when
// downsampling. Symmetric kernels compensate their own delay. Zero-pad edges.
// Cache coefficients instead of evaluating trig functions for every sample.
const kernels = new Map<string, Float64Array[]>();
export function resample(audio: Float32Array, from: number, to: number): Float32Array {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || to <= 0) throw new Error('Invalid sample rate');
  if (from === to) return audio.slice();
  const cutoff = Math.min(1, to / from) * 0.94;
  const radius = Math.ceil(24 / cutoff);
  const out = new Float32Array(Math.round(audio.length * to / from));
  const key = `${from}/${to}`;
  let phases = kernels.get(key);
  if (!phases) {
    let a = from, b = to;
    while (b) [a, b] = [b, a % b];
    const count = to / a;
    if (count > 1024 || radius > 1024) throw new Error('Unsupported resampling ratio');
    phases = Array.from({ length: count }, (_, phaseIndex) => {
      const phase = ((phaseIndex * from) % to) / to;
      let kernel = new Float64Array(radius * 2 + 1);
      let sum = 0;
      for (let tap = -radius; tap <= radius; tap++) {
        const distance = tap - phase;
        const x = distance * cutoff;
        const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const window = Math.abs(distance) > radius ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * distance / radius);
        kernel[tap + radius] = cutoff * sinc * window;
        sum += kernel[tap + radius];
      }
      return kernel.map((weight) => weight / sum);
    });
    kernels.set(key, phases);
  }
  // G2's 16↔48 kHz path uses only three interpolation phases and one
  // decimation phase. Share input reads, move edge handling outside the dot
  // product, and exploit the symmetric decimation kernel. Coefficients and
  // zero-padded edge behavior match the generic path below.
  if (from === 16000 && to === 48000) {
    const [k0, k1, k2] = phases;
    for (let center = 0; center < audio.length; center++) {
      const start = center - radius;
      const first = Math.max(0, -start);
      const last = Math.min(k0.length, audio.length - start);
      let s0 = 0, s1 = 0, s2 = 0;
      for (let tap = first; tap < last; tap++) {
        const value = audio[start + tap];
        s0 += value * k0[tap]; s1 += value * k1[tap]; s2 += value * k2[tap];
      }
      out[center * 3] = s0; out[center * 3 + 1] = s1; out[center * 3 + 2] = s2;
    }
    return out;
  }
  if (from === 48000 && to === 16000) {
    const kernel = phases[0];
    for (let i = 0; i < out.length; i++) {
      const center = i * 3;
      let sum = 0;
      if (center >= radius && center + radius < audio.length) {
        sum = audio[center] * kernel[radius];
        for (let tap = 0; tap < radius; tap++) {
          sum += (audio[center - radius + tap] + audio[center + radius - tap]) * kernel[tap];
        }
      } else {
        const start = center - radius;
        const first = Math.max(0, -start);
        const last = Math.min(kernel.length, audio.length - start);
        for (let tap = first; tap < last; tap++) sum += audio[start + tap] * kernel[tap];
      }
      out[i] = sum;
    }
    return out;
  }
  for (let i = 0; i < out.length; i++) {
    const center = Math.floor(i * from / to);
    const kernel = phases[i % phases.length];
    let sum = 0;
    for (let tap = -radius; tap <= radius; tap++) {
      const index = center + tap;
      if (index >= 0 && index < audio.length) sum += audio[index] * kernel[tap + radius];
    }
    out[i] = sum;
  }
  return out;
}



/** C API exposed by the pinned Jitsi RNNoise WASM builds. */
export interface RnnoiseModule {
  HEAPF32: Float32Array;
  _rnnoise_create(model: number): number;
  _rnnoise_destroy(state: number): void;
  _rnnoise_process_frame(state: number, output: number, input: number): number;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
}

export interface NoiseSnapshotOptions {
  delay?: number;
  strength?: number;
  normalizeQuiet?: boolean;
}

const rounded = (value: number): number => Math.round(value * 100) / 100;

/**
 * Independent 16 kHz snapshots; never mutate the source. Small RNNoise has
 * 10 ms of algorithmic delay (160 source samples). Flush the final frame and
 * compensate delay before blending with the time-aligned original signal.
 * The lab uses this exact engine for its model/quality comparisons.
 */
export function processNoiseSnapshot(
  module: RnnoiseModule, input: Float32Array,
  { delay = 160, strength = 0.5, normalizeQuiet = true }: NoiseSnapshotOptions = {},
) {
  if (!(strength >= 0 && strength <= 1)) throw new Error('Invalid RNNoise strength');
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 1600) throw new Error('Invalid RNNoise delay');
  if (!input.length) throw new Error('Empty RNNoise snapshot');
  const start = performance.now();
  const state = module._rnnoise_create(0);
  const pointer = module._malloc(480 * 4);
  if (!state || !pointer) {
    if (state) module._rnnoise_destroy(state);
    if (pointer) module._free(pointer);
    throw new Error('RNNoise allocation failed');
  }
  const initMs = performance.now() - start;
  try {
    let peak = 0, energy = 0;
    for (const value of input) {
      if (!Number.isFinite(value)) throw new Error('Nonfinite RNNoise input');
      peak = Math.max(peak, Math.abs(value)); energy += value * value;
    }
    const level = Math.sqrt(energy / input.length);
    const gain = normalizeQuiet && level > 0 ? Math.max(1, Math.min(64, 0.05 / level, 0.9 / peak)) : 1;
    const upStart = performance.now();
    const up = resample(input, 16000, 48000);
    const upsampleMs = performance.now() - upStart;
    const output = new Float32Array(Math.ceil((up.length + 4800) / 480) * 480);
    const timings: number[] = [];
    const inferenceStart = performance.now();
    for (let offset = 0; offset < output.length; offset += 480) {
      const frame = module.HEAPF32.subarray(pointer / 4, pointer / 4 + 480);
      // RNNoise's float API uses PCM16-scale samples, rather than [-1, 1].
      for (let i = 0; i < 480; i++) frame[i] = (up[offset + i] ?? 0) * 32768 * gain;
      const begin = performance.now();
      module._rnnoise_process_frame(state, pointer, pointer);
      timings.push(performance.now() - begin);
      for (let i = 0; i < 480; i++) output[offset + i] = frame[i] / (32768 * gain);
    }
    const inferenceMs = performance.now() - inferenceStart;
    const downStart = performance.now();
    const delayed = resample(output, 48000, 16000);
    const audio = delayed.slice(delay, delay + input.length);
    if (strength < 1) for (let i = 0; i < audio.length; i++) audio[i] = strength * audio[i] + (1 - strength) * input[i];
    if (audio.length !== input.length || !audio.every(Number.isFinite)) throw new Error('Invalid RNNoise output');
    const totalMs = performance.now() - start;
    timings.sort((a, b) => a - b);
    return { audio, delayed, timing: {
      initMs: rounded(initMs), totalMs: rounded(totalMs),
      inferenceMs: rounded(inferenceMs), upsampleMs: rounded(upsampleMs), downsampleMs: rounded(performance.now() - downStart),
      rtf: rounded(totalMs / (input.length / 16)),
      frameP95Ms: rounded(timings[Math.floor(timings.length * 0.95)]), frameMaxMs: rounded(timings.at(-1)!),
      wasmMemoryBytes: module.HEAPF32.buffer.byteLength, inputGain: rounded(gain), strength, normalizeQuiet,
    } };
  } finally { module._free(pointer); module._rnnoise_destroy(state); }
}
