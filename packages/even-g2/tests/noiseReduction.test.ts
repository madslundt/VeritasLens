import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_NOISE_REDUCTION_DURATION_SEC, NOISE_REDUCTION_TIMEOUT_MS, reduceSnapshotNoise, resetNoiseReduction } from '../src/runtime/noiseReduction';

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  pcm?: Uint8Array;
  terminate = vi.fn();
  constructor() { TestWorker.instances.push(this); }
  postMessage(message: { pcm: ArrayBuffer }, transfer: ArrayBuffer[]) {
    // Reproduce actual transferable ownership: a mistaken transfer of the
    // caller's raw buffer would detach it and fail the preservation test.
    this.pcm = new Uint8Array(structuredClone(message, { transfer }).pcm);
  }
  reply(pcm: unknown) { this.onmessage?.({ data: { pcm } } as MessageEvent); }
}
const format = { sampleRate: 16000, bitsPerSample: 16, channels: 1 };
const original = () => new Uint8Array([100, 0, 200, 0]);
const options = (controller = new AbortController()) => ({ ...format, enabled: true, signal: controller.signal });

describe('bounded noise reduction', () => {
  beforeEach(() => {
    resetNoiseReduction(); TestWorker.instances = [];
    vi.stubGlobal('Worker', TestWorker); vi.useFakeTimers();
  });
  afterEach(() => { resetNoiseReduction(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('does no worker/model work when off or when the PCM format is unsupported', async () => {
    const pcm = original();
    expect(await reduceSnapshotNoise(pcm, { ...options(), enabled: false })).toMatchObject({ pcm, status: 'off' });
    expect(await reduceSnapshotNoise(pcm, { ...options(), sampleRate: 8000 })).toMatchObject({ pcm, status: 'unsupported' });
    expect(await reduceSnapshotNoise(pcm, { ...options(), channels: 2 })).toMatchObject({ pcm, status: 'unsupported' });
    expect(TestWorker.instances).toHaveLength(0);
  });

  it('bounds memory before launching a worker for long snapshots', async () => {
    const limit = MAX_NOISE_REDUCTION_DURATION_SEC * format.sampleRate * 2;
    const long = new Uint8Array(limit + 2);
    const skipped = await reduceSnapshotNoise(long, options());
    expect(skipped.pcm).toBe(long);
    expect(skipped.status).toBe('unsupported');
    expect(TestWorker.instances).toHaveLength(0);
    const supported = new Uint8Array(limit);
    const result = reduceSnapshotNoise(supported, options());
    TestWorker.instances[0]!.reply(supported.slice().buffer);
    expect((await result).status).toBe('filtered');
  });

  it('transfers only a copy and releases the worker after accepting equal-length PCM', async () => {
    const pcm = original(); const promise = reduceSnapshotNoise(pcm, options());
    const worker = TestWorker.instances[0]!;
    worker.pcm!.fill(0);
    expect(pcm).toEqual(original()); expect(pcm.byteLength).toBe(4);
    worker.reply(new Uint8Array([50, 0, 100, 0]).buffer);
    const result = await promise;
    expect(result.status).toBe('filtered'); expect(result.pcm).toEqual(new Uint8Array([50, 0, 100, 0]));
    expect(pcm).toEqual(original()); expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back after one second and does not repeat the delay until reset', async () => {
    const pcm = original(); const promise = reduceSnapshotNoise(pcm, options());
    await vi.advanceTimersByTimeAsync(NOISE_REDUCTION_TIMEOUT_MS - 1);
    expect(TestWorker.instances[0]!.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(result.pcm).toBe(pcm); expect(result.status).toBe('timeout');
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect((await reduceSnapshotNoise(pcm, options())).status).toBe('unavailable');
    expect(TestWorker.instances).toHaveLength(1);
    resetNoiseReduction();
    const retry = reduceSnapshotNoise(pcm, options());
    TestWorker.instances[1]!.reply(pcm.slice().buffer);
    expect((await retry).status).toBe('filtered');
  });

  it('discards a late result even when the timeout callback has not run yet', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const pcm = original(); const promise = reduceSnapshotNoise(pcm, options());
    now.mockReturnValue(NOISE_REDUCTION_TIMEOUT_MS + 1);
    TestWorker.instances[0]!.reply(new Uint8Array(4).buffer);
    expect(await promise).toMatchObject({ pcm, status: 'timeout' });
  });

  it.each([null, new Uint8Array(2).buffer, 'invalid'])('keeps the original on malformed worker output %s', async value => {
    const pcm = original(); const promise = reduceSnapshotNoise(pcm, options());
    TestWorker.instances[0]!.reply(value);
    expect((await promise).pcm).toBe(pcm);
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect((await reduceSnapshotNoise(pcm, options())).status).toBe('unavailable');
  });

  it('handles unsupported Workers and synchronous or asynchronous startup failures', async () => {
    const pcm = original(); vi.stubGlobal('Worker', undefined);
    expect((await reduceSnapshotNoise(pcm, options())).status).toBe('unavailable');
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked by WebView'); } });
    expect(await reduceSnapshotNoise(pcm, options())).toMatchObject({ pcm, status: 'failed' });
    resetNoiseReduction(); vi.stubGlobal('Worker', TestWorker);
    const pending = reduceSnapshotNoise(pcm, options());
    TestWorker.instances[0]!.onerror!({ preventDefault: vi.fn() } as unknown as ErrorEvent);
    expect(await pending).toMatchObject({ pcm, status: 'failed' });
  });

  it('aborts processing without uploading and frees the worker immediately', async () => {
    const controller = new AbortController();
    const promise = reduceSnapshotNoise(original(), options(controller));
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    await expect(reduceSnapshotNoise(original(), options(controller))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('bounds concurrent memory and releases a pending snapshot on reset', async () => {
    const pcm = original(); const first = reduceSnapshotNoise(pcm, options());
    expect(await reduceSnapshotNoise(pcm, options())).toMatchObject({ pcm, status: 'busy' });
    expect(TestWorker.instances).toHaveLength(1);
    resetNoiseReduction();
    expect(await first).toMatchObject({ pcm, status: 'reset' });
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
});
