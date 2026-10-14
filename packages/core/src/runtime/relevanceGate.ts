// src/runtime/relevanceGate.ts
//
// Auto-mode suppresses only obvious filler. Lens prompts make the semantic
// relevance decision, because vocabulary and language heuristics silently
// miss useful speech. Translation and Meeting Prep pass even acknowledgments.

import type { TranscriptSegment } from './transcript';

/**
 * How many trailing transcript segments the gate inspects. Aligned with the
 * auto-lens "if all of the last 5 are filler, suppress" rule. Exported so
 * tests and tracing utilities can mirror it without duplicating the constant.
 */
export const GATE_TAIL_SEGMENTS = 5;

/**
 * Filler / back-channel words. Match in isolation (only word in the segment)
 * or as the *sole* content after stripping punctuation. English-only by
 * design — a Danish "ja" or French "oui" is not on this list and passes. Lowercase, no punctuation.
 */
const FILLER_TOKENS: ReadonlySet<string> = new Set([
  'yeah', 'yep', 'yup', 'yes',
  'no', 'nope', 'nah',
  'okay', 'ok',
  'mm', 'mhm', 'mmhmm', 'mmhm', 'uhhuh', 'uhuh',
  'right', 'sure', 'exactly', 'totally',
  'huh', 'hm', 'hmm',
  'i see', 'got it', 'gotcha',
  'cool', 'nice',
  'thanks', 'thank you',
]);

/**
 * Returns true if the recent transcript tail contains content the active
 * lens should fire on. Conservative — fails open in every ambiguous case.
 *
 * @param segments  Recent transcript segments, oldest-first. Pass the result
 *                  of `transcript.getRecent(GATE_TAIL_SEGMENTS)` or an empty
 *                  array when transcript mode is off.
 * @param lensId    Active lens id (BUILTINS key from `personas/index.ts`).
 *                  Substantive speech passes for every lens.
 */
export function shouldAnalyze(
  segments: readonly TranscriptSegment[],
  lensId: string,
): boolean {
  // No transcript signal → fall back to the historical "always fire" behaviour
  // so users with transcript mode off don't lose auto-mode entirely.
  if (segments.length === 0) return true;

  const tail = segments.slice(-GATE_TAIL_SEGMENTS);
  // Even a one-word acknowledgment can need translation or matter to a
  // prepared meeting. Those modes must receive all captured speech.
  if (lensId === 'translation' || lensId === 'meeting-prep') return true;

  // Suppress only unmistakable filler. English keyword patterns cannot
  // establish that an utterance is irrelevant: "Dolphins are mammals", a
  // lowercased technical term, or ASCII-only Danish all have useful content.
  return !tail.every((segment) => isFiller(segment.text));
}

/** True when the segment text, lowercased and stripped of punctuation, is a
 *  single filler token. Empty / whitespace-only segments count as filler.
 *  Hyphens are stripped too so "mm-hmm" / "uh-huh" normalize against the
 *  canonical "mmhmm" / "uhhuh" entries in the blocklist. */
function isFiller(text: string): boolean {
  const cleaned = text.toLowerCase().replace(/[^\p{Letter}\p{Number}\s']+/gu, '').trim();
  if (cleaned.length === 0) return true;
  return FILLER_TOKENS.has(cleaned);
}
