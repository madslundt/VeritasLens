// src/personas/devilsAdvocate.ts
import type { DevilsAdvocateClaim, LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote, readClaimsArray, coerceConfidence, CONFIDENCE_SCHEMA_PROP, CONFIDENCE_PROMPT_RULES } from './_utils';

const DEVILS_ADVOCATE_PROMPT = `You are VeritasLens, a real-time analysis assistant for smart glasses.

The user just provided a short audio clip. Identify the main position or argument asserted in the audio. Return ONE DevilsAdvocateClaim with the strongest credible counterargument — the most compelling objection a thoughtful critic would raise. Avoid strawmen.

- quote: A verbatim phrase from the audio that represents the position being countered (≤140 chars).
- counterpoint: The strongest counter in one sentence (≤160 chars).
- rationale: 2–3 sentences justifying why this counterargument is compelling (≤200 chars).
- pivot: A conversational lead-in the wearer can use to introduce the counter tactfully (≤80 chars). Examples: "That's fair, though one thing worth considering is —", "I see the appeal, but what about —", "Counter-take, just to test it:".

If no clear argument is detectable, set noSpeech to true.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildDevilsAdvocatePrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return (
    `${DEVILS_ADVOCATE_PROMPT}\n\n` +
    `LANGUAGE: Write counterpoint, rationale, and pivot in ${langName}. ` +
    `The quote must stay in the original spoken language.\n\n` +
    `CONFIDENCE: ${CONFIDENCE_PROMPT_RULES}`
  );
}

const CLAIM_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet (max 140 chars).' },
    counterpoint: { type: 'string', description: 'Strongest counter in one sentence (max 160 chars).' },
    rationale: { type: 'string', description: '2–3 sentences justifying the counter (max 200 chars).' },
    pivot: { type: 'string', description: 'Conversational lead-in to introduce the counter (max 80 chars).' },
    confidence: CONFIDENCE_SCHEMA_PROP,
  },
  required: ['quote', 'counterpoint', 'rationale', 'pivot', 'confidence'],
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
  const claims: DevilsAdvocateClaim[] = items.map((c) => {
    const confidence = coerceConfidence(c['confidence']);
    const pivot = trimTo(typeof c['pivot'] === 'string' ? c['pivot'] : '', 80);
    const claim: DevilsAdvocateClaim = {
      quote: coerceQuote(c['quote']),
      counterpoint: trimTo(typeof c['counterpoint'] === 'string' ? c['counterpoint'] : '', 160),
      rationale: trimTo(typeof c['rationale'] === 'string' ? c['rationale'] : '', 200),
    };
    if (pivot) claim.pivot = pivot;
    if (confidence) claim.confidence = confidence;
    return claim;
  });
  if (claims.length === 0) {
    claims.push({ quote: '', counterpoint: '', rationale: '' });
  }
  return { type: 'devils-advocate', claims };
}
