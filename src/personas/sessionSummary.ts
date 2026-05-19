// src/personas/sessionSummary.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a conversation summarizer for smart glasses.

The user has provided an audio clip of a recent conversation segment. Summarize the key points discussed:

1. Identify the main topics covered.
2. Note any decisions made or action items mentioned.
3. Keep the summary concise (max 300 characters), written as 2-3 sentences.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildSessionSummaryPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write \`summary\` in ${langName}.`;
}

export const SESSION_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Concise conversation summary (max 300 chars).' },
  },
  required: ['summary'],
} as const;

export function parseSessionSummaryResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  return {
    type: 'session-summary',
    summary: trimTo(typeof raw['summary'] === 'string' ? raw['summary'] : '', 300),
  };
}
