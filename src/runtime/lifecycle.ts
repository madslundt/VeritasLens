// src/runtime/lifecycle.ts
import { getBridge } from './bridge';
import { PcmRingBuffer } from './audioBuffer';
import {
  bootstrapHud,
  currentHudPage,
  menuOptionAtIndex,
  personaAtIndex,
  restoreActivePage,
  restoreHistoryListPage,
  scrollActiveReason,
  scrollHistoryDetail,
  setLensResult,
  setRecIndicator,
  setStatus,
  showActivePage,
  showHistoryDetailPage,
  showHistoryListPage,
  showMenuPage,
  showPickerPage,
  showUnconfiguredPage,
} from './hud';
import { callLens } from '@/llm/gemini';
import { getPersona, type Persona, type PersonaId } from '@/personas';
import {
  activePersona,
  lensResult as stateResultGet,
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

const SLEEP_AFTER_MS = 5 * 60 * 1000;

let running = false;
let buffer: PcmRingBuffer | null = null;
let unsubscribeEvents: (() => void) | null = null;
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
let inflight: AbortController | null = null;
let autoSummaryTimer: ReturnType<typeof setInterval> | null = null;

let lastPickerIndex = 0;
let lastMenuIndex = 0;
let lastHistoryIndex = 0;
let currentSessionId = '';

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
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
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

function isLifecycleSysEvent(et: OsEventTypeList | undefined): boolean {
  return (
    et === OsEventTypeList.FOREGROUND_EXIT_EVENT ||
    et === OsEventTypeList.FOREGROUND_ENTER_EVENT ||
    et === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    et === OsEventTypeList.ABNORMAL_EXIT_EVENT
  );
}

function handleEvent(event: EvenHubEvent): void {
  if (event.listEvent || event.textEvent || event.sysEvent) console.info('[veritaslens] event', summarize(event));

  if (event.sysEvent && isLifecycleSysEvent(event.sysEvent.eventType)) {
    switch (event.sysEvent.eventType) {
      case OsEventTypeList.FOREGROUND_EXIT_EVENT: void pauseListening(); return;
      case OsEventTypeList.FOREGROUND_ENTER_EVENT: void resumeListening(); return;
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

  // Double-tap is universal: always triggers a new analysis from any page.
  if (gesture.type === OsEventTypeList.DOUBLE_CLICK_EVENT) { void runAnalysis(); return; }

  const page = currentHudPage();
  if (page === 'picker') void handlePickerEvent(gesture);
  else if (page === 'active') void handleActiveGesture(gesture);
  else if (page === 'menu') void handleMenuGesture(gesture);
  else if (page === 'history-list') void handleHistoryListGesture(gesture);
  else if (page === 'history-detail') void handleHistoryDetailGesture(gesture);
}

async function handlePickerEvent(g: Gesture): Promise<void> {
  resetSleepTimer();
  if (typeof g.itemIndex === 'number') lastPickerIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    const persona = personaAtIndex(lastPickerIndex);
    if (persona) await enterActiveSession(persona.id);
  }
}

async function handleActiveGesture(g: Gesture): Promise<void> {
  resetSleepTimer();
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    await showMenuPage();
  }
}

async function handleMenuGesture(g: Gesture): Promise<void> {
  resetSleepTimer();
  if (typeof g.itemIndex === 'number') lastMenuIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    const option = menuOptionAtIndex(lastMenuIndex);
    switch (option) {
      case 'fact-check': await restoreActivePage(); await runAnalysis(); break;
      case 'history': await showHistoryListPage(sessionHistory()); break;
      case 'cancel': await restoreActiveWithResult(); break;
      case 'exit': await leaveActiveSession(); break;
    }
  }
}

async function handleHistoryListGesture(g: Gesture): Promise<void> {
  resetSleepTimer();
  if (typeof g.itemIndex === 'number') lastHistoryIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    if (lastHistoryIndex === 0) { lastMenuIndex = 0; await restoreActivePage(); return; }
    const entries = sessionHistory();
    const entry = entries[lastHistoryIndex - 1];
    if (entry) await showHistoryDetailPage(entry);
  } else if (g.type === OsEventTypeList.SCROLL_TOP_EVENT) {
    lastMenuIndex = 0;
    await restoreActivePage();
  }
}

async function handleHistoryDetailGesture(g: Gesture): Promise<void> {
  resetSleepTimer();
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    await restoreHistoryListPage();
  }
}

async function restoreActiveWithResult(): Promise<void> {
  await restoreActivePage();
  const current = stateResultGet();
  if (current) {
    await setLensResult(current);
    await setStatus('displaying');
    setAppPhase('displaying');
  } else {
    await setStatus('listening');
    setAppPhase('listening');
  }
}

async function enterActiveSession(personaId: PersonaId): Promise<void> {
  const persona = getPersona(personaId);
  if (!persona) { setErrorMessage(`Unknown lens: ${personaId}`); return; }
  setActivePersona(personaId);
  currentSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  lastMenuIndex = 0;
  await showActivePage(persona);
  await setStatus('listening');
  await setRecIndicator(true);
  buffer = new PcmRingBuffer({ durationSec: settings().bufferDuration, sampleRate: 16_000 });
  const micOk = await getBridge().audioControl(true);
  if (!micOk) {
    await setStatus('error');
    await setRecIndicator(false);
    setErrorMessage('Microphone could not be opened.');
    setAppPhase('error');
    return;
  }
  resetSleepTimer();
  startAutoSummaryTimer();
  setAppPhase('listening');
}

async function leaveActiveSession(): Promise<void> {
  try { await getBridge().audioControl(false); } catch { /* ignore */ }
  stopAutoSummaryTimer();
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
  spinnerTimer = setInterval(() => { i = (i + 1) % SPINNER_FRAMES.length; void setStatus(` ${SPINNER_FRAMES[i]}  `); }, 180);
}

function stopSpinner(): void {
  if (spinnerTimer) clearInterval(spinnerTimer);
  spinnerTimer = null;
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

async function runAnalysis(): Promise<void> {
  const page = currentHudPage();
  if (page === 'history-list' || page === 'history-detail') await restoreActivePage();
  if (currentHudPage() !== 'active') return;
  if (!buffer || buffer.bytesBuffered === 0) { await setStatus('listening'); return; }

  const apiKey = settings().geminiApiKey;
  if (!apiKey) { await setStatus('error'); setErrorMessage('No Gemini API key.'); return; }

  const persona = getPersona(activePersona());
  if (!persona) return;

  inflight?.abort();
  inflight = new AbortController();
  setAppPhase('thinking');
  await setStatus('thinking');
  startSpinner();

  try {
    const wav = buffer.snapshotWav();
    const prompt = buildPromptWithContext(persona, settings().responseLanguage);
    const rawText = await callLens({
      apiKey,
      wav,
      prompt,
      schema: persona.schema,
      model: settings().geminiModel,
      signal: inflight.signal,
      onRetry: async (attempt) => {
        stopSpinner();
        await setStatus(`retry${attempt}`);
      },
    });
    const result = persona.parse(rawText);
    stopSpinner();
    setStateResult(result);
    pushHistoryEntry({
      sessionId: currentSessionId,
      lensId: persona.id,
      lensName: persona.name,
      question: extractQuestion(result),
      badge: extractBadge(result),
      result,
    }, (k, v) => getBridge().setLocalStorage(k, v));
    await setLensResult(result);
    await setStatus('displaying');
    setAppPhase('displaying');
  } catch (err) {
    stopSpinner();
    if ((err as Error)?.name === 'AbortError') return;
    if ((err as Error)?.name === 'NoSpeechError') {
      await setStatus('listening');
      setAppPhase('listening');
      return;
    }
    setErrorMessage(err instanceof Error ? err.message : String(err));
    await setStatus('error');
    setAppPhase('error');
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
    pushHistoryEntry({
      sessionId: currentSessionId,
      lensId: persona.id,
      lensName: persona.name,
      question: extractQuestion(result),
      badge: 'AUTO',
      result,
    }, (k, v) => getBridge().setLocalStorage(k, v));
  } catch { /* silent failure — auto-summary is best-effort */ }
}

function extractQuestion(result: LensResult): string {
  switch (result.type) {
    case 'fact-check': return result.claim;
    case 'trivia': return result.question;
    case 'logical-fallacy': return result.fallacy;
    case 'stats-check': return result.stat;
    case 'bias': return result.direction || result.verdict;
    case 'translation': return result.translatedText.slice(0, 80);
    case 'eli5': return result.explanation.slice(0, 80);
    case 'session-summary': return result.summary.slice(0, 80);
  }
}

function extractBadge(result: LensResult): string {
  switch (result.type) {
    case 'fact-check': return result.verdict;
    case 'trivia': return 'ANSWER';
    case 'logical-fallacy': return result.fallacy.slice(0, 12).toUpperCase();
    case 'stats-check': return result.verdict;
    case 'bias': return result.verdict;
    case 'translation': return 'TRANSL.';
    case 'eli5': return 'ELI5';
    case 'session-summary': return 'SUMMARY';
  }
}

async function pauseListening(): Promise<void> {
  try { await getBridge().audioControl(false); } catch { /* ignore */ }
  await setRecIndicator(false);
  setAppPhase('sleeping');
}

async function resumeListening(): Promise<void> {
  if (currentHudPage() !== 'active') return;
  try { await getBridge().audioControl(true); } catch { /* ignore */ }
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
  } catch { /* ignore */ }
}

void activePersona;

function summarize(event: EvenHubEvent): Record<string, unknown> {
  if (event.textEvent) return { kind: 'text', eventType: event.textEvent.eventType, container: event.textEvent.containerName };
  if (event.listEvent) return { kind: 'list', eventType: event.listEvent.eventType, container: event.listEvent.containerName, idx: event.listEvent.currentSelectItemIndex, name: event.listEvent.currentSelectItemName };
  if (event.sysEvent) return { kind: 'sys', eventType: event.sysEvent.eventType, source: event.sysEvent.eventSource };
  return { kind: 'unknown' };
}
