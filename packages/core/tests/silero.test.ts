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

  it('calls the underlying destroy hook at most once across repeated dispose calls', async () => {
    const session = getSileroVAD() as unknown as { vad: { destroy: ReturnType<typeof vi.fn> } | null; dispose: () => void };
    const destroy = vi.fn();
    session.vad = { destroy };

    session.dispose();
    session.dispose();
    await Promise.resolve();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(session.vad).toBeNull();
  });

  it('returns extracted speech segments in sample offsets and clamps segment ends', async () => {
    const session = getSileroVAD() as unknown as {
      init: () => Promise<void>;
      vad: {
        run: (input: Float32Array, sampleRate: number) => AsyncGenerator<{ start: number; end: number }>;
        frameProcessor: { endSegment: ReturnType<typeof vi.fn> };
      } | null;
      extractSpeechSegments: (pcm: Uint8Array, sampleRate: number, rmsFloor?: number) => Promise<Array<{ start: number; end: number }>>;
    };

    session.init = vi.fn(async () => {});
    session.vad = {
      frameProcessor: { endSegment: vi.fn(() => ({})) },
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

  it('does not skip inference when speech appears only in a final partial energy frame', async () => {
    const session = getSileroVAD();
    const run = vi.fn(async function* () {
      yield { audio: new Float32Array(1600), start: 250, end: 350 };
    });
    vi.spyOn(session, 'init').mockResolvedValue(undefined);
    (session as unknown as { vad: unknown }).vad = {
      run,
      frameProcessor: { endSegment: vi.fn(() => ({})) },
    };
    const pcm = pcm16([...new Array(4000).fill(0), ...new Array(1600).fill(1)]);

    const result = await session.predict(pcm, 16_000);
    expect(result.voiceFrames).toBe(1);
    expect(result.totalFrames).toBe(2);
    expect(run).toHaveBeenCalledTimes(1);
    await expect(session.extractSpeechSegments(pcm, 16_000)).resolves.toEqual([
      { start: 4000, end: 5600 },
    ]);
  });
});
