// tests/analysis-cursor.test.ts
//
// Regression coverage for the audio-window cursor rule in runAnalysis.
//
// The bug: `lastAnalysisByteOffset` was advanced eagerly before the LLM call,
// so an errored analysis "consumed" its audio window. A silent double-tap retry
// then re-checked the wrong window and reported `○` ("no speech captured")
// instead of re-running. The fix defers the cursor commit to a completed
// attempt (success or noSpeech) via `resolveAnalysisCursor`.
//
// runAnalysis itself isn't exported (large bridge/HUD/network surface), so we
// test the pure decision helper directly, then exercise its semantics against
// the real PcmRingBuffer to prove audio survives an error but is consumed on
// success.

import { describe, it, expect } from 'vitest';
import { resolveAnalysisCursor } from '../src/runtime/lifecycle';
import { PcmRingBuffer } from '@veritaslens/core';

describe('resolveAnalysisCursor', () => {
  const SNAPSHOT = 100;
  const CURRENT = 40;

  it('advances to the snapshot offset on a displayed result', () => {
    expect(resolveAnalysisCursor('success', SNAPSHOT, CURRENT)).toBe(SNAPSHOT);
  });

  it('advances to the snapshot offset on a completed noSpeech verdict', () => {
    expect(resolveAnalysisCursor('noSpeech', SNAPSHOT, CURRENT)).toBe(SNAPSHOT);
  });

  it('leaves the cursor unchanged on error/timeout', () => {
    expect(resolveAnalysisCursor('error', SNAPSHOT, CURRENT)).toBe(CURRENT);
  });

  it('leaves the cursor unchanged on abort/cancel', () => {
    expect(resolveAnalysisCursor('abort', SNAPSHOT, CURRENT)).toBe(CURRENT);
  });
});

describe('cursor rule against PcmRingBuffer', () => {
  // A voiced window: 1000 bytes (= 500 int16 samples) of non-zero PCM.
  const makeWindow = (): Uint8Array => {
    const chunk = new Uint8Array(1000);
    for (let i = 0; i < chunk.length; i++) chunk[i] = (i % 251) + 1; // never 0
    return chunk;
  };

  it('preserves the audio window after an error so a retry re-includes it', () => {
    const buffer = new PcmRingBuffer({ durationSec: 1 }); // 32000-byte capacity
    const priorOffset = buffer.bytesProduced; // 0 — first analysis of the session

    buffer.append(makeWindow());
    const snapshot = buffer.bytesProduced; // 1000
    expect(buffer.linearPcmSince(priorOffset).length).toBe(1000);

    // Errored attempt: cursor must not advance.
    const afterError = resolveAnalysisCursor('error', snapshot, priorOffset);
    expect(afterError).toBe(priorOffset);
    // The same audio is still visible to the next gate/upload.
    expect(buffer.linearPcmSince(afterError).length).toBe(1000);
  });

  it('consumes the audio window after a successful analysis', () => {
    const buffer = new PcmRingBuffer({ durationSec: 1 });
    const priorOffset = buffer.bytesProduced;

    buffer.append(makeWindow());
    const snapshot = buffer.bytesProduced;

    // Successful attempt: cursor advances past the analysed window.
    const afterSuccess = resolveAnalysisCursor('success', snapshot, priorOffset);
    expect(afterSuccess).toBe(snapshot);
    // A silent re-tap now sees nothing new — correct `○` behaviour.
    expect(buffer.linearPcmSince(afterSuccess).length).toBe(0);
  });
});
