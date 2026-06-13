import { type EventSubscription } from 'expo-modules-core';
import ExpoMetaCameraModule from './ExpoMetaCameraModule';
import type {
  CameraStateEvent,
  CameraErrorEvent,
  CameraTapEvent,
  CapturedFrame,
  CameraState,
} from './ExpoMetaCamera.types';

export type { CameraStateEvent, CameraErrorEvent, CameraTapEvent, CapturedFrame, CameraState };

// In expo-modules-core 2.x the native module returned by requireNativeModule is already a
// NativeModule<TEventsMap> (which extends EventEmitter), so we can call addListener() directly.
// In the web/test path ExpoMetaCameraModule.web.ts exports an EventEmitter subclass, same API.

export function startStream(): Promise<void> {
  return ExpoMetaCameraModule.startStream();
}

export function stopStream(): Promise<void> {
  return ExpoMetaCameraModule.stopStream();
}

export function captureFrame(): Promise<CapturedFrame> {
  return ExpoMetaCameraModule.captureFrame();
}

export function addCameraStateListener(listener: (e: CameraStateEvent) => void): EventSubscription {
  return ExpoMetaCameraModule.addListener('onCameraState', listener);
}

export function addCameraErrorListener(listener: (e: CameraErrorEvent) => void): EventSubscription {
  return ExpoMetaCameraModule.addListener('onCameraError', listener);
}

export function addTapListener(listener: (e: CameraTapEvent) => void): EventSubscription {
  return ExpoMetaCameraModule.addListener('onTap', listener);
}
