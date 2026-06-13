import { addCameraStateListener, addTapListener, captureFrame, startStream, stopStream } from '../modules/expo-meta-camera';
import ExpoMetaCameraMock from '../modules/expo-meta-camera/ExpoMetaCameraModule.web';

describe('expo-meta-camera (mock)', () => {
  beforeEach(() => {
    // Reset between tests by stopping any previous stream.
    return stopStream();
  });

  it('emits connecting then streaming after startStream()', async () => {
    const states: string[] = [];
    const sub = addCameraStateListener((e) => states.push(e.state));

    await startStream();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(states).toEqual(['connecting', 'streaming']);
    sub.remove();
  });

  it('captureFrame returns a JPEG-shaped CapturedFrame while streaming', async () => {
    await startStream();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const frame = await captureFrame();
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBeGreaterThan(0);
    expect(typeof frame.data).toBe('string');
    expect(frame.data.length).toBeGreaterThan(0);
  });

  it('captureFrame rejects when not streaming', async () => {
    await stopStream();
    await expect(captureFrame()).rejects.toThrow();
  });

  it('emits tap events with monotonically increasing sequence', async () => {
    const sequences: number[] = [];
    const sub = addTapListener((e) => sequences.push(e.sequence));

    // Cast to the mock type to access __mockEmitTap.
    const mock = ExpoMetaCameraMock as unknown as { __mockEmitTap(): void };
    mock.__mockEmitTap();
    mock.__mockEmitTap();
    mock.__mockEmitTap();

    expect(sequences).toEqual([1, 2, 3]);
    sub.remove();
  });
});
