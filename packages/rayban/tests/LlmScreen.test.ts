import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const testState = vi.hoisted(() => ({
  settings: {
    provider: 'openai-compatible', openaiBaseUrl: 'https://chat.example/v1', openaiModel: 'chat-model',
    geminiModel: 'gemini-2.5-flash', claudeModel: 'claude-sonnet-4-6',
    sttHost: 'https://whisper.example/v1', sttModel: 'whisper-model',
    openaiFallbackUrls: {}, sttFallbackUrls: {},
  },
  hooks: [] as unknown[], setters: [] as Array<ReturnType<typeof vi.fn>>,
  updateSettings: vi.fn(), patchFullSettings: vi.fn(), runSelfTest: vi.fn(), setLocalStorage: vi.fn(),
}));

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: vi.fn(),
  useState: (initial: unknown) => {
    const setter = vi.fn();
    const index = testState.setters.length;
    testState.setters.push(setter);
    return [index < testState.hooks.length ? testState.hooks[index] : initial, setter];
  },
}));
vi.mock('react-native', () => ({
  View: 'View', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../src/state/store', () => ({
  useStore: (select: (state: unknown) => unknown) => select({ settings: testState.settings, updateSettings: testState.updateSettings }),
}));
vi.mock('../src/runtime/bootstrap', () => ({ patchFullSettings: testState.patchFullSettings }));
vi.mock('../src/runtime/bridge-rn', () => ({ setLocalStorage: testState.setLocalStorage }));
vi.mock('@veritaslens/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@veritaslens/core')>(),
  settings: () => ({ openaiApiKeys: {}, geminiApiKey: '', claudeApiKey: '' }),
  runSelfTest: testState.runSelfTest,
}));

import { LlmScreen } from '../src/screens/LlmScreen';

type Element = ReactElement<{ children?: unknown; onPress?: () => void }>;
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as Element;
  return [node, ...elements(node.props.children)];
}
function press(text: string): void {
  const node = elements(LlmScreen()).find((element) => element.type === 'TouchableOpacity'
    && elements(element.props.children).some((child) =>
      (Array.isArray(child.props.children) ? child.props.children.join('') : child.props.children) === text));
  expect(node).toBeDefined();
  node!.props.onPress!();
}
function draft(provider = 'openai-compatible', speechUrl = 'https://whisper.example/v1', speechKey = '') {
  testState.hooks = [provider, 'https://chat.example/v1/', 'chat-model', 'chat-key',
    'https://chat-backup.example/v1/\nhttp://localhost:1234/v1', speechUrl, 'whisper-model', speechKey,
    'https://whisper-backup.example/v1/'];
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.setters = [];
  testState.hooks = [];
  testState.setLocalStorage.mockResolvedValue(true);
  testState.runSelfTest.mockResolvedValue({ latencyMs: 10 });
});

describe('LLM settings draft actions', () => {
  it('tests draft custom Whisper and ordered alternate addresses without saving', async () => {
    draft();
    press('Test OpenAI-compatible');
    await vi.waitFor(() => expect(testState.runSelfTest).toHaveBeenCalledWith('chat-key', 'chat-model', expect.objectContaining({
      provider: 'openai-compatible', baseUrl: 'https://chat.example/v1',
      sttHost: 'https://whisper.example/v1', sttApiKey: '', sttModel: 'whisper-model',
      fallbackUrls: ['https://chat-backup.example/v1', 'http://localhost:1234/v1'],
      sttFallbackUrls: ['https://whisper-backup.example/v1'],
    })));
    expect(testState.setLocalStorage).not.toHaveBeenCalled();
  });

  it('saves custom speech secrets and both fallback maps for immediate use', async () => {
    draft('openai-compatible', 'https://whisper.example/v1/', 'whisper-key');
    press('Save settings');
    await vi.waitFor(() => expect(testState.patchFullSettings).toHaveBeenCalled());
    expect(testState.setLocalStorage).toHaveBeenCalledWith('veritaslens.openaiKey.https://whisper.example/v1', 'whisper-key');
    expect(testState.setLocalStorage).toHaveBeenCalledWith('veritaslens.openaiFallbackUrls', JSON.stringify({ 'https://chat.example/v1': ['https://chat-backup.example/v1', 'http://localhost:1234/v1'] }));
    expect(testState.setLocalStorage).toHaveBeenCalledWith('veritaslens.sttFallbackUrls', JSON.stringify({ 'https://whisper.example/v1': ['https://whisper-backup.example/v1'] }));
    expect(testState.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ sttHost: 'https://whisper.example/v1', sttModel: 'whisper-model' }));
  });

  it('persists Gemini transcript sidecar settings', async () => {
    draft('gemini', 'https://whisper.example/v1', 'whisper-key');
    press('Save settings');
    await vi.waitFor(() => expect(testState.patchFullSettings).toHaveBeenCalled());
    expect(testState.setLocalStorage).toHaveBeenCalledWith('veritaslens.sttHost', 'https://whisper.example/v1');
    expect(testState.setLocalStorage).toHaveBeenCalledWith('veritaslens.sttFallbackUrls', JSON.stringify({ 'https://whisper.example/v1': ['https://whisper-backup.example/v1'] }));
  });

  it('tests Gemini without probing an unconfigured optional built-in Whisper sidecar', async () => {
    draft('gemini', 'https://api.groq.com/openai/v1');
    press('Test Gemini');
    await vi.waitFor(() => expect(testState.runSelfTest).toHaveBeenCalled());
    const overrides = testState.runSelfTest.mock.calls[0][2];
    expect(overrides).toMatchObject({ provider: 'gemini' });
    expect(overrides).not.toHaveProperty('sttHost');
    expect(overrides).not.toHaveProperty('sttApiKey');
    expect(overrides).not.toHaveProperty('sttFallbackUrls');
  });

  it('tests a configured keyless custom Whisper sidecar with Gemini', async () => {
    draft('gemini', 'https://whisper.example/v1/');
    press('Test Gemini');
    await vi.waitFor(() => expect(testState.runSelfTest).toHaveBeenCalledWith('chat-key', 'chat-model', expect.objectContaining({
      provider: 'gemini', sttHost: 'https://whisper.example/v1', sttModel: 'whisper-model', sttApiKey: '',
      sttFallbackUrls: ['https://whisper-backup.example/v1'],
    })));
  });

  it('saves Gemini without requiring an API key for its optional built-in Whisper sidecar', async () => {
    draft('gemini', 'https://api.groq.com/openai/v1');
    press('Save settings');
    await vi.waitFor(() => expect(testState.patchFullSettings).toHaveBeenCalled());
    expect(testState.setLocalStorage).toHaveBeenCalledWith('veritaslens.geminiApiKey', 'chat-key');
  });

  it.each(['gemini', 'openai-compatible'])('saves %s with an unconfigured optional custom sidecar', async (provider) => {
    draft(provider, '');
    testState.hooks[6] = '';
    if (provider === 'openai-compatible') testState.hooks[1] = 'https://openrouter.ai/api/v1';
    press('Save settings');
    await vi.waitFor(() => expect(testState.patchFullSettings).toHaveBeenCalled());
    expect(testState.setLocalStorage.mock.calls.some(([key]) => key === 'veritaslens.sttHost')).toBe(false);
    expect(testState.setLocalStorage.mock.calls.some(([key]) => key === 'veritaslens.sttModel')).toBe(false);
  });

  it('exposes optional transcription for OpenRouter and tests its configured custom sidecar', async () => {
    draft('openai-compatible', 'https://whisper.example/v1');
    testState.hooks[1] = 'https://openrouter.ai/api/v1';
    const tree = elements(LlmScreen());
    expect(tree.some((element) => element.props.children === 'Transcription provider')).toBe(true);
    testState.setters = [];
    press('Test OpenAI-compatible');
    await vi.waitFor(() => expect(testState.runSelfTest).toHaveBeenCalledWith('chat-key', 'chat-model', expect.objectContaining({
      baseUrl: 'https://openrouter.ai/api/v1', sttHost: 'https://whisper.example/v1', sttApiKey: '', sttModel: 'whisper-model',
    })));
  });

  it('tests OpenRouter without probing a built-in sidecar that has no key', async () => {
    draft('openai-compatible', 'https://api.groq.com/openai/v1');
    testState.hooks[1] = 'https://openrouter.ai/api/v1';
    press('Test OpenAI-compatible');
    await vi.waitFor(() => expect(testState.runSelfTest).toHaveBeenCalled());
    expect(testState.runSelfTest.mock.calls[0][2]).not.toHaveProperty('sttHost');
  });

  it('rejects an invalid fallback before any settings are written', async () => {
    draft();
    testState.hooks[4] = 'javascript:alert(1)';
    press('Save settings');
    await vi.waitFor(() => expect(testState.setters[11]).toHaveBeenCalledWith(expect.stringContaining('Error:')));
    expect(testState.setLocalStorage).not.toHaveBeenCalled();
    expect(testState.updateSettings).not.toHaveBeenCalled();
  });

  it('shares the primary chat key when its Whisper endpoint uses the same address', async () => {
    draft('openai-compatible', 'https://chat.example/v1');
    press('Save settings');
    await vi.waitFor(() => expect(testState.patchFullSettings).toHaveBeenCalled());
    expect(testState.patchFullSettings).toHaveBeenCalledWith(expect.objectContaining({ openaiApiKeys: { 'https://chat.example/v1': 'chat-key' } }));
  });
});
