// src/personas/index.ts
import { createSignal } from 'solid-js';
import type { LensResult, LanguageCode } from '@/types';
import { FACT_CHECKER_SCHEMA, buildFactCheckerPrompt, parseFactCheckerResponse } from './factChecker';
import { TRIVIA_SCHEMA, buildTriviaPrompt, parseTriviaResponse } from './trivia';
import { LOGICAL_FALLACY_SCHEMA, buildLogicalFallacyPrompt, parseLogicalFallacyResponse } from './logicalFallacy';
import { STATS_CHECK_SCHEMA, buildStatsCheckPrompt, parseStatsCheckResponse } from './statsCheck';
import { BIAS_DETECTOR_SCHEMA, buildBiasDetectorPrompt, parseBiasDetectorResponse } from './biasDetector';
import { TRANSLATION_SCHEMA, buildTranslationPrompt, parseTranslationResponse } from './translation';
import { ELI5_SCHEMA, buildEli5Prompt, parseEli5Response } from './eli5';
import { SESSION_SUMMARY_SCHEMA, buildSessionSummaryPrompt, parseSessionSummaryResponse } from './sessionSummary';

export type PersonaId = string;

export interface Persona {
  id: PersonaId;
  name: string;
  description: string;
  hint: string;
  /** Returns the fully-built, language-aware system prompt. */
  buildPrompt: (lang: LanguageCode) => string;
  schema: Record<string, unknown>;
  parse: (text: string) => LensResult;
  builtin: true;
}

const BUILTINS: Persona[] = [
  {
    id: 'fact-checker',
    name: 'Fact-Checker',
    description: 'Labels the most check-worthy claim TRUE / FALSE / UNVERIFIED.',
    hint: 'Tap to fact-check',
    buildPrompt: buildFactCheckerPrompt,
    schema: FACT_CHECKER_SCHEMA as unknown as Record<string, unknown>,
    parse: parseFactCheckerResponse,
    builtin: true,
  },
  {
    id: 'trivia',
    name: 'Trivia',
    description: 'Answers trivia questions with a direct answer and brief description.',
    hint: 'Tap for the answer',
    buildPrompt: buildTriviaPrompt,
    schema: TRIVIA_SCHEMA as unknown as Record<string, unknown>,
    parse: parseTriviaResponse,
    builtin: true,
  },
  {
    id: 'logical-fallacy',
    name: 'Fallacy Detector',
    description: 'Names any logical fallacy present in the argument.',
    hint: 'Tap to check the argument',
    buildPrompt: buildLogicalFallacyPrompt,
    schema: LOGICAL_FALLACY_SCHEMA as unknown as Record<string, unknown>,
    parse: parseLogicalFallacyResponse,
    builtin: true,
  },
  {
    id: 'stats-check',
    name: 'Stats Check',
    description: 'Rates a numerical claim as PLAUSIBLE or SUSPICIOUS.',
    hint: 'Tap to check the numbers',
    buildPrompt: buildStatsCheckPrompt,
    schema: STATS_CHECK_SCHEMA as unknown as Record<string, unknown>,
    parse: parseStatsCheckResponse,
    builtin: true,
  },
  {
    id: 'bias-detector',
    name: 'Bias Detector',
    description: 'Detects political, emotional, or factional bias in statements.',
    hint: 'Tap to detect bias',
    buildPrompt: buildBiasDetectorPrompt,
    schema: BIAS_DETECTOR_SCHEMA as unknown as Record<string, unknown>,
    parse: parseBiasDetectorResponse,
    builtin: true,
  },
  {
    id: 'translation',
    name: 'Translation',
    description: 'Translates spoken words into your configured response language.',
    hint: 'Tap to translate',
    buildPrompt: buildTranslationPrompt,
    schema: TRANSLATION_SCHEMA as unknown as Record<string, unknown>,
    parse: parseTranslationResponse,
    builtin: true,
  },
  {
    id: 'eli5',
    name: 'ELI5',
    description: 'Explains jargon or complex statements in plain language.',
    hint: 'Tap to simplify',
    buildPrompt: buildEli5Prompt,
    schema: ELI5_SCHEMA as unknown as Record<string, unknown>,
    parse: parseEli5Response,
    builtin: true,
  },
  {
    id: 'session-summary',
    name: 'Session Summary',
    description: 'Summarizes the conversation recorded so far. Requires extended buffer.',
    hint: 'Tap to summarize',
    buildPrompt: buildSessionSummaryPrompt,
    schema: SESSION_SUMMARY_SCHEMA as unknown as Record<string, unknown>,
    parse: parseSessionSummaryResponse,
    builtin: true,
  },
];

const [personasSignal, setPersonasSignal] = createSignal<Persona[]>(BUILTINS);

export const personas = personasSignal;

export function getPersonas(): Persona[] {
  return personasSignal();
}

export function getPersona(id: PersonaId): Persona | undefined {
  return personasSignal().find((p) => p.id === id);
}

/**
 * Personas shown in the HUD picker.
 * Session Summary is hidden when buffer is 30 s — it needs a longer buffer to be useful.
 */
export function getPickerPersonas(bufferDuration: number): Persona[] {
  return personasSignal().filter((p) => p.id !== 'session-summary' || bufferDuration > 30);
}

export function _setPersonas(next: Persona[]): void {
  setPersonasSignal(next);
}

/** Legacy alias retained so existing imports compile. */
export const PERSONAS = personasSignal;
