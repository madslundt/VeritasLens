import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

// TODO: Per-host OpenAI keys (storage key format: 'veritaslens.openaiKey.<url>')
// don't contain 'ApiKey' so they're currently routed to AsyncStorage unencrypted.
// Add a secondary pattern match like 'openaiKey.' once those keys are wired up
// in the LLM settings screen.

/** Pattern of localStorage key fragments that hold secrets. */
const SECURE_KEY_PATTERNS = ['ApiKey', 'apiKey'];

export function isSecureKey(key: string): boolean {
  return SECURE_KEY_PATTERNS.some((p) => key.includes(p));
}

/**
 * SecureStore on iOS Keychain restricts key characters; replace dots with
 * underscores to keep the original `veritaslens.*` namespace intact in
 * AsyncStorage while staying within Keychain's allowed character set.
 */
function secureStoreKey(localStorageKey: string): string {
  return localStorageKey.replace(/\./g, '_');
}

export async function getLocalStorage(key: string): Promise<string | null> {
  if (isSecureKey(key)) {
    return (await SecureStore.getItemAsync(secureStoreKey(key))) ?? null;
  }
  return (await AsyncStorage.getItem(key)) ?? null;
}

export async function setLocalStorage(key: string, value: string): Promise<boolean> {
  try {
    if (isSecureKey(key)) {
      await SecureStore.setItemAsync(secureStoreKey(key), value);
    } else {
      await AsyncStorage.setItem(key, value);
    }
    return true;
  } catch {
    return false;
  }
}
