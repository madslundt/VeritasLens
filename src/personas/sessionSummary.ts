// src/personas/sessionSummary.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a conversation summarizer for smart glasses.

The user has provided an audio clip of a recent conversation segment. Summarize the key points discussed:

1. Identify the main topics covered.
2. Note any decisions made or action items mentioned.
3. Optionally include a short verbatim \`quote\` (≤140 chars) of the most salient line from the audio.
4. Keep the summary concise (max 300 characters), written as 2-3 sentences.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildSessionSummaryPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write \`summary\` in ${langName}. \`quote\` stays in the original spoken language.`;
}

export const SESSION_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet of the most salient line (max 140 chars).' },
    summary: { type: 'string', description: 'Concise conversation summary (max 300 chars).' },
  },
  required: ['summary'],
} as const;

export function parseSessionSummaryResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  return {
    type: 'session-summary',
    summary: trimTo(typeof raw['summary'] === 'string' ? raw['summary'] : '', 300),
    quote: coerceQuote(raw['quote']),
  };
}
