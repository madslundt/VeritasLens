import { requireNativeModule, type EventSubscription } from 'expo-modules-core';
import type { CameraStateEvent, CameraErrorEvent, CameraTapEvent, CapturedFrame } from './ExpoMetaCamera.types';

type CameraEventName = 'onCameraState' | 'onCameraError' | 'onTap';

// In expo-modules-core 2.x the native module is a NativeModule which extends EventEmitter,
// so addListener is available on the native object itself.
export interface ExpoMetaCameraModule {
  startStream(): Promise<void>;
  stopStream(): Promise<void>;
  captureFrame(): Promise<CapturedFrame>;
  addListener(eventName: 'onCameraState', listener: (e: CameraStateEvent) => void): EventSubscription;
  addListener(eventName: 'onCameraError', listener: (e: CameraErrorEvent) => void): EventSubscription;
  addListener(eventName: 'onTap', listener: (e: CameraTapEvent) => void): EventSubscription;
  addListener(eventName: CameraEventName, listener: (...args: unknown[]) => void): EventSubscription;
}

export default requireNativeModule<ExpoMetaCameraModule>('ExpoMetaCameraModule');
