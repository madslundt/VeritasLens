// src/personas/translation.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote } from './_utils';

export function buildTranslationPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `You are VeritasLens, a real-time translation assistant for smart glasses.

The user just provided an audio clip of recent conversation. Translate the spoken content into ${langName}.

Rules:
- Translate only; do not summarize or editorialize.
- If the audio is already in ${langName}, provide the original text unchanged.
- Keep the translation concise (max 300 characters).
- Include a short verbatim \`quote\` (≤140 chars) of the original spoken text in its source language.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;
}

export const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'Verbatim audio snippet in source language (max 140 chars).' },
    translatedText: { type: 'string', description: 'The translated text (max 300 chars).' },
  },
  required: ['translatedText'],
} as const;

export function parseTranslationResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  return {
    type: 'translation',
    translatedText: trimTo(typeof raw['translatedText'] === 'string' ? raw['translatedText'] : '', 300),
    quote: coerceQuote(raw['quote']),
  };
}
