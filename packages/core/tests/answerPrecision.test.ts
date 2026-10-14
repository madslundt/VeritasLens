import { describe, expect, it } from 'vitest';
import { parseFactCheckerResponse } from '../src/personas/factChecker';

describe('fact-check precision at the response boundary', () => {
  it.each(['FALSE', 'TRUE'])('keeps a low-confidence %s claim unverified instead of asserting it', (verdict) => {
    const result = parseFactCheckerResponse(JSON.stringify({ claims: [{
      quote: 'An unclear number', claim: 'A disputed number', verdict,
      correction: 'Actually 42', reason: 'The recording is unclear.', confidence: 'LOW',
    }] }));
    if (result.type !== 'fact-check') throw new Error('Wrong lens result');
    expect(result.claims[0]?.verdict).toBe('UNVERIFIED');
    expect(result.claims[0]?.correction).toBeUndefined();
    expect(result.claims[0]?.confidence).toBe('LOW');
  });

  it('retains a supported correction when confidence is high', () => {
    const result = parseFactCheckerResponse(JSON.stringify({ claims: [{
      quote: 'A kilometre is 100 metres', claim: 'A kilometre is 100 metres', verdict: 'FALSE',
      correction: 'A kilometre is 1,000 metres.', reason: 'Kilo means one thousand.', confidence: 'HIGH',
    }] }));
    if (result.type !== 'fact-check') throw new Error('Wrong lens result');
    expect(result.claims[0]?.verdict).toBe('FALSE');
    expect(result.claims[0]?.correction).toBe('A kilometre is 1,000 metres.');
  });
});
