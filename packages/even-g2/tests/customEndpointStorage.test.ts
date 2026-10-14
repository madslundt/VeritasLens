import { describe, expect, it } from 'vitest';
import { loadSettings, saveOpenaiBaseUrl, saveOpenaiKeys, saveOpenaiTranscribeModels, saveSttHost, saveSttModel, saveOpenaiFallbackUrls, saveSttFallbackUrls, settings } from '../src/state/store';

describe('custom endpoint persistence', () => {
  it('restores multiple custom key slots, including unauthenticated endpoints', async () => {
    const storage = new Map<string, string>();
    const set = async (key: string, value: string) => { storage.set(key, value); return true; };
    const first = 'https://custom.example/proxy/v1';
    const second = 'http://192.168.1.42:1234/v1';
    await saveOpenaiKeys(set, { [first]: 'private-key', [second]: '' });
    await saveOpenaiBaseUrl(set, `${second}/`);
    await saveOpenaiTranscribeModels(set, { [first]: 'custom-whisper' });
    await loadSettings(async (key) => storage.get(key) ?? '');
    expect(settings().openaiBaseUrl).toBe(second);
    expect(settings().openaiApiKeys[first]).toBe('private-key');
    expect(Object.hasOwn(settings().openaiApiKeys, second)).toBe(true);
    expect(settings().openaiApiKeys[second]).toBe('');
    expect(settings().openaiTranscribeModels[first]).toBe('custom-whisper');
  });

  it('rejects unsafe URLs on save and ignores corrupt custom URL entries on load', async () => {
    const storage = new Map<string, string>([
      ['veritaslens.openaiBaseUrl', 'javascript:alert(1)'],
      ['veritaslens.openaiCustomUrls', JSON.stringify(['https://user:secret@host/v1', null, 5])],
    ]);
    const set = async (key: string, value: string) => { storage.set(key, value); return true; };
    expect(() => saveOpenaiBaseUrl(set, 'https://user:secret@host/v1')).toThrow();
    await loadSettings(async (key) => storage.get(key) ?? '');
    expect(settings().openaiBaseUrl).toBe('https://api.openai.com/v1');
    expect(Object.keys(settings().openaiApiKeys)).not.toContain('https://user:secret@host/v1');
  });

  it('does not migrate a legacy provider key into an unauthenticated custom endpoint', async () => {
    const custom = 'https://custom.example/v1';
    const storage = new Map([
      ['veritaslens.openaiBaseUrl', custom],
      ['veritaslens.openaiKey', 'legacy-provider-secret'],
    ]);
    await loadSettings(async (key) => storage.get(key) ?? '');
    expect(settings().openaiApiKeys[custom]).toBe('');
  });

  it('does not publish new keys in memory when any storage write fails', async () => {
    await loadSettings(async () => '');
    const first = 'https://custom.example/v1';
    const before = settings().openaiApiKeys;
    const ok = await saveOpenaiKeys(async (key) => key !== 'veritaslens.openaiCustomUrls', { [first]: 'key' });
    expect(ok).toBe(false);
    expect(settings().openaiApiKeys).toEqual(before);
  });
});


describe('custom Whisper and alternate URL persistence', () => {
  it('restores custom Whisper without authentication and preserves separate chat/STT fallback lists', async () => {
    const storage = new Map<string, string>();
    const set = async (key: string, value: string) => { storage.set(key, value); return true; };
    const whisper = 'http://192.168.1.42:8000/v1';
    const chat = 'http://192.168.1.42:1234/v1';
    await saveSttHost(set, `${whisper}/`);
    await saveSttModel(set, 'local-whisper');
    await saveOpenaiKeys(set, { [whisper]: '' });
    await saveOpenaiFallbackUrls(set, { [chat]: ['https://chat.tailnet.example/v1/', 'https://chat.tailnet.example/v1', chat], 'https://other.example/v1': ['https://other.tailnet.example/v1'] });
    await saveSttFallbackUrls(set, { [whisper]: ['https://whisper.tailnet.example/v1/'] });
    await loadSettings(async (key) => storage.get(key) ?? '');
    expect(settings().sttHost).toBe(whisper);
    expect(settings().sttModel).toBe('local-whisper');
    expect(settings().openaiApiKeys[whisper]).toBe('');
    expect(settings().openaiFallbackUrls).toEqual({ [chat]: ['https://chat.tailnet.example/v1'], 'https://other.example/v1': ['https://other.tailnet.example/v1'] });
    expect(settings().sttFallbackUrls).toEqual({ [whisper]: ['https://whisper.tailnet.example/v1'] });
  });

  it('loads an active custom STT key without requiring the registry', async () => {
    const host = 'https://whisper.example/v1';
    const storage = new Map([
      ['veritaslens.sttHost', `${host}/`],
      [`veritaslens.openaiKey.${host}`, 'whisper-key'],
    ]);
    await loadSettings(async (key) => storage.get(key) ?? '');
    expect(settings().sttHost).toBe(host);
    expect(settings().sttModel).toBe('');
    expect(settings().openaiApiKeys[host]).toBe('whisper-key');
  });

  it('ignores corrupt fallback entries and invalid custom STT URLs on load', async () => {
    const storage = new Map([
      ['veritaslens.sttHost', 'javascript:alert(1)'],
      ['veritaslens.openaiFallbackUrls', JSON.stringify({ 'http://localhost:1234/v1/': ['https://fallback.example/v1/', 'unsafe', null], unsafe: ['https://example/v1'] })],
      ['veritaslens.sttFallbackUrls', '{broken'],
    ]);
    await loadSettings(async (key) => storage.get(key) ?? '');
    expect(settings().sttHost).toBe('https://api.groq.com/openai/v1');
    expect(settings().openaiFallbackUrls).toEqual({ 'http://localhost:1234/v1': ['https://fallback.example/v1'] });
    expect(settings().sttFallbackUrls).toEqual({});
  });

  it('rejects unsafe alternate URLs and does not publish failed writes', async () => {
    await loadSettings(async () => '');
    const before = settings().sttFallbackUrls;
    await expect(saveSttFallbackUrls(async () => true, { 'http://localhost:8000/v1': ['https://user:secret@host/v1'] })).rejects.toThrow();
    expect(await saveSttFallbackUrls(async () => false, { 'http://localhost:8000/v1': ['https://whisper.tailnet.example/v1'] })).toBe(false);
    expect(settings().sttFallbackUrls).toEqual(before);
  });
});
