// src/runtime/lifecycle.ts
import { getBridge } from './bridge';
import { PcmRingBuffer } from './audioBuffer';
import {
  ACTIVE_HINT_ANALYZING,
  applyDefaultActiveHint,
  bootstrapHud,
  currentHudPage,
  tryAdvanceActiveClaim,
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
import {
  activePersona,
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
import type { LanguageCode, LensResult } from '@/types';

let running = false;
let buffer: PcmRingBuffer | null = null;
let unsubscribeEvents: (() => void) | null = null;
let inflight: AbortController | null = null;
let analyzing = false;
let autoSummaryTimer: ReturnType<typeof setInterval> | null = null;

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
    if (persona) await enterActiveSession(persona.id);
  }
}

async function handleActiveGesture(g: Gesture): Promise<void> {
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    // For multi-claim results, single-tap walks forward through the claims.
    // On the last claim it falls through to opening the menu (and for
    // single-claim or answer-shaped results it goes straight to the menu).
    if (await tryAdvanceActiveClaim()) return;
    await showMenuPage();
    return;
  }
  // Discreet layouts use a list container as the event sink, so vertical swipes
  // arrive here as listEvent SCROLL_TOP/BOTTOM rather than via the textEvent
  // path that the baseline text-container sink uses. Forward them to the same
  // reason-pagination logic so a long reason is still scrollable in discreet-result.
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
    await applyDefaultActiveHint();
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
  stopAutoSummaryTimer();
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
    await applyDefaultActiveHint();
    setAppPhase('displaying');
  } catch (err) {
    stopSpinner();
    if ((err as Error)?.name === 'AbortError') {
      await setStatus('listening');
      await applyDefaultActiveHint();
      setAppPhase('listening');
      return;
    }
    if ((err as Error)?.name === 'NoSpeechError') {
      await setStatus('listening');
      await applyDefaultActiveHint();
      setAppPhase('listening');
      return;
    }
    setErrorMessage(err instanceof Error ? err.message : String(err));
    await setStatus('error');
    await applyDefaultActiveHint();
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
    for (const single of splitResultByClaim(result)) {
      pushHistoryEntry({
        sessionId: currentSessionId,
        lensId: persona.id,
        lensName: persona.name,
        question: extractQuestion(single),
        badge: 'AUTO',
        quote: extractQuote(single),
        result: single,
      }, (k, v) => getBridge().setLocalStorage(k, v));
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
    case 'translation': return result.translatedText.slice(0, 80);
    case 'eli5': return (result.claims[0]?.explanation ?? '').slice(0, 80);
    case 'session-summary': return result.summary.slice(0, 80);
  }
}

function extractBadge(result: LensResult): string {
  switch (result.type) {
    case 'fact-check': return result.claims[0]?.verdict ?? 'UNVERIFIED';
    case 'trivia': return 'ANSWER';
    case 'logical-fallacy': return (result.claims[0]?.fallacy ?? '').slice(0, 12).toUpperCase();
    case 'stats-check': return result.claims[0]?.verdict ?? 'SUSPICIOUS';
    case 'bias': return result.claims[0]?.verdict ?? 'NEUTRAL';
    case 'translation': return 'TRANSL.';
    case 'eli5': return 'ELI5';
    case 'session-summary': return 'SUMMARY';
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
    case 'translation':
    case 'session-summary':
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
    case 'translation':
      return result.quote ?? '';
  }
}

function summarize(event: EvenHubEvent): Record<string, unknown> {
  if (event.textEvent) return { kind: 'text', eventType: event.textEvent.eventType, container: event.textEvent.containerName };
  if (event.listEvent) return { kind: 'list', eventType: event.listEvent.eventType, container: event.listEvent.containerName, idx: event.listEvent.currentSelectItemIndex, name: event.listEvent.currentSelectItemName };
  if (event.sysEvent) return { kind: 'sys', eventType: event.sysEvent.eventType, source: event.sysEvent.eventSource };
  return { kind: 'unknown' };
}
