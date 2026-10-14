import { describe, expect, it } from 'vitest';
import {
  analyzeBufferForVoice,
  extractSpeechSegments,
  warmupVAD,
} from '../../core/src/runtime/vad/index.native';
import { getSileroVAD } from '../../core/src/runtime/vad/silero.native';

describe('native VAD fallback', () => {
  it('analyzes PCM locally and reports trimming as unavailable', async () => {
    await expect(warmupVAD()).resolves.toBeUndefined();
    const pcm = new Uint8Array(32_000);
    const result = await analyzeBufferForVoice(pcm, 16_000);
    expect(result.voiceFrames).toBe(0);
    expect(result.silenceFrames).toBeGreaterThan(0);
    await expect(extractSpeechSegments(pcm, 16_000)).resolves.toBeNull();
  });

  it('rejects explicit browser-model initialization on native', async () => {
    await expect(getSileroVAD().init()).rejects.toThrow('unavailable in React Native');
  });
});
