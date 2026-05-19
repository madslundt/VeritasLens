// src/personas/trivia.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

const TRIVIA_BASE_PROMPT = `You are VeritasLens, a trivia assistant for smart glasses.

The user just provided an audio clip likely containing a trivia question or factual question.

1. Identify the question being asked.
2. Provide the correct, definitive answer in one short phrase (max 60 characters).
3. Provide one brief explanatory sentence (max 180 characters) with an interesting supporting fact.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildTriviaPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${TRIVIA_BASE_PROMPT}\n\nLANGUAGE: Write \`question\`, \`answer\`, and \`description\` in ${langName}.`;
}

export const TRIVIA_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The trivia question as asked (max 120 chars).' },
    answer: { type: 'string', description: 'The correct answer (max 60 chars).' },
    description: { type: 'string', description: 'One interesting supporting fact (max 180 chars).' },
  },
  required: ['question', 'answer', 'description'],
} as const;

export function parseTriviaResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  return {
    type: 'trivia',
    question: trimTo(typeof raw['question'] === 'string' ? raw['question'] : '', 120),
    answer: trimTo(typeof raw['answer'] === 'string' ? raw['answer'] : '', 60),
    description: trimTo(typeof raw['description'] === 'string' ? raw['description'] : '', 180),
  };
}
