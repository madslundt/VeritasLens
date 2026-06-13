import { requireNativeModule, type EventSubscription } from 'expo-modules-core';
import type { AudioRecordingStateEvent, AudioErrorEvent, AudioChunkEvent } from './ExpoBluetoothAudio.types';

type AudioEventName = 'onAudioState' | 'onAudioError' | 'onAudioChunk';

// In expo-modules-core 2.x the native module is a NativeModule which extends EventEmitter,
// so addListener is available on the native object itself.
export interface ExpoBluetoothAudioModule {
  startRecording(): Promise<void>;
  stopRecording(): Promise<void>;
  addListener(eventName: 'onAudioState', listener: (e: AudioRecordingStateEvent) => void): EventSubscription;
  addListener(eventName: 'onAudioError', listener: (e: AudioErrorEvent) => void): EventSubscription;
  addListener(eventName: 'onAudioChunk', listener: (e: AudioChunkEvent) => void): EventSubscription;
  addListener(eventName: AudioEventName, listener: (...args: unknown[]) => void): EventSubscription;
}

export default requireNativeModule<ExpoBluetoothAudioModule>('ExpoBluetoothAudioModule');
