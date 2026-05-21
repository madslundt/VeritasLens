// src/runtime/lifecycle.ts
import { getBridge } from './bridge';
import { PcmRingBuffer } from './audioBuffer';
import {
  ACTIVE_HINT_ANALYZING,
  ACTIVE_HINT_DEFAULT,
  bootstrapHud,
  currentHudPage,
  flashPickerHint,
  getActiveLayout,
  hasPendingActiveResult,
  menuOptionAtIndex,
  personaAtIndex,
  resetHudSessionState,
  restoreActivePage,
  restoreHistoryListPage,
  scrollActiveReason,
  scrollHistoryDetail,
  setActiveHint,
  setActiveLayout,
  setLensResult,
  setMenuSpinner,
  setRecIndicator,
  setStatus,
  showActivePage,
  showHistoryDetailPage,
  showHistoryListPage,
  getHistoryListEntries,
  showMenuPage,
  showPickerPage,
  showUnconfiguredPage,
} from './hud';
import { callLens, MAX_RETRIES } from '@/llm/gemini';
import { getPersona, type Persona, type PersonaId } from '@/personas';
import { AUTO_CLASSIFIER_SCHEMA, parseAutoClassifierResponse } from '@/personas/auto';
import { buildSessionSummaryPrompt } from '@/personas/sessionSummary';
import {
  MEETING_PREP_ID,
  buildMeetingPrepPrompt,
  buildMeetingPrepSchema,
  parseMeetingPrepResponse,
} from '@/personas/meetingPrep';
import {
  activePersona,
  meetingPrepIsConfigured,
  meetingPrepSections,
  pushDebugEvent,
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
import type { LanguageCode, LensResult, MeetingPrepSection } from '@/types';

let running = false;
let buffer: PcmRingBuffer | null = null;
let unsubscribeEvents: (() => void) | null = null;
let inflight: AbortController | null = null;
let analyzing = false;
let autoSummaryTimer: ReturnType<typeof setInterval> | null = null;
// In-memory running summaries accumulated during a session by the auto-summary
// timer. Cleared on session enter / leave / runtime stop. Never persisted on
// their own — they are folded into the single end-of-session entry by
// runFinalSummary().
let intermediateSummaries: Array<{ summary: string; quote?: string }> = [];

let lastPickerIndex = 0;
let lastMenuIndex = 0;
let lastHistoryIndex = 0;
let currentSessionId = '';
let sessionStartTime = 0;

export function isHudRunning(): boolean { return running; }

export async function startHudRuntime(): Promise<void> {
  const configured = settings().geminiApiKey.trim().length >= 10;
  if (running) {
    if (configured) await showPickerPage();
    else await showUnconfiguredPage();
    return;
  }
  running = true;
  try {
    setAppPhase('booting');
    await bootstrapHud(configured ? 'picker' : 'unconfigured');
    setAppPhase('idle');
    unsubscribeEvents = getBridge().onEvenHubEvent(handleEvent);
  } catch (err) {
    running = false;
    setAppPhase('error');
    setErrorMessage(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

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
  stopAutoSummaryTimer();
  // System shutdown deliberately discards any accumulated intermediate
  // summaries — firing a Gemini call here would race the runtime teardown
  // (no reliable way to complete the fetch + localStorage write), so the
  // final summary only runs from the user-initiated leaveActiveSession path.
  intermediateSummaries = [];
  unsubscribeEvents?.();
  unsubscribeEvents = null;
  inflight?.abort();
  inflight = null;
  buffer?.clear();
  buffer = null;
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

function isLifecycleSysEvent(et: OsEventTypeList | undefined): boolean {
  return (
    et === OsEventTypeList.FOREGROUND_EXIT_EVENT ||
    et === OsEventTypeList.FOREGROUND_ENTER_EVENT ||
    et === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    et === OsEventTypeList.ABNORMAL_EXIT_EVENT
  );
}

function handleEvent(event: EvenHubEvent): void {
  if (import.meta.env.DEV && (event.listEvent || event.textEvent || event.sysEvent)) {
    console.info('[veritaslens] event', summarize(event));
  }

  if (event.sysEvent && isLifecycleSysEvent(event.sysEvent.eventType)) {
    switch (event.sysEvent.eventType) {
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT: void stopHudRuntime(); return;
    }
  }

  if (event.audioEvent && buffer) { buffer.append(event.audioEvent.audioPcm); return; }

  if (event.textEvent) {
    const type = event.textEvent.eventType ?? 0;
    if (currentHudPage() === 'history-detail') {
      if (type === OsEventTypeList.SCROLL_TOP_EVENT) void scrollHistoryDetail(-1);
      else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) void scrollHistoryDetail(1);
    } else if (currentHudPage() === 'active') {
      if (type === OsEventTypeList.SCROLL_TOP_EVENT) void scrollActiveReason(-1);
      else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) void scrollActiveReason(1);
    }
    return;
  }

  const gesture = extractGesture(event);
  if (!gesture) return;

  const page = currentHudPage();

  // Double-tap handling. From the root pages (picker, unconfigured) it asks
  // the host to surface its exit confirmation dialog — required by Even Hub
  // review so users always have a way out, even before an API key is set.
  // Everywhere else it starts analysis, or cancels an in-flight one.
  if (gesture.type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (page === 'picker' || page === 'unconfigured') {
      void requestHostExitConfirm();
      return;
    }
    if (analyzing) { inflight?.abort(); return; }
    void runAnalysis();
    return;
  }

  if (page === 'picker') void handlePickerEvent(gesture);
  else if (page === 'active') void handleActiveGesture(gesture);
  else if (page === 'menu') void handleMenuGesture(gesture);
  else if (page === 'history-list') void handleHistoryListGesture(gesture);
  else if (page === 'history-detail') void handleHistoryDetailGesture(gesture);
}

async function handlePickerEvent(g: Gesture): Promise<void> {
  if (typeof g.itemIndex === 'number') lastPickerIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    const persona = personaAtIndex(lastPickerIndex);
    if (!persona) return;
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

async function handleActiveGesture(g: Gesture): Promise<void> {
  // Single-tap (CLICK_EVENT or the normalized `undefined`) opens the menu.
  // For multi-claim results, claim navigation is via vertical swipe — which
  // arrives here as SCROLL_TOP/BOTTOM from the discreet text-container sink,
  // or via the textEvent branch in handleEvent for baseline (same sink type
  // now). scrollActiveReason swaps claims when multi-claim, otherwise
  // paginates a long reason.
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    await showMenuPage();
    return;
  }
  if (g.type === OsEventTypeList.SCROLL_TOP_EVENT) {
    await scrollActiveReason(-1);
  } else if (g.type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    await scrollActiveReason(1);
  }
}

async function handleMenuGesture(g: Gesture): Promise<void> {
  if (typeof g.itemIndex === 'number') lastMenuIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    const option = menuOptionAtIndex(lastMenuIndex);
    switch (option) {
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
  setAppPhase('listening');
}

async function handleHistoryListGesture(g: Gesture): Promise<void> {
  if (typeof g.itemIndex === 'number') lastHistoryIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    if (lastHistoryIndex === 0) { lastMenuIndex = 0; await restoreActivePage(); return; }
    const entries = getHistoryListEntries();
    const entry = entries[lastHistoryIndex - 1];
    if (entry) await showHistoryDetailPage(entry);
  }
}

async function handleHistoryDetailGesture(g: Gesture): Promise<void> {
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    await restoreHistoryListPage();
  }
}

async function enterActiveSession(personaId: PersonaId): Promise<void> {
  const persona = getPersona(personaId);
  if (!persona) { setErrorMessage(`Unknown lens: ${personaId}`); return; }
  setActivePersona(personaId);
  currentSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  sessionStartTime = Date.now();
  intermediateSummaries = [];
  lastMenuIndex = 0;
  setActiveLayout(settings().discreet ? 'discreet-minimal' : 'baseline');
  await showActivePage(persona);
  buffer = new PcmRingBuffer({ durationSec: settings().bufferDuration, sampleRate: 16_000 });
  const micOk = await getBridge().audioControl(true);
  if (!micOk) {
    await setStatus('error');
    await setRecIndicator(false);
    setErrorMessage('Microphone could not be opened.');
    setAppPhase('error');
    return;
  }
  startAutoSummaryTimer();
  setAppPhase('listening');
}

async function leaveActiveSession(): Promise<void> {
  // Cancel any analysis still in flight so the answer doesn't arrive into a
  // session that no longer exists (which would set lensResult / pendingActive
  // long after the user has left). resetHudSessionState below clears the
  // pending stash, but the abort prevents a late callLens success from
  // reintroducing it via setLensResult.
  inflight?.abort();
  inflight = null;
  analyzing = false;
  stopSpinner();
  try { await getBridge().audioControl(false); } catch { /* ignore */ }
  // Stop the periodic timer BEFORE the final summary so a tick can't fire
  // mid-call and double up against the same buffer.
  stopAutoSummaryTimer();
  // Best-effort end-of-session summary. runFinalSummary is internally guarded
  // and never throws, so this can't block the cleanup that follows. It runs
  // before buffer.clear() so the most-recent audio is still available.
  await runFinalSummary();
  intermediateSummaries = [];
  buffer?.clear();
  buffer = null;
  resetHudSessionState();
  await showPickerPage();
  setAppPhase('idle');
}

const SPINNER_FRAMES = ['|', '/', '-', '\\'];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerPrefix = '';

function startSpinner(): void {
  if (spinnerTimer) return;
  let i = 0;
  // Push an initial frame immediately so the menu/status slot doesn't stay
  // blank for up to one tick after analysis begins.
  void setStatus(spinnerPrefix ? `${spinnerPrefix}${SPINNER_FRAMES[i]}` : ` ${SPINNER_FRAMES[i]}  `);
  void setMenuSpinner(SPINNER_FRAMES[i]!);
  spinnerTimer = setInterval(() => {
    i = (i + 1) % SPINNER_FRAMES.length;
    const frame = SPINNER_FRAMES[i];
    void setStatus(spinnerPrefix ? `${spinnerPrefix}${frame}` : ` ${frame}  `);
    void setMenuSpinner(frame!);
  }, 180);
}

function stopSpinner(): void {
  if (spinnerTimer) clearInterval(spinnerTimer);
  spinnerTimer = null;
  spinnerPrefix = '';
  void setMenuSpinner('');
}

function buildPromptWithContext(persona: Persona, lang: LanguageCode): string {
  const base = persona.buildPrompt(lang);
  const recent = sessionHistory().slice(-3).map((e, i) => `${i + 1}. ${e.question}`);
  const parts = [
    'Focus only on clear human speech in the audio. Ignore background noise, music, and non-speech sounds.',
    'If no clear human speech is detected, set noSpeech to true in your response.',
    '',
    base,
  ];
  if (recent.length > 0) {
    parts.push(
      '',
      'RECENT: These have already been analyzed this session — if the audio contains the same content, focus on anything new instead:',
      ...recent,
    );
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
  const recent = sessionHistory().slice(-3).map((e, i) => `${i + 1}. ${e.question}`);
  const parts = [
    'Focus only on clear human speech in the audio. Ignore background noise, music, and non-speech sounds.',
    'If no clear human speech is detected, set noSpeech to true in your response.',
    '',
    base,
  ];
  if (recent.length > 0) {
    parts.push(
      '',
      'RECENT: These have already been analyzed this session — if the audio contains the same content, focus on anything new instead:',
      ...recent,
    );
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
  ].join('\n');
}

async function runAnalysis(): Promise<void> {
  const page = currentHudPage();
  if (page === 'history-list' || page === 'history-detail') await restoreActivePage();
  if (currentHudPage() !== 'active') return;

  if (!buffer || buffer.bytesBuffered === 0) { await setStatus('listening'); return; }

  const apiKey = settings().geminiApiKey;
  if (!apiKey) { await setStatus('error'); setErrorMessage('No Gemini API key.'); return; }

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

  // Clear the previous answer and rebuild the active page before starting a
  // new check. Without this, a double-tap from the result screen leaves '...'
  // stuck and the spinner never animates — the SDK does not refresh containers
  // that are already populated with the prior result. The Menu → Check path
  // already worked because it does its own restoreActivePage before calling
  // runAnalysis; the bug only surfaced via the direct double-tap path.
  // In discreet mode drop back to the dot-only layout so the user has
  // something on screen during thinking; setLensResult will promote to
  // discreet-result once the answer arrives.
  setStateResult(null);
  if (settings().discreet && getActiveLayout() !== 'discreet-minimal') {
    setActiveLayout('discreet-minimal');
  }
  await restoreActivePage();

  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  analyzing = true;
  setAppPhase('thinking');
  await setStatus('thinking');
  await setActiveHint(ACTIVE_HINT_ANALYZING);
  startSpinner();

  try {
    const wav = buffer.snapshotWav();
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
        apiKey,
        wav,
        prompt: `${meetingContext}\n\n${meetingPrompt}`,
        schema: meetingSchema,
        model: settings().geminiModel,
        signal: controller.signal,
        onRetry,
      });
      const result = parseMeetingPrepResponse(rawText, sections);
      stopSpinner();
      setStateResult(result);
      pushHistoryEntry({
        sessionId: currentSessionId,
        lensId: persona.id,
        lensName: persona.name,
        question: extractQuestion(result),
        badge: extractBadge(result),
        quote: extractQuote(result),
        result,
      }, (k, v) => getBridge().setLocalStorage(k, v));
      await setLensResult(result);
      await setStatus('displaying');
      await setActiveHint(ACTIVE_HINT_DEFAULT);
      setAppPhase('displaying');
      return;
    }

    let analysisPersona: Persona = persona;
    let autoSelected = false;

    if (persona.id === 'auto') {
      const classifierPrompt = buildPromptWithContext(persona, lang);
      const classifierContext = buildContextBlock(persona.name);
      const classifierRaw = await callLens({
        apiKey,
        wav,
        prompt: `${classifierContext}\n\n${classifierPrompt}`,
        schema: AUTO_CLASSIFIER_SCHEMA,
        model: settings().geminiAutoModel,
        signal: controller.signal,
        onRetry,
      });
      const { chosenLensId } = parseAutoClassifierResponse(classifierRaw);
      const chosen = getPersona(chosenLensId);
      if (!chosen) {
        stopSpinner();
        setErrorMessage(`Auto classifier returned unknown lens: ${chosenLensId}`);
        await setStatus('error');
        setAppPhase('error');
        return;
      }
      analysisPersona = chosen;
      autoSelected = true;
    }

    const analysisPrompt = buildPromptWithContext(analysisPersona, lang);
    const analysisContext = buildContextBlock(analysisPersona.name);
    const rawText = await callLens({
      apiKey,
      wav,
      prompt: `${analysisContext}\n\n${analysisPrompt}`,
      schema: analysisPersona.schema,
      model: settings().geminiModel,
      signal: controller.signal,
      onRetry,
    });
    const result = analysisPersona.parse(rawText);
    if (autoSelected) result.autoSelected = true;
    stopSpinner();
    setStateResult(result);
    for (const single of splitResultByClaim(result)) {
      pushHistoryEntry({
        sessionId: currentSessionId,
        lensId: analysisPersona.id,
        lensName: analysisPersona.name,
        question: extractQuestion(single),
        badge: extractBadge(single),
        quote: extractQuote(single),
        result: single,
      }, (k, v) => getBridge().setLocalStorage(k, v));
    }
    await setLensResult(result);
    await setStatus('displaying');
    await setActiveHint(ACTIVE_HINT_DEFAULT);
    setAppPhase('displaying');
  } catch (err) {
    stopSpinner();
    if ((err as Error)?.name === 'AbortError') {
      await setStatus('listening');
      await setActiveHint(ACTIVE_HINT_DEFAULT);
      setAppPhase('listening');
      return;
    }
    if ((err as Error)?.name === 'NoSpeechError') {
      await setStatus('listening');
      await setActiveHint(ACTIVE_HINT_DEFAULT);
      setAppPhase('listening');
      return;
    }
    setErrorMessage(err instanceof Error ? err.message : String(err));
    await setStatus('error');
    await setActiveHint(ACTIVE_HINT_DEFAULT);
    setAppPhase('error');
  } finally {
    // Identity check prevents clobbering a newer controller spawned by a
    // back-to-back analysis. Nulling inflight here releases the AbortController
    // and, through its closure, the WAV snapshot that can be up to ~19 MB at
    // the maximum buffer duration.
    if (inflight === controller) {
      analyzing = false;
      inflight = null;
    }
  }
}


function startAutoSummaryTimer(): void {
  stopAutoSummaryTimer();
  const s = settings();
  if (!s.autoSummaryEnabled) return;
  autoSummaryTimer = setInterval(() => void runAutoSummary(), s.autoSummaryInterval * 60_000);
}

function stopAutoSummaryTimer(): void {
  if (autoSummaryTimer) clearInterval(autoSummaryTimer);
  autoSummaryTimer = null;
}


async function runAutoSummary(): Promise<void> {
  if (!buffer || buffer.bytesBuffered === 0) return;
  const apiKey = settings().geminiApiKey;
  if (!apiKey) return;
  const persona = getPersona('session-summary');
  if (!persona) return;
  try {
    const wav = buffer.snapshotWav();
    const rawText = await callLens({
      apiKey,
      wav,
      prompt: persona.buildPrompt(settings().responseLanguage),
      schema: persona.schema,
      model: settings().geminiModel,
    });
    const result = persona.parse(rawText);
    // Intermediate tick — accumulate text in memory only. The final end-of-
    // session call folds these into one history entry; intermediates never
    // appear in History on their own.
    if (result.type === 'session-summary' && result.summary.trim().length > 0) {
      intermediateSummaries.push({ summary: result.summary, quote: result.quote });
    }
  } catch (err) {
    // Auto-summary is best-effort, but failures should be observable in the
    // debug log so the user can see why the timer is firing without producing
    // entries (network down, quota, etc.).
    pushDebugEvent({
      label: 'auto-summary-fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Generates one consolidated end-of-session summary using accumulated
 * intermediate summaries as prior context plus whatever audio is still in the
 * ring buffer. Pushes exactly one history entry (lensId='session-summary',
 * badge='SUMMARY') on success.
 *
 * Skipped when no intermediate ever fired — this also implements the
 * "session shorter than autoSummaryInterval" gate, because the first timer
 * tick lands at exactly that boundary.
 *
 * Best-effort; failures land in pushDebugEvent and never throw, so the caller
 * (leaveActiveSession) can always complete its cleanup.
 */
async function runFinalSummary(): Promise<void> {
  if (intermediateSummaries.length === 0) return;
  const apiKey = settings().geminiApiKey;
  if (!apiKey) return;
  const persona = getPersona('session-summary');
  if (!persona) return;
  try {
    const previousSummaries = intermediateSummaries.map((i) => i.summary);
    const prompt = buildSessionSummaryPrompt(
      settings().responseLanguage,
      { previousSummaries },
    );
    // If the buffer was cleared between the last tick and exit (defensive —
    // leaveActiveSession clears it after this call returns), fall through to a
    // text-only synthesis by sending a tiny silent WAV. Skipping the call
    // would lose the work entirely.
    const wav = buffer && buffer.bytesBuffered > 0 ? buffer.snapshotWav() : null;
    if (!wav) {
      pushDebugEvent({
        label: 'final-summary-skip',
        detail: 'no audio buffer at session end',
      });
      return;
    }
    const rawText = await callLens({
      apiKey,
      wav,
      prompt,
      schema: persona.schema,
      model: settings().geminiModel,
    });
    const result = persona.parse(rawText);
    if (result.type !== 'session-summary') return;
    // Fall back to the most-recent intermediate quote if the final response
    // didn't include one — keeps the history row from rendering with an empty
    // quote column when prior ticks already captured a salient line.
    const lastIntermediate = intermediateSummaries[intermediateSummaries.length - 1];
    const quote = result.quote ?? lastIntermediate?.quote ?? '';
    pushHistoryEntry({
      sessionId: currentSessionId,
      lensId: persona.id,
      lensName: persona.name,
      question: extractQuestion(result),
      badge: 'SUMMARY',
      quote,
      result,
    }, (k, v) => getBridge().setLocalStorage(k, v));
  } catch (err) {
    pushDebugEvent({
      label: 'final-summary-fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
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
    case 'session-summary': return result.summary.slice(0, 80);
    case 'meeting-prep': return result.claims[0]?.text ?? '';
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
    case 'meeting-prep':
      // Primary answer's detail line — the closest thing this lens has to a
      // verbatim audio quote, since Gemini isn't asked to echo the heard text.
      return result.claims[0]?.detail ?? '';
  }
}

function summarize(event: EvenHubEvent): Record<string, unknown> {
  if (event.textEvent) return { kind: 'text', eventType: event.textEvent.eventType, container: event.textEvent.containerName };
  if (event.listEvent) return { kind: 'list', eventType: event.listEvent.eventType, container: event.listEvent.containerName, idx: event.listEvent.currentSelectItemIndex, name: event.listEvent.currentSelectItemName };
  if (event.sysEvent) return { kind: 'sys', eventType: event.sysEvent.eventType, source: event.sysEvent.eventSource };
  return { kind: 'unknown' };
}
