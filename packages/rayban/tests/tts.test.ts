import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('expo-speech', () => ({
  speak: vi.fn(),
  stop: vi.fn(),
  isSpeakingAsync: vi.fn().mockResolvedValue(false),
}));

import * as Speech from 'expo-speech';
import { speak, stopSpeaking } from '../src/runtime/tts';

describe('tts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls Speech.speak with text and rate', () => {
    speak('Hello world', { rate: 1.2 });
    expect(Speech.speak).toHaveBeenCalledWith('Hello world', expect.objectContaining({ rate: 1.2 }));
  });

  it('skips when ttsEnabled=false', () => {
    speak('Hello world', { rate: 1.0, enabled: false });
    expect(Speech.speak).not.toHaveBeenCalled();
  });

  it('stopSpeaking calls Speech.stop', () => {
    stopSpeaking();
    expect(Speech.stop).toHaveBeenCalled();
  });

  it('truncates extremely long text', () => {
    const longText = 'a'.repeat(2000);
    speak(longText, { rate: 1.0 });
    const call = (Speech.speak as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0].length).toBeLessThanOrEqual(1000);
  });
});
