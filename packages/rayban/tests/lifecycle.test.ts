import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the native modules — vitest's resolve.extensions already resolves
// '../modules/expo-meta-camera' to the .web.ts file, so we don't vi.mock them here.
// We only need to mock the external packages that lifecycle.ts transitively imports.
vi.mock('expo-speech', () => ({ speak: vi.fn(), stop: vi.fn() }));
vi.mock('expo-av', () => ({
  Audio: {
    Sound: class {
      loadAsync() { return Promise.resolve(); }
      replayAsync() { return Promise.resolve(); }
    },
  },
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
  },
}));

// callLensStream is the heavy hitter — mock it so we don't actually call any LLM.
// Use importOriginal to preserve PcmRingBuffer, getPersona, toSpeech, etc.
vi.mock('@veritaslens/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@veritaslens/core')>();
  return {
    ...actual,
    callLensStream: vi.fn().mockResolvedValue('{"noSpeech":false,"claims":[]}'),
  };
});

import { startLifecycle, stopLifecycle, triggerAnalysis, cancelAnalysis } from '../src/runtime/lifecycle';
import { useStore } from '../src/state/store';
import * as core from '@veritaslens/core';

describe('lifecycle', () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    vi.clearAllMocks();
  });

  it('startLifecycle sets up subscriptions and starts streams', async () => {
    await startLifecycle();
    // After 150ms the mock camera+audio should both be reporting healthy state.
    await new Promise((r) => setTimeout(r, 150));
    const conn = useStore.getState().glassesConnection;
    expect(conn.hfpConnected).toBe(true);
    await stopLifecycle();
  });

  it('triggerAnalysis transitions phases idle → thinking → displaying', async () => {
    await startLifecycle();
    await new Promise((r) => setTimeout(r, 150));

    const phases: string[] = [];
    const unsubscribe = useStore.subscribe((s) => phases.push(s.appPhase));

    await triggerAnalysis();
    unsubscribe();

    expect(phases).toContain('thinking');
    expect(phases[phases.length - 1]).toBe('displaying');
    await stopLifecycle();
  });

  it('triggerAnalysis blocks when glasses are not connected', async () => {
    // Don't start lifecycle - leave glasses disconnected.
    await triggerAnalysis();
    expect(core.callLensStream).not.toHaveBeenCalled();
  });

  it('cancelAnalysis transitions to idle without going to error', async () => {
    await startLifecycle();
    await new Promise((r) => setTimeout(r, 150));

    // Make callLensStream slow so we have time to cancel mid-flight.
    let resolveCallLens: (() => void) | null = null;
    (core.callLensStream as ReturnType<typeof vi.fn>).mockImplementation(async (opts: { signal?: AbortSignal }) => {
      return new Promise((resolve, reject) => {
        resolveCallLens = () => resolve('{"noSpeech":false,"claims":[]}');
        opts.signal?.addEventListener('abort', () => {
          const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
        });
      });
    });

    const triggerPromise = triggerAnalysis();
    // Wait a tick so triggerAnalysis enters 'thinking'.
    await new Promise((r) => setTimeout(r, 30));
    expect(useStore.getState().appPhase).toBe('thinking');

    // Cancel mid-flight.
    cancelAnalysis();
    expect(useStore.getState().appPhase).toBe('idle');

    // Wait for the rejection to propagate through triggerAnalysis's catch.
    await triggerPromise.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));

    // Phase must remain 'idle', NOT 'error'.
    expect(useStore.getState().appPhase).toBe('idle');

    // Suppress unused variable warning.
    void resolveCallLens;

    await stopLifecycle();
  });
});
