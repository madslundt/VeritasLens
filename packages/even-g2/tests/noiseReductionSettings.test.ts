import { describe, expect, it } from 'vitest';
import { loadSettings, saveNoiseReductionEnabled, settings } from '../src/state/store';

describe('noise reduction setting', () => {
  it.each(['', 'false', 'unexpected'])('defaults off for missing or malformed value %s', async value => {
    await loadSettings(async key => key === 'veritaslens.noiseReductionEnabled' ? value : '');
    expect(settings().noiseReductionEnabled).toBe(false);
  });
  it('persists an opt-in and round-trips it through the host store', async () => {
    const storage = new Map<string, string>();
    await loadSettings(async () => '');
    await saveNoiseReductionEnabled(async (key, value) => { storage.set(key, value); return true; }, true);
    expect(storage.get('veritaslens.noiseReductionEnabled')).toBe('true');
    await loadSettings(async key => storage.get(key) ?? '');
    expect(settings().noiseReductionEnabled).toBe(true);
  });
  it('does not enable processing when persistence fails', async () => {
    await loadSettings(async () => '');
    expect(await saveNoiseReductionEnabled(async () => false, true)).toBe(false);
    expect(settings().noiseReductionEnabled).toBe(false);
  });
});
