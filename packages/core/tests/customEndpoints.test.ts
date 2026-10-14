import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeOpenAiBaseUrl, isOpenAiChatOnlyHost, DEFAULT_GEMINI_MODEL, DEFAULT_CLAUDE_MODEL, type Settings } from '../src/types';
import { configureSettings } from '../src/state/store';
import { callLensStream, runSelfTest } from '../src/llm/index';
import { fetchOpenAiModels } from '../src/llm/openai';
import { callGame } from '../src/llm/gameClient';

const endpoint = 'http://192.168.1.20:1234/v1';
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const schema = { type: 'object', properties: { answer: { type: 'string' } } };

function useCustomSettings() {
  configureSettings(() => ({
    geminiApiKey: '', geminiModel: DEFAULT_GEMINI_MODEL, geminiAutoModel: null,
    claudeApiKey: '', claudeModel: DEFAULT_CLAUDE_MODEL,
    responseLanguage: 'en', bufferDuration: 30, micSource: 'glasses',
    autoSummaryEnabled: false, crossSessionRecallEnabled: false, transcriptMode: 'off', discreet: false,
    voiceGateRmsFloor: 200, voiceTrimEnabled: true, autoDisabledLenses: [],
    autoModeEnabled: false, autoModeStartMs: 1000, autoModeSilenceMs: 1000, autoModeIntervalMs: 30000,
    translationSourceLanguages: 'auto', translationMode: 'converse', romanizeForeignScript: false,
    locationEnabled: false, cachedLocation: null,
    provider: 'openai-compatible', openaiBaseUrl: endpoint, openaiModel: 'local-model',
    openaiApiKeys: { [endpoint]: '', 'https://api.groq.com/openai/v1': 'gsk-test' },
    openaiTranscribeModels: {}, sttHost: 'https://api.groq.com/openai/v1', sttModel: 'whisper-large-v3',
  } satisfies Settings));
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('custom endpoints', () => {
  it('normalizes HTTP/S paths and rejects credentials, queries and unsafe schemes', () => {
    expect(normalizeOpenAiBaseUrl('  HTTPS://HOST.example/proxy/v1/// ')).toBe('https://host.example/proxy/v1');
    expect(normalizeOpenAiBaseUrl(endpoint)).toBe(endpoint);
    for (const raw of ['ftp://host/v1', 'https://user:secret@host/v1', 'https://host/v1?key=secret', 'https://host/v1#chat', 'https://host/v1?', 'https://host/v1#', '/v1', '']) {
      expect(() => normalizeOpenAiBaseUrl(raw)).toThrow();
    }
    expect(isOpenAiChatOnlyHost(endpoint)).toBe(true);
    expect(isOpenAiChatOnlyHost('https://api.openai.com/v1')).toBe(false);
  });

  it('lists arbitrary local model IDs without requiring authentication', async () => {
    const fetch = vi.fn(async () => json({ data: [{ id: 'whisper-chat-custom' }, { id: 'my-model.gguf' }] }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchOpenAiModels('', `${endpoint}/`)).toEqual(['my-model.gguf', 'whisper-chat-custom']);
    expect(fetch.mock.calls[0]).toEqual([`${endpoint}/models`, { headers: {}, signal: undefined }]);
  });

  it('routes self-test audio to the selected Whisper host and chat to the custom URL', async () => {
    useCustomSettings();
    const fetch = vi.fn(async (url: string) => url.endsWith('/audio/transcriptions')
      ? json({ text: 'test' })
      : json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    vi.stubGlobal('fetch', fetch);
    await runSelfTest('', 'local-model');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.groq.com/openai/v1/audio/transcriptions', `${endpoint}/chat/completions`,
    ]);
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![1].headers).toEqual({ authorization: 'Bearer gsk-test' });
    expect(calls[1]![1].headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(calls[1]![1].body as string).response_format).toEqual({ type: 'json_object' });
  });

  it('streams custom responses and forwards noSpeech through the shared router', async () => {
    useCustomSettings();
    const noSpeech = vi.fn();
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/audio/transcriptions')) return json({ text: 'test speech' });
      const chunk = { choices: [{ delta: { content: '{"noSpeech":true,"answer":"quiet"}' } }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetch);
    const text = await callLensStream({ wav: new Uint8Array(4), prompt: 'Return JSON', schema, onNoSpeech: noSpeech });
    expect(JSON.parse(text)).toEqual({ noSpeech: true, answer: 'quiet' });
    expect(noSpeech).toHaveBeenCalled();
    expect(fetch.mock.calls[1]![0]).toBe(`${endpoint}/chat/completions`);
  });

  it('generates games on custom hosts without a key or transcription call', async () => {
    useCustomSettings();
    const fetch = vi.fn(async () => json({ choices: [{ message: { content: '{"answer":"game"}' } }] }));
    vi.stubGlobal('fetch', fetch);
    expect(await callGame({ prompt: 'Return JSON', schema })).toContain('game');
    expect(fetch).toHaveBeenCalledTimes(1);
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe(`${endpoint}/chat/completions`);
    expect(calls[0]![1].headers).toEqual({ 'content-type': 'application/json' });
  });

  it.each([503, 429])('retries custom chat HTTP %s without repeating transcription', async (status) => {
    useCustomSettings();
    vi.useFakeTimers();
    let chatCalls = 0;
    const retry = vi.fn();
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/audio/transcriptions')) return json({ text: 'test' });
      if (++chatCalls === 1) return new Response('busy', { status, headers: { 'retry-after': '1' } });
      return new Response('data: {"choices":[{"delta":{"content":"{\\"answer\\":\\"ok\\"}"}}]}\n\ndata: [DONE]\n\n');
    });
    vi.stubGlobal('fetch', fetch);
    const result = callLensStream({ wav: new Uint8Array(4), prompt: 'Return JSON', schema, onRetry: retry });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await result).toBe('{"answer":"ok"}');
    expect(retry).toHaveBeenCalledWith(1);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/audio/transcriptions'))).toHaveLength(1);
    expect(chatCalls).toBe(2);
  });

  it('aborts a custom stream after a partial field without retrying chat', async () => {
    useCustomSettings();
    const controller = new AbortController();
    const partial = vi.fn(() => controller.abort());
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/audio/transcriptions')) return json({ text: 'test' });
      const content = '{"answer":"partial",';
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        },
      }));
    });
    vi.stubGlobal('fetch', fetch);
    await expect(callLensStream({ wav: new Uint8Array(4), prompt: 'Return JSON', schema,
      signal: controller.signal, onPartialField: partial })).rejects.toMatchObject({ name: 'AbortError' });
    expect(partial).toHaveBeenCalledWith('answer', 'partial');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
