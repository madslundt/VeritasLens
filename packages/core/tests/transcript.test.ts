// tests/transcript.test.ts
//
// Pure-data tests for the rolling transcript module. No provider mocking —
// `transcriptSource.ts` is the integration layer and gets its own tests once
// it's wired.

import { afterEach, describe, it, expect } from 'vitest';
import {
  TRANSCRIPT_MAX_AGE_MS,
  TRANSCRIPT_MAX_SEGMENTS,
  _resetTranscriptForTesting,
  appendSegment,
  currentSessionId,
  formatForPrompt,
  getRecent,
  resetTranscript,
  subscribe,
} from '../src/runtime/transcript';

afterEach(() => {
  _resetTranscriptForTesting();
});

describe('resetTranscript', () => {
  it('initializes a session and exposes its id', () => {
    resetTranscript('sess-1');
    expect(currentSessionId()).toBe('sess-1');
    expect(getRecent(10)).toHaveLength(0);
  });

  it('starting a new session drops prior segments', () => {
    resetTranscript('sess-1');
    appendSegment({ speaker: 'other', text: 'hello', startedAt: 0, endedAt: 1000 });
    expect(getRecent(10)).toHaveLength(1);

    resetTranscript('sess-2');
    expect(currentSessionId()).toBe('sess-2');
    expect(getRecent(10)).toHaveLength(0);
  });
});

describe('appendSegment', () => {
  it('returns null and is a no-op when no session is active', () => {
    const seg = appendSegment({ speaker: 'other', text: 'hi', startedAt: 0, endedAt: 100 });
    expect(seg).toBeNull();
    expect(getRecent(10)).toHaveLength(0);
  });

  it('trims whitespace and drops empty segments', () => {
    resetTranscript('sess');
    expect(appendSegment({ speaker: 'other', text: '   ', startedAt: 0, endedAt: 100 })).toBeNull();
    expect(appendSegment({ speaker: 'other', text: '  hello  ', startedAt: 100, endedAt: 200 })).not.toBeNull();
    expect(getRecent(10)[0]!.text).toBe('hello');
  });

  it('dedupes a same-speaker repeat within 2 seconds', () => {
    resetTranscript('sess');
    appendSegment({ speaker: 'other', text: 'hello', startedAt: 0, endedAt: 1000 });
    const dup = appendSegment({ speaker: 'other', text: 'hello', startedAt: 1500, endedAt: 2500 });
    expect(dup).toBeNull();
    expect(getRecent(10)).toHaveLength(1);
  });

  it('keeps a same-speaker repeat after 2 seconds', () => {
    resetTranscript('sess');
    appendSegment({ speaker: 'other', text: 'hello', startedAt: 0, endedAt: 1000 });
    const ok = appendSegment({ speaker: 'other', text: 'hello', startedAt: 3_000, endedAt: 4_000 });
    expect(ok).not.toBeNull();
    expect(getRecent(10)).toHaveLength(2);
  });

  it('keeps a same-text turn from a different speaker (do not dedupe across speakers)', () => {
    resetTranscript('sess');
    appendSegment({ speaker: 'wearer', text: 'okay', startedAt: 0, endedAt: 500 });
    const ok = appendSegment({ speaker: 'other', text: 'okay', startedAt: 600, endedAt: 1100 });
    expect(ok).not.toBeNull();
    expect(getRecent(10)).toHaveLength(2);
  });

  it('evicts segments older than TRANSCRIPT_MAX_AGE_MS', () => {
    resetTranscript('sess');
    appendSegment({ speaker: 'other', text: 'old', startedAt: 0, endedAt: 1000 });
    appendSegment({ speaker: 'other', text: 'recent', startedAt: TRANSCRIPT_MAX_AGE_MS + 5_000, endedAt: TRANSCRIPT_MAX_AGE_MS + 6_000 });

    const segs = getRecent(10);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe('recent');
  });

  it('caps the buffer at TRANSCRIPT_MAX_SEGMENTS', () => {
    resetTranscript('sess');
    for (let i = 0; i < TRANSCRIPT_MAX_SEGMENTS + 10; i++) {
      appendSegment({ speaker: 'other', text: `t${i}`, startedAt: i * 1_000, endedAt: i * 1_000 + 500 });
    }
    expect(getRecent(TRANSCRIPT_MAX_SEGMENTS + 100)).toHaveLength(TRANSCRIPT_MAX_SEGMENTS);
    // Oldest survivors are the ones immediately after the overflow line.
    const segs = getRecent(TRANSCRIPT_MAX_SEGMENTS);
    expect(segs[0]!.text).toBe('t10');
  });
});

describe('formatForPrompt', () => {
  it('returns the empty string when no session is active', () => {
    expect(formatForPrompt()).toBe('');
  });

  it('emits one `[speaker] text` line per segment', () => {
    resetTranscript('sess');
    appendSegment({ speaker: 'other', text: 'how are you', startedAt: 0, endedAt: 1000 });
    appendSegment({ speaker: 'wearer', text: 'good thanks', startedAt: 2000, endedAt: 3000 });
    expect(formatForPrompt()).toBe('[other] how are you\n[wearer] good thanks');
  });

  it('respects maxSegments by trimming oldest first', () => {
    resetTranscript('sess');
    appendSegment({ speaker: 'other', text: 'a', startedAt: 0, endedAt: 100 });
    appendSegment({ speaker: 'other', text: 'b', startedAt: 200, endedAt: 300 });
    appendSegment({ speaker: 'other', text: 'c', startedAt: 400, endedAt: 500 });
    expect(formatForPrompt({ maxSegments: 2 })).toBe('[other] b\n[other] c');
  });
});

describe('subscribe', () => {
  it('fires immediately with the current snapshot on registration', () => {
    resetTranscript('sess');
    appendSegment({ speaker: 'other', text: 'seeded', startedAt: 0, endedAt: 100 });

    const events: ReadonlyArray<{ text: string }>[] = [];
    subscribe((segs) => events.push(segs.map((s) => ({ text: s.text }))));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual([{ text: 'seeded' }]);
  });

  it('fires again on every append', () => {
    resetTranscript('sess');
    const events: number[] = [];
    subscribe((segs) => events.push(segs.length));

    appendSegment({ speaker: 'other', text: 'a', startedAt: 0, endedAt: 100 });
    appendSegment({ speaker: 'other', text: 'b', startedAt: 200, endedAt: 300 });

    // 1 immediate snapshot + 2 appends = 3 events.
    expect(events).toEqual([0, 1, 2]);
  });

  it('unsubscribe stops further notifications', () => {
    resetTranscript('sess');
    const events: number[] = [];
    const stop = subscribe((segs) => events.push(segs.length));

    appendSegment({ speaker: 'other', text: 'a', startedAt: 0, endedAt: 100 });
    stop();
    appendSegment({ speaker: 'other', text: 'b', startedAt: 200, endedAt: 300 });

    expect(events).toEqual([0, 1]);
  });

  it('a throwing subscriber does not poison the producer', () => {
    resetTranscript('sess');
    const seen: number[] = [];
    subscribe(() => { throw new Error('boom'); });
    subscribe((segs) => seen.push(segs.length));

    appendSegment({ speaker: 'other', text: 'a', startedAt: 0, endedAt: 100 });
    expect(seen).toContain(1);
  });
});
