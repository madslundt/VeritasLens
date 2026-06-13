// src/runtime/recallContext.ts
//
// Pure helper for the "conversation memory" prompt injection. Lives in its
// own module (rather than inside lifecycle.ts) so the unit test can exercise
// the trim/cap/empty paths without standing up the SDK / store / bridge
// mocks that the lifecycle entry-points require.
//
// The caller (lifecycle.ts) is responsible for reading the live
// `settings().autoSummaryEnabled` and `intermediateSummaries` and passing
// them in — keeping this function side-effect-free is the whole point.

// 2 entries × the 5-minute auto-summary cadence ≈ the last ~10 minutes of
// the conversation. Matches the "recall something said a few minutes ago"
// use case without unbounded prompt growth as the session ages.
export const RECALL_CONTEXT_MAX_ENTRIES = 2;

// Token-budget proxy at ~4 chars/token (≈ 600 tokens). Oldest entries trim
// first so the most-recent context survives if the summaries themselves are
// unusually verbose for a given tick.
export const RECALL_CONTEXT_MAX_CHARS = 2400;

// Framing instruction that wraps the recall block. Explicit "background
// only / base your answer on the JUST-spoken audio" guidance keeps lenses
// from extracting fresh claims out of the summarized context — without
// this, a fact-style lens may treat a summary line as if it were a thing
// the speaker just uttered. See tests/recallContext.test.ts for the wiring
// test that protects this behaviour.
export const RECALL_CONTEXT_DIRECTIVE =
  'CONVERSATION CONTEXT (background only): the following are summaries of earlier moments in this same conversation. Base your answer on the JUST-spoken audio. Use this context ONLY to resolve references the speaker explicitly makes back to it (e.g. "what did they just say about X?"). Do NOT extract new claims or facts from this context.';

export interface RecallSummary {
  title?: string;
  summary: string;
}

/**
 * Build the recall-context block lines. Returns `[]` when disabled or when
 * there is nothing to recall — the caller can then skip emitting the
 * directive entirely. Walks newest-first so the budget is spent on the
 * most-recent context; emitted order is oldest-first so the model reads
 * the block in conversation order.
 */
export function buildRecallContextLines(
  summaries: ReadonlyArray<RecallSummary>,
  enabled: boolean,
  maxEntries: number = RECALL_CONTEXT_MAX_ENTRIES,
  maxChars: number = RECALL_CONTEXT_MAX_CHARS,
): string[] {
  if (!enabled) return [];
  if (summaries.length === 0) return [];
  const recent = summaries.slice(-maxEntries);
  const lines: string[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const s = recent[i]!;
    const body = (s.summary ?? '').trim();
    if (!body) continue;
    const line = s.title ? `- ${s.title}: ${body}` : `- ${body}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines;
}

/**
 * Minimal shape needed by `extractPriorSessionSummaries`. The store's
 * `HistoryEntry` carries far more, but this helper only cares about the
 * `session-summary` rows so the import surface stays narrow (and the unit
 * test doesn't have to reconstruct the full HistoryEntry type).
 */
export interface PriorHistoryEntry {
  sessionId: string;
  result: { type: string; title?: string; summary?: string };
}

/**
 * Pull the most-recent N session summaries from persisted history so the
 * next session can be seeded with cross-session recall context. Only
 * `session-summary` rows count (auto-summaries land in history under the
 * same lens id) and we dedupe by `sessionId` to avoid double-counting the
 * final-summary + auto-summary pair from the same session. Walks the
 * history newest-first so the most recent two sessions win when capped.
 *
 * Returns oldest-first so the caller can append to `intermediateSummaries`
 * directly without re-ordering — the recall-context builder also reads
 * newest-from-the-tail when budgeting.
 */
export function extractPriorSessionSummaries(
  history: ReadonlyArray<PriorHistoryEntry>,
  max: number = RECALL_CONTEXT_MAX_ENTRIES,
): RecallSummary[] {
  if (max <= 0 || history.length === 0) return [];
  const seenSessions = new Set<string>();
  const collected: RecallSummary[] = [];
  for (let i = history.length - 1; i >= 0 && collected.length < max; i--) {
    const entry = history[i]!;
    if (entry.result.type !== 'session-summary') continue;
    const sid = entry.sessionId;
    if (sid && seenSessions.has(sid)) continue;
    const body = (entry.result.summary ?? '').trim();
    if (!body) continue;
    if (sid) seenSessions.add(sid);
    collected.push({
      title: entry.result.title?.trim() || undefined,
      summary: body,
    });
  }
  return collected.reverse();
}
