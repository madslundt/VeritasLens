// tests/recallContext.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildRecallContextLines,
  RECALL_CONTEXT_MAX_CHARS,
} from '../src/runtime/recallContext';

describe('buildRecallContextLines', () => {
  it('returns [] when disabled, regardless of summaries', () => {
    expect(buildRecallContextLines([{ summary: 'something' }], false)).toEqual([]);
  });

  it('returns [] when enabled but there are no summaries', () => {
    expect(buildRecallContextLines([], true)).toEqual([]);
  });

  it('emits at most maxEntries entries, keeping the most recent ones', () => {
    const summaries = [
      { title: 'A', summary: 'first' },
      { title: 'B', summary: 'second' },
      { title: 'C', summary: 'third' },
      { title: 'D', summary: 'fourth' },
    ];
    const out = buildRecallContextLines(summaries, true, 2);
    // Last 2 entries (C, D) survive; oldest (A, B) are dropped.
    expect(out).toEqual(['- C: third', '- D: fourth']);
  });

  it('formats entries with title prefix when present, plain bullet otherwise', () => {
    const out = buildRecallContextLines(
      [
        { summary: 'no-title body' },
        { title: 'With Title', summary: 'titled body' },
      ],
      true,
    );
    expect(out).toEqual(['- no-title body', '- With Title: titled body']);
  });

  it('skips empty / whitespace-only summaries', () => {
    const out = buildRecallContextLines(
      [{ summary: '   ' }, { title: 'Real', summary: 'real body' }],
      true,
    );
    expect(out).toEqual(['- Real: real body']);
  });

  it('trims oldest first when the char cap is exceeded', () => {
    const long = 'x'.repeat(2000);
    const summaries = [
      { title: 'oldest', summary: long }, // ~2010 chars
      { title: 'newest', summary: long }, // ~2010 chars
    ];
    const out = buildRecallContextLines(summaries, true, 2, RECALL_CONTEXT_MAX_CHARS);
    // 2 × ~2010 > 2400 → only the newest entry fits.
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('newest');
    expect(out[0]).not.toContain('oldest');
  });

  it('returns [] when even the most recent single entry exceeds the cap', () => {
    const huge = { title: 'huge', summary: 'x'.repeat(10_000) };
    expect(buildRecallContextLines([huge], true, 2, RECALL_CONTEXT_MAX_CHARS)).toEqual([]);
  });
});
