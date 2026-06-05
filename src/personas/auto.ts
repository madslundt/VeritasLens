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
  'devils-advocate',
  'key-questions',
  'sentiment',
] as const;

export type AutoLensCandidate = (typeof AUTO_LENS_CANDIDATES)[number];

/** Per-candidate descriptions injected into the classifier prompt. */
const CANDIDATE_DESCRIPTIONS: Record<string, string> = {
  'fact-checker': '"fact-checker": A specific factual claim is being made that can be verified against reliable knowledge (history, geography, science, attributions).',
  'trivia': '"trivia": The speaker asks a direct factual question that has a settled, well-known answer in general knowledge — names, dates, distances, capitals, definitions, numbers, who/what/when/where/how-many style lookups (e.g., "how far is the moon?", "who wrote Hamlet?", "what year did WW2 end?"). Phrased as a question, not an assertion.',
  'logical-fallacy': '"logical-fallacy": An argument is being made that likely contains a logical fallacy (ad hominem, straw man, false dilemma, slippery slope, etc.).',
  'stats-check': '"stats-check": A numerical or statistical claim is being made — percentages, large numbers, comparisons, or rates.',
  'bias-detector': '"bias-detector": Loaded language, charged political/emotional rhetoric, or one-sided framing that hints at bias.',
  'eli5': '"eli5": Jargon-heavy, technical, or unusually complex language that a listener would benefit from having explained in plain terms.',
  'devils-advocate': '"devils-advocate": Someone makes a strong one-sided argument or assertion and the most compelling counterargument is worth surfacing.',
  'key-questions': '"key-questions": The speakers are discussing a topic but failing to raise important follow-up questions a careful listener would want answered. Use this to SURFACE questions the participants are NOT asking but should — not to answer a direct question the speaker just asked.',
  'sentiment': '"sentiment": The emotional tone, intent, or attitude behind what was said is worth examining — charged language, unexpected affect, or notable framing.',
};

const AUTO_CLASSIFIER_PREAMBLE = `You are VeritasLens, a real-time analysis assistant for smart glasses.

The user just provided a short audio clip. Your job is to pick the SINGLE best analysis lens to apply, from these options:`;

const DISAMBIGUATION_NOTES = `Pick exactly one. If multiple lenses could plausibly apply, pick the SINGLE most useful one for the listener.
Prefer "fact-checker" over "trivia" when the speaker is asserting a claim rather than asking.
Prefer "stats-check" over "fact-checker" when the claim is primarily numerical.
Prefer "fact-checker" over "devils-advocate" when a specific factual claim can be verified.
Prefer "trivia" over "key-questions" whenever the speaker directly asks a question that has a settled, well-known factual answer — even if the answer is long or technical.
Prefer "key-questions" over "trivia" only when the audio is a discussion (not a direct question) and a careful listener would want to raise follow-ups the speakers aren't asking themselves.
Prefer "bias-detector" over "sentiment" when the framing is politically or factionally loaded.

If no clear human speech is detected, set noSpeech to true.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

/**
 * Build the Auto classifier prompt. When `enabledCandidates` is supplied the
 * prompt and schema enum are scoped to only those lenses — callers that filter
 * by `autoDisabledLenses` pass the allowed subset so the model can only pick
 * from what the user has enabled. Omit for full-list behaviour (backwards compat).
 */
export function buildAutoPrompt(lang: LanguageCode, enabledCandidates?: string[]): string {
  const langName = LANGUAGES[lang] ?? 'English';
  const candidates = enabledCandidates ?? [...AUTO_LENS_CANDIDATES];
  const descriptions = candidates
    .filter((id) => id in CANDIDATE_DESCRIPTIONS)
    .map((id) => `- ${CANDIDATE_DESCRIPTIONS[id]}`)
    .join('\n');
  const prompt = `${AUTO_CLASSIFIER_PREAMBLE}\n\n${descriptions}\n\n${DISAMBIGUATION_NOTES}`;
  return (
    `${prompt}\n\n` +
    `LANGUAGE: The \`reason\` field may be written in ${langName}. ` +
    `The \`chosenLensId\` field MUST stay as one of the literal IDs above regardless of language.`
  );
}

/** Build a classifier schema scoped to `enabledCandidates`. */
export function buildAutoClassifierSchema(enabledCandidates: string[]) {
  return {
    type: 'object' as const,
    properties: {
      chosenLensId: {
        type: 'string' as const,
        enum: enabledCandidates,
        description: 'The lens that best fits the audio content.',
      },
      reason: {
        type: 'string' as const,
        description: 'Brief explanation for the choice (max 80 chars).',
      },
    },
    required: ['chosenLensId'] as const,
  };
}

/** Static schema used for tests and the `auto` persona registration in BUILTINS. */
export const AUTO_CLASSIFIER_SCHEMA = buildAutoClassifierSchema([...AUTO_LENS_CANDIDATES]);

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
