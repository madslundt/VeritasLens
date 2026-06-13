// src/personas/biasDetector.ts
import type { BiasClaim, LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote, readClaimsArray, coerceConfidence, CONFIDENCE_SCHEMA_PROP, CONFIDENCE_PROMPT_RULES } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a bias and tonal-framing detection assistant for smart glasses.

The user just provided an audio clip of recent conversation. Analyze it and:

1. Identify statements where the framing is loaded — political/factional bias, OR purely emotional/tonal framing (anger, dismissiveness, enthusiasm, catastrophising) even when there is no factional slant. Return up to FIVE distinct statements, but ONLY include one if you clearly understand what was said and the framing is genuinely present. Skip mid-sentences, unclear phrases, weak hunches, and statements you don't understand — fewer high-confidence calls is always better than padding the list. ORDER MATTERS: list the MOST RECENT statement first (the one spoken closest to the end of the audio). If the audio is genuinely neutral and even-toned, return a single claim with verdict "NEUTRAL".
2. For each, classify as "NEUTRAL" or "BIASED". Use "BIASED" for both factional bias and purely tonal/emotional loading.
3. For each, include a short verbatim quote (≤140 chars) from the audio.
4. For each, describe the direction concisely (e.g. "political-left", "political-right", "emotionally-loaded", "dismissive", "aggressive", "enthusiastic", "catastrophising", "corporate", "nationalist") — max 30 characters. Tonal directions are valid on their own when no factional slant is present.
5. For each, provide a 1-2 sentence explanation (max 160 characters) of the framing markers found.
6. For each BIASED claim, also produce a "counterFrame" (≤80 chars): the same underlying point reframed from the opposing tonal or political angle, so the wearer can pivot the conversation. Use "" when verdict is NEUTRAL.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildBiasDetectorPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write each \`reason\` and \`counterFrame\` in ${langName}. Keep \`direction\` in English. \`quote\` stays in the original spoken language.\n\nCONFIDENCE: ${CONFIDENCE_PROMPT_RULES}`;
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet (max 140 chars).' },
    verdict: { type: 'string', enum: ['NEUTRAL', 'BIASED'] },
    direction: { type: 'string', description: 'Bias direction in English (max 30 chars).' },
    reason: { type: 'string', description: 'Explanation of bias markers (max 160 chars).' },
    counterFrame: { type: 'string', description: 'Same point framed from the opposing angle (max 80 chars). Empty when NEUTRAL.' },
    confidence: CONFIDENCE_SCHEMA_PROP,
  },
  required: ['quote', 'verdict', 'direction', 'reason', 'counterFrame', 'confidence'],
} as const;

export const BIAS_DETECTOR_SCHEMA = {
  type: 'object',
  properties: {
    claims: { type: 'array', minItems: 1, maxItems: 5, items: ITEM_SCHEMA },
  },
  required: ['claims'],
} as const;

export function parseBiasDetectorResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw);
  const claims: BiasClaim[] = items.map((c) => {
    const v = typeof c['verdict'] === 'string' ? c['verdict'].toUpperCase() : '';
    const confidence = coerceConfidence(c['confidence']);
    const counterFrame = trimTo(typeof c['counterFrame'] === 'string' ? c['counterFrame'] : '', 80);
    const claim: BiasClaim = {
      quote: coerceQuote(c['quote']),
      verdict: v === 'NEUTRAL' ? 'NEUTRAL' : 'BIASED',
      direction: trimTo(typeof c['direction'] === 'string' ? c['direction'] : '', 30),
      reason: trimTo(typeof c['reason'] === 'string' ? c['reason'] : '', 160),
    };
    if (counterFrame) claim.counterFrame = counterFrame;
    if (confidence) claim.confidence = confidence;
    return claim;
  });
  if (claims.length === 0) {
    claims.push({ quote: '', verdict: 'NEUTRAL', direction: '', reason: '' });
  }
  return { type: 'bias', claims };
}
