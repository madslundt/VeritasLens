// src/personas/trivia.ts
import type { LensResult, LanguageCode, TriviaClaim } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote, readClaimsArray } from './_utils';

const TRIVIA_BASE_PROMPT = `You are VeritasLens, a trivia assistant for smart glasses.

The user just provided an audio clip likely containing one or more trivia or factual questions.

1. Identify the trivia or factual questions being asked. Return up to FIVE distinct questions, but ONLY include one if you clearly understand what was asked and it has a definitive factual answer. Skip mid-sentences, unclear phrases, repeated points, and questions you can't answer with confidence — fewer high-confidence answers is always better than padding the list.
2. For each, include a short verbatim quote (≤140 chars) from the audio that captures how the question was asked.
3. For each, restate the question (max 120 chars), provide the correct definitive answer in one short phrase (max 60 chars), and one brief explanatory sentence (max 180 chars).
4. ORDER MATTERS: list the MOST RECENT question first (the one spoken closest to the end of the audio).

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildTriviaPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${TRIVIA_BASE_PROMPT}\n\nLANGUAGE: Write each \`question\`, \`answer\`, and \`description\` in ${langName}. \`quote\` stays in the original spoken language.`;
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet (max 140 chars).' },
    question: { type: 'string', description: 'The trivia question as asked (max 120 chars).' },
    answer: { type: 'string', description: 'The correct answer (max 60 chars).' },
    description: { type: 'string', description: 'One interesting supporting fact (max 180 chars).' },
  },
  required: ['quote', 'question', 'answer', 'description'],
} as const;

export const TRIVIA_SCHEMA = {
  type: 'object',
  properties: {
    claims: { type: 'array', minItems: 1, maxItems: 5, items: ITEM_SCHEMA },
  },
  required: ['claims'],
} as const;

export function parseTriviaResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw);
  const claims: TriviaClaim[] = items.map((c) => ({
    quote: coerceQuote(c['quote']),
    question: trimTo(typeof c['question'] === 'string' ? c['question'] : '', 120),
    answer: trimTo(typeof c['answer'] === 'string' ? c['answer'] : '', 60),
    description: trimTo(typeof c['description'] === 'string' ? c['description'] : '', 180),
  }));
  if (claims.length === 0) {
    claims.push({ quote: '', question: '', answer: '', description: '' });
  }
  return { type: 'trivia', claims };
}
