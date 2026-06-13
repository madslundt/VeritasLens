// src/personas/trivia.ts
import type { LensResult, LanguageCode, TriviaClaim } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote, readClaimsArray, coerceConfidence, CONFIDENCE_SCHEMA_PROP, CONFIDENCE_PROMPT_RULES } from './_utils';

const TRIVIA_BASE_PROMPT = `You are VeritasLens, a trivia assistant for smart glasses.

The user just provided an audio clip likely containing one or more trivia or factual questions.

1. Identify the trivia or factual questions being asked. Return up to FIVE distinct questions, but ONLY include one if you clearly understand what was asked and it has a definitive factual answer. Skip mid-sentences, unclear phrases, repeated points, and questions you can't answer with confidence — fewer high-confidence answers is always better than padding the list.
2. For each, include a short verbatim quote (≤140 chars) from the audio that captures how the question was asked.
3. For each, restate the question (max 140 chars), provide the correct definitive answer in one short phrase (max 60 chars), and one brief explanatory sentence (max 140 chars). The FIRST half of the description should be the single most repeatable supporting fact (a number, a date, a place) — the wearer skims that and uses it in their next sentence.
4. Optionally include "alt": a common alternative phrasing of the answer (≤60 chars). Examples: "Paris" + alt "Paris, France"; "Einstein" + alt "Albert Einstein". Use "" when there is no useful alternative phrasing.
5. ORDER MATTERS: list the MOST RECENT question first (the one spoken closest to the end of the audio).

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildTriviaPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${TRIVIA_BASE_PROMPT}\n\nLANGUAGE: Write each \`question\`, \`answer\`, \`alt\`, and \`description\` in ${langName}. \`quote\` stays in the original spoken language.\n\nCONFIDENCE: ${CONFIDENCE_PROMPT_RULES}`;
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet (max 140 chars).' },
    question: { type: 'string', description: 'The trivia question as asked (max 140 chars).' },
    answer: { type: 'string', description: 'The correct answer (max 60 chars).' },
    alt: { type: 'string', description: 'Optional alternative phrasing of the answer (max 60 chars). Empty when none.' },
    description: { type: 'string', description: 'One repeatable supporting fact (max 140 chars).' },
    confidence: CONFIDENCE_SCHEMA_PROP,
  },
  required: ['quote', 'question', 'answer', 'alt', 'description', 'confidence'],
} as const;

export const TRIVIA_SCHEMA = {
  type: 'object',
  properties: {
    claims: { type: 'array', minItems: 1, maxItems: 5, items: ITEM_SCHEMA },
  },
  required: ['claims'],
} as const;

export function parseTriviaResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw);
  const claims: TriviaClaim[] = items.map((c) => {
    const confidence = coerceConfidence(c['confidence']);
    const alt = trimTo(typeof c['alt'] === 'string' ? c['alt'] : '', 60);
    const claim: TriviaClaim = {
      quote: coerceQuote(c['quote']),
      question: trimTo(typeof c['question'] === 'string' ? c['question'] : '', 140),
      answer: trimTo(typeof c['answer'] === 'string' ? c['answer'] : '', 60),
      description: trimTo(typeof c['description'] === 'string' ? c['description'] : '', 140),
    };
    if (alt) claim.alt = alt;
    if (confidence) claim.confidence = confidence;
    return claim;
  });
  if (claims.length === 0) {
    claims.push({ quote: '', question: '', answer: '', description: '' });
  }
  return { type: 'trivia', claims };
}
