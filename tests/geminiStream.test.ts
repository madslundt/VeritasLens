// tests/geminiStream.test.ts
//
// Behaviour-lock tests for callLensStream. Network is mocked via
// vi.stubGlobal('fetch', ...). The streaming layer is purely a
// perceived-latency optimization, so the tests focus on: partial-event timing,
// noSpeech fast-path, tools-array threading, and graceful end-of-stream
// behaviour.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callLensStream, GOOGLE_SEARCH_TOOLS } from '../src/llm/gemini';

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Build an SSE Response whose body emits the given pre-encoded chunks. */
function sseResponse(chunks: string[], init?: { status?: number }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: init?.status ?? 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Wrap a JSON text payload as a Gemini SSE `data:` event. */
function sseEvent(jsonText: string): string {
  const event = { candidates: [{ content: { parts: [{ text: jsonText }] } }] };
  return `data: ${JSON.stringify(event)}\n\n`;
}

const BASE_OPTS = {
  apiKey: 'k',
  wav: new Uint8Array([0]),
  prompt: 'p',
  schema: { type: 'object', properties: { claims: { type: 'array' } } },
};

describe('callLensStream', () => {
  it('emits onPartialClaim for each complete claim in the stream', async () => {
    const fullText = '{"claims":[{"quote":"a","verdict":"TRUE","claim":"A","reason":"r1"},{"quote":"b","verdict":"FALSE","claim":"B","reason":"r2"}]}';
    // Slice the JSON into halves and put each half in a separate SSE event so
    // the test exercises the multi-chunk path.
    const chunks = [sseEvent(fullText.slice(0, 40)), sseEvent(fullText.slice(40))];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(chunks)));

    const claims: Record<string, unknown>[] = [];
    const text = await callLensStream({
      ...BASE_OPTS,
      onPartialClaim: (c) => claims.push(c),
    });

    expect(claims).toHaveLength(2);
    expect(claims[0]?.['quote']).toBe('a');
    expect(claims[1]?.['quote']).toBe('b');
    expect(text).toBe(fullText);
  });

  it('fires onNoSpeech the moment the flag is visible mid-stream', async () => {
    const fullText = '{"noSpeech":true,"claims":[]}';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([sseEvent(fullText)])));

    const onNoSpeech = vi.fn();
    await callLensStream({ ...BASE_OPTS, onNoSpeech });

    expect(onNoSpeech).toHaveBeenCalled();
  });

  it('threads the tools array into the request body', async () => {
    const fullText = '{"claims":[]}';
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([sseEvent(fullText)]));
    vi.stubGlobal('fetch', fetchMock);

    await callLensStream({ ...BASE_OPTS, tools: [...GOOGLE_SEARCH_TOOLS] });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['tools']).toEqual([{ google_search: {} }]);
  });

  it('omits the tools key when none are supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([sseEvent('{"claims":[]}')]));
    vi.stubGlobal('fetch', fetchMock);

    await callLensStream(BASE_OPTS);

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['tools']).toBeUndefined();
  });

  it('uses the streamGenerateContent endpoint with alt=sse', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([sseEvent('{"claims":[]}')]));
    vi.stubGlobal('fetch', fetchMock);

    await callLensStream(BASE_OPTS);

    const [url] = fetchMock.mock.calls[0]!;
    expect(url as string).toContain('streamGenerateContent');
    expect(url as string).toContain('alt=sse');
  });

  it('retries transient 503 before any byte arrives, fires onRetry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('upstream gone', { status: 503 }))
      .mockResolvedValueOnce(sseResponse([sseEvent('{"claims":[{"q":1}]}')]));
    vi.stubGlobal('fetch', fetchMock);
    const onRetry = vi.fn();

    const claims: Record<string, unknown>[] = [];
    await callLensStream({
      ...BASE_OPTS,
      onRetry,
      onPartialClaim: (c) => claims.push(c),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1);
    expect(claims).toHaveLength(1);
  });

  it('throws on non-transient HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad key', { status: 401 })));
    await expect(callLensStream(BASE_OPTS)).rejects.toThrow(/401/);
  });

  it('throws when the model blocks the prompt', async () => {
    const event = `data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })}\n\n`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([event])));
    await expect(callLensStream(BASE_OPTS)).rejects.toThrow(/blocked/i);
  });

  it('handles SSE chunk boundaries that split a single event', async () => {
    // The JSON `{"claims":[{"a":1}]}` lives inside one SSE event but the chunk
    // boundary lands inside the `data:` line. The reader has to wait for the
    // blank-line terminator before forwarding the chunk to the JSON parser.
    const payload = JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"claims":[{"a":1}]}' }] } }] });
    const full = `data: ${payload}\n\n`;
    const chunks = [full.slice(0, 30), full.slice(30)];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(chunks)));

    const claims: Record<string, unknown>[] = [];
    const text = await callLensStream({
      ...BASE_OPTS,
      onPartialClaim: (c) => claims.push(c),
    });

    expect(claims).toHaveLength(1);
    expect(text).toBe('{"claims":[{"a":1}]}');
  });

  it('skips empty / comment-only SSE blocks (keepalive pings)', async () => {
    const keepalive = ': ping\n\n';
    const event = sseEvent('{"claims":[{"q":"a"}]}');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([keepalive, event])));

    const claims: Record<string, unknown>[] = [];
    const text = await callLensStream({
      ...BASE_OPTS,
      onPartialClaim: (c) => claims.push(c),
    });

    expect(claims).toHaveLength(1);
    expect(text).toBe('{"claims":[{"q":"a"}]}');
  });
});
