// src/personas/sessionSummary.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote } from './_utils';

// Identifiers used when persisting auto-generated summary entries to history.
// The persona is no longer exposed in the picker — these constants exist so
// the auto-summary path can attribute its history rows without a registered
// persona to look up.
export const SESSION_SUMMARY_ID = 'session-summary';
export const SESSION_SUMMARY_NAME = 'Summary';

const BASE_PROMPT = `You are VeritasLens, a conversation summarizer for smart glasses.

The user has provided an audio clip of a recent conversation segment. Summarize the key points discussed:

1. Produce a short \`title\` (≤40 chars) phrased like "Summary of <topic>" — e.g. "Summary of bank meeting", "Summary of project planning". Infer the topic from the conversation; if it's unclear, use "Summary of conversation".
2. Write a \`summary\` covering the main topics, decisions, and action items. Keep it concise (max 300 characters), written as 2-3 sentences. Do NOT just say the meeting ended — describe what was actually discussed.
3. Optionally include a short verbatim \`quote\` (≤140 chars) of the most salient line from the audio.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export interface SessionSummaryOptions {
  /**
   * Running summaries from earlier intervals of the same session whose audio
   * has since fallen out of the ring buffer. Used by the final end-of-session
   * call so the summary can cover the whole conversation, not just the tail.
   */
  previousSummaries?: string[];
}

export function buildSessionSummaryPrompt(
  lang: LanguageCode,
  options?: SessionSummaryOptions,
): string {
  const langName = LANGUAGES[lang] ?? 'English';
  const langDirective = `LANGUAGE: Write \`title\` and \`summary\` in ${langName}. \`quote\` stays in the original spoken language.`;
  const prior = options?.previousSummaries?.filter((s) => s.trim().length > 0) ?? [];
  if (prior.length === 0) {
    return `${BASE_PROMPT}\n\n${langDirective}`;
  }
  const numbered = prior.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const priorBlock =
    `PRIOR CONTEXT: These are running summaries of earlier parts of the same conversation whose audio is no longer in the buffer. Use them only for context; the authoritative content is the audio clip. Produce a single consolidated summary covering the whole session.\n${numbered}`;
  return `${BASE_PROMPT}\n\n${priorBlock}\n\n${langDirective}`;
}

export const SESSION_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short heading like "Summary of bank meeting" (max 40 chars).' },
    quote: { type: 'string', description: 'Verbatim audio snippet of the most salient line (max 140 chars).' },
    summary: { type: 'string', description: 'Concise conversation summary (max 300 chars).' },
  },
  required: ['title', 'summary'],
} as const;

export function parseSessionSummaryResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const rawTitle = typeof raw['title'] === 'string' ? raw['title'].trim() : '';
  return {
    type: 'session-summary',
    title: trimTo(rawTitle.length > 0 ? rawTitle : 'Summary of conversation', 40),
    summary: trimTo(typeof raw['summary'] === 'string' ? raw['summary'] : '', 300),
    quote: coerceQuote(raw['quote']),
  };
}
