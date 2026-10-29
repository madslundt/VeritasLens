/// <reference lib="webworker" />
import createModule from '@jitsi/rnnoise-wasm/dist/rnnoise.js';
import wasmUrl from '@jitsi/rnnoise-wasm/dist/rnnoise.wasm?url';
import { processNoiseSnapshot } from '@/runtime/noiseReductionEngine';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async ({ data }: MessageEvent<{ pcm: ArrayBuffer }>) => {
  try {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`RNNoise WASM: HTTP ${response.status}`);
    const module = await createModule({ wasmBinary: new Uint8Array(await response.arrayBuffer()) });
    const view = new DataView(data.pcm);
    if (!view.byteLength || view.byteLength % 2) throw new Error('Invalid PCM snapshot');
    const input = new Float32Array(view.byteLength / 2);
    for (let i = 0; i < input.length; i++) input[i] = view.getInt16(i * 2, true) / 32768;
    const { audio } = processNoiseSnapshot(module, input);
    const pcm = new Uint8Array(view.byteLength);
    const output = new DataView(pcm.buffer);
    for (let i = 0; i < audio.length; i++) output.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(audio[i] * 32768))), true);
    self.postMessage({ pcm: pcm.buffer }, [pcm.buffer]);
  } catch {
    // Never include captured audio in errors/logs. The caller keeps the raw
    // snapshot and degrades to it on every worker/model failure.
    self.postMessage({ error: 'Noise reduction unavailable' });
  }
};
