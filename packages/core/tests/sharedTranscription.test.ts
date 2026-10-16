import { afterEach, describe, expect, it, vi } from 'vitest';
import { callOpenAiLens, callOpenAiLensStream } from '../src/llm/openai';
import { callOpenAiResponsesLensStream } from '../src/llm/openaiResponses';
import { callLens, callLensStream, prepareLensTranscript } from '../src/llm/index';
import { configureSettings } from '../src/state/store';
import { DEFAULT_GEMINI_MODEL, DEFAULT_CLAUDE_MODEL, type Settings } from '../src/types';

const raw = '{"noSpeech":false,"claims":[]}';
const opts = {
  apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1' as const,
  model: 'test-model', transcribeModel: 'whisper-1', wav: new Uint8Array(44),
  prompt: 'Analyze', schema: { type: 'object', properties: { claims: { type: 'array' } } },
};

function json(body: unknown) { return new Response(JSON.stringify(body)); }
function stream(data: unknown) { return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`); }

const defaultSettings: Settings = {
  geminiApiKey: '', geminiModel: DEFAULT_GEMINI_MODEL, geminiAutoModel: null,
  claudeApiKey: 'claude-key', claudeModel: DEFAULT_CLAUDE_MODEL,
  provider: 'openai-compatible', openaiBaseUrl: 'https://api.openai.com/v1', openaiModel: 'test-model',
  openaiApiKeys: {}, openaiTranscribeModels: {}, sttHost: 'https://api.groq.com/openai/v1', sttModel: 'whisper-large-v3',
  responseLanguage: 'en', bufferDuration: 30, micSource: 'glasses',
  autoSummaryEnabled: false, crossSessionRecallEnabled: false, transcriptMode: 'off', discreet: false,
  voiceGateRmsFloor: 200, voiceTrimEnabled: true, audioCompressionEnabled: true, autoDisabledLenses: [],
  autoModeEnabled: false, autoModeStartMs: 1000, autoModeSilenceMs: 1000, autoModeIntervalMs: 30000,
  translationSourceLanguages: 'auto', translationMode: 'converse', romanizeForeignScript: false,
  locationEnabled: false, cachedLocation: null,
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('shared transcription on the actual provider paths', () => {
  it.each(['https://api.openai.com/v1', 'https://api.groq.com/openai/v1', 'https://api.deepseek.com/v1'])
    ('shares one upload across Auto facade calls on %s and creates a fresh upload for the next tap', async (baseUrl) => {
      configureSettings(() => ({
        ...defaultSettings,
        provider: 'openai-compatible', openaiBaseUrl: baseUrl, openaiModel: 'test-model',
        openaiApiKeys: { [baseUrl]: 'test-key', 'https://api.groq.com/openai/v1': 'stt-key' },
        openaiTranscribeModels: {}, sttHost: 'https://api.groq.com/openai/v1', sttModel: 'whisper-large-v3',
      }));
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/audio/transcriptions')) return json({ text: 'One captured question' });
        return JSON.parse(String(init?.body)).stream
          ? stream({ choices: [{ delta: { content: raw } }] })
          : json({ choices: [{ message: { content: raw } }] });
      });
      vi.stubGlobal('fetch', fetchMock);
      const signal = new AbortController().signal;
      const transcript = prepareLensTranscript(opts.wav, signal);
      await Promise.all([
        callLens({ ...opts, transcript, signal }),
        callLensStream({ ...opts, transcript, signal }),
        callLensStream({ ...opts, transcript, signal }),
      ]);
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/audio/transcriptions'))).toHaveLength(1);
      await prepareLensTranscript(opts.wav, signal);
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/audio/transcriptions'))).toHaveLength(2);
    });

  it('does not start extra transcription on inline-audio providers', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const provider of ['gemini', 'openai-compatible'] as const) {
      configureSettings(() => ({ ...defaultSettings, provider, openaiBaseUrl: 'https://openrouter.ai/api/v1' }));
      expect(prepareLensTranscript(opts.wav, new AbortController().signal)).toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shares STT between Claude classification and streaming without transcribing twice', async () => {
    configureSettings(() => ({ ...defaultSettings, provider: 'claude',
      openaiApiKeys: { 'https://api.groq.com/openai/v1': 'speech-key' } }));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/audio/transcriptions')) return json({ text: 'One captured question' });
      if (!JSON.parse(String(init?.body)).stream) {
        return json({ content: [{ type: 'tool_use', name: 'emit_lens_result', input: JSON.parse(raw) }] });
      }
      return new Response([
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'emit_lens_result' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: raw } },
      ].map((data) => `data: ${JSON.stringify(data)}\n\n`).join(''));
    });
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    const transcript = prepareLensTranscript(opts.wav, signal);
    await Promise.all([callLens({ ...opts, transcript, signal }), callLensStream({ ...opts, transcript, signal })]);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/audio/transcriptions'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/messages'))).toHaveLength(2);
  });

  it('reuses one transcript for classifier and streaming answer without uploading audio again', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/audio/transcriptions')) return json({ text: 'redundant STT' });
      const body = JSON.parse(String(init?.body));
      return body.stream
        ? stream({ choices: [{ delta: { content: raw } }] })
        : json({ choices: [{ message: { content: raw } }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const transcript = Promise.resolve('The moon is 384400 kilometres away.');
    await Promise.all([
      callOpenAiLens({ ...opts, transcript }),
      callOpenAiLensStream({ ...opts, transcript }),
    ]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/v1/chat/completions',
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String(init?.body)).messages[1].content).toContain('384400');
    }
  });

  it('also reuses the transcript on the grounded OpenAI Responses path', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/audio/transcriptions')) return json({ text: 'redundant STT' });
      return stream({ type: 'response.output_text.delta', delta: raw });
    });
    vi.stubGlobal('fetch', fetchMock);
    await callOpenAiResponsesLensStream({ ...opts, transcript: Promise.resolve('A question') });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://api.openai.com/v1/responses']);
  });

  it.each([callOpenAiLens, callOpenAiLensStream])('skips the answer model when STT detects no speech', async (call) => {
    const fetchMock = vi.fn(async (url: string) => url.endsWith('/audio/transcriptions')
      ? json({ text: '   ' }) : json({ choices: [{ message: { content: raw } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(call(opts)).rejects.toMatchObject({ name: 'NoSpeechError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
