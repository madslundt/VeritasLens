// tests/openai.test.ts
//
// Provider tests for src/llm/openai.ts. Network is mocked via
// vi.stubGlobal('fetch', ...). Covers:
//   - Transcribe-then-chat hosts (OpenAI/Groq): two HTTP calls,
//     `/audio/transcriptions` before `/chat/completions`.
//   - Inline-audio hosts (OpenRouter): one HTTP call, audio attached as an
//     `input_audio` content part.
//   - Model list filtering: OpenRouter requires `architecture.input_modalities`
//     to include `audio`; OpenAI/Groq accept any chat-shaped model id.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callOpenAiLens, fetchOpenAiModels } from '../src/llm/openai';

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: init?.headers ?? { 'content-type': 'application/json' },
  });
}

const CHAT_OK = {
  choices: [{ message: { content: '{"noSpeech": false, "verdict": "TRUE"}' } }],
};

const baseOpts = {
  apiKey: 'sk-test',
  model: 'gpt-4o-audio',
  wav: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
  prompt: 'p',
  schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] },
} as const;

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('callOpenAiLens — OpenRouter inline-audio path', () => {
  it('sends a single chat-completions request with an input_audio content part and no transcription call', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
      return jsonResponse(CHAT_OK);
    });
    vi.stubGlobal('fetch', fetchMock);

    const text = await callOpenAiLens({
      ...baseOpts,
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    expect(text).toContain('TRUE');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    const userMessage = body.messages.find((m: { role: string }) => m.role === 'user');
    expect(Array.isArray(userMessage.content)).toBe(true);
    const audioPart = userMessage.content.find((p: { type: string }) => p.type === 'input_audio');
    expect(audioPart).toBeDefined();
    expect(audioPart.input_audio.format).toBe('wav');
    expect(typeof audioPart.input_audio.data).toBe('string');
    expect(audioPart.input_audio.data.length).toBeGreaterThan(0);
  });
});

describe('callOpenAiLens — transcribe-then-chat path', () => {
  it('calls /audio/transcriptions before /chat/completions on OpenAI', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/audio/transcriptions')) {
        return jsonResponse({ text: 'hello world' });
      }
      return jsonResponse(CHAT_OK);
    });
    vi.stubGlobal('fetch', fetchMock);

    await callOpenAiLens({
      ...baseOpts,
      baseUrl: 'https://api.openai.com/v1',
      transcribeModel: 'whisper-1',
    });

    expect(calls).toEqual([
      'https://api.openai.com/v1/audio/transcriptions',
      'https://api.openai.com/v1/chat/completions',
    ]);

    const chatInit = fetchMock.mock.calls[1][1] as RequestInit;
    const chatBody = JSON.parse(chatInit.body as string);
    const userMessage = chatBody.messages.find((m: { role: string }) => m.role === 'user');
    // Transcribe path sends the transcript as a string, not a multimodal array.
    expect(typeof userMessage.content).toBe('string');
    expect(userMessage.content).toContain('hello world');
  });

  it('throws a clear error if a transcribe-then-chat host is invoked without a transcribeModel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(CHAT_OK)));
    await expect(callOpenAiLens({
      ...baseOpts,
      baseUrl: 'https://api.openai.com/v1',
      // transcribeModel intentionally omitted
    })).rejects.toThrow(/Missing transcribeModel for OpenAI/);
  });
});

describe('fetchOpenAiModels', () => {
  it('filters OpenRouter models to those with audio in architecture.input_modalities', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'openai/gpt-4o-audio-preview', architecture: { input_modalities: ['text', 'audio'] } },
          { id: 'google/gemini-2.5-flash', architecture: { input_modalities: ['text', 'image', 'audio'] } },
          { id: 'anthropic/claude-3.5-sonnet', architecture: { input_modalities: ['text', 'image'] } },
          { id: 'meta-llama/llama-3.3-70b', architecture: { input_modalities: ['text'] } },
        ],
      }),
    ));
    const models = await fetchOpenAiModels('sk-or-test', 'https://openrouter.ai/api/v1');
    expect(models).toEqual([
      'google/gemini-2.5-flash',
      'openai/gpt-4o-audio-preview',
    ]);
  });

  it('does not require audio modality on non-inline-audio hosts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'gpt-4o-mini' },
          { id: 'gpt-4o' },
          { id: 'whisper-1' },        // filtered by isSupportedChatModel
          { id: 'text-embedding-3-small' }, // filtered by isSupportedChatModel
        ],
      }),
    ));
    const models = await fetchOpenAiModels('sk-test', 'https://api.openai.com/v1');
    expect(models).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });
});
