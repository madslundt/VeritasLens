import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** Pattern of localStorage key fragments that hold secrets. */
const SECURE_KEY_PATTERNS = ['ApiKey', 'apiKey', 'openaiKey.'];

export function isSecureKey(key: string): boolean {
  return SECURE_KEY_PATTERNS.some((p) => key.includes(p));
}

/**
 * SecureStore restricts key characters. Keep legacy credential names stable
 * and encode endpoint credential names as code points so URL punctuation is
 * valid and distinct endpoint URLs never share a credential slot.
 */
function secureStoreKey(localStorageKey: string): string {
  // Preserve existing Gemini/Claude key names; encode endpoint URLs collision-free.
  if (!localStorageKey.includes('openaiKey.')) return localStorageKey.replace(/\./g, '_');
  return 'openai_' + Array.from(localStorageKey, (char) => char.codePointAt(0)!.toString(16)).join('_');
}

export async function getLocalStorage(key: string): Promise<string | null> {
  if (isSecureKey(key)) {
    const secure = await SecureStore.getItemAsync(secureStoreKey(key));
    if (secure !== null && secure !== undefined) return secure;
    // Older Rayban versions stored endpoint keys in AsyncStorage. Migrate only
    // after Keychain succeeds, so a temporary native failure cannot lose a key.
    if (key.includes('openaiKey.')) {
      const legacy = await AsyncStorage.getItem(key);
      if (legacy !== null && legacy !== undefined) {
        await SecureStore.setItemAsync(secureStoreKey(key), legacy);
        await AsyncStorage.removeItem(key);
        return legacy;
      }
    }
    return null;
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
