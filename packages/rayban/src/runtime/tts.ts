import * as Speech from 'expo-speech';

const MAX_UTTERANCE_CHARS = 1000;

export interface SpeakOptions {
  /** Speech rate (0.5–2.0). Default 1.0. */
  rate: number;
  /** When false, the call is a no-op. Default true. */
  enabled?: boolean;
  /** Optional callback when speech finishes. */
  onDone?: () => void;
}

export function speak(text: string, opts: SpeakOptions): void {
  if (opts.enabled === false) return;
  if (!text) return;
  const utterance = text.length > MAX_UTTERANCE_CHARS ? text.slice(0, MAX_UTTERANCE_CHARS) : text;
  Speech.speak(utterance, {
    rate: opts.rate,
    onDone: opts.onDone,
    // expo-speech routes to the active audio session output. With AVAudioSession's
    // `.allowBluetooth` option set in ExpoBluetoothAudio (Plan 2 / Task 9), the
    // BT HFP route is active and TTS plays through the glasses speaker.
  });
}

export function stopSpeaking(): void {
  Speech.stop();
}

export async function isSpeaking(): Promise<boolean> {
  return Speech.isSpeakingAsync();
}
