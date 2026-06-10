// tests/transcriptSource.test.ts
//
// Provider-routing tests for the whisper-sidecar. Mocks `settings()` and
// `transcribeAudio()` so each provider's behavior is observable in isolation;
// uses the real `transcript` module so we can assert what actually landed in
// the rolling buffer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks are declared before importing the module under test (vi hoists them).
const mockSettings = vi.fn();
const mockTranscribeAudio = vi.fn();

vi.mock('@/state/store', () => ({
  get settings(): unknown { return mockSettings; },
}));
vi.mock('@/llm/openai', () => ({
  transcribeAudio: (...args: unknown[]) => (mockTranscribeAudio as (...a: unknown[]) => Promise<string>)(...args),
}));

import {
  _resetTranscriptForTesting,
  getRecent,
  resetTranscript,
} from '../src/runtime/transcript';
import { runWhisperSidecar, shouldRunWhisperSidecar } from '../src/runtime/transcriptSource';

const FAKE_WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

beforeEach(() => {
  mockSettings.mockReset();
  mockTranscribeAudio.mockReset();
  resetTranscript('sess-test');
});

afterEach(() => {
  _resetTranscriptForTesting();
});

function settingsFor(overrides: Record<string, unknown> = {}): void {
  mockSettings.mockReturnValue({
    provider: 'gemini',
    sttHost: 'https://api.groq.com/openai/v1',
    openaiApiKeys: { 'https://api.groq.com/openai/v1': 'sk-stt' },
    sttModel: 'whisper-large-v3',
    openaiBaseUrl: 'https://api.openai.com/v1',
    transcriptEnabled: true,
    ...overrides,
  });
}

describe('shouldRunWhisperSidecar', () => {
  it('returns true for Gemini', () => {
    settingsFor({ provider: 'gemini' });
    expect(shouldRunWhisperSidecar()).toBe(true);
  });

  it('returns true for OpenRouter (inline-audio host)', () => {
    settingsFor({ provider: 'openai-compatible', openaiBaseUrl: 'https://openrouter.ai/api/v1' });
    expect(shouldRunWhisperSidecar()).toBe(true);
  });

  it('returns false for Claude (uses chat-byproduct onTranscript instead)', () => {
    settingsFor({ provider: 'claude' });
    expect(shouldRunWhisperSidecar()).toBe(false);
  });

  it('returns false for OpenAI direct (transcribe-then-chat, has onTranscript)', () => {
    settingsFor({ provider: 'openai-compatible', openaiBaseUrl: 'https://api.openai.com/v1' });
    expect(shouldRunWhisperSidecar()).toBe(false);
  });

  it('returns false for Groq chat host (transcribe-then-chat path)', () => {
    settingsFor({ provider: 'openai-compatible', openaiBaseUrl: 'https://api.groq.com/openai/v1' });
    expect(shouldRunWhisperSidecar()).toBe(false);
  });

  it('returns false when the transcript master switch is off, even on Gemini', () => {
    settingsFor({ provider: 'gemini', transcriptEnabled: false });
    expect(shouldRunWhisperSidecar()).toBe(false);
  });
});

describe('runWhisperSidecar', () => {
  it('on Gemini appends a tagged segment with the Whisper text', async () => {
    settingsFor({ provider: 'gemini' });
    mockTranscribeAudio.mockResolvedValue('hello from sidecar');

    await runWhisperSidecar(FAKE_WAV, 'other');

    const segs = getRecent(10);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.speaker).toBe('other');
    expect(segs[0]!.text).toBe('hello from sidecar');
  });

  it('on Claude is a no-op (chat-byproduct path handles transcript)', async () => {
    settingsFor({ provider: 'claude' });

    await runWhisperSidecar(FAKE_WAV, 'other');

    expect(mockTranscribeAudio).not.toHaveBeenCalled();
    expect(getRecent(10)).toHaveLength(0);
  });

  it('skips silently when the STT key is missing (graceful degradation)', async () => {
    settingsFor({
      provider: 'gemini',
      openaiApiKeys: {}, // no key for sttHost
    });

    await runWhisperSidecar(FAKE_WAV, 'other');

    expect(mockTranscribeAudio).not.toHaveBeenCalled();
    expect(getRecent(10)).toHaveLength(0);
  });

  it('drops the segment if the session rotates while transcribe is in flight', async () => {
    settingsFor({ provider: 'gemini' });
    let resolveTranscribe!: (text: string) => void;
    mockTranscribeAudio.mockReturnValue(new Promise<string>((r) => { resolveTranscribe = r; }));

    const sidecarPromise = runWhisperSidecar(FAKE_WAV, 'other');

    // Rotate the session before transcribe resolves — simulates leaveActiveSession
    // mid-flight.
    resetTranscript('sess-2');
    resolveTranscribe('stale text');
    await sidecarPromise;

    // The new session's transcript stays empty; the late result is dropped.
    expect(getRecent(10)).toHaveLength(0);
  });

  it('swallows transcribe errors silently — sidecar must not break the lens call', async () => {
    settingsFor({ provider: 'gemini' });
    mockTranscribeAudio.mockRejectedValue(new Error('whisper 500'));

    await expect(runWhisperSidecar(FAKE_WAV, 'other')).resolves.toBeUndefined();
    expect(getRecent(10)).toHaveLength(0);
  });

  it('drops an empty Whisper transcript (no segment appended)', async () => {
    settingsFor({ provider: 'gemini' });
    mockTranscribeAudio.mockResolvedValue('   ');

    await runWhisperSidecar(FAKE_WAV, 'other');

    expect(getRecent(10)).toHaveLength(0);
  });

  it('uses speaker="wearer" when the wearer-speak path calls it', async () => {
    settingsFor({ provider: 'gemini' });
    mockTranscribeAudio.mockResolvedValue('thank you');

    await runWhisperSidecar(FAKE_WAV, 'wearer');

    const segs = getRecent(10);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.speaker).toBe('wearer');
    expect(segs[0]!.text).toBe('thank you');
  });
});
