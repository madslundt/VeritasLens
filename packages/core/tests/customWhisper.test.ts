import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSettings } from '../src/state/store';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_GEMINI_MODEL, type Settings } from '../src/types';
import { callLens, callLensStream, fetchAvailableModels, prepareLensTranscript, runSelfTest } from '../src/llm/index';
import { callGame } from '../src/llm/gameClient';
import { transcribeAudio } from '../src/llm/openai';
import { callOpenAiResponsesLensStream } from '../src/llm/openaiResponses';
import { runWhisperSidecar } from '../src/runtime/transcriptSource';
import { _resetTranscriptForTesting, getRecent, resetTranscript } from '../src/runtime/transcript';

const chatLan = 'http://192.168.1.20:1234/v1';
const chatTail = 'http://100.64.0.20:1234/v1';
const sttLan = 'http://192.168.1.20:8000/v1';
const sttTail = 'http://100.64.0.20:8000/v1';
const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
const output = { noSpeech: false, answer: 'done', claims: [{ quote: 'heard speech' }] };
const schema = { type: 'object', properties: { answer: { type: 'string' }, claims: { type: 'array', items: { type: 'object' } } } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const chatResponse = () => json({ choices: [{ message: { content: JSON.stringify(output) } }] });
function streamResponse(): Response {
  const pieces = ['{"noSpeech":false,"answer":"do', 'ne","claims":[{"quote":"heard speech"}]}'];
  const events = pieces.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('');
  return new Response(`${events}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

function useSettings(overrides: Partial<Settings> = {}): void {
  configureSettings(() => ({
    provider: 'openai-compatible',
    openaiBaseUrl: chatLan, openaiModel: 'same-server-model',
    openaiApiKeys: { [chatLan]: 'chat-primary-key', [chatTail]: 'must-not-use-alternate-key',
      [sttLan]: '', [sttTail]: 'must-not-use-stt-alternate-key' },
    openaiTranscribeModels: {}, openaiFallbackUrls: { [chatLan]: [chatTail] },
    sttHost: sttLan, sttModel: 'local-whisper', sttFallbackUrls: { [sttLan]: [sttTail] },
    transcriptMode: 'on', claudeApiKey: 'claude-primary-key', claudeModel: DEFAULT_CLAUDE_MODEL,
    ...overrides,
  } as Settings));
}

beforeEach(() => { useSettings(); resetTranscript('test-session'); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); _resetTranscriptForTesting(); });

describe('custom Whisper and server address routing', () => {
  it.each(['claude', 'openai-compatible'] as const)('probes configured custom Whisper before the %s self-test', async (provider) => {
    useSettings({ provider, openaiBaseUrl: 'https://openrouter.ai/api/v1' });
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(sttLan)) throw new TypeError('LAN unreachable');
      if (url.startsWith(sttTail)) return json({ text: '' });
      if (provider === 'claude') return json({ content: [{ type: 'tool_use', name: 'emit_lens_result', input: { ok: true } }] });
      return json({ choices: [{ message: { content: '{"ok":true}' } }] });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(runSelfTest('provider-key', undefined, {
      provider, sttHost: sttLan, sttModel: 'local-whisper', sttApiKey: '', sttFallbackUrls: [sttTail],
    })).resolves.toMatchObject({ latencyMs: expect.any(Number) });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/audio/transcriptions')).map(([url]) => url)).toEqual([
      `${sttLan}/audio/transcriptions`, `${sttTail}/audio/transcriptions`,
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(['nonstream', 'stream'])('uses keyless custom STT and both fallback paths for %s lens calls', async (mode) => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url === `${sttLan}/audio/transcriptions`) throw new TypeError('LAN unreachable');
      if (url === `${sttTail}/audio/transcriptions`) return json({ text: 'heard speech' });
      if (url === `${chatLan}/chat/completions`) return json({ error: 'busy' }, 503);
      if (url === `${chatTail}/chat/completions`) return mode === 'stream' ? streamResponse() : chatResponse();
      throw new Error(`Unexpected request: ${url}, ${init.method}`);
    });
    vi.stubGlobal('fetch', fetch);
    const claim = vi.fn();
    const field = vi.fn();
    const partial = vi.fn();
    const args = { wav, prompt: 'Return JSON', schema, onPartialClaim: claim, onPartialField: field,
      watchValueKeys: new Set(['answer']), onPartialString: partial };
    const result = await (mode === 'stream' ? callLensStream(args) : callLens(args));
    expect(JSON.parse(result)).toEqual(output);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${sttLan}/audio/transcriptions`, `${sttTail}/audio/transcriptions`,
      `${chatLan}/chat/completions`, `${chatTail}/chat/completions`,
    ]);
    const calls = fetch.mock.calls;
    expect(new Headers(calls[0]![1].headers).has('authorization')).toBe(false);
    expect(new Headers(calls[1]![1].headers).has('authorization')).toBe(false);
    expect((calls[1]![1].body as FormData).get('model')).toBe('local-whisper');
    for (const [, init] of calls.slice(2)) {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer chat-primary-key');
      expect(JSON.parse(init.body as string).model).toBe('same-server-model');
    }
    if (mode === 'stream') {
      expect(claim).toHaveBeenCalledWith({ quote: 'heard speech' }, 'claims');
      expect(field).toHaveBeenCalledWith('answer', 'done');
      expect(partial).toHaveBeenCalledWith('answer', 'done');
    }
  });

  it.each(['models', 'game'])('uses the same-server fallback for %s without invoking STT', async (route) => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(chatLan)) throw new TypeError('LAN unreachable');
      return route === 'models' ? json({ data: [{ id: 'same-server-model' }] }) : chatResponse();
    });
    vi.stubGlobal('fetch', fetch);
    if (route === 'models') await expect(fetchAvailableModels('chat-primary-key')).resolves.toEqual(['same-server-model']);
    else await expect(callGame({ prompt: 'Return JSON', schema })).resolves.toBe(JSON.stringify(output));
    const suffix = route === 'models' ? '/models' : '/chat/completions';
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${chatLan}${suffix}`, `${chatTail}${suffix}`]);
  });

  it('shares one custom Whisper upload across Auto classifier and both competing lens calls', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(sttLan)) throw new TypeError('LAN unreachable');
      if (url.startsWith(sttTail)) return json({ text: 'heard speech' });
      return chatResponse();
    });
    vi.stubGlobal('fetch', fetch);
    const outer = new AbortController();
    const transcript = prepareLensTranscript(wav, outer.signal);
    expect(transcript).toBeDefined();
    const args = { wav, prompt: 'Return JSON', schema, transcript, signal: outer.signal };
    await Promise.all([callLens(args), callLens(args), callLens(args)]);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/audio/transcriptions')).map(([url]) => url)).toEqual([
      `${sttLan}/audio/transcriptions`, `${sttTail}/audio/transcriptions`,
    ]);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/chat/completions'))).toHaveLength(3);
  });

  it('uses the custom Whisper fallback for Claude while keeping the Claude key on Anthropic only', async () => {
    useSettings({ provider: 'claude' });
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(sttLan)) throw new TypeError('LAN unreachable');
      if (url.startsWith(sttTail)) return json({ text: 'heard speech' });
      return json({ content: [{ type: 'tool_use', name: 'emit_lens_result', input: output }] });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(callLens({ wav, prompt: 'Return JSON', schema })).resolves.toBe(JSON.stringify(output));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${sttLan}/audio/transcriptions`, `${sttTail}/audio/transcriptions`, 'https://api.anthropic.com/v1/messages',
    ]);
  });

  it('adds a Gemini transcript from keyless custom Whisper through its fallback address', async () => {
    useSettings({ provider: 'gemini' });
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(sttLan)) throw new TypeError('LAN unreachable');
      return json({ text: 'sidecar speech' });
    });
    vi.stubGlobal('fetch', fetch);
    await runWhisperSidecar(wav, 'other');
    expect(getRecent(1)[0]).toMatchObject({ text: 'sidecar speech', speaker: 'other' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${sttLan}/audio/transcriptions`, `${sttTail}/audio/transcriptions`]);
  });

  it('tests a custom Whisper configuration even when silence produces an empty transcript', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/audio/transcriptions')
      ? json({ text: '' }) : json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    vi.stubGlobal('fetch', fetch);
    await expect(runSelfTest('chat-primary-key', 'same-server-model')).resolves.toMatchObject({ latencyMs: expect.any(Number) });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/chat/completions'))).toHaveLength(1);
  });

  it('probes custom Whisper with address fallback when testing unsaved Gemini settings', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(sttLan)) throw new TypeError('LAN unreachable');
      if (url.startsWith(sttTail)) return json({ text: '' });
      return json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(runSelfTest('gemini-primary-key', DEFAULT_GEMINI_MODEL, {
      provider: 'gemini', sttHost: sttLan, sttModel: 'unsaved-whisper', sttApiKey: '', sttFallbackUrls: [sttTail],
    })).resolves.toMatchObject({ latencyMs: expect.any(Number) });
    expect(fetch.mock.calls[0]![0]).toBe(`${sttLan}/audio/transcriptions`);
    expect(fetch.mock.calls[1]![0]).toBe(`${sttTail}/audio/transcriptions`);
    expect(fetch.mock.calls[2]![0]).toContain('generativelanguage.googleapis.com');
  });

  it('runs Responses streaming through separate Whisper and chat fallback lists', async () => {
    const baseUrl = 'https://api.openai.com/v1';
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(sttLan) || url === `${baseUrl}/responses`) throw new TypeError('Primary unreachable');
      if (url.startsWith(sttTail)) return json({ text: 'heard speech' });
      const event = { type: 'response.output_text.delta', delta: JSON.stringify(output) };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    });
    vi.stubGlobal('fetch', fetch);
    await expect(callOpenAiResponsesLensStream({
      apiKey: 'response-primary-key', baseUrl, fallbackUrls: [chatTail],
      transcribeBaseUrl: sttLan, transcribeApiKey: '', transcribeModel: 'local-whisper', transcribeFallbackUrls: [sttTail],
      model: 'gpt-4o', wav, prompt: 'Return JSON', schema,
    })).resolves.toBe(JSON.stringify(output));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${sttLan}/audio/transcriptions`, `${sttTail}/audio/transcriptions`, `${baseUrl}/responses`, `${chatTail}/responses`,
    ]);
  });

  it('reports empty speech before attempting chat on either address', async () => {
    const fetch = vi.fn(async () => json({ text: '' }));
    vi.stubGlobal('fetch', fetch);
    await expect(callLensStream({ wav, prompt: 'Return JSON', schema })).rejects.toMatchObject({ name: 'NoSpeechError' });
    expect(fetch.mock.calls).toHaveLength(1);
  });

  it('never repeats STT or switches addresses when the wearer aborts an open chat stream', async () => {
    const outer = new AbortController();
    const cancel = vi.fn();
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/audio/transcriptions')) return json({ text: 'heard speech' });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = { choices: [{ delta: { content: '{"answer":"partial"' } }] };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
        },
        cancel,
      }));
    });
    vi.stubGlobal('fetch', fetch);
    await expect(callLensStream({ wav, prompt: 'Return JSON', schema, signal: outer.signal,
      onPartialField: () => outer.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${sttLan}/audio/transcriptions`, `${chatLan}/chat/completions`]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled Whisper response body without attempting another address or chat', async () => {
    const outer = new AbortController();
    let bodySignal: AbortSignal | undefined;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodySignal = init.signal!;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
        },
      }));
    });
    vi.stubGlobal('fetch', fetch);
    const result = transcribeAudio({ apiKey: '', baseUrl: sttLan, fallbackUrls: [sttTail], model: 'local-whisper', wav, signal: outer.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    // Let response.json() start before cancelling, rather than aborting headers.
    await vi.waitFor(() => expect(bodySignal).toBeDefined());
    await Promise.resolve();
    outer.abort();
    const wasCancelled = bodySignal!.aborted;
    // Clean up the mock if the regression is present so the test never hangs.
    if (!wasCancelled) bodyController!.error(new DOMException('Test cleanup', 'AbortError'));
    await rejected;
    expect(wasCancelled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
