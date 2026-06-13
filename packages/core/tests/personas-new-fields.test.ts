// Coverage for the conversation-ready lens redesign — fields the wearer reads
// to formulate their next sentence (correction, callOut, counterFrame, pivot,
// oneLine/expanded, alt, priority) plus back-compat for the legacy ELI5
// `explanation` blob.

import { describe, expect, it } from 'vitest';
import { parseFactCheckerResponse } from '../src/personas/factChecker';
import { parseTriviaResponse } from '../src/personas/trivia';
import { parseLogicalFallacyResponse } from '../src/personas/logicalFallacy';
import { parseBiasDetectorResponse } from '../src/personas/biasDetector';
import { parseEli5Response } from '../src/personas/eli5';
import { parseDevilsAdvocateResponse } from '../src/personas/devilsAdvocate';
import { parseKeyQuestionsResponse } from '../src/personas/keyQuestions';

describe('fact-checker correction', () => {
  it('round-trips a correction value on FALSE', () => {
    const result = parseFactCheckerResponse(
      JSON.stringify({
        claims: [{
          quote: 'inflation hit 12%',
          verdict: 'FALSE',
          claim: 'US inflation peaked at 12%.',
          correction: 'Actually ~9.1%, peaked mid-2022.',
          reason: 'Per BLS reporting, peak CPI was near 9.1% in mid-2022.',
          confidence: 'HIGH',
        }],
      }),
    );
    expect(result.type).toBe('fact-check');
    if (result.type !== 'fact-check') throw new Error('wrong type');
    expect(result.claims[0]?.correction).toBe('Actually ~9.1%, peaked mid-2022.');
    expect(result.claims[0]?.confidence).toBe('HIGH');
  });

  it('omits correction when empty / absent', () => {
    const result = parseFactCheckerResponse(
      JSON.stringify({
        claims: [{
          quote: 'Water boils at 100C',
          verdict: 'TRUE',
          claim: 'Water boils at 100°C.',
          correction: '',
          reason: 'At 1 atm.',
        }],
      }),
    );
    if (result.type !== 'fact-check') throw new Error('wrong type');
    expect(result.claims[0]?.correction).toBeUndefined();
  });

  it('truncates correction to 80 chars', () => {
    const long = 'x'.repeat(200);
    const result = parseFactCheckerResponse(
      JSON.stringify({
        claims: [{ quote: 'q', verdict: 'FALSE', claim: 'c', correction: long, reason: 'r' }],
      }),
    );
    if (result.type !== 'fact-check') throw new Error('wrong type');
    expect((result.claims[0]?.correction ?? '').length).toBeLessThanOrEqual(80);
  });
});

describe('trivia alt phrasing', () => {
  it('round-trips an alt value', () => {
    const result = parseTriviaResponse(
      JSON.stringify({
        claims: [{
          quote: "what's the capital of France",
          question: 'What is the capital of France?',
          answer: 'Paris',
          alt: 'Paris, France',
          description: 'Capital since the 10th century.',
          confidence: 'HIGH',
        }],
      }),
    );
    if (result.type !== 'trivia') throw new Error('wrong type');
    expect(result.claims[0]?.alt).toBe('Paris, France');
  });

  it('omits alt when empty', () => {
    const result = parseTriviaResponse(
      JSON.stringify({
        claims: [{ quote: 'q', question: 'Q?', answer: 'A', alt: '', description: 'ok' }],
      }),
    );
    if (result.type !== 'trivia') throw new Error('wrong type');
    expect(result.claims[0]?.alt).toBeUndefined();
  });

  it('caps description at 140 chars (tighter than legacy 180)', () => {
    const long = 'x'.repeat(200);
    const result = parseTriviaResponse(
      JSON.stringify({
        claims: [{ quote: 'q', question: 'Q?', answer: 'A', description: long }],
      }),
    );
    if (result.type !== 'trivia') throw new Error('wrong type');
    expect(result.claims[0]?.description.length).toBeLessThanOrEqual(140);
  });
});

describe('logical-fallacy callOut', () => {
  it('round-trips a callOut', () => {
    const result = parseLogicalFallacyResponse(
      JSON.stringify({
        claims: [{
          quote: 'Either we agree or you hate freedom',
          fallacy: 'False Dilemma',
          callOut: "Wait, isn't that a false dilemma?",
          explanation: 'Frames two options as the only choices.',
          confidence: 'HIGH',
        }],
      }),
    );
    if (result.type !== 'logical-fallacy') throw new Error('wrong type');
    expect(result.claims[0]?.callOut).toBe("Wait, isn't that a false dilemma?");
  });

  it('omits callOut when empty', () => {
    const result = parseLogicalFallacyResponse(
      JSON.stringify({
        claims: [{ quote: 'q', fallacy: 'None detected', callOut: '', explanation: 'ok' }],
      }),
    );
    if (result.type !== 'logical-fallacy') throw new Error('wrong type');
    expect(result.claims[0]?.callOut).toBeUndefined();
  });

  it('truncates callOut to 80 chars', () => {
    const long = 'x'.repeat(200);
    const result = parseLogicalFallacyResponse(
      JSON.stringify({
        claims: [{ quote: 'q', fallacy: 'X', callOut: long, explanation: 'ok' }],
      }),
    );
    if (result.type !== 'logical-fallacy') throw new Error('wrong type');
    expect((result.claims[0]?.callOut ?? '').length).toBeLessThanOrEqual(80);
  });
});

describe('bias-detector counterFrame', () => {
  it('round-trips counterFrame on BIASED', () => {
    const result = parseBiasDetectorResponse(
      JSON.stringify({
        claims: [{
          quote: "they're destroying the economy",
          verdict: 'BIASED',
          direction: 'political-left',
          reason: 'Loaded verb "destroying" framed as fact.',
          counterFrame: 'Critics say the policy lowers long-term growth.',
          confidence: 'MED',
        }],
      }),
    );
    if (result.type !== 'bias') throw new Error('wrong type');
    expect(result.claims[0]?.counterFrame).toBe('Critics say the policy lowers long-term growth.');
  });

  it('omits counterFrame when verdict is NEUTRAL', () => {
    const result = parseBiasDetectorResponse(
      JSON.stringify({
        claims: [{
          quote: 'GDP grew 2% last year',
          verdict: 'NEUTRAL',
          direction: '',
          reason: '',
          counterFrame: '',
        }],
      }),
    );
    if (result.type !== 'bias') throw new Error('wrong type');
    expect(result.claims[0]?.counterFrame).toBeUndefined();
  });
});

describe('eli5 oneLine + expanded with legacy explanation back-compat', () => {
  it('round-trips the new shape', () => {
    const result = parseEli5Response(
      JSON.stringify({
        claims: [{
          quote: 'It uses CRISPR-Cas9',
          oneLine: 'A cut-and-paste tool for DNA.',
          expanded: 'CRISPR-Cas9 is a system scientists use to find a specific spot in DNA and snip it.',
          confidence: 'HIGH',
        }],
      }),
    );
    if (result.type !== 'eli5') throw new Error('wrong type');
    const c = result.claims[0]!;
    expect(c.oneLine).toBe('A cut-and-paste tool for DNA.');
    expect(c.expanded).toContain('CRISPR-Cas9 is');
    // explanation back-fills from expanded so HUD code paths reading the
    // legacy field still see content.
    expect(c.explanation).toBe(c.expanded);
  });

  it('falls back to legacy explanation when model returns the old shape', () => {
    const result = parseEli5Response(
      JSON.stringify({
        claims: [{
          quote: 'jargon term',
          explanation: 'Plain-language version goes here.',
        }],
      }),
    );
    if (result.type !== 'eli5') throw new Error('wrong type');
    const c = result.claims[0]!;
    expect(c.oneLine).toBeUndefined();
    expect(c.expanded).toBeUndefined();
    expect(c.explanation).toBe('Plain-language version goes here.');
  });

  it('caps oneLine at 60 chars', () => {
    const result = parseEli5Response(
      JSON.stringify({
        claims: [{ quote: 'q', oneLine: 'x'.repeat(200), expanded: 'ok' }],
      }),
    );
    if (result.type !== 'eli5') throw new Error('wrong type');
    expect((result.claims[0]?.oneLine ?? '').length).toBeLessThanOrEqual(60);
  });

  it('caps expanded at 220 chars', () => {
    const result = parseEli5Response(
      JSON.stringify({
        claims: [{ quote: 'q', oneLine: 'a', expanded: 'x'.repeat(400) }],
      }),
    );
    if (result.type !== 'eli5') throw new Error('wrong type');
    expect((result.claims[0]?.expanded ?? '').length).toBeLessThanOrEqual(220);
  });
});

describe("devil's advocate pivot", () => {
  it('round-trips pivot', () => {
    const result = parseDevilsAdvocateResponse(
      JSON.stringify({
        claims: [{
          quote: 'we should drop tariffs',
          counterpoint: 'Domestic industries lose protection.',
          rationale: 'A sudden tariff drop exposes vulnerable sectors.',
          pivot: "That's fair, though one thing worth considering is —",
          confidence: 'MED',
        }],
      }),
    );
    if (result.type !== 'devils-advocate') throw new Error('wrong type');
    expect(result.claims[0]?.pivot).toContain('one thing worth considering');
  });

  it('caps rationale at 200 chars (tighter than legacy 280)', () => {
    const long = 'x'.repeat(400);
    const result = parseDevilsAdvocateResponse(
      JSON.stringify({
        claims: [{
          quote: 'q', counterpoint: 'c', rationale: long, pivot: 'p',
        }],
      }),
    );
    if (result.type !== 'devils-advocate') throw new Error('wrong type');
    expect(result.claims[0]?.rationale.length).toBeLessThanOrEqual(200);
  });
});

describe('key-questions priority + sort', () => {
  it('sorts CRITICAL before IMPORTANT before NICE', () => {
    const result = parseKeyQuestionsResponse(
      JSON.stringify({
        claims: [
          { question: 'Q-N', context: 'c1', priority: 'NICE' },
          { question: 'Q-C', context: 'c2', priority: 'CRITICAL' },
          { question: 'Q-I', context: 'c3', priority: 'IMPORTANT' },
        ],
      }),
    );
    if (result.type !== 'key-questions') throw new Error('wrong type');
    expect(result.claims.map((c) => c.question)).toEqual(['Q-C', 'Q-I', 'Q-N']);
  });

  it('treats missing priority as IMPORTANT (mid-bucket)', () => {
    const result = parseKeyQuestionsResponse(
      JSON.stringify({
        claims: [
          { question: 'Q-no-prio', context: 'c1' },
          { question: 'Q-N', context: 'c2', priority: 'NICE' },
          { question: 'Q-C', context: 'c3', priority: 'CRITICAL' },
        ],
      }),
    );
    if (result.type !== 'key-questions') throw new Error('wrong type');
    expect(result.claims.map((c) => c.question)).toEqual(['Q-C', 'Q-no-prio', 'Q-N']);
  });

  it('round-trips priority on each claim', () => {
    const result = parseKeyQuestionsResponse(
      JSON.stringify({
        claims: [{ question: 'Q', context: 'c', priority: 'CRITICAL' }],
      }),
    );
    if (result.type !== 'key-questions') throw new Error('wrong type');
    expect(result.claims[0]?.priority).toBe('CRITICAL');
  });

  it('ignores invalid priority strings', () => {
    const result = parseKeyQuestionsResponse(
      JSON.stringify({
        claims: [{ question: 'Q', context: 'c', priority: 'WHATEVER' }],
      }),
    );
    if (result.type !== 'key-questions') throw new Error('wrong type');
    expect(result.claims[0]?.priority).toBeUndefined();
  });
});
