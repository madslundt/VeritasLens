// React Native cannot load the browser WASM models. Keep the shared VAD
// interface while using the local FFT fallback without bundling browser glue.
import { analyzeBufferForVoiceFFT, type VoiceBufferAnalysis } from '@/runtime/audioBuffer';

export type { VoiceBufferAnalysis } from '@/runtime/audioBuffer';

export async function warmupVAD(): Promise<void> {}

export async function analyzeBufferForVoice(
  pcm: Uint8Array,
  sampleRate: number,
  rmsFloor = 200,
): Promise<VoiceBufferAnalysis> {
  return analyzeBufferForVoiceFFT(pcm, sampleRate, rmsFloor);
}

export async function extractSpeechSegments(
  _pcm: Uint8Array,
  _sampleRate: number,
  _rmsFloor = 200,
): Promise<Array<{ start: number; end: number }> | null> {
  return null;
}

export function resetVADAvailability(): void {}
export const __resetVADAvailabilityForTests = resetVADAvailability;
