// src/personas/game.ts
//
// Prompt builders + response shape for the game-mode runtime. Despite the
// "personas" folder, these are NOT registered as `Persona`s — game sessions
// follow a separate runtime track (no audio, multi-step state, dedicated HUD
// pages) and are reached through `runtime/game.ts` rather than the lens picker.
// Colocated here so the prompt + schema sit next to the existing prompt
// builders and follow the same shape.

import { LANGUAGES, GAME_LENGTH, type GameDifficulty, type GameFormat, type GamePreset, type GameQuestion, type LanguageCode, type LensResult } from '@/types';
import { isRecord } from './_utils';

/** Map difficulty into a single instruction line interpolated into prompts. */
function difficultyDirective(difficulty: GameDifficulty): string {
  switch (difficulty) {
    case 'easy':
      return 'Difficulty: EASY. Household-knowledge level. Avoid obscure dates, named figures, or trivia that requires specialist background.';
    case 'medium':
      return 'Difficulty: MEDIUM. Typical-enthusiast level. Most adults with general knowledge of the topic should find this challenging but fair.';
    case 'hard':
      return 'Difficulty: HARD. Specialist-level. Expect specific dates, named figures, and uncommon detail. Do not hand-hold.';
  }
}

function languageDirective(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `LANGUAGE: Write every \`text\`, \`options\`, and \`reveal\` field in ${langName}.`;
}

/** Topic clause. Random presets pass empty topic — the LLM picks. When
 *  `recentRandomTopics` is non-empty the clause appends an explicit
 *  avoid-list so back-to-back Random plays don't all default to "space /
 *  Apollo" (the observed LLM bias when given a wide-open choice).
 *
 *  `recentConversationTopics` is the opposite nudge: when populated, it
 *  PREFERS a topic the wearer was recently talking about (sourced from
 *  session-summary history). The two lists serve different purposes — one
 *  steers away from staleness, the other steers toward relevance — so we
 *  emit them as separate blocks rather than collapsing them. */
function topicClause(
  topic: string,
  recentRandomTopics: readonly string[] = [],
  recentConversationTopics: readonly string[] = [],
): string {
  const trimmed = topic.trim();
  if (trimmed.length > 0) return `Topic: ${trimmed}.`;
  const base = [
    'Topic: Pick a single specific, interesting topic yourself. Range WIDELY across plays — history, science, geography, pop culture, sports, food, literature, mythology, technology, music, art, architecture, biology, languages, board games, cinema, etc.',
    'Resist the strong default to space exploration / Apollo / astronomy unless that is what the random roll genuinely surfaces this time — picking it every play is the failure mode we are guarding against.',
    'Lean toward concrete sub-domains rather than broad fields (e.g. "Renaissance painters" instead of "art", "Formula 1 history" instead of "sports", "Cold War cinema" instead of "movies").',
    'Once chosen, every question must be on that same topic.',
    'Echo the chosen topic in the `chosenTopic` field of the response so it can be displayed back to the user.',
  ].join(' ');
  const blocks: string[] = [base];
  if (recentConversationTopics.length > 0) {
    const bullets = recentConversationTopics.map((t) => `- ${t}`).join('\n');
    blocks.push(
      `PREFER — these topics came up in the wearer's recent conversations. If any one fits a concrete sub-domain you can build 10 distinct questions on, pick it. Otherwise pick freely from the wide universe above:\n${bullets}`,
    );
  }
  if (recentRandomTopics.length > 0) {
    const bullets = recentRandomTopics.map((t) => `- ${t}`).join('\n');
    blocks.push(
      `AVOID these recent Random picks (choose a clearly different domain, not a sibling of any of these):\n${bullets}`,
    );
  }
  return blocks.join('\n\n');
}

const COMMON_OUTPUT_RULES = [
  `Generate exactly ${GAME_LENGTH} questions.`,
  'Output strict JSON matching the provided schema. Do not add prose outside JSON.',
  'Order questions roughly from easier to harder within the chosen difficulty band.',
  'Do not repeat the same question. Each question must cover distinct sub-areas of the topic.',
].join('\n');

/** Header used at the start of the avoid-list block. Exported as a const so
 *  the prompt-shape regression tests can assert on it without inlining the
 *  exact wording in two places. */
export const AVOID_LIST_HEADER =
  'AVOID — these were asked in recent sessions on this preset. Pick distinct sub-areas, not paraphrases of these:';

/**
 * Format a list of recently-asked question texts as a Markdown-style
 * bullet block that follows the COMMON_OUTPUT_RULES section. Returns `''`
 * for an empty / missing input so callers can splice unconditionally — no
 * AVOID block is emitted when there's nothing to avoid.
 *
 * The list is fed in newest-first by the runtime (so the LLM sees recency
 * as the first bullets); we preserve that order here.
 */
function buildAvoidBlock(recentQuestions: readonly string[] | undefined): string {
  if (!recentQuestions || recentQuestions.length === 0) return '';
  const bullets = recentQuestions.map((q) => `- ${q}`).join('\n');
  return `${AVOID_LIST_HEADER}\n${bullets}`;
}

/** Quiz (4-option multiple choice). One correct answer per question. */
export function buildQuizPrompt(
  topic: string,
  difficulty: GameDifficulty,
  lang: LanguageCode,
  recentQuestions?: readonly string[],
  recentRandomTopics?: readonly string[],
  recentConversationTopics?: readonly string[],
): string {
  const avoid = buildAvoidBlock(recentQuestions);
  return [
    'You are a quiz master generating a multiple-choice quiz for a smart-glasses HUD.',
    '',
    topicClause(topic, recentRandomTopics, recentConversationTopics),
    difficultyDirective(difficulty),
    '',
    'For each question, output:',
    '- `text`: the question itself, short enough to read on a small display (≤140 chars).',
    '- `options`: exactly 4 answer choices, each ≤60 chars. One must be correct, the other three plausible distractors.',
    '- `correctIndex`: 0-based index of the correct option inside `options`.',
    '- `reveal`: a thorough 2-4 sentence explanation (≤240 chars). Say WHY the correct answer is right AND, where useful, why the closest distractor is wrong, plus one concrete supporting fact (date, name, mechanism, number) so the wearer learns something each round — not just "yes/no".',
    '',
    COMMON_OUTPUT_RULES,
    ...(avoid ? ['', avoid] : []),
    '',
    languageDirective(lang),
  ].join('\n');
}

/** True / False — 2-option binary. `options` is exactly ["True", "False"] (in the response language). */
export function buildTrueFalsePrompt(
  topic: string,
  difficulty: GameDifficulty,
  lang: LanguageCode,
  recentQuestions?: readonly string[],
  recentRandomTopics?: readonly string[],
  recentConversationTopics?: readonly string[],
): string {
  const avoid = buildAvoidBlock(recentQuestions);
  return [
    'You are a quiz master generating a TRUE / FALSE quiz for a smart-glasses HUD.',
    '',
    topicClause(topic, recentRandomTopics, recentConversationTopics),
    difficultyDirective(difficulty),
    '',
    'For each question, output:',
    '- `text`: a single factual statement, ≤140 chars. Half should be true, half false.',
    '- `options`: exactly 2 entries — the localized words for "True" and "False" in this order.',
    '- `correctIndex`: 0 if the statement is true, 1 if it is false.',
    '- `reveal`: a 2-4 sentence explanation grounding the verdict in fact (≤240 chars). Name the specific evidence or counter-evidence (date, named source, mechanism) — avoid generic "yes/no" answers so the wearer learns the supporting detail.',
    '',
    COMMON_OUTPUT_RULES,
    ...(avoid ? ['', avoid] : []),
    '',
    languageDirective(lang),
  ].join('\n');
}

/** Riddle — no options. User taps to reveal the answer. */
export function buildRiddlePrompt(
  topic: string,
  difficulty: GameDifficulty,
  lang: LanguageCode,
  recentQuestions?: readonly string[],
  recentRandomTopics?: readonly string[],
  recentConversationTopics?: readonly string[],
): string {
  const avoid = buildAvoidBlock(recentQuestions);
  return [
    'You are a riddle master generating tap-to-reveal riddles for a smart-glasses HUD.',
    '',
    topicClause(topic, recentRandomTopics, recentConversationTopics),
    difficultyDirective(difficulty),
    '',
    'For each riddle, output:',
    '- `text`: the riddle itself, ≤180 chars, ending with a single question mark.',
    '- `options`: an empty array `[]`.',
    '- `correctIndex`: the literal value `-1` (riddles are unscored).',
    '- `reveal`: the answer followed by a 2-3 sentence walkthrough of the trick / logic and the key clue in the riddle (≤240 chars). Aim for "ah-ha"-level clarity, not just the bare answer.',
    '',
    COMMON_OUTPUT_RULES,
    ...(avoid ? ['', avoid] : []),
    '',
    languageDirective(lang),
  ].join('\n');
}

/** Build the system prompt for any concrete preset. */
export function buildGamePrompt(
  format: GameFormat,
  topic: string,
  difficulty: GameDifficulty,
  lang: LanguageCode,
  recentQuestions?: readonly string[],
  recentRandomTopics?: readonly string[],
  recentConversationTopics?: readonly string[],
): string {
  switch (format) {
    case 'quiz-mc': return buildQuizPrompt(topic, difficulty, lang, recentQuestions, recentRandomTopics, recentConversationTopics);
    case 'true-false': return buildTrueFalsePrompt(topic, difficulty, lang, recentQuestions, recentRandomTopics, recentConversationTopics);
    case 'riddle': return buildRiddlePrompt(topic, difficulty, lang, recentQuestions, recentRandomTopics, recentConversationTopics);
  }
}

/**
 * Shared Gemini-shaped response schema. Same shape across all three formats —
 * `parseGameResponse` enforces the per-format constraints (options length,
 * correctIndex range) post-hoc, since JSON Schema can't express "len = N when
 * format = X" without inflating the prompt with multiple schemas.
 */
export const GAME_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    chosenTopic: {
      type: 'string',
      description: 'Only populated for Random presets — the topic the model picked. Empty otherwise.',
    },
    questions: {
      type: 'array',
      minItems: GAME_LENGTH,
      maxItems: GAME_LENGTH,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correctIndex: { type: 'integer' },
          reveal: { type: 'string' },
        },
        required: ['text', 'options', 'correctIndex', 'reveal'],
      },
    },
  },
  required: ['questions'],
} as const;

/** Required options length per format. Riddle is exactly 0. */
function expectedOptionsCount(format: GameFormat): number {
  switch (format) {
    case 'quiz-mc': return 4;
    case 'true-false': return 2;
    case 'riddle': return 0;
  }
}

/**
 * Validate + coerce the raw JSON text into a GameQuestion[] and a chosenTopic.
 * Throws on hard schema violations (wrong array length, missing fields,
 * out-of-range correctIndex) so the runtime can surface a retry affordance
 * on `game-loading` rather than launching a session with broken questions.
 */
export interface ParsedGameResponse {
  questions: GameQuestion[];
  /** Topic the LLM picked, only set when the request used a Random preset (empty topic). */
  chosenTopic: string;
}

export function parseGameResponse(text: string, format: GameFormat): ParsedGameResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const fenced = /\{[\s\S]*\}/.exec(text);
    if (!fenced) throw new Error('Game response was not JSON.');
    raw = JSON.parse(fenced[0]);
  }
  if (!isRecord(raw)) throw new Error('Game response was not a JSON object.');
  const rawQuestions = raw['questions'];
  if (!Array.isArray(rawQuestions)) throw new Error('Game response missing `questions` array.');
  if (rawQuestions.length !== GAME_LENGTH) {
    throw new Error(`Game response had ${rawQuestions.length} questions, expected ${GAME_LENGTH}.`);
  }
  const expectedOptions = expectedOptionsCount(format);
  const questions: GameQuestion[] = rawQuestions.map((q, i) => {
    if (!isRecord(q)) throw new Error(`Question ${i + 1} was not an object.`);
    const textVal = typeof q['text'] === 'string' ? q['text'].trim() : '';
    if (!textVal) throw new Error(`Question ${i + 1} missing \`text\`.`);
    const optionsRaw = q['options'];
    if (!Array.isArray(optionsRaw)) throw new Error(`Question ${i + 1} missing \`options\` array.`);
    const options = optionsRaw.filter((o): o is string => typeof o === 'string').map((o) => o.trim());
    if (options.length !== expectedOptions) {
      throw new Error(
        `Question ${i + 1} had ${options.length} options, expected ${expectedOptions} for ${format}.`,
      );
    }
    const correctRaw = q['correctIndex'];
    let correctIndex: number | null;
    if (format === 'riddle') {
      correctIndex = null;
    } else {
      const n = typeof correctRaw === 'number' ? correctRaw : Number.NaN;
      if (!Number.isInteger(n) || n < 0 || n >= options.length) {
        throw new Error(`Question ${i + 1} \`correctIndex\` out of range.`);
      }
      correctIndex = n;
    }
    const reveal = typeof q['reveal'] === 'string' ? q['reveal'].trim() : '';
    return { text: textVal, options, correctIndex, reveal };
  });
  const chosenTopic = typeof raw['chosenTopic'] === 'string' ? raw['chosenTopic'].trim() : '';
  return { questions, chosenTopic };
}

/**
 * Randomize the option order for each multi-choice question, remapping
 * `correctIndex` so it still points at the same answer text. Gemini (and
 * most chat LLMs) bias correctIndex toward 0 — without this shuffle the
 * "correct" option lands first ~70 %+ of the time, which the wearer
 * notices within a session or two and the quiz turns into a tap-the-top
 * game. True-False is left alone (the options carry semantic position:
 * idx 0 = True, idx 1 = False) and riddles have no options to shuffle.
 *
 * `rng` is injectable so tests can pin the order; the runtime call site
 * uses `Math.random` directly.
 */
export function shuffleQuizOptions(
  questions: GameQuestion[],
  rng: () => number = Math.random,
): GameQuestion[] {
  return questions.map((q) => {
    // Skip when shuffling would change meaning (true-false: positional)
    // or wouldn't do anything (riddle / single option). The 3-option case
    // is included so any future custom quiz format with 3 distractors
    // shuffles too.
    if (q.correctIndex === null || q.options.length < 3) return q;
    const indices = q.options.map((_, i) => i);
    // Fisher-Yates over the index array, then materialize the new
    // options[] and find the new home of `correctIndex` in one pass.
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = indices[i]!;
      indices[i] = indices[j]!;
      indices[j] = tmp;
    }
    const options = indices.map((origIdx) => q.options[origIdx]!);
    const correctIndex = indices.indexOf(q.correctIndex);
    return { ...q, options, correctIndex };
  });
}

/**
 * Compose the final LensResult for the completed game. Used by the runtime
 * when writing a history entry on game-end.
 */
export function buildGameResult(
  preset: GamePreset,
  questions: GameQuestion[],
  answers: (number | null)[],
): LensResult {
  let score = 0;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    if (q.correctIndex === null) continue;
    if (answers[i] === q.correctIndex) score += 1;
  }
  return { type: 'game', preset, questions, answers, score };
}
