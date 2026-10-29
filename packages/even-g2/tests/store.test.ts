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
  deleteHistorySession,
  loadHistory,
  loadSettings,
  pushDebugEvent,
  pushHistoryEntry,
  updateHistoryEntry,
  saveConversationPreferences,
  saveAutoSummaryEnabled,
  saveAudioCompressionEnabled,
  saveBufferDuration,
  saveMicSource,
  saveTranscriptMode,
  saveGeminiAutoModel,
  saveGeminiKey,
  saveGeminiModel,
  saveResponseLanguage,
  sessionHistory,
  settings,
} from '../src/state/store';
import { CONVERSATION_KEY, DEFAULT_CONVERSATION, DEFAULT_BUFFER_DURATION, DEFAULT_GEMINI_AUTO_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_LANGUAGE, DEFAULT_MIC_SOURCE } from '@veritaslens/core';
import type { HistoryEntry } from '@veritaslens/core';

const HISTORY_BYTE_BUDGET = 400 * 1024;

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
    await Promise.all(Array.from({ length: 400 }, (_, i) => pushHistoryEntry(fatEntry(i), ls.set)));
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
    await clearSessionHistory(ls.set);
    expect(sessionHistory()).toEqual([]);
    await Promise.resolve();
    expect(ls.data.get('veritaslens.history')).toBe('[]');
  });
});

describe('deleteHistorySession', () => {
  it('removes only entries with the matching sessionId', async () => {
    // fatEntry uses `session-${i % 5}` so we get sessions 0..4.
    for (let i = 0; i < 10; i++) await pushHistoryEntry(fatEntry(i));
    expect(sessionHistory().length).toBe(10);
    await deleteHistorySession('session-2');
    const remaining = sessionHistory();
    expect(remaining.length).toBe(8);
    expect(remaining.every((e) => e.sessionId !== 'session-2')).toBe(true);
    // Other sessions are untouched.
    expect(remaining.filter((e) => e.sessionId === 'session-0').length).toBe(2);
  });

  it('persists the filtered list via the provided setLs', async () => {
    const ls = fakeLocalStorage();
    for (let i = 0; i < 4; i++) await pushHistoryEntry(fatEntry(i), ls.set);
    await deleteHistorySession('session-1', ls.set);
    const raw = ls.data.get('veritaslens.history') ?? '[]';
    const parsed = JSON.parse(raw) as HistoryEntry[];
    expect(parsed.every((e) => e.sessionId !== 'session-1')).toBe(true);
    expect(parsed.length).toBe(sessionHistory().length);
  });

  it('is a no-op when no entries match', async () => {
    const ls = fakeLocalStorage();
    for (let i = 0; i < 3; i++) await pushHistoryEntry(fatEntry(i), ls.set);
    const before = sessionHistory().length;
    await deleteHistorySession('session-does-not-exist', ls.set);
    expect(sessionHistory().length).toBe(before);
  });
});

describe('history deletion failures', () => {
  it.each(['clear', 'session'] as const)('rolls back a failed %s deletion and allows a retry', async action => {
    const ls = fakeLocalStorage();
    await pushHistoryEntry(fatEntry(0), ls.set);
    await pushHistoryEntry(fatEntry(1), ls.set);
    const previous = sessionHistory();
    const remove = (write: (key: string, value: string) => Promise<boolean>) => action === 'clear'
      ? clearSessionHistory(write) : deleteHistorySession('session-0', write);
    await expect(remove(async () => false)).rejects.toThrow('Could not save');
    expect(sessionHistory()).toBe(previous);
    await expect(remove(async () => { throw new Error('Storage unavailable'); })).rejects.toThrow('Storage unavailable');
    expect(sessionHistory()).toBe(previous);
    await remove(ls.set);
    expect(sessionHistory().map(entry => entry.sessionId)).toEqual(action === 'clear' ? [] : ['session-1']);
    expect(JSON.parse(ls.data.get('veritaslens.history')!)).toEqual(sessionHistory());
  });

  it.each(['clear', 'session'] as const)('does not erase newer analysis during failed %s rollback', async action => {
    const ls = fakeLocalStorage();
    await pushHistoryEntry(fatEntry(0), ls.set);
    let release!: (ok: boolean) => void;
    const write = () => new Promise<boolean>(resolve => { release = resolve; });
    const deleting = action === 'clear' ? clearSessionHistory(write) : deleteHistorySession('session-0', write);
    const rejected = expect(deleting).rejects.toThrow('Could not save');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const appending = pushHistoryEntry(fatEntry(1), ls.set);
    release(false); await Promise.all([rejected, appending]);
    expect(sessionHistory().map(entry => entry.sessionId)).toEqual(['session-1']);
    expect(JSON.parse(ls.data.get('veritaslens.history')!)).toEqual(sessionHistory());
  });
});

describe('loadSettings', () => {
  it('round-trips every persisted setting', async () => {
    const ls = fakeLocalStorage();
    await saveGeminiKey(ls.set, 'AIza-test-key-12345');
    await saveGeminiModel(ls.set, 'gemini-2.5-pro');
    await saveGeminiAutoModel(ls.set, 'gemini-2.5-flash');
    await saveResponseLanguage(ls.set, 'da');
    await saveBufferDuration(ls.set, 120);
    await saveMicSource(ls.set, 'phone');
    await saveAutoSummaryEnabled(ls.set, true);

    await loadSettings(ls.get);
    const s = settings();
    expect(s.geminiApiKey).toBe('AIza-test-key-12345');
    expect(s.geminiModel).toBe('gemini-2.5-pro');
    expect(s.geminiAutoModel).toBe('gemini-2.5-flash');
    expect(s.responseLanguage).toBe('da');
    expect(s.bufferDuration).toBe(120);
    expect(s.micSource).toBe('phone');
    expect(s.autoSummaryEnabled).toBe(true);
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
    expect(s.micSource).toBe(DEFAULT_MIC_SOURCE);
    expect(s.autoSummaryEnabled).toBe(false);
    expect(s.audioCompressionEnabled).toBe(true);
  });

  it('coerces unknown values back to defaults per field', async () => {
    const ls = fakeLocalStorage();
    ls.data.set('veritaslens.geminiModel', 'not-a-model');
    ls.data.set('veritaslens.responseLanguage', 'klingon');
    ls.data.set('veritaslens.bufferDuration', '9999');
    ls.data.set('veritaslens.micSource', 'telepathy');
    await loadSettings(ls.get);
    const s = settings();
    expect(s.geminiModel).toBe(DEFAULT_GEMINI_MODEL);
    expect(s.responseLanguage).toBe(DEFAULT_LANGUAGE);
    expect(s.bufferDuration).toBe(DEFAULT_BUFFER_DURATION);
    // Garbage mic source falls back to the glasses default.
    expect(s.micSource).toBe('glasses');
  });

  it("defaults micSource to glasses when storage is empty", async () => {
    const ls = fakeLocalStorage();
    await loadSettings(ls.get);
    expect(settings().micSource).toBe('glasses');
  });

  it('defaults audio upload compression on when the setting is missing or invalid', async () => {
    const ls = fakeLocalStorage();
    await loadSettings(ls.get);
    expect(settings().audioCompressionEnabled).toBe(true);
    ls.data.set('veritaslens.audioCompressionEnabled', 'invalid');
    await loadSettings(ls.get);
    expect(settings().audioCompressionEnabled).toBe(true);
  });

  it.each([false, true])('persists audio upload compression=%s across reloads', async (enabled) => {
    const ls = fakeLocalStorage();
    expect(await saveAudioCompressionEnabled(ls.set, enabled)).toBe(true);
    expect(ls.data.get('veritaslens.audioCompressionEnabled')).toBe(String(enabled));
    expect(settings().audioCompressionEnabled).toBe(enabled);
    await loadSettings(async () => '');
    await loadSettings(ls.get);
    expect(settings().audioCompressionEnabled).toBe(enabled);
  });

  it('keeps the active compression preference when saving fails', async () => {
    await loadSettings(async () => '');
    expect(await saveAudioCompressionEnabled(async () => false, false)).toBe(false);
    expect(settings().audioCompressionEnabled).toBe(true);
  });

  it('clamps a persisted 600s buffer duration from 0.6.x down to the new 300s cap', async () => {
    const ls = fakeLocalStorage();
    ls.data.set('veritaslens.bufferDuration', '600');
    await loadSettings(ls.get);
    expect(settings().bufferDuration).toBe(300);
  });

  it("defaults transcriptMode to 'on' when storage is empty (capture + inject, no HUD verify)", async () => {
    const ls = fakeLocalStorage();
    await loadSettings(ls.get);
    expect(settings().transcriptMode).toBe('on');
  });

  it("round-trips transcriptMode='off' through save → load", async () => {
    const ls = fakeLocalStorage();
    await saveTranscriptMode(ls.set, 'off');
    await loadSettings(ls.get);
    expect(settings().transcriptMode).toBe('off');
  });

  it("migrates legacy transcriptEnabled='false' to transcriptMode='off' on read", async () => {
    const ls = fakeLocalStorage();
    ls.data.set('veritaslens.transcriptEnabled', 'false');
    await loadSettings(ls.get);
    expect(settings().transcriptMode).toBe('off');
  });

  it("collapses a stored 'on-verify' value to 'on' (legacy three-state value, verify-flash retired)", async () => {
    const ls = fakeLocalStorage();
    ls.data.set('veritaslens.transcriptMode', 'on-verify');
    await loadSettings(ls.get);
    expect(settings().transcriptMode).toBe('on');
  });

  it("prefers the new transcriptMode key over the legacy transcriptEnabled when both are set", async () => {
    const ls = fakeLocalStorage();
    ls.data.set('veritaslens.transcriptMode', 'off');
    ls.data.set('veritaslens.transcriptEnabled', 'true');
    await loadSettings(ls.get);
    expect(settings().transcriptMode).toBe('off');
  });
});

describe('loadHistory', () => {
  it('does not restore entries deleted while a storage read was pending', async () => {
    const ls = fakeLocalStorage();
    await pushHistoryEntry(fatEntry(0), ls.set);
    const snapshot = ls.data.get('veritaslens.history')!;
    let release!: (raw: string) => void;
    const loading = loadHistory(() => new Promise<string>(resolve => { release = resolve; }));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await clearSessionHistory(ls.set);
    release(snapshot); await loading;
    expect(sessionHistory()).toEqual([]);
  });

  it('preserves a newer analysis when an older storage read completes', async () => {
    const ls = fakeLocalStorage();
    await pushHistoryEntry(fatEntry(0), ls.set);
    const snapshot = ls.data.get('veritaslens.history')!;
    let release!: (raw: string) => void;
    const loading = loadHistory(() => new Promise<string>(resolve => { release = resolve; }));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await pushHistoryEntry(fatEntry(1), ls.set);
    release(snapshot); await loading;
    await pushHistoryEntry(fatEntry(2), ls.set);
    expect((JSON.parse(ls.data.get('veritaslens.history')!) as HistoryEntry[]).map(entry => entry.sessionId))
      .toEqual(['session-0', 'session-1', 'session-2']);
  });

  it('ignores an older read that completes after a newer read', async () => {
    let release!: (raw: string) => void;
    const older = loadHistory(() => new Promise<string>(resolve => { release = resolve; }));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const newest = { ...fatEntry(1), id: 'newest', timestamp: 1 };
    await loadHistory(async () => JSON.stringify([newest]));
    release(JSON.stringify([{ ...fatEntry(0), id: 'older', timestamp: 0 }])); await older;
    expect(sessionHistory().map(entry => entry.id)).toEqual(['newest']);
  });

  it('waits for pending history writes before reading their persisted snapshot', async () => {
    const ls = fakeLocalStorage();
    await pushHistoryEntry(fatEntry(0), ls.set);
    let release!: () => void;
    const writing = pushHistoryEntry(fatEntry(1), async (key, value) => {
      await new Promise<void>(resolve => { release = resolve; });
      return ls.set(key, value);
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const read = vi.fn(ls.get);
    const loading = loadHistory(read);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const readWhileWriting = read.mock.calls.length;
    release(); await Promise.all([writing, loading]);
    expect(readWhileWriting).toBe(0);
    expect(sessionHistory().map(entry => entry.sessionId)).toEqual(['session-0', 'session-1']);
  });

  it('preserves rollback and continues loading after a pending write fails', async () => {
    const ls = fakeLocalStorage();
    const id = await pushHistoryEntry(fatEntry(0), ls.set);
    let release!: (ok: boolean) => void;
    const updating = updateHistoryEntry(id, { pinned: true }, () => new Promise<boolean>(resolve => { release = resolve; }));
    const rejected = expect(updating).rejects.toThrow('Could not save');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const loading = loadHistory(ls.get);
    release(false); await Promise.all([rejected, loading]);
    expect(sessionHistory()[0]!.pinned).toBeUndefined();
    await pushHistoryEntry(fatEntry(1), ls.set);
    await loadHistory(ls.get);
    expect(sessionHistory().map(entry => entry.sessionId)).toEqual(['session-0', 'session-1']);
  });

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

describe('conversation review persistence', () => {
  it.each(['history-first', 'settings-first'] as const)('merges overlapping Settings and History writes: %s', async order => {
    const ls = fakeLocalStorage();
    await saveConversationPreferences(ls.set, structuredClone(DEFAULT_CONVERSATION));
    const base = structuredClone(settings().conversation!);
    const withNote = { ...base, contexts: [{ id: 'note', label: 'History', body: 'Remember this' }] };
    const withGoal = { ...base, goal: 'Keep my goal', profile: 'work' as const };
    let release!: () => void;
    const firstWrite = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const write = async (key: string, value: string) => {
      if (++calls === 1) await firstWrite;
      return ls.set(key, value);
    };
    const first = saveConversationPreferences(write, order === 'history-first' ? withNote : withGoal);
    const second = saveConversationPreferences(write, order === 'history-first' ? withGoal : withNote);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(settings().conversation!.goal).toBe('Keep my goal');
    expect(settings().conversation!.profile).toBe('work');
    expect(settings().conversation!.contexts).toEqual(withNote.contexts);
    expect(JSON.parse(ls.data.get(CONVERSATION_KEY)!)).toEqual(settings().conversation);
  });

  it('continues queued preference writes after a failed write', async () => {
    const ls = fakeLocalStorage();
    await saveConversationPreferences(ls.set, structuredClone(DEFAULT_CONVERSATION));
    const base = structuredClone(settings().conversation!);
    const failed = saveConversationPreferences(async () => { throw new Error('Storage offline'); }, { ...base, goal: 'Not saved' });
    const next = saveConversationPreferences(ls.set, { ...base, goal: 'Recovered' });
    await expect(failed).rejects.toThrow('Storage offline');
    expect(await next).toBe(true);
    expect(settings().conversation!.goal).toBe('Recovered');
  });

  it('rejects over-capacity queued merges without discarding the earlier saved note', async () => {
    const ls = fakeLocalStorage();
    const initial = { ...structuredClone(DEFAULT_CONVERSATION), contexts: Array.from({ length: 19 }, (_, i) => ({ id: String(i), label: `Note ${i}`, body: 'Saved' })) };
    await saveConversationPreferences(ls.set, initial);
    const first = saveConversationPreferences(ls.set, { ...initial, contexts: [...initial.contexts, { id: 'history', label: 'History', body: 'Keep me' }] });
    const second = saveConversationPreferences(ls.set, { ...initial, contexts: [...initial.contexts, { id: 'draft', label: 'Draft', body: 'Unsaved' }] });
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(settings().conversation!.contexts).toHaveLength(20);
    expect(settings().conversation!.contexts.at(-1)!.id).toBe('history');
    expect(JSON.parse(ls.data.get(CONVERSATION_KEY)!).contexts).toEqual(settings().conversation!.contexts);
  });

  it('rejects over-capacity merged notes without silently truncating or writing them', async () => {
    const previous = settings().conversation!;
    const set = vi.fn(async () => true);
    const contexts = Array.from({ length: 21 }, (_, i) => ({ id: String(i), label: `Note ${i}`, body: 'Saved context' }));
    expect(await saveConversationPreferences(set, { ...previous, contexts })).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(settings().conversation).toBe(previous);
  });

  it('does not drop an analysis appended while a pin is being persisted', async () => {
    const ls = fakeLocalStorage();
    const id = await pushHistoryEntry(fatEntry(1), ls.set);
    let release!: () => void;
    const slowWrite = async (key: string, value: string) => { await new Promise<void>(resolve => { release = resolve; }); return ls.set(key, value); };
    const pin = updateHistoryEntry(id, { pinned: true }, slowWrite);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const append = pushHistoryEntry(fatEntry(2), ls.set);
    release(); await Promise.all([pin, append]);
    expect(sessionHistory()).toHaveLength(2); expect(sessionHistory()[0].pinned).toBe(true);
    await loadHistory(ls.get); expect(sessionHistory()).toHaveLength(2); expect(sessionHistory()[0].pinned).toBe(true);
  });
  it('reports and rolls back a failed review edit', async () => {
    const id = await pushHistoryEntry(fatEntry(1));
    await expect(updateHistoryEntry(id, { pinned: true }, async () => false)).rejects.toThrow('Could not save');
    expect(sessionHistory()[0].pinned).toBeUndefined();
  });
});
