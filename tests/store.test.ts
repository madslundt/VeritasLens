// tests/store.test.ts
//
// Behaviour-lock tests for src/state/store.ts.
// Captures current persistence semantics (HISTORY_BYTE_BUDGET trim, settings
// round-trip, debug-event ring) before the Pass 1+ cleanup. The memory-cap
// regression at the bottom is intentionally `.skip`-ed — it documents the
// post-Pass 1 behaviour and gets un-skipped when C1 lands.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clearDebugEvents,
  clearSessionHistory,
  debugEvents,
  loadHistory,
  loadSettings,
  pushDebugEvent,
  pushHistoryEntry,
  saveAutoSummaryEnabled,
  saveAutoSummaryInterval,
  saveBufferDuration,
  saveGeminiAutoModel,
  saveGeminiKey,
  saveGeminiModel,
  saveResponseLanguage,
  sessionHistory,
  settings,
} from '../src/state/store';
import { DEFAULT_BUFFER_DURATION, DEFAULT_GEMINI_AUTO_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_LANGUAGE } from '../src/types';
import type { HistoryEntry } from '../src/types';

const HISTORY_BYTE_BUDGET = 300 * 1024;

function fakeLocalStorage(): {
  get: (k: string) => Promise<string>;
  set: (k: string, v: string) => Promise<boolean>;
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? '',
    set: async (k, v) => { data.set(k, v); return true; },
  };
}

function fatEntry(i: number): Omit<HistoryEntry, 'id' | 'timestamp'> {
  // ~1 KB per entry — enough that ~400 entries breaches the 300 KB budget.
  const filler = 'x'.repeat(900);
  return {
    sessionId: `session-${i % 5}`,
    lensId: 'fact-checker',
    lensName: 'Fact Check',
    question: `claim ${i} ${filler}`,
    badge: 'TRUE',
    quote: '',
    result: { type: 'fact-check', claims: [{ quote: '', verdict: 'TRUE', claim: `claim ${i}`, reason: filler }] },
  };
}

beforeEach(() => {
  clearSessionHistory();
  clearDebugEvents();
});

describe('pushHistoryEntry', () => {
  it('appends entries with unique ids and timestamps', () => {
    pushHistoryEntry(fatEntry(0));
    pushHistoryEntry(fatEntry(1));
    const list = sessionHistory();
    expect(list.length).toBe(2);
    expect(list[0]!.id).not.toBe(list[1]!.id);
    expect(list[0]!.timestamp).toBeLessThanOrEqual(list[1]!.timestamp);
  });

  it('invokes setLs with the serialized history payload', async () => {
    const ls = fakeLocalStorage();
    pushHistoryEntry(fatEntry(0), ls.set);
    // setLs is fire-and-forget; give the microtask queue a tick to settle.
    await Promise.resolve();
    await Promise.resolve();
    const raw = ls.data.get('veritaslens.history');
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as HistoryEntry[];
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.lensId).toBe('fact-checker');
  });
});

describe('persistHistory trim semantics', () => {
  it('keeps the persisted JSON under HISTORY_BYTE_BUDGET when overflowing', async () => {
    const ls = fakeLocalStorage();
    for (let i = 0; i < 400; i++) {
      pushHistoryEntry(fatEntry(i), ls.set);
    }
    // Allow the chained async persistHistory calls to settle.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const raw = ls.data.get('veritaslens.history') ?? '[]';
    expect(raw.length).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET);
    const parsed = JSON.parse(raw) as HistoryEntry[];
    // Trim is from the head, so the tail (latest entries) survives.
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.at(-1)!.question).toContain('claim 399');
  }, 30_000);

  // Regression for B2: the prior `while (over) { keep *= 0.9; stringify; }` loop
  // could re-stringify the same payload 5+ times per write on uneven entry
  // distributions (e.g. a tail of large entries dragging the per-entry average
  // up after smaller entries get trimmed). The refactor caps stringify calls
  // per single persistHistory at <=3 so big-history writes stop causing GC
  // churn on constrained devices.
  it('caps JSON.stringify calls per persist write at 3 or fewer (uneven entries)', async () => {
    // 400 small in-memory + 50 fat at the tail. Total ~330 KB; first
    // ratio-based estimate trims to ~243 entries which still includes all
    // 50 fat (~250 KB) — the old loop would iterate many times shrinking
    // 10% at a time until only ~40 fat entries fit.
    for (let i = 0; i < 400; i++) {
      pushHistoryEntry({
        sessionId: 's', lensId: 'eli5', lensName: 'ELI5',
        question: 'q' + i, badge: 'ELI5', quote: '',
        result: { type: 'eli5', claims: [{ quote: '', explanation: 'short' }] },
      });
    }
    for (let i = 0; i < 50; i++) {
      pushHistoryEntry({
        sessionId: 's', lensId: 'eli5', lensName: 'ELI5',
        question: 'long ' + 'x'.repeat(200),
        badge: 'ELI5', quote: '',
        result: { type: 'eli5', claims: [{ quote: '', explanation: 'y'.repeat(4000) }] },
      });
    }
    const ls = fakeLocalStorage();
    // Spy AFTER the in-memory pushes so we only count the persist call below.
    const spy = vi.spyOn(JSON, 'stringify');
    pushHistoryEntry({
      sessionId: 's', lensId: 'eli5', lensName: 'ELI5',
      question: 'trigger persist', badge: 'ELI5', quote: '',
      result: { type: 'eli5', claims: [{ quote: '', explanation: 'z'.repeat(4000) }] },
    }, ls.set);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // persistHistory's calls have an array as the first arg (the entries list);
    // ignore the per-entry stringify calls Solid or test setup may make.
    const persistCalls = spy.mock.calls.filter((c) => Array.isArray(c[0]));
    spy.mockRestore();
    expect(persistCalls.length).toBeLessThanOrEqual(3);
  });

  // Regression for B2: an uneven distribution where the tail has bigger
  // entries than the average would underestimate the trim aggressiveness on
  // the first pass. The refactor must still land under budget by call 3.
  it('lands under budget even when tail entries are larger than average', async () => {
    const ls = fakeLocalStorage();
    // 400 small entries (~200 B) then 50 fat ones (~5 KB) at the tail.
    for (let i = 0; i < 400; i++) {
      pushHistoryEntry({
        sessionId: 's', lensId: 'eli5', lensName: 'ELI5',
        question: 'q' + i, badge: 'ELI5', quote: '',
        result: { type: 'eli5', claims: [{ quote: '', explanation: 'short' }] },
      });
    }
    for (let i = 0; i < 50; i++) {
      pushHistoryEntry({
        sessionId: 's', lensId: 'eli5', lensName: 'ELI5',
        question: 'long question ' + 'x'.repeat(200),
        badge: 'ELI5', quote: '',
        result: { type: 'eli5', claims: [{ quote: '', explanation: 'y'.repeat(4000) }] },
      });
    }
    pushHistoryEntry(fatEntry(999), ls.set);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const raw = ls.data.get('veritaslens.history') ?? '[]';
    expect(raw.length).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET);
  });
});

describe('clearSessionHistory', () => {
  it('empties the in-memory history and persists []', async () => {
    const ls = fakeLocalStorage();
    pushHistoryEntry(fatEntry(0), ls.set);
    clearSessionHistory(ls.set);
    expect(sessionHistory()).toEqual([]);
    await Promise.resolve();
    expect(ls.data.get('veritaslens.history')).toBe('[]');
  });
});

describe('loadSettings', () => {
  it('round-trips every persisted setting', async () => {
    const ls = fakeLocalStorage();
    await saveGeminiKey(ls.set, 'AIza-test-key-12345');
    await saveGeminiModel(ls.set, 'gemini-2.5-pro');
    await saveGeminiAutoModel(ls.set, 'gemini-2.0-flash-lite');
    await saveResponseLanguage(ls.set, 'da');
    await saveBufferDuration(ls.set, 120);
    await saveAutoSummaryEnabled(ls.set, true);
    await saveAutoSummaryInterval(ls.set, 5);

    await loadSettings(ls.get);
    const s = settings();
    expect(s.geminiApiKey).toBe('AIza-test-key-12345');
    expect(s.geminiModel).toBe('gemini-2.5-pro');
    expect(s.geminiAutoModel).toBe('gemini-2.0-flash-lite');
    expect(s.responseLanguage).toBe('da');
    expect(s.bufferDuration).toBe(120);
    expect(s.autoSummaryEnabled).toBe(true);
    expect(s.autoSummaryInterval).toBe(5);
  });

  it('returns defaults when storage throws', async () => {
    const broken = async (_k: string): Promise<string> => {
      throw new Error('storage unavailable');
    };
    await loadSettings(broken);
    const s = settings();
    expect(s.geminiApiKey).toBe('');
    expect(s.geminiModel).toBe(DEFAULT_GEMINI_MODEL);
    expect(s.geminiAutoModel).toBe(DEFAULT_GEMINI_AUTO_MODEL);
    expect(s.responseLanguage).toBe(DEFAULT_LANGUAGE);
    expect(s.bufferDuration).toBe(DEFAULT_BUFFER_DURATION);
    expect(s.autoSummaryEnabled).toBe(false);
  });

  it('coerces unknown values back to defaults per field', async () => {
    const ls = fakeLocalStorage();
    ls.data.set('veritaslens.geminiModel', 'not-a-model');
    ls.data.set('veritaslens.responseLanguage', 'klingon');
    ls.data.set('veritaslens.bufferDuration', '9999');
    ls.data.set('veritaslens.autoSummaryInterval', '17');
    await loadSettings(ls.get);
    const s = settings();
    expect(s.geminiModel).toBe(DEFAULT_GEMINI_MODEL);
    expect(s.responseLanguage).toBe(DEFAULT_LANGUAGE);
    expect(s.bufferDuration).toBe(DEFAULT_BUFFER_DURATION);
    expect(s.autoSummaryInterval).toBe(2);
  });
});

describe('loadHistory', () => {
  it('populates the signal from valid JSON', async () => {
    const ls = fakeLocalStorage();
    const entry: HistoryEntry = {
      id: 'a',
      timestamp: 1,
      sessionId: 's',
      lensId: 'trivia',
      lensName: 'Trivia',
      question: 'Q?',
      badge: 'ANSWER',
      quote: '',
      result: { type: 'trivia', claims: [{ quote: '', question: 'Q?', answer: 'A', description: 'D' }] },
    };
    ls.data.set('veritaslens.history', JSON.stringify([entry]));
    await loadHistory(ls.get);
    expect(sessionHistory()).toHaveLength(1);
    expect(sessionHistory()[0]!.id).toBe('a');
  });

  it('wraps a pre-0.5 flat fact-check entry into the new claims shape', async () => {
    const ls = fakeLocalStorage();
    const oldEntry = {
      id: 'a', timestamp: 1, sessionId: 's',
      lensId: 'fact-checker', lensName: 'Fact Check',
      question: 'old', badge: 'TRUE',
      // pre-0.5 shape: top-level verdict/claim/reason, no `claims`, no `quote`
      result: { type: 'fact-check', verdict: 'TRUE', claim: 'c0', reason: 'r0' },
    };
    ls.data.set('veritaslens.history', JSON.stringify([oldEntry]));
    await loadHistory(ls.get);
    const list = sessionHistory();
    expect(list).toHaveLength(1);
    expect(list[0]!.quote).toBe('');
    const r = list[0]!.result;
    expect(r.type).toBe('fact-check');
    if (r.type === 'fact-check') {
      expect(r.claims).toHaveLength(1);
      expect(r.claims[0]!.verdict).toBe('TRUE');
      expect(r.claims[0]!.claim).toBe('c0');
      expect(r.claims[0]!.reason).toBe('r0');
      expect(r.claims[0]!.quote).toBe('');
    }
  });

  it('wraps a pre-0.5 flat trivia entry into the new claims shape', async () => {
    const ls = fakeLocalStorage();
    const oldEntry = {
      id: 't', timestamp: 1, sessionId: 's',
      lensId: 'trivia', lensName: 'Trivia',
      question: 'Q', badge: 'ANSWER',
      result: { type: 'trivia', question: 'Q?', answer: 'A', description: 'D' },
    };
    ls.data.set('veritaslens.history', JSON.stringify([oldEntry]));
    await loadHistory(ls.get);
    const r = sessionHistory()[0]!.result;
    if (r.type === 'trivia') {
      expect(r.claims).toHaveLength(1);
      expect(r.claims[0]!.answer).toBe('A');
    }
  });

  it('wraps a pre-0.5 flat eli5 entry into the new claims shape', async () => {
    const ls = fakeLocalStorage();
    const oldEntry = {
      id: 'e', timestamp: 1, sessionId: 's',
      lensId: 'eli5', lensName: 'Simplify',
      question: 'jargon', badge: 'ELI5',
      result: { type: 'eli5', explanation: 'plain words' },
    };
    ls.data.set('veritaslens.history', JSON.stringify([oldEntry]));
    await loadHistory(ls.get);
    const r = sessionHistory()[0]!.result;
    if (r.type === 'eli5') {
      expect(r.claims).toHaveLength(1);
      expect(r.claims[0]!.explanation).toBe('plain words');
    }
  });

  it('drops corrupt entries without poisoning the rest', async () => {
    const ls = fakeLocalStorage();
    const good = {
      id: 'g', timestamp: 1, sessionId: 's',
      lensId: 'trivia', lensName: 'Trivia',
      question: 'Q', badge: 'ANSWER', quote: '',
      result: { type: 'trivia', claims: [{ quote: '', question: 'Q', answer: 'A', description: 'D' }] },
    };
    const corrupt = { id: 'x' /* missing result */ };
    const alsoBad = { id: 'y', result: { type: 'not-a-real-lens' } };
    ls.data.set('veritaslens.history', JSON.stringify([corrupt, good, alsoBad]));
    await loadHistory(ls.get);
    const list = sessionHistory();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('g');
  });

  it('leaves history empty on malformed JSON', async () => {
    const ls = fakeLocalStorage();
    ls.data.set('veritaslens.history', '{not json');
    await loadHistory(ls.get);
    expect(sessionHistory()).toEqual([]);
  });

  it('leaves history empty when storage returns empty string', async () => {
    const ls = fakeLocalStorage();
    await loadHistory(ls.get);
    expect(sessionHistory()).toEqual([]);
  });
});

describe('debugEvents ring', () => {
  it('keeps at most 40 most-recent entries, newest first', () => {
    for (let i = 0; i < 60; i++) pushDebugEvent({ label: 'tick', detail: String(i) });
    const list = debugEvents();
    expect(list.length).toBe(40);
    // newest first → entry with detail "59" should be at index 0
    expect(list[0]!.detail).toBe('59');
    expect(list[39]!.detail).toBe('20');
  });
});

describe('pushHistoryEntry — in-memory cap', () => {
  it('caps in-memory history at 500 entries even when 2000 are pushed', () => {
    for (let i = 0; i < 2000; i++) pushHistoryEntry(fatEntry(i));
    expect(sessionHistory().length).toBeLessThanOrEqual(500);
    // Newest entry must survive trimming.
    expect(sessionHistory().at(-1)!.question).toContain('claim 1999');
  });
});
