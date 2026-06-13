import { serializeHistory, deserializeHistory } from '@/runtime/history';
import type { HistoryEntry } from '@/types';

function makeEntry(id: string): HistoryEntry {
  return {
    id,
    sessionId: 'sess-1',
    timestamp: Date.now(),
    lensId: 'fact-check',
    lensName: 'Fact Check',
    question: 'q',
    badge: 'b',
    quote: '',
    result: { type: 'fact-check', claims: [] },
  };
}

describe('serializeHistory', () => {
  it('returns JSON string of all entries when under budget', () => {
    const entries = [makeEntry('1'), makeEntry('2')];
    const json = serializeHistory(entries, { byteBudget: 1_000_000, maxEntries: 500 });
    expect(JSON.parse(json)).toHaveLength(2);
  });

  it('trims oldest entries first when over maxEntries', () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(String(i)));
    const json = serializeHistory(entries, { byteBudget: 1_000_000, maxEntries: 5 });
    const parsed = JSON.parse(json) as HistoryEntry[];
    expect(parsed).toHaveLength(5);
    expect(parsed[0].id).toBe('5');
  });

  it('preserves single oversized entry even when over byte budget', () => {
    const bigEntry = makeEntry('big');
    (bigEntry as unknown as Record<string, unknown>)['result'] = { type: 'fact-check', claims: [{ text: 'x'.repeat(5000) }] };
    const entries = [bigEntry];
    const json = serializeHistory(entries, { byteBudget: 100, maxEntries: 500 });
    expect(JSON.parse(json)).toHaveLength(1);
  });
});

describe('deserializeHistory', () => {
  it('returns empty array for invalid JSON', () => {
    expect(deserializeHistory('not json')).toEqual([]);
  });

  it('returns empty array for null/undefined input', () => {
    expect(deserializeHistory(null)).toEqual([]);
    expect(deserializeHistory(undefined)).toEqual([]);
  });

  it('round-trips entries through serialize/deserialize', () => {
    const entries = [makeEntry('1'), makeEntry('2')];
    const json = serializeHistory(entries, { byteBudget: 1_000_000, maxEntries: 500 });
    const parsed = deserializeHistory(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('1');
  });
});
