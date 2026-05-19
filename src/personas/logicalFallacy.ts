// src/personas/logicalFallacy.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a logical reasoning assistant for smart glasses.

The user just provided an audio clip of recent conversation. Analyze it and:

1. Identify whether a logical fallacy is present in the argument or statement.
2. If a fallacy is found, name it precisely (e.g. "Strawman", "Ad Hominem", "False Dilemma", "Appeal to Authority").
3. If no fallacy is found, use "None detected".
4. Provide a brief explanation (max 200 characters) of why this is or is not a fallacy.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildLogicalFallacyPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write \`explanation\` in ${langName}. Keep \`fallacy\` as the English name.`;
}

export const LOGICAL_FALLACY_SCHEMA = {
  type: 'object',
  properties: {
    fallacy: { type: 'string', description: 'Name of the logical fallacy, or "None detected".' },
    explanation: { type: 'string', description: 'Why this is or is not a fallacy (max 200 chars).' },
  },
  required: ['fallacy', 'explanation'],
} as const;

export function parseLogicalFallacyResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  return {
    type: 'logical-fallacy',
    fallacy: trimTo(typeof raw['fallacy'] === 'string' ? raw['fallacy'] : 'Unknown', 40),
    explanation: trimTo(typeof raw['explanation'] === 'string' ? raw['explanation'] : '', 200),
  };
}
