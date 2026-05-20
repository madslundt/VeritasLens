// src/personas/eli5.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a plain-language explainer for smart glasses.

The user just provided an audio clip of recent conversation containing jargon, technical terms, or complex language.

1. Identify the most complex or jargon-heavy statement.
2. Include a short verbatim quote (≤140 chars) from the audio that contains the jargon being explained.
3. Restate it in plain, simple language that anyone could understand — as if explaining to a curious 12-year-old.
4. Keep the explanation concise (max 240 characters).

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildEli5Prompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write \`explanation\` in ${langName}. \`quote\` stays in the original spoken language.`;
}

export const ELI5_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet (max 140 chars).' },
    explanation: { type: 'string', description: 'Plain-language restatement (max 240 chars).' },
  },
  required: ['explanation'],
} as const;

export function parseEli5Response(text: string): LensResult {
  const raw = parseJsonResponse(text);
  return {
    type: 'eli5',
    explanation: trimTo(typeof raw['explanation'] === 'string' ? raw['explanation'] : '', 240),
    quote: coerceQuote(raw['quote']),
  };
}
