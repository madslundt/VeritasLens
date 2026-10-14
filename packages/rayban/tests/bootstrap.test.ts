import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock native + external dependencies before any imports that transitively
// load them. Order matters — vi.mock is hoisted to the top of the module by
// Vitest's transform, but the factory closures run at import time.
// ---------------------------------------------------------------------------

vi.mock('expo-speech', () => ({ speak: vi.fn(), stop: vi.fn() }));
vi.mock('expo-av', () => ({
  Audio: {
    Sound: class {
      loadAsync() { return Promise.resolve(); }
      replayAsync() { return Promise.resolve(); }
    },
  },
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock callLensStream so triggerAnalysis (called indirectly via startLifecycle
// → tap handler) never hits a real LLM, and configureSettings is preserved
// from the real implementation so we can spy on it.
vi.mock('@veritaslens/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@veritaslens/core')>();
  return {
    ...actual,
    callLensStream: vi.fn().mockResolvedValue('{"noSpeech":false,"claims":[]}'),
  };
});

// Mock bridge-rn so we control what getLocalStorage returns.
// The module path must match exactly what bootstrap.ts imports.
vi.mock('../src/runtime/bridge-rn', () => ({
  getLocalStorage: vi.fn().mockResolvedValue(null),
  setLocalStorage: vi.fn().mockResolvedValue(true),
  isSecureKey: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are declared)
// ---------------------------------------------------------------------------

import { bootstrap, patchFullSettings } from '../src/runtime/bootstrap';
import { useStore } from '../src/state/store';
import * as bridgeRn from '../src/runtime/bridge-rn';
import * as core from '@veritaslens/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Configure getLocalStorage to return a specific key → value map. */
function mockStorage(values: Record<string, string | null>): void {
  vi.mocked(bridgeRn.getLocalStorage).mockImplementation((key: string) =>
    Promise.resolve(values[key] ?? null),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bootstrap', () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    vi.clearAllMocks();
    // Default: all keys absent → defaults apply.
    vi.mocked(bridgeRn.getLocalStorage).mockResolvedValue(null);
  });

  it('calls getLocalStorage for the expected settings keys', async () => {
    await bootstrap();

    const calls = vi.mocked(bridgeRn.getLocalStorage).mock.calls.map(([k]) => k);

    expect(calls).toContain('veritaslens.provider');
    expect(calls).toContain('veritaslens.geminiApiKey');
    expect(calls).toContain('veritaslens.claudeApiKey');
    // At least one per-host OpenAI key key
    expect(calls.some((k) => k.startsWith('veritaslens.openaiKey.'))).toBe(true);
  });

  it('hydrates Zustand store with persisted non-secret settings', async () => {
    mockStorage({
      'veritaslens.provider': 'claude',
      'veritaslens.claudeModel': 'claude-opus-4-5',
      'veritaslens.ttsEnabled': 'false',
      'veritaslens.ttsRate': '1.5',
    });

    await bootstrap();

    const settings = useStore.getState().settings;
    expect(settings.provider).toBe('claude');
    expect(settings.claudeModel).toBe('claude-opus-4-5');
    expect(settings.ttsEnabled).toBe(false);
    expect(settings.ttsRate).toBe(1.5);
  });

  it.each([true, false])('hydrates Tavily enabled=%s without losing its private key', async (enabled) => {
    mockStorage({ 'veritaslens.tavilyEnabled': String(enabled), 'veritaslens.tavilyApiKey': 'tvly-private' });
    await bootstrap();
    expect(useStore.getState().settings.tavilyEnabled).toBe(enabled);
    expect(useStore.getState().settings).not.toHaveProperty('tavilyApiKey');
    expect(core.settings().tavilyApiKey).toBe('tvly-private');
    expect(core.settings().tavilyEnabled).toBe(enabled);
    expect(Object.values(core.settings().openaiApiKeys)).not.toContain('tvly-private');
    patchFullSettings({ tavilyEnabled: !enabled });
    expect(core.settings().tavilyEnabled).toBe(!enabled);
    expect(core.settings().tavilyApiKey).toBe('tvly-private');
  });

  it('hydrates custom endpoints and their per-endpoint keys', async () => {
    mockStorage({
      'veritaslens.provider': 'openai-compatible',
      'veritaslens.openaiBaseUrl': 'http://localhost:1234/v1/',
      'veritaslens.openaiCustomUrls': JSON.stringify(['http://localhost:1234/v1', 'https://other.example/api', 'invalid']),
      'veritaslens.openaiKey.http://localhost:1234/v1': 'local-key',
      'veritaslens.openaiKey.https://other.example/api': 'other-key',
    });
    await bootstrap();
    expect(useStore.getState().settings.openaiBaseUrl).toBe('http://localhost:1234/v1');
    expect(core.settings().openaiApiKeys['http://localhost:1234/v1']).toBe('local-key');
    expect(core.settings().openaiApiKeys['https://other.example/api']).toBe('other-key');
  });

  it('survives invalid custom URL storage', async () => {
    mockStorage({
      'veritaslens.openaiBaseUrl': 'javascript:alert(1)',
      'veritaslens.openaiCustomUrls': '{broken',
    });
    await bootstrap();
    expect(useStore.getState().settings.openaiBaseUrl).toBe('https://api.openai.com/v1');
  });

  it('restores a custom Whisper server and its secret without requiring a custom chat URL', async () => {
    mockStorage({
      'veritaslens.sttHost': 'http://localhost:8000/v1/',
      'veritaslens.sttModel': 'whisper-custom',
      'veritaslens.openaiKey.http://localhost:8000/v1': 'speech-key',
    });
    await bootstrap();
    expect(useStore.getState().settings).toMatchObject({ sttHost: 'http://localhost:8000/v1', sttModel: 'whisper-custom' });
    expect(core.settings().openaiApiKeys['http://localhost:8000/v1']).toBe('speech-key');
  });

  it('restores ordered fallback addresses into both settings stores', async () => {
    const chat = { 'https://chat.example/v1': ['https://chat-backup.example/v1'] };
    const speech = { 'https://speech.example/v1': ['https://speech-backup.example/v1', 'http://localhost:8000/v1'] };
    mockStorage({
      'veritaslens.openaiFallbackUrls': JSON.stringify(chat),
      'veritaslens.sttFallbackUrls': JSON.stringify(speech),
    });
    await bootstrap();
    expect(useStore.getState().settings).toMatchObject({ openaiFallbackUrls: chat, sttFallbackUrls: speech });
    expect(core.settings()).toMatchObject({ openaiFallbackUrls: chat, sttFallbackUrls: speech });
  });

  it('resets damaged custom speech and fallback settings safely', async () => {
    mockStorage({ 'veritaslens.sttHost': 'javascript:alert(1)', 'veritaslens.openaiFallbackUrls': '{broken', 'veritaslens.sttFallbackUrls': '[]' });
    await bootstrap();
    expect(core.settings()).toMatchObject({ sttHost: core.DEFAULT_STT_HOST, sttModel: core.DEFAULT_STT_MODEL, openaiFallbackUrls: {}, sttFallbackUrls: {} });
  });

  it('uses defaults when storage returns null', async () => {
    // All mocks return null (set in beforeEach).
    await bootstrap();

    const settings = useStore.getState().settings;
    expect(settings.provider).toBe('gemini');
    expect(settings.ttsEnabled).toBe(true);
    expect(settings.ttsRate).toBe(1.0);
    expect(settings.bufferDurationSec).toBe(30);
  });

  it('registers configureSettings with core', async () => {
    const configureSpy = vi.spyOn(core, 'configureSettings');

    await bootstrap();

    expect(configureSpy).toHaveBeenCalledOnce();
    // The argument is a getter function.
    const [getter] = configureSpy.mock.calls[0] as [() => core.Settings];
    expect(typeof getter).toBe('function');
    const result = getter();
    expect(result).toMatchObject({
      provider: 'gemini',
      geminiApiKey: '',
    });
  });
});

describe('patchFullSettings', () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    vi.clearAllMocks();
    vi.mocked(bridgeRn.getLocalStorage).mockResolvedValue(null);
  });

  it('updates the closure returned by the configureSettings getter', async () => {
    const configureSpy = vi.spyOn(core, 'configureSettings');

    await bootstrap();

    const [getter] = configureSpy.mock.calls[0] as [() => core.Settings];

    // Before patch — geminiApiKey is empty (storage returned null).
    expect(getter().geminiApiKey).toBe('');

    // Patch with a new key.
    patchFullSettings({ geminiApiKey: 'new-api-key-123' });

    // Getter now reflects the patched value — no new configureSettings call needed.
    expect(getter().geminiApiKey).toBe('new-api-key-123');
  });

  it('mirrors current UI routing into the core settings closure', async () => {
    await bootstrap();
    useStore.getState().updateSettings({ provider: 'openai-compatible', openaiBaseUrl: 'http://localhost:1234/v1', openaiModel: 'local-model' });
    patchFullSettings({});
    expect(core.settings()).toMatchObject({ provider: 'openai-compatible', openaiBaseUrl: 'http://localhost:1234/v1', openaiModel: 'local-model' });
  });

  it('mirrors edited custom speech and fallback addresses without another bootstrap', async () => {
    await bootstrap();
    const next = {
      sttHost: 'https://speech.example/v1', sttModel: 'whisper-custom',
      sttFallbackUrls: { 'https://speech.example/v1': ['http://localhost:8000/v1'] },
      openaiFallbackUrls: { 'https://chat.example/v1': ['https://chat-backup.example/v1'] },
    };
    useStore.getState().updateSettings(next);
    patchFullSettings({});
    expect(core.settings()).toMatchObject(next);
  });

  it('does not clobber unpatched fields', async () => {
    mockStorage({
      'veritaslens.claudeApiKey': 'claude-key-abc',
    });
    const configureSpy = vi.spyOn(core, 'configureSettings');

    await bootstrap();
    const [getter] = configureSpy.mock.calls[0] as [() => core.Settings];

    patchFullSettings({ geminiApiKey: 'gemini-key-xyz' });

    expect(getter().claudeApiKey).toBe('claude-key-abc');
    expect(getter().geminiApiKey).toBe('gemini-key-xyz');
  });
});
