import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSileroVADForTests, getSileroVAD } from '../src/runtime/vad/silero';
import { extractSpeechSegments, resetVADAvailability, warmupVAD } from '../src/runtime/vad';

function pcm16(samples: number[]): Uint8Array {
  const pcm = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample * 1200, true));
  return pcm;
}

// Deliberately stateful, asynchronous inference at the adapter seam. Real
// candidate + v6 inference is covered separately by the WASM integration test
// and scripts/test-vad-real.mjs; these tests exercise snapshot scheduling.
function installVad(process?: () => Promise<void>) {
  const session = getSileroVAD();
  const internal = session as unknown as { vad: unknown; doInit: () => Promise<void> };
  let state = 0;
  let active = 0;
  let maxActive = 0;
  const states: number[] = [];
  const inputs: Float32Array[] = [];
  const destroy = vi.fn();
  const vad = {
    destroy,
    frameProcessor: { endSegment: () => { state = 0; } },
    run: async function* (input: Float32Array) {
      states.push(state++);
      inputs.push(input);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await process?.();
        if (input.some((s) => s > 0) && input.length >= 7 * 512) {
          yield { audio: input, start: 0, end: input.length / 16 };
        }
      } finally { active--; }
    },
  };
  const startup = vi.spyOn(internal, 'doInit').mockImplementation(async () => { internal.vad = vad; });
  return { session, states, inputs, destroy, startup, get maxActive() { return maxActive; } };
}

describe('Silero snapshot inference', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetSileroVADForTests();
    resetVADAvailability();
  });

  it('resets recurrent state after an early presence result and before the next snapshot', async () => {
    const model = installVad();
    const pcm = pcm16(new Array(16_000).fill(1));
    expect((await model.session.predict(pcm, 16_000)).voiceFrames).toBe(1);
    expect((await model.session.predict(pcm16(new Array(16_000).fill(-1)), 16_000)).voiceFrames).toBe(0);
    expect(model.states).toEqual([0, 0]);
  });

  it('serializes presence checks and trimming on the shared recurrent models', async () => {
    const model = installVad(async () => { await Promise.resolve(); });
    const pcm = pcm16(new Array(16_000).fill(1));
    const [presence, segments] = await Promise.all([
      model.session.predict(pcm, 16_000),
      model.session.extractSpeechSegments(pcm, 16_000),
    ]);
    expect(model.maxActive).toBe(1);
    expect(presence.voiceFrames).toBe(1);
    expect(segments).toEqual([{ start: 0, end: 16_000 }]);
    expect(model.states).toEqual([0, 0]);
  });

  it.each([16_000, 44_100, 48_000])('resamples and pads the final partial v6 frame at %i Hz without extending trim offsets', async (rate) => {
    const model = installVad();
    const samples = Math.floor((6 * 512 + 200) * rate / 16_000);
    const pcm = pcm16(new Array(samples).fill(1));
    expect((await model.session.predict(pcm, rate)).voiceFrames).toBe(1);
    expect(model.inputs[0]).toHaveLength(7 * 512);
    expect(model.inputs[0]![6 * 512]).toBeCloseTo(1200 / 32768);
    expect(model.inputs[0]!.at(-1)).toBe(0);
    expect(await model.session.extractSpeechSegments(pcm, rate)).toEqual([{ start: 0, end: samples }]);
  });

  it('resets after inference errors and lets the next queued snapshot run', async () => {
    let fail = true;
    const model = installVad(async () => {
      if (fail) { fail = false; throw new Error('inference failed'); }
    });
    const pcm = pcm16(new Array(16_000).fill(1));
    const first = model.session.predict(pcm, 16_000);
    const second = model.session.predict(pcm, 16_000);
    await expect(first).rejects.toThrow('inference failed');
    await expect(second).resolves.toMatchObject({ voiceFrames: 1 });
    expect(model.states).toEqual([0, 0]);
  });

  it('ignores an old warmup failure after disposal and a new successful warmup', async () => {
    const model = installVad();
    let finish!: () => void;
    const finishing = new Promise<void>((resolve) => { finish = resolve; });
    model.startup.mockImplementationOnce(async () => {
      await finishing;
      throw new Error('old startup failed');
    });
    const oldWarmup = warmupVAD();
    model.session.dispose();
    resetVADAvailability();
    await warmupVAD();
    finish();
    await oldWarmup;
    expect(model.session.isFailed).toBe(false);
    const pcm = pcm16(new Array(16_000).fill(1));
    expect(await extractSpeechSegments(pcm, 16_000)).toEqual([{ start: 0, end: 16_000 }]);
    expect(model.startup).toHaveBeenCalledTimes(2);
  });

  it('waits for inference before releasing and rejects scans queued before disposal', async () => {
    let started!: () => void;
    let finish!: () => void;
    const starting = new Promise<void>((resolve) => { started = resolve; });
    const finishing = new Promise<void>((resolve) => { finish = resolve; });
    let firstFrame = true;
    const model = installVad(async () => {
      if (!firstFrame) return;
      firstFrame = false;
      started();
      await finishing;
    });
    const pcm = pcm16(new Array(16_000).fill(1));
    const first = model.session.predict(pcm, 16_000);
    await starting;
    const queued = model.session.extractSpeechSegments(pcm, 16_000);
    const stopped = Promise.all([
      expect(first).rejects.toThrow('disposed'), expect(queued).rejects.toThrow('disposed'),
    ]);
    model.session.dispose();
    expect(model.destroy).not.toHaveBeenCalled();
    finish();
    await stopped;
    expect(model.destroy).toHaveBeenCalledTimes(1);
    await expect(model.session.predict(pcm, 16_000)).resolves.toMatchObject({ voiceFrames: 1 });
  });
});
