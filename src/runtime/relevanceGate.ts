// src/runtime/relevanceGate.ts
//
// Cheap, pattern-based relevance check used by the Auto-mode interval and
// silence triggers to suppress LLM calls when the recent transcript tail
// doesn't contain content worth analyzing for the active lens.
//
// Failure modes are explicitly tilted toward "fire": when in doubt, return
// true. The downside of a missed false-positive (wasted LLM call) is much
// smaller than the downside of suppressing a genuinely useful analysis the
// wearer was waiting for. In particular:
//
//   - Empty transcript tail → true (preserves transcriptMode='off' behaviour
//     and the brief window at session start before the first segment lands).
//   - Unknown / uncovered lens id → true (translation, meeting-prep,
//     session-summary, future lenses: no opinion, always pass).
//   - Transcript tail looks mostly non-Latin / has substantial non-ASCII
//     content → true. The English regex patterns below would mis-suppress
//     Danish / Swedish / German / French / Spanish content otherwise.
//   - The Auto lens runs only the filler blocklist (no per-lens patterns)
//     since its classifier is the thing that picks the analysis lens — the
//     gate's job there is just to dodge unambiguous noise like back-channels.
//
// Tail window is the last 5 transcript segments (oldest-first). Matches the
// auto-lens filler-blocklist rule from the spec and keeps the heuristic
// stable across lens choices.

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
 * design — the non-ASCII early-exit further down means a Danish "ja" or
 * French "oui" segment routes through the pass-through path instead of
 * hitting this list. Lowercase, no punctuation.
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
 * Heuristic per-lens trigger patterns. Each entry returns true when the
 * tail contains content the lens can act on. The patterns are deliberately
 * loose — false positives are cheap; false negatives are not.
 *
 * Lenses omitted here (translation, meeting-prep, session-summary, game,
 * companion) pass through the unknown-id default of `true`. Companion in
 * particular is treated as broad catch-all per the spec.
 */
const LENS_PATTERNS: Record<string, RegExp> = {
  // Declarative assertions, numbers/stats, "X is Y" copular claims.
  'fact-checker':
    /\b(\d{2,}|percent|percentage|%|million|billion|always|never|first|biggest|largest|oldest|smallest|most|least)\b|\b\w+\s+(is|are|was|were|will be)\s+(the|a|an|\w+ed|\w+est)\b/i,
  // Explicit question signals — `?` or wh-question words at any position.
  'trivia':
    /\?|\b(who|what|when|where|why|how)\b|\bhow many\b|\bhow much\b/i,
  // Decision / planning language.
  'key-questions':
    /\b(should|let'?s|we (?:need|have to|must|can|could)|the plan|i think we|let me|we'?re going to|we will|going forward)\b/i,
  // Technical / acronym / domain jargon. Heuristics: ≥2-char all-caps
  // acronyms or a "-tion / -ology / -ize" suffix.
  'eli5':
    /\b[A-Z]{2,5}\b|\b\w+(?:tion|ology|ometry|onomy|esis|ization|izing)\b/,
  // Argumentative / absolute claims.
  'logical-fallacy':
    /\b(always|never|everyone|nobody|every (?:single )?(?:one|time)|obviously|clearly|of course)\b|\bif .+ then\b/i,
  // Loaded / political / group-blanket framing.
  'bias-detector':
    /\b(they (?:always|never)|those people|liberals?|conservatives?|the (?:left|right)|elites?|woke|radical)\b/i,
  // Confident assertions stated without hedging — same shape as fact-check
  // since strong claims are what a counter-argument lens wants to bite on.
  'devils-advocate':
    /\b(definitely|absolutely|certainly|undoubtedly|the only|the best|the worst|obviously)\b|\b\w+\s+(is|are)\s+(the|a|an)\b/i,
};

/**
 * Returns true if the recent transcript tail contains content the active
 * lens should fire on. Conservative — fails open in every ambiguous case.
 *
 * @param segments  Recent transcript segments, oldest-first. Pass the result
 *                  of `transcript.getRecent(GATE_TAIL_SEGMENTS)` or an empty
 *                  array when transcript mode is off.
 * @param lensId    Active lens id (BUILTINS key from `personas/index.ts`).
 *                  Unknown ids pass.
 */
export function shouldAnalyze(
  segments: readonly TranscriptSegment[],
  lensId: string,
): boolean {
  // No transcript signal → fall back to the historical "always fire" behaviour
  // so users with transcript mode off don't lose auto-mode entirely.
  if (segments.length === 0) return true;

  const tail = segments.slice(-GATE_TAIL_SEGMENTS);
  const joined = tail.map((s) => s.text).join(' ');

  // Non-Latin / heavily-non-ASCII content: the English regex patterns below
  // are reliable only for English speech. When more than ~30 % of the tail's
  // letter chars are non-ASCII, route through the pass-through path so a
  // Danish/Swedish/German conversation never gets silently suppressed.
  if (looksMostlyNonAscii(joined)) return true;

  // Filler blocklist: when every tail segment is pure back-channel noise,
  // suppress regardless of which lens is active. This is the only check
  // applied to the Auto lens — its classifier handles dispatch when content
  // is substantive.
  if (tail.every((s) => isFiller(s.text))) return false;
  if (lensId === 'auto') return true;

  // Per-lens pattern. Unknown / uncovered ids (translation, meeting-prep,
  // companion, session-summary, future lenses) fall through to true.
  const pattern = LENS_PATTERNS[lensId];
  if (!pattern) return true;
  return pattern.test(joined);
}

/** True when the segment text, lowercased and stripped of punctuation, is a
 *  single filler token. Empty / whitespace-only segments count as filler.
 *  Hyphens are stripped too so "mm-hmm" / "uh-huh" normalize against the
 *  canonical "mmhmm" / "uhhuh" entries in the blocklist. */
function isFiller(text: string): boolean {
  const cleaned = text.toLowerCase().replace(/[^\p{Letter}\s']+/gu, '').trim();
  if (cleaned.length === 0) return true;
  return FILLER_TOKENS.has(cleaned);
}

/** True when the tail contains any non-ASCII letter at all. Used as an early
 *  exit for non-English content — the regex patterns above are English-only,
 *  and a Danish ø / German ü / French é / Cyrillic / CJK character is a
 *  strong signal that the speaker isn't producing English at this moment.
 *  Conservative: an English speaker quoting "café" once is a small false-pass
 *  (one extra LLM call), but a Danish speaker is otherwise mis-suppressed on
 *  every single fire — much higher cost. Routing through pass-through here
 *  guards against that. */
function looksMostlyNonAscii(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (!/\p{Letter}/u.test(ch)) continue;
    if (code > 0x7f) return true;
  }
  return false;
}
