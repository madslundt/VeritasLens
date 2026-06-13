import { EventEmitter } from 'expo-modules-core';
import type { CameraStateEvent, CameraErrorEvent, CameraTapEvent, CapturedFrame } from './ExpoMetaCamera.types';

type CameraEvents = {
  onCameraState: (e: CameraStateEvent) => void;
  onCameraError: (e: CameraErrorEvent) => void;
  onTap: (e: CameraTapEvent) => void;
};

/**
 * Mock native module. Used on web and in non-device test environments.
 * Emits a `connecting` → `streaming` transition shortly after startStream(),
 * then provides synthetic frames (a 1×1 grey JPEG) on captureFrame().
 *
 * Tap events can be triggered from test code via __mockEmitTap() — see tests.
 */
class ExpoMetaCameraMock extends EventEmitter<CameraEvents> {
  private streaming = false;
  private tapSequence = 0;

  async startStream(): Promise<void> {
    this.emit('onCameraState', { state: 'connecting' } satisfies CameraStateEvent);
    this.streaming = true;
    // Defer streaming state so callers can subscribe before the event fires.
    setTimeout(() => {
      if (this.streaming) {
        this.emit('onCameraState', { state: 'streaming' } satisfies CameraStateEvent);
      }
    }, 50);
  }

  async stopStream(): Promise<void> {
    this.streaming = false;
    this.emit('onCameraState', { state: 'disconnected' } satisfies CameraStateEvent);
  }

  async captureFrame(): Promise<CapturedFrame> {
    if (!this.streaming) {
      const err: CameraErrorEvent = { code: 'connection-lost', message: 'mock: not streaming' };
      this.emit('onCameraError', err);
      throw new Error(err.message);
    }
    // Single grey pixel JPEG (smallest valid JPEG payload).
    return {
      data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wgARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhADEAAAAR//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAn//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/An//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==',
      width: 1,
      height: 1,
    };
  }

  /** Test-only: simulate a glasses-button tap. */
  __mockEmitTap(): void {
    this.tapSequence += 1;
    this.emit('onTap', { sequence: this.tapSequence } satisfies CameraTapEvent);
  }
}

export default new ExpoMetaCameraMock();
