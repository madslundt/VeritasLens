// tests/personas.test.ts
import { describe, it, expect } from 'vitest';
import { trimTo, isRecord, parseJsonResponse, coerceQuote, readClaimsArray, MAX_QUOTE_CHARS } from '../src/personas/_utils';
import { parseFactCheckerResponse, buildFactCheckerPrompt } from '../src/personas/factChecker';

describe('_utils', () => {
  it('trimTo leaves short strings unchanged', () => {
    expect(trimTo('hello', 10)).toBe('hello');
  });

  it('trimTo truncates long strings with ellipsis', () => {
    expect(trimTo('hello world', 8)).toBe('hello w…');
  });

  it('isRecord returns true for plain objects', () => {
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('isRecord returns false for arrays and primitives', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord('str')).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it('parseJsonResponse parses clean JSON', () => {
    const result = parseJsonResponse('{"answer":"Paris"}');
    expect(result['answer']).toBe('Paris');
  });

  it('parseJsonResponse extracts fenced JSON from prose', () => {
    const result = parseJsonResponse('Here is the result: {"answer":"Berlin"} done.');
    expect(result['answer']).toBe('Berlin');
  });

  it('parseJsonResponse throws if no JSON found', () => {
    expect(() => parseJsonResponse('no json here')).toThrow();
  });

  it('coerceQuote truncates over-long quotes to MAX_QUOTE_CHARS', () => {
    const long = 'x'.repeat(MAX_QUOTE_CHARS + 50);
    const out = coerceQuote(long);
    expect(out.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
  });

  it('coerceQuote returns "" for non-string input', () => {
    expect(coerceQuote(undefined)).toBe('');
    expect(coerceQuote(42)).toBe('');
  });

  it('readClaimsArray caps at MAX_CLAIMS (5) items even when the LLM returns more', () => {
    const raw = { claims: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }, { a: 6 }, { a: 7 }] };
    expect(readClaimsArray(raw)).toHaveLength(5);
  });

  it('readClaimsArray returns [] when claims is missing or wrong type', () => {
    expect(readClaimsArray({})).toEqual([]);
    expect(readClaimsArray({ claims: 'nope' })).toEqual([]);
  });
});

describe('fact-checker', () => {
  it('parses a single-claim TRUE response', () => {
    const result = parseFactCheckerResponse(
      JSON.stringify({ claims: [{ quote: 'Water boils at 100C.', verdict: 'TRUE', claim: 'Water boils at 100C.', reason: 'At sea level, yes.' }] }),
    );
    expect(result.type).toBe('fact-check');
    if (result.type === 'fact-check') {
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]!.verdict).toBe('TRUE');
      expect(result.claims[0]!.quote).toBe('Water boils at 100C.');
    }
  });

  it('parses a two-claim response and preserves ordering', () => {
    const result = parseFactCheckerResponse(JSON.stringify({
      claims: [
        { quote: 'q1', verdict: 'TRUE', claim: 'c1', reason: 'r1' },
        { quote: 'q2', verdict: 'FALSE', claim: 'c2', reason: 'r2' },
      ],
    }));
    if (result.type === 'fact-check') {
      expect(result.claims).toHaveLength(2);
      expect(result.claims[0]!.quote).toBe('q1');
      expect(result.claims[1]!.verdict).toBe('FALSE');
    }
  });

  it('caps claims at MAX_CLAIMS (5) even if more are returned', () => {
    const result = parseFactCheckerResponse(JSON.stringify({
      claims: [
        { quote: 'q1', verdict: 'TRUE', claim: 'c1', reason: 'r1' },
        { quote: 'q2', verdict: 'FALSE', claim: 'c2', reason: 'r2' },
        { quote: 'q3', verdict: 'TRUE', claim: 'c3', reason: 'r3' },
        { quote: 'q4', verdict: 'FALSE', claim: 'c4', reason: 'r4' },
        { quote: 'q5', verdict: 'TRUE', claim: 'c5', reason: 'r5' },
        { quote: 'q6', verdict: 'FALSE', claim: 'c6', reason: 'r6' },
      ],
    }));
    if (result.type === 'fact-check') expect(result.claims).toHaveLength(5);
  });

  it('falls back to UNVERIFIED for unknown verdict', () => {
    const result = parseFactCheckerResponse(JSON.stringify({ claims: [{ quote: '', verdict: 'MAYBE', claim: 'x', reason: 'y' }] }));
    if (result.type === 'fact-check') expect(result.claims[0]!.verdict).toBe('UNVERIFIED');
  });

  it('synthesizes an empty claim when the response has no claims array', () => {
    const result = parseFactCheckerResponse(JSON.stringify({}));
    if (result.type === 'fact-check') {
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]!.verdict).toBe('UNVERIFIED');
    }
  });

  it('truncates over-long quotes to MAX_QUOTE_CHARS', () => {
    const huge = 'a'.repeat(500);
    const result = parseFactCheckerResponse(JSON.stringify({ claims: [{ quote: huge, verdict: 'TRUE', claim: 'c', reason: 'r' }] }));
    if (result.type === 'fact-check') expect(result.claims[0]!.quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
  });

  it('buildFactCheckerPrompt includes the language name', () => {
    const prompt = buildFactCheckerPrompt('de');
    expect(prompt).toContain('Deutsch');
  });
});

import { parseTriviaResponse, buildTriviaPrompt } from '../src/personas/trivia';

describe('trivia', () => {
  it('parses a single-claim response', () => {
    const result = parseTriviaResponse(
      JSON.stringify({ claims: [{ quote: 'Quelle est la capitale de la France?', question: 'What is the capital of France?', answer: 'Paris', description: 'Capital of France since the 10th century.' }] }),
    );
    expect(result.type).toBe('trivia');
    if (result.type === 'trivia') {
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]!.question).toBe('What is the capital of France?');
      expect(result.claims[0]!.answer).toBe('Paris');
      expect(result.claims[0]!.description).toContain('France');
      expect(result.claims[0]!.quote).toContain('Quelle');
    }
  });

  it('parses multiple questions in one response', () => {
    const result = parseTriviaResponse(JSON.stringify({
      claims: [
        { quote: 'q1', question: 'Q1?', answer: 'A1', description: 'D1' },
        { quote: 'q2', question: 'Q2?', answer: 'A2', description: 'D2' },
      ],
    }));
    if (result.type === 'trivia') {
      expect(result.claims).toHaveLength(2);
      expect(result.claims[1]!.answer).toBe('A2');
    }
  });

  it('truncates long answers to 60 chars', () => {
    const long = 'A'.repeat(100);
    const result = parseTriviaResponse(JSON.stringify({ claims: [{ quote: '', question: 'Q?', answer: long, description: 'ok' }] }));
    if (result.type === 'trivia') expect(result.claims[0]!.answer.length).toBeLessThanOrEqual(60);
  });

  it('synthesizes an empty claim when the response has no claims array', () => {
    const result = parseTriviaResponse(JSON.stringify({}));
    if (result.type === 'trivia') {
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]!.answer).toBe('');
    }
  });

  it('buildTriviaPrompt includes the language name', () => {
    const prompt = buildTriviaPrompt('fr');
    expect(prompt).toContain('Français');
  });
});

import { parseLogicalFallacyResponse } from '../src/personas/logicalFallacy';

describe('logical-fallacy', () => {
  it('parses a single-claim response', () => {
    const result = parseLogicalFallacyResponse(
      JSON.stringify({ claims: [{ quote: 'You always say that', fallacy: 'Ad Hominem', explanation: 'Attacking the person, not the argument.' }] }),
    );
    expect(result.type).toBe('logical-fallacy');
    if (result.type === 'logical-fallacy') expect(result.claims[0]!.fallacy).toBe('Ad Hominem');
  });

  it('parses two distinct fallacies in one response', () => {
    const result = parseLogicalFallacyResponse(JSON.stringify({
      claims: [
        { quote: 'q1', fallacy: 'Strawman', explanation: 'e1' },
        { quote: 'q2', fallacy: 'False Dilemma', explanation: 'e2' },
      ],
    }));
    if (result.type === 'logical-fallacy') {
      expect(result.claims).toHaveLength(2);
      expect(result.claims[1]!.fallacy).toBe('False Dilemma');
    }
  });

  it('returns Unknown fallacy on missing field', () => {
    const result = parseLogicalFallacyResponse(JSON.stringify({ claims: [{ quote: '', explanation: 'ok' }] }));
    if (result.type === 'logical-fallacy') expect(result.claims[0]!.fallacy).toBe('Unknown');
  });
});

import { parseStatsCheckResponse } from '../src/personas/statsCheck';

describe('stats-check', () => {
  it('parses a PLAUSIBLE single-claim response', () => {
    const result = parseStatsCheckResponse(
      JSON.stringify({ claims: [{ quote: '71% of the planet is water', verdict: 'PLAUSIBLE', stat: '71% of the Earth is water', reason: 'Accurate figure.' }] }),
    );
    expect(result.type).toBe('stats-check');
    if (result.type === 'stats-check') {
      expect(result.claims[0]!.verdict).toBe('PLAUSIBLE');
      expect(result.claims[0]!.quote).toContain('71%');
    }
  });

  it('defaults to SUSPICIOUS for unknown verdict', () => {
    const result = parseStatsCheckResponse(JSON.stringify({ claims: [{ quote: '', verdict: 'UNKNOWN', stat: 'x', reason: 'y' }] }));
    if (result.type === 'stats-check') expect(result.claims[0]!.verdict).toBe('SUSPICIOUS');
  });
});

import { parseBiasDetectorResponse } from '../src/personas/biasDetector';

describe('bias-detector', () => {
  it('parses a NEUTRAL response', () => {
    const result = parseBiasDetectorResponse(
      JSON.stringify({ claims: [{ quote: 'The data shows X', verdict: 'NEUTRAL', direction: 'none', reason: 'Balanced statement.' }] }),
    );
    expect(result.type).toBe('bias');
    if (result.type === 'bias') expect(result.claims[0]!.verdict).toBe('NEUTRAL');
  });

  it('parses a BIASED response', () => {
    const result = parseBiasDetectorResponse(
      JSON.stringify({ claims: [{ quote: 'they always lie', verdict: 'BIASED', direction: 'political-left', reason: 'Loaded language.' }] }),
    );
    if (result.type === 'bias') {
      expect(result.claims[0]!.verdict).toBe('BIASED');
      expect(result.claims[0]!.direction).toBe('political-left');
    }
  });
});

import { parseEli5Response, buildEli5Prompt } from '../src/personas/eli5';

describe('eli5', () => {
  it('parses a single-claim response', () => {
    const result = parseEli5Response(JSON.stringify({ claims: [{ quote: 'GDP contracted', explanation: 'It means the economy is shrinking.' }] }));
    expect(result.type).toBe('eli5');
    if (result.type === 'eli5') {
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]!.explanation).toContain('economy');
      expect(result.claims[0]!.quote).toBe('GDP contracted');
    }
  });

  it('parses multiple jargon terms in one response', () => {
    const result = parseEli5Response(JSON.stringify({
      claims: [
        { quote: 'quantum tunneling', explanation: 'Particles can pass through barriers that would normally block them.' },
        { quote: 'monetary policy', explanation: 'How central banks adjust interest rates to manage the economy.' },
      ],
    }));
    if (result.type === 'eli5') {
      expect(result.claims).toHaveLength(2);
      expect(result.claims[0]!.explanation).toContain('barriers');
    }
  });

  it('buildEli5Prompt includes the language name', () => {
    const prompt = buildEli5Prompt('es');
    expect(prompt).toContain('Español');
  });
});

import { parseSessionSummaryResponse } from '../src/personas/sessionSummary';

describe('session-summary', () => {
  it('parses a valid summary response', () => {
    const result = parseSessionSummaryResponse(
      JSON.stringify({ summary: 'Discussed project timeline and budget.' }),
    );
    expect(result.type).toBe('session-summary');
    if (result.type === 'session-summary') expect(result.summary).toContain('project');
  });
});

import {
  parseAutoClassifierResponse,
  buildAutoPrompt,
  AUTO_LENS_CANDIDATES,
} from '../src/personas/auto';

describe('auto-classifier', () => {
  it('parses a valid classification', () => {
    const result = parseAutoClassifierResponse(
      JSON.stringify({ chosenLensId: 'stats-check', reason: 'Numerical claim' }),
    );
    expect(result.chosenLensId).toBe('stats-check');
    expect(result.reason).toBe('Numerical claim');
  });

  it('falls back to fact-checker for unknown lens ids', () => {
    const result = parseAutoClassifierResponse(JSON.stringify({ chosenLensId: 'not-a-lens' }));
    expect(result.chosenLensId).toBe('fact-checker');
  });

  it('accepts every advertised candidate id', () => {
    for (const id of AUTO_LENS_CANDIDATES) {
      const result = parseAutoClassifierResponse(JSON.stringify({ chosenLensId: id }));
      expect(result.chosenLensId).toBe(id);
    }
  });

  it('buildAutoPrompt includes the language name', () => {
    const prompt = buildAutoPrompt('da');
    expect(prompt).toContain('Dansk');
  });

  it('excludes session-summary and auto from candidates', () => {
    expect(AUTO_LENS_CANDIDATES).not.toContain('session-summary');
    expect(AUTO_LENS_CANDIDATES).not.toContain('auto');
  });

  // noSpeech short-circuit is already correct: parseJsonResponse in _utils.ts
  // throws NoSpeechError on `noSpeech: true`, which lifecycle.ts catches in its
  // analysis catch block (sets status='listening', skips second callLens).
  // This test locks that behaviour.
  it('throws NoSpeechError when the classifier reports no speech', () => {
    expect(() => parseAutoClassifierResponse(JSON.stringify({ noSpeech: true })))
      .toThrow(/no clear human speech/i);
  });
});
