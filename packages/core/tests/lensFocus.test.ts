import { describe, expect, it } from 'vitest';
import { personas } from '../src/personas/index';
import { NoRelevantContentError, NoSpeechError } from '../src/personas/_utils';
import { parseBiasDetectorResponse } from '../src/personas/biasDetector';
import { parseLogicalFallacyResponse } from '../src/personas/logicalFallacy';
import { parseTriviaResponse } from '../src/personas/trivia';
import { parseCompanionResponse } from '../src/personas/companion';

const claimLenses = personas().filter((persona) =>
  !['auto', 'translation', 'meeting-prep', 'respond', 'repair', 'catch-up', 'commitments', 'refine'].includes(persona.id));

describe('lens focus at the response boundary', () => {
  it.each(claimLenses.map((persona) => [persona.id, persona] as const))(
    '%s supports clear speech with nothing relevant to output', (_id, persona) => {
      const schema = persona.schema as { properties: { claims: { minItems: number } } };
      expect(schema.properties.claims.minItems).toBe(0);
      expect(() => persona.parse(JSON.stringify({ noSpeech: false, claims: [] })))
        .toThrow(NoRelevantContentError);
      expect(() => persona.parse(JSON.stringify({ noSpeech: true, claims: [] })))
        .toThrow(NoSpeechError);
    },
  );

  it.each(['LOW', undefined])('never turns an invalid framing verdict into BIASED (%s)', (confidence) => {
    const result = parseBiasDetectorResponse(JSON.stringify({ claims: [{
      quote: 'We should consider both options', verdict: 'UNKNOWN', confidence,
      counterFrame: 'An opposing accusation', direction: 'aggressive', reason: 'Uncertain.',
    }] }));
    if (result.type !== 'bias') throw new Error('Wrong result');
    expect(result.claims[0]?.verdict).toBe('NEUTRAL');
    expect(result.claims[0]?.counterFrame).toBeUndefined();
    expect(result.claims[0]?.direction).toBe('');
  });

  it('neutralizes a low-confidence framing accusation and removes its counterframe', () => {
    const result = parseBiasDetectorResponse(JSON.stringify({ claims: [{
      quote: 'An ambiguous statement', verdict: 'BIASED', confidence: 'LOW',
      direction: 'political-left', reason: 'Unclear context.', counterFrame: 'The opposite view.',
    }] }));
    if (result.type !== 'bias') throw new Error('Wrong result');
    expect(result.claims[0]?.verdict).toBe('NEUTRAL');
    expect(result.claims[0]?.direction).toBe('');
    expect(result.claims[0]?.counterFrame).toBeUndefined();
  });

  it('removes an unsupported fallacy label and spoken accusation', () => {
    const result = parseLogicalFallacyResponse(JSON.stringify({ claims: [{
      quote: 'An unclear argument', fallacy: 'Ad Hominem', confidence: 'LOW',
      explanation: 'Not enough context.', callOut: 'You are attacking the person.',
    }] }));
    if (result.type !== 'logical-fallacy') throw new Error('Wrong result');
    expect(result.claims[0]?.fallacy).toBe('None detected');
    expect(result.claims[0]?.callOut).toBeUndefined();
  });

  it.each([
    ['trivia', parseTriviaResponse, { question: 'What is the number?', answer: '42', description: 'A guess.' }],
    ['companion', parseCompanionResponse, { kind: 'stat', headline: '42 percent', detail: 'An unsupported figure.' }],
  ] as const)('%s omits weak answers while keeping supported ones', (_id, parse, fields) => {
    const low = { quote: 'Unclear speech', ...fields, confidence: 'LOW' };
    const high = { quote: 'Clear speech', ...fields, confidence: 'HIGH' };
    expect(() => parse(JSON.stringify({ claims: [low] }))).toThrow(NoRelevantContentError);
    const result = parse(JSON.stringify({ claims: [low, high] }));
    if (result.type !== 'trivia' && result.type !== 'companion') throw new Error('Wrong result');
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.quote).toBe('Clear speech');
  });
});
