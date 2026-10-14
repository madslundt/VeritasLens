import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENDPOINT_HEADER_TIMEOUT_MS, fetchWithEndpointFallback } from '../src/llm/endpointFallback';

const lan = 'http://192.168.1.20:1234/v1';
const tailscale = 'http://100.64.0.20:1234/v1';
const options = () => ({
  baseUrl: lan,
  fallbackUrls: [tailscale],
  apiKey: 'same-server-key',
  path: '/chat/completions',
  init: { method: 'POST', body: JSON.stringify({ model: 'same-model', stream: true }) },
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('fetchWithEndpointFallback', () => {
  it('uses Tailscale when the LAN address is unreachable, preserving key, model and request', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('Network unavailable'))
      .mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    const opts = options();
    expect(await (await fetchWithEndpointFallback(opts)).text()).toBe('ok');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${lan}/chat/completions`, `${tailscale}/chat/completions`]);
    for (const [, init] of fetch.mock.calls) {
      expect(init.body).toBe(opts.init.body);
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer same-server-key');
    }
  });

  it('replaces caller authorization with the supplied key and omits it for an unauthenticated server', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    await fetchWithEndpointFallback({
      ...options(), apiKey: '',
      init: { headers: { Authorization: 'Bearer unrelated-provider-secret', 'content-type': 'application/json' } },
    });
    const init = (fetch.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1];
    const headers = new Headers(init.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.get('content-type')).toBe('application/json');
  });

  it.each([408, 429, 500, 502, 503, 504])('discards HTTP %s before trying the next address', async (status) => {
    const cancel = vi.fn();
    const failed = new Response(new ReadableStream({ cancel }), { status });
    const fetch = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    const result = await fetchWithEndpointFallback(options());
    expect(result.ok).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 422])('returns terminal HTTP %s without fallback', async (status) => {
    const response = new Response('terminal', { status });
    const fetch = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetch);
    expect(await fetchWithEndpointFallback(options())).toBe(response);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe('terminal');
  });

  it('returns the final HTTP error with its body for provider retry handling', async () => {
    const final = new Response('overloaded', { status: 503 });
    const fetch = vi.fn().mockResolvedValueOnce(new Response('retry', { status: 429 })).mockResolvedValueOnce(final);
    vi.stubGlobal('fetch', fetch);
    expect(await fetchWithEndpointFallback(options())).toBe(final);
    expect(await final.text()).toBe('overloaded');
  });

  it('bounds each unreachable address to ten seconds before fallback', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      }))
      .mockResolvedValueOnce(new Response('reachable'));
    vi.stubGlobal('fetch', fetch);
    const result = fetchWithEndpointFallback(options());
    await vi.advanceTimersByTimeAsync(ENDPOINT_HEADER_TIMEOUT_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await result).text()).toBe('reachable');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the caller signal and adds no deadline for a single unique address', async () => {
    vi.useFakeTimers();
    const outer = new AbortController();
    const fetch = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    await fetchWithEndpointFallback({ ...options(), fallbackUrls: [`${lan}/`], init: { signal: outer.signal } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1].signal).toBe(outer.signal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a timeout when the final address also fails to return headers', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const result = fetchWithEndpointFallback(options());
    const rejected = expect(result).rejects.toMatchObject({ name: 'UploadTimeoutError' });
    await vi.advanceTimersByTimeAsync(ENDPOINT_HEADER_TIMEOUT_MS * 2);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not contact any address when the outer signal was already aborted', async () => {
    const outer = new AbortController();
    outer.abort();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(fetchWithEndpointFallback({ ...options(), init: { signal: outer.signal } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops immediately on outer cancellation during the primary request', async () => {
    const outer = new AbortController();
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const result = fetchWithEndpointFallback({ ...options(), init: { signal: outer.signal } });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    outer.abort();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('normalizes and deduplicates addresses in order', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    await fetchWithEndpointFallback({ ...options(), baseUrl: `${lan}///`, fallbackUrls: [lan, `${tailscale}/`, tailscale] });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${lan}/chat/completions`, `${tailscale}/chat/completions`]);
  });

  it('rejects invalid alternative addresses before making any network request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(fetchWithEndpointFallback({ ...options(), fallbackUrls: [tailscale, 'https://user:secret@host/v1'] })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps cancellation active after successful headers and never falls back during streaming', async () => {
    vi.useFakeTimers();
    const outer = new AbortController();
    const fetch = vi.fn((_url: string, init: RequestInit) => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
      },
    }))));
    vi.stubGlobal('fetch', fetch);
    const response = await fetchWithEndpointFallback({ ...options(), init: { signal: outer.signal } });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('partial');
    await vi.advanceTimersByTimeAsync(ENDPOINT_HEADER_TIMEOUT_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(1);
    outer.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps stream cancellation working in WebViews without AbortSignal.any', async () => {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
    try {
      const outer = new AbortController();
      let requestSignal: AbortSignal | undefined;
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        requestSignal = init.signal!;
        return new Response('ok');
      }));
      await fetchWithEndpointFallback({ ...options(), init: { signal: outer.signal } });
      outer.abort();
      expect(requestSignal!.aborted).toBe(true);
    } finally {
      if (original) Object.defineProperty(AbortSignal, 'any', original);
      else Reflect.deleteProperty(AbortSignal, 'any');
    }
  });
});
