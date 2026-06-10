// src/runtime/transcript.ts
//
// Session-scoped rolling transcript. Every voice-end emits a `TranscriptSegment`
// tagged with the speaker ("wearer" when the wearer-speak audio-offset window
// was active, otherwise "other"). The runtime consumes the rolling window to:
//   - inject `<transcript>...</transcript>` into lens prompts so the model
//     sees the conversation arc, not just raw audio of the last clip;
//   - render a live 2–3 line transcript widget on the HUD so the wearer can
//     glance at what was just heard;
//   - feed Translate Say-More with richer source-language context than the
//     ad-hoc `recentTranscripts` list it carries today.
//
// Layer B foundation — no provider/HUD/store dependencies. Wire-up happens in
// `transcriptSource.ts`, `lifecycle.ts`, and `hud.ts`.

export type TranscriptSpeaker = 'wearer' | 'other';

export interface TranscriptSegment {
  /** Stable id for the segment — `${startedAt}-${random}`. Used by Layer C's
   *  speculative-analysis queue to key on transcript positions. */
  id: string;
  speaker: TranscriptSpeaker;
  text: string;
  startedAt: number;
  endedAt: number;
}

/**
 * Largest transcript window the rolling buffer retains. ~120 seconds of
 * conversation comfortably covers the wearer's most recent context without
 * inflating prompts on long sessions. Older segments are evicted in FIFO order
 * once both the age and segment-count caps are crossed.
 */
export const TRANSCRIPT_MAX_AGE_MS = 120_000;
/** Hard cap so a runaway burst of short segments can't pin the buffer. */
export const TRANSCRIPT_MAX_SEGMENTS = 60;

interface SessionState {
  sessionId: string;
  segments: TranscriptSegment[];
  subscribers: Set<(segments: readonly TranscriptSegment[]) => void>;
}

let state: SessionState | null = null;

/** Re-initialize the transcript for a fresh session. Drops any prior segments
 *  and notifies subscribers with an empty list so the HUD widget clears. */
export function resetTranscript(sessionId: string): void {
  const subs = state?.subscribers ?? new Set();
  state = { sessionId, segments: [], subscribers: subs };
  notify();
}

/** Surface the current session id (or empty string when no session is active).
 *  Lets callers gate transcript writes — e.g. ignore a late STT result for a
 *  session that already ended. */
export function currentSessionId(): string {
  return state?.sessionId ?? '';
}

/** Append a new segment. Trims to TRANSCRIPT_MAX_AGE_MS / TRANSCRIPT_MAX_SEGMENTS.
 *  Dedupes against the immediately-previous segment when text + speaker match
 *  and started within 2 seconds — Whisper occasionally double-emits the same
 *  utterance when the VAD-end fires twice on a single pause, and we don't want
 *  to inflate the prompt with duplicates. */
export function appendSegment(input: Omit<TranscriptSegment, 'id'>): TranscriptSegment | null {
  if (!state) return null;
  const trimmed = input.text.trim();
  if (trimmed.length === 0) return null;

  const last = state.segments[state.segments.length - 1];
  if (
    last
    && last.speaker === input.speaker
    && last.text === trimmed
    && Math.abs(input.startedAt - last.startedAt) < 2_000
  ) {
    return null;
  }

  const segment: TranscriptSegment = {
    id: `${input.startedAt.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    speaker: input.speaker,
    text: trimmed,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  };
  state.segments.push(segment);
  evictOldSegments(input.endedAt);
  notify();
  return segment;
}

/** Most recent `n` segments, oldest-first. `n` capped to TRANSCRIPT_MAX_SEGMENTS. */
export function getRecent(n: number): readonly TranscriptSegment[] {
  if (!state) return [];
  const count = Math.min(Math.max(n, 0), TRANSCRIPT_MAX_SEGMENTS);
  if (count === 0) return [];
  return state.segments.slice(-count);
}

/** Format the rolling transcript for prompt injection. Each line is prefixed
 *  with `[wearer]` or `[other]` so the model can attribute claims to speakers.
 *  Returns the empty string when there's nothing to inject — callers can use
 *  the result directly in template literals without producing stray blank
 *  prompt blocks. */
export function formatForPrompt(opts: { maxSegments?: number } = {}): string {
  if (!state) return '';
  const segs = state.segments.slice(-(opts.maxSegments ?? TRANSCRIPT_MAX_SEGMENTS));
  if (segs.length === 0) return '';
  return segs.map((s) => `[${s.speaker}] ${s.text}`).join('\n');
}

/** Subscribe to transcript updates. Returns an unsubscribe function. The
 *  subscriber is called immediately with the current snapshot so HUD widgets
 *  can seed themselves without a separate getter call. */
export function subscribe(fn: (segments: readonly TranscriptSegment[]) => void): () => void {
  if (!state) return () => undefined;
  state.subscribers.add(fn);
  try {
    fn(state.segments.slice());
  } catch {
    /* subscriber errors must not break the producer */
  }
  return () => {
    state?.subscribers.delete(fn);
  };
}

/** Test-only: tear down all state so test order doesn't bleed. */
export function _resetTranscriptForTesting(): void {
  state = null;
}

function evictOldSegments(now: number): void {
  if (!state) return;
  const minStart = now - TRANSCRIPT_MAX_AGE_MS;
  while (state.segments.length > 0 && state.segments[0]!.endedAt < minStart) {
    state.segments.shift();
  }
  while (state.segments.length > TRANSCRIPT_MAX_SEGMENTS) {
    state.segments.shift();
  }
}

function notify(): void {
  if (!state) return;
  const snapshot = state.segments.slice();
  for (const fn of state.subscribers) {
    try {
      fn(snapshot);
    } catch {
      /* subscriber errors must not break the producer — surfaced by the subscriber's own try/catch */
    }
  }
}
