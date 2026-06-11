// src/personas/keyQuestions.ts
import type { KeyQuestionClaim, KeyQuestionPriority, LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, readClaimsArray } from './_utils';

const KEY_QUESTIONS_PROMPT = `You are VeritasLens, a real-time analysis assistant for smart glasses.

The user just provided a short audio clip. Listen for topics, decisions, or claims where important questions remain open, unaddressed, or unanswered. Return up to 4, most important first.

Distinguish from Trivia: these are questions WITHOUT a known answer, not questions the speaker asked that have a direct factual reply.

For each question:
- question: The question as a full sentence (≤160 chars).
- context: One sentence on why it matters or is unresolved (≤160 chars).
- priority: One of "CRITICAL" (the decision will go wrong without it), "IMPORTANT" (materially improves the outcome), or "NICE" (curiosity / nice-to-have). Sort the list so CRITICAL items come first.

If no clear speech is detected, set noSpeech to true.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildKeyQuestionsPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return (
    `${KEY_QUESTIONS_PROMPT}\n\n` +
    `LANGUAGE: Write question and context in ${langName}. Keep \`priority\` as one of the literal values "CRITICAL" / "IMPORTANT" / "NICE" regardless of language.`
  );
}

const CLAIM_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'Open question as a full sentence (max 160 chars).' },
    context: { type: 'string', description: 'Why this question matters or is unresolved (max 160 chars).' },
    priority: {
      type: 'string',
      enum: ['CRITICAL', 'IMPORTANT', 'NICE'],
      description: 'CRITICAL = decision goes wrong without it, IMPORTANT = materially improves outcome, NICE = curiosity / optional.',
    },
  },
  required: ['question', 'context', 'priority'],
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

const PRIORITY_RANK: Record<KeyQuestionPriority, number> = {
  CRITICAL: 0,
  IMPORTANT: 1,
  NICE: 2,
};

function coercePriority(v: unknown): KeyQuestionPriority | undefined {
  if (v === 'CRITICAL' || v === 'IMPORTANT' || v === 'NICE') return v;
  if (typeof v !== 'string') return undefined;
  const upper = v.trim().toUpperCase();
  if (upper === 'CRITICAL' || upper === 'IMPORTANT' || upper === 'NICE') return upper;
  return undefined;
}

export function parseKeyQuestionsResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw).slice(0, 4);
  const claims: KeyQuestionClaim[] = items.map((c) => {
    const priority = coercePriority(c['priority']);
    const claim: KeyQuestionClaim = {
      question: trimTo(typeof c['question'] === 'string' ? c['question'] : '', 160),
      context: trimTo(typeof c['context'] === 'string' ? c['context'] : '', 160),
    };
    if (priority) claim.priority = priority;
    return claim;
  });
  // Stable-sort by priority (CRITICAL → IMPORTANT → NICE). Missing priority
  // defaults to IMPORTANT so legacy history rows keep their original
  // mid-bucket position.
  claims.sort((a, b) => PRIORITY_RANK[a.priority ?? 'IMPORTANT'] - PRIORITY_RANK[b.priority ?? 'IMPORTANT']);
  if (claims.length === 0) {
    claims.push({ question: '', context: '' });
  }
  return { type: 'key-questions', claims };
}
