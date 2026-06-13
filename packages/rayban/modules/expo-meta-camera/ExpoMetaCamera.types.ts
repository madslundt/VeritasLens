/**
 * Connection state of the Meta DAT camera session.
 * - `disconnected`: no glasses connected, or DAT SDK reports unavailable
 * - `connecting`: pairing / initialising the camera session
 * - `streaming`: active video stream (frames available for capture)
 * - `error`: a non-recoverable error occurred (see CameraErrorEvent)
 */
export type CameraState = 'disconnected' | 'connecting' | 'streaming' | 'error';

export interface CameraStateEvent {
  state: CameraState;
}

export interface CameraErrorEvent {
  /** Stable error code; not localised. */
  code: 'sdk-unavailable' | 'permission-denied' | 'connection-lost' | 'unknown';
  /** Human-readable message for diagnostic display only. */
  message: string;
}

/**
 * Glasses button event. The Ray-Ban Meta capacitive surface emits
 * `tap` on a single press; longer interactions are not exposed in v1.
 */
export interface CameraTapEvent {
  /** Monotonically increasing integer for deduplication / ordering. */
  sequence: number;
}

export interface CapturedFrame {
  /** Base64-encoded JPEG bytes (no data: prefix). */
  data: string;
  /** Frame width in pixels (DAT SDK reports the active stream resolution). */
  width: number;
  /** Frame height in pixels. */
  height: number;
}
