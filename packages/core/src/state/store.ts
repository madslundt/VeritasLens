// packages/core/src/state/store.ts
//
// Platform-agnostic settings accessor for the core package.
//
// The Even G2 app (packages/even-g2) wires the real Solid signal in by
// calling `configureSettings(() => solidSettingsSignal())` during bootstrap.
// Tests and other consumers can do the same with a plain getter.
//
// Design note: the facade is intentionally minimal — only what the LLM
// clients and platform-agnostic runtime modules need.

import type { Settings } from '@/types';

// ---------------------------------------------------------------------------
// Debug event log — thin ring buffer used by VAD and other runtime modules
// to surface diagnostic messages in the Settings debug panel.
// ---------------------------------------------------------------------------

export interface DebugEvent { ts: number; label: string; detail: string; }

let _debugEvents: DebugEvent[] = [];
let _onDebugEvent: ((events: DebugEvent[]) => void) | null = null;

/**
 * Register a listener that is notified whenever the debug event list changes.
 * The Even G2 app wires this to the Solid `setDebugEvents` setter; tests can
 * pass a plain function or omit it entirely.
 */
export function configureDebugEvents(listener: (events: DebugEvent[]) => void): void {
  _onDebugEvent = listener;
}

/**
 * Append a new debug event (capped at 40 entries, newest first). Notifies the
 * registered listener if one is configured.
 */
export function pushDebugEvent(entry: Omit<DebugEvent, 'ts'>): void {
  _debugEvents = [{ ts: Date.now(), ...entry }, ..._debugEvents].slice(0, 40);
  _onDebugEvent?.([..._debugEvents]);
}

/** Wipe the debug log. */
export function clearDebugEvents(): void {
  _debugEvents = [];
  _onDebugEvent?.([]);
}

/** Read the current debug events (newest first). */
export function getDebugEvents(): DebugEvent[] {
  return _debugEvents;
}

// ---------------------------------------------------------------------------
// Settings accessor
// ---------------------------------------------------------------------------

let _settings: (() => Settings) | null = null;

/**
 * Register a settings getter. Must be called once before any function that
 * reads `settings()`. In the Even G2 app this is called from `bootstrap.ts`
 * before the first lens call.
 */
export function configureSettings(getter: () => Settings): void {
  _settings = getter;
}

/**
 * Returns the current settings snapshot. Throws if `configureSettings` has
 * not been called yet.
 */
export function settings(): Settings {
  if (!_settings) {
    throw new Error(
      '[core] settings() called before configureSettings(). ' +
      'Call configureSettings(() => yourSettingsGetter) during bootstrap.',
    );
  }
  return _settings();
}
