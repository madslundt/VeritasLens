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

/** Per-lens mode. `'converse'` generates 3 reply starters (the wearer plans
 *  to talk back). `'listen-in'` skips the starters — the wearer is just
 *  eavesdropping (tour guide, foreign meeting) and wants minimal chrome. */
export type TranslationMode = 'converse' | 'listen-in';

const BASE_PROMPT_HEADER = `You are VeritasLens running in TRANSLATE mode for smart glasses.

The wearer is listening to someone else speak in a foreign language. From the audio:

1. Detect the language being spoken and return it as \`sourceLanguage\` (BCP-47 short code like "es", "fr", "de", or "unknown" if you cannot tell).
2. Transcribe the most recent meaningful utterance verbatim in the ORIGINAL language as \`sourceText\` (≤200 chars; if the audio is longer, take the latest complete thought).
3. Provide a natural translation of \`sourceText\` into the wearer's display language as \`translatedText\`.`;

const CONVERSE_STARTERS_CLAUSE = `4. Suggest EXACTLY 3 short reply starters the wearer could say back, each ≤10 words. Vary the intent across the 3 — for example: a direct/affirmative reply, a follow-up question, and an empathetic or acknowledging line. Match the social register implied by the conversation (formal at a café or interview, casual with a friend). Each starter object has:
   - \`source\`: starter in the SAME language as \`sourceText\` (what the wearer would say out loud).
   - \`translated\`: same starter rendered in the wearer's display language.`;

const LISTEN_IN_STARTERS_CLAUSE = `4. Return \`replyStarters\` as an empty array \`[]\`. The wearer is in LISTEN-IN mode — they are not participating in the conversation, only following along, so do not waste tokens generating starters.`;

const TAIL = `Output strict JSON matching the provided schema. No prose outside JSON.
If no clear human speech is detected, set noSpeech=true and return empty strings / empty arrays.`;

export function buildTranslationPrompt(
  lang: LanguageCode,
  source: TranslationSourceConfig = 'auto',
  mode: TranslationMode = 'converse',
): string {
  const targetName = LANGUAGES[lang] ?? 'English';
  const sourceDirective =
    source === 'auto' || source.length === 0
      ? 'The speaker may be using ANY language; detect it.'
      : `The speaker is using ONE of: ${source
          .map((c) => `${c} (${LANGUAGES[c] ?? c})`)
          .join(', ')}. If they are clearly using a different language, set sourceLanguage="unknown" and noSpeech=true.`;
  const startersClause = mode === 'listen-in' ? LISTEN_IN_STARTERS_CLAUSE : CONVERSE_STARTERS_CLAUSE;
  const targetClause = mode === 'listen-in'
    ? `TARGET LANGUAGE: ${targetName}. Render \`translatedText\` in ${targetName}. ` +
      `\`sourceText\` MUST stay in the original spoken language. ` +
      `\`sourceLanguage\` is always a BCP-47 short code (or "unknown") regardless of TARGET LANGUAGE.`
    : `TARGET LANGUAGE: ${targetName}. Render \`translatedText\` and each starter's \`translated\` field in ${targetName}. ` +
      `\`sourceText\` and each starter's \`source\` field MUST stay in the original spoken language. ` +
      `\`sourceLanguage\` is always a BCP-47 short code (or "unknown") regardless of TARGET LANGUAGE.`;
  return (
    `${BASE_PROMPT_HEADER}\n${startersClause}\n\n${TAIL}\n\n` +
    `${targetClause}\n\nSOURCE: ${sourceDirective}`
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

const CONVERSE_SCHEMA = {
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

const LISTEN_IN_SCHEMA = {
  type: 'object',
  properties: {
    sourceLanguage: { type: 'string', description: 'BCP-47 short code like "es", "fr"; or "unknown".' },
    sourceText: { type: 'string', description: 'Verbatim transcript in the spoken language (≤200 chars).' },
    translatedText: { type: 'string', description: 'Natural translation into the wearer display language.' },
    replyStarters: {
      type: 'array',
      minItems: 0,
      maxItems: 0,
      items: STARTER_ITEM_SCHEMA,
    },
  },
  required: ['sourceLanguage', 'sourceText', 'translatedText', 'replyStarters'],
} as const;

/** Pick the response schema that matches the active lens mode. */
export function getTranslationSchema(mode: TranslationMode): unknown {
  return mode === 'listen-in' ? LISTEN_IN_SCHEMA : CONVERSE_SCHEMA;
}

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

// ---------- Say-more expansion ----------

/** Inputs for the "Say more →" follow-up call. The wearer has chosen a
 *  starter on the teleprompter page; we want the LLM to expand it into a
 *  1-3 sentence natural reply in the SAME source language, using recent
 *  conversation as soft context. */
export interface SayMoreArgs {
  /** The starter the wearer picked. */
  starter: { source: string; translated: string };
  /** Wearer's display language. */
  targetLang: LanguageCode;
  /** BCP-47 short code of the foreign side (e.g. "es"). May be "unknown" — in
   *  that case the prompt instructs the LLM to use the same language as the
   *  starter's `source` field. */
  sourceLang: string;
  /** Up to ~3 recent transcripts from the session so the extension can
   *  reference what was just said. Each entry is the OTHER side's text in
   *  the foreign language. Pass the latest last. */
  recentTranscripts: string[];
}

export const SAY_MORE_SCHEMA = {
  type: 'object',
  properties: {
    extendedSource: {
      type: 'string',
      description: 'Extended reply in the original (foreign) language, 1-3 sentences, ≤220 chars.',
    },
    extendedTranslated: {
      type: 'string',
      description: 'Same extended reply translated into the wearer display language.',
    },
  },
  required: ['extendedSource', 'extendedTranslated'],
} as const;

export function buildSayMorePrompt(args: SayMoreArgs): string {
  const targetName = LANGUAGES[args.targetLang] ?? 'English';
  // Use the explicit code when known so the LLM doesn't drift; otherwise
  // anchor on the starter's own language so it can't accidentally extend
  // into a different one.
  const sourceClause =
    args.sourceLang && args.sourceLang !== 'unknown'
      ? `Source language: ${args.sourceLang}.`
      : `Source language: the same language as the chosen starter below.`;
  const recent = args.recentTranscripts.filter((t) => t.trim().length > 0).slice(-3);
  const recentBlock = recent.length > 0
    ? `RECENT CONVERSATION (the other person, foreign language; latest last):\n${recent.map((t) => `- ${t}`).join('\n')}\n\n`
    : '';
  return (
    `You are VeritasLens in TRANSLATE/SAY-MORE mode for smart glasses.\n\n` +
    `The wearer is in a conversation. They picked the short starter below and want a longer, ` +
    `natural-sounding 1-3 sentence reply they can read aloud. Extend the starter into a complete ` +
    `thought that fits the conversation's social register. Stay in the SOURCE language for ` +
    `\`extendedSource\` (this is what the wearer will say out loud). Translate the same line into ` +
    `${targetName} for \`extendedTranslated\` (this is what they read).\n\n` +
    `${sourceClause}\n\n` +
    `${recentBlock}` +
    `CHOSEN STARTER (extend this):\n` +
    `- ${args.starter.source}\n` +
    `- (${targetName}) ${args.starter.translated}\n\n` +
    `Output strict JSON matching the provided schema. No prose outside JSON. Keep ` +
    `\`extendedSource\` ≤220 characters.`
  );
}

/** Parse a Say-more response. Returns a tuple of (sourceLine, translatedLine).
 *  Defensive — missing fields fall back to the starter's original text via
 *  the caller. */
export function parseSayMoreResponse(text: string): { extendedSource: string; extendedTranslated: string } {
  const raw = parseJsonResponse(text);
  const extendedSource = clipShort(raw['extendedSource'], 240);
  const extendedTranslated = clipShort(raw['extendedTranslated'], 240);
  return { extendedSource, extendedTranslated };
}

// ---------- Wearer-speak (two-way) ----------

/** Inputs for the wearer-speak prompt. The wearer speaks in their own
 *  language; the LLM transcribes it and translates to the foreign side's
 *  language so the wearer can read the translation aloud. */
export interface WearerSpeakArgs {
  /** The wearer's display language (what they speak in). */
  wearerLang: LanguageCode;
  /** Foreign-side BCP-47 short code, derived from the most recent listening
   *  translation's `sourceLanguage`. Empty / 'unknown' is rejected upstream
   *  before we get here — the lifecycle gates on having a known target. */
  targetLangCode: string;
}

export const WEARER_SPEAK_SCHEMA = {
  type: 'object',
  properties: {
    spoken: {
      type: 'string',
      description: "Verbatim transcript of what the wearer said, in the wearer's display language.",
    },
    translated: {
      type: 'string',
      description: 'Same utterance translated into the target (foreign-side) language.',
    },
  },
  required: ['spoken', 'translated'],
} as const;

export function buildWearerSpeakPrompt(args: WearerSpeakArgs): string {
  const wearerName = LANGUAGES[args.wearerLang] ?? 'English';
  // We pass the code AND, when our LANGUAGES dictionary recognises it, the
  // human name. When the model knows a code we don't (e.g. "tl" Tagalog),
  // the code alone still gets the right output language — Gemini doesn't
  // need our display name to identify a language by ISO code.
  const knownTarget = (Object.keys(LANGUAGES) as LanguageCode[]).includes(
    args.targetLangCode as LanguageCode,
  );
  const targetHint = knownTarget
    ? `${args.targetLangCode} (${LANGUAGES[args.targetLangCode as LanguageCode]})`
    : args.targetLangCode;
  return (
    `You are VeritasLens in TRANSLATE/WEARER-SPEAK mode for smart glasses.\n\n` +
    `The wearer just spoke in ${wearerName}. From the audio, do TWO things:\n\n` +
    `1. \`spoken\`: verbatim transcript of what the wearer said, in ${wearerName} (≤200 chars; take the latest complete thought if the audio is long).\n` +
    `2. \`translated\`: \`spoken\` translated naturally into ${targetHint} so the wearer can read it aloud to the other person.\n\n` +
    `Be conversational and natural — match the social register of the speech (formal / casual / friendly).\n\n` +
    `Output strict JSON matching the provided schema. No prose outside JSON. ` +
    `If no clear human speech is detected, set noSpeech=true and return empty strings.`
  );
}

/** Parse a wearer-speak response. Defensive — both fields default to empty
 *  strings on missing data, and the caller falls back to a generic
 *  "no speech detected" message rather than rendering blank. */
export function parseWearerSpeakResponse(text: string): { spoken: string; translated: string } {
  const raw = parseJsonResponse(text);
  const spoken = clipShort(raw['spoken'], 240);
  const translated = clipShort(raw['translated'], 240);
  return { spoken, translated };
}
