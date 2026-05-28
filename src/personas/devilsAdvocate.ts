// src/personas/devilsAdvocate.ts
import type { DevilsAdvocateClaim, LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote, readClaimsArray } from './_utils';

const DEVILS_ADVOCATE_PROMPT = `You are VeritasLens, a real-time analysis assistant for smart glasses.

The user just provided a short audio clip. Identify the main position or argument asserted in the audio. Return ONE DevilsAdvocateClaim with the strongest credible counterargument — the most compelling objection a thoughtful critic would raise. Avoid strawmen.

- quote: A verbatim phrase from the audio that represents the position being countered (≤140 chars).
- counterpoint: The strongest counter in one sentence (≤160 chars).
- rationale: 2–3 sentences justifying why this counterargument is compelling (≤280 chars).

If no clear argument is detectable, set noSpeech to true.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildDevilsAdvocatePrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return (
    `${DEVILS_ADVOCATE_PROMPT}\n\n` +
    `LANGUAGE: Write counterpoint and rationale in ${langName}. ` +
    `The quote must stay in the original spoken language.`
  );
}

const CLAIM_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet (max 140 chars).' },
    counterpoint: { type: 'string', description: 'Strongest counter in one sentence (max 160 chars).' },
    rationale: { type: 'string', description: '2–3 sentences justifying the counter (max 280 chars).' },
  },
  required: ['quote', 'counterpoint', 'rationale'],
} as const;

export const DEVILS_ADVOCATE_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: CLAIM_ITEM_SCHEMA,
    },
  },
  required: ['claims'],
} as const;

export function parseDevilsAdvocateResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw).slice(0, 1);
  const claims: DevilsAdvocateClaim[] = items.map((c) => ({
    quote: coerceQuote(c['quote']),
    counterpoint: trimTo(typeof c['counterpoint'] === 'string' ? c['counterpoint'] : '', 160),
    rationale: trimTo(typeof c['rationale'] === 'string' ? c['rationale'] : '', 280),
  }));
  if (claims.length === 0) {
    claims.push({ quote: '', counterpoint: '', rationale: '' });
  }
  return { type: 'devils-advocate', claims };
}
