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
  },
}));

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

describe('isSecureKey', () => {
  it('classifies API key keys as secure', () => {
    expect(isSecureKey('veritaslens.geminiApiKey')).toBe(true);
    expect(isSecureKey('veritaslens.claudeApiKey')).toBe(true);
    expect(isSecureKey('veritaslens.openaiApiKeys')).toBe(true);
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

  it('routes non-key set to AsyncStorage', async () => {
    (AsyncStorage.setItem as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const ok = await setLocalStorage('veritaslens.activeLensId', 'translation');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('veritaslens.activeLensId', 'translation');
    expect(ok).toBe(true);
  });
});
