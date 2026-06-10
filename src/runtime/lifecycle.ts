// src/runtime/lifecycle.ts
import { getBridge } from './bridge';
import { PcmRingBuffer, encodePcmToWav, trimPcmToSegments } from './audioBuffer';
import { analyzeBufferForVoice, extractSpeechSegments, resetVADAvailability, warmupVAD } from './vad';
import { getSileroVAD } from './vad/silero';
import {
  isAutoModeWatcherRunning,
  startAutoModeWatcher,
  stopAutoModeWatcher,
} from './autoMode';
import {
  buildRecallContextLines,
  extractPriorSessionSummaries,
  RECALL_CONTEXT_DIRECTIVE,
} from './recallContext';
import {
  ACTIVE_HINT_ANALYZING,
  ACTIVE_HINT_DEFAULT,
  bootstrapHud,
  clearMenuSpinnerFrame,
  clearStatusFrame,
  currentHudPage,
  flashActiveHint,
  flashMenuHint,
  flashPickerHint,
  gameSavePromptEntryAtIndex,
  gamesPickerEntryAtIndex,
  getActiveLayout,
  hasPendingActiveResult,
  markActiveHidden,
  menuOptionAtIndex,
  pickerEntryAtIndex,
  resetHudSessionState,
  restoreActivePage,
  restoreHistoryListPage,
  scrollActiveReason,
  scrollHistoryDetail,
  setActiveHint,
  setActiveLayout,
  setAutoModeIndicator,
  setLensResult,
  setMenuSpinner,
  setStatus,
  setSummaryBadgeState,
  showActivePage,
  showHistoryDetailPage,
  showHistoryListPage,
  getHistoryListEntries,
  showMenuPage,
  showMidSummaryPage,
  showPickerPage,
  showUnconfiguredPage,
  type MenuItem,
} from './hud';
import {
  cancelGame,
  dismissRandomSavePrompt,
  saveCurrentRandomAsPreset,
  getLastGameOptionIndex,
  materializeRandomPreset,
  openGamesPicker,
  selectAnswer as gameSelectAnswer,
  setLastGameOptionIndex,
  startGame,
  advance as gameAdvance,
  teardownGame,
} from './game';
import { callLens, MAX_RETRIES } from '@/llm';
import { formatRelativeTime } from '@/personas/_utils';
import { getPersona, type Persona, type PersonaId } from '@/personas';
import {
  AUTO_LENS_CANDIDATES,
  buildAutoClassifierSchema,
  buildAutoPrompt,
  parseAutoClassifierResponse,
} from '@/personas/auto';
import {
  SESSION_SUMMARY_ID,
  SESSION_SUMMARY_NAME,
  SESSION_SUMMARY_SCHEMA,
  buildSessionSummaryPrompt,
  parseSessionSummaryResponse,
} from '@/personas/sessionSummary';
import {
  MEETING_PREP_ID,
  buildMeetingPrepPrompt,
  buildMeetingPrepSchema,
  parseMeetingPrepResponse,
} from '@/personas/meetingPrep';
import {
  activePersona,
  appPhase,
  loadHistory,
  meetingPrepIsConfigured,
  meetingPrepSections,
  pushDebugEvent,
  pushHistoryEntries,
  pushHistoryEntry,
  sessionHistory,
  setActivePersona,
  setAppPhase,
  setErrorMessage,
  setLensResult as setStateResult,
  settings,
} from '@/state/store';
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import { createEffect, createRoot, on } from 'solid-js';
import { openaiHostLabel } from '@/types';
import type { GeminiModel, LanguageCode, LensResult, MeetingPrepSection, Settings } from '@/types';

/**
 * Pick the Gemini Auto-classifier model from the current settings, or
 * `undefined` to reuse the main model. Only Gemini exposes a dedicated
 * lighter classifier knob; OpenAI-compatible hosts always reuse the main
 * chat model.
 */
export function chooseClassifierModel(s: Settings): GeminiModel | undefined {
  if (s.provider !== 'gemini') return undefined;
  return s.geminiAutoModel ?? undefined;
}

/**
 * Maximum amount of recent audio the no-voice gate inspects on each
 * user-triggered analysis. The full ring buffer can hold up to 5 minutes,
 * but the user's tap-after-utterance intent is "what just happened" — looking
 * further back wastes Silero inference time on already-stale audio without
 * changing the verdict. 10 seconds comfortably spans a typical English
 * sentence at conversational pace.
 */
const VAD_GATE_WINDOW_SEC = 10;

/**
 * Return the API key for the currently-active provider. Empty string when
 * unset. The LLM facade (`src/llm/index.ts`) routes by `settings().provider`
 * and falls back to the matching provider key when `opts.apiKey` is omitted,
 * so call sites in this file only use this helper for the upfront "is the
 * user configured" check — they no longer forward the key into callLens.
 */
function activeApiKey(): string {
  const s = settings();
  return s.provider === 'openai-compatible'
    ? (s.openaiApiKeys[s.openaiBaseUrl] ?? '')
    : s.geminiApiKey;
}

let running = false;
let buffer: PcmRingBuffer | null = null;
let unsubscribeEvents: (() => void) | null = null;
let inflight: AbortController | null = null;
let analyzing = false;
// Auto-clears the ERR corner glyph so the wearer doesn't have to figure out
// the dismiss gesture after a Gemini failure. Cleared early by any incoming
// gesture (see handleEvent) so an immediate double-tap retry both clears the
// glyph AND triggers a fresh analysis. A new retry that runs through callLens
// will also overwrite the status itself, so the timer is purely defensive
// against the wearer staring at ERR with no idea how to proceed.
let errClearTimer: ReturnType<typeof setTimeout> | null = null;
const ERR_AUTO_CLEAR_MS = 5_000;
let autoSummaryTimer: ReturnType<typeof setInterval> | null = null;
// Abort handle for the in-flight auto-summary tick. Separate from `inflight`
// (which tracks the foreground analysis) so an exit during a periodic tick can
// cancel its fetch + base64 work instead of letting it run to completion and
// push stale state into the next session.
let autoSummaryInflight: AbortController | null = null;
// Detached final-summary call (fires after leaveActiveSession). Held at module
// scope so a new session entering — or runtime stop — can cancel an in-flight
// final summary and release its ~19 MB WAV closure instead of letting the
// request linger past teardown.
let finalSummaryInflight: AbortController | null = null;
// In-memory running summaries accumulated during a session by the auto-summary
// timer. Cleared on session enter / leave / runtime stop. Never persisted on
// their own — they are folded into the single end-of-session entry by
// runFinalSummary().
let intermediateSummaries: Array<{
  title?: string;
  summary: string;
  topics?: string[];
  keyPoints?: string[];
  quote?: string;
}> = [];

type MidSummaryResult = Extract<LensResult, { type: 'session-summary' }>;
let midSummaryResult: { result: MidSummaryResult; generatedAt: number } | null = null;
let midSummaryLoading = false;
let midSummaryController: AbortController | null = null;

let lastPickerIndex = 0;
let lastMenuIndex = 0;
let lastHistoryIndex = 0;
let currentSessionId = '';
let sessionStartTime = 0;
/**
 * Monotonic byte position into the current session's buffer marking the
 * point of the last user-triggered analysis. The no-voice gate considers
 * audio captured since this position so that re-tapping in silence after a
 * fresh analysis correctly reports "no sound" instead of re-classifying
 * already-analysed audio. Reset on session enter; snapshotted just before
 * each successful API call from runAnalysis.
 */
let lastAnalysisByteOffset = 0;
/**
 * Within the current Auto-driven session, the lens id the classifier picked
 * on the previous tap. Used to fire a *speculative* lens call in parallel
 * with the classifier on subsequent taps — on hit we save a full RTT. Reset
 * on session enter/leave so a new conversation never inherits the previous
 * session's topic. `null` when no Auto tap has yet resolved (first-tap path
 * skips the speculative call to avoid spending tokens on a cold guess).
 */
let lastAutoWinnerInSession: string | null = null;

export function isHudRunning(): boolean { return running; }

/**
 * Re-reads history from bridge storage and pushes it into the sessionHistory
 * signal. Called after analyze/check completions and on lens exit so the
 * settings WebView surfaces fresh entries even when the runtime that wrote
 * them is in a sibling WebView context (same-context is a harmless re-set of
 * the value we just wrote). Best-effort — failures are swallowed.
 */
async function reloadHistoryFromStorage(): Promise<void> {
  try {
    await loadHistory((k) => getBridge().getLocalStorage(k));
  } catch { /* best-effort */ }
}

export async function startHudRuntime(): Promise<void> {
  const isProviderConfigured = (): boolean => {
    const s = settings();
    if (s.provider === 'openai-compatible') return (s.openaiApiKeys[s.openaiBaseUrl] ?? '').trim().length >= 10;
    return s.geminiApiKey.trim().length >= 10;
  };
  const configured = isProviderConfigured();
  if (running) {
    if (configured) await showPickerPage();
    else await showUnconfiguredPage();
    return;
  }
  running = true;
  try {
    setAppPhase('booting');
    await bootstrapHud(configured ? 'picker' : 'unconfigured');
    // Kick off Silero VAD warmup in the background so the first user tap
    // pays no cold-start latency. Fire-and-forget — failures fall back to
    // the FFT heuristic inside `analyzeBufferForVoice`.
    void warmupVAD();
    setAppPhase('idle');
    unsubscribeEvents = getBridge().onEvenHubEvent(handleEvent);
    startSettingsWatcher();
  } catch (err) {
    running = false;
    setAppPhase('error');
    setErrorMessage(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export async function refreshHudPage(): Promise<void> {
  if (!running) return;
  const s = settings();
  const configured =
    s.provider === 'openai-compatible'
      ? (s.openaiApiKeys[s.openaiBaseUrl] ?? '').trim().length >= 10
      : s.geminiApiKey.trim().length >= 10;
  if (configured) await showPickerPage();
  else await showUnconfiguredPage();
}

export async function stopHudRuntime(): Promise<void> {
  if (!running) return;
  running = false;
  stopSettingsWatcher();
  stopSpinner();
  // Abort the auto-summary tick BEFORE clearing the timer, so a tick already
  // mid-fetch when shutdown begins doesn't keep its network call (and the WAV
  // / base64 closures behind it) alive past teardown.
  autoSummaryInflight?.abort();
  autoSummaryInflight = null;
  stopAutoSummaryTimer();
  // Same reasoning for the detached final-summary call: abort it so its WAV
  // closure can be GC'd immediately rather than living until Gemini responds.
  finalSummaryInflight?.abort();
  finalSummaryInflight = null;
  // System shutdown deliberately discards any accumulated intermediate
  // summaries — firing a Gemini call here would race the runtime teardown
  // (no reliable way to complete the fetch + localStorage write), so the
  // final summary only runs from the user-initiated leaveActiveSession path.
  intermediateSummaries = [];
  midSummaryController?.abort();
  midSummaryController = null;
  midSummaryResult = null;
  midSummaryLoading = false;
  unsubscribeEvents?.();
  unsubscribeEvents = null;
  inflight?.abort();
  inflight = null;
  analyzing = false;
  stopAutoModeWatcher();
  void setAutoModeIndicator(false);
  // Drop any in-flight game session along with its abort controller so the
  // next HUD start sees a clean slate.
  teardownGame();
  if (noVoiceStatusTimer) {
    clearTimeout(noVoiceStatusTimer);
    noVoiceStatusTimer = null;
  }
  if (errClearTimer) {
    clearTimeout(errClearTimer);
    errClearTimer = null;
  }
  buffer?.clear();
  buffer = null;
  // Drop the Silero session reference (calls release/destroy if exposed by the
  // wrapped library) and clear the cached availability flag so the next
  // `startHudRuntime → warmupVAD()` re-probes from scratch. Without the
  // availability reset, a previous-session init failure would lock the
  // runtime to the FFT fallback for the rest of the page lifetime even
  // after the underlying network / fetch issue clears.
  getSileroVAD().dispose();
  resetVADAvailability();
  try { await getBridge().audioControl(false); } catch { /* ignore */ }
  setAppPhase('idle');
}

interface Gesture { type: OsEventTypeList | undefined; itemIndex?: number; }

function extractGesture(event: EvenHubEvent): Gesture | null {
  if (event.listEvent) return { type: event.listEvent.eventType, itemIndex: event.listEvent.currentSelectItemIndex ?? 0 };
  if (event.sysEvent) {
    const et = event.sysEvent.eventType ?? 0; // protobuf: undefined → 0 = CLICK_EVENT
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

/**
 * Asks the host to surface its exit-confirmation dialog. exitMode=1 is the
 * dialog variant per `bridge.shutDownPageContainer` SDK semantics; mode 0
 * exits immediately and isn't what we want from a double-tap on the root
 * pages. Kept as a named helper so review tooling that scans the call graph
 * can see the exit handler is wired (called from handleEvent below).
 */
async function requestHostExitConfirm(): Promise<void> {
  await getBridge().shutDownPageContainer(1);
}

function isHandledLifecycleSysEvent(et: OsEventTypeList | undefined): boolean {
  // Narrowed to the two events the switch below actually handles. The
  // foreground enter/exit events are deliberately not listed — they fall
  // through to the gesture / no-op path so adding handling later is just a
  // new case rather than a guard mismatch.
  return (
    et === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    et === OsEventTypeList.ABNORMAL_EXIT_EVENT
  );
}

/** Centralised handler for unhandled rejections from `void`-dispatched async
 *  page handlers. Without this, a bridge.rebuild rejection inside e.g.
 *  handleMenuGesture surfaces as an unhandled rejection at the WebView level,
 *  which is a hard crash on strict platforms. Logged to the debug ring so the
 *  failure stays observable in the settings view. */
function logDispatchError(label: string, err: unknown): void {
  pushDebugEvent({
    label,
    detail: err instanceof Error ? err.message : String(err),
  });
}

function handleEvent(event: EvenHubEvent): void {
  if (import.meta.env.DEV && (event.listEvent || event.textEvent || event.sysEvent)) {
    console.info('[veritaslens] event', summarize(event));
  }

  if (event.sysEvent && isHandledLifecycleSysEvent(event.sysEvent.eventType)) {
    switch (event.sysEvent.eventType) {
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        stopHudRuntime().catch((err) => logDispatchError('stop-runtime-fail', err));
        return;
    }
  }

  if (event.audioEvent && buffer) { buffer.append(event.audioEvent.audioPcm); return; }

  if (event.textEvent) {
    const type = event.textEvent.eventType ?? 0;
    if (currentHudPage() === 'history-detail') {
      if (type === OsEventTypeList.SCROLL_TOP_EVENT) {
        scrollHistoryDetail(-1).catch((err) => logDispatchError('scroll-history-fail', err));
      } else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        scrollHistoryDetail(1).catch((err) => logDispatchError('scroll-history-fail', err));
      }
    } else if (currentHudPage() === 'active') {
      if (type === OsEventTypeList.SCROLL_TOP_EVENT) {
        handleActiveScroll(-1).catch((err) => logDispatchError('scroll-active-fail', err));
      } else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        handleActiveScroll(1).catch((err) => logDispatchError('scroll-active-fail', err));
      }
    }
    // mid-summary swipes are owned by the firmware (TextContainer overflow scroll).
    return;
  }

  const gesture = extractGesture(event);
  if (!gesture) return;

  // Any user gesture clears a lingering ERR glyph immediately, regardless of
  // which gesture it is. Fall through to the normal dispatch below so e.g. a
  // double-tap during ERR both clears the error and triggers the fresh
  // analysis it implies (the in-flight retry will overwrite the status on
  // its own; this branch only matters if the user gestures during the
  // 5-second auto-clear window). clearErrorState is a no-op if phase moved
  // on already, so it's safe to call unconditionally.
  if (appPhase() === 'error') clearErrorState();

  const page = currentHudPage();

  // Double-tap handling. From the root pages (picker, unconfigured) it asks
  // the host to surface its exit confirmation dialog — required by Even Hub
  // review so users always have a way out, even before an API key is set.
  // Everywhere else it starts analysis, or cancels an in-flight one.
  if (gesture.type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (page === 'picker' || page === 'unconfigured') {
      requestHostExitConfirm().catch((err) => logDispatchError('host-exit-fail', err));
      return;
    }
    if (page === 'games-picker') {
      // From the games sub-picker, double-tap returns to the main picker —
      // not host exit, since the wearer is one level down.
      lastGamesPickerIndex = 0;
      showPickerPage().catch((err) => logDispatchError('games-back-fail', err));
      return;
    }
    if (
      page === 'game-loading'
      || page === 'game-question'
      || page === 'game-feedback'
      || page === 'game-end'
      || page === 'game-save-prompt'
    ) {
      // Cancel in-flight generation OR exit mid-game. cancelGame routes the
      // wearer back to the games sub-picker so they can start something else.
      cancelGame().catch((err) => logDispatchError('cancel-game-fail', err));
      return;
    }
    if (analyzing) {
      // Cancel the in-flight analysis. Null `inflight` right here (in addition
      // to the controller-identity check in runAnalysis's finally) so the
      // analyzing flag's release isn't gated on whether a NEW analysis has
      // raced in between abort and finally — otherwise the user can get stuck
      // unable to start a new analysis until they leave the session.
      const c = inflight;
      inflight = null;
      analyzing = false;
      c?.abort();
      return;
    }
    runAnalysis().catch((err) => logDispatchError('run-analysis-fail', err));
    return;
  }

  if (page === 'picker') handlePickerEvent(gesture).catch((err) => logDispatchError('picker-fail', err));
  else if (page === 'active') handleActiveGesture(gesture).catch((err) => logDispatchError('active-fail', err));
  else if (page === 'menu') handleMenuGesture(gesture).catch((err) => logDispatchError('menu-fail', err));
  else if (page === 'history-list') handleHistoryListGesture(gesture).catch((err) => logDispatchError('history-list-fail', err));
  else if (page === 'history-detail') handleHistoryDetailGesture(gesture).catch((err) => logDispatchError('history-detail-fail', err));
  else if (page === 'mid-summary') handleMidSummaryGesture(gesture).catch((err) => logDispatchError('mid-summary-fail', err));
  else if (page === 'games-picker') handleGamesPickerEvent(gesture).catch((err) => logDispatchError('games-picker-fail', err));
  else if (page === 'game-question') handleGameQuestionEvent(gesture).catch((err) => logDispatchError('game-question-fail', err));
  else if (page === 'game-feedback') handleGameFeedbackEvent(gesture).catch((err) => logDispatchError('game-feedback-fail', err));
  else if (page === 'game-end') handleGameEndEvent(gesture).catch((err) => logDispatchError('game-end-fail', err));
  else if (page === 'game-save-prompt') handleGameSavePromptEvent(gesture).catch((err) => logDispatchError('game-save-prompt-fail', err));
  // game-loading absorbs single-tap gestures — only double-tap (cancel) acts.
}

async function handlePickerEvent(g: Gesture): Promise<void> {
  if (typeof g.itemIndex === 'number') lastPickerIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    const entry = pickerEntryAtIndex(lastPickerIndex);
    if (entry.kind === 'games') {
      await openGamesPicker();
      return;
    }
    const persona = entry.persona;
    // Block entry into Meeting Prep when no context exists — opening a
    // session would needlessly power the mic and allocate the ring buffer
    // for a lens that can't produce anything useful. Flash a hint on the
    // picker so the wearer knows why nothing happened.
    if (persona.id === MEETING_PREP_ID && !meetingPrepIsConfigured()) {
      await flashPickerHint('Add notes in phone settings first');
      return;
    }
    await enterActiveSession(persona.id);
  }
}

let lastGamesPickerIndex = 0;

async function handleGamesPickerEvent(g: Gesture): Promise<void> {
  if (typeof g.itemIndex === 'number') lastGamesPickerIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    const entry = gamesPickerEntryAtIndex(lastGamesPickerIndex);
    if (!entry || entry.kind === 'back') {
      lastGamesPickerIndex = 0;
      await showPickerPage();
      return;
    }
    if (entry.kind === 'random') {
      await startGame(materializeRandomPreset());
      return;
    }
    await startGame(entry.preset);
  }
}

async function handleGameQuestionEvent(g: Gesture): Promise<void> {
  if (typeof g.itemIndex === 'number') setLastGameOptionIndex(g.itemIndex);
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    await gameSelectAnswer(getLastGameOptionIndex());
  }
}

async function handleGameFeedbackEvent(g: Gesture): Promise<void> {
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    await gameAdvance();
  }
}

/** Mirror of `lastPickerIndex` for the 2-item save-prompt list. */
let lastSavePromptIndex = 0;

async function handleGameSavePromptEvent(g: Gesture): Promise<void> {
  if (typeof g.itemIndex === 'number') lastSavePromptIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    const entry = gameSavePromptEntryAtIndex(lastSavePromptIndex);
    if (!entry || entry.kind === 'back') {
      lastSavePromptIndex = 0;
      await dismissRandomSavePrompt();
      return;
    }
    await saveCurrentRandomAsPreset();
  }
}

async function handleGameEndEvent(g: Gesture): Promise<void> {
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    // advance() on phase 'end' returns to the games sub-picker.
    await gameAdvance();
  }
}

async function handleActiveGesture(g: Gesture): Promise<void> {
  // Single-tap (CLICK_EVENT or the normalized `undefined`) opens the menu.
  // For multi-claim results, claim navigation is via vertical swipe — which
  // arrives here as SCROLL_TOP/BOTTOM from the discreet text-container sink,
  // or via the textEvent branch in handleEvent for baseline (same sink type
  // now). scrollActiveReason swaps claims when multi-claim, otherwise
  // paginates a long reason.
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    await showMenuPage({
      exitGeneratesSummary: canGenerateFinalSummary(),
      dynamicItems: buildMidSummaryMenuItems(),
    });
    return;
  }
  if (g.type === OsEventTypeList.SCROLL_TOP_EVENT) {
    await handleActiveScroll(-1);
  } else if (g.type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    await handleActiveScroll(1);
  }
}

/**
 * Dispatch a swipe on the active page to the HUD and reconcile app phase with
 * the outcome. Reveal flips us back to 'displaying'; dismiss tears the result
 * down and returns to 'listening' — same end-state as tap → Back from the menu.
 */
async function handleActiveScroll(dir: 1 | -1): Promise<void> {
  const outcome = await scrollActiveReason(dir);
  if (outcome === 'revealed') {
    setAppPhase('displaying');
    await setStatus('displaying');
  } else if (outcome === 'hidden') {
    setAppPhase('listening');
  }
}

async function handleMenuGesture(g: Gesture): Promise<void> {
  if (typeof g.itemIndex === 'number') lastMenuIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    const option = menuOptionAtIndex(lastMenuIndex);
    switch (option) {
      case 'mid-summary':
      case 'mid-summary-refresh': {
        const reason = summaryGateReason();
        if (reason) { await flashMenuHint(reason, 5000); break; }
        await runMidSummary();
        break;
      }
      case 'mid-summary-view':
        await showMidSummaryPage(midSummaryLoading, midSummaryResult?.result ?? null);
        break;
      case 'mid-summary-loading': break; // disabled item — no-op
      case 'back': await handleBackMenuOption(); break;
      case 'fact-check': await restoreActivePage(); await runAnalysis(); break;
      case 'history': await showHistoryListPage(sessionHistory().filter(e => e.sessionId === currentSessionId)); break;
      case 'exit': await leaveActiveSession(); break;
    }
  }
}

/**
 * Back closes the menu and returns to the listening state, clearing any
 * answer that was on screen. In discreet mode that means returning to the
 * dot-only layout; in baseline it means the standard REC + hint view.
 */
async function handleBackMenuOption(): Promise<void> {
  // If a result arrived while the menu was open, surface it instead of
  // clearing — the user opened the menu before the answer was revealed and
  // expects to see it on return. When no pending result exists the menu was
  // opened after the answer was already on screen (or no analysis ran), and
  // Back should return to a clean recording view as before.
  if (hasPendingActiveResult()) {
    await restoreActivePage();
    await setStatus('displaying');
    await setActiveHint(ACTIVE_HINT_DEFAULT);
    setAppPhase('displaying');
    return;
  }
  setStateResult(null);
  setActiveLayout(settings().discreet ? 'discreet-minimal' : 'baseline');
  await restoreActivePage();
  // Preserve the result so a follow-up swipe-up re-reveals the last page the
  // user was viewing instead of decrementing from a stale index.
  markActiveHidden();
  setAppPhase('listening');
}

async function handleHistoryListGesture(g: Gesture): Promise<void> {
  if (typeof g.itemIndex === 'number') lastHistoryIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    if (lastHistoryIndex <= 0) { lastMenuIndex = 0; await restoreActivePage(); return; }
    const entries = getHistoryListEntries();
    // Bound by entry count too — a stale lastHistoryIndex from a prior page
    // that had more entries would otherwise read off the end (entry is then
    // undefined and the `if (entry)` below silently no-ops, but the explicit
    // bound makes the intent obvious).
    if (lastHistoryIndex > entries.length) return;
    const entry = entries[lastHistoryIndex - 1];
    if (entry) await showHistoryDetailPage(entry);
  }
}

async function handleHistoryDetailGesture(g: Gesture): Promise<void> {
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    await restoreHistoryListPage();
  }
}

async function handleMidSummaryGesture(g: Gesture): Promise<void> {
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    await showMenuPage({
      exitGeneratesSummary: canGenerateFinalSummary(),
      dynamicItems: buildMidSummaryMenuItems(),
    });
  }
}

async function enterActiveSession(personaId: PersonaId): Promise<void> {
  const persona = getPersona(personaId);
  if (!persona) { setErrorMessage(`Unknown lens: ${personaId}`); return; }
  // A previous session may have left a detached final-summary call in flight.
  // Abort it so its WAV closure is released and so its late history-write
  // can't interleave with this fresh session's writes.
  finalSummaryInflight?.abort();
  finalSummaryInflight = null;
  setActivePersona(personaId);
  currentSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  sessionStartTime = Date.now();
  // Seed cross-session recall when the user has opted in AND auto-summary is
  // also on — the recall builder gates on `autoSummaryEnabled`, so seeding
  // without it would silently no-op. Pulls the most-recent N session
  // summaries from persisted history into the same shape auto-summary
  // ticks populate during the live session.
  intermediateSummaries = settings().crossSessionRecallEnabled && settings().autoSummaryEnabled
    ? extractPriorSessionSummaries(sessionHistory())
    : [];
  lastAnalysisByteOffset = 0;
  lastAutoWinnerInSession = null;
  lastMenuIndex = 0;
  setActiveLayout(settings().discreet ? 'discreet-minimal' : 'baseline');
  await showActivePage(persona);
  buffer = new PcmRingBuffer({ durationSec: settings().bufferDuration, sampleRate: 16_000 });
  const micOk = await getBridge().audioControl(true);
  if (!micOk) {
    await setStatus('error');
    setErrorMessage('Microphone could not be opened.');
    setAppPhase('error');
    return;
  }
  startAutoSummaryTimer();
  syncAutoModeWatcher();
  setAppPhase('listening');
}

/**
 * Start or stop the VAD-driven auto-analysis watcher to match the current
 * settings + session state. Idempotent and safe to call from a reactive
 * effect (no work done when the desired state already matches reality).
 *
 * The watcher only runs while we have a live PCM buffer (mic open). Outside
 * an active session this is a no-op — the createEffect below covers the
 * case where the user toggles the setting while the mic is hot.
 */
function syncAutoModeWatcher(): void {
  const wantOn = settings().autoModeEnabled && buffer !== null;
  if (wantOn && !isAutoModeWatcherRunning()) {
    startAutoModeWatcher(buffer!, {
      getStartMs: () => settings().autoModeStartMs,
      getSilenceMs: () => settings().autoModeSilenceMs,
      getRmsFloor: () => settings().voiceGateRmsFloor,
      isAnalyzing: () => analyzing,
      trigger: () => {
        // Same entry point as a double-tap. Errors land in the debug ring
        // via logDispatchError so a transient API failure can't crash the
        // watcher's setInterval callback chain.
        runAnalysis().catch((err) => logDispatchError('auto-mode-trigger-fail', err));
      },
    });
    void setAutoModeIndicator(true);
  } else if (!wantOn && isAutoModeWatcherRunning()) {
    stopAutoModeWatcher();
    void setAutoModeIndicator(false);
  }
}

// Re-entrancy guard so cascading store-driven events can't double-fire the
// teardown + stop-time-summary chain. Set on entry, cleared on exit.
let leavingActiveSession = false;

async function leaveActiveSession(): Promise<void> {
  if (leavingActiveSession) return;
  leavingActiveSession = true;
  try {
    // Cancel any analysis still in flight so the answer doesn't arrive into a
    // session that no longer exists (which would set lensResult / pendingActive
    // long after the user has left). resetHudSessionState below clears the
    // pending stash, but the abort prevents a late callLens success from
    // reintroducing it via setLensResult.
    inflight?.abort();
    inflight = null;
    analyzing = false;
    if (noVoiceStatusTimer) {
      clearTimeout(noVoiceStatusTimer);
      noVoiceStatusTimer = null;
    }
    if (errClearTimer) {
      clearTimeout(errClearTimer);
      errClearTimer = null;
    }
    stopAutoModeWatcher();
    void setAutoModeIndicator(false);
    stopSpinner();
    // Abort any auto-summary tick already in flight, then stop the periodic
    // timer. Aborting first ensures a tick mid-await (e.g. inside callLens or
    // base64 encoding) terminates immediately and frees its WAV/base64 closures
    // before the final-summary path snapshots the buffer. Without the abort, a
    // stray tick could complete after teardown and push a stale intermediate
    // into the next session's accumulator.
    autoSummaryInflight?.abort();
    autoSummaryInflight = null;
    stopAutoSummaryTimer();
    midSummaryController?.abort();
    midSummaryController = null;
    midSummaryResult = null;
    midSummaryLoading = false;
    try { await getBridge().audioControl(false); } catch { /* ignore */ }
    // Snapshot the inputs for the stop-time summaries (last-tick + final
    // synthesis) while the buffer and session id are still live. Both calls
    // run in the background so the user is returned to the picker immediately.
    const stopTimeInputs = captureStopTimeInputs();
    intermediateSummaries = [];
    buffer?.clear();
    buffer = null;
    resetHudSessionState();
    await showPickerPage();
    setAppPhase('idle');
    // Refresh history before kicking off the background summary chain so the
    // settings WebView shows everything from the session that just ended.
    // runStopTimeSummaries reloads again on its own once each entry lands.
    await reloadHistoryFromStorage();
    if (stopTimeInputs) void runStopTimeSummaries(stopTimeInputs);
  } finally {
    leavingActiveSession = false;
  }
}

const SPINNER_FRAMES = ['|', '/', '-', '\\'];
const SPINNER_INTERVAL_MS = 200;
let spinnerTimer: ReturnType<typeof setTimeout> | null = null;
let spinnerPrefix = '';
// Generation counter bumped by stopSpinner so a tick callback already
// mid-flight when the timer is cleared discards its async setStatus /
// setMenuSpinner writes instead of overwriting the post-stop "displaying"
// status. Without this guard a single straggler tick can briefly revert the
// verdict back to a spinner frame.
let spinnerGen = 0;

function statusFrameContent(frame: string): string {
  return spinnerPrefix ? `${spinnerPrefix}${frame}` : ` ${frame}  `;
}

function startSpinner(): void {
  if (spinnerTimer) return;
  let i = 0;
  const gen = spinnerGen;
  // Push an initial frame immediately so the menu/status slot doesn't stay
  // blank for up to one tick after analysis begins. Update both canonical
  // buffers in lock-step (cheap module-level assignments, no SDK call), but
  // only push to the SDK for the slot that is currently visible. This halves
  // bridge throughput in steady state and keeps the unseen slot seeded for
  // when the user navigates to it mid-analysis.
  const dispatchFrame = async (frame: string): Promise<void> => {
    const page = currentHudPage();
    if (page === 'active') {
      await setStatus(statusFrameContent(frame));
      // Seed menuSpinner buffer without an SDK round trip.
      void setMenuSpinner(frame);
    } else if (page === 'menu') {
      await setMenuSpinner(frame);
      // Seed status buffer without an SDK round trip.
      void setStatus(statusFrameContent(frame));
    } else {
      // No visible spinner slot — just seed both buffers for later rebuilds.
      void setStatus(statusFrameContent(frame));
      void setMenuSpinner(frame);
    }
  };

  const tick = async (): Promise<void> => {
    if (gen !== spinnerGen) return; // stale tick after stopSpinner
    const frame = SPINNER_FRAMES[i]!;
    try {
      await dispatchFrame(frame);
    } finally {
      if (gen === spinnerGen) {
        i = (i + 1) % SPINNER_FRAMES.length;
        // Self-reschedule only after the SDK write resolves — caps cadence to
        // what the bridge can actually deliver and prevents the setInterval
        // catch-up burst that produced the jittery "freeze, then rush" motion.
        spinnerTimer = setTimeout(() => { void tick(); }, SPINNER_INTERVAL_MS);
      }
    }
  };

  // Mark the timer as running before the first await so a reentrant startSpinner
  // call (e.g. from onRetry) is a no-op while the first frame is in flight.
  spinnerTimer = setTimeout(() => { void tick(); }, 0);
}

function stopSpinner(): void {
  if (spinnerTimer) clearTimeout(spinnerTimer);
  spinnerTimer = null;
  spinnerPrefix = '';
  spinnerGen++;
  // Sync reset of the canonical buffers so any page rebuild that races the
  // async clear writes below (notably setLensResult → renderActivePage on the
  // success path) cannot bake a stale spinner glyph into the freshly built
  // status container.
  clearStatusFrame();
  clearMenuSpinnerFrame();
  void setMenuSpinner('');
  void setStatus('listening');
}

/**
 * Format the already-answered claims block. Filtered to the *current* session
 * only — previous sessions are unrelated context and would just inflate the
 * prompt. Includes the verbatim quote when present so the LLM can anchor
 * against the exact spoken utterance, not just the topic label.
 */
function buildAlreadyAnsweredLines(): string[] {
  const entries = sessionHistory()
    .filter((e) => e.sessionId === currentSessionId)
    .slice(-5);
  return entries.map((e, i) => {
    const q = (e.question ?? '').trim() || '(no question)';
    const quote = (e.quote ?? '').trim();
    return quote ? `${i + 1}. "${quote}" → ${q}` : `${i + 1}. ${q}`;
  });
}

const ALREADY_ANSWERED_DIRECTIVE =
  'ALREADY ANSWERED in this conversation — do NOT re-extract, re-answer, or include these claims even if they appear again in the audio. If the audio contains ONLY these (nothing new), set noSpeech=true. If the audio contains both these and something new, analyze ONLY the new content and skip the rest:';

/**
 * Cancel the ERR auto-clear timer and, if we're still sitting in the error
 * phase, demote the HUD back to listening. Safe to call from anywhere — the
 * phase guard makes it a no-op when the user has already moved past the
 * error (e.g. by starting a new analysis that itself set the phase).
 */
function clearErrorState(): void {
  if (errClearTimer) {
    clearTimeout(errClearTimer);
    errClearTimer = null;
  }
  if (appPhase() !== 'error') return;
  setErrorMessage(null);
  void setStatus('listening');
  setAppPhase('listening');
}

function buildPromptWithContext(persona: Persona, lang: LanguageCode): string {
  const base = persona.buildPrompt(lang);
  const recent = buildAlreadyAnsweredLines();
  const recall = buildRecallContextLines(intermediateSummaries, settings().autoSummaryEnabled);
  const parts = [
    'Focus only on clear human speech in the audio. Ignore background noise, music, and non-speech sounds.',
    'If no clear human speech is detected, set noSpeech to true in your response.',
    '',
    base,
  ];
  // Recall context first (general background), then the already-answered
  // directive (hard rule) closest to the call so the model's last-seen
  // instruction is the suppression list, not the "look back" context.
  if (recall.length > 0) {
    parts.push('', RECALL_CONTEXT_DIRECTIVE, ...recall);
  }
  if (recent.length > 0) {
    parts.push('', ALREADY_ANSWERED_DIRECTIVE, ...recent);
  }
  return parts.join('\n');
}

/**
 * Mirror of buildPromptWithContext for Meeting Prep — wraps the same speech-
 * focus preamble and recent-list around the section-aware prompt. Kept as a
 * dedicated helper so the runtime doesn't need to make the Persona shape
 * accept a sections argument.
 */
function buildMeetingPromptWithContext(
  _persona: Persona,
  lang: LanguageCode,
  sections: MeetingPrepSection[],
): string {
  const base = buildMeetingPrepPrompt(lang, sections);
  const recent = buildAlreadyAnsweredLines();
  const recall = buildRecallContextLines(intermediateSummaries, settings().autoSummaryEnabled);
  const parts = [
    'Focus only on clear human speech in the audio. Ignore background noise, music, and non-speech sounds.',
    'If no clear human speech is detected, set noSpeech to true in your response.',
    '',
    base,
  ];
  if (recall.length > 0) {
    parts.push('', RECALL_CONTEXT_DIRECTIVE, ...recall);
  }
  if (recent.length > 0) {
    parts.push('', ALREADY_ANSWERED_DIRECTIVE, ...recent);
  }
  return parts.join('\n');
}

function buildContextBlock(personaName: string): string {
  const now = new Date();
  const date = now.toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = now.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  const audioSecs = buffer?.secondsBuffered ?? 0;
  const count = sessionHistory().length;
  const mins = Math.floor((Date.now() - sessionStartTime) / 60_000);

  return [
    '# CONTEXT',
    `Date: ${date}`,
    `Time: ${time} (local)`,
    `Audio: ${audioSecs}s buffered`,
    `Session: ${mins}m active, ${count} ${count === 1 ? 'analysis' : 'analyses'}, ${personaName} lens`,
    '',
    'When the audio uses relative time references ("today", "tomorrow", "yesterday", "in N days", "until X", "how long until Y", "how long ago was Z"), resolve them against the Date and Time fields above as ground truth. If the audio asks a question whose answer requires calendar or clock arithmetic from "now", compute it and give a direct answer rather than skipping the question.',
  ].join('\n');
}

/**
 * Surface the no-voice gate's feedback. Both layouts get the same glyph in
 * the top-right status slot so the icon vocabulary is consistent — the
 * wearer learns the symbols once and they mean the same thing everywhere:
 *   `○` = nothing to analyse (silence) — the natural inverse of the `•`
 *         recording-dot rest state, reads as "empty"
 *   `~` = too noisy — ASCII tilde, reads as "wave / interference"
 * Reverts to the layout's rest state after ~2.5 s.
 *
 * Glyphs were chosen from the LVGL firmware-font safe sets documented in
 * the Even Hub design guidelines (Selection: `●○ ■□ ★☆`; basic ASCII).
 * Out-of-font glyphs render as nothing on the G2 — earlier attempts with
 * `∅` (U+2205) and `≋` (U+224B) were silently dropped by the firmware.
 *
 * Baseline additionally writes the full message to the bottom hint slot
 * (456 px wide — fits the text comfortably) so the glyph is reinforced by
 * a readable explanation. Discreet has no hint row by design, so the glyph
 * is the only on-glasses signal; the full message is logged to the debug
 * panel (`no-voice-gate` entries) for after-the-fact verification.
 */
let noVoiceStatusTimer: ReturnType<typeof setTimeout> | null = null;

async function showNoVoiceFeedback(message: string): Promise<void> {
  pushDebugEvent({ label: 'no-voice-gate', detail: message });
  await flashActiveHint(message);
  const noisy = message.toLowerCase().includes('noisy');
  await setStatus(noisy ? '~' : '○');
  // Track the revert timer so leaveActiveSession / stopHudRuntime can cancel
  // it. Without this, a user exiting the session within 2.5 s of a no-voice
  // tap would have setStatus('listening') write to a torn-down HUD page.
  if (noVoiceStatusTimer) clearTimeout(noVoiceStatusTimer);
  noVoiceStatusTimer = setTimeout(() => {
    noVoiceStatusTimer = null;
    void setStatus('listening');
  }, 2500);
}

async function runAnalysis(): Promise<void> {
  const page = currentHudPage();
  if (page === 'history-list' || page === 'history-detail' || page === 'mid-summary') await restoreActivePage();
  if (currentHudPage() !== 'active') return;

  if (!buffer || buffer.bytesBuffered === 0) {
    // User tapped before any audio arrived (e.g. immediately after entering
    // the lens). Surface the same "no speech" feedback as the gate below
    // instead of silently returning so the wearer knows the tap registered.
    await showNoVoiceFeedback('No speech captured');
    setAppPhase('listening');
    return;
  }

  const s = settings();
  const apiKey = s.provider === 'openai-compatible'
    ? (s.openaiApiKeys[s.openaiBaseUrl] ?? '')
    : s.geminiApiKey;
  if (!apiKey) {
    await setStatus('error');
    setErrorMessage(
      s.provider === 'openai-compatible'
        ? `No ${openaiHostLabel(s.openaiBaseUrl)} API key.`
        : 'No Gemini API key.',
    );
    return;
  }

  const persona = getPersona(activePersona());
  if (!persona) return;

  // Empty-context guard for Meeting Prep: show a clear "configure on phone"
  // message and skip the API call entirely. The user can leave context empty
  // and still pick the lens from the picker, so this needs to be friendly
  // rather than an error.
  if (persona.id === MEETING_PREP_ID && !meetingPrepIsConfigured()) {
    const guidance: LensResult = {
      type: 'meeting-prep',
      claims: [{
        kind: 'answer',
        text: 'Add meeting context in phone settings to use this lens.',
        source: '',
        detail: '',
      }],
    };
    setStateResult(guidance);
    if (settings().discreet && getActiveLayout() !== 'discreet-minimal') {
      setActiveLayout('discreet-minimal');
    }
    await restoreActivePage();
    await setLensResult(guidance);
    await setStatus('displaying');
    await setActiveHint(ACTIVE_HINT_DEFAULT);
    setAppPhase('displaying');
    return;
  }

  // No-voice gate: analyse only audio captured *since the last analysis
  // trigger* (not the whole buffer). This makes re-tapping in silence after
  // a fresh analysis correctly report "no speech captured" — otherwise the
  // already-analysed voice content earlier in the buffer would falsely pass
  // the gate. The LLM's own noSpeech flag remains the safety net for
  // ambiguous audio that DOES contain at least one voice frame.
  //
  // Bypassed when the user sets `voiceGateRmsFloor` to 0 (Settings → Voice
  // detection → Off). Higher floor values make the gate stricter (only louder
  // input passes); lower values are more permissive — useful when the G2's
  // low-amplitude mic capture is being misclassified as silence.
  const rmsFloor = settings().voiceGateRmsFloor;
  if (rmsFloor > 0) {
    const sincePcm = buffer.linearPcmSince(lastAnalysisByteOffset);
    const gatePcm = tailPcm(sincePcm, buffer.sampleRate, VAD_GATE_WINDOW_SEC);
    const va = await analyzeBufferForVoice(gatePcm, buffer.sampleRate, rmsFloor);
    if (va.voiceFrames === 0) {
      const noisy = va.noiseFrames > va.silenceFrames;
      await showNoVoiceFeedback(noisy ? 'Too noisy to pick up voice' : 'No speech captured');
      setAppPhase('listening');
      return;
    }
  }
  // Snapshot the buffer + byte position only after the gate passes. Allocating
  // the linear PCM copy (~10 MB at the default buffer, ~190 MB at 5 min) and
  // bumping the byte offset are wasted work when the gate rejects.
  //
  // Use `linearPcmSince(lastAnalysisByteOffset)` rather than `toLinearPcm()`
  // so the LLM only sees audio captured *since the previous successful
  // analysis*. The first tap of a session has offset 0 → it sees the whole
  // buffer. Each subsequent tap sees only what was said since the last one,
  // which (a) prevents Gemini from re-answering the same claim across
  // consecutive taps and (b) shrinks the upload on rapid-tap workflows.
  const linearPcm = buffer.linearPcmSince(lastAnalysisByteOffset);
  lastAnalysisByteOffset = buffer.bytesProduced;

  // Clear the store signal for sibling components (settings WebView). The HUD
  // intentionally keeps the previous answer on screen during analysis so the
  // wearer can review it while the spinner animates in the corner status slot
  // (added to every active-page layout). Only rebuild the page when there is
  // nothing meaningful to keep — e.g. on the first analysis of a session where
  // the layout is still discreet-minimal/baseline idle.
  setStateResult(null);

  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  analyzing = true;
  setAppPhase('thinking');
  // The spinner writes its first frame synchronously; an intermediate
  // setStatus('thinking') here would flash '...' before the spinner takes
  // over, so we skip it and let the spinner own the status slot.
  await setActiveHint(ACTIVE_HINT_ANALYZING);
  startSpinner();

  try {
    // VAD-trim the upload to just the detected speech regions when enabled
    // (default) and Silero is available. The gate above already confirmed at
    // least one voice frame in the recent tail; here we re-run Silero against
    // the full buffer to enumerate every region, then crop. Falls back to the
    // full PCM silently when Silero is unavailable (FFT fallback returns
    // `null` segments) or when trimming would not shrink the payload.
    let pcmForUpload = linearPcm;
    if (settings().voiceTrimEnabled) {
      // Reuse the same RMS floor as the gate so trim and gate agree on what
      // counts as silence — passing the historical 200 here while the gate
      // used a lenient value would let the trim drop speech the gate
      // accepted. When the gate is off (`rmsFloor === 0`), fall back to the
      // historical default so trim still has a meaningful floor; trim is
      // controlled by its own `voiceTrimEnabled` toggle anyway.
      const trimFloor = rmsFloor > 0 ? rmsFloor : 200;
      const segments = await extractSpeechSegments(linearPcm, buffer.sampleRate, trimFloor);
      if (segments && segments.length > 0) {
        const trimmed = trimPcmToSegments(linearPcm, segments, {
          sampleRate: buffer.sampleRate,
          bytesPerSample: buffer.bitsPerSample / 8,
        });
        if (trimmed.length < linearPcm.length) {
          pushDebugEvent({
            label: 'vad-trim',
            detail: `${Math.round(linearPcm.length / 1024)}KB → ${Math.round(trimmed.length / 1024)}KB (${segments.length} seg)`,
          });
          pcmForUpload = trimmed;
        }
      }
    }
    const wav = encodePcmToWav(pcmForUpload, {
      sampleRate: buffer.sampleRate,
      bitsPerSample: buffer.bitsPerSample,
      channels: buffer.channels,
    });
    const lang = settings().responseLanguage;
    const onRetry = async (attempt: number): Promise<void> => {
      // Keep the spinner running and switch its prefix to the retry label so
      // the indicator animates as e.g. R1/2|, R1/2/, R1/2- through the retry
      // wait and the next request, instead of freezing on a static label.
      spinnerPrefix = `R${attempt}/${MAX_RETRIES}`;
      if (!spinnerTimer) startSpinner();
    };

    // Meeting Prep follows a dedicated flow: prompt and schema are built from
    // the user's prepared sections (read from the store at call time so a mid-
    // session settings edit takes effect on the next tap). Follow-ups stay
    // folded into the single history entry rather than fanning out — they're
    // suggestions, not standalone facts.
    if (persona.id === MEETING_PREP_ID) {
      const sections = meetingPrepSections();
      const meetingPrompt = buildMeetingPromptWithContext(persona, lang, sections);
      const meetingSchema = buildMeetingPrepSchema(sections);
      const meetingContext = buildContextBlock(persona.name);
      const rawText = await callLens({
        wav,
        prompt: `${meetingContext}\n\n${meetingPrompt}`,
        schema: meetingSchema,
        signal: controller.signal,
        onRetry,
      });
      const result = parseMeetingPrepResponse(rawText, sections);
      stopSpinner();
      setStateResult(result);
      const newEntryId = await pushHistoryEntry({
        sessionId: currentSessionId,
        lensId: persona.id,
        lensName: persona.name,
        question: extractQuestion(result),
        badge: extractBadge(result),
        quote: extractQuote(result),
        result,
        tags: extractTags(result),
      }, (k, v) => getBridge().setLocalStorage(k, v));
      await reloadHistoryFromStorage();
      // Pass the full session context so multiple Meeting Prep questions in
      // the same session accumulate as separate entries — without this, the
      // direct-call path in setLensResult would replace sessionEntries with a
      // synthetic one-entry list, breaking cross-question swipe-up navigation.
      const sessionEntriesNext = sessionHistory().filter((e) => e.sessionId === currentSessionId);
      await setLensResult(result, { sessionEntries: sessionEntriesNext, newEntryIds: new Set([newEntryId]) });
      await setStatus('displaying');
      await setActiveHint(ACTIVE_HINT_DEFAULT);
      setAppPhase('displaying');
      return;
    }

    let analysisPersona: Persona = persona;
    let autoSelected = false;
    /**
     * Set to the speculative call's raw text when the classifier confirms its
     * pick matched our guess — that result is reused directly instead of
     * issuing a second, sequential lens call. `null` means "no usable
     * speculative result; run the main lens call below."
     */
    let speculativeRawText: string | null = null;

    if (persona.id === 'auto') {
      const enabled = (AUTO_LENS_CANDIDATES as readonly string[]).filter(
        (id) => !settings().autoDisabledLenses.includes(id),
      );
      if (enabled.length === 0) {
        stopSpinner();
        await setStatus('No Auto lenses enabled — configure in settings');
        return;
      }
      const classifierPrompt = buildPromptWithContext(
        { ...persona, buildPrompt: (l: LanguageCode) => buildAutoPrompt(l, enabled) },
        lang,
      );
      const classifierContext = buildContextBlock(persona.name);
      const classifierModel = chooseClassifierModel(settings());
      const classifierCall = callLens({
        wav,
        prompt: `${classifierContext}\n\n${classifierPrompt}`,
        schema: buildAutoClassifierSchema(enabled),
        model: classifierModel,
        signal: controller.signal,
        onRetry,
      });

      // Fire a speculative lens call in parallel against the previous Auto
      // winner in this session. First tap of a session has no signal yet —
      // we skip the speculative call entirely so a cold guess can't waste
      // tokens. On hit we save one full sequential lens RTT.
      const speculativeId = lastAutoWinnerInSession;
      const speculativeLens =
        speculativeId && speculativeId !== persona.id ? getPersona(speculativeId) : null;
      const speculativeCtrl = new AbortController();
      // Forward outer aborts (user cancel via double-tap, settings change,
      // teardown) onto the speculative controller so its fetch releases too.
      const forwardAbort = (): void => speculativeCtrl.abort();
      controller.signal.addEventListener('abort', forwardAbort, { once: true });
      let speculativeCall: Promise<string> | null = null;
      if (speculativeLens) {
        const specPrompt = buildPromptWithContext(speculativeLens, lang);
        const specContext = buildContextBlock(speculativeLens.name);
        speculativeCall = callLens({
          wav,
          prompt: `${specContext}\n\n${specPrompt}`,
          schema: speculativeLens.schema,
          signal: speculativeCtrl.signal,
          // Deliberately no onRetry: only the foreground call's retries
          // should flash R1/2/3 on the HUD spinner.
        });
        // Attach a no-op catch so an aborted-on-miss speculative doesn't
        // surface as an unhandled rejection while the classifier finishes.
        void speculativeCall.catch(() => undefined);
      }

      let chosenLensId: string;
      try {
        chosenLensId = parseAutoClassifierResponse(await classifierCall).chosenLensId;
      } catch (err) {
        speculativeCtrl.abort();
        controller.signal.removeEventListener('abort', forwardAbort);
        throw err;
      }

      const chosen = getPersona(chosenLensId);
      if (!chosen) {
        speculativeCtrl.abort();
        controller.signal.removeEventListener('abort', forwardAbort);
        stopSpinner();
        setErrorMessage(`Auto classifier returned unknown lens: ${chosenLensId}`);
        await setStatus('error');
        setAppPhase('error');
        return;
      }
      analysisPersona = chosen;
      autoSelected = true;
      lastAutoWinnerInSession = chosenLensId;

      if (speculativeCall && chosenLensId === speculativeId) {
        // Speculative was correct — wait for it. If it errored for any
        // non-cancel reason we fall through to a fresh main call.
        try {
          speculativeRawText = await speculativeCall;
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err;
          pushDebugEvent({
            label: 'auto-spec-fail',
            detail: err instanceof Error ? err.message : String(err),
          });
          speculativeRawText = null;
        }
      } else {
        speculativeCtrl.abort();
      }
      controller.signal.removeEventListener('abort', forwardAbort);
    }

    let rawText: string;
    if (speculativeRawText !== null) {
      rawText = speculativeRawText;
    } else {
      const analysisPrompt = buildPromptWithContext(analysisPersona, lang);
      const analysisContext = buildContextBlock(analysisPersona.name);
      rawText = await callLens({
        wav,
        prompt: `${analysisContext}\n\n${analysisPrompt}`,
        schema: analysisPersona.schema,
        signal: controller.signal,
        onRetry,
      });
    }
    const result = analysisPersona.parse(rawText);
    if (autoSelected) result.autoSelected = true;
    stopSpinner();
    setStateResult(result);
    // Single atomic write for all per-claim history entries — see
    // pushHistoryEntries for the race it prevents (concurrent persist calls
    // overwriting each other with stale snapshots). Capture the returned ids
    // so the HUD's session-wide swipe scroll knows which entries belong to
    // this just-finished analysis (drives the "1/N within-analysis" indicator).
    const freshIds = await pushHistoryEntries(
      splitResultByClaim(result).map((single, idx) => ({
        sessionId: currentSessionId,
        lensId: analysisPersona.id,
        lensName: analysisPersona.name,
        question: extractQuestion(single),
        badge: single.type === 'key-questions' ? `Q${idx + 1}` : extractBadge(single),
        quote: extractQuote(single),
        result: single,
        tags: extractTags(single),
      })),
      (k, v) => getBridge().setLocalStorage(k, v),
    );
    await reloadHistoryFromStorage();
    const sessionEntriesNext = sessionHistory().filter((e) => e.sessionId === currentSessionId);
    await setLensResult(result, { sessionEntries: sessionEntriesNext, newEntryIds: new Set(freshIds) });
    await setStatus('displaying');
    await setActiveHint(ACTIVE_HINT_DEFAULT);
    setAppPhase('displaying');
  } catch (err) {
    stopSpinner();
    if ((err as Error)?.name === 'AbortError') {
      // User cancelled via double-tap (which nulls `inflight` and clears
      // `analyzing` at the call site), or a back-to-back analysis aborted this
      // one. Either way the finally's identity check is enough to clear our
      // own controller — no extra reset needed here.
      await setStatus('listening');
      await setActiveHint(ACTIVE_HINT_DEFAULT);
      setAppPhase('listening');
      return;
    }
    if ((err as Error)?.name === 'NoSpeechError') {
      // The LLM saw the audio but decided no clear speech was present
      // (typically humming, mouth sounds, or voice-shaped noise that passed
      // the local gate's voice-band heuristic). Surface the same visual as
      // the local gate so the wearer's mental model of `○` is consistent —
      // "no usable speech was found", regardless of which stage caught it.
      await showNoVoiceFeedback('No speech captured');
      await setActiveHint(ACTIVE_HINT_DEFAULT);
      setAppPhase('listening');
      return;
    }
    setErrorMessage(err instanceof Error ? err.message : String(err));
    // UploadTimeoutError gets its own `T/O` glyph so the wearer can
    // distinguish a stalled upload (often "try again on better signal" or
    // "shrink the buffer") from a generic provider error. Same auto-clear
    // timer as ERR — the recovery path is identical. 3 chars (matching ERR's
    // shape) keeps it inside the 55px status slot — `TIMEOUT` would overflow.
    const isTimeout = (err as Error)?.name === 'UploadTimeoutError';
    await setStatus(isTimeout ? 'T/O' : 'error');
    await setActiveHint(ACTIVE_HINT_DEFAULT);
    setAppPhase('error');
    // Schedule the ERR glyph auto-clear so the wearer isn't stuck staring at
    // a sticky corner indicator with no obvious recovery gesture. Any user
    // gesture (see handleEvent) also clears it earlier, and a double-tap
    // retry both clears AND starts a fresh analysis. Replaces any prior
    // pending timer (back-to-back errors restart the countdown rather than
    // firing two clears on overlapping timelines).
    if (errClearTimer) clearTimeout(errClearTimer);
    errClearTimer = setTimeout(clearErrorState, ERR_AUTO_CLEAR_MS);
  } finally {
    // Identity check prevents clobbering a newer controller spawned by a
    // back-to-back analysis. Nulling inflight here releases the AbortController
    // and, through its closure, the WAV snapshot that can be up to ~19 MB at
    // the maximum buffer duration. The cancel path in handleEvent also clears
    // `analyzing`/`inflight` directly so a stuck flag can't strand the user
    // even if the controller-identity check below misses on a race.
    if (inflight === controller) {
      analyzing = false;
      inflight = null;
    }
  }
}


/** Auto-summary cadence — scales with bufferDuration so summaries fire roughly
 *  as the audio ring buffer rolls over (otherwise speech can scroll out of the
 *  ring before being captured in a summary, leaving recall blind). 60 s floor
 *  caps request cost on the smallest buffer setting; 2× factor gives silent
 *  ticks room without starving coverage. */
const AUTO_SUMMARY_MIN_INTERVAL_MS = 60_000;
function autoSummaryIntervalMs(bufferDurationSec: number): number {
  return Math.max(AUTO_SUMMARY_MIN_INTERVAL_MS, 2 * bufferDurationSec * 1000);
}

/**
 * Return at most the most-recent `maxSeconds` of audio from a 16-bit LE PCM
 * buffer. Used by the VAD gate to bound Silero inference latency on long
 * ring-buffer windows. Returns the original buffer if it's already shorter.
 */
function tailPcm(pcm: Uint8Array, sampleRate: number, maxSeconds: number): Uint8Array {
  const maxBytes = maxSeconds * sampleRate * 2; // 16-bit mono ⇒ 2 bytes/sample
  if (pcm.length <= maxBytes) return pcm;
  return pcm.subarray(pcm.length - maxBytes);
}

/**
 * Disposer for the Solid effect that watches "critical" settings — the ones
 * that invalidate the audio capture path when changed (provider, model, API
 * key, buffer duration). On change, an active session is torn down via
 * leaveActiveSession so the HUD resets to the picker and the mic releases.
 */
let settingsWatchDispose: (() => void) | null = null;

function startSettingsWatcher(): void {
  if (settingsWatchDispose) return;
  createRoot((dispose) => {
    settingsWatchDispose = dispose;
    // Concatenate only the fields that affect audio capture / send-path
    // identity into a single tracked key. Unrelated fields (responseLanguage,
    // discreet, autoSummaryEnabled) are intentionally omitted so toggling
    // them mid-session does NOT stop recording.
    const criticalKey = (): string => {
      const s = settings();
      return [
        s.provider,
        s.geminiApiKey,
        s.geminiModel,
        s.geminiAutoModel,
        s.openaiApiKeys[s.openaiBaseUrl] ?? '',
        s.openaiBaseUrl,
        s.openaiModel,
        s.bufferDuration,
      ].join('|');
    };
    let initial = true;
    createEffect(on(criticalKey, () => {
      // `on()` fires once on registration with the initial value — skip it so
      // startup doesn't immediately call leaveActiveSession.
      if (initial) { initial = false; return; }
      // No active session ⇒ nothing to tear down. Also guard against the
      // re-entry flag inside leaveActiveSession itself.
      if (!buffer || leavingActiveSession) return;
      void leaveActiveSession();
    }));
    // Toggle the auto-mode VAD watcher live whenever the user flips the
    // Settings switch — no session restart required. Threshold changes
    // (start/silence ms) don't need their own effect because the watcher
    // re-reads `settings().autoModeStartMs` / `autoModeSilenceMs` on every
    // tick via the `get*` callbacks it was started with.
    createEffect(() => {
      // Read the signal so Solid tracks the dependency.
      settings().autoModeEnabled;
      syncAutoModeWatcher();
    });
  });
}

function stopSettingsWatcher(): void {
  if (settingsWatchDispose) {
    settingsWatchDispose();
    settingsWatchDispose = null;
  }
}

function startAutoSummaryTimer(): void {
  stopAutoSummaryTimer();
  const s = settings();
  if (!s.autoSummaryEnabled) return;
  autoSummaryTimer = setInterval(
    () => void runAutoSummary(),
    autoSummaryIntervalMs(s.bufferDuration),
  );
}

function stopAutoSummaryTimer(): void {
  if (autoSummaryTimer) clearInterval(autoSummaryTimer);
  autoSummaryTimer = null;
}

/**
 * Whether a final summary can be produced if the user exits right now: the
 * auto-summary feature is enabled AND at least one intermediate tick has fired.
 * Drives the Menu page's Exit-row label.
 */
function canGenerateFinalSummary(): boolean {
  return settings().autoSummaryEnabled && intermediateSummaries.length > 0;
}

/** Minimum session duration before any summary will be generated. */
const MIN_SUMMARY_RECORDING_MS = 60_000;

/**
 * Common gate for any summary generation (auto / mid / stop-time): at least
 * 60 s of recording AND at least one user-driven analysis in the current
 * session. Summary entries themselves don't count as analyses — only taps
 * that produced an answer do.
 */
function canRunSummary(): boolean {
  if (Date.now() - sessionStartTime < MIN_SUMMARY_RECORDING_MS) return false;
  return sessionHistory().some(
    (e) => e.sessionId === currentSessionId && e.lensId !== SESSION_SUMMARY_ID,
  );
}

/**
 * Specific reason `canRunSummary()` is false, for surfacing as a 5 s hint when
 * the user taps the disabled mid-summary row. Null when the gate is open.
 */
function summaryGateReason(): string | null {
  if (Date.now() - sessionStartTime < MIN_SUMMARY_RECORDING_MS) return 'Record ≥1 min first';
  const hasAnalysis = sessionHistory().some(
    (e) => e.sessionId === currentSessionId && e.lensId !== SESSION_SUMMARY_ID,
  );
  if (!hasAnalysis) return 'Ask a question first';
  return null;
}

function buildMidSummaryMenuItems(): MenuItem[] {
  const items: MenuItem[] = [];
  const gateOk = canRunSummary();
  if (midSummaryResult) {
    const relTime = formatRelativeTime(midSummaryResult.generatedAt);
    items.push({ id: 'mid-summary-view', label: `Summary — ${relTime}` });
    if (midSummaryLoading) {
      items.push({ id: 'mid-summary-loading', label: 'Generating summary...', disabled: true });
    } else {
      items.push({ id: 'mid-summary-refresh', label: 'Refresh summary', disabled: !gateOk });
    }
  } else {
    if (midSummaryLoading) {
      items.push({ id: 'mid-summary-loading', label: 'Generating summary...', disabled: true });
    } else {
      items.push({ id: 'mid-summary', label: 'Mid-session summary', disabled: !gateOk });
    }
  }
  return items;
}

async function runAutoSummary(): Promise<void> {
  if (!buffer || buffer.bytesBuffered === 0) return;
  // Skip when the active provider has no API key — the facade would throw
  // and we'd just be burning Silero inference time before discovering that.
  if (!activeApiKey()) return;
  // Don't summarise a session that has no human input yet (no analyses) or
  // hasn't accumulated enough recording for a summary to be meaningful.
  if (!canRunSummary()) return;
  // Always gate auto-summary on voice presence — there is no user knob for
  // this because there is nothing to summarise in a silent/noisy window, and
  // skipping the API call here is pure upside.
  const linearPcm = buffer.toLinearPcm();
  const summaryFloor = settings().voiceGateRmsFloor;
  if (summaryFloor > 0) {
    const va = await analyzeBufferForVoice(linearPcm, buffer.sampleRate, summaryFloor);
    if (va.totalFrames > 0 && va.voiceFrames === 0) return;
  }
  // Per-tick abort handle so leaveActiveSession / stopHudRuntime can cancel
  // a tick mid-fetch. The identity check on success ensures we don't push a
  // result that arrived after an exit reset the accumulator.
  autoSummaryInflight?.abort();
  const controller = new AbortController();
  autoSummaryInflight = controller;
  let wav: Uint8Array | null = encodePcmToWav(linearPcm, {
    sampleRate: buffer.sampleRate,
    bitsPerSample: buffer.bitsPerSample,
    channels: buffer.channels,
  });
  try {
    const rawText = await callLens({
      wav,
      prompt: buildSessionSummaryPrompt(settings().responseLanguage),
      schema: SESSION_SUMMARY_SCHEMA,
      signal: controller.signal,
    });
    // Release the WAV reference as soon as the network call resolves so GC can
    // reclaim it during JSON parsing rather than holding it across the parse.
    wav = null;
    if (controller.signal.aborted) return;
    const result = parseSessionSummaryResponse(rawText);
    if (autoSummaryInflight !== controller) return; // stale tick — discard
    // Intermediate tick — accumulate text in memory only. The final end-of-
    // session call folds these into one history entry; intermediates never
    // appear in History on their own.
    if (result.type === 'session-summary' && result.summary.trim().length > 0) {
      intermediateSummaries.push({
        title: result.title,
        summary: result.summary,
        topics: result.topics,
        keyPoints: result.keyPoints,
        quote: result.quote,
      });
    }
  } catch (err) {
    wav = null;
    if ((err as Error)?.name === 'AbortError') return;
    // Auto-summary is best-effort, but failures should be observable in the
    // debug log so the user can see why the timer is firing without producing
    // entries (network down, quota, etc.).
    pushDebugEvent({
      label: 'auto-summary-fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (autoSummaryInflight === controller) autoSummaryInflight = null;
  }
}

async function runMidSummary(): Promise<void> {
  if (!canRunSummary()) {
    midSummaryLoading = false;
    await showMidSummaryPage(false, null);
    return;
  }
  const hasHistory = sessionHistory().some((e) => e.sessionId === currentSessionId);
  const hasAudio = buffer !== null && buffer.bytesBuffered > 0;
  if (!hasHistory && !hasAudio) {
    midSummaryLoading = false;
    await showMidSummaryPage(false, null);
    return;
  }

  midSummaryController?.abort();
  const controller = new AbortController();
  midSummaryController = controller;
  midSummaryLoading = true;

  await showMidSummaryPage(true, midSummaryResult?.result ?? null);

  let wav: Uint8Array | null = buffer
    ? encodePcmToWav(buffer.toLinearPcm(), {
        sampleRate: buffer.sampleRate,
        bitsPerSample: buffer.bitsPerSample,
        channels: buffer.channels,
      })
    : null;
  try {
    const rawText = await callLens({
      wav: wav ?? new Uint8Array(0),
      prompt: buildSessionSummaryPrompt(settings().responseLanguage),
      schema: SESSION_SUMMARY_SCHEMA,
      signal: controller.signal,
    });
    wav = null;
    if (controller.signal.aborted) return;
    const result = parseSessionSummaryResponse(rawText);
    if (midSummaryController !== controller) return;
    if (result.type === 'session-summary') {
      midSummaryResult = { result, generatedAt: Date.now() };
    }
  } catch (err) {
    wav = null;
    if ((err as Error)?.name === 'AbortError') return;
    pushDebugEvent({ label: 'mid-summary-fail', detail: err instanceof Error ? err.message : String(err) });
  } finally {
    if (midSummaryController === controller) {
      midSummaryLoading = false;
      midSummaryController = null;
    }
  }

  if (currentHudPage() === 'mid-summary') {
    await showMidSummaryPage(false, midSummaryResult?.result ?? null);
  }
}

interface IntermediateSummary {
  title?: string;
  summary: string;
  topics?: string[];
  keyPoints?: string[];
  quote?: string;
}

interface FinalSummaryInputs {
  sessionId: string;
  intermediates: IntermediateSummary[];
}

/**
 * Inputs for the stop-time summary chain (last-tick + final-synthesis).
 * Linear PCM is captured rather than an encoded WAV so the last-tick can run
 * voice-activity gating before deciding whether to encode and send anything.
 * Provider/model/key are not captured — the LLM facade resolves them from
 * `settings()` at call time, so a mid-session settings change is respected.
 */
interface StopTimeInputs {
  sessionId: string;
  /** Intermediates accumulated by the periodic timer before the user left. */
  priorIntermediates: IntermediateSummary[];
  /** Tail-buffer audio at session end. Null when the buffer was empty. */
  linearPcm: Uint8Array | null;
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
  language: LanguageCode;
}

/**
 * Snapshots inputs for the stop-time summary chain while the buffer and
 * module-level state are still live. Returns null when neither audio nor
 * prior intermediates exist — nothing to summarise — or when the feature is
 * disabled / no API key is set.
 */
function captureStopTimeInputs(): StopTimeInputs | null {
  const s = settings();
  if (!s.autoSummaryEnabled) return null;
  if (!activeApiKey()) return null;
  const linearPcm =
    buffer && buffer.bytesBuffered > 0 ? buffer.toLinearPcm() : null;
  if (!linearPcm && intermediateSummaries.length === 0) return null;
  return {
    sessionId: currentSessionId,
    priorIntermediates: intermediateSummaries.slice(),
    linearPcm,
    sampleRate: buffer?.sampleRate ?? 16_000,
    bitsPerSample: buffer?.bitsPerSample ?? 16,
    channels: buffer?.channels ?? 1,
    language: s.responseLanguage,
  };
}

/**
 * Runs the stop-time summary chain in the background after the user has left
 * the active session: first a last-tick summary from the tail audio (writes a
 * Summary history entry when voice is present), then a final synthesis that
 * consolidates all intermediates (the prior ticks plus the last tick) into a
 * separate Summary history entry.
 *
 * Skip rules:
 * - Last tick is skipped when the tail buffer has no voice (or no audio).
 * - Final synthesis is skipped when no PRIOR intermediates exist — otherwise
 *   it would just duplicate the last tick.
 */
async function runStopTimeSummaries(inputs: StopTimeInputs): Promise<void> {
  // Same gate as runAutoSummary: no summary for a session shorter than the
  // minimum, or one that produced zero analyses. Skipping here avoids the
  // 'generating' badge flash and the last-tick Gemini call.
  if (!canRunSummary()) return;

  let lastTick: IntermediateSummary | null = null;

  if (inputs.linearPcm) {
    const stopFloor = settings().voiceGateRmsFloor;
    const hasVoice = stopFloor > 0
      ? (await analyzeBufferForVoice(inputs.linearPcm, inputs.sampleRate, stopFloor)).voiceFrames > 0
      : true;
    if (hasVoice) {
      await setSummaryBadgeState('generating');
      lastTick = await runLastTickSummary(inputs);
    }
  }

  if (inputs.priorIntermediates.length === 0) {
    // Only the last tick fired — synthesising from a single intermediate
    // would just duplicate it. Flip the badge to ready so the picker reflects
    // that the summary is done.
    if (lastTick) await setSummaryBadgeState('ready');
    return;
  }

  const allIntermediates = lastTick
    ? [...inputs.priorIntermediates, lastTick]
    : inputs.priorIntermediates;

  await runFinalSummary({
    sessionId: inputs.sessionId,
    intermediates: allIntermediates,
  });
}

/**
 * Summarises the tail-buffer audio with one Gemini call and writes its own
 * Summary history entry. Returns the resulting segment so the final-synthesis
 * step can fold it in.
 */
async function runLastTickSummary(
  inputs: StopTimeInputs,
): Promise<IntermediateSummary | null> {
  if (!inputs.linearPcm) return null;
  const controller = new AbortController();
  finalSummaryInflight = controller;
  try {
    const wav = encodePcmToWav(inputs.linearPcm, {
      sampleRate: inputs.sampleRate,
      bitsPerSample: inputs.bitsPerSample,
      channels: inputs.channels,
    });
    const rawText = await callLens({
      wav,
      prompt: buildSessionSummaryPrompt(inputs.language),
      schema: SESSION_SUMMARY_SCHEMA,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return null;
    const result = parseSessionSummaryResponse(rawText);
    if (result.type !== 'session-summary' || result.summary.trim().length === 0) {
      return null;
    }
    await pushHistoryEntry({
      sessionId: inputs.sessionId,
      lensId: SESSION_SUMMARY_ID,
      lensName: SESSION_SUMMARY_NAME,
      question: extractQuestion(result),
      badge: 'SUMMARY',
      quote: result.quote ?? '',
      result,
      tags: extractTags(result),
    }, (k, v) => getBridge().setLocalStorage(k, v));
    await reloadHistoryFromStorage();
    return {
      title: result.title,
      summary: result.summary,
      topics: result.topics,
      keyPoints: result.keyPoints,
      quote: result.quote,
    };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return null;
    pushDebugEvent({
      label: 'last-tick-summary-fail',
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (finalSummaryInflight === controller) finalSummaryInflight = null;
  }
}

/**
 * Build a session-summary LensResult from the accumulated intermediate ticks
 * alone, when there's no fresh audio at session end to send to Gemini. Uses
 * the most-recent intermediate as the headline (its title, summary, quote),
 * then unions topics and key points across every tick. Stops the user from
 * losing an entire session's auto-summary work just because the buffer
 * happened to be empty at exit time (very short trailing tick, mic glitch).
 */
function synthesizeSummaryFromIntermediates(
  intermediates: FinalSummaryInputs['intermediates'],
): Extract<LensResult, { type: 'session-summary' }> | null {
  if (intermediates.length === 0) return null;
  const last = intermediates[intermediates.length - 1]!;
  // Union topics / key points across all ticks, de-duplicated preserving
  // first-seen order. Caps keep the result bounded for the history budget.
  const seenTopics = new Set<string>();
  const topics: string[] = [];
  const seenKey = new Set<string>();
  const keyPoints: string[] = [];
  for (const seg of intermediates) {
    for (const t of seg.topics ?? []) {
      const k = t.trim();
      if (k && !seenTopics.has(k)) { seenTopics.add(k); topics.push(k); }
    }
    for (const p of seg.keyPoints ?? []) {
      const k = p.trim();
      if (k && !seenKey.has(k)) { seenKey.add(k); keyPoints.push(k); }
    }
  }
  return {
    type: 'session-summary',
    title: last.title ?? 'Summary of conversation',
    summary: last.summary,
    topics: topics.slice(0, 20),
    keyPoints: keyPoints.slice(0, 40),
    quote: last.quote,
  };
}

/**
 * Generates one consolidated end-of-session summary using accumulated
 * intermediate summaries as prior context plus whatever audio was buffered
 * when the user exited. Pushes exactly one history entry on success.
 *
 * All inputs are captured by the caller synchronously before buffer teardown,
 * so this can safely run in the background after leaveActiveSession returns.
 * Tracked via finalSummaryInflight so a new session or runtime stop can
 * abort the network call and release its WAV closure.
 *
 * Best-effort; failures land in pushDebugEvent and never throw.
 */
async function runFinalSummary(inputs: FinalSummaryInputs): Promise<void> {
  const controller = new AbortController();
  finalSummaryInflight = controller;
  await setSummaryBadgeState('generating');
  try {
    // The last-tick audio summary is already written by runLastTickSummary at
    // this point, so the final synthesis consolidates intermediates only — no
    // fresh audio call. Skip entirely when no intermediates exist (e.g. when
    // the last tick was the very first one to fire).
    const synth = synthesizeSummaryFromIntermediates(inputs.intermediates);
    if (!synth) {
      pushDebugEvent({
        label: 'final-summary-skip',
        detail: 'no intermediates at session end',
      });
      await setSummaryBadgeState('idle');
      return;
    }
    if (controller.signal.aborted) {
      await setSummaryBadgeState('idle');
      return;
    }
    pushDebugEvent({
      label: 'final-summary-synth',
      detail: `synthesized from ${inputs.intermediates.length} intermediate tick(s)`,
    });
    await pushHistoryEntry({
      sessionId: inputs.sessionId,
      lensId: SESSION_SUMMARY_ID,
      lensName: SESSION_SUMMARY_NAME,
      question: extractQuestion(synth),
      badge: 'SUMMARY',
      quote: synth.quote ?? '',
      result: synth,
      tags: extractTags(synth),
    }, (k, v) => getBridge().setLocalStorage(k, v));
    await reloadHistoryFromStorage();
    await setSummaryBadgeState('ready');
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    pushDebugEvent({
      label: 'final-summary-fail',
      detail: err instanceof Error ? err.message : String(err),
    });
    await setSummaryBadgeState('idle');
  } finally {
    if (finalSummaryInflight === controller) finalSummaryInflight = null;
  }
}

/**
 * Naive content-word extractor for tag derivation. Splits on non-alphanumerics,
 * drops short tokens and common stop words, returns at most `maxWords`. Kept
 * deliberately simple — tags are a search-recall aid, not a topic model.
 */
function keywordize(text: string, maxWords: number): string[] {
  if (!text) return [];
  const stop = new Set([
    'the','a','an','and','or','but','of','to','in','on','at','for','is','was',
    'are','were','be','been','being','this','that','these','those','it','its',
    'as','by','with','from','if','then','than','so','what','which','who','how',
    'why','when','where','do','does','did','have','has','had','not','no','yes',
    'his','her','their','our','your','my','they','them','he','she','we',
  ]);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !stop.has(t));
  return tokens.slice(0, maxWords);
}

/**
 * Normalises raw tag candidates (lowercase, trim, dedupe, cap length / count).
 * Stored on each `HistoryEntry.tags` and never rendered — used only to widen
 * the SettingsView history search predicate so e.g. searching by an entity
 * name finds the entry even when that name isn't in the recorded question.
 */
function normalizeTags(raw: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    if (!r) continue;
    const t = r.trim().toLowerCase().slice(0, 32);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Derives search tags from a `LensResult`. Exhaustive switch — adding a new
 * LensResult variant fails the build here until handled. Coverage matches the
 * full union declared in `src/types.ts`, including `session-summary` which is
 * driven by the auto-summary path in this file (not via personas/index.ts).
 */
export function extractTags(result: LensResult): string[] {
  const raw: string[] = [];
  switch (result.type) {
    case 'fact-check':
      for (const c of result.claims) {
        raw.push(c.verdict);
        for (const t of keywordize(c.claim, 3)) raw.push(t);
      }
      break;
    case 'trivia':
      for (const c of result.claims) {
        for (const t of keywordize(c.question, 3)) raw.push(t);
        for (const t of keywordize(c.answer, 2)) raw.push(t);
      }
      break;
    case 'logical-fallacy':
      for (const c of result.claims) raw.push(c.fallacy);
      break;
    case 'stats-check':
      for (const c of result.claims) {
        raw.push(c.verdict);
        for (const t of keywordize(c.stat, 3)) raw.push(t);
      }
      break;
    case 'bias':
      for (const c of result.claims) {
        raw.push(c.verdict);
        if (c.direction) raw.push(c.direction);
      }
      break;
    case 'eli5':
      for (const c of result.claims) {
        for (const t of keywordize(c.explanation, 3)) raw.push(t);
      }
      break;
    case 'session-summary':
      for (const t of result.topics) raw.push(t);
      break;
    case 'meeting-prep':
      for (const c of result.claims) {
        if (c.source) raw.push(c.source);
        for (const t of keywordize(c.text, 3)) raw.push(t);
      }
      break;
    case 'devils-advocate':
      for (const c of result.claims) {
        for (const t of keywordize(c.counterpoint, 3)) raw.push(t);
      }
      break;
    case 'key-questions':
      for (const c of result.claims) {
        for (const t of keywordize(c.question, 3)) raw.push(t);
      }
      break;
    case 'sentiment':
      for (const c of result.claims) {
        raw.push(c.tone);
        for (const t of keywordize(c.explanation, 3)) raw.push(t);
      }
      break;
    case 'game':
      raw.push(result.preset.format, result.preset.difficulty);
      for (const t of keywordize(result.preset.topic, 3)) raw.push(t);
      break;
    case 'translation':
      // Tag with the detected source-language code so history can be filtered
      // by language; plus translated-text keywords so a search for the topic
      // words still finds the row even when the transcript is in another
      // language the wearer can't easily type.
      if (result.sourceLanguage) raw.push(result.sourceLanguage);
      for (const t of keywordize(result.translatedText, 3)) raw.push(t);
      break;
  }
  return normalizeTags(raw);
}

function extractQuestion(result: LensResult): string {
  switch (result.type) {
    case 'fact-check': return result.claims[0]?.claim ?? '';
    case 'trivia': return result.claims[0]?.question ?? '';
    case 'logical-fallacy': return result.claims[0]?.fallacy ?? '';
    case 'stats-check': return result.claims[0]?.stat ?? '';
    case 'bias': {
      const c = result.claims[0];
      return c ? (c.direction || c.verdict) : '';
    }
    case 'eli5': return (result.claims[0]?.explanation ?? '').slice(0, 80);
    case 'session-summary': return (result.title || result.summary).slice(0, 80);
    case 'meeting-prep': return result.claims[0]?.text ?? '';
    case 'devils-advocate': return (result.claims[0]?.counterpoint ?? '').slice(0, 60);
    case 'key-questions': return (result.claims[0]?.question ?? '').slice(0, 60);
    case 'sentiment': return (result.claims[0]?.explanation ?? '').slice(0, 60);
    case 'game': {
      const topic = result.preset.topic || 'Random topic';
      return topic.slice(0, 80);
    }
    case 'translation':
      return (result.sourceText || result.translatedText).slice(0, 80);
  }
}

function extractBadge(result: LensResult): string {
  switch (result.type) {
    case 'fact-check': return result.claims[0]?.verdict ?? 'UNVERIFIED';
    case 'trivia': return 'ANSWER';
    case 'logical-fallacy': return (result.claims[0]?.fallacy ?? '').slice(0, 12).toUpperCase();
    case 'stats-check': return result.claims[0]?.verdict ?? 'SUSPICIOUS';
    case 'bias': return result.claims[0]?.verdict ?? 'NEUTRAL';
    case 'eli5': return 'ELI5';
    case 'session-summary': return 'SUMMARY';
    case 'meeting-prep': {
      const src = result.claims[0]?.source ?? '';
      // Falls back to a generic "PREP" tag when the response didn't ground
      // itself in a specific section, so the history badge column never
      // renders empty for this lens.
      return src ? src.toUpperCase().slice(0, 12) : 'PREP';
    }
    case 'devils-advocate': return 'COUNTER';
    case 'key-questions': return 'Q1';
    case 'sentiment': return result.claims[0]?.tone ?? 'NEUTRAL';
    case 'game': {
      const scored = result.questions.some((q) => q.correctIndex !== null);
      return scored ? `${result.score}/${result.questions.length}` : 'GAME';
    }
    case 'translation':
      // Source-language code in upper case (e.g. "ES", "FR") — picks out the
      // detected spoken language at a glance in history. Falls back to "TR"
      // (TRanslate) when the model couldn't identify the language.
      return ((result.sourceLanguage || 'tr').toUpperCase()).slice(0, 4);
  }
}

/**
 * Splits a multi-claim result into individual single-claim variants so each
 * claim becomes its own history entry. Answer-shaped results (and already-
 * single-claim claim-shaped results) pass through unchanged. The HUD's
 * active page still uses the original multi-claim result — splitting happens
 * only at history-storage time.
 */
export function splitResultByClaim(result: LensResult): LensResult[] {
  switch (result.type) {
    case 'fact-check':
    case 'logical-fallacy':
    case 'stats-check':
    case 'bias':
    case 'trivia':
    case 'eli5': {
      if (result.claims.length <= 1) return [result];
      // Type-narrowing per variant is needed because each `claims` array is
      // typed against its own per-claim shape; we rebuild the same variant
      // per claim instead of using a generic spread.
      switch (result.type) {
        case 'fact-check':
          return result.claims.map((c) => ({ type: 'fact-check', claims: [c], autoSelected: result.autoSelected }));
        case 'stats-check':
          return result.claims.map((c) => ({ type: 'stats-check', claims: [c], autoSelected: result.autoSelected }));
        case 'logical-fallacy':
          return result.claims.map((c) => ({ type: 'logical-fallacy', claims: [c], autoSelected: result.autoSelected }));
        case 'bias':
          return result.claims.map((c) => ({ type: 'bias', claims: [c], autoSelected: result.autoSelected }));
        case 'trivia':
          return result.claims.map((c) => ({ type: 'trivia', claims: [c], autoSelected: result.autoSelected }));
        case 'eli5':
          return result.claims.map((c) => ({ type: 'eli5', claims: [c], autoSelected: result.autoSelected }));
      }
    }
    /* falls through */
    case 'session-summary':
      return [result];
    case 'meeting-prep':
      // Follow-ups are suggestions, not standalone facts — keep the primary
      // answer + follow-ups together as one history entry.
      return [result];
    case 'key-questions': {
      if (result.claims.length <= 1) return [result];
      return result.claims.map((c) => ({
        type: 'key-questions' as const,
        claims: [c],
        autoSelected: result.autoSelected,
      }));
    }
    case 'devils-advocate':
      return [result];
    case 'sentiment':
      return [result];
    case 'game':
      return [result];
    case 'translation':
      return [result];
  }
}

/**
 * Returns the verbatim source quote(s) from a result, joined with " · " when
 * multiple claims are present. Powers history search in the settings WebView.
 * Exhaustive switch — adding a new LensResult variant fails the build until
 * this is updated.
 */
export function extractQuote(result: LensResult): string {
  switch (result.type) {
    case 'fact-check':
    case 'logical-fallacy':
    case 'stats-check':
    case 'bias':
    case 'trivia':
    case 'eli5':
      return result.claims.map((c) => c.quote).filter(Boolean).join(' · ');
    case 'session-summary':
      return result.quote ?? '';
    case 'meeting-prep': {
      // Prefer the verbatim evidence excerpt so history search hits the real
      // prep text. Fall back to the answer's detail line when no evidence claim
      // was produced (e.g. answer drawn from general notes or no attachments).
      const evidence = result.claims.find((c) => c.kind === 'evidence');
      if (evidence?.text) return evidence.text;
      return result.claims[0]?.detail ?? '';
    }
    case 'devils-advocate':
      return result.claims.map((c) => c.quote).filter(Boolean).join(' · ');
    case 'key-questions':
      return '';
    case 'sentiment':
      return result.claims.map((c) => c.quote).filter(Boolean).join(' · ');
    case 'game':
      return '';
    case 'translation':
      // The source-language transcript IS the quote — it's verbatim from the
      // audio. History search hits the original spoken text.
      return result.sourceText;
  }
}

function summarize(event: EvenHubEvent): Record<string, unknown> {
  if (event.textEvent) return { kind: 'text', eventType: event.textEvent.eventType, container: event.textEvent.containerName };
  if (event.listEvent) return { kind: 'list', eventType: event.listEvent.eventType, container: event.listEvent.containerName, idx: event.listEvent.currentSelectItemIndex, name: event.listEvent.currentSelectItemName };
  if (event.sysEvent) return { kind: 'sys', eventType: event.sysEvent.eventType, source: event.sysEvent.eventSource };
  return { kind: 'unknown' };
}
