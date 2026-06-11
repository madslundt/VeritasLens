// src/personas/eli5.ts
import type { Eli5Claim, LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote, readClaimsArray, coerceConfidence, CONFIDENCE_SCHEMA_PROP, CONFIDENCE_PROMPT_RULES } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a plain-language explainer for smart glasses.

The user just provided an audio clip of recent conversation containing jargon, technical terms, or complex language.

1. Identify the complex or jargon-heavy statements that benefit from plain-language restatement. Return up to FIVE distinct restatements, but ONLY include one if you clearly understand what was said. Skip mid-sentences, unclear phrases, repeated points, and statements you don't understand — fewer high-confidence explanations is always better than padding the list.
2. For each, include a short verbatim quote (≤140 chars) from the audio that contains the jargon being explained.
3. For each, return BOTH:
   - "oneLine": the simplest possible single-sentence restatement (≤60 chars) — the line the wearer can repeat out loud.
   - "expanded": a richer plain-language version (≤220 chars), still as if explaining to a curious 12-year-old.
4. ORDER MATTERS: list the MOST RECENT term first (the one spoken closest to the end of the audio).

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildEli5Prompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write each \`oneLine\` and \`expanded\` in ${langName}. \`quote\` stays in the original spoken language.\n\nCONFIDENCE: ${CONFIDENCE_PROMPT_RULES}`;
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet (max 140 chars).' },
    oneLine: { type: 'string', description: 'Simplest possible single-sentence restatement (max 60 chars).' },
    expanded: { type: 'string', description: 'Richer plain-language version (max 220 chars).' },
    confidence: CONFIDENCE_SCHEMA_PROP,
  },
  required: ['quote', 'oneLine', 'expanded', 'confidence'],
} as const;

export const ELI5_SCHEMA = {
  type: 'object',
  properties: {
    claims: { type: 'array', minItems: 1, maxItems: 5, items: ITEM_SCHEMA },
  },
  required: ['claims'],
} as const;

export function parseEli5Response(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw);
  const claims: Eli5Claim[] = items.map((c) => {
    const confidence = coerceConfidence(c['confidence']);
    const oneLine = trimTo(typeof c['oneLine'] === 'string' ? c['oneLine'] : '', 60);
    const expanded = trimTo(typeof c['expanded'] === 'string' ? c['expanded'] : '', 220);
    const legacy = trimTo(typeof c['explanation'] === 'string' ? c['explanation'] : '', 240);
    const claim: Eli5Claim = {
      quote: coerceQuote(c['quote']),
    };
    if (oneLine) claim.oneLine = oneLine;
    if (expanded) claim.expanded = expanded;
    // Populate `explanation` either from the model's new `expanded` (so legacy
    // HUD code paths still find a non-empty blob) or from the legacy field
    // when an old response shape comes back. Keeps backwards compat without
    // forcing every consumer to know about both shapes.
    const fallback = expanded || legacy;
    if (fallback) claim.explanation = fallback;
    if (confidence) claim.confidence = confidence;
    return claim;
  });
  if (claims.length === 0) {
    claims.push({ quote: '' });
  }
  return { type: 'eli5', claims };
}
