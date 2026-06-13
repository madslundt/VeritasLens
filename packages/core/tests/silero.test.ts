import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSileroVADForTests, getSileroVAD } from '../src/runtime/vad/silero';

function pcm16(samples: number[], amplitude = 1200): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const dv = new DataView(out.buffer);
  samples.forEach((sample, i) => dv.setInt16(i * 2, sample * amplitude, true));
  return out;
}

describe('SileroVADSession lifecycle', () => {
  beforeEach(() => {
    __resetSileroVADForTests();
    vi.restoreAllMocks();
  });

  it('reuses the singleton until reset', () => {
    const a = getSileroVAD();
    const b = getSileroVAD();
    expect(a).toBe(b);

    a.dispose();
    __resetSileroVADForTests();

    const c = getSileroVAD();
    expect(c).not.toBe(a);
  });

  it('clears failed init state on dispose so a later retry can succeed', async () => {
    const session = getSileroVAD();
    const doInit = vi.spyOn(session as unknown as { doInit: () => Promise<void> }, 'doInit');
    doInit.mockRejectedValueOnce(new Error('boom'));
    doInit.mockResolvedValueOnce(undefined);

    await expect(session.init()).rejects.toThrow('boom');
    expect(session.isFailed).toBe(true);

    session.dispose();
    expect(session.isFailed).toBe(false);

    await expect(session.init()).resolves.toBeUndefined();
    expect(doInit).toHaveBeenCalledTimes(2);
  });

  it('calls the underlying destroy hook at most once across repeated dispose calls', () => {
    const session = getSileroVAD() as unknown as { vad: { destroy: ReturnType<typeof vi.fn> } | null; dispose: () => void };
    const destroy = vi.fn();
    session.vad = { destroy };

    session.dispose();
    session.dispose();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(session.vad).toBeNull();
  });

  it('returns extracted speech segments in sample offsets and clamps segment ends', async () => {
    const session = getSileroVAD() as unknown as {
      init: () => Promise<void>;
      vad: { run: (input: Float32Array, sampleRate: number) => AsyncGenerator<{ start: number; end: number }> } | null;
      extractSpeechSegments: (pcm: Uint8Array, sampleRate: number, rmsFloor?: number) => Promise<Array<{ start: number; end: number }>>;
    };

    session.init = vi.fn(async () => {});
    session.vad = {
      run: async function* () {
        yield { start: 125, end: 500 };
        yield { start: 900, end: 1300 };
      },
    };

    const pcm = pcm16(new Array(16_000).fill(1));
    const segments = await session.extractSpeechSegments(pcm, 16_000, 10);

    expect(segments).toEqual([
      { start: 2000, end: 8000 },
      { start: 14400, end: 16000 },
    ]);
  });
});
