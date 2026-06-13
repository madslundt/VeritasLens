import { type EventSubscription } from 'expo-modules-core';
import ExpoBluetoothAudioModule from './ExpoBluetoothAudioModule';
import type {
  AudioRecordingStateEvent,
  AudioErrorEvent,
  AudioChunkEvent,
  AudioRecordingState,
} from './ExpoBluetoothAudio.types';

export type { AudioRecordingStateEvent, AudioErrorEvent, AudioChunkEvent, AudioRecordingState };

// In expo-modules-core 2.x the native module returned by requireNativeModule is already a
// NativeModule<TEventsMap> (which extends EventEmitter), so we can call addListener() directly.
// In the web/test path ExpoBluetoothAudioModule.web.ts exports an EventEmitter subclass, same API.

export function startRecording(): Promise<void> {
  return ExpoBluetoothAudioModule.startRecording();
}

export function stopRecording(): Promise<void> {
  return ExpoBluetoothAudioModule.stopRecording();
}

export function addAudioStateListener(listener: (e: AudioRecordingStateEvent) => void): EventSubscription {
  return ExpoBluetoothAudioModule.addListener('onAudioState', listener);
}

export function addAudioErrorListener(listener: (e: AudioErrorEvent) => void): EventSubscription {
  return ExpoBluetoothAudioModule.addListener('onAudioError', listener);
}

export function addAudioChunkListener(listener: (e: AudioChunkEvent) => void): EventSubscription {
  return ExpoBluetoothAudioModule.addListener('onAudioChunk', listener);
}
