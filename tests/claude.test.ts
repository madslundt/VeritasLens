// tests/claude.test.ts
//
// Behaviour tests for src/llm/claude.ts. The Claude path is text-only —
// upstream callers transcribe the WAV first and hand the transcript to
// `callLens`. Structured output is via Anthropic's tool-use shaping, so
// these tests verify (a) the tool is registered with the lens schema as
// `input_schema`, (b) the returned tool_use input is forwarded verbatim,
// (c) auth headers are the Anthropic shape (x-api-key + anthropic-version),
// and (d) transient HTTP statuses (429/529) retry while terminal errors
// don't.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callLens, fetchAvailableModels, CLAUDE_ENDPOINT, CLAUDE_API_VERSION } from '../src/llm/claude';

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: init?.headers ?? { 'content-type': 'application/json' },
  });
}

const TOOL_USE_OK = {
  content: [{
    type: 'tool_use',
    name: 'emit_lens_result',
    input: { noSpeech: false, verdict: 'TRUE', claim: 'x', reason: 'y' },
  }],
  stop_reason: 'tool_use',
};

const baseOpts = {
  apiKey: 'sk-ant-test',
  transcript: 'hello world',
  prompt: 'system prompt here',
  schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] },
} as const;

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('callLens (Claude)', () => {
  it('POSTs to /v1/messages with x-api-key + anthropic-version and the lens schema as the tool input_schema', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      expect(url).toBe(CLAUDE_ENDPOINT);
      return jsonResponse(TOOL_USE_OK);
    });
    vi.stubGlobal('fetch', fetchMock);

    await callLens(baseOpts);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe(CLAUDE_API_VERSION);
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    // System prompt forwarded verbatim, transcript wrapped as a user message.
    expect(body.system).toBe('system prompt here');
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('hello world');
    // Tool config: single tool, choice forces it.
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe('emit_lens_result');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'emit_lens_result' });
    // `noSpeech` injected into the tool's input_schema even though the lens
    // didn't declare it — parity with Gemini/OpenAI augmentation.
    expect(body.tools[0].input_schema.properties.noSpeech).toBeDefined();
    expect(body.tools[0].input_schema.properties.verdict).toBeDefined();
  });

  it('returns the tool_use input as a JSON string for the lens parser', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(TOOL_USE_OK)));
    const text = await callLens(baseOpts);
    const parsed = JSON.parse(text);
    expect(parsed.verdict).toBe('TRUE');
    expect(parsed.noSpeech).toBe(false);
  });

  it('throws when the response carries text content but no tool_use (Claude refused the tool call)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      content: [{ type: 'text', text: "I can't do that." }],
      stop_reason: 'end_turn',
    })));
    await expect(callLens(baseOpts)).rejects.toThrow(/Anthropic skipped the tool call/);
  });

  it('treats an empty / whitespace transcript as a "no speech captured" sentinel rather than 400-ing on empty content', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      // The user-message body should contain the empty-transcript sentinel so
      // the model is told to flip noSpeech=true rather than seeing literal "".
      expect(body.messages[0].content).toContain('<empty');
      return jsonResponse(TOOL_USE_OK);
    });
    vi.stubGlobal('fetch', fetchMock);
    await callLens({ ...baseOpts, transcript: '   ' });
  });

  it('retries on 529 (Anthropic overloaded) and succeeds on the retry', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response('overloaded', { status: 529 });
      return jsonResponse(TOOL_USE_OK);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onRetry = vi.fn();
    const out = await callLens({ ...baseOpts, onRetry });
    expect(calls).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out).verdict).toBe('TRUE');
  });

  it('does NOT retry on 401 (terminal auth failure)', async () => {
    const fetchMock = vi.fn(async () => new Response('bad key', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(callLens(baseOpts)).rejects.toThrow(/Anthropic HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on missing API key without firing a fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(callLens({ ...baseOpts, apiKey: '' })).rejects.toThrow(/Missing Anthropic API key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchAvailableModels (Claude)', () => {
  it('returns the curated list when no key is provided (no network call)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ids = await fetchAvailableModels('');
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain('claude-sonnet-4-6');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the curated list as-is when /v1/models is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const ids = await fetchAvailableModels('sk-ant-test');
    expect(ids).toContain('claude-sonnet-4-6');
  });

  it('appends extras the API knows about that we have not curated yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: [
        { id: 'claude-sonnet-4-6' },
        { id: 'claude-future-9-0' },
      ],
    })));
    const ids = await fetchAvailableModels('sk-ant-test');
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).toContain('claude-future-9-0');
  });
});
