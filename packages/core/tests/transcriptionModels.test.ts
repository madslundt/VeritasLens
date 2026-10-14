import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTranscriptionModels } from '../src/llm/transcriptionModels';

const primary = 'https://whisper.example/v1';
const alternate = 'https://whisper-backup.example/v1';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Whisper model discovery', () => {
  it('uses built-in transcription choices without a network request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await fetchTranscriptionModels('', 'https://api.openai.com/v1')).toContain('whisper-1');
    expect(await fetchTranscriptionModels('', 'https://api.groq.com/openai/v1')).toContain('whisper-large-v3');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('discovers arbitrary IDs from the alternative server using the primary key', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Primary unreachable')).mockResolvedValueOnce(json({
      data: [{ id: 'distil-large-v3' }, { id: 'local-model' }, { id: 'distil-large-v3' }, { id: '' }, { id: 5 }, null],
    }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchTranscriptionModels('same-server-key', `${primary}/`, undefined, [alternate])).toEqual(['distil-large-v3', 'local-model']);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${primary}/models`, `${alternate}/models`]);
    for (const [, init] of fetch.mock.calls) expect(new Headers(init.headers).get('authorization')).toBe('Bearer same-server-key');
  });

  it('supports unauthenticated custom servers', async () => {
    const fetch = vi.fn(async () => json({ data: [{ id: 'local-whisper' }] }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchTranscriptionModels('', primary)).toEqual(['local-whisper']);
    const call = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(new Headers(call[0]![1].headers).has('authorization')).toBe(false);
  });

  it.each([404, 405, 501])('keeps manual entry available when discovery returns HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, status)));
    expect(await fetchTranscriptionModels('', primary)).toEqual([]);
  });

  it('reports authentication errors instead of trying another server', async () => {
    const fetch = vi.fn(async () => json({}, 401));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchTranscriptionModels('wrong-key', primary, undefined, [alternate])).rejects.toThrow('HTTP 401');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ignores unsupported catalog shapes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ models: ['not-openai-compatible'] })));
    expect(await fetchTranscriptionModels('', primary)).toEqual([]);
  });

  it('cancels model loading without contacting an alternative', async () => {
    const outer = new AbortController();
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const result = fetchTranscriptionModels('', primary, outer.signal, [alternate]);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    outer.abort();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled catalog request, including without fallback addresses', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })));
    const rejected = expect(fetchTranscriptionModels('', primary)).rejects.toMatchObject({ name: 'UploadTimeoutError' });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
