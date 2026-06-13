import { EventEmitter } from 'expo-modules-core';
import type { AudioRecordingStateEvent, AudioErrorEvent, AudioChunkEvent } from './ExpoBluetoothAudio.types';

type AudioEvents = {
  onAudioState: (e: AudioRecordingStateEvent) => void;
  onAudioError: (e: AudioErrorEvent) => void;
  onAudioChunk: (e: AudioChunkEvent) => void;
};

/**
 * Mock audio module. Emits a synthetic 16 kHz PCM stream of silence in 100 ms chunks
 * (1600 samples × 2 bytes = 3200 bytes per chunk) once startRecording() is called.
 * Test code can stop the loop by calling stopRecording() or check sequence numbers.
 */
class ExpoBluetoothAudioMock extends EventEmitter<AudioEvents> {
  private timerId: ReturnType<typeof setInterval> | null = null;
  private sequence = 0;
  private static readonly SAMPLE_RATE = 16_000;
  private static readonly CHUNK_MS = 100;
  private static readonly BYTES_PER_CHUNK =
    (ExpoBluetoothAudioMock.SAMPLE_RATE * ExpoBluetoothAudioMock.CHUNK_MS) / 1000 * 2;

  async startRecording(): Promise<void> {
    if (this.timerId) return;
    this.emit('onAudioState', { state: 'starting' } satisfies AudioRecordingStateEvent);
    // Allow listeners to attach before recording state.
    setTimeout(() => {
      this.emit('onAudioState', { state: 'recording' } satisfies AudioRecordingStateEvent);
      // 3200 bytes of zero == 100 ms of 16 kHz silence.
      const silentBase64 = 'A'.repeat(Math.ceil(ExpoBluetoothAudioMock.BYTES_PER_CHUNK / 3) * 4);
      this.timerId = setInterval(() => {
        this.sequence += 1;
        this.emit('onAudioChunk', {
          pcm: silentBase64,
          sampleRate: ExpoBluetoothAudioMock.SAMPLE_RATE,
          sequence: this.sequence,
        } satisfies AudioChunkEvent);
      }, ExpoBluetoothAudioMock.CHUNK_MS);
    }, 30);
  }

  async stopRecording(): Promise<void> {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.emit('onAudioState', { state: 'idle' } satisfies AudioRecordingStateEvent);
  }

  /** Test-only: simulate an error mid-recording. */
  __mockEmitError(code: AudioErrorEvent['code'], message: string): void {
    this.emit('onAudioError', { code, message } satisfies AudioErrorEvent);
  }
}

export default new ExpoBluetoothAudioMock();
