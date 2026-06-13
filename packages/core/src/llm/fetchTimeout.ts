// src/llm/fetchTimeout.ts
//
// Per-fetch deadline helper shared by the Gemini and OpenAI-compatible
// providers. The Gemini path has had this since the 0.x era; the OpenAI path
// previously had no timeout at all, which let a 5-minute Whisper upload hang
// indefinitely on poor connectivity (the bug item-A in the v0.12.0 plan).
//
// `withFetchTimeout` returns a signal that aborts on EITHER the outer signal
// (user cancel / runtime teardown) or the timer firing. `timedOut()` lets the
// caller disambiguate after the fetch rejects, so a timer abort can be
// re-thrown as `UploadTimeoutError` (surfaces a `TIMEOUT` glyph on the HUD)
// while an outer abort propagates as the original cancel.

export interface FetchTimeoutHandle {
  signal: AbortSignal;
  /** Detach the timer + outer-signal listener. Must be called on settle. */
  cleanup: () => void;
  /** True iff the timer fired before cleanup — distinguishes timeout from outer cancel. */
  timedOut: () => boolean;
}

export function withFetchTimeout(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): FetchTimeoutHandle {
  const ctrl = new AbortController();
  let timedOut = false;
  if (outer?.aborted) ctrl.abort();
  const onOuterAbort = (): void => ctrl.abort();
  outer?.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  return {
    signal: ctrl.signal,
    cleanup: (): void => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    },
    timedOut: () => timedOut,
  };
}

/**
 * Thrown by provider fetches when the per-attempt deadline fires. Surfaced to
 * the HUD as `TIMEOUT` (vs the generic `ERR`) so the wearer can tell a stalled
 * upload apart from a hard provider error.
 */
export class UploadTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadTimeoutError';
  }
}

export function isUploadTimeout(err: unknown): err is UploadTimeoutError {
  return err instanceof Error && err.name === 'UploadTimeoutError';
}
