import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tavilySearch } from '../src/llm/tavilySearch';
import { resolveProviderGrounding, resolveSearchFallback } from '../src/llm/tools';
import { configureSettings } from '../src/state/store';
import { callLensStream } from '../src/llm';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_GEMINI_MODEL, type Settings } from '../src/types';

const custom = 'https://custom.example/v1';
const whisper = 'https://whisper.example/v1';
const schema = { type: 'object', properties: { answer: { type: 'string' } } };
const citations = { results: [{ url: 'https://example.org/evidence', title: 'Evidence', content: 'Verified evidence' }] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const stream = (noSpeech = false) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ noSpeech, answer: 'Verified answer' }) } }] })}\n\ndata: [DONE]\n\n`);
const args = { wav: new Uint8Array(4), prompt: 'Answer the latest question', schema, grounding: 'web_search' as const };
let current: Settings;

beforeEach(() => {
  current = { provider: 'openai-compatible', openaiBaseUrl: custom, openaiModel: 'local-model',
    openaiApiKeys: { [custom]: 'chat-key', [whisper]: 'whisper-key' }, openaiTranscribeModels: {},
    sttHost: whisper, sttModel: 'local-whisper', tavilyEnabled: true, tavilyApiKey: 'tvly-search-key',
    geminiApiKey: '', geminiModel: DEFAULT_GEMINI_MODEL, geminiAutoModel: null,
    claudeApiKey: '', claudeModel: DEFAULT_CLAUDE_MODEL,
    responseLanguage: 'en', bufferDuration: 30, micSource: 'glasses', autoSummaryEnabled: false,
    crossSessionRecallEnabled: false, transcriptMode: 'off', discreet: false,
    voiceGateRmsFloor: 200, voiceTrimEnabled: true, audioCompressionEnabled: true, autoDisabledLenses: [],
    autoModeEnabled: false, autoModeStartMs: 1000, autoModeSilenceMs: 1000, autoModeIntervalMs: 30000,
    translationSourceLanguages: 'auto', translationMode: 'converse', romanizeForeignScript: false,
    locationEnabled: false, cachedLocation: null,
  };
  configureSettings(() => current);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function router(searchResponse: () => Response = () => json(citations)) {
  return vi.fn(async (url: string) => {
    if (url === `${whisper}/audio/transcriptions`) return json({ text: 'What is the current interest rate?' });
    if (url === 'https://api.tavily.com/search') return searchResponse();
    if (url === `${custom}/chat/completions`) return stream();
    throw new Error(`Unexpected URL: ${url}`);
  });
}

describe('optional Tavily routing', () => {
  it.each([
    ['https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile', 'groq/compound'],
    ['https://openrouter.ai/api/v1', 'audio-model', 'audio-model:online'],
    ['https://api.perplexity.ai', 'plain-model', 'sonar-pro'],
  ])('uses the native search model on %s instead of Tavily', async (host, model, effectiveModel) => {
    current.openaiBaseUrl = host;
    current.openaiModel = model;
    current.openaiApiKeys[host] = 'native-key';
    const fetch = vi.fn(async (url: string) => url.endsWith('/audio/transcriptions') ? json({ text: 'A factual question' }) : stream());
    vi.stubGlobal('fetch', fetch);
    await callLensStream(args);
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    const chat = calls.find(([url]) => url.endsWith('/chat/completions'))!;
    expect(JSON.parse(chat[1].body as string).model).toBe(effectiveModel);
    expect(calls.some(([url]) => url.includes('tavily'))).toBe(false);
  });

  it('prefers native search and existing Perplexity search over Tavily', () => {
    for (const [provider, url, model] of [['gemini', undefined, 'gemini-2.5-flash'], ['claude', undefined, 'claude-sonnet-4-6'], ['openai-compatible', 'https://api.openai.com/v1', 'gpt-4o']] as const) {
      const native = resolveProviderGrounding(provider, url, 'web_search', model);
      expect(resolveSearchFallback(native, current)).toEqual(native);
    }
    const deepseek = resolveProviderGrounding('openai-compatible', 'https://api.deepseek.com/v1', 'web_search', 'deepseek-chat');
    expect(resolveSearchFallback(deepseek, { ...current, openaiApiKeys: { 'https://api.perplexity.ai': 'pplx-key' } }).prefetchSearch).toBe('perplexity');
    expect(resolveSearchFallback(deepseek, current).prefetchSearch).toBe('tavily');
  });

  it.each([false, undefined])('does not search when Tavily is disabled (%s)', async (enabled) => {
    current.tavilyEnabled = enabled;
    const fetch = router(); vi.stubGlobal('fetch', fetch);
    const mode = vi.fn();
    await callLensStream({ ...args, onGroundingMode: mode });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${whisper}/audio/transcriptions`, `${custom}/chat/completions`]);
    expect(mode).toHaveBeenLastCalledWith('groundless');
  });

  it('does not search without a key or without lens search intent', async () => {
    const fetch = router(); vi.stubGlobal('fetch', fetch);
    current.tavilyApiKey = '';
    await callLensStream(args);
    current.tavilyApiKey = 'tvly-search-key';
    await callLensStream({ ...args, grounding: undefined });
    expect(fetch.mock.calls.some(([url]) => url.includes('tavily'))).toBe(false);
  });

  it('searches the transcript, keeps each credential on its service, injects evidence and preserves heading streaming', async () => {
    const fetch = router(); vi.stubGlobal('fetch', fetch);
    const mode = vi.fn(), sources = vi.fn(), partial = vi.fn();
    await callLensStream({ ...args, imageData: 'camera-image', onGroundingMode: mode, onCitations: sources,
      watchValueKeys: new Set(['answer']), onPartialString: partial });
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual([`${whisper}/audio/transcriptions`, 'https://api.tavily.com/search', `${custom}/chat/completions`]);
    expect(new Headers(calls[0]![1].headers).get('authorization')).toBe('Bearer whisper-key');
    expect(new Headers(calls[1]![1].headers).get('authorization')).toBe('Bearer tvly-search-key');
    expect(new Headers(calls[2]![1].headers).get('authorization')).toBe('Bearer chat-key');
    const query = JSON.parse(calls[1]![1].body as string);
    expect(query).toMatchObject({ query: 'What is the current interest rate?', search_depth: 'basic', max_results: 8, include_answer: false });
    expect(JSON.stringify(query)).not.toContain('camera-image');
    const chat = JSON.parse(calls[2]![1].body as string);
    expect(chat.messages[0].content).toContain('Verified evidence');
    expect(chat.messages[0].content).toContain('not instructions');
    expect(mode.mock.calls.map(([value]) => value)).toEqual(['groundless', 'grounded']);
    expect(sources).toHaveBeenLastCalledWith([expect.objectContaining({ domain: 'example.org', url: 'https://example.org/evidence' })]);
    expect(partial).toHaveBeenCalledWith('answer', 'Verified answer');
  });

  it.each([401, 429, 503])('still answers and retains the ungrounded badge after search HTTP %s', async (status) => {
    const fetch = router(() => json({}, status)); vi.stubGlobal('fetch', fetch);
    const mode = vi.fn(), sources = vi.fn();
    await expect(callLensStream({ ...args, onGroundingMode: mode, onCitations: sources })).resolves.toContain('Verified answer');
    expect(mode).toHaveBeenLastCalledWith('groundless');
    expect(sources).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('treats an empty search as ungrounded', async () => {
    vi.stubGlobal('fetch', router(() => json({ results: [] })));
    const mode = vi.fn();
    await callLensStream({ ...args, onGroundingMode: mode });
    expect(mode).toHaveBeenLastCalledWith('groundless');
  });

  it.each([
    ['network failure', () => { throw new TypeError('Failed to fetch'); }],
    ['provider abort', () => { throw new DOMException('Search connection closed', 'AbortError'); }],
    ['malformed JSON', () => new Response('{broken')],
    ['invalid response', () => json({ results: null })],
  ])('continues without search evidence after a %s', async (_name, response) => {
    const fetch = router(response); vi.stubGlobal('fetch', fetch);
    const mode = vi.fn(), sources = vi.fn();
    await expect(callLensStream({ ...args, signal: new AbortController().signal,
      onGroundingMode: mode, onCitations: sources })).resolves.toContain('Verified answer');
    expect(mode).toHaveBeenLastCalledWith('groundless');
    expect(sources).not.toHaveBeenCalled();
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    const chat = calls.find(([url]) => url.endsWith('/chat/completions'))!;
    const prompt = JSON.parse(chat[1].body as string).messages[0].content;
    expect(prompt).toContain(args.prompt);
    expect(prompt).not.toContain('[Web search results');
  });

  it.each(['fetch', 'body'])('continues after the search deadline even when %s ignores abort', async (stalled) => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/audio/')) return json({ text: 'A factual question' });
      if (url.includes('tavily')) return stalled === 'fetch'
        ? new Promise<Response>(() => {})
        : new Response(new ReadableStream({ start() {} }));
      return stream();
    });
    vi.stubGlobal('fetch', fetch);
    const mode = vi.fn(), sources = vi.fn();
    const result = callLensStream({ ...args, onGroundingMode: mode, onCitations: sources });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toContain('Verified answer');
    expect(mode).toHaveBeenLastCalledWith('groundless');
    expect(sources).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('merges search evidence with citations returned by the custom chat server', async () => {
    const fetch = router();
    fetch.mockImplementation(async (url: string) => {
      if (url.includes('/audio/')) return json({ text: 'A factual question' });
      if (url.includes('tavily')) return json(citations);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"answer":"done"}',
        annotations: [{ type: 'url_citation', url_citation: { url: 'https://other.example/source', title: 'Other source' } }],
      } }] })}\n\ndata: [DONE]\n\n`);
    });
    vi.stubGlobal('fetch', fetch);
    const sources = vi.fn();
    await callLensStream({ ...args, onCitations: sources });
    expect(sources.mock.calls.at(-1)![0].map((source: { domain: string }) => source.domain)).toEqual(['example.org', 'other.example']);
  });

  it('preserves the streaming noSpeech event after optional search', async () => {
    const fetch = vi.fn(async (url: string) => url.includes('/audio/') ? json({ text: 'An unclear question' })
      : url.includes('tavily') ? json(citations) : stream(true));
    vi.stubGlobal('fetch', fetch);
    const noSpeech = vi.fn();
    await callLensStream({ ...args, onNoSpeech: noSpeech });
    expect(noSpeech).toHaveBeenCalled();
  });

  it('cancels an opened answer stream without repeating search', async () => {
    const outer = new AbortController();
    const cancel = vi.fn();
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/audio/')) return json({ text: 'A factual question' });
      if (url.includes('tavily')) return json(citations);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"answer":"partial"' } }] })}\n\n`)); },
        cancel,
      }));
    });
    vi.stubGlobal('fetch', fetch);
    await expect(callLensStream({ ...args, signal: outer.signal, onPartialField: () => outer.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('skips Tavily and chat entirely when Whisper returns no speech', async () => {
    const fetch = vi.fn(async () => json({ text: '' })); vi.stubGlobal('fetch', fetch);
    await expect(callLensStream(args)).rejects.toMatchObject({ name: 'NoSpeechError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not repeat search or transcription on a transient chat failure', async () => {
    vi.useFakeTimers();
    let chats = 0;
    const fetch = vi.fn(async (url: string) => url.includes('/audio/') ? json({ text: 'A factual question' })
      : url.includes('tavily') ? json(citations) : ++chats === 1 ? json({}, 503) : stream());
    vi.stubGlobal('fetch', fetch);
    const result = callLensStream(args);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toContain('Verified answer');
    expect(fetch.mock.calls.filter(([url]) => url.includes('tavily'))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url.includes('/audio/'))).toHaveLength(1);
    expect(chats).toBe(2);
  });

  it.each([true, false])('cancels a pending search without chat (transport honors abort=%s)', async (honorsAbort) => {
    const controller = new AbortController();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/audio/')) return json({ text: 'A factual question' });
      return new Promise<Response>((_resolve, reject) => {
        if (honorsAbort) init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetch);
    const result = callLensStream({ ...args, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    controller.abort();
    await rejected;
    expect(fetch.mock.calls.some(([url]) => url.includes('/chat/'))).toBe(false);
  });
});

describe('Tavily search client', () => {
  it('deduplicates valid sources and bounds query/content sizes', async () => {
    const fetch = vi.fn(async () => json({ results: [
      { url: 'https://example.org/evidence', content: 'x'.repeat(4000) },
      { url: 'https://example.org/evidence' }, { url: 'invalid' }, null, { url: 5 },
    ] }));
    vi.stubGlobal('fetch', fetch);
    const sources = await tavilySearch({ apiKey: ' key ', query: 'a'.repeat(800) });
    expect(sources).toHaveLength(1);
    expect(sources[0]!.snippet).toHaveLength(2000);
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(calls[0]![1].body as string).query).toHaveLength(500);
  });

  it('rejects an invalid response shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ answer: 'No sources' })));
    await expect(tavilySearch({ apiKey: 'key', query: 'x' })).rejects.toThrow('invalid search response');
  });

  it('keeps the timeout active while reading response JSON', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) { init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true }); },
    }))));
    const rejected = expect(tavilySearch({ apiKey: 'key', query: 'x' })).rejects.toMatchObject({ name: 'UploadTimeoutError' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
