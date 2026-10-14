import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { SileroVADSession } from '../src/runtime/vad/silero';

function signal(fn: (i: number) => number): Uint8Array {
  const pcm = new Uint8Array(16_000 * 3 * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < pcm.length / 2; i++) view.setInt16(i * 2, Math.round(fn(i)), true);
  return pcm;
}

describe('packaged candidate and Silero v6 WASM', () => {
  const session = new SileroVADSession();

  beforeAll(async () => {
    const candidate = await readFile(new URL('../assets/vad/earshot-1.2.2.wasm', import.meta.url));
    const silero = await readFile(new URL('../../../node_modules/@fluidinference/fluidvad/dist/fluidvad_bg.wasm', import.meta.url));
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === './earshot-1.2.2.wasm') return new Response(candidate, { headers: { 'Content-Type': 'application/wasm' } });
      if (url.endsWith('/fluidvad_bg.wasm')) return new Response(silero, { headers: { 'Content-Type': 'application/wasm' } });
      throw new Error(`Unexpected network request in local VAD test: ${url}`);
    });
    await session.init();
  });

  afterAll(() => { session.dispose(); vi.unstubAllGlobals(); });

  it.each([60, 220, 440, 880])('rejects a sustained %i Hz tone using actual inference', async (hz) => {
    const pcm = signal((i) => 1200 * Math.sin(2 * Math.PI * hz * i / 16_000));
    expect((await session.predict(pcm, 16_000)).voiceFrames).toBe(0);
    expect(await session.extractSpeechSegments(pcm, 16_000)).toEqual([]);
  });

  it('rejects deterministic white noise and DC offset', async () => {
    let seed = 42;
    const noise = signal(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed / 4294967296 * 2 - 1) * 1200;
    });
    expect((await session.predict(noise, 16_000)).voiceFrames).toBe(0);
    expect((await session.predict(signal(() => 600), 16_000)).voiceFrames).toBe(0);
  });

  it('returns silence without loading models for empty or silent PCM', async () => {
    const fresh = new SileroVADSession();
    const init = vi.spyOn(fresh, 'init');
    expect((await fresh.predict(new Uint8Array(), 16_000)).voiceFrames).toBe(0);
    expect((await fresh.predict(signal(() => 0), 16_000)).voiceFrames).toBe(0);
    expect(init).not.toHaveBeenCalled();
    fresh.dispose();
  });
});
