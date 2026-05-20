// src/personas/biasDetector.ts
import type { BiasClaim, LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote, readClaimsArray } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a bias detection assistant for smart glasses.

The user just provided an audio clip of recent conversation. Analyze it and:

1. Identify the biased statements in the audio. If TWO distinct biased statements are present (different topics, different bias directions, or independently loaded), return BOTH. If only one is present, return just that one. Never return more than two. ORDER MATTERS: list the MOST RECENT biased statement first (the one spoken closest to the end of the audio). If the audio is neutral, return a single claim with verdict "NEUTRAL".
2. For each, classify as "NEUTRAL" or "BIASED".
3. For each, include a short verbatim quote (≤140 chars) from the audio.
4. For each, describe the direction concisely (e.g. "political-left", "political-right", "emotionally-loaded", "corporate", "nationalist") — max 30 characters.
5. For each, provide a 1-2 sentence explanation (max 200 characters) of the bias markers found.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildBiasDetectorPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write each \`reason\` in ${langName}. Keep \`direction\` in English. \`quote\` stays in the original spoken language.`;
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet (max 140 chars).' },
    verdict: { type: 'string', enum: ['NEUTRAL', 'BIASED'] },
    direction: { type: 'string', description: 'Bias direction in English (max 30 chars).' },
    reason: { type: 'string', description: 'Explanation of bias markers (max 200 chars).' },
  },
  required: ['quote', 'verdict', 'direction', 'reason'],
} as const;

export const BIAS_DETECTOR_SCHEMA = {
  type: 'object',
  properties: {
    claims: { type: 'array', minItems: 1, maxItems: 2, items: ITEM_SCHEMA },
  },
  required: ['claims'],
} as const;

export function parseBiasDetectorResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw);
  const claims: BiasClaim[] = items.map((c) => {
    const v = typeof c['verdict'] === 'string' ? c['verdict'].toUpperCase() : '';
    return {
      quote: coerceQuote(c['quote']),
      verdict: v === 'NEUTRAL' ? 'NEUTRAL' : 'BIASED',
      direction: trimTo(typeof c['direction'] === 'string' ? c['direction'] : '', 30),
      reason: trimTo(typeof c['reason'] === 'string' ? c['reason'] : '', 200),
    };
  });
  if (claims.length === 0) {
    claims.push({ quote: '', verdict: 'NEUTRAL', direction: '', reason: '' });
  }
  return { type: 'bias', claims };
}
