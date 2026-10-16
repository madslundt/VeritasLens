import { encodeWavToFlac } from '@/runtime/flac';
import { throwIfAborted } from '@/llm/fetchTimeout';
import { pushDebugEvent } from '@/state/store';

export interface AudioUpload {
  bytes: Uint8Array;
  format: 'wav' | 'flac';
}

/** Call only for audio endpoints that accept FLAC, never chat-only endpoints. */
export async function prepareAudioUpload(
  wav: Uint8Array,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<AudioUpload> {
  throwIfAborted(signal);
  const startedAt = performance.now();
  const flac = enabled ? await encodeWavToFlac(wav, signal) : null;
  throwIfAborted(signal);
  const audio: AudioUpload = { bytes: flac ?? wav, format: flac ? 'flac' : 'wav' };
  pushDebugEvent({ label: 'audio-upload', detail: `${audio.format.toUpperCase()} | ` +
    `${Math.round(wav.length / 1024)}KB → ${Math.round(audio.bytes.length / 1024)}KB | ` +
    `encode=${Math.round(performance.now() - startedAt)}ms` });
  return audio;
}
