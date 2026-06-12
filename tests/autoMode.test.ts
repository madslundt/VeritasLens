// tests/autoMode.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isAutoModeWatcherRunning,
  startAutoModeWatcher,
  stopAutoModeWatcher,
} from '../src/runtime/autoMode';
import { PcmRingBuffer } from '../src/runtime/audioBuffer';

// Mirror the watcher's hard-coded tick cadence. If TICK_MS in autoMode.ts
// ever changes, this test file must change in lock-step — that's intentional,
// since timing assumptions are the entire point of the state machine.
const TICK_MS = 200;
const SAMPLE_RATE = 16_000;
// 200 ms of 16 kHz mono 16-bit PCM = 3200 samples = 6400 bytes.
const BYTES_PER_TICK = (SAMPLE_RATE * TICK_MS) / 1000 * 2;

const START_MS = 1500;
const SILENCE_MS = 2000;
// Comfortably larger than the existing tests' longest voiced run so the
// pre-existing cases keep their original semantics (no spurious interval fire).
const INTERVAL_MS = 30_000;
const RMS_FLOOR = 200;

/** Square wave at ~10 000 amplitude → RMS ≈ 10 000, well above the 200 floor. */
function makeVoiceChunk(): Uint8Array {
  const samples = BYTES_PER_TICK / 2;
  const arr = new Int16Array(samples);
  for (let i = 0; i < samples; i++) arr[i] = i % 2 === 0 ? 10_000 : -10_000;
  return new Uint8Array(arr.buffer);
}

/** All zero samples → RMS = 0, well below the 200 floor. */
function makeSilenceChunk(): Uint8Array {
  return new Uint8Array(BYTES_PER_TICK);
}

let buffer: PcmRingBuffer;
// Annotate the generic so the mock satisfies `() => void` exactly rather than
// the wider `Procedure | Constructable` default from vi.fn() with no args.
let trigger: ReturnType<typeof vi.fn<() => void>>;
let isAnalyzing = false;
/**
 * Per-test gate override. `null` means "omit shouldAnalyze entirely" — the
 * watcher's gate-pass branch handles the missing-callback case, which is the
 * behaviour the v3 existing tests expect.
 */
let gate: (() => boolean) | null = null;

function defaultConfig() {
  return {
    getStartMs: () => START_MS,
    getSilenceMs: () => SILENCE_MS,
    getIntervalMs: () => INTERVAL_MS,
    getRmsFloor: () => RMS_FLOOR,
    isAnalyzing: () => isAnalyzing,
    ...(gate ? { shouldAnalyze: gate } : {}),
    trigger,
  };
}

function feedTick(chunk: Uint8Array): void {
  buffer.append(chunk);
  vi.advanceTimersByTime(TICK_MS);
}

function feedVoiceTicks(n: number): void {
  for (let i = 0; i < n; i++) feedTick(makeVoiceChunk());
}

function feedSilenceTicks(n: number): void {
  for (let i = 0; i < n; i++) feedTick(makeSilenceChunk());
}

describe('autoMode watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new PcmRingBuffer({ durationSec: 30, sampleRate: SAMPLE_RATE });
    trigger = vi.fn<() => void>();
    isAnalyzing = false;
    gate = null;
  });

  afterEach(() => {
    stopAutoModeWatcher();
    vi.useRealTimers();
  });

  it('does not fire when voice duration stays below startMs', () => {
    startAutoModeWatcher(buffer, defaultConfig());
    // 5 ticks * 200 ms = 1000 ms — under the 1500 ms arm threshold.
    feedVoiceTicks(5);
    // Then long silence — has nothing to fire because the watcher never armed.
    feedSilenceTicks(15);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('fires once after voice >= startMs and trailing silence >= silenceMs', () => {
    startAutoModeWatcher(buffer, defaultConfig());
    feedVoiceTicks(8);    // 1600 ms ≥ 1500 → armed
    feedSilenceTicks(10); // 2000 ms ≥ 2000 → fire
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("treats a mid-utterance pause below silenceMs as a single utterance — the user's scenario", () => {
    startAutoModeWatcher(buffer, defaultConfig());
    feedVoiceTicks(8);    // armed
    feedSilenceTicks(5);  // 1000 ms pause < 2000 ms — must NOT fire
    expect(trigger).not.toHaveBeenCalled();
    feedVoiceTicks(5);    // voice resumes — silence accumulator resets
    feedSilenceTicks(10); // 2000 ms trailing silence → fire
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('re-arms after firing so two consecutive cycles fire twice', () => {
    startAutoModeWatcher(buffer, defaultConfig());
    feedVoiceTicks(8);
    feedSilenceTicks(10);
    expect(trigger).toHaveBeenCalledTimes(1);
    feedVoiceTicks(8);
    feedSilenceTicks(10);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('stops firing after stopAutoModeWatcher, even when conditions become satisfied', () => {
    startAutoModeWatcher(buffer, defaultConfig());
    feedVoiceTicks(8);    // armed
    feedSilenceTicks(5);  // partial silence
    expect(isAutoModeWatcherRunning()).toBe(true);
    stopAutoModeWatcher();
    expect(isAutoModeWatcherRunning()).toBe(false);
    // Would have fired ~5 ticks in if still running.
    feedSilenceTicks(20);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('queues a single catch-up fire when an utterance ends while a prior analysis is in flight', () => {
    // Replaces the v2 "skip + require fresh arm" semantics. v3 catch-up:
    // when an utterance hits the silence threshold during an in-flight
    // analysis, set pendingFire instead of dropping. As soon as the watcher
    // observes `isAnalyzing` false, the next tick drains the pending fire.
    // Critical for listen-in mode so back-to-back utterances aren't silently
    // lost — the lifecycle's `lastAnalysisByteOffset` makes sure the
    // catch-up payload covers the audio captured during the missed window.
    startAutoModeWatcher(buffer, defaultConfig());
    isAnalyzing = true;
    feedVoiceTicks(8);
    feedSilenceTicks(10); // threshold met but analysis in flight → defer
    expect(trigger).not.toHaveBeenCalled();
    // Now the analysis releases. The very next tick should drain the
    // pending fire — no new utterance required.
    isAnalyzing = false;
    feedSilenceTicks(1);
    expect(trigger).toHaveBeenCalledTimes(1);
    // Subsequent silence must NOT fire again (only one catch-up per
    // missed utterance — no double-fire on each idle tick).
    feedSilenceTicks(20);
    expect(trigger).toHaveBeenCalledTimes(1);
    // A fresh utterance after catch-up still fires normally.
    feedVoiceTicks(8);
    feedSilenceTicks(10);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('coalesces multiple in-flight utterances into a single catch-up fire', () => {
    // If three utterances all complete while an analysis is in flight, the
    // watcher must NOT fire three catch-ups when the analysis releases —
    // it must coalesce them into one. The lifecycle's byte-offset cropping
    // hands the one catch-up call all the audio captured during the missed
    // window, which is the right behaviour.
    startAutoModeWatcher(buffer, defaultConfig());
    isAnalyzing = true;
    // Utterance 1
    feedVoiceTicks(8);
    feedSilenceTicks(10);
    // Utterance 2
    feedVoiceTicks(8);
    feedSilenceTicks(10);
    // Utterance 3
    feedVoiceTicks(8);
    feedSilenceTicks(10);
    expect(trigger).not.toHaveBeenCalled();
    isAnalyzing = false;
    feedSilenceTicks(1);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  // ----- Interval trigger -----

  it('does not tick the interval timer while in the idle (pre-arm) state', () => {
    // Use a tiny interval so the test would catch a misfire fast if the
    // timer were running in idle. The watcher never arms (no voice ticks),
    // so 100 silence ticks (20 s) should produce zero triggers regardless
    // of the 3 s interval ceiling.
    startAutoModeWatcher(buffer, {
      ...defaultConfig(),
      getIntervalMs: () => 3_000,
    });
    feedSilenceTicks(100);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('fires the interval trigger after continuous voice without a silence trigger', () => {
    // 3 s interval, 8 s of voice → no mid-pauses, no silence trigger ever
    // crosses, but the interval fires at the ceiling. Picked 3 s so the test
    // runs fast.
    startAutoModeWatcher(buffer, {
      ...defaultConfig(),
      getIntervalMs: () => 3_000,
    });
    // Arm: 8 voice ticks = 1.6 s ≥ 1.5 s start threshold.
    feedVoiceTicks(8);
    expect(trigger).not.toHaveBeenCalled();
    // 15 more voice ticks = 3 s armed → interval crosses.
    feedVoiceTicks(15);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('interval timer resets after the silence trigger fires', () => {
    // After a normal silence fire, the next utterance must rebuild its own
    // interval window from scratch — a stale interval counter from before
    // the fire mustn't carry over and cause the next utterance to fire
    // prematurely on a sub-interval voice run.
    startAutoModeWatcher(buffer, {
      ...defaultConfig(),
      getIntervalMs: () => 3_000,
    });
    feedVoiceTicks(8);
    feedSilenceTicks(10); // silence trigger fires
    expect(trigger).toHaveBeenCalledTimes(1);
    // New utterance, 2 s armed → still under the 3 s ceiling. No second fire
    // unless the interval timer reset cleanly.
    feedVoiceTicks(8);    // arms
    feedVoiceTicks(8);    // 1.6 s armed
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('interval timer resets after its own fire and re-arms cleanly', () => {
    startAutoModeWatcher(buffer, {
      ...defaultConfig(),
      getIntervalMs: () => 3_000,
    });
    feedVoiceTicks(8);
    feedVoiceTicks(15);    // interval fire 1
    expect(trigger).toHaveBeenCalledTimes(1);
    // Second utterance: must arm + cross the interval ceiling fresh, not
    // immediately on next voice tick.
    feedVoiceTicks(8);
    feedVoiceTicks(15);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('interval trigger queues a catch-up fire when an analysis is in flight', () => {
    // Same coalescing contract as the silence trigger — the interval path
    // must also defer through pendingFire when isAnalyzing is true.
    startAutoModeWatcher(buffer, {
      ...defaultConfig(),
      getIntervalMs: () => 3_000,
    });
    isAnalyzing = true;
    feedVoiceTicks(8);
    feedVoiceTicks(15);    // interval threshold crossed in-flight
    expect(trigger).not.toHaveBeenCalled();
    isAnalyzing = false;
    feedSilenceTicks(1);    // drain
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  // ----- Relevance gate -----

  it('suppresses the silence trigger when the gate returns false', () => {
    gate = () => false;
    startAutoModeWatcher(buffer, defaultConfig());
    feedVoiceTicks(8);
    feedSilenceTicks(10);  // would normally fire
    expect(trigger).not.toHaveBeenCalled();
  });

  it('gate suppression resets the state machine — next utterance re-arms fresh', () => {
    // Critical: if the watcher doesn't reset state on suppression, the next
    // silence tick after threshold would immediately re-evaluate the gate
    // every 200 ms. Tested by toggling gate from false→true and verifying
    // that one fresh utterance fires exactly once.
    let pass = false;
    gate = () => pass;
    startAutoModeWatcher(buffer, defaultConfig());
    feedVoiceTicks(8);
    feedSilenceTicks(10);  // suppressed
    expect(trigger).not.toHaveBeenCalled();
    // No spurious fires from re-evaluation on subsequent silence ticks.
    feedSilenceTicks(20);
    expect(trigger).not.toHaveBeenCalled();
    // Gate flips to pass; new utterance fires normally.
    pass = true;
    feedVoiceTicks(8);
    feedSilenceTicks(10);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('gate suppression also covers the interval trigger', () => {
    gate = () => false;
    startAutoModeWatcher(buffer, {
      ...defaultConfig(),
      getIntervalMs: () => 3_000,
    });
    feedVoiceTicks(8);
    feedVoiceTicks(15);    // interval threshold crossed
    expect(trigger).not.toHaveBeenCalled();
  });

  it('omitting shouldAnalyze keeps the v3 default-fire behaviour', () => {
    // Test the optionality contract — when shouldAnalyze is undefined, the
    // watcher behaves as if every fire passed the gate. Same as the pre-gate
    // baseline. gate is null in beforeEach so the helper omits the field.
    startAutoModeWatcher(buffer, defaultConfig());
    feedVoiceTicks(8);
    feedSilenceTicks(10);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('clears pending catch-up on stopAutoModeWatcher', () => {
    // A pending fire must not survive a session tear-down: if the watcher
    // is stopped (session exit, settings toggle), no spurious catch-up
    // should fire when isAnalyzing flips false after restart.
    startAutoModeWatcher(buffer, defaultConfig());
    isAnalyzing = true;
    feedVoiceTicks(8);
    feedSilenceTicks(10); // pending fire queued
    stopAutoModeWatcher();
    isAnalyzing = false;
    // Restart in a fresh session; first tick must not fire from the prior
    // queued state.
    startAutoModeWatcher(buffer, defaultConfig());
    feedSilenceTicks(5);
    expect(trigger).not.toHaveBeenCalled();
  });
});
