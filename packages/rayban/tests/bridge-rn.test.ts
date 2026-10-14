import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getLocalStorage, setLocalStorage, isSecureKey } from '../src/runtime/bridge-rn';

// Mock expo-secure-store and AsyncStorage before importing.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

describe('isSecureKey', () => {
  it('classifies API key keys as secure', () => {
    expect(isSecureKey('veritaslens.geminiApiKey')).toBe(true);
    expect(isSecureKey('veritaslens.claudeApiKey')).toBe(true);
    expect(isSecureKey('veritaslens.openaiApiKeys')).toBe(true);
    expect(isSecureKey('veritaslens.openaiKey.http://localhost:1234/v1')).toBe(true);
  });

  it('classifies non-credential keys as plain', () => {
    expect(isSecureKey('veritaslens.activeLensId')).toBe(false);
    expect(isSecureKey('veritaslens.history')).toBe(false);
  });
});

describe('bridge-rn storage routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes API key get to SecureStore', async () => {
    (SecureStore.getItemAsync as ReturnType<typeof vi.fn>).mockResolvedValue('secret-key');
    const v = await getLocalStorage('veritaslens.geminiApiKey');
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(expect.stringContaining('geminiApiKey'));
    expect(v).toBe('secret-key');
  });

  it('routes non-key get to AsyncStorage', async () => {
    (AsyncStorage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue('fact-check');
    const v = await getLocalStorage('veritaslens.activeLensId');
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('veritaslens.activeLensId');
    expect(v).toBe('fact-check');
  });

  it('routes API key set to SecureStore', async () => {
    (SecureStore.setItemAsync as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const ok = await setLocalStorage('veritaslens.claudeApiKey', 'sk-...');
    expect(SecureStore.setItemAsync).toHaveBeenCalled();
    expect(ok).toBe(true);
  });

  it('uses valid collision-free SecureStore names for endpoint keys', async () => {
    await setLocalStorage('veritaslens.openaiKey.https://api.example/v1', 'first');
    await setLocalStorage('veritaslens.openaiKey.https://api_example/v1', 'second');
    const names = vi.mocked(SecureStore.setItemAsync).mock.calls.map(([key]) => key);
    expect(names).toHaveLength(2);
    expect(names.every((name) => /^[A-Za-z0-9._-]+$/.test(name))).toBe(true);
    expect(names[0]).not.toBe(names[1]);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('migrates existing per-host keys to SecureStore without losing them', async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('legacy-key');
    const key = 'veritaslens.openaiKey.https://api.example/v1';
    expect(await getLocalStorage(key)).toBe('legacy-key');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(expect.any(String), 'legacy-key');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(key);
  });

  it('routes non-key set to AsyncStorage', async () => {
    (AsyncStorage.setItem as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const ok = await setLocalStorage('veritaslens.activeLensId', 'translation');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('veritaslens.activeLensId', 'translation');
    expect(ok).toBe(true);
  });
});
