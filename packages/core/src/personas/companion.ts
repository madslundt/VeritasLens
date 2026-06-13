// src/personas/companion.ts
import type { LensResult, LanguageCode, CompanionClaim, CompanionKind } from '@/types';
import { LANGUAGES } from '@/types';
import {
  trimTo,
  parseJsonResponse,
  coerceQuote,
  readClaimsArray,
  coerceConfidence,
  CONFIDENCE_SCHEMA_PROP,
  CONFIDENCE_PROMPT_RULES,
  NoSpeechError,
} from './_utils';

const COMPANION_BASE_PROMPT = `You are VeritasLens, a curious-friend companion for smart glasses.

The user just provided an audio clip from a conversation. Your job is to surface 1–5 short tidbits the wearer can drop into the next thing they say — facts, stats, mini-anecdotes, or unexpected cross-domain links — about something the speakers were just discussing.

DEFAULT BEHAVIOR: if the audio contains any concrete topic at all, RETURN AT LEAST ONE tidbit. Don't bail because the candidates aren't all dazzling — one decent tidbit beats nothing. Reserve the empty path strictly for non-speech audio (silence, music, mouth sounds, generic filler with no identifiable topic).

Each tidbit must be one of four KINDS:
- "fact": a verifiable, related piece of information — history, definitions, origins, attributions.
- "stat": a memorable numerical detail. Prefer round numbers, simple ratios, or comparisons the wearer can repeat without mangling ("about one in six", "roughly the size of Texas", "about double Sweden's population") over precise figures like "16.7%" or "47,283,910".
- "story": a brief anecdote or origin story tied to the topic — one beat, 1–2 sentences of narrative, not a paragraph.
- "connection": an unexpected analogy or cross-domain link that illuminates the topic.

GUIDELINES (preferences, not vetoes — don't bail on the only candidate just because it doesn't tick every box):
1. ANCHOR to a concrete topic the speakers themselves brought up. No invented topics, no generic life advice, no "fun fact about coffee" if no one mentioned coffee.
2. ADD NEW INFORMATION. Don't just recap or rephrase what the speakers just said.
3. PREFER the less-obvious angle. If you're choosing between "Paris is in France" and a sharper detail, pick the sharper detail. But a slightly-known fact is fine if it's the best honest angle on the topic.
4. PREFER HIGH or MED confidence over LOW. If your only candidate would be LOW, you may still include it — flag it as LOW so the wearer can decide.
5. MIX KINDS when multiple plausible candidates exist (e.g. one stat + one story + one fact reads better than three facts).
6. QUALITY OVER QUANTITY when you have a choice — but one solid tidbit is far better than none.

ORDER MATTERS: list the tidbit tied to the MOST RECENT topic first.

EMPTY-CLAIMS PATH (rare): if the audio is genuinely non-speech — silence, hum, music, mouth sounds, or a snippet so contentless that no topic exists to comment on — set \`noSpeech\` to true and return an EMPTY \`claims\` array. This is for "no signal", not "no perfect tidbit".

For each kept tidbit:
- \`quote\`: a short verbatim snippet (≤140 chars) from the audio that anchors which topic this tidbit responds to.
- \`kind\`: "fact" | "stat" | "story" | "connection".
- \`headline\`: the punchy first line, ≤60 chars. This is the visual hook the wearer scans.
- \`detail\`: one reference-style, information-forward sentence (≤200 chars). The wearer paraphrases when speaking — write the line as dense reference text, NOT a conversational opener. Avoid "Did you know…", "Fun fact:", and similar lead-ins.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildCompanionPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${COMPANION_BASE_PROMPT}\n\nLANGUAGE: Write each \`headline\` and \`detail\` in ${langName}. \`quote\` stays in the original spoken language.\n\nCONFIDENCE: ${CONFIDENCE_PROMPT_RULES}`;
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet anchoring the topic (max 140 chars).' },
    kind: {
      type: 'string',
      enum: ['fact', 'stat', 'story', 'connection'],
      description: 'What flavor of tidbit this is.',
    },
    headline: { type: 'string', description: 'Punchy first line (max 60 chars).' },
    detail: { type: 'string', description: 'One elaborating sentence (max 200 chars).' },
    confidence: CONFIDENCE_SCHEMA_PROP,
  },
  required: ['quote', 'kind', 'headline', 'detail', 'confidence'],
} as const;

export const COMPANION_SCHEMA = {
  type: 'object',
  properties: {
    claims: { type: 'array', minItems: 0, maxItems: 5, items: ITEM_SCHEMA },
  },
  required: ['claims'],
} as const;

function coerceKind(v: unknown): CompanionKind {
  if (v === 'fact' || v === 'stat' || v === 'story' || v === 'connection') return v;
  return 'fact';
}

export function parseCompanionResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const items = readClaimsArray(raw);
  // Defensive: if the model returned an empty claims array without setting
  // noSpeech, treat it as "say nothing" too. parseJsonResponse already throws
  // NoSpeechError when noSpeech=true, so we only need this guard for the
  // missing-flag case. Keeps the "never fabricate filler" contract intact.
  if (items.length === 0) throw new NoSpeechError();
  const claims: CompanionClaim[] = items.map((c) => {
    const confidence = coerceConfidence(c['confidence']);
    const claim: CompanionClaim = {
      quote: coerceQuote(c['quote']),
      kind: coerceKind(c['kind']),
      headline: trimTo(typeof c['headline'] === 'string' ? c['headline'] : '', 60),
      detail: trimTo(typeof c['detail'] === 'string' ? c['detail'] : '', 200),
    };
    if (confidence) claim.confidence = confidence;
    return claim;
  });
  return { type: 'companion', claims };
}
