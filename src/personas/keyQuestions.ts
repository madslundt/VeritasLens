// src/personas/keyQuestions.ts
import type { KeyQuestionClaim, LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, readClaimsArray } from './_utils';

const KEY_QUESTIONS_PROMPT = `You are VeritasLens, a real-time analysis assistant for smart glasses.

The user just provided a short audio clip. Listen for topics, decisions, or claims where important questions remain open, unaddressed, or unanswered. Return up to 4, most important first.

Distinguish from Trivia: these are questions WITHOUT a known answer, not questions the speaker asked that have a direct factual reply.

For each question:
- question: The question as a full sentence (≤160 chars).
- context: One sentence on why it matters or is unresolved (≤160 chars).

If no clear speech is detected, set noSpeech to true.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildKeyQuestionsPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return (
    `${KEY_QUESTIONS_PROMPT}\n\n` +
    `LANGUAGE: Write question and context in ${langName}.`
  );
}

const CLAIM_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'Open question as a full sentence (max 160 chars).' },
    context: { type: 'string', description: 'Why this question matters or is unresolved (max 160 chars).' },
  },
  required: ['question', 'context'],
} as const;

export const KEY_QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: CLAIM_ITEM_SCHEMA,
    },
  },
  required: ['claims'],
} as const;

export function parseKeyQuestionsResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw).slice(0, 4);
  const claims: KeyQuestionClaim[] = items.map((c) => ({
    question: trimTo(typeof c['question'] === 'string' ? c['question'] : '', 160),
    context: trimTo(typeof c['context'] === 'string' ? c['context'] : '', 160),
  }));
  if (claims.length === 0) {
    claims.push({ question: '', context: '' });
  }
  return { type: 'key-questions', claims };
}
