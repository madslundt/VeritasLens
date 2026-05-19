// src/personas/factChecker.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

export const FACT_CHECKER_PROMPT = `You are VeritasLens, a real-time fact-check assistant for smart glasses.

The user just provided a short audio clip of recent conversation. Listen carefully and:

1. Identify the SINGLE most check-worthy factual claim in the audio. If multiple, pick the most consequential or most verifiable.
2. Classify the claim as one of:
   - "TRUE"  : Widely supported by reliable knowledge.
   - "FALSE" : Contradicted by reliable knowledge.
   - "UNVERIFIED" : Cannot confidently classify (opinion, future event, niche fact, ambiguous wording, no check-worthy claim at all).
3. Produce a short claim summary as ONE concise sentence (no more than 110 characters). Phrase it as a statement, not a question.
4. Produce an explanation of 2-3 short sentences (no more than 240 characters total) that justifies the verdict with specific reasoning.

Output strict JSON matching the provided schema. Do not add prose outside JSON.
Do not invent facts. Prefer "UNVERIFIED" over guessing.`;

export function buildFactCheckerPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return (
    `${FACT_CHECKER_PROMPT}\n\n` +
    `LANGUAGE: Write the \`claim\` and \`reason\` fields in ${langName}. ` +
    `The \`verdict\` field MUST stay as one of the literal strings "TRUE", "FALSE", or "UNVERIFIED" regardless of language.`
  );
}

export const FACT_CHECKER_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['TRUE', 'FALSE', 'UNVERIFIED'] },
    claim: { type: 'string', description: 'One concise sentence summarizing the claim (max 110 chars).' },
    reason: { type: 'string', description: '2-3 short sentences justifying the verdict (max 240 chars).' },
  },
  required: ['verdict', 'claim', 'reason'],
} as const;

export function parseFactCheckerResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const verdict = normalizeFactVerdict(raw['verdict']);
  return {
    type: 'fact-check',
    verdict,
    claim: trimTo(typeof raw['claim'] === 'string' ? raw['claim'] : '', 110),
    reason: trimTo(typeof raw['reason'] === 'string' ? raw['reason'] : '', 240),
  };
}

function normalizeFactVerdict(value: unknown): 'TRUE' | 'FALSE' | 'UNVERIFIED' {
  if (typeof value !== 'string') return 'UNVERIFIED';
  const upper = value.trim().toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return upper;
  return 'UNVERIFIED';
}
