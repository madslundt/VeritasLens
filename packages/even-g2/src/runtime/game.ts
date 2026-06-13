// src/runtime/game.ts
//
// Game session state machine. Lives in parallel to the lens / audio lifecycle:
//   - mic stays closed for the duration of a session (game mode is text-only)
//   - audio ring buffer is not allocated
//   - HUD pages are dedicated game-* pages (see hud.ts)
//   - completion writes a `type: 'game'` history entry when the preset's
//     saveToHistory toggle is on
//
// Reached from the lens picker's "Games" entry → games-picker sub-page →
// preset tap → startGame(). Double-tap from any game-* page cancels the
// in-flight LLM call (if any) and returns to the games-picker.

import { createSignal } from 'solid-js';
import {
  callGame,
  RANDOM_GAME_PRESET_ID,
  GAME_RESPONSE_SCHEMA,
  buildGameResult,
  buildGamePrompt,
  parseGameResponse,
  shuffleQuizOptions,
  extractRecentConversationTopics,
  extractRecentGameQuestions,
  extractRecentRandomTopics,
} from '@veritaslens/core';
import type {
  GameFormat,
  GamePreset,
  GameSession,
} from '@veritaslens/core';
import {
  GAME_PRESETS_CAP,
  gamePresets,
  newGamePresetId,
  pushDebugEvent,
  pushHistoryEntry,
  saveGamePresets,
  sessionHistory,
  settings,
} from '@/state/store';
import { getBridge } from './bridge';
import {
  showGameEndPage,
  showGameFeedbackPage,
  showGameLoadingPage,
  showGameQuestionPage,
  showGameSavePromptPage,
  showGamesPickerPage,
} from './hud';

const FORMATS: readonly GameFormat[] = ['quiz-mc', 'true-false', 'riddle'];

const [sessionSignal, setSession] = createSignal<GameSession | null>(null);
let inflight: AbortController | null = null;
/** Current highlighted option on the question page. Mirrored from list events
 *  in lifecycle so an index-less tap is correctly attributed to the row the
 *  user was scrolled to — same trick used by `lastPickerIndex` for the
 *  double-tap quirk documented in CLAUDE.md. */
let lastGameOptionIndex = 0;
/** Sticky retry label for the loading page, mirroring the lens spinner. */
let retryLabel = '';

export function currentGameSession(): GameSession | null {
  return sessionSignal();
}

export function isGameActive(): boolean {
  return sessionSignal() !== null;
}

export function setLastGameOptionIndex(idx: number): void {
  lastGameOptionIndex = Math.max(0, idx);
}

export function getLastGameOptionIndex(): number {
  return lastGameOptionIndex;
}

/** Cap consumed by the HUD progress bar. */
export const GAME_PROGRESS_BAR_CELLS = 10;

/**
 * Materialize a concrete `GamePreset` for the Random sentinel. Used when the
 * wearer taps the Random entry — picks a format uniformly at random, leaves
 * topic empty so the prompt asks the LLM to choose, defaults difficulty to
 * Medium, and always saves to history (Random has no edit surface).
 */
export function materializeRandomPreset(): GamePreset {
  const fmt = FORMATS[Math.floor(Math.random() * FORMATS.length)]!;
  return {
    id: RANDOM_GAME_PRESET_ID,
    format: fmt,
    topic: '',
    difficulty: 'medium',
    saveToHistory: true,
  };
}

/**
 * Open the games sub-picker. Called when the wearer taps the "Games" entry
 * on the main picker. Pinned `Random` at the top, then the user's saved
 * presets in order.
 */
export async function openGamesPicker(): Promise<void> {
  // Always reset the highlighted option when entering a fresh games view
  // so a stale index from a previous game can't leak into the next session.
  lastGameOptionIndex = 0;
  await showGamesPickerPage(gamePresets());
}

/**
 * Start a session against the chosen preset. Pushes the loading page, fires
 * a single text-only LLM call, and on success transitions the HUD to the
 * first question page. On non-abort failure surfaces a debug entry and
 * bounces back to the games-picker so the wearer can retry from there.
 */
export async function startGame(preset: GamePreset): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  retryLabel = '';
  lastGameOptionIndex = 0;

  // Seed the session in `loading` so an early HUD refresh has something to
  // render. The actual questions land after callGame resolves.
  const session: GameSession = {
    preset,
    questions: [],
    index: 0,
    answers: [],
    phase: 'loading',
  };
  setSession(session);
  await showGameLoadingPage(preset, retryLabel);

  // Per-preset override wins; null/undefined falls back to the global
  // setting so legacy presets keep working without a migration step.
  const lang = preset.language ?? settings().responseLanguage;
  // Scan history for previously-asked questions on this preset (Random
  // matches by format+difficulty only). Empty array → no AVOID block in
  // the prompt; non-empty → buildGamePrompt splices in a bulleted "don't
  // repeat these" section so the wearer doesn't get the same opener
  // trivia three replays in a row.
  const recentQuestions = extractRecentGameQuestions(sessionHistory(), preset);
  // For Random presets, also pull the chosen-topics from prior Random
  // plays so the topic-clause can tell the LLM "don't pick any of these
  // again." Without this nudge the model defaults to space/Apollo most
  // rolls. No-op for saved presets (the extractor returns [] when the
  // preset id isn't the Random sentinel).
  const recentRandomTopics = extractRecentRandomTopics(sessionHistory(), preset);
  // Conversation-derived topic hints only apply to Random presets (saved
  // presets already pin a topic). extractRecentConversationTopics returns
  // [] when no session summaries exist, so first-run users see the same
  // prompt as before — the PREFER block silently appears once summaries
  // start landing in history.
  const recentConversationTopics =
    preset.id === RANDOM_GAME_PRESET_ID
      ? extractRecentConversationTopics(sessionHistory())
      : [];
  const prompt = buildGamePrompt(
    preset.format,
    preset.topic,
    preset.difficulty,
    lang,
    recentQuestions,
    recentRandomTopics,
    recentConversationTopics,
  );

  try {
    const rawText = await callGame({
      prompt,
      schema: GAME_RESPONSE_SCHEMA,
      signal: controller.signal,
      onRetry: async (attempt) => {
        retryLabel = `R${attempt}/3`;
        // Mirror the lens spinner cadence — flash the retry label on the loading
        // page so the wearer sees progress between attempts.
        await showGameLoadingPage(preset, retryLabel);
      },
    });
    const parsed = parseGameResponse(rawText, preset.format);
    // Shuffle multi-choice option order so the LLM's bias toward
    // correctIndex=0 doesn't make the quiz a tap-the-top game. No-op for
    // true-false (positional semantics) and riddles.
    const questions = shuffleQuizOptions(parsed.questions);
    // For Random presets, fold the chosen topic into the live session so it
    // appears on the end-page summary and history entry. Saved presets keep
    // their explicit topic.
    const effectivePreset: GamePreset =
      preset.id === RANDOM_GAME_PRESET_ID && parsed.chosenTopic
        ? { ...preset, topic: parsed.chosenTopic }
        : preset;
    const nextSession: GameSession = {
      preset: effectivePreset,
      questions,
      index: 0,
      answers: Array(questions.length).fill(null),
      phase: 'question',
    };
    setSession(nextSession);
    await showGameQuestionPage(nextSession);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      // Cancelled by the user via double-tap. cancelGame already cleared the
      // session signal and navigated away — nothing more to do here.
      return;
    }
    pushDebugEvent({
      label: 'game-load-fail',
      detail: err instanceof Error ? err.message : String(err),
    });
    setSession(null);
    await showGamesPickerPage(gamePresets(), { errorMessage: 'Generation failed — try again' });
  } finally {
    if (inflight === controller) inflight = null;
  }
}

/**
 * Record an answer for the current question and advance to the feedback page.
 * Riddle (`correctIndex === null`) passes through with `selected = null`.
 */
export async function selectAnswer(selected: number | null): Promise<void> {
  const session = sessionSignal();
  if (!session || session.phase !== 'question') return;
  const q = session.questions[session.index];
  if (!q) return;
  let chosen: number | null = selected;
  if (q.correctIndex === null) {
    chosen = null; // riddle: ignore selection
  } else if (selected === null || selected < 0 || selected >= q.options.length) {
    // Defensive: bad index from a race between a list event and a tap. Default
    // to the highlighted row at the time of the tap.
    chosen = Math.min(Math.max(0, lastGameOptionIndex), q.options.length - 1);
  }
  const nextAnswers = session.answers.slice();
  nextAnswers[session.index] = chosen;
  const next: GameSession = {
    ...session,
    answers: nextAnswers,
    phase: 'feedback',
  };
  setSession(next);
  await showGameFeedbackPage(next);
}

/**
 * Tap-to-advance on the feedback page. Moves to the next question, or to
 * the end page if the wearer just answered the last one. On end-page entry
 * writes the history entry (when `saveToHistory` is on).
 */
export async function advance(): Promise<void> {
  const session = sessionSignal();
  if (!session) return;
  if (session.phase === 'feedback') {
    const nextIndex = session.index + 1;
    if (nextIndex >= session.questions.length) {
      const end: GameSession = { ...session, phase: 'end' };
      setSession(end);
      await persistGameIfRequested(end);
      await showGameEndPage(end);
      return;
    }
    lastGameOptionIndex = 0;
    const next: GameSession = { ...session, index: nextIndex, phase: 'question' };
    setSession(next);
    await showGameQuestionPage(next);
    return;
  }
  if (session.phase === 'end') {
    // For Random presets, the topic was chosen by the LLM at runtime — give
    // the wearer one tap to save it as a reusable preset before tearing the
    // session down. Saved presets just go back to the picker.
    if (session.preset.id === RANDOM_GAME_PRESET_ID) {
      await showGameSavePromptPage(session);
      return;
    }
    setSession(null);
    await openGamesPicker();
  }
}

/**
 * Tap-on-Back from the random save-prompt page: discard the prompt and
 * return to the games sub-picker without persisting a preset.
 */
export async function dismissRandomSavePrompt(): Promise<void> {
  setSession(null);
  await openGamesPicker();
}

/**
 * Tap-on-Save: persist the random session's chosen topic + format +
 * difficulty as a fresh `GamePreset` so the wearer can replay it directly.
 * No-ops gracefully when the preset cap is already reached (we surface
 * "cap reached" via the games-picker error flash on return). Always lands
 * back on the games sub-picker afterwards.
 */
export async function saveCurrentRandomAsPreset(): Promise<void> {
  const session = sessionSignal();
  if (!session) {
    await openGamesPicker();
    return;
  }
  const topic = session.preset.topic.trim();
  const list = [...gamePresets()];
  let error = '';
  if (!topic) {
    error = 'Random session had no topic to save';
  } else if (list.length >= GAME_PRESETS_CAP) {
    error = `Preset cap reached (${GAME_PRESETS_CAP})`;
  } else {
    list.push({
      id: newGamePresetId(),
      format: session.preset.format,
      topic,
      difficulty: session.preset.difficulty,
      // Default new presets to history-on — the wearer just chose to keep
      // this topic, so it should behave like any other manually-created
      // preset would.
      saveToHistory: true,
    });
    const ok = await saveGamePresets((k, v) => getBridge().setLocalStorage(k, v), list);
    if (!ok) error = 'Could not save preset';
  }
  setSession(null);
  await showGamesPickerPage(gamePresets(), error ? { errorMessage: error } : {});
}

/**
 * Cancel the in-flight LLM call and clear the session. Routed from a
 * double-tap on any game-* page. Lands the wearer back on the games sub-
 * picker so they can start something else.
 *
 * When the wearer has answered at least one question, persist the partial
 * session to history (subject to the preset's `saveToHistory` flag) so a
 * mid-game exit doesn't quietly erase the progress they already made. A
 * pure-cancel (no answers yet — e.g. they double-tapped during the loading
 * page) is dropped without a write, since there's nothing to record.
 */
export async function cancelGame(): Promise<void> {
  inflight?.abort();
  inflight = null;
  const current = currentGameSession();
  // Skip the partial-persist write when the wearer is on the end page or
  // the random save-prompt — advance() already wrote a history entry when
  // it transitioned the session into phase 'end', so re-persisting here
  // would duplicate the row. Mid-game cancels (phase 'question'/'feedback')
  // are the only ones that need to flush.
  if (current && current.phase !== 'end' && hasAnyAnswer(current)) {
    await persistGameIfRequested(current);
  }
  setSession(null);
  await openGamesPicker();
}

/** True iff the wearer has resolved at least one question — either picked
 *  an option (number) or, for riddles, tapped through to reveal. */
function hasAnyAnswer(session: GameSession): boolean {
  return session.answers.some((a) => a !== null);
}

/**
 * Stop the runtime entirely (e.g. host SYSTEM_EXIT_EVENT). Drops the session
 * without navigating — the HUD teardown owns the next page push.
 */
export function teardownGame(): void {
  inflight?.abort();
  inflight = null;
  setSession(null);
  lastGameOptionIndex = 0;
  retryLabel = '';
}

async function persistGameIfRequested(session: GameSession): Promise<void> {
  if (!session.preset.saveToHistory) return;
  const result = buildGameResult(session.preset, session.questions, session.answers);
  if (result.type !== 'game') return;
  const sessionId = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const isScored = session.questions.some((q) => q.correctIndex !== null);
  const badge = isScored ? `${result.score}/${session.questions.length}` : 'GAME';
  const question = session.preset.topic.trim() || 'Random';
  try {
    await pushHistoryEntry({
      sessionId,
      lensId: 'game',
      lensName: 'Game',
      question,
      badge,
      quote: '',
      result,
      tags: [session.preset.format, session.preset.difficulty, session.preset.topic.toLowerCase()].filter(Boolean),
    }, (k, v) => getBridge().setLocalStorage(k, v));
  } catch (err) {
    pushDebugEvent({
      label: 'game-history-fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
