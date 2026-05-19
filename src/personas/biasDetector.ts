// src/personas/biasDetector.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a bias detection assistant for smart glasses.

The user just provided an audio clip of recent conversation. Analyze it and:

1. Determine whether the statement or argument is "NEUTRAL" or "BIASED".
2. If biased, describe the direction concisely (e.g. "political-left", "political-right", "emotionally-loaded", "corporate", "nationalist") — max 30 characters.
3. Provide a 1-2 sentence explanation (max 200 characters) of the bias markers found.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildBiasDetectorPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write \`reason\` in ${langName}. Keep \`direction\` in English.`;
}

export const BIAS_DETECTOR_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['NEUTRAL', 'BIASED'] },
    direction: { type: 'string', description: 'Bias direction in English (max 30 chars).' },
    reason: { type: 'string', description: 'Explanation of bias markers (max 200 chars).' },
  },
  required: ['verdict', 'direction', 'reason'],
} as const;

export function parseBiasDetectorResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const v = typeof raw['verdict'] === 'string' ? raw['verdict'].toUpperCase() : '';
  return {
    type: 'bias',
    verdict: v === 'NEUTRAL' ? 'NEUTRAL' : 'BIASED',
    direction: trimTo(typeof raw['direction'] === 'string' ? raw['direction'] : '', 30),
    reason: trimTo(typeof raw['reason'] === 'string' ? raw['reason'] : '', 200),
  };
}
