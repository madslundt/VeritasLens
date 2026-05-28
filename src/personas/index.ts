// src/personas/index.ts
import { createSignal } from 'solid-js';
import type { LensResult, LanguageCode } from '@/types';
import { FACT_CHECKER_SCHEMA, buildFactCheckerPrompt, parseFactCheckerResponse } from './factChecker';
import { TRIVIA_SCHEMA, buildTriviaPrompt, parseTriviaResponse } from './trivia';
import { LOGICAL_FALLACY_SCHEMA, buildLogicalFallacyPrompt, parseLogicalFallacyResponse } from './logicalFallacy';
import { STATS_CHECK_SCHEMA, buildStatsCheckPrompt, parseStatsCheckResponse } from './statsCheck';
import { BIAS_DETECTOR_SCHEMA, buildBiasDetectorPrompt, parseBiasDetectorResponse } from './biasDetector';
import { ELI5_SCHEMA, buildEli5Prompt, parseEli5Response } from './eli5';
import { DEVILS_ADVOCATE_SCHEMA, buildDevilsAdvocatePrompt, parseDevilsAdvocateResponse } from './devilsAdvocate';
import { KEY_QUESTIONS_SCHEMA, buildKeyQuestionsPrompt, parseKeyQuestionsResponse } from './keyQuestions';
import { SENTIMENT_SCHEMA, buildSentimentPrompt, parseSentimentResponse } from './sentiment';
import { AUTO_CLASSIFIER_SCHEMA, buildAutoPrompt, parseAutoResponse } from './auto';
import {
  MEETING_PREP_ID,
  buildMeetingPrepPromptStub,
  parseMeetingPrepResponseStub,
} from './meetingPrep';

export type PersonaId = string;

export interface Persona {
  id: PersonaId;
  name: string;
  description: string;
  hint: string;
  /** Returns the fully-built, language-aware system prompt. */
  buildPrompt: (lang: LanguageCode) => string;
  /** Gemini responseSchema — opaque to the runtime, forwarded to the API. */
  schema: unknown;
  parse: (text: string) => LensResult;
  builtin: true;
}

const BUILTINS: Persona[] = [
  {
    id: 'auto',
    name: 'Auto',
    description:
      'Picks the best lens for what you asked, then runs it. Covers every lens except Meeting Prep. Makes an extra request to choose the lens, so it takes a bit longer.',
    hint: 'Tap and let VeritasLens choose',
    buildPrompt: buildAutoPrompt,
    schema: AUTO_CLASSIFIER_SCHEMA,
    parse: parseAutoResponse,
    builtin: true,
  },
  {
    id: 'fact-checker',
    name: 'Fact Check',
    description: 'Labels the most check-worthy claim TRUE / FALSE / UNVERIFIED.',
    hint: 'Tap to fact-check',
    buildPrompt: buildFactCheckerPrompt,
    schema: FACT_CHECKER_SCHEMA,
    parse: parseFactCheckerResponse,
    builtin: true,
  },
  {
    id: 'trivia',
    name: 'Trivia',
    description: 'Answers trivia questions with a direct answer and brief description.',
    hint: 'Tap for the answer',
    buildPrompt: buildTriviaPrompt,
    schema: TRIVIA_SCHEMA,
    parse: parseTriviaResponse,
    builtin: true,
  },
  {
    id: 'logical-fallacy',
    name: 'Fallacy Check',
    description: 'Names any logical fallacy present in the argument.',
    hint: 'Tap to check the argument',
    buildPrompt: buildLogicalFallacyPrompt,
    schema: LOGICAL_FALLACY_SCHEMA,
    parse: parseLogicalFallacyResponse,
    builtin: true,
  },
  {
    id: 'stats-check',
    name: 'Stats Check',
    description: 'Rates a numerical claim as PLAUSIBLE or SUSPICIOUS.',
    hint: 'Tap to check the numbers',
    buildPrompt: buildStatsCheckPrompt,
    schema: STATS_CHECK_SCHEMA,
    parse: parseStatsCheckResponse,
    builtin: true,
  },
  {
    id: 'bias-detector',
    name: 'Bias Check',
    description: 'Detects political, emotional, or factional bias in statements.',
    hint: 'Tap to detect bias',
    buildPrompt: buildBiasDetectorPrompt,
    schema: BIAS_DETECTOR_SCHEMA,
    parse: parseBiasDetectorResponse,
    builtin: true,
  },
  {
    id: 'eli5',
    name: 'Simplify',
    description: 'Explains jargon or complex statements in plain language.',
    hint: 'Tap to simplify',
    buildPrompt: buildEli5Prompt,
    schema: ELI5_SCHEMA,
    parse: parseEli5Response,
    builtin: true,
  },
  {
    id: 'devils-advocate',
    name: "Devil's Advocate",
    description: 'Surfaces the strongest counterargument to the main position being argued.',
    hint: 'Tap to find the counter',
    buildPrompt: buildDevilsAdvocatePrompt,
    schema: DEVILS_ADVOCATE_SCHEMA,
    parse: parseDevilsAdvocateResponse,
    builtin: true,
  },
  {
    id: 'key-questions',
    name: 'Key Questions',
    description: 'Identifies the most important open or unanswered questions raised by the conversation.',
    hint: 'Tap for key questions',
    buildPrompt: buildKeyQuestionsPrompt,
    schema: KEY_QUESTIONS_SCHEMA,
    parse: parseKeyQuestionsResponse,
    builtin: true,
  },
  {
    id: 'sentiment',
    name: 'Tone Check',
    description: 'Reads the emotional tone and intent behind what was said.',
    hint: 'Tap to read the tone',
    buildPrompt: buildSentimentPrompt,
    schema: SENTIMENT_SCHEMA,
    parse: parseSentimentResponse,
    builtin: true,
  },
  {
    id: MEETING_PREP_ID,
    name: 'Meeting Prep',
    description:
      'Real-time answers grounded in context you prepared on your phone — general notes plus optional labeled attachments (contracts, prepared questions).',
    hint: 'Tap to ask about what was said',
    // Prompt and schema are built per-tap from the user's section list, so the
    // lifecycle special-cases this lens instead of going through the generic
    // path. Same shape as the Auto lens.
    buildPrompt: buildMeetingPrepPromptStub,
    schema: {},
    parse: parseMeetingPrepResponseStub,
    builtin: true,
  },
];

const [personasSignal] = createSignal<Persona[]>(BUILTINS);

export const personas = personasSignal;

export function getPersona(id: PersonaId): Persona | undefined {
  return personasSignal().find((p) => p.id === id);
}

/**
 * Personas shown in the HUD picker. Currently identical to the full list —
 * kept as a separate function so future picker-only filtering has a single
 * call site to update.
 */
export function getPickerPersonas(): Persona[] {
  return personasSignal();
}

