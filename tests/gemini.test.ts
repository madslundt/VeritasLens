// tests/gemini.test.ts
//
// Behaviour-lock tests for src/llm/gemini.ts. Network is mocked via
// vi.stubGlobal('fetch', ...). Captures the current retry/abort/error semantics
// so the Pass 3 cleanups (gating console chatter, schema-cast removal) don't
// silently alter behaviour.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  callLens,
  fetchAvailableModels,
  parseGoogleRetryDelayMs,
  parseRetryAfterMs,
} from '../src/llm/gemini';

const OK_RESPONSE = {
  candidates: [{ content: { parts: [{ text: '{"verdict":"TRUE","claim":"x","reason":"y"}' }] } }],
};

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: init?.headers ?? { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status: number, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('parseRetryAfterMs', () => {
  it('parses integer seconds', () => {
    expect(parseRetryAfterMs('5')).toBe(5_000);
  });
  it('parses fractional seconds', () => {
    expect(parseRetryAfterMs('1.5')).toBe(1_500);
  });
  it('returns null on null / empty / non-numeric', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
  });
  it('returns null on negative seconds', () => {
    expect(parseRetryAfterMs('-1')).toBeNull();
  });
  it('caps very large values at 30 s', () => {
    expect(parseRetryAfterMs('600')).toBe(30_000);
  });
});

describe('parseGoogleRetryDelayMs', () => {
  it('extracts retryDelay from a Google quota error', () => {
    const body = JSON.stringify({
      error: { details: [{ '@type': 'x', retryDelay: '7s' }] },
    });
    expect(parseGoogleRetryDelayMs(body)).toBe(7_000);
  });
  it('returns null on malformed JSON', () => {
    expect(parseGoogleRetryDelayMs('{not json')).toBeNull();
  });
  it('returns null when no retryDelay is present', () => {
    expect(parseGoogleRetryDelayMs(JSON.stringify({ error: { details: [] } }))).toBeNull();
  });
  it('caps the delay at 30 s', () => {
    const body = JSON.stringify({ error: { details: [{ retryDelay: '999s' }] } });
    expect(parseGoogleRetryDelayMs(body)).toBe(30_000);
  });
});

describe('callLens', () => {
  const baseOpts = {
    apiKey: 'k',
    wav: new Uint8Array([1, 2, 3]),
    prompt: 'p',
    schema: { type: 'object', properties: {} },
  } as const;

  it('throws when API key is missing', async () => {
    await expect(callLens({ ...baseOpts, apiKey: '' })).rejects.toThrow(/Missing Gemini API key/);
  });

  it('returns the text candidate on a 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(OK_RESPONSE)));
    const text = await callLens({ ...baseOpts });
    expect(text).toContain('TRUE');
  });

  it('throws when promptFeedback.blockReason is set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } })));
    await expect(callLens({ ...baseOpts })).rejects.toThrow(/blocked the prompt/);
  });

  it('throws when no text candidate is returned', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ candidates: [] })));
    await expect(callLens({ ...baseOpts })).rejects.toThrow(/no text candidate/);
  });

  it('retries up to MAX_RETRIES times on 503 then succeeds on the final attempt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse('busy', 503, { 'retry-after': '0' }))
      .mockResolvedValueOnce(textResponse('busy', 503, { 'retry-after': '0' }))
      .mockResolvedValueOnce(textResponse('busy', 503, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(OK_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);
    const onRetry = vi.fn();
    const text = await callLens({ ...baseOpts, onRetry });
    expect(text).toContain('TRUE');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2);
    expect(onRetry).toHaveBeenNthCalledWith(3, 3);
  });

  it('throws after exhausting retries on persistent 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('busy', 503, { 'retry-after': '0' })));
    await expect(callLens({ ...baseOpts })).rejects.toThrow(/Gemini HTTP 503/);
  });

  it('throws immediately on a non-retryable HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('bad request', 400)));
    await expect(callLens({ ...baseOpts })).rejects.toThrow(/Gemini HTTP 400/);
  });

  it('honours AbortSignal during the retry delay', async () => {
    const ac = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse('busy', 503, { 'retry-after': '5' })) // 5 s delay
      .mockResolvedValueOnce(jsonResponse(OK_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);
    const p = callLens({ ...baseOpts, signal: ac.signal });
    // Abort immediately while we're inside retryDelay.
    queueMicrotask(() => ac.abort());
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('injects noSpeech into the responseSchema', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(OK_RESPONSE));
    vi.stubGlobal('fetch', fetchMock);
    await callLens({ ...baseOpts });
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string) as {
      generationConfig: { responseSchema: { properties: Record<string, unknown> } };
    };
    expect(body.generationConfig.responseSchema.properties['noSpeech']).toBeDefined();
  });
});

describe('fetchAvailableModels', () => {
  it('returns gemini-* models that support generateContent, newest first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      models: [
        { name: 'models/gemini-1.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-bison', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
      ],
    })));
    const list = await fetchAvailableModels('key');
    expect(list).toEqual(['gemini-2.5-pro', 'gemini-1.5-flash']);
  });

  it('returns [] on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('forbidden', 403)));
    expect(await fetchAvailableModels('key')).toEqual([]);
  });

  it('returns [] when the models field is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
    expect(await fetchAvailableModels('key')).toEqual([]);
  });

  it('forwards the AbortSignal to fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ models: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const ac = new AbortController();
    await fetchAvailableModels('key', ac.signal);
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
    expect(calls[0]![1]?.signal).toBe(ac.signal);
  });
});
