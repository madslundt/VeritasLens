// src/runtime/gameHistory.ts
//
// Extract recently-asked game questions from history so the LLM can be
// told "don't repeat these" on replays of the same preset. Pure module —
// takes the history array as a parameter rather than importing
// `sessionHistory` from the store, so it's trivially unit-testable and
// mirrors the existing `src/runtime/recallContext.ts` pattern.
//
// Matching rule (newest-first walk):
//   - Saved preset: lensId === 'game' AND tags include format + difficulty + topic.toLowerCase()
//   - Random preset: lensId === 'game' AND tags include format + difficulty (no topic filter — Random
//     hasn't picked one yet at the moment we ask)
//
// Stops when either the count cap (MAX_RECENT_GAME_QUESTIONS = 20) or the
// character cap (MAX_RECENT_GAME_QUESTIONS_CHARS = 1500) is reached.
// Verbatim duplicates across prior sessions are collapsed.

import { RANDOM_GAME_PRESET_ID } from '@/types';
import type { GamePreset, HistoryEntry } from '@/types';

/** Maximum number of past questions to inject into the avoid block. ~2
 *  prior sessions' worth at GAME_LENGTH = 10. Bigger nudges the LLM more
 *  but inflates the prompt; this hits the same ballpark as the existing
 *  cross-session recall budget. */
export const MAX_RECENT_GAME_QUESTIONS = 20;

/** Total characters across the assembled avoid list. Mirrors the
 *  `RECALL_CONTEXT_MAX_CHARS = 2400` precedent at a smaller scale because
 *  question texts are much shorter than session summaries. */
export const MAX_RECENT_GAME_QUESTIONS_CHARS = 1500;

/**
 * Walk `history` newest-first, pulling question texts from entries that
 * match the active preset. Verbatim duplicates are dropped on insert
 * (trim-compare). Returns a fresh array; callers can pass it straight to
 * `buildGamePrompt(..., recent)`.
 *
 * The returned array preserves recency: the most-recently-asked question
 * comes first so the LLM sees recency as the leading bullet.
 */
export function extractRecentGameQuestions(
  history: ReadonlyArray<HistoryEntry>,
  preset: GamePreset,
  maxCount: number = MAX_RECENT_GAME_QUESTIONS,
  maxChars: number = MAX_RECENT_GAME_QUESTIONS_CHARS,
): string[] {
  if (history.length === 0 || maxCount <= 0 || maxChars <= 0) return [];

  const isRandom = preset.id === RANDOM_GAME_PRESET_ID;
  const wantFormat = preset.format;
  const wantDifficulty = preset.difficulty;
  const wantTopic = preset.topic.trim().toLowerCase();

  const out: string[] = [];
  const seen = new Set<string>();
  let charsUsed = 0;

  // Walk newest-first. `sessionHistory()` appends new rows at the end, so
  // iterating from the back gives us recency-first.
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (entry.lensId !== 'game') continue;
    if (!entry.tags || entry.tags.length === 0) continue;
    if (!entry.tags.includes(wantFormat)) continue;
    if (!entry.tags.includes(wantDifficulty)) continue;
    if (!isRandom) {
      // Saved preset: require a topic match. Random skips this because the
      // topic isn't known until the LLM picks one at session start.
      if (wantTopic.length === 0) continue;
      if (!entry.tags.includes(wantTopic)) continue;
    }
    if (entry.result.type !== 'game') continue;

    // Pull the entry's questions in their original order — the entry's
    // own questions are roughly easier→harder, and that's also a useful
    // signal for the LLM (it sees an opener-then-deeper pattern across
    // the avoid list).
    for (const q of entry.result.questions) {
      const text = q.text.trim();
      if (text.length === 0) continue;
      if (seen.has(text)) continue;
      // +1 for the implicit newline that joins bullets in the prompt
      // splice. Using +1 keeps the cap a tight upper bound rather than a
      // soft estimate.
      const projected = charsUsed + text.length + 1;
      if (projected > maxChars) return out;
      seen.add(text);
      out.push(text);
      charsUsed = projected;
      if (out.length >= maxCount) return out;
    }
  }
  return out;
}
