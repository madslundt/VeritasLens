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
  /**
   * Interval-trigger ceiling (ms). After the watcher has been armed for this
   * long without a silence trigger firing, the interval trigger fires anyway —
   * solves the "flowing conversation never pauses, auto-mode never fires"
   * starvation case. Re-read on every tick so live slider changes apply.
   */
  getIntervalMs: () => number;
  /** Active VAD threshold (int16 RMS). 0 -> use FALLBACK_RMS_FLOOR. */
  getRmsFloor: () => number;
  /** True when an analysis is already in flight (suppresses firing). */
  isAnalyzing: () => boolean;
  /**
   * Relevance gate. Called synchronously just before `trigger()` would run;
   * `false` suppresses the fire silently (no LLM call, no HUD change) but
   * still resets the state machine — so the same window doesn't re-evaluate
   * the gate every tick. Default behaviour when omitted is "always fire".
   */
  shouldAnalyze?: () => boolean;
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
/**
 * Time spent in the `armed` state since the last fire (or gate-suppression).
 * Ticked unconditionally while armed — both voice and sub-silence-threshold
 * silence ticks count. Reset to 0 when the watcher arms, on every silence
 * trigger, on every interval trigger, and on every gate-suppression. Tests
 * verify all four reset paths.
 */
let intervalMs = 0;
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
  intervalMs = 0;
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
  intervalMs = 0;
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
  //
  // The relevance gate also applies to the catch-up. The transcript tail
  // at drain time reflects current state, not the missed-window content,
  // so this slightly under-fires when the missed window had substance but
  // current speech is filler. That trade-off is accepted as cost-conservative;
  // the gate is a heuristic. If suppressed, drop pendingFire silently —
  // resetting it so it can't double-drain on the next tick.
  if (pendingFire && !config.isAnalyzing()) {
    pendingFire = false;
    if (gatePass(config)) config.trigger();
    return;
  }

  // Use the ring's in-place RMS so this 200 ms tick doesn't allocate a fresh
  // copy of the entire buffer (multi-MB per tick at large durations — was
  // the dominant GC source on long sessions). Snapshot `bytesProduced`
  // first so the offset we save matches the window we measured.
  const offsetBefore = lastByteOffset;
  lastByteOffset = buffer.bytesProduced;
  const wantedBytes = lastByteOffset - offsetBefore;
  if (wantedBytes < 2) {
    // No new samples this tick (mic stuck, or session just started). Treat
    // as silence so the state machine doesn't get stuck armed forever.
    onSilence(config);
    return;
  }

  const rmsFloor = config.getRmsFloor() || FALLBACK_RMS_FLOOR;
  const rms = buffer.rmsInt16LeSince(offsetBefore);
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
      intervalMs = 0;
    }
    return;
  }
  // Armed: any voice resets the silence accumulator so mid-utterance
  // pauses below the silence threshold don't fire.
  silenceMs = 0;
  intervalMs += TICK_MS;
  if (intervalMs >= config.getIntervalMs()) {
    // Flowing conversation that never paused — fire the interval trigger.
    fireOrSuppress(config);
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
  intervalMs += TICK_MS;
  silenceMs += TICK_MS;
  if (silenceMs >= config.getSilenceMs()) {
    fireOrSuppress(config);
    return;
  }
  if (intervalMs >= config.getIntervalMs()) {
    // Long sub-threshold pauses (lots of half-second breaths in a row) can
    // accumulate past the interval ceiling without ever hitting the silence
    // trigger. Fire the interval anyway so the wearer still gets analysis.
    fireOrSuppress(config);
  }
}

/**
 * Centralized fire entry. Resets the state machine BEFORE evaluating in-flight
 * + gate so:
 *   - the next utterance must build up start+silence from scratch (continuous
 *     re-arm);
 *   - a gate-suppression resets the interval timer too, so the gate doesn't
 *     re-evaluate every tick after the threshold crosses;
 *   - the queue-depth-1 catch-up logic stays unchanged from v3.
 */
function fireOrSuppress(config: AutoModeConfig): void {
  state = 'idle';
  voicedMs = 0;
  silenceMs = 0;
  intervalMs = 0;
  // If an analysis is already in flight, queue exactly one catch-up fire
  // instead of dropping. The next tick that observes `analyzing` false
  // will drain it (and re-evaluate the gate then). Bounds queue depth at 1
  // so a stuck in-flight call can't snowball into a flood of catch-up fires.
  if (config.isAnalyzing()) {
    pendingFire = true;
    return;
  }
  if (!gatePass(config)) return;
  config.trigger();
}

/** Evaluate the relevance gate. Missing callback = pass. Throwing callback
 *  = pass, so a bug in the gate can never silently kill auto-mode. */
function gatePass(config: AutoModeConfig): boolean {
  if (!config.shouldAnalyze) return true;
  try {
    return config.shouldAnalyze();
  } catch {
    return true;
  }
}

