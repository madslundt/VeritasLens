import { addAudioChunkListener, addAudioStateListener, startRecording, stopRecording } from '../modules/expo-bluetooth-audio';

describe('expo-bluetooth-audio (mock)', () => {
  afterEach(() => stopRecording());

  it('emits starting → recording on startRecording()', async () => {
    const states: string[] = [];
    const sub = addAudioStateListener((e) => states.push(e.state));

    await startRecording();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(states).toContain('starting');
    expect(states).toContain('recording');
    sub.remove();
  });

  it('emits audio chunks at ~10 Hz with 16 kHz sampleRate', async () => {
    const chunks: Array<{ sampleRate: number; sequence: number }> = [];
    const sub = addAudioChunkListener((e) => chunks.push({ sampleRate: e.sampleRate, sequence: e.sequence }));

    await startRecording();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await stopRecording();

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.sampleRate === 16_000)).toBe(true);
    expect(chunks[0].sequence).toBe(1);
    expect(chunks[chunks.length - 1].sequence).toBe(chunks.length);
    sub.remove();
  });

  it('emits idle on stopRecording()', async () => {
    const states: string[] = [];
    const sub = addAudioStateListener((e) => states.push(e.state));

    await startRecording();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await stopRecording();

    expect(states[states.length - 1]).toBe('idle');
    sub.remove();
  });
});
