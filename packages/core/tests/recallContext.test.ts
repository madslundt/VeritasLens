// tests/recallContext.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildRecallContextLines,
  extractPriorSessionSummaries,
  RECALL_CONTEXT_MAX_CHARS,
  type PriorHistoryEntry,
} from '../src/runtime/recallContext';

const sessionSummary = (
  sessionId: string,
  summary: string,
  title?: string,
): PriorHistoryEntry => ({
  sessionId,
  result: { type: 'session-summary', summary, title },
});

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

describe('extractPriorSessionSummaries', () => {
  it('returns [] when history is empty', () => {
    expect(extractPriorSessionSummaries([])).toEqual([]);
  });

  it('returns [] when no session-summary rows exist', () => {
    const history: PriorHistoryEntry[] = [
      { sessionId: 's1', result: { type: 'fact-check', summary: 'ignored' } },
      { sessionId: 's1', result: { type: 'trivia', summary: 'ignored too' } },
    ];
    expect(extractPriorSessionSummaries(history)).toEqual([]);
  });

  it('keeps only the most recent N session summaries, oldest-first', () => {
    const history: PriorHistoryEntry[] = [
      sessionSummary('s1', 'first', 'A'),
      sessionSummary('s2', 'second', 'B'),
      sessionSummary('s3', 'third', 'C'),
      sessionSummary('s4', 'fourth', 'D'),
    ];
    // Default max = 2 → last two sessions, in chronological order.
    expect(extractPriorSessionSummaries(history)).toEqual([
      { title: 'C', summary: 'third' },
      { title: 'D', summary: 'fourth' },
    ]);
  });

  it('dedupes by sessionId so an auto-summary + final-summary pair counts once', () => {
    const history: PriorHistoryEntry[] = [
      sessionSummary('s1', 'old session'),
      // Same session — both auto-summary mid-session and final summary land
      // here under session-summary type. Only the newest entry per session
      // should count toward the max.
      sessionSummary('s2', 'mid tick'),
      sessionSummary('s2', 'final'),
    ];
    const out = extractPriorSessionSummaries(history, 2);
    // Two unique sessions surviving: s1's "old session" and s2's "final"
    // (the newest s2 row, walked newest-first).
    expect(out).toEqual([
      { summary: 'old session' },
      { summary: 'final' },
    ]);
  });

  it('skips empty / whitespace-only summary bodies', () => {
    const history: PriorHistoryEntry[] = [
      sessionSummary('s1', '   '),
      sessionSummary('s2', 'real body'),
    ];
    expect(extractPriorSessionSummaries(history)).toEqual([
      { summary: 'real body' },
    ]);
  });

  it('returns [] when max is 0', () => {
    const history = [sessionSummary('s1', 'body')];
    expect(extractPriorSessionSummaries(history, 0)).toEqual([]);
  });

  it('omits the title field when title is missing or empty', () => {
    const history: PriorHistoryEntry[] = [
      sessionSummary('s1', 'no title here'),
      sessionSummary('s2', 'empty title', '   '),
    ];
    const out = extractPriorSessionSummaries(history);
    expect(out).toEqual([
      { summary: 'no title here' },
      { summary: 'empty title' },
    ]);
    expect(out[0]!.title).toBeUndefined();
    expect(out[1]!.title).toBeUndefined();
  });
});
