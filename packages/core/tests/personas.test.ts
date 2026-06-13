// tests/personas.test.ts
import { describe, it, expect } from 'vitest';
import { trimTo, isRecord, parseJsonResponse, coerceQuote, readClaimsArray, MAX_QUOTE_CHARS, NoSpeechError } from '../src/personas/_utils';
import { parseFactCheckerResponse, buildFactCheckerPrompt } from '../src/personas/factChecker';
import {
  parseTranslationResponse,
  buildTranslationPrompt,
  buildSayMorePrompt,
  parseSayMoreResponse,
  buildWearerSpeakPrompt,
  parseWearerSpeakResponse,
  getTranslationSchema,
} from '../src/personas/translation';
import { toStrictSchema } from '../src/llm/openai';

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

  it('parseJsonResponse throws NoSpeechError when noSpeech=true', () => {
    // Same shape returned by both Gemini (via responseSchema) and OpenAI
    // (via the toStrictSchema-augmented response_format) — the lifecycle
    // layer relies on this throw to render the `○` glyph, so the route
    // must stay consistent across providers.
    expect(() => parseJsonResponse('{"noSpeech":true,"claims":[]}')).toThrow(NoSpeechError);
  });
});

describe('toStrictSchema (OpenAI provider augmentation)', () => {
  it('injects additionalProperties:false and forces required on every object', () => {
    const input = {
      type: 'object',
      properties: {
        claim: { type: 'string' },
        nested: { type: 'object', properties: { x: { type: 'number' } } },
      },
    };
    const out = toStrictSchema(input) as Record<string, unknown>;
    expect(out['additionalProperties']).toBe(false);
    expect(out['required']).toEqual(['claim', 'nested']);
    const nested = (out['properties'] as Record<string, Record<string, unknown>>)['nested'];
    expect(nested?.['additionalProperties']).toBe(false);
    expect(nested?.['required']).toEqual(['x']);
  });

  it('recurses into array item schemas', () => {
    const input = {
      type: 'object',
      properties: {
        claims: {
          type: 'array',
          items: { type: 'object', properties: { quote: { type: 'string' } } },
        },
      },
    };
    const out = toStrictSchema(input) as Record<string, unknown>;
    const items = ((out['properties'] as Record<string, Record<string, unknown>>)['claims']?.['items']) as Record<string, unknown>;
    expect(items['additionalProperties']).toBe(false);
    expect(items['required']).toEqual(['quote']);
  });

  it('preserves the noSpeech contract end-to-end (OpenAI shape parses through parseJsonResponse)', () => {
    // Emulates the body OpenAI/Groq actually returns when the model decides no
    // human speech is present: strict-schema JSON with the augmented top-level
    // `noSpeech: true` field. Must throw NoSpeechError so the lifecycle
    // surfaces `○` instead of writing an empty claim into history.
    const openaiBody = JSON.stringify({ noSpeech: true, claims: [] });
    expect(() => parseJsonResponse(openaiBody)).toThrow(NoSpeechError);
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

  it('extracts confidence (HIGH/MED/LOW) when present', () => {
    const result = parseFactCheckerResponse(JSON.stringify({
      claims: [
        { quote: 'q1', verdict: 'TRUE', claim: 'c1', reason: 'r1', confidence: 'HIGH' },
        { quote: 'q2', verdict: 'FALSE', claim: 'c2', reason: 'r2', confidence: 'low' },
        { quote: 'q3', verdict: 'UNVERIFIED', claim: 'c3', reason: 'r3', confidence: 'med' },
      ],
    }));
    if (result.type === 'fact-check') {
      expect(result.claims[0]!.confidence).toBe('HIGH');
      // case-insensitive — coerceConfidence normalizes to upper
      expect(result.claims[1]!.confidence).toBe('LOW');
      expect(result.claims[2]!.confidence).toBe('MED');
    }
  });

  it('omits confidence when absent or invalid', () => {
    const result = parseFactCheckerResponse(JSON.stringify({
      claims: [
        { quote: 'q1', verdict: 'TRUE', claim: 'c1', reason: 'r1' },
        { quote: 'q2', verdict: 'TRUE', claim: 'c2', reason: 'r2', confidence: 'WHATEVER' },
        { quote: 'q3', verdict: 'TRUE', claim: 'c3', reason: 'r3', confidence: 42 },
      ],
    }));
    if (result.type === 'fact-check') {
      expect(result.claims[0]!.confidence).toBeUndefined();
      expect(result.claims[1]!.confidence).toBeUndefined();
      expect(result.claims[2]!.confidence).toBeUndefined();
    }
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

  it('truncates over-long claim summaries to 140 chars', () => {
    const long = 'c'.repeat(500);
    const result = parseFactCheckerResponse(JSON.stringify({ claims: [{ quote: 'q', verdict: 'TRUE', claim: long, reason: 'r' }] }));
    if (result.type === 'fact-check') expect(result.claims[0]!.claim.length).toBeLessThanOrEqual(140);
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

  it('truncates over-long questions to 140 chars', () => {
    const long = 'Q'.repeat(500);
    const result = parseTriviaResponse(JSON.stringify({ claims: [{ quote: '', question: long, answer: 'A', description: 'ok' }] }));
    if (result.type === 'trivia') expect(result.claims[0]!.question.length).toBeLessThanOrEqual(140);
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

describe('fact-check numerical absorption', () => {
  it('parses a FALSE verdict on a numerical claim', () => {
    const result = parseFactCheckerResponse(JSON.stringify({
      claims: [{
        quote: 'Inflation hit 12% last year',
        verdict: 'FALSE',
        claim: 'US inflation reached 12% in the prior year.',
        reason: 'CPI peaked near 9.1% in mid-2022.',
      }],
    }));
    expect(result.type).toBe('fact-check');
    if (result.type === 'fact-check') {
      expect(result.claims[0]!.verdict).toBe('FALSE');
      expect(result.claims[0]!.reason).toContain('9.1');
    }
  });

  it('prompt instructs the model to treat numerical claims as check-worthy', () => {
    const prompt = buildFactCheckerPrompt('en');
    expect(prompt).toMatch(/numerical/i);
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

  it('absorbs tonal/emotional framing (formerly the Sentiment lens)', () => {
    const result = parseBiasDetectorResponse(
      JSON.stringify({ claims: [{ quote: 'this is an absolute disaster', verdict: 'BIASED', direction: 'catastrophising', reason: 'Strong negative-emotional loading without a factional slant.' }] }),
    );
    if (result.type === 'bias') {
      expect(result.claims[0]!.verdict).toBe('BIASED');
      expect(result.claims[0]!.direction).toBe('catastrophising');
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

import {
  buildSessionSummaryPrompt,
  parseSessionSummaryResponse,
  SESSION_SUMMARY_LIMITS,
} from '../src/personas/sessionSummary';

describe('session-summary', () => {
  it('parses a valid summary response with topics and key points', () => {
    const result = parseSessionSummaryResponse(
      JSON.stringify({
        title: 'Summary of bank meeting',
        summary: 'Discussed project timeline and budget across three topics.',
        topics: ['Project timeline', 'Q3 budget', 'Hiring plan'],
        keyPoints: [
          'Decision: ship beta by July 15',
          'Maria owns the budget proposal',
          'Risk: backend headcount short',
        ],
        quote: 'We need to ship by July 15.',
      }),
    );
    expect(result.type).toBe('session-summary');
    if (result.type === 'session-summary') {
      expect(result.title).toBe('Summary of bank meeting');
      expect(result.summary).toContain('project');
      expect(result.topics).toEqual(['Project timeline', 'Q3 budget', 'Hiring plan']);
      expect(result.keyPoints).toHaveLength(3);
      expect(result.keyPoints[1]).toContain('Maria');
      expect(result.quote).toContain('July 15');
    }
  });

  it('falls back to defaults when required fields are missing', () => {
    const result = parseSessionSummaryResponse(JSON.stringify({ summary: 'Just some prose.' }));
    if (result.type === 'session-summary') {
      expect(result.title).toBe('Summary of conversation');
      expect(result.topics).toEqual([]);
      expect(result.keyPoints).toEqual([]);
    }
  });

  it('filters empty/whitespace-only entries from topics and keyPoints', () => {
    const result = parseSessionSummaryResponse(
      JSON.stringify({
        summary: 'x',
        topics: ['  ', 'Real topic', '', '   '],
        keyPoints: ['', 'Real point', '   ', 'Another'],
      }),
    );
    if (result.type === 'session-summary') {
      expect(result.topics).toEqual(['Real topic']);
      expect(result.keyPoints).toEqual(['Real point', 'Another']);
    }
  });

  it('caps topics at MAX_TOPICS and keyPoints at MAX_KEY_POINTS', () => {
    const topics = Array.from({ length: SESSION_SUMMARY_LIMITS.MAX_TOPICS + 5 }, (_, i) => `t${i}`);
    const keyPoints = Array.from({ length: SESSION_SUMMARY_LIMITS.MAX_KEY_POINTS + 5 }, (_, i) => `k${i}`);
    const result = parseSessionSummaryResponse(
      JSON.stringify({ summary: 'x', topics, keyPoints }),
    );
    if (result.type === 'session-summary') {
      expect(result.topics).toHaveLength(SESSION_SUMMARY_LIMITS.MAX_TOPICS);
      expect(result.keyPoints).toHaveLength(SESSION_SUMMARY_LIMITS.MAX_KEY_POINTS);
    }
  });

  it('trims over-long title/summary/topic/keyPoint to their caps', () => {
    const huge = 'x'.repeat(5000);
    const result = parseSessionSummaryResponse(
      JSON.stringify({
        title: huge,
        summary: huge,
        topics: [huge],
        keyPoints: [huge],
      }),
    );
    if (result.type === 'session-summary') {
      expect(result.title.length).toBeLessThanOrEqual(SESSION_SUMMARY_LIMITS.MAX_TITLE_CHARS);
      expect(result.summary.length).toBeLessThanOrEqual(SESSION_SUMMARY_LIMITS.MAX_SUMMARY_CHARS);
      expect(result.topics[0]!.length).toBeLessThanOrEqual(SESSION_SUMMARY_LIMITS.MAX_TOPIC_CHARS);
      expect(result.keyPoints[0]!.length).toBeLessThanOrEqual(SESSION_SUMMARY_LIMITS.MAX_KEY_POINT_CHARS);
    }
  });

  it('ignores non-string entries in topics/keyPoints arrays', () => {
    const result = parseSessionSummaryResponse(
      JSON.stringify({
        summary: 'x',
        topics: ['ok', 42, null, 'also ok'],
        keyPoints: [{}, 'bullet'],
      }),
    );
    if (result.type === 'session-summary') {
      expect(result.topics).toEqual(['ok', 'also ok']);
      expect(result.keyPoints).toEqual(['bullet']);
    }
  });

  it('buildSessionSummaryPrompt omits the prior-context block when no previous summaries are supplied', () => {
    const prompt = buildSessionSummaryPrompt('en');
    expect(prompt).not.toContain('PRIOR CONTEXT');
    expect(prompt).toContain('LANGUAGE:');
  });

  it('buildSessionSummaryPrompt omits the prior-context block when the array is empty', () => {
    const prompt = buildSessionSummaryPrompt('en', { previousSummaries: [] });
    expect(prompt).not.toContain('PRIOR CONTEXT');
  });

  it('buildSessionSummaryPrompt drops empty/whitespace-only segments before deciding whether to include the prior-context block', () => {
    const prompt = buildSessionSummaryPrompt('en', {
      previousSummaries: [
        { summary: '' },
        { summary: '   ', topics: ['  '], keyPoints: ['', '  '] },
      ],
    });
    expect(prompt).not.toContain('PRIOR CONTEXT');
  });

  it('buildSessionSummaryPrompt renders each prior segment with header, summary, topics line, and key points bullets', () => {
    const prompt = buildSessionSummaryPrompt('en', {
      previousSummaries: [
        {
          title: 'Summary of opening',
          summary: 'first half of meeting',
          topics: ['intros', 'agenda'],
          keyPoints: ['kickoff at 10:00', 'Anna joined late'],
        },
        {
          title: 'Summary of close',
          summary: 'second half discussion',
          topics: ['budget'],
          keyPoints: ['ship by July 15'],
        },
      ],
    });
    expect(prompt).toContain('PRIOR CONTEXT');
    expect(prompt).toContain('=== Segment 1: Summary of opening ===');
    expect(prompt).toContain('first half of meeting');
    expect(prompt).toContain('Topics: intros · agenda');
    expect(prompt).toContain('- kickoff at 10:00');
    expect(prompt).toContain('- Anna joined late');
    expect(prompt).toContain('=== Segment 2: Summary of close ===');
    expect(prompt).toContain('Topics: budget');
    expect(prompt).toContain('- ship by July 15');
  });

  it('buildSessionSummaryPrompt still applies the language directive when prior context is provided', () => {
    const prompt = buildSessionSummaryPrompt('da', {
      previousSummaries: [{ summary: 'en ting', topics: [], keyPoints: [] }],
    });
    expect(prompt).toContain('Dansk');
    expect(prompt).toContain('PRIOR CONTEXT');
  });

  it('buildSessionSummaryPrompt directs the model to capture topics and key points exhaustively', () => {
    const prompt = buildSessionSummaryPrompt('en');
    // The "do not just conclude" anti-instruction is the load-bearing piece
    // that prevents the model from regressing to a one-paragraph wrap-up.
    expect(prompt).toMatch(/topics/i);
    expect(prompt).toMatch(/key ?points/i);
    expect(prompt).toMatch(/(not\s+just\s+conclude|whole\s+conversation|entire\s+conversation)/i);
  });
});

import { parseDevilsAdvocateResponse } from '../src/personas/devilsAdvocate';
import { parseKeyQuestionsResponse } from '../src/personas/keyQuestions';

import {
  parseAutoClassifierResponse,
  buildAutoPrompt,
  AUTO_LENS_CANDIDATES,
} from '../src/personas/auto';

describe('auto-classifier', () => {
  it('parses a valid classification', () => {
    const result = parseAutoClassifierResponse(
      JSON.stringify({ chosenLensId: 'fact-checker', reason: 'Numerical claim' }),
    );
    expect(result.chosenLensId).toBe('fact-checker');
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

  // Routing-quality regression guards. We can't run Gemini in unit tests, but
  // we can lock the *prompt language* that drove the moon-distance →
  // key-questions misroute so the fix can't silently regress.
  it('Trivia description names the lens as the answer-lookup pick', () => {
    const prompt = buildAutoPrompt('en');
    expect(prompt).toMatch(/how far is the moon/);
    expect(prompt).toMatch(/settled, well-known answer/);
  });

  it('Key Questions description scopes it to discussion gaps, not direct questions', () => {
    const prompt = buildAutoPrompt('en');
    expect(prompt).toMatch(/NOT asking but should/);
    expect(prompt).not.toMatch(/important questions remain open/);
  });

  it('Disambiguation prefers Trivia over Key Questions for direct factual questions', () => {
    const prompt = buildAutoPrompt('en');
    expect(prompt).toMatch(/Prefer "trivia" over "key-questions"/);
    expect(prompt).not.toMatch(/no clear known answer/);
  });
});

describe("devil's advocate", () => {
  it('parses a typical response', () => {
    const result = parseDevilsAdvocateResponse(JSON.stringify({
      claims: [{
        quote: 'taxes are always bad',
        counterpoint: 'Taxes fund public goods that markets under-provide.',
        rationale: 'Roads, courts, and basic research all rely on tax revenue. Without them, the economy itself degrades.',
      }],
    }));
    expect(result.type).toBe('devils-advocate');
    if (result.type === 'devils-advocate') {
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]!.quote).toBe('taxes are always bad');
      expect(result.claims[0]!.counterpoint).toContain('public goods');
      expect(result.claims[0]!.rationale).toContain('Roads');
    }
  });

  it('synthesizes an empty claim when claims array is missing', () => {
    const result = parseDevilsAdvocateResponse(JSON.stringify({}));
    if (result.type === 'devils-advocate') {
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]!.counterpoint).toBe('');
    }
  });

  it('truncates over-long quotes', () => {
    const huge = 'x'.repeat(500);
    const result = parseDevilsAdvocateResponse(JSON.stringify({
      claims: [{ quote: huge, counterpoint: 'c', rationale: 'r' }],
    }));
    if (result.type === 'devils-advocate') {
      expect(result.claims[0]!.quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    }
  });
});

import {
  buildMeetingPrepPrompt,
  buildMeetingPrepSchema,
  parseMeetingPrepResponse,
  resolveAttachmentLabels,
  MAX_ANSWER_CHARS,
  MAX_FOLLOW_UP_CHARS,
  MAX_EVIDENCE_CHARS,
} from '../src/personas/meetingPrep';
import type { MeetingPrepSection } from '../src/types';

const GENERAL_ONLY: MeetingPrepSection[] = [
  { id: 's0', label: '', body: 'Negotiating prepayment terms; aim for ≤5y fixed.' },
];

const GENERAL_PLUS_TWO: MeetingPrepSection[] = [
  { id: 's0', label: '', body: 'Negotiating prepayment terms.' },
  { id: 's1', label: 'Bank contract', body: 'Current rate 4.8%, 25-year term.' },
  { id: 's2', label: 'Questions', body: 'Can I prepay without penalty?' },
];

describe('meeting-prep / resolveAttachmentLabels', () => {
  it('preserves trimmed user labels and auto-numbers unlabeled rows as "Attachment N"', () => {
    const labels = resolveAttachmentLabels([
      { id: 'a', label: '  ', body: 'x' },
      { id: 'b', label: 'Mortgage', body: 'y' },
      { id: 'c', label: '', body: 'z' },
    ]);
    expect(labels).toEqual(['Attachment 1', 'Mortgage', 'Attachment 2']);
  });

  it('returns an empty list when no attachments are passed', () => {
    expect(resolveAttachmentLabels([])).toEqual([]);
  });
});

describe('meeting-prep / buildMeetingPrepSchema', () => {
  it('produces a source enum from attachment labels only — never the general slot', () => {
    const schema = buildMeetingPrepSchema(GENERAL_PLUS_TWO) as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    const source = props['source'] as Record<string, unknown>;
    expect(source['enum']).toEqual(['Bank contract', 'Questions']);
    expect(schema['required']).toEqual(['answer']);
  });

  it('omits source and evidence entirely when no attachments are configured (general only)', () => {
    const schema = buildMeetingPrepSchema(GENERAL_ONLY) as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    expect(props['source']).toBeUndefined();
    expect(props['evidence']).toBeUndefined();
  });

  it('exposes followUp as a single string (no array, no maxItems)', () => {
    const schema = buildMeetingPrepSchema(GENERAL_PLUS_TWO) as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    const followUp = props['followUp'] as Record<string, unknown>;
    expect(followUp['type']).toBe('string');
    expect(followUp['maxItems']).toBeUndefined();
    expect(followUp['items']).toBeUndefined();
  });

  it('declares evidence as an object with required source + quote, source bound to attachment enum', () => {
    const schema = buildMeetingPrepSchema(GENERAL_PLUS_TWO) as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    const evidence = props['evidence'] as Record<string, unknown>;
    expect(evidence['type']).toBe('object');
    expect(evidence['required']).toEqual(['source', 'quote']);
    const evidenceProps = evidence['properties'] as Record<string, unknown>;
    const evidenceSource = evidenceProps['source'] as Record<string, unknown>;
    expect(evidenceSource['enum']).toEqual(['Bank contract', 'Questions']);
    expect((evidenceProps['quote'] as Record<string, unknown>)['type']).toBe('string');
  });

  it('uses "Attachment N" defaults in the enum when attachments are unlabeled', () => {
    const schema = buildMeetingPrepSchema([
      { id: 's0', label: '', body: 'general' },
      { id: 'a', label: '', body: 'first att' },
      { id: 'b', label: '', body: 'second att' },
    ]) as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    const source = props['source'] as Record<string, unknown>;
    expect(source['enum']).toEqual(['Attachment 1', 'Attachment 2']);
  });

  it('skips attachments with empty bodies when building the source enum', () => {
    const schema = buildMeetingPrepSchema([
      { id: 's0', label: '', body: 'general' },
      { id: 'a', label: 'Real', body: 'content' },
      { id: 'b', label: 'Blank', body: '   ' },
    ]) as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    const source = props['source'] as Record<string, unknown>;
    expect(source['enum']).toEqual(['Real']);
  });
});

describe('meeting-prep / buildMeetingPrepPrompt', () => {
  it('embeds the general body unlabeled and lists attachments with headers + source labels', () => {
    const prompt = buildMeetingPrepPrompt('da', GENERAL_PLUS_TWO);
    expect(prompt).toContain('Dansk');
    expect(prompt).toContain('# Notes');
    expect(prompt).toContain('Negotiating prepayment terms.');
    expect(prompt).toContain('=== Bank contract ===');
    expect(prompt).toContain('=== Questions ===');
    expect(prompt).toContain('"Bank contract"');
    expect(prompt).toContain('"Questions"');
  });

  it('tells the model not to set source when there are no attachments', () => {
    const prompt = buildMeetingPrepPrompt('en', GENERAL_ONLY);
    expect(prompt).toMatch(/no attachments/i);
    expect(prompt).not.toContain('=== ');
  });

  it('includes BOTH few-shot examples (no-follow-up and gap cases) so the model sees both cardinalities', () => {
    // Quality-critical: a single example showing follow-ups anchors the model
    // to always emit them. The pair (Example A with no followUp, Example B
    // with one) calibrates against that prior.
    const prompt = buildMeetingPrepPrompt('en', GENERAL_PLUS_TWO);
    expect(prompt).toContain('EXAMPLE A');
    expect(prompt).toContain('EXAMPLE B');
    expect(prompt).toContain('evidence');
  });
});

describe('meeting-prep / parseMeetingPrepResponse', () => {
  it('parses a primary answer with detail and an attachment source as a single answer claim', () => {
    const result = parseMeetingPrepResponse(
      JSON.stringify({
        answer: 'They are offering 4.2% — lower than your current 4.8%.',
        detail: 'Saves about €120/month at current balance.',
        source: 'Bank contract',
      }),
      GENERAL_PLUS_TWO,
    );
    expect(result.type).toBe('meeting-prep');
    if (result.type === 'meeting-prep') {
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]!.kind).toBe('answer');
      expect(result.claims[0]!.text).toContain('4.2%');
      expect(result.claims[0]!.source).toBe('Bank contract');
      expect(result.claims[0]!.detail).toContain('€120');
    }
  });

  it('drops source when it does not match a known attachment label', () => {
    const result = parseMeetingPrepResponse(
      JSON.stringify({ answer: 'X', source: 'Made-up label' }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      expect(result.claims[0]!.source).toBe('');
    }
  });

  it('drops source even if the model returns the general slot name (general is never citable)', () => {
    const result = parseMeetingPrepResponse(
      JSON.stringify({ answer: 'X', source: 'Notes' }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      expect(result.claims[0]!.source).toBe('');
    }
  });

  it('parses evidence into a kind:"evidence" claim with the verbatim quote and attachment source', () => {
    const result = parseMeetingPrepResponse(
      JSON.stringify({
        answer: 'A',
        source: 'Bank contract',
        evidence: { source: 'Bank contract', quote: 'Current rate 4.8%, 25-year term.' },
      }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      expect(result.claims).toHaveLength(2);
      expect(result.claims[1]!.kind).toBe('evidence');
      expect(result.claims[1]!.text).toBe('Current rate 4.8%, 25-year term.');
      expect(result.claims[1]!.source).toBe('Bank contract');
    }
  });

  it('drops evidence when its source is not a valid attachment label', () => {
    const result = parseMeetingPrepResponse(
      JSON.stringify({
        answer: 'A',
        evidence: { source: 'Made-up', quote: 'something' },
      }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      expect(result.claims).toHaveLength(1);
    }
  });

  it('drops evidence when its quote is missing or empty', () => {
    const result = parseMeetingPrepResponse(
      JSON.stringify({
        answer: 'A',
        evidence: { source: 'Bank contract', quote: '' },
      }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      expect(result.claims).toHaveLength(1);
    }
  });

  it('parses a single followUp into a kind:"followup" claim with empty source', () => {
    const result = parseMeetingPrepResponse(
      JSON.stringify({
        answer: 'A',
        followUp: 'Is 4.2% fixed, and for how many years?',
      }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      expect(result.claims).toHaveLength(2);
      expect(result.claims[1]!.kind).toBe('followup');
      expect(result.claims[1]!.text).toBe('Is 4.2% fixed, and for how many years?');
      expect(result.claims[1]!.source).toBe('');
    }
  });

  it('omits the followup claim entirely when followUp is missing — the default path', () => {
    // Central behavior change: the model is expected to leave followUp unset
    // for the common case where prep already covers the answer.
    const result = parseMeetingPrepResponse(
      JSON.stringify({ answer: 'A', source: 'Bank contract' }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      expect(result.claims.some((c) => c.kind === 'followup')).toBe(false);
    }
  });

  it('omits the followup claim when followUp is an empty string', () => {
    const result = parseMeetingPrepResponse(
      JSON.stringify({ answer: 'A', followUp: '' }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      expect(result.claims).toHaveLength(1);
    }
  });

  it('emits answer + evidence + followup in stable order when all three are present', () => {
    const result = parseMeetingPrepResponse(
      JSON.stringify({
        answer: 'A',
        source: 'Bank contract',
        evidence: { source: 'Bank contract', quote: 'Q' },
        followUp: 'F',
      }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      expect(result.claims.map((c) => c.kind)).toEqual(['answer', 'evidence', 'followup']);
    }
  });

  it('truncates over-long answer, evidence, and follow-up text', () => {
    const huge = 'x'.repeat(500);
    const result = parseMeetingPrepResponse(
      JSON.stringify({
        answer: huge,
        evidence: { source: 'Bank contract', quote: huge },
        followUp: huge,
      }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      const answer = result.claims.find((c) => c.kind === 'answer')!;
      const evidence = result.claims.find((c) => c.kind === 'evidence')!;
      const followup = result.claims.find((c) => c.kind === 'followup')!;
      expect(answer.text.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS);
      expect(evidence.text.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
      expect(followup.text.length).toBeLessThanOrEqual(MAX_FOLLOW_UP_CHARS);
    }
  });

  it('throws NoSpeechError when the model reports no speech', () => {
    expect(() =>
      parseMeetingPrepResponse(JSON.stringify({ noSpeech: true }), GENERAL_PLUS_TWO),
    ).toThrow(/no clear human speech/i);
  });
});

describe('key-questions', () => {
  it('parses a two-question response', () => {
    const result = parseKeyQuestionsResponse(JSON.stringify({
      claims: [
        { question: 'What is the total cost of the project?', context: 'Budget was mentioned but no figure given.' },
        { question: 'Who approves the final decision?', context: 'Decision authority was left ambiguous.' },
      ],
    }));
    expect(result.type).toBe('key-questions');
    if (result.type === 'key-questions') {
      expect(result.claims).toHaveLength(2);
      expect(result.claims[0]!.question).toContain('total cost');
      expect(result.claims[1]!.context).toContain('ambiguous');
    }
  });

  it('synthesizes an empty claim when claims array is missing', () => {
    const result = parseKeyQuestionsResponse(JSON.stringify({}));
    if (result.type === 'key-questions') {
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]!.question).toBe('');
    }
  });

  it('caps at 4 claims even if more are returned', () => {
    const claims = Array.from({ length: 6 }, (_, i) => ({
      question: `Q${i + 1}?`,
      context: `context ${i + 1}`,
    }));
    const result = parseKeyQuestionsResponse(JSON.stringify({ claims }));
    if (result.type === 'key-questions') {
      expect(result.claims).toHaveLength(4);
    }
  });
});

describe('translation persona', () => {
  it('parses a full Gemini response with 3 starters', () => {
    const result = parseTranslationResponse(JSON.stringify({
      sourceLanguage: 'es',
      sourceText: '¿Qué le gustaría tomar?',
      translatedText: 'What would you like to drink?',
      replyStarters: [
        { source: 'Un café, por favor.', translated: 'A coffee, please.' },
        { source: 'Agua mineral.', translated: 'Sparkling water.' },
        { source: '¿Qué me recomienda?', translated: 'What do you recommend?' },
      ],
    }));
    expect(result.type).toBe('translation');
    if (result.type === 'translation') {
      expect(result.sourceLanguage).toBe('es');
      expect(result.sourceText).toContain('gustaría');
      expect(result.translatedText).toContain('drink');
      expect(result.replyStarters).toHaveLength(3);
      expect(result.replyStarters[0]!.source).toBe('Un café, por favor.');
      expect(result.replyStarters[0]!.translated).toBe('A coffee, please.');
    }
  });

  it('caps reply starters at 3 even when the model returns more', () => {
    const result = parseTranslationResponse(JSON.stringify({
      sourceLanguage: 'fr',
      sourceText: 'Bonjour.',
      translatedText: 'Hello.',
      replyStarters: Array.from({ length: 6 }, (_, i) => ({
        source: `bonjour-${i}`,
        translated: `hi-${i}`,
      })),
    }));
    if (result.type === 'translation') {
      expect(result.replyStarters).toHaveLength(3);
    }
  });

  it('defaults sourceLanguage to "unknown" and replyStarters to [] when fields are missing', () => {
    const result = parseTranslationResponse(JSON.stringify({}));
    if (result.type === 'translation') {
      expect(result.sourceLanguage).toBe('unknown');
      expect(result.sourceText).toBe('');
      expect(result.translatedText).toBe('');
      expect(result.replyStarters).toEqual([]);
    }
  });

  it('throws NoSpeechError when the model returns noSpeech=true', () => {
    expect(() => parseTranslationResponse(JSON.stringify({
      noSpeech: true,
      sourceLanguage: 'unknown',
      sourceText: '',
      translatedText: '',
      replyStarters: [],
    }))).toThrow(NoSpeechError);
  });

  it('buildTranslationPrompt embeds the target-language name', () => {
    const prompt = buildTranslationPrompt('da', 'auto');
    expect(prompt).toContain('Dansk');
    expect(prompt).toContain('ANY language');
  });

  it('buildTranslationPrompt lists the allow-listed source languages', () => {
    const prompt = buildTranslationPrompt('en', ['es', 'fr']);
    expect(prompt).toContain('es (Español)');
    expect(prompt).toContain('fr (Français)');
    expect(prompt).toContain('ONE of');
  });

  it('buildTranslationPrompt with empty array behaves like auto', () => {
    const prompt = buildTranslationPrompt('en', []);
    expect(prompt).toContain('ANY language');
  });

  it('lowercases sourceLanguage codes returned by the model', () => {
    const result = parseTranslationResponse(JSON.stringify({
      sourceLanguage: 'ES',
      sourceText: 'Hola',
      translatedText: 'Hello',
      replyStarters: [],
    }));
    if (result.type === 'translation') {
      expect(result.sourceLanguage).toBe('es');
    }
  });

  // ---------- v2: converse / listen-in mode ----------

  it('converse mode prompts the LLM for 3 reply starters', () => {
    const prompt = buildTranslationPrompt('en', 'auto', 'converse');
    expect(prompt).toContain('EXACTLY 3 short reply starters');
    expect(prompt).toContain("each starter's `translated` field");
  });

  it('listen-in mode skips the reply-starter clause entirely', () => {
    const prompt = buildTranslationPrompt('en', 'auto', 'listen-in');
    expect(prompt).not.toContain('EXACTLY 3 short reply starters');
    expect(prompt).toContain('LISTEN-IN mode');
    expect(prompt).toContain('empty array');
  });

  it('mode defaults to converse when omitted (back-compat with v1 callers)', () => {
    const omitted = buildTranslationPrompt('en', 'auto');
    const explicit = buildTranslationPrompt('en', 'auto', 'converse');
    expect(omitted).toBe(explicit);
  });

  it('getTranslationSchema(converse) requires 3 reply starters', () => {
    const schema = getTranslationSchema('converse') as {
      properties: { replyStarters: { minItems: number; maxItems: number } };
    };
    expect(schema.properties.replyStarters.minItems).toBe(3);
    expect(schema.properties.replyStarters.maxItems).toBe(3);
  });

  it('getTranslationSchema(listen-in) forbids reply starters', () => {
    const schema = getTranslationSchema('listen-in') as {
      properties: { replyStarters: { minItems: number; maxItems: number } };
    };
    expect(schema.properties.replyStarters.minItems).toBe(0);
    expect(schema.properties.replyStarters.maxItems).toBe(0);
  });
});

describe('say-more expansion', () => {
  it('buildSayMorePrompt embeds the chosen starter verbatim', () => {
    const prompt = buildSayMorePrompt({
      starter: { source: 'Un café, por favor.', translated: 'A coffee, please.' },
      targetLang: 'en',
      sourceLang: 'es',
      recentTranscripts: [],
    });
    expect(prompt).toContain('Un café, por favor.');
    expect(prompt).toContain('A coffee, please.');
    expect(prompt).toContain('Source language: es');
  });

  it('buildSayMorePrompt anchors on the starter language when sourceLang is unknown', () => {
    const prompt = buildSayMorePrompt({
      starter: { source: 'Hola', translated: 'Hi' },
      targetLang: 'en',
      sourceLang: 'unknown',
      recentTranscripts: [],
    });
    expect(prompt).toContain('same language as the chosen starter');
    expect(prompt).not.toContain('Source language: unknown');
  });

  it('buildSayMorePrompt embeds up to 3 recent transcripts in order, latest last', () => {
    const prompt = buildSayMorePrompt({
      starter: { source: 'X', translated: 'X' },
      targetLang: 'en',
      sourceLang: 'es',
      recentTranscripts: ['first thing', 'second thing', 'third thing', 'fourth thing'],
    });
    expect(prompt).toContain('RECENT CONVERSATION');
    expect(prompt).not.toContain('first thing'); // trimmed (capped at 3)
    expect(prompt).toContain('second thing');
    expect(prompt).toContain('third thing');
    expect(prompt).toContain('fourth thing');
    // Latest last → fourth appears after second in the prompt
    const second = prompt.indexOf('second thing');
    const fourth = prompt.indexOf('fourth thing');
    expect(fourth).toBeGreaterThan(second);
  });

  it('buildSayMorePrompt omits the recent-conversation block when empty', () => {
    const prompt = buildSayMorePrompt({
      starter: { source: 'X', translated: 'X' },
      targetLang: 'en',
      sourceLang: 'es',
      recentTranscripts: [],
    });
    expect(prompt).not.toContain('RECENT CONVERSATION');
  });

  it('parseSayMoreResponse extracts both fields', () => {
    const parsed = parseSayMoreResponse(JSON.stringify({
      extendedSource: 'Un café americano, por favor, sin azúcar.',
      extendedTranslated: 'An americano, please, no sugar.',
    }));
    expect(parsed.extendedSource).toContain('americano');
    expect(parsed.extendedTranslated).toContain('americano');
  });

  it('parseSayMoreResponse defaults missing fields to empty strings', () => {
    const parsed = parseSayMoreResponse(JSON.stringify({}));
    expect(parsed.extendedSource).toBe('');
    expect(parsed.extendedTranslated).toBe('');
  });
});

describe('wearer-speak (two-way)', () => {
  it('buildWearerSpeakPrompt embeds the wearer language name and the target code', () => {
    const prompt = buildWearerSpeakPrompt({ wearerLang: 'en', targetLangCode: 'es' });
    expect(prompt).toContain('English');
    expect(prompt).toContain('es (Español)');
  });

  it('buildWearerSpeakPrompt uses the raw code when our LANGUAGES dict does not know it', () => {
    // Tagalog is not in our LANGUAGES dict; Gemini still knows the code.
    const prompt = buildWearerSpeakPrompt({ wearerLang: 'en', targetLangCode: 'tl' });
    expect(prompt).toContain('tl');
    expect(prompt).not.toContain('tl (');
  });

  it('buildWearerSpeakPrompt names a non-English wearer language too', () => {
    const prompt = buildWearerSpeakPrompt({ wearerLang: 'da', targetLangCode: 'es' });
    expect(prompt).toContain('Dansk');
  });

  it('parseWearerSpeakResponse extracts both fields', () => {
    const parsed = parseWearerSpeakResponse(JSON.stringify({
      spoken: 'Where is the bus stop?',
      translated: '¿Dónde está la parada del autobús?',
    }));
    expect(parsed.spoken).toContain('bus stop');
    expect(parsed.translated).toContain('autobús');
  });

  it('parseWearerSpeakResponse defaults missing fields to empty strings', () => {
    const parsed = parseWearerSpeakResponse(JSON.stringify({}));
    expect(parsed.spoken).toBe('');
    expect(parsed.translated).toBe('');
  });
});

import { parseCompanionResponse, buildCompanionPrompt } from '../src/personas/companion';

describe('companion', () => {
  it('parses a single-tidbit response', () => {
    const result = parseCompanionResponse(JSON.stringify({
      claims: [{
        quote: 'the Roman aqueducts',
        kind: 'fact',
        headline: 'Some aqueducts still flow today',
        detail: 'The Aqua Virgo, built in 19 BC, still feeds the Trevi Fountain in Rome.',
        confidence: 'HIGH',
      }],
    }));
    expect(result.type).toBe('companion');
    if (result.type === 'companion') {
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]!.kind).toBe('fact');
      expect(result.claims[0]!.headline).toContain('aqueducts');
      expect(result.claims[0]!.quote).toBe('the Roman aqueducts');
      expect(result.claims[0]!.confidence).toBe('HIGH');
    }
  });

  it('accepts all four kinds, coerces unknown to "fact", and caps at MAX_CLAIMS=5', () => {
    const result = parseCompanionResponse(JSON.stringify({
      claims: [
        { quote: 'q1', kind: 'story', headline: 'h1', detail: 'd1', confidence: 'HIGH' },
        { quote: 'q2', kind: 'connection', headline: 'h2', detail: 'd2', confidence: 'MED' },
        { quote: 'q3', kind: 'nonsense', headline: 'h3', detail: 'd3', confidence: 'HIGH' },
        { quote: 'q4', kind: 'stat', headline: 'h4', detail: 'About 1 in 6 Danes…', confidence: 'MED' },
        { quote: 'q5', kind: 'fact', headline: 'h5', detail: 'd5', confidence: 'HIGH' },
        { quote: 'q6', kind: 'fact', headline: 'h6', detail: 'd6', confidence: 'HIGH' },
      ],
    }));
    if (result.type === 'companion') {
      expect(result.claims).toHaveLength(5);
      expect(result.claims[0]!.kind).toBe('story');
      expect(result.claims[1]!.kind).toBe('connection');
      expect(result.claims[2]!.kind).toBe('fact');
      expect(result.claims[3]!.kind).toBe('stat');
      expect(result.claims[4]!.kind).toBe('fact');
    }
  });

  it('throws NoSpeechError on noSpeech=true or empty claims', () => {
    expect(() =>
      parseCompanionResponse(JSON.stringify({ noSpeech: true, claims: [] })),
    ).toThrow(NoSpeechError);
    expect(() =>
      parseCompanionResponse(JSON.stringify({ claims: [] })),
    ).toThrow(NoSpeechError);
  });

  it('buildCompanionPrompt includes the language name', () => {
    const prompt = buildCompanionPrompt('da');
    expect(prompt).toContain('Dansk');
  });
});
