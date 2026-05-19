// src/personas/statsCheck.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a statistical fact-check assistant for smart glasses.

The user just provided an audio clip of recent conversation. Analyze it and:

1. Identify the most specific numerical or statistical claim (percentage, count, ratio, price, date range).
2. Classify it as "PLAUSIBLE" (consistent with known data) or "SUSPICIOUS" (implausible or contradicted by known data).
3. Quote the specific stat being checked (max 100 chars).
4. Provide a 1-2 sentence justification (max 200 chars).

If no numerical claim is present, return verdict "PLAUSIBLE", stat "No numerical claim found", reason "Nothing to check."

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildStatsCheckPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write \`stat\` and \`reason\` in ${langName}.`;
}

export const STATS_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PLAUSIBLE', 'SUSPICIOUS'] },
    stat: { type: 'string', description: 'The specific stat being checked (max 100 chars).' },
    reason: { type: 'string', description: 'Justification (max 200 chars).' },
  },
  required: ['verdict', 'stat', 'reason'],
} as const;

export function parseStatsCheckResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const v = typeof raw['verdict'] === 'string' ? raw['verdict'].toUpperCase() : '';
  return {
    type: 'stats-check',
    verdict: v === 'PLAUSIBLE' ? 'PLAUSIBLE' : 'SUSPICIOUS',
    stat: trimTo(typeof raw['stat'] === 'string' ? raw['stat'] : '', 100),
    reason: trimTo(typeof raw['reason'] === 'string' ? raw['reason'] : '', 200),
  };
}
