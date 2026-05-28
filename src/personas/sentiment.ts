// src/personas/sentiment.ts
import type { SentimentClaim, LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote, readClaimsArray } from './_utils';

const SENTIMENT_PROMPT = `You are VeritasLens, a real-time analysis assistant for smart glasses.

The user just provided a short audio clip. Identify the dominant emotional tone of the speaker — not the topic, but the intent and affect. Return ONE SentimentClaim.

- quote: The most tonally-loaded phrase from the audio (≤140 chars).
- tone: POSITIVE | NEGATIVE | NEUTRAL | MIXED. Use MIXED when the speaker expresses contradictory signals.
- explanation: 2–3 sentences on what the tone signals about intent or affect (≤280 chars).

If no clear speech is detected, set noSpeech to true.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildSentimentPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return (
    `${SENTIMENT_PROMPT}\n\n` +
    `LANGUAGE: Write explanation in ${langName}. ` +
    `The quote must stay in the original spoken language. ` +
    `The tone field MUST stay as one of "POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED" regardless of language.`
  );
}

const CLAIM_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Most tonally-loaded phrase (max 140 chars).' },
    tone: { type: 'string', enum: ['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'MIXED'] },
    explanation: { type: 'string', description: '2–3 sentences on tone intent (max 280 chars).' },
  },
  required: ['quote', 'tone', 'explanation'],
} as const;

export const SENTIMENT_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: CLAIM_ITEM_SCHEMA,
    },
  },
  required: ['claims'],
} as const;

export function parseSentimentResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw).slice(0, 1);
  const claims: SentimentClaim[] = items.map((c) => ({
    quote: coerceQuote(c['quote']),
    tone: normalizeTone(c['tone']),
    explanation: trimTo(typeof c['explanation'] === 'string' ? c['explanation'] : '', 280),
  }));
  if (claims.length === 0) {
    claims.push({ quote: '', tone: 'NEUTRAL', explanation: '' });
  }
  return { type: 'sentiment', claims };
}

function normalizeTone(value: unknown): 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED' {
  if (typeof value !== 'string') return 'NEUTRAL';
  switch (value.trim().toUpperCase()) {
    case 'POSITIVE': return 'POSITIVE';
    case 'NEGATIVE': return 'NEGATIVE';
    case 'MIXED':    return 'MIXED';
    default:         return 'NEUTRAL';
  }
}
