// tests/tags.test.ts
//
// Coverage for the lifecycle.extractTags exhaustive switch — exercises every
// LensResult variant declared in src/types.ts (including session-summary,
// which is driven by the auto-summary path in lifecycle.ts, not via
// personas/index.ts BUILTINS). Tags are auto-derived at history-write time
// and never rendered; they exist purely to widen the history search predicate
// in SettingsView. These tests assert the derived tags include the obvious
// recall-anchors so the user can find an entry by entity/topic/verdict.

import { describe, it, expect } from 'vitest';
import { extractTags } from '../src/runtime/lifecycle';
import type { LensResult } from '../src/types';

describe('extractTags', () => {
  it('fact-check: includes verdict and claim keywords', () => {
    const r: LensResult = {
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'Venus is the hottest planet in the solar system', reason: 'Yep.' }],
    };
    const tags = extractTags(r);
    expect(tags).toContain('true');
    expect(tags).toContain('venus');
    expect(tags.length).toBeLessThanOrEqual(6);
  });

  it('trivia: extracts keywords from question and answer', () => {
    const r: LensResult = {
      type: 'trivia',
      claims: [{ quote: '', question: 'What is the capital of France', answer: 'Paris', description: 'A city.' }],
    };
    const tags = extractTags(r);
    expect(tags).toContain('capital');
    expect(tags).toContain('france');
    expect(tags).toContain('paris');
  });

  it('logical-fallacy: uses the fallacy name', () => {
    const r: LensResult = {
      type: 'logical-fallacy',
      claims: [{ quote: '', fallacy: 'Ad hominem', explanation: 'Attacks the person.' }],
    };
    expect(extractTags(r)).toContain('ad hominem');
  });

  it('stats-check: includes verdict and stat keywords', () => {
    const r: LensResult = {
      type: 'stats-check',
      claims: [{ quote: '', verdict: 'SUSPICIOUS', stat: '90% of statistics are made up', reason: '...' }],
    };
    const tags = extractTags(r);
    expect(tags).toContain('suspicious');
    expect(tags).toContain('statistics');
  });

  it('bias: includes verdict and direction', () => {
    const r: LensResult = {
      type: 'bias',
      claims: [{ quote: '', verdict: 'BIASED', direction: 'left-leaning', reason: '...' }],
    };
    const tags = extractTags(r);
    expect(tags).toContain('biased');
    expect(tags).toContain('left-leaning');
  });

  it('eli5: extracts keywords from the explanation', () => {
    const r: LensResult = {
      type: 'eli5',
      claims: [{ quote: '', explanation: 'A blockchain is a distributed ledger of records' }],
    };
    const tags = extractTags(r);
    expect(tags).toContain('blockchain');
  });

  it('session-summary: surfaces the topics list', () => {
    const r: LensResult = {
      type: 'session-summary',
      title: 'Summary of bank meeting',
      summary: '...',
      topics: ['Mortgage rates', 'Down payment', 'Closing costs'],
      keyPoints: [],
    };
    const tags = extractTags(r);
    expect(tags).toContain('mortgage rates');
    expect(tags).toContain('down payment');
    expect(tags.length).toBeLessThanOrEqual(6);
  });

  it('meeting-prep: includes source label and text keywords', () => {
    const r: LensResult = {
      type: 'meeting-prep',
      claims: [{ kind: 'answer', text: 'The interest rate is fixed at 4.5%', source: 'Bank Contract', detail: '' }],
    };
    const tags = extractTags(r);
    expect(tags).toContain('bank contract');
    expect(tags).toContain('interest');
  });

  it('normalises tags: lowercase, deduped, trimmed, capped at 6', () => {
    const r: LensResult = {
      type: 'session-summary',
      title: '',
      summary: '',
      topics: ['  Apple ', 'apple', 'Banana', 'CHERRY', 'date', 'elderberry', 'fig', 'grape'],
      keyPoints: [],
    };
    const tags = extractTags(r);
    expect(tags.length).toBe(6);
    expect(tags).toContain('apple');
    expect(tags.filter((t) => t === 'apple').length).toBe(1); // deduped
    expect(tags.every((t) => t === t.toLowerCase())).toBe(true);
  });

  it('returns empty array for entries with no extractable content', () => {
    const r: LensResult = {
      type: 'logical-fallacy',
      claims: [{ quote: '', fallacy: '', explanation: '' }],
    };
    expect(extractTags(r)).toEqual([]);
  });
});
