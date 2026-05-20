// src/personas/eli5.ts
import type { Eli5Claim, LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote, readClaimsArray } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a plain-language explainer for smart glasses.

The user just provided an audio clip of recent conversation containing jargon, technical terms, or complex language.

1. Identify the complex or jargon-heavy statements that benefit from plain-language restatement. Return up to FIVE distinct restatements, but ONLY include one if you clearly understand what was said. Skip mid-sentences, unclear phrases, repeated points, and statements you don't understand — fewer high-confidence explanations is always better than padding the list.
2. For each, include a short verbatim quote (≤140 chars) from the audio that contains the jargon being explained.
3. For each, restate it in plain, simple language that anyone could understand — as if explaining to a curious 12-year-old. Keep each explanation concise (max 240 characters).
4. ORDER MATTERS: list the MOST RECENT term first (the one spoken closest to the end of the audio).

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildEli5Prompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write each \`explanation\` in ${langName}. \`quote\` stays in the original spoken language.`;
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet (max 140 chars).' },
    explanation: { type: 'string', description: 'Plain-language restatement (max 240 chars).' },
  },
  required: ['quote', 'explanation'],
} as const;

export const ELI5_SCHEMA = {
  type: 'object',
  properties: {
    claims: { type: 'array', minItems: 1, maxItems: 5, items: ITEM_SCHEMA },
  },
  required: ['claims'],
} as const;

export function parseEli5Response(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw);
  const claims: Eli5Claim[] = items.map((c) => ({
    quote: coerceQuote(c['quote']),
    explanation: trimTo(typeof c['explanation'] === 'string' ? c['explanation'] : '', 240),
  }));
  if (claims.length === 0) {
    claims.push({ quote: '', explanation: '' });
  }
  return { type: 'eli5', claims };
}
