// src/runtime/autoMode.ts
//
// Voice-activity-driven auto-analysis watcher.
//
// Polls the live PCM ring buffer on a fixed interval, classifies each new
// chunk as voice/silence by RMS, and runs a two-state machine:
//
//   idle  -> on voice ticks, accumulate voicedMs; when >= startMs -> armed
//   armed -> on voice ticks, reset silenceMs and stay; on silence ticks,
//            accumulate silenceMs; when >= silenceMs, fire the trigger
//            callback and reset back to idle for the next utterance.
//
// Short mid-utterance pauses (< silenceMs) only reset the silence counter,
// so a "voice, brief pause, voice, trailing silence" sequence fires once
// at the end — matching the user's described scenario.
//
// The watcher is intentionally analysis-agnostic: it takes a `trigger`
// callback rather than importing `runAnalysis` from lifecycle to avoid a
// circular dependency. The lifecycle wires the callback to its own
// `runAnalysis()` so this module stays trivially testable in isolation.

import type { PcmRingBuffer } from './audioBuffer';

/** Tick cadence for the polling loop. */
const TICK_MS = 200;

/** Fallback RMS threshold when the user has disabled the voice gate
 *  (`voiceGateRmsFloor === 0`). Auto-mode still needs SOME notion of
 *  silence to function — without a non-zero floor every frame would
 *  register as voice and the watcher would fire instantly on every poll.
 *  Mirrors the historical default in `audioBuffer.ts`. */
const FALLBACK_RMS_FLOOR = 200;

/** Configuration the lifecycle passes per session. The thresholds are
 *  re-read on every tick (rather than snapshotted at start) so toggling
 *  the slider in Settings reflects live without a session restart. */
export interface AutoModeConfig {
  /** Minimum continuous voice duration (ms) before the watcher arms. */
  getStartMs: () => number;
  /** Trailing silence (ms) after arming that fires the trigger. */
  getSilenceMs: () => number;
  /** Active VAD threshold (int16 RMS). 0 -> use FALLBACK_RMS_FLOOR. */
  getRmsFloor: () => number;
  /** True when an analysis is already in flight (suppresses firing). */
  isAnalyzing: () => boolean;
  /** Fired when start+silence thresholds are satisfied. */
  trigger: () => void;
}

type WatcherState = 'idle' | 'armed';

let timer: ReturnType<typeof setInterval> | null = null;
let activeBuffer: PcmRingBuffer | null = null;
let activeConfig: AutoModeConfig | null = null;
let lastByteOffset = 0;
let voicedMs = 0;
let silenceMs = 0;
let state: WatcherState = 'idle';
/**
 * When `true`, an utterance completed its silence threshold while a previous
 * analysis was still in flight. Cleared and fired the next time `tick()`
 * observes `isAnalyzing() === false`. Only one pending fire is held — if a
 * third utterance arrives before the in-flight call returns it coalesces
 * onto the existing pending fire rather than queueing N deep. The catch-up
 * call uses `lastAnalysisByteOffset` on the lifecycle side, so the audio
 * captured during the missed window is what gets sent.
 */
let pendingFire = false;

/**
 * Begin polling. Idempotent — repeated calls with the same buffer reset the
 * state machine but do not stack timers. Calling with a different buffer
 * (i.e. a new session) re-seeds the cursor from the buffer's monotonic
 * position so the first tick only inspects audio captured AFTER the
 * watcher started, not stale ring-buffer content.
 */
export function startAutoModeWatcher(buffer: PcmRingBuffer, config: AutoModeConfig): void {
  // Re-binding to the same buffer is treated as a soft reset rather than a
  // no-op: callers (e.g. a settings effect that toggles auto-mode mid-session)
  // expect a fresh state machine each time they start the watcher.
  stopAutoModeWatcher();
  activeBuffer = buffer;
  activeConfig = config;
  lastByteOffset = buffer.bytesProduced;
  voicedMs = 0;
  silenceMs = 0;
  state = 'idle';
  pendingFire = false;
  timer = setInterval(tick, TICK_MS);
}

/** Stop polling and clear state. Safe to call when not started. */
export function stopAutoModeWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
  activeBuffer = null;
  activeConfig = null;
  lastByteOffset = 0;
  voicedMs = 0;
  silenceMs = 0;
  state = 'idle';
  pendingFire = false;
}

/** True iff the watcher is currently polling. Exposed for the lifecycle's
 *  reactive effect so it can short-circuit redundant start/stop calls. */
export function isAutoModeWatcherRunning(): boolean {
  return timer !== null;
}

/**
 * One poll. Reads only bytes appended since the previous tick, computes
 * a single RMS over them, classifies the whole chunk as voice or silence,
 * and advances the state machine by `TICK_MS`. Splitting the new bytes into
 * sub-frames here would be more precise but isn't worth the cost: at 200 ms
 * cadence and 16 kHz, each tick already maps to a single conversational
 * frame's worth of samples (~3200 samples / 6400 bytes).
 */
function tick(): void {
  const buffer = activeBuffer;
  const config = activeConfig;
  if (!buffer || !config) return;

  // Catch-up fire: if an utterance completed during a previous analysis,
  // drain it as soon as `analyzing` flips false. Done BEFORE the new-bytes
  // read so the catch-up always fires within one tick of the prior call
  // releasing, not behind the next utterance's classification work. The
  // lifecycle uses `lastAnalysisByteOffset` to crop the catch-up's audio
  // to "everything captured since the previous call's snapshot", so the
  // missed window is what gets sent.
  if (pendingFire && !config.isAnalyzing()) {
    pendingFire = false;
    config.trigger();
    return;
  }

  const sincePcm = buffer.linearPcmSince(lastByteOffset);
  lastByteOffset = buffer.bytesProduced;
  if (sincePcm.length < 2) {
    // No new samples this tick (mic stuck, or session just started). Treat
    // as silence so the state machine doesn't get stuck armed forever.
    onSilence(config);
    return;
  }

  const rmsFloor = config.getRmsFloor() || FALLBACK_RMS_FLOOR;
  const rms = computeRmsInt16Le(sincePcm);
  if (rms >= rmsFloor) {
    onVoice(config);
  } else {
    onSilence(config);
  }
}

function onVoice(config: AutoModeConfig): void {
  if (state === 'idle') {
    voicedMs += TICK_MS;
    if (voicedMs >= config.getStartMs()) {
      state = 'armed';
      silenceMs = 0;
    }
  } else {
    // Armed: any voice resets the silence accumulator so mid-utterance
    // pauses below the silence threshold don't fire.
    silenceMs = 0;
  }
}

function onSilence(config: AutoModeConfig): void {
  if (state === 'idle') {
    // Silence before the user has spoken enough — decay the voice
    // accumulator gently so a brief noise blip doesn't credit toward
    // arming forever.
    voicedMs = 0;
    return;
  }
  silenceMs += TICK_MS;
  if (silenceMs < config.getSilenceMs()) return;

  // Threshold met. Reset the state machine BEFORE firing so the next
  // utterance must build up start+silence from scratch ("continuous
  // re-arm").
  state = 'idle';
  voicedMs = 0;
  silenceMs = 0;
  // If an analysis is already in flight, queue exactly one catch-up fire
  // instead of dropping. The next tick that observes `analyzing` false
  // will drain it via the check at the top of `tick()`. Coalesces
  // multiple missed utterances into a single catch-up — the lifecycle's
  // `lastAnalysisByteOffset` ensures the catch-up payload covers the full
  // missed window. Bounds queue depth at 1 so a stuck in-flight call
  // can't snowball into a flood of catch-up fires when it finally
  // resolves.
  if (config.isAnalyzing()) {
    pendingFire = true;
    return;
  }
  config.trigger();
}

/** Single-pass RMS over little-endian int16 PCM. Returns 0 for empty input. */
function computeRmsInt16Le(pcm: Uint8Array): number {
  const sampleCount = pcm.length >> 1;
  if (sampleCount === 0) return 0;
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i++) {
    const s = dv.getInt16(i * 2, true);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / sampleCount);
}
