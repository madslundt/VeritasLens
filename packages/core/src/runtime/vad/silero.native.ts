// Preserve the public model-session API without pulling browser-only WASM
// into Metro. Native callers use the FFT implementation in index.native.ts.
import type { VoiceBufferAnalysis } from '@/runtime/audioBuffer';

let instance: SileroVADSession | null = null;

export function getSileroVAD(): SileroVADSession {
  return instance ??= new SileroVADSession();
}

export class SileroVADSession {
  init(): Promise<void> {
    return Promise.reject(new Error('Silero VAD is unavailable in React Native; use the FFT fallback.'));
  }

  async predict(_pcm: Uint8Array, _sampleRate: number, _rmsFloor = 200): Promise<VoiceBufferAnalysis> {
    await this.init();
    throw new Error('Silero VAD unavailable');
  }

  async extractSpeechSegments(
    _pcm: Uint8Array,
    _sampleRate: number,
    _rmsFloor = 200,
  ): Promise<Array<{ start: number; end: number }>> {
    await this.init();
    throw new Error('Silero VAD unavailable');
  }

  dispose(): void {}
  get isFailed(): boolean { return true; }
}

export function __resetSileroVADForTests(): void { instance = null; }
