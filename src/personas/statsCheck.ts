// src/personas/statsCheck.ts
import type { LensResult, LanguageCode, StatsClaim } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote, readClaimsArray } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a statistical fact-check assistant for smart glasses.

The user just provided an audio clip of recent conversation. Analyze it and:

1. Identify the numerical or statistical claims (percentage, count, ratio, price, date range). If TWO distinct numerical claims are present, return BOTH. If only one is present, return just that one. Never return more than two. ORDER MATTERS: list the MOST RECENT claim first (the one spoken closest to the end of the audio).
2. For each, classify as "PLAUSIBLE" (consistent with known data) or "SUSPICIOUS" (implausible or contradicted by known data).
3. For each, include a short verbatim quote (≤140 chars) from the audio.
4. For each, quote the specific stat being checked (max 100 chars) and provide a 1-2 sentence justification (max 200 chars).

If no numerical claim is present, return a single claim with verdict "PLAUSIBLE", stat "No numerical claim found", reason "Nothing to check.", and an empty quote.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildStatsCheckPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write each claim's \`stat\` and \`reason\` in ${langName}. \`quote\` stays in the original spoken language.`;
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet (max 140 chars).' },
    verdict: { type: 'string', enum: ['PLAUSIBLE', 'SUSPICIOUS'] },
    stat: { type: 'string', description: 'The specific stat being checked (max 100 chars).' },
    reason: { type: 'string', description: 'Justification (max 200 chars).' },
  },
  required: ['quote', 'verdict', 'stat', 'reason'],
} as const;

export const STATS_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    claims: { type: 'array', minItems: 1, maxItems: 2, items: ITEM_SCHEMA },
  },
  required: ['claims'],
} as const;

export function parseStatsCheckResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw);
  const claims: StatsClaim[] = items.map((c) => {
    const v = typeof c['verdict'] === 'string' ? c['verdict'].toUpperCase() : '';
    return {
      quote: coerceQuote(c['quote']),
      verdict: v === 'PLAUSIBLE' ? 'PLAUSIBLE' : 'SUSPICIOUS',
      stat: trimTo(typeof c['stat'] === 'string' ? c['stat'] : '', 100),
      reason: trimTo(typeof c['reason'] === 'string' ? c['reason'] : '', 200),
    };
  });
  if (claims.length === 0) {
    claims.push({ quote: '', verdict: 'SUSPICIOUS', stat: '', reason: '' });
  }
  return { type: 'stats-check', claims };
}
