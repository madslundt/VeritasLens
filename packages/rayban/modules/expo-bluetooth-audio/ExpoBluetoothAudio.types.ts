/**
 * Recording state for the BT-HFP-routed microphone.
 * `unavailable` means no HFP device is connected or HFP route cannot be acquired.
 */
export type AudioRecordingState = 'idle' | 'starting' | 'recording' | 'unavailable' | 'error';

export interface AudioRecordingStateEvent {
  state: AudioRecordingState;
}

/**
 * Emitted continuously while recording. PCM is signed 16-bit, little-endian, mono.
 *
 * `sampleRate` reports the OS-negotiated rate:
 * - 16000 when mSBC (wideband) is active
 * - 8000 when CVSD (narrowband) is the only available codec
 *
 * Consumers must size their ring buffer using this rate, NOT a hardcoded 16000.
 */
export interface AudioChunkEvent {
  /** Base64-encoded raw PCM bytes (no header, no metadata). */
  pcm: string;
  /** Effective sample rate in Hz (8000 or 16000). */
  sampleRate: number;
  /** Sequential chunk number; monotonically increasing per recording session. */
  sequence: number;
}

export interface AudioErrorEvent {
  code: 'permission-denied' | 'no-hfp-route' | 'session-interrupted' | 'unknown';
  message: string;
}
