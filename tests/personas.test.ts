// tests/personas.test.ts
import { describe, it, expect } from 'vitest';
import { trimTo, isRecord, parseJsonResponse } from '../src/personas/_utils';
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
});

describe('fact-checker', () => {
  it('parses a valid TRUE response', () => {
    const result = parseFactCheckerResponse(
      JSON.stringify({ verdict: 'TRUE', claim: 'Water boils at 100C.', reason: 'At sea level, yes.' }),
    );
    expect(result.type).toBe('fact-check');
    if (result.type === 'fact-check') {
      expect(result.verdict).toBe('TRUE');
      expect(result.claim).toBe('Water boils at 100C.');
    }
  });

  it('falls back to UNVERIFIED for unknown verdict', () => {
    const result = parseFactCheckerResponse(JSON.stringify({ verdict: 'MAYBE', claim: 'x', reason: 'y' }));
    if (result.type === 'fact-check') expect(result.verdict).toBe('UNVERIFIED');
  });

  it('buildFactCheckerPrompt includes the language name', () => {
    const prompt = buildFactCheckerPrompt('de');
    expect(prompt).toContain('Deutsch');
  });
});

import { parseTriviaResponse, buildTriviaPrompt } from '../src/personas/trivia';

describe('trivia', () => {
  it('parses a valid trivia response', () => {
    const result = parseTriviaResponse(
      JSON.stringify({ question: 'What is the capital of France?', answer: 'Paris', description: 'Capital of France since the 10th century.' }),
    );
    expect(result.type).toBe('trivia');
    if (result.type === 'trivia') {
      expect(result.question).toBe('What is the capital of France?');
      expect(result.answer).toBe('Paris');
      expect(result.description).toContain('France');
    }
  });

  it('truncates long answers to 60 chars', () => {
    const long = 'A'.repeat(100);
    const result = parseTriviaResponse(JSON.stringify({ question: 'Q?', answer: long, description: 'ok' }));
    if (result.type === 'trivia') expect(result.answer.length).toBeLessThanOrEqual(60);
  });

  it('buildTriviaPrompt includes the language name', () => {
    const prompt = buildTriviaPrompt('fr');
    expect(prompt).toContain('Français');
  });
});

import { parseLogicalFallacyResponse } from '../src/personas/logicalFallacy';

describe('logical-fallacy', () => {
  it('parses a valid response', () => {
    const result = parseLogicalFallacyResponse(
      JSON.stringify({ fallacy: 'Ad Hominem', explanation: 'Attacking the person, not the argument.' }),
    );
    expect(result.type).toBe('logical-fallacy');
    if (result.type === 'logical-fallacy') expect(result.fallacy).toBe('Ad Hominem');
  });

  it('returns Unknown fallacy on missing field', () => {
    const result = parseLogicalFallacyResponse(JSON.stringify({ explanation: 'ok' }));
    if (result.type === 'logical-fallacy') expect(result.fallacy).toBe('Unknown');
  });
});

import { parseStatsCheckResponse } from '../src/personas/statsCheck';

describe('stats-check', () => {
  it('parses a PLAUSIBLE response', () => {
    const result = parseStatsCheckResponse(
      JSON.stringify({ verdict: 'PLAUSIBLE', stat: '71% of the Earth is water', reason: 'Accurate figure.' }),
    );
    expect(result.type).toBe('stats-check');
    if (result.type === 'stats-check') expect(result.verdict).toBe('PLAUSIBLE');
  });

  it('defaults to SUSPICIOUS for unknown verdict', () => {
    const result = parseStatsCheckResponse(JSON.stringify({ verdict: 'UNKNOWN', stat: 'x', reason: 'y' }));
    if (result.type === 'stats-check') expect(result.verdict).toBe('SUSPICIOUS');
  });
});

import { parseBiasDetectorResponse } from '../src/personas/biasDetector';

describe('bias-detector', () => {
  it('parses a NEUTRAL response', () => {
    const result = parseBiasDetectorResponse(
      JSON.stringify({ verdict: 'NEUTRAL', direction: 'none', reason: 'Balanced statement.' }),
    );
    expect(result.type).toBe('bias');
    if (result.type === 'bias') expect(result.verdict).toBe('NEUTRAL');
  });

  it('parses a BIASED response', () => {
    const result = parseBiasDetectorResponse(
      JSON.stringify({ verdict: 'BIASED', direction: 'political-left', reason: 'Loaded language.' }),
    );
    if (result.type === 'bias') {
      expect(result.verdict).toBe('BIASED');
      expect(result.direction).toBe('political-left');
    }
  });
});

import { parseTranslationResponse, buildTranslationPrompt } from '../src/personas/translation';

describe('translation', () => {
  it('parses a valid translation response', () => {
    const result = parseTranslationResponse(JSON.stringify({ translatedText: 'Bonjour le monde' }));
    expect(result.type).toBe('translation');
    if (result.type === 'translation') expect(result.translatedText).toBe('Bonjour le monde');
  });

  it('buildTranslationPrompt embeds the target language', () => {
    const prompt = buildTranslationPrompt('fr');
    expect(prompt).toContain('Français');
  });
});

import { parseEli5Response, buildEli5Prompt } from '../src/personas/eli5';

describe('eli5', () => {
  it('parses a valid ELI5 response', () => {
    const result = parseEli5Response(JSON.stringify({ explanation: 'It means the economy is shrinking.' }));
    expect(result.type).toBe('eli5');
    if (result.type === 'eli5') expect(result.explanation).toContain('economy');
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

  it('excludes translation and session-summary from candidates', () => {
    expect(AUTO_LENS_CANDIDATES).not.toContain('translation');
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
