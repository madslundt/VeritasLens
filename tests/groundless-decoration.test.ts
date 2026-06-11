// Verifies the `°` groundless mark renders on the verdict line for the lens
// shapes that carry one (fact-check, bias) AND that the persisted history
// blob round-trips a `groundingMode` field through migrateEntry.

import { describe, expect, it, beforeEach } from 'vitest';
import { formatLensResultBase } from '../src/runtime/hud';
import {
  clearSessionHistory,
  loadHistory,
  pushHistoryEntries,
  sessionHistory,
} from '../src/state/store';
import type { HistoryEntry, LensResult } from '../src/types';

describe('formatLensResultBase groundless decoration', () => {
  const factResult: LensResult = {
    type: 'fact-check',
    claims: [{
      quote: 'humans only use 10% of their brain',
      verdict: 'FALSE',
      claim: 'Humans use only 10% of their brain.',
      reason: 'Imaging shows nearly all regions active.',
    }],
  };

  it('omits the ° mark when groundingMode is grounded (default)', () => {
    const out = formatLensResultBase(factResult, 0);
    expect(out.middle).toBe('- FALSE');
  });

  it('appends ° to the verdict line for fact-check when groundless', () => {
    const out = formatLensResultBase(factResult, 0, 'groundless');
    expect(out.middle).toBe('- FALSE°');
  });

  it('appends ° to the verdict line for bias when groundless', () => {
    const biasResult: LensResult = {
      type: 'bias',
      claims: [{
        quote: 'they are destroying the economy',
        verdict: 'BIASED',
        direction: 'political-left',
        reason: 'Loaded verb framed as fact.',
      }],
    };
    const out = formatLensResultBase(biasResult, 0, 'groundless');
    expect(out.middle).toBe('- BIASED°');
  });

  it('does NOT decorate lenses without a verdict slot (trivia)', () => {
    const trivia: LensResult = {
      type: 'trivia',
      claims: [{
        quote: 'capital of France',
        question: 'What is the capital of France?',
        answer: 'Paris',
        description: 'Capital since the 10th century.',
      }],
    };
    const grounded = formatLensResultBase(trivia, 0);
    const groundless = formatLensResultBase(trivia, 0, 'groundless');
    expect(grounded).toEqual(groundless);
  });
});

describe('HistoryEntry groundingMode persistence', () => {
  const factEntry: Omit<HistoryEntry, 'id' | 'timestamp'> = {
    sessionId: 'session-1',
    lensId: 'fact-checker',
    lensName: 'Fact Check',
    question: 'q',
    badge: 'FALSE°',
    quote: 'q',
    result: {
      type: 'fact-check',
      claims: [{ quote: 'q', verdict: 'FALSE', claim: 'c', reason: 'r' }],
    },
    groundingMode: 'groundless',
  };

  let kv = new Map<string, string>();
  beforeEach(() => {
    kv = new Map();
    clearSessionHistory();
  });

  it('round-trips groundingMode through persist + migrate', async () => {
    const setLs = async (k: string, v: string): Promise<boolean> => {
      kv.set(k, v);
      return true;
    };
    const getLs = async (k: string): Promise<string> => kv.get(k) ?? '';

    await pushHistoryEntries([factEntry], setLs);
    expect(sessionHistory()[0]?.groundingMode).toBe('groundless');

    // Force a reload from the persisted blob — exercises the migrateEntry path.
    clearSessionHistory();
    expect(sessionHistory()).toHaveLength(0);
    await loadHistory(getLs);
    expect(sessionHistory()).toHaveLength(1);
    expect(sessionHistory()[0]?.groundingMode).toBe('groundless');
  });

  it('omits groundingMode when entry is plain grounded', async () => {
    const setLs = async (k: string, v: string): Promise<boolean> => {
      kv.set(k, v);
      return true;
    };
    const getLs = async (k: string): Promise<string> => kv.get(k) ?? '';

    const { groundingMode: _omit, ...withoutGrounding } = factEntry;
    void _omit;
    await pushHistoryEntries([withoutGrounding], setLs);

    clearSessionHistory();
    await loadHistory(getLs);
    expect(sessionHistory()[0]?.groundingMode).toBeUndefined();
  });
});
