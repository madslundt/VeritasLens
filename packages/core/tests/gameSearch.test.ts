import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSettings } from '../src/state/store';
import { callGame } from '../src/llm/gameClient';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_GEMINI_MODEL, type Settings } from '../src/types';

const custom = 'https://custom.example/v1';
const prompt = 'Generate ten factual questions. Private history: do not repeat secret-example.';
const schema = { type: 'object', properties: { questions: { type: 'array' } } };
const answer = '{"chosenTopic":"Volcanoes","questions":[]}';
const sources = { results: [{ url: 'https://example.org/volcanoes', title: 'Volcanoes', content: 'A shield volcano has gentle slopes.' }] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const args = { prompt, schema, search: { format: 'quiz-mc' as const, topic: 'Volcanoes' } };
let current: Settings;

beforeEach(() => {
  current = { provider: 'openai-compatible', openaiBaseUrl: custom, openaiModel: 'local-model',
    openaiApiKeys: { [custom]: 'chat-key' }, openaiTranscribeModels: {},
    sttHost: 'https://api.groq.com/openai/v1', sttModel: 'whisper-large-v3',
    tavilyEnabled: true, tavilyApiKey: 'tvly-search-key',
    geminiApiKey: 'gemini-key', geminiModel: DEFAULT_GEMINI_MODEL, geminiAutoModel: null,
    claudeApiKey: 'claude-key', claudeModel: DEFAULT_CLAUDE_MODEL,
    responseLanguage: 'en', bufferDuration: 30, micSource: 'glasses', autoSummaryEnabled: false,
    crossSessionRecallEnabled: false, transcriptMode: 'off', discreet: false,
    voiceGateRmsFloor: 200, voiceTrimEnabled: true, audioCompressionEnabled: true, autoDisabledLenses: [],
    autoModeEnabled: false, autoModeStartMs: 1000, autoModeSilenceMs: 1000, autoModeIntervalMs: 30000,
    translationSourceLanguages: 'auto', translationMode: 'converse', romanizeForeignScript: false,
    locationEnabled: false, cachedLocation: null,
  };
  configureSettings(() => current);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function router(searchResponse: () => Response = () => json(sources)) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === 'https://api.tavily.com/search') return searchResponse();
    if (url.includes('generativelanguage')) return json({ candidates: [{ content: { parts: [{ text: answer }] } }] });
    if (url.includes('anthropic')) return json({ content: [{ type: 'tool_use', name: 'emit_game_questions', input: JSON.parse(answer) }] });
    if (url.endsWith('/chat/completions')) return json({ choices: [{ message: { content: answer } }] });
    throw new Error(`Unexpected request: ${url}`);
  });
}
function generationPrompt(init: RequestInit): string {
  const body = JSON.parse(init.body as string);
  return body.system ?? body.contents?.[0].parts[0].text ?? body.messages[0].content;
}

describe('optional factual game search', () => {
  it.each(['gemini', 'claude', 'openai-compatible'] as const)('searches once before %s generation, with isolated credentials', async (provider) => {
    current.provider = provider;
    const fetch = router(); vi.stubGlobal('fetch', fetch);
    const citations = vi.fn();
    expect(JSON.parse(await callGame({ ...args, onCitations: citations }))).toEqual(JSON.parse(answer));
    expect(fetch).toHaveBeenCalledTimes(2);
    const searchInit = fetch.mock.calls[0]![1]!;
    expect(new Headers(searchInit.headers).get('authorization')).toBe('Bearer tvly-search-key');
    const query = JSON.parse(searchInit.body as string).query;
    expect(query).toBe('Facts and history about Volcanoes');
    expect(query).not.toContain('secret-example');
    const chatInit = fetch.mock.calls[1]![1]!;
    expect(generationPrompt(chatInit)).toContain('A shield volcano has gentle slopes.');
    expect(generationPrompt(chatInit)).toContain('not instructions');
    expect(JSON.stringify(chatInit)).not.toContain('tvly-search-key');
    expect(citations).toHaveBeenCalledWith([expect.objectContaining({ domain: 'example.org' })]);
  });

  it.each(['disabled', 'missing key', 'riddle', 'no search intent'])('generates normally with %s', async (condition) => {
    const fetch = router(); vi.stubGlobal('fetch', fetch);
    const citations = vi.fn();
    if (condition === 'disabled') current.tavilyEnabled = false;
    if (condition === 'missing key') current.tavilyApiKey = '';
    const search = condition === 'riddle' ? { ...args.search, format: 'riddle' as const }
      : condition === 'no search intent' ? undefined : args.search;
    await callGame({ ...args, search, onCitations: citations });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(generationPrompt(fetch.mock.calls[0]![1]!)).not.toContain('[Web search results');
    expect(citations).not.toHaveBeenCalled();
  });

  it.each([
    ['bad key', () => json({}, 401)], ['quota', () => json({}, 429)], ['outage', () => json({}, 503)],
    ['network error', () => { throw new TypeError('Offline'); }],
    ['internal abort', () => { throw new DOMException('Search failed', 'AbortError'); }],
    ['invalid JSON', () => new Response('{broken')], ['invalid shape', () => json({ results: null })],
    ['empty results', () => json({ results: [] })],
  ])('keeps the original generation prompt after %s', async (_name, response) => {
    const fetch = router(response); vi.stubGlobal('fetch', fetch);
    const citations = vi.fn();
    await expect(callGame({ ...args, onCitations: citations })).resolves.toBe(answer);
    expect(generationPrompt(fetch.mock.calls[1]![1]!)).not.toContain('[Web search results');
    expect(citations).not.toHaveBeenCalled();
  });

  it('continues generation after a stalled search reaches its deadline', async () => {
    vi.useFakeTimers();
    const fetch = router();
    fetch.mockImplementationOnce(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetch);
    const result = callGame(args);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toBe(answer);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels during search without generating even if transport ignores abort', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal('fetch', fetch);
    const result = callGame({ ...args, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not search again when question generation is retried', async () => {
    vi.useFakeTimers();
    const fetch = router();
    fetch.mockResolvedValueOnce(json(sources)).mockResolvedValueOnce(json({}, 503));
    vi.stubGlobal('fetch', fetch);
    const retry = vi.fn();
    const result = callGame({ ...args, onRetry: retry });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toBe(answer);
    expect(fetch.mock.calls.filter(([url]) => url.includes('tavily'))).toHaveLength(1);
    expect(retry).toHaveBeenCalledWith(1);
  });

  it('does not spend a search request with missing generation credentials', async () => {
    current.provider = 'gemini'; current.geminiApiKey = '';
    const fetch = router(); vi.stubGlobal('fetch', fetch);
    await expect(callGame(args)).rejects.toThrow('Missing Gemini API key');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('searches local games using only their location topic', async () => {
    const fetch = router(); vi.stubGlobal('fetch', fetch);
    await callGame({ ...args, search: { format: 'true-false', topic: 'Local trivia about Copenhagen, Denmark' } });
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).query).toContain('Copenhagen, Denmark');
  });

  it('anchors Random games to a preferred topic while avoiding recent picks', async () => {
    const fetch = router(); vi.stubGlobal('fetch', fetch);
    await callGame({ ...args, search: { format: 'quiz-mc', topic: '', preferredTopics: ['Volcanoes', 'Marine biology'], recentTopics: [' volcanoes '] } });
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).query).toBe('Facts and history about Marine biology');
    expect(generationPrompt(fetch.mock.calls[1]![1]!)).toContain('return it as chosenTopic');
    expect(generationPrompt(fetch.mock.calls[1]![1]!)).toContain('"Marine biology"');
  });

  it('picks a concrete Random topic when no conversation topic is available', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetch = router(); vi.stubGlobal('fetch', fetch);
    await callGame({ ...args, search: { format: 'true-false', topic: '', recentTopics: ['Renaissance painting'] } });
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).query).toBe('Facts and history about Antarctic wildlife');
  });
});
