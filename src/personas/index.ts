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
import {
  getTranslationSchema,
  buildTranslationPrompt,
  parseTranslationResponse,
} from './translation';
import { settings } from '@/state/store';

export type PersonaId = string;

/**
 * Optional grounding capability a lens can opt into. When set, the runtime
 * forwards a `tools` array to Gemini so the model can resolve check-worthy
 * claims against fresh web results instead of from training memory.
 *
 * `google_search` enables the GoogleSearch tool on Gemini 2.x. Adds ~500ms–1s
 * to wall-clock per call; restricted to lenses where factual freshness is the
 * point (fact-check, stats-check, trivia, devil's advocate). Sentiment, eli5,
 * fallacy, bias, key questions, and translation are deliberately off — they
 * are interpretive, not retrieval-bound, so grounding wouldn't sharpen them
 * and would just spend latency.
 */
export type LensGrounding = 'google_search';

/**
 * Persona-level opt-in for intra-claim heading streaming. When set, the
 * lifecycle subscribes to `valueChunk` events for `field` and, every ~150ms,
 * synthesizes a partial `LensResult` via `synthesize(partial)` so the wearer
 * sees the heading text fill in character-by-character before the full
 * response lands.
 *
 * Scoped narrowly to lenses where a single short string carries the wearer's
 * answer (Trivia's `answer`, Translate's `translatedText`). Multi-claim
 * lenses already get claim-by-claim streaming via `onPartialClaim` — adding
 * this on top would just cause the HUD to strobe.
 */
export interface StreamHeadingConfig {
  /** JSON property name whose mid-stream content drives the heading slot. */
  field: string;
  /**
   * Other top-level scalar properties whose completed values should be
   * threaded into `synthesize` via the `fields` map. Gemini emits scalars in
   * schema order, so fields declared BEFORE the heading field in the schema
   * are guaranteed to have arrived by the time the heading starts streaming
   * — useful for Translate, where `sourceLanguage` and `sourceText` close
   * before `translatedText` begins.
   */
  carryFields?: readonly string[];
  /**
   * Build a placeholder `LensResult` whose heading slot carries `partial`.
   * `fields` contains any `carryFields` that finished parsing so far (may be
   * absent on the first commit if the heading happens to start streaming
   * before any of the carry fields close). Other LensResult slots should be
   * empty strings so the HUD's formatter renders cleanly.
   */
  synthesize: (
    partial: string,
    fields: Readonly<Record<string, string | number | boolean | null>>,
  ) => LensResult;
}

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
  /** Web-grounding capability. Omit when the lens is interpretive. */
  grounding?: LensGrounding;
  /** Opt-in intra-claim heading streaming. Omit when the lens isn't worth
   *  streaming character-by-character (most multi-claim lenses). */
  streamHeading?: StreamHeadingConfig;
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
    grounding: 'google_search',
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
    grounding: 'google_search',
    streamHeading: {
      field: 'answer',
      // Trivia's `question` and `quote` live inside the claim object, not at
      // top level — the parser's field-event path only sees top-level
      // scalars, so there's nothing to carry. Populating only `answer`
      // keeps the page minimal during streaming; question/description
      // appear once the full claim closes via the normal final-result render.
      synthesize: (partial) => ({
        type: 'trivia',
        claims: [{ quote: '', question: '', answer: partial, description: '' }],
      }),
    },
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
    grounding: 'google_search',
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
    grounding: 'google_search',
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
    id: 'translation',
    name: 'Translate',
    description:
      'Listens to someone else speak in a foreign language and shows their words plus a translation. In Converse mode (default) also suggests 3 reply starters you can say back. Tip: enable Auto mode in Settings for hands-free continuous translation.',
    hint: 'Tap to translate',
    // The translation persona needs to read the wearer's source-language hint
    // (auto vs a fixed allow-list) AND the mode (converse vs listen-in) at
    // call time, so we close over the store inside the wrapper. The schema
    // also branches on mode (listen-in declares `replyStarters` as an empty
    // array in the schema so the LLM doesn't generate them), so it's exposed
    // as a getter rather than a static value. Object-spread captures the
    // getter's current value (lifecycle.ts:1312 does `{...persona, ...}`),
    // which is the snapshot we want.
    buildPrompt: (lang) =>
      buildTranslationPrompt(
        lang,
        settings().translationSourceLanguages,
        settings().translationMode,
      ),
    get schema() { return getTranslationSchema(settings().translationMode); },
    parse: parseTranslationResponse,
    streamHeading: {
      field: 'translatedText',
      // sourceLanguage + sourceText are declared BEFORE translatedText in
      // the schema, so Gemini closes them as `field` events before the
      // heading starts streaming. Carrying them through lets the HUD show
      // the language code on top of the page right from the first frame
      // instead of waiting for the final commit. Starters stay empty
      // during streaming so the picker chrome doesn't flash with
      // placeholder rows before the real ones land.
      carryFields: ['sourceLanguage', 'sourceText'],
      synthesize: (partial, fields) => ({
        type: 'translation',
        sourceLanguage: typeof fields['sourceLanguage'] === 'string' ? fields['sourceLanguage'] : '',
        sourceText: typeof fields['sourceText'] === 'string' ? fields['sourceText'] : '',
        translatedText: partial,
        replyStarters: [],
      }),
    },
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

