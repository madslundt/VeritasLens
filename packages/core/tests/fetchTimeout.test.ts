// tests/fetchTimeout.test.ts
//
// Unit tests for the per-fetch deadline helper used by both the Gemini and
// OpenAI-compatible providers. The bug it fixes (item-A in the v0.12.0 plan)
// is "5-minute Whisper uploads hang forever on flaky cellular" — the helper
// gives the fetch a hard upper bound and lets the caller distinguish a timer
// abort from a user / runtime abort.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withFetchTimeout, isUploadTimeout, UploadTimeoutError } from '../src/llm/fetchTimeout';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('withFetchTimeout', () => {
  it('aborts the returned signal when the timer fires and marks timedOut()=true', () => {
    const handle = withFetchTimeout(undefined, 1000);
    expect(handle.signal.aborted).toBe(false);
    expect(handle.timedOut()).toBe(false);

    vi.advanceTimersByTime(1000);

    expect(handle.signal.aborted).toBe(true);
    expect(handle.timedOut()).toBe(true);
    handle.cleanup();
  });

  it('aborts when the outer signal is already aborted at construction', () => {
    const outer = new AbortController();
    outer.abort();
    const handle = withFetchTimeout(outer.signal, 1000);
    expect(handle.signal.aborted).toBe(true);
    // Outer-driven abort is NOT a timeout — caller propagates as user cancel.
    expect(handle.timedOut()).toBe(false);
    handle.cleanup();
  });

  it('aborts when an outer signal aborts mid-flight and leaves timedOut()=false', () => {
    const outer = new AbortController();
    const handle = withFetchTimeout(outer.signal, 10_000);
    expect(handle.signal.aborted).toBe(false);

    outer.abort();

    expect(handle.signal.aborted).toBe(true);
    expect(handle.timedOut()).toBe(false);
    handle.cleanup();
  });

  it('cleanup() clears the pending timer so it never fires', () => {
    const handle = withFetchTimeout(undefined, 1000);
    handle.cleanup();
    vi.advanceTimersByTime(2000);
    // Timer was cleared before it could abort.
    expect(handle.signal.aborted).toBe(false);
    expect(handle.timedOut()).toBe(false);
  });

  it('cleanup() detaches the outer-abort listener so later outer aborts do not affect this handle', () => {
    const outer = new AbortController();
    const handle = withFetchTimeout(outer.signal, 10_000);
    handle.cleanup();
    outer.abort();
    // We've cleaned up — the listener should be detached, so the inner ctrl
    // is unaffected. (The signal is its own AbortController.signal, separate
    // from outer.signal.)
    expect(handle.signal.aborted).toBe(false);
  });
});

describe('UploadTimeoutError', () => {
  it('isUploadTimeout matches instances created via the class', () => {
    const err = new UploadTimeoutError('timed out');
    expect(isUploadTimeout(err)).toBe(true);
    expect(err.name).toBe('UploadTimeoutError');
  });

  it('isUploadTimeout returns false for plain Error / AbortError / strings', () => {
    expect(isUploadTimeout(new Error('boom'))).toBe(false);
    expect(isUploadTimeout(Object.assign(new Error('cancel'), { name: 'AbortError' }))).toBe(false);
    expect(isUploadTimeout('timeout')).toBe(false);
    expect(isUploadTimeout(null)).toBe(false);
    expect(isUploadTimeout(undefined)).toBe(false);
  });
});
