// src/personas/factChecker.ts
import type { FactClaim, LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote, readClaimsArray } from './_utils';

export const FACT_CHECKER_PROMPT = `You are VeritasLens, a real-time fact-check assistant for smart glasses.

The user just provided a short audio clip of recent conversation. Listen carefully and:

1. Identify the check-worthy factual claims in the audio. If TWO distinct factual claims are present (different facts, different topics, or independently verifiable), return BOTH in the claims array. If only ONE check-worthy claim is present, return just that one. Never return more than two. Order them by check-worthiness, most consequential first.
2. For each claim, classify it as one of:
   - "TRUE"  : Widely supported by reliable knowledge.
   - "FALSE" : Contradicted by reliable knowledge.
   - "UNVERIFIED" : Cannot confidently classify (opinion, future event, niche fact, ambiguous wording).
3. For each claim, include a short verbatim quote (≤140 chars) from the audio that the verdict is responding to. The quote must come straight from the audio in its original spoken language.
4. For each claim, produce a one-sentence claim summary (≤110 chars), and a 2-3 sentence justification (≤240 chars).

Output strict JSON matching the provided schema. Do not add prose outside JSON.
Do not invent facts. Prefer "UNVERIFIED" over guessing.

EXAMPLE — audio contains two distinct claims about different facts:
Audio: "The Eiffel Tower is in Berlin and humans only use 10% of their brain."
Output:
{
  "claims": [
    {
      "quote": "The Eiffel Tower is in Berlin",
      "verdict": "FALSE",
      "claim": "The Eiffel Tower is located in Berlin.",
      "reason": "It is in Paris, France. It has stood on the Champ de Mars since 1889. Berlin has the Brandenburg Gate but not the Eiffel Tower."
    },
    {
      "quote": "humans only use 10% of their brain",
      "verdict": "FALSE",
      "claim": "Humans use only 10% of their brain.",
      "reason": "fMRI studies show essentially all regions of the brain are active over a day. The 10% figure is a popular myth with no scientific basis."
    }
  ]
}

EXAMPLE — audio contains only one check-worthy claim:
Audio: "Water boils at 100 degrees Celsius."
Output:
{
  "claims": [
    {
      "quote": "Water boils at 100 degrees Celsius",
      "verdict": "TRUE",
      "claim": "Water boils at 100°C.",
      "reason": "At standard atmospheric pressure (1 atm) the boiling point of water is 100°C. Higher altitudes lower it; pressure cookers raise it."
    }
  ]
}`;

export function buildFactCheckerPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return (
    `${FACT_CHECKER_PROMPT}\n\n` +
    `LANGUAGE: Write each claim's \`claim\` and \`reason\` fields in ${langName}. ` +
    `Each claim's \`quote\` field must stay in the original spoken language. ` +
    `Each claim's \`verdict\` MUST stay as one of "TRUE", "FALSE", or "UNVERIFIED" regardless of language.`
  );
}

const CLAIM_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet for this claim (max 140 chars).' },
    verdict: { type: 'string', enum: ['TRUE', 'FALSE', 'UNVERIFIED'] },
    claim: { type: 'string', description: 'One concise sentence summarizing the claim (max 110 chars).' },
    reason: { type: 'string', description: '2-3 short sentences justifying the verdict (max 240 chars).' },
  },
  required: ['quote', 'verdict', 'claim', 'reason'],
} as const;

export const FACT_CHECKER_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: CLAIM_ITEM_SCHEMA,
    },
  },
  required: ['claims'],
} as const;

export function parseFactCheckerResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw);
  const claims: FactClaim[] = items.map((c) => ({
    quote: coerceQuote(c['quote']),
    verdict: normalizeFactVerdict(c['verdict']),
    claim: trimTo(typeof c['claim'] === 'string' ? c['claim'] : '', 110),
    reason: trimTo(typeof c['reason'] === 'string' ? c['reason'] : '', 240),
  }));
  if (claims.length === 0) {
    claims.push({ quote: '', verdict: 'UNVERIFIED', claim: '', reason: '' });
  }
  return { type: 'fact-check', claims };
}

function normalizeFactVerdict(value: unknown): 'TRUE' | 'FALSE' | 'UNVERIFIED' {
  if (typeof value !== 'string') return 'UNVERIFIED';
  const upper = value.trim().toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return upper;
  return 'UNVERIFIED';
}
