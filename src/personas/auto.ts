// src/personas/auto.ts
import type { LanguageCode, LensResult } from '@/types';
import { LANGUAGES } from '@/types';
import { parseJsonResponse } from './_utils';

/** Lens IDs the Auto classifier is allowed to pick. */
export const AUTO_LENS_CANDIDATES = [
  'fact-checker',
  'trivia',
  'logical-fallacy',
  'stats-check',
  'bias-detector',
  'eli5',
] as const;

export type AutoLensCandidate = (typeof AUTO_LENS_CANDIDATES)[number];

export const AUTO_CLASSIFIER_PROMPT = `You are VeritasLens, a real-time analysis assistant for smart glasses.

The user just provided a short audio clip. Your job is to pick the SINGLE best analysis lens to apply, from these options:

- "fact-checker": A specific factual claim is being made that can be verified against reliable knowledge (history, geography, science, attributions).
- "trivia": Someone is asking or wondering about a piece of common knowledge — a question with a direct factual answer.
- "logical-fallacy": An argument is being made that likely contains a logical fallacy (ad hominem, straw man, false dilemma, slippery slope, etc.).
- "stats-check": A numerical or statistical claim is being made — percentages, large numbers, comparisons, or rates.
- "bias-detector": Loaded language, charged political/emotional rhetoric, or one-sided framing that hints at bias.
- "eli5": Jargon-heavy, technical, or unusually complex language that a listener would benefit from having explained in plain terms.

Pick exactly one. If multiple lenses could plausibly apply, pick the SINGLE most useful one for the listener. Prefer "fact-checker" over "trivia" when the speaker is asserting a claim rather than asking. Prefer "stats-check" over "fact-checker" when the claim is primarily numerical.

If no clear human speech is detected, set noSpeech to true.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildAutoPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return (
    `${AUTO_CLASSIFIER_PROMPT}\n\n` +
    `LANGUAGE: The \`reason\` field may be written in ${langName}. ` +
    `The \`chosenLensId\` field MUST stay as one of the literal IDs above regardless of language.`
  );
}

export const AUTO_CLASSIFIER_SCHEMA = {
  type: 'object',
  properties: {
    chosenLensId: {
      type: 'string',
      enum: [...AUTO_LENS_CANDIDATES],
      description: 'The lens that best fits the audio content.',
    },
    reason: {
      type: 'string',
      description: 'Brief explanation for the choice (max 80 chars).',
    },
  },
  required: ['chosenLensId'],
} as const;

export interface AutoClassification {
  chosenLensId: AutoLensCandidate;
  reason?: string;
}

export function parseAutoClassifierResponse(text: string): AutoClassification {
  const raw = parseJsonResponse(text);
  const id = typeof raw['chosenLensId'] === 'string' ? raw['chosenLensId'] : '';
  const chosenLensId = (AUTO_LENS_CANDIDATES as readonly string[]).includes(id)
    ? (id as AutoLensCandidate)
    : 'fact-checker';
  const reason = typeof raw['reason'] === 'string' ? raw['reason'] : undefined;
  return { chosenLensId, reason };
}

/**
 * Placeholder parse for the Persona interface. The Auto lens uses a two-call flow
 * (classify → run chosen lens) handled in the runtime lifecycle, so this parser
 * should never be invoked. Throws to surface logic errors loudly if it ever is.
 */
export function parseAutoResponse(_text: string): LensResult {
  throw new Error('Auto lens parse() should not be called directly — handled by lifecycle dispatch.');
}
