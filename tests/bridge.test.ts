// tests/bridge.test.ts
//
// Behaviour-lock for the audio-message filter in src/runtime/bridge.ts.
// The filter runs on every host->web message so a regression would either
// flood the debug log (false negatives) or silently swallow non-audio events
// the user is trying to debug (false positives).

import { describe, it, expect } from 'vitest';
import { isAudioMessage } from '../src/runtime/bridge';

describe('isAudioMessage', () => {
  it('matches the snake_case audio types we know about', () => {
    expect(isAudioMessage({ data: { type: 'audio_pcm' } })).toBe(true);
    expect(isAudioMessage({ data: { type: 'audio_event' } })).toBe(true);
    expect(isAudioMessage({ data: { type: 'audio' } })).toBe(true);
  });

  it('matches camelCase audio types', () => {
    expect(isAudioMessage({ data: { type: 'audioFrame' } })).toBe(true);
    expect(isAudioMessage({ data: { type: 'audioEvent' } })).toBe(true);
  });

  it('matches array-form data heads', () => {
    expect(isAudioMessage({ data: ['audio_pcm', /* ...samples */] })).toBe(true);
    expect(isAudioMessage({ data: ['audioFrame', 1, 2] })).toBe(true);
  });

  it('detects via the serialized-payload fallback when type is nested', () => {
    // A wrapper message where data.type isn't on the top-level data object
    // but the JSON still mentions an audio_pcm field somewhere in the head.
    expect(isAudioMessage({ method: 'foo', payload: { audio_pcm: 'base64...' } })).toBe(true);
    expect(isAudioMessage({ method: 'foo', payload: { audio_event: 'x' } })).toBe(true);
  });

  it('does not match substrings that merely contain the word "audio"', () => {
    // Regression for the prior /audio/i regex: a non-audio message with the
    // word "audio" embedded in a URL or unrelated field MUST NOT be filtered.
    expect(isAudioMessage({ data: { type: 'videoFrame', url: '/audio/track.mp3' } })).toBe(false);
    expect(isAudioMessage({ data: { type: 'audiophile' } })).toBe(false);
    expect(isAudioMessage({ data: { type: 'studioaudio' } })).toBe(false);
  });

  it('returns false for non-object / null inputs', () => {
    expect(isAudioMessage(null)).toBe(false);
    expect(isAudioMessage(undefined)).toBe(false);
    expect(isAudioMessage('audio_pcm')).toBe(false);
    expect(isAudioMessage(42)).toBe(false);
  });

  it('returns false for messages with no audio reference', () => {
    expect(isAudioMessage({ method: 'click', data: { type: 'sys' } })).toBe(false);
    expect(isAudioMessage({ data: { type: 'gesture' } })).toBe(false);
    expect(isAudioMessage({})).toBe(false);
  });

  it('survives cyclic structures without throwing', () => {
    const cyclic: Record<string, unknown> = { data: { type: 'gesture' } };
    cyclic['self'] = cyclic;
    expect(() => isAudioMessage(cyclic)).not.toThrow();
    expect(isAudioMessage(cyclic)).toBe(false);
  });
});
