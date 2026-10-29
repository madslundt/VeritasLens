import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { denoiseRnnoise } from './rnnoise.mjs';
import { noise } from './dsp.mjs';

const originalFetch = globalThis.fetch;
before(async () => {
  const bytes = await readFile(new URL('../../node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm', import.meta.url));
  globalThis.fetch = async (url) => {
    assert.ok(String(url).endsWith('/rnnoise.wasm'));
    return new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } });
  };
});
after(() => { globalThis.fetch = originalFetch; });

test('zero suppression preserves exact input, including an incomplete final frame', async () => {
  const audio = noise(16073);
  const result = await denoiseRnnoise(audio, { delay: 160, strength: 0 });
  assert.deepEqual(result.audio, audio);
});

test('concurrent snapshots keep independent recurrent state and free their allocations', async () => {
  const audio = noise(16000);
  const baseline = await denoiseRnnoise(audio, { delay: 160 });
  const snapshots = await Promise.all(Array.from({ length: 8 }, () => denoiseRnnoise(audio, { delay: 160 })));
  for (const result of snapshots) {
    assert.deepEqual(result.audio, baseline.audio);
    assert.equal(result.timing.wasmMemoryBytes, baseline.timing.wasmMemoryBytes);
  }
});

test('rejects invalid suppression strength', async () => {
  await assert.rejects(denoiseRnnoise(new Float32Array(1), { strength: 2 }), /Invalid/);
});
