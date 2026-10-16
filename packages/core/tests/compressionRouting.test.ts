import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmProvider, OpenAiBaseUrl } from '../src/types';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  gemini: vi.fn(), geminiStream: vi.fn(), geminiSelfTest: vi.fn(),
  openai: vi.fn(), openaiStream: vi.fn(), openaiSelfTest: vi.fn(), responses: vi.fn(),
  claude: vi.fn(), claudeStream: vi.fn(), claudeSelfTest: vi.fn(),
  resolveTranscript: vi.fn(), transcribe: vi.fn(),
}));

vi.mock('@/state/store', () => ({ settings: mocks.settings }));
vi.mock('../src/llm/gemini', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/llm/gemini')>(),
  callLens: mocks.gemini, callLensStream: mocks.geminiStream, runSelfTest: mocks.geminiSelfTest,
}));
vi.mock('../src/llm/openai', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/llm/openai')>(),
  callOpenAiLens: mocks.openai, callOpenAiLensStream: mocks.openaiStream,
  runSelfTest: mocks.openaiSelfTest, resolveLensTranscript: mocks.resolveTranscript,
  transcribeAudio: mocks.transcribe,
}));
vi.mock('../src/llm/openaiResponses', () => ({ callOpenAiResponsesLensStream: mocks.responses }));
vi.mock('../src/llm/claude', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/llm/claude')>(),
  callLens: mocks.claude, callLensStream: mocks.claudeStream, runSelfTest: mocks.claudeSelfTest,
}));

import { callLens, callLensStream, prepareLensTranscript, runSelfTest } from '../src/llm/index';
import { runWhisperSidecar } from '../src/runtime/transcriptSource';
import { transcribeConversationAudio } from '../src/runtime/captions';
import { _resetTranscriptForTesting, resetTranscript } from '../src/runtime/transcript';

const openaiHost = 'https://api.openai.com/v1';
const groqHost = 'https://api.groq.com/openai/v1';
const openrouterHost = 'https://openrouter.ai/api/v1';
const deepseekHost = 'https://api.deepseek.com/v1';
const options = {
  wav: new Uint8Array(44), prompt: 'Answer the question', schema: { type: 'object' },
};

function useSettings(audioCompressionEnabled: boolean | undefined, provider: LlmProvider = 'openai-compatible', openaiBaseUrl: OpenAiBaseUrl = openaiHost) {
  mocks.settings.mockReturnValue({
    provider, audioCompressionEnabled, openaiBaseUrl, openaiModel: 'gpt-5.4-mini',
    geminiApiKey: 'gemini-key', geminiModel: 'gemini-2.5-flash',
    claudeApiKey: 'claude-key', claudeModel: 'claude-sonnet-4-5',
    openaiApiKeys: { [openaiHost]: 'openai-key', [groqHost]: 'groq-key', [deepseekHost]: 'deepseek-key' },
    openaiTranscribeModels: {}, sttHost: groqHost, sttModel: 'whisper-large-v3', transcriptMode: 'on',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTranscript.mockResolvedValue('A captured question');
  mocks.transcribe.mockResolvedValue('A captured question');
  resetTranscript('compression-routing');
});
afterEach(() => _resetTranscriptForTesting());

describe.each([true, false])('audio compression routing when enabled=%s', (enabled) => {
  it.each([
    ['gemini', openaiHost, mocks.gemini, mocks.geminiStream],
    ['openai-compatible', openaiHost, mocks.openai, mocks.openaiStream],
    ['openai-compatible', groqHost, mocks.openai, mocks.openaiStream],
    ['openai-compatible', deepseekHost, mocks.openai, mocks.openaiStream],
    ['openai-compatible', openrouterHost, mocks.openai, mocks.openaiStream],
  ] as const)('passes the setting to %s at %s for normal and streaming calls', async (provider, host, plain, streaming) => {
    useSettings(enabled, provider, host);
    await callLens(options);
    await callLensStream(options);
    expect(plain).toHaveBeenCalledWith(expect.objectContaining({ audioCompressionEnabled: enabled }));
    expect(streaming).toHaveBeenCalledWith(expect.objectContaining({ audioCompressionEnabled: enabled }));
  });

  it('passes the setting to grounded OpenAI Responses calls', async () => {
    useSettings(enabled);
    await callLensStream({ ...options, grounding: 'web_search' });
    expect(mocks.responses).toHaveBeenCalledWith(expect.objectContaining({ audioCompressionEnabled: enabled }));
  });

  it('passes the setting to both Claude transcription paths', async () => {
    useSettings(enabled, 'claude');
    await callLens(options);
    await callLensStream(options);
    expect(mocks.resolveTranscript).toHaveBeenCalledTimes(2);
    for (const [opts] of mocks.resolveTranscript.mock.calls) expect(opts.audioCompressionEnabled).toBe(enabled);
  });

  it.each(['openai-compatible', 'claude'] as const)('passes the setting to shared Auto transcription for %s', async (provider) => {
    useSettings(enabled, provider);
    await prepareLensTranscript(options.wav, new AbortController().signal);
    expect(mocks.resolveTranscript).toHaveBeenCalledWith(expect.objectContaining({ audioCompressionEnabled: enabled }));
  });

  it.each(['gemini', 'openai-compatible'] as const)('passes the setting to the %s transcript sidecar', async (provider) => {
    useSettings(enabled, provider, openrouterHost);
    await runWhisperSidecar(options.wav, 'other');
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.objectContaining({ audioCompressionEnabled: enabled }));
  });

  it('passes the setting to live caption uploads', async () => {
    useSettings(enabled);
    await transcribeConversationAudio(options.wav, new AbortController().signal);
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.objectContaining({ audioCompressionEnabled: enabled }));
  });

  it.each([openaiHost, deepseekHost, openrouterHost])('uses the unsaved compression choice when self-testing %s', async (host) => {
    useSettings(!enabled, 'openai-compatible', host);
    await runSelfTest('draft-key', 'test-model', { audioCompressionEnabled: enabled });
    expect(mocks.openaiSelfTest).toHaveBeenCalledTimes(1);
    expect(mocks.openaiSelfTest.mock.calls[0]?.slice(0, 3)).toEqual(['draft-key', host, 'test-model']);
    expect(mocks.openaiSelfTest.mock.calls[0]?.[4]).toMatchObject({ audioCompressionEnabled: enabled });
  });

  it.each(['gemini', 'claude', 'openai-compatible'] as const)('uses the draft choice for the %s STT self-test', async (provider) => {
    useSettings(!enabled, provider, openrouterHost);
    await runSelfTest('draft-key', 'test-model', { audioCompressionEnabled: enabled, sttHost: groqHost });
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.objectContaining({ audioCompressionEnabled: enabled }));
    if (provider === 'gemini') {
      expect(mocks.geminiSelfTest).toHaveBeenCalledWith('draft-key', 'test-model', expect.objectContaining({ audioCompressionEnabled: enabled }));
    }
  });
});

it('lets an explicit call override disable compression without changing the saved choice', async () => {
  useSettings(true);
  await callLensStream({ ...options, audioCompressionEnabled: false });
  expect(mocks.openaiStream).toHaveBeenCalledWith(expect.objectContaining({ audioCompressionEnabled: false }));
});

it('self-tests the saved compression choice when there is no draft override', async () => {
  useSettings(false);
  await runSelfTest('key');
  expect(mocks.openaiSelfTest.mock.calls[0]?.[4]).toMatchObject({ audioCompressionEnabled: false });
});
