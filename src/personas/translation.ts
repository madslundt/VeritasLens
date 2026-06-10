// src/personas/translation.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { parseJsonResponse, isRecord } from './_utils';

/** What the prompt builder needs to know about the wearer's source-language
 *  preference. `'auto'` means detect the spoken language. A non-empty array
 *  restricts the speaker to one of the listed codes — the LLM is told to set
 *  noSpeech if none match, which lets the wearer pin a "I'm at a Spanish
 *  conversation, ignore everything else" mode. */
export type TranslationSourceConfig = LanguageCode[] | 'auto';

const BASE_PROMPT = `You are VeritasLens running in TRANSLATE mode for smart glasses.

The wearer is listening to someone else speak in a foreign language. From the audio:

1. Detect the language being spoken and return it as \`sourceLanguage\` (BCP-47 short code like "es", "fr", "de", or "unknown" if you cannot tell).
2. Transcribe the most recent meaningful utterance verbatim in the ORIGINAL language as \`sourceText\` (≤200 chars; if the audio is longer, take the latest complete thought).
3. Provide a natural translation of \`sourceText\` into the wearer's display language as \`translatedText\`.
4. Suggest EXACTLY 3 short reply starters the wearer could say back, each ≤10 words. Vary the intent across the 3 — for example: a direct/affirmative reply, a follow-up question, and an empathetic or acknowledging line. Match the social register implied by the conversation (formal at a café or interview, casual with a friend). Each starter object has:
   - \`source\`: starter in the SAME language as \`sourceText\` (what the wearer would say out loud).
   - \`translated\`: same starter rendered in the wearer's display language.

Output strict JSON matching the provided schema. No prose outside JSON.
If no clear human speech is detected, set noSpeech=true and return empty strings / empty arrays.`;

export function buildTranslationPrompt(
  lang: LanguageCode,
  source: TranslationSourceConfig = 'auto',
): string {
  const targetName = LANGUAGES[lang] ?? 'English';
  const sourceDirective =
    source === 'auto' || source.length === 0
      ? 'The speaker may be using ANY language; detect it.'
      : `The speaker is using ONE of: ${source
          .map((c) => `${c} (${LANGUAGES[c] ?? c})`)
          .join(', ')}. If they are clearly using a different language, set sourceLanguage="unknown" and noSpeech=true.`;
  return (
    `${BASE_PROMPT}\n\n` +
    `TARGET LANGUAGE: ${targetName}. Render \`translatedText\` and each starter's \`translated\` field in ${targetName}. ` +
    `\`sourceText\` and each starter's \`source\` field MUST stay in the original spoken language. ` +
    `\`sourceLanguage\` is always a BCP-47 short code (or "unknown") regardless of TARGET LANGUAGE.\n\n` +
    `SOURCE: ${sourceDirective}`
  );
}

const STARTER_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    source: { type: 'string', description: 'Starter in the original spoken language (≤10 words).' },
    translated: { type: 'string', description: 'Same starter translated into the wearer display language.' },
  },
  required: ['source', 'translated'],
} as const;

export const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    sourceLanguage: { type: 'string', description: 'BCP-47 short code like "es", "fr"; or "unknown".' },
    sourceText: { type: 'string', description: 'Verbatim transcript in the spoken language (≤200 chars).' },
    translatedText: { type: 'string', description: 'Natural translation into the wearer display language.' },
    replyStarters: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: STARTER_ITEM_SCHEMA,
    },
  },
  required: ['sourceLanguage', 'sourceText', 'translatedText', 'replyStarters'],
} as const;

function clipShort(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  return s.length <= max ? s : s.slice(0, max);
}

export function parseTranslationResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const sourceLanguage = (typeof raw['sourceLanguage'] === 'string'
    ? raw['sourceLanguage'].trim().toLowerCase()
    : 'unknown'
  ) || 'unknown';
  const sourceText = clipShort(raw['sourceText'], 220);
  const translatedText = clipShort(raw['translatedText'], 220);
  const startersRaw = Array.isArray(raw['replyStarters']) ? raw['replyStarters'] : [];
  const replyStarters = startersRaw
    .slice(0, 3)
    .filter((s): s is Record<string, unknown> => isRecord(s))
    .map((s) => ({
      source: clipShort(s['source'], 80),
      translated: clipShort(s['translated'], 80),
    }));
  return {
    type: 'translation',
    sourceLanguage,
    sourceText,
    translatedText,
    replyStarters,
  };
}
