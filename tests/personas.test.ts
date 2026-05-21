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

import { buildSessionSummaryPrompt, parseSessionSummaryResponse } from '../src/personas/sessionSummary';

describe('session-summary', () => {
  it('parses a valid summary response', () => {
    const result = parseSessionSummaryResponse(
      JSON.stringify({ summary: 'Discussed project timeline and budget.' }),
    );
    expect(result.type).toBe('session-summary');
    if (result.type === 'session-summary') expect(result.summary).toContain('project');
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

  it('buildSessionSummaryPrompt drops empty/whitespace-only entries before deciding whether to include the prior-context block', () => {
    const prompt = buildSessionSummaryPrompt('en', { previousSummaries: ['', '   '] });
    expect(prompt).not.toContain('PRIOR CONTEXT');
  });

  it('buildSessionSummaryPrompt embeds each previous summary in a numbered list under PRIOR CONTEXT', () => {
    const prompt = buildSessionSummaryPrompt('en', {
      previousSummaries: ['first half of meeting', 'second half discussion'],
    });
    expect(prompt).toContain('PRIOR CONTEXT');
    expect(prompt).toContain('1. first half of meeting');
    expect(prompt).toContain('2. second half discussion');
  });

  it('buildSessionSummaryPrompt still applies the language directive when prior context is provided', () => {
    const prompt = buildSessionSummaryPrompt('da', { previousSummaries: ['en ting'] });
    expect(prompt).toContain('Dansk');
    expect(prompt).toContain('PRIOR CONTEXT');
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

import {
  buildMeetingPrepPrompt,
  buildMeetingPrepSchema,
  parseMeetingPrepResponse,
  resolveAttachmentLabels,
  MAX_FOLLOW_UPS,
  MAX_ANSWER_CHARS,
  MAX_FOLLOW_UP_CHARS,
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

  it('omits source entirely when no attachments are configured (general only)', () => {
    const schema = buildMeetingPrepSchema(GENERAL_ONLY) as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    expect(props['source']).toBeUndefined();
    const followUps = props['followUps'] as Record<string, unknown>;
    const items = followUps['items'] as Record<string, unknown>;
    const itemProps = items['properties'] as Record<string, unknown>;
    expect(itemProps['source']).toBeUndefined();
  });

  it('caps follow-ups at MAX_FOLLOW_UPS', () => {
    const schema = buildMeetingPrepSchema(GENERAL_PLUS_TWO) as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    const followUps = props['followUps'] as Record<string, unknown>;
    expect(followUps['maxItems']).toBe(MAX_FOLLOW_UPS);
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

  it('includes the hardcoded few-shot example so the model sees concrete answer/follow-up shape', () => {
    // Quality-critical: the example anchors rule 3 ("fold answered questions
    // into `answer` instead of echoing them as follow-ups"). Without it the
    // model often regresses to redundant follow-ups.
    const prompt = buildMeetingPrepPrompt('en', GENERAL_PLUS_TWO);
    expect(prompt).toContain('EXAMPLE');
  });
});

describe('meeting-prep / parseMeetingPrepResponse', () => {
  it('parses a primary answer with detail and an attachment source', () => {
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

  it('parses follow-ups and preserves their order', () => {
    const result = parseMeetingPrepResponse(
      JSON.stringify({
        answer: 'Primary',
        followUps: [
          { prompt: 'Ask about prepayment.', source: 'Questions' },
          { prompt: 'Ask about reset windows.' },
        ],
      }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      expect(result.claims).toHaveLength(3);
      expect(result.claims[1]!.text).toBe('Ask about prepayment.');
      expect(result.claims[1]!.source).toBe('Questions');
      expect(result.claims[2]!.text).toBe('Ask about reset windows.');
      expect(result.claims[2]!.source).toBe('');
    }
  });

  it('clamps follow-ups at MAX_FOLLOW_UPS even when the model returns more', () => {
    const followUps = Array.from({ length: 6 }, (_, i) => ({ prompt: `F${i}` }));
    const result = parseMeetingPrepResponse(
      JSON.stringify({ answer: 'A', followUps }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      expect(result.claims).toHaveLength(1 + MAX_FOLLOW_UPS);
    }
  });

  it('skips follow-ups with empty prompts but keeps valid ones', () => {
    const result = parseMeetingPrepResponse(
      JSON.stringify({
        answer: 'A',
        followUps: [
          { prompt: '' },
          { prompt: 'Real follow-up' },
          { other: 'malformed' },
        ],
      }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      expect(result.claims).toHaveLength(2);
      expect(result.claims[1]!.text).toBe('Real follow-up');
    }
  });

  it('truncates over-long answer and follow-up text', () => {
    const huge = 'x'.repeat(500);
    const result = parseMeetingPrepResponse(
      JSON.stringify({ answer: huge, followUps: [{ prompt: huge }] }),
      GENERAL_PLUS_TWO,
    );
    if (result.type === 'meeting-prep') {
      expect(result.claims[0]!.text.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS);
      expect(result.claims[1]!.text.length).toBeLessThanOrEqual(MAX_FOLLOW_UP_CHARS);
    }
  });

  it('throws NoSpeechError when the model reports no speech', () => {
    expect(() =>
      parseMeetingPrepResponse(JSON.stringify({ noSpeech: true }), GENERAL_PLUS_TWO),
    ).toThrow(/no clear human speech/i);
  });
});
