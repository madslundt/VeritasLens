import { getBridge } from './bridge';
import { PcmRingBuffer } from './audioBuffer';
import {
  bootstrapHud,
  currentHudPage,
  menuOptionAtIndex,
  personaAtIndex,
  restoreActivePage,
  setRecIndicator,
  setStatus,
  setVerdict,
  showActivePage,
  showMenuPage,
  showPickerPage,
  showUnconfiguredPage,
} from './hud';
import { factCheck } from '@/llm/gemini';
import { getPersona, type PersonaId } from '@/personas';
import {
  activePersona,
  setActivePersona,
  setAppPhase,
  setErrorMessage,
  setVerdict as setStateVerdict,
  settings,
  verdict as stateVerdictGet,
} from '@/state/store';
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { OsEventTypeList } from '@evenrealities/even_hub_sdk';

/**
 * HUD runtime orchestrator.
 *
 * Lifecycle:
 *   1. startHudRuntime()      → bootstrap picker page on glasses
 *   2. user taps a persona    → handlePickerClick → enterActiveSession()
 *   3. enterActiveSession()   → rebuild to active page, start mic + ring buffer
 *   4. user taps temple       → runFactCheck()
 *   5. swipe back to picker   → leaveActiveSession()
 */

const SLEEP_AFTER_MS = 5 * 60 * 1000;

let running = false;
let buffer: PcmRingBuffer | null = null;
let unsubscribeEvents: (() => void) | null = null;
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
let inflight: AbortController | null = null;

// Mirror the SDK's native list-cursor in JS. `listEvent.currentSelectItemIndex`
// arrives on listEvent (click/scroll on the captured list) but NOT on
// sysEvent (which the host uses for double-tap and some other gestures), so
// we have to remember the last known index when sysEvent fires a tap.
let lastPickerIndex = 0;
let lastMenuIndex = 0;

export function isHudRunning(): boolean {
  return running;
}

export async function startHudRuntime(): Promise<void> {
  const configured = settings().geminiApiKey.trim().length >= 10;

  if (running) {
    // Already running — flip the page to whatever the current config dictates.
    if (configured) await showPickerPage();
    else await showUnconfiguredPage();
    return;
  }
  running = true;

  try {
    setAppPhase('booting');
    await bootstrapHud(configured ? 'picker' : 'unconfigured');
    setAppPhase('idle');

    const bridge = getBridge();
    unsubscribeEvents = bridge.onEvenHubEvent(handleEvent);
  } catch (err) {
    running = false;
    setAppPhase('error');
    setErrorMessage(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** Refresh the page that's currently on the glasses to reflect new settings. */
export async function refreshHudPage(): Promise<void> {
  if (!running) return;
  const configured = settings().geminiApiKey.trim().length >= 10;
  if (configured) await showPickerPage();
  else await showUnconfiguredPage();
}

export async function stopHudRuntime(): Promise<void> {
  if (!running) return;
  running = false;

  stopSpinner();
  unsubscribeEvents?.();
  unsubscribeEvents = null;

  inflight?.abort();
  inflight = null;

  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;

  buffer?.clear();
  buffer = null;

  try {
    await getBridge().audioControl(false);
  } catch {
    /* ignore — tearing down */
  }
  setAppPhase('idle');
}

// ------- event dispatch ---------------------------------------------------

interface Gesture {
  type: OsEventTypeList | undefined;
  /** Selected item index (present on listEvent, absent on sysEvent). */
  itemIndex?: number;
}

/**
 * Normalize listEvent and sysEvent gesture inputs into a common shape.
 * Returns null for non-gesture events (audio, lifecycle, textEvent).
 */
function extractGesture(event: EvenHubEvent): Gesture | null {
  if (event.listEvent) {
    return {
      type: event.listEvent.eventType,
      itemIndex: event.listEvent.currentSelectItemIndex,
    };
  }
  if (event.sysEvent) {
    const et = event.sysEvent.eventType;
    // Only treat input-style sys events as gestures; FG / SYS_EXIT / IMU are
    // handled elsewhere.
    if (
      et === OsEventTypeList.CLICK_EVENT ||
      et === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      et === OsEventTypeList.SCROLL_TOP_EVENT ||
      et === OsEventTypeList.SCROLL_BOTTOM_EVENT
    ) {
      return { type: et };
    }
  }
  return null;
}

function isLifecycleSysEvent(et: OsEventTypeList | undefined): boolean {
  return (
    et === OsEventTypeList.FOREGROUND_EXIT_EVENT ||
    et === OsEventTypeList.FOREGROUND_ENTER_EVENT ||
    et === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    et === OsEventTypeList.ABNORMAL_EXIT_EVENT
  );
}

function handleEvent(event: EvenHubEvent): void {
  // Light dev logging — useful in the simulator console without spamming UI.
  if (event.listEvent || event.textEvent || event.sysEvent) {
    console.info('[veritaslens] event', summarize(event));
  }

  // Lifecycle sysEvents take priority over gesture-style sysEvents.
  if (event.sysEvent && isLifecycleSysEvent(event.sysEvent.eventType)) {
    switch (event.sysEvent.eventType) {
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
        void pauseListening();
        return;
      case OsEventTypeList.FOREGROUND_ENTER_EVENT:
        void resumeListening();
        return;
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        void stopHudRuntime();
        return;
    }
  }

  // Always append audio while a buffer exists, regardless of which page is
  // currently rendered. The mic stays on through thinking / displaying / menu
  // so the next fact-check can pick up whatever was said in between.
  if (event.audioEvent && buffer) {
    buffer.append(event.audioEvent.audioPcm);
    return;
  }

  const gesture = extractGesture(event);
  if (!gesture) return;

  const page = currentHudPage();
  if (page === 'picker') void handlePickerEvent(gesture);
  else if (page === 'active') void handleActiveGesture(gesture);
  else if (page === 'menu') void handleMenuGesture(gesture);
}

async function handlePickerEvent(g: Gesture): Promise<void> {
  resetSleepTimer();
  if (typeof g.itemIndex === 'number') lastPickerIndex = g.itemIndex;
  switch (g.type) {
    case OsEventTypeList.CLICK_EVENT:
    case undefined: // host normalizes CLICK_EVENT (0) to undefined
    case OsEventTypeList.DOUBLE_CLICK_EVENT: {
      const persona = personaAtIndex(lastPickerIndex);
      if (!persona) return;
      await enterActiveSession(persona.id);
      break;
    }
    // Scroll events: SDK manages the native cursor; nothing to do in JS.
  }
}

async function handleActiveGesture(g: Gesture): Promise<void> {
  resetSleepTimer();
  // UX:
  //   single tap  → menu (CLICK_EVENT, or `undefined` after host normalization)
  //   double tap  → direct fact-check shortcut (DOUBLE_CLICK_EVENT, fires as sysEvent)
  //   swipe up    → exit to picker
  //   swipe down  → clear verdict
  switch (g.type) {
    case OsEventTypeList.CLICK_EVENT:
    case undefined:
      await showMenuPage();
      break;
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      await runFactCheck();
      break;
    case OsEventTypeList.SCROLL_TOP_EVENT:
      await leaveActiveSession();
      break;
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      await clearVerdictAndKeepListening();
      break;
  }
}

async function handleMenuGesture(g: Gesture): Promise<void> {
  resetSleepTimer();
  if (typeof g.itemIndex === 'number') lastMenuIndex = g.itemIndex;
  switch (g.type) {
    case OsEventTypeList.CLICK_EVENT:
    case undefined:
    case OsEventTypeList.DOUBLE_CLICK_EVENT: {
      const option = menuOptionAtIndex(lastMenuIndex);
      switch (option) {
        case 'fact-check':
          await restoreActivePage();
          await runFactCheck();
          break;
        case 'cancel':
          await restoreActiveWithVerdict();
          break;
        case 'exit':
          await leaveActiveSession();
          break;
      }
      break;
    }
    // Scroll events: SDK handles the highlight cursor natively for listEvent;
    // for sysEvent we can't tell which direction the cursor moved either, so
    // we rely on the SDK keeping its internal selection in sync.
  }
}

/** Return to the active page and re-render any verdict that was visible. */
async function restoreActiveWithVerdict(): Promise<void> {
  await restoreActivePage();
  const current = stateVerdictGet();
  if (current) {
    await setVerdict(current);
    await setStatus('displaying');
    setAppPhase('displaying');
  } else {
    await setStatus('listening');
    setAppPhase('listening');
  }
}

// ------- session transitions ---------------------------------------------

async function enterActiveSession(personaId: PersonaId): Promise<void> {
  const persona = getPersona(personaId);
  if (!persona) {
    setErrorMessage(`Unknown lens: ${personaId}`);
    return;
  }
  setActivePersona(personaId);
  lastMenuIndex = 0; // reset menu cursor when (re-)entering a session
  await showActivePage(persona);
  await setStatus('listening');
  await setRecIndicator(true);

  buffer = new PcmRingBuffer({ durationSec: 30, sampleRate: 16_000 });

  const micOk = await getBridge().audioControl(true);
  if (!micOk) {
    await setStatus('error');
    await setRecIndicator(false);
    setErrorMessage('Microphone could not be opened (audioControl returned false).');
    setAppPhase('error');
    return;
  }
  resetSleepTimer();
  setAppPhase('listening');
}

async function leaveActiveSession(): Promise<void> {
  try {
    await getBridge().audioControl(false);
  } catch {
    /* ignore */
  }
  buffer?.clear();
  buffer = null;
  await showPickerPage();
  setAppPhase('idle');
}

const SPINNER_FRAMES = ['|', '/', '-', '\\'];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;

function startSpinner(): void {
  if (spinnerTimer) return;
  let i = 0;
  spinnerTimer = setInterval(() => {
    i = (i + 1) % SPINNER_FRAMES.length;
    // Fire and forget; the SDK upgrade is async but we don't need to await.
    void setStatus(` ${SPINNER_FRAMES[i]}  `);
  }, 180);
}

function stopSpinner(): void {
  if (spinnerTimer) clearInterval(spinnerTimer);
  spinnerTimer = null;
}

async function runFactCheck(): Promise<void> {
  if (currentHudPage() !== 'active') return;
  if (!buffer || buffer.bytesBuffered === 0) {
    await setStatus('listening');
    return;
  }
  const apiKey = settings().geminiApiKey;
  if (!apiKey) {
    await setStatus('error');
    setErrorMessage('No Gemini API key. Open VeritasLens from the phone app menu to add one.');
    return;
  }

  inflight?.abort();
  inflight = new AbortController();

  setAppPhase('thinking');
  await setStatus('thinking');
  startSpinner();

  try {
    const wav = buffer.snapshotWav();
    const verdict = await factCheck({
      apiKey,
      wav,
      model: settings().geminiModel,
      language: settings().responseLanguage,
      signal: inflight.signal,
    });
    stopSpinner();
    setStateVerdict(verdict);
    await setVerdict(verdict);
    await setStatus('displaying');
    setAppPhase('displaying');
    // The verdict stays on the HUD until the user takes another action —
    // no auto-clear, per the explicit UX requirement.
  } catch (err) {
    stopSpinner();
    if ((err as Error)?.name === 'AbortError') return;
    setErrorMessage(err instanceof Error ? err.message : String(err));
    await setStatus('error');
    setAppPhase('error');
  }
}

async function clearVerdictAndKeepListening(): Promise<void> {
  setStateVerdict(null);
  await setVerdict(null);
  await setStatus('listening');
  setAppPhase('listening');
}

async function pauseListening(): Promise<void> {
  try {
    await getBridge().audioControl(false);
  } catch {
    /* ignore */
  }
  await setRecIndicator(false);
  setAppPhase('sleeping');
}

async function resumeListening(): Promise<void> {
  if (currentHudPage() !== 'active') return;
  try {
    await getBridge().audioControl(true);
  } catch {
    /* ignore */
  }
  await setStatus('listening');
  await setRecIndicator(true);
  setAppPhase('listening');
  resetSleepTimer();
}

function resetSleepTimer(): void {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => void enterSleep(), SLEEP_AFTER_MS);
}

async function enterSleep(): Promise<void> {
  if (currentHudPage() !== 'active') return;
  try {
    await getBridge().audioControl(false);
    await setStatus('sleeping');
    await setRecIndicator(false);
    setAppPhase('sleeping');
  } catch {
    /* ignore */
  }
}

// Keep the unused-warning suppressed; `activePersona` is part of the public
// surface read by views even though this module doesn't read it directly.
void activePersona;

function summarize(event: EvenHubEvent): Record<string, unknown> {
  if (event.textEvent) {
    return { kind: 'text', eventType: event.textEvent.eventType, container: event.textEvent.containerName };
  }
  if (event.listEvent) {
    return {
      kind: 'list',
      eventType: event.listEvent.eventType,
      container: event.listEvent.containerName,
      idx: event.listEvent.currentSelectItemIndex,
      name: event.listEvent.currentSelectItemName,
    };
  }
  if (event.sysEvent) {
    return { kind: 'sys', eventType: event.sysEvent.eventType, source: event.sysEvent.eventSource };
  }
  return { kind: 'unknown' };
}
