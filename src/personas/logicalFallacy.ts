// src/personas/logicalFallacy.ts
import type { FallacyClaim, LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote, readClaimsArray } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a logical reasoning assistant for smart glasses.

The user just provided an audio clip of recent conversation. Analyze it and:

1. Identify the logical fallacies in the argument(s). If TWO distinct fallacies are present, return BOTH. If only one is present, return just that one. Never return more than two. Order them by clarity, most blatant first. If no fallacy is found, return a single claim with fallacy "None detected".
2. For each, name the fallacy precisely (e.g. "Strawman", "Ad Hominem", "False Dilemma", "Appeal to Authority").
3. For each, include a short verbatim quote (≤140 chars) from the audio that contains the fallacy.
4. For each, provide a brief explanation (max 200 characters) of why this is or is not a fallacy.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildLogicalFallacyPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write each \`explanation\` in ${langName}. Keep \`fallacy\` as the English name. \`quote\` stays in the original spoken language.`;
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet (max 140 chars).' },
    fallacy: { type: 'string', description: 'Name of the logical fallacy, or "None detected".' },
    explanation: { type: 'string', description: 'Why this is or is not a fallacy (max 200 chars).' },
  },
  required: ['quote', 'fallacy', 'explanation'],
} as const;

export const LOGICAL_FALLACY_SCHEMA = {
  type: 'object',
  properties: {
    claims: { type: 'array', minItems: 1, maxItems: 2, items: ITEM_SCHEMA },
  },
  required: ['claims'],
} as const;

export function parseLogicalFallacyResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw);
  const claims: FallacyClaim[] = items.map((c) => ({
    quote: coerceQuote(c['quote']),
    fallacy: trimTo(typeof c['fallacy'] === 'string' ? c['fallacy'] : 'Unknown', 40),
    explanation: trimTo(typeof c['explanation'] === 'string' ? c['explanation'] : '', 200),
  }));
  if (claims.length === 0) {
    claims.push({ quote: '', fallacy: 'Unknown', explanation: '' });
  }
  return { type: 'logical-fallacy', claims };
}
