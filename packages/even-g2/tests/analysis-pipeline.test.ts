import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk';
import type { CallLensStreamOptions, VoiceBufferAnalysis } from '@veritaslens/core';

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  call: vi.fn(),
  stream: vi.fn(),
  noise: vi.fn(),
  listener: null as ((event: EvenHubEvent) => void) | null,
  storage: new Map<string, string>(),
  upgrades: [] as Array<{ containerName: string; content: string }>,
  visible: new Map<string, string>(),
  listItems: [] as string[],
  hudWriteBarrier: null as Promise<void> | null,
  hudRebuildBarrier: null as Promise<void> | null,
}));

vi.mock('@veritaslens/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@veritaslens/core')>(),
  analyzeBufferForVoice: mocks.gate,
  callLens: mocks.call,
  callLensStream: mocks.stream,
  warmupVAD: vi.fn(async () => {}),
}));

vi.mock('../src/runtime/bridge', () => ({
  getBridge: () => ({
    createStartUpPageContainer: vi.fn(async () => 0),
    rebuildPageContainer: vi.fn(async (page: { textObject?: Array<{ containerName?: string; content?: string }>; listObject?: Array<{ itemContainer?: { itemName?: string[] } }> }) => {
      if (mocks.hudRebuildBarrier) await mocks.hudRebuildBarrier;
      mocks.visible.clear();
      mocks.listItems = page.listObject?.flatMap(list => list.itemContainer?.itemName ?? []) ?? [];
      // Record visible content from both in-place updates and page rebuilds.
      for (const text of page.textObject ?? []) {
        if (text.containerName && typeof text.content === 'string') {
          mocks.upgrades.push({ containerName: text.containerName, content: text.content });
          mocks.visible.set(text.containerName, text.content);
        }
      }
      return true;
    }),
    textContainerUpgrade: vi.fn(async (upgrade: { containerName: string; content: string }) => {
      if (mocks.hudWriteBarrier) await mocks.hudWriteBarrier;
      mocks.upgrades.push(upgrade);
      mocks.visible.set(upgrade.containerName, upgrade.content);
      return true;
    }),
    audioControl: vi.fn(async () => true),
    setLocalStorage: async (key: string, value: string) => { mocks.storage.set(key, value); return true; },
    getLocalStorage: async (key: string) => mocks.storage.get(key) ?? '',
    onEvenHubEvent: (listener: (event: EvenHubEvent) => void) => {
      mocks.listener = listener;
      return () => { mocks.listener = null; };
    },
  }),
}));

vi.mock('../src/runtime/noiseReduction', () => ({
  reduceSnapshotNoise: mocks.noise,
  resetNoiseReduction: vi.fn(),
}));

import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import { DEFAULT_CONVERSATION, AUTO_LENS_CANDIDATES, configureSettings, getPersona } from '@veritaslens/core';
import { requestConversationHelp, pauseConversation, startConversation, refreshHudPage, startHudRuntime, stopHudRuntime } from '../src/runtime/lifecycle';
import { _resetHudBootstrapForTesting, currentHudPage, getLensStreamingState, menuOptionAtIndex, setActiveLayout, showActivePage, isActiveHidden, setLensResult, showHistoryListPage, showHistoryDetailPage, getHistoryListEntries, scrollActiveReason, hasPendingActiveResult } from '../src/runtime/hud';
import {
  saveMeetingPrepSections, lensResult, deleteHistorySession, activePersona, setActivePersona, appPhase, clearSessionHistory, errorMessage, saveAutoSummaryEnabled,
  saveAutoDisabledLenses, saveGeminiKey, saveTranscriptMode, saveVoiceGateRmsFloor, saveVoiceTrimEnabled, saveNoiseReductionEnabled,
  recordingPaused, updateHistoryEntry, loadHistory, saveConversationPreferences, sessionHistory, settings, setErrorMessage, saveDiscreet,
} from '../src/state/store';

const voice: VoiceBufferAnalysis = { voiceFrames: 1, silenceFrames: 0, noiseFrames: 0, totalFrames: 1 };
const answer = JSON.stringify({ claims: [{
  quote: 'Paris is in France', verdict: 'TRUE', claim: 'Paris is in France',
  correction: '', reason: 'Paris is the French capital.', confidence: 'HIGH',
}] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

function lastHudContent(name: string): string | undefined {
  return mocks.upgrades.filter((upgrade) => upgrade.containerName === name).at(-1)?.content;
}

async function drain() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

function tap() {
  mocks.listener!({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } } as EvenHubEvent);
}

function audio(value: number) {
  const pcm = new Uint8Array(3200);
  new Int16Array(pcm.buffer).fill(value);
  mocks.listener!({ audioEvent: { audioPcm: pcm } } as EvenHubEvent);
  return pcm;
}

describe('analysis through the gesture/audio pipeline', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    mocks.storage.clear();
    mocks.upgrades.length = 0;
    mocks.visible.clear();
    mocks.listItems = [];
    mocks.hudWriteBarrier = null;
    mocks.hudRebuildBarrier = null;
    configureSettings(settings);
    setErrorMessage(null);
    clearSessionHistory();
    _resetHudBootstrapForTesting();
    const persist = async () => true;
    await saveConversationPreferences(persist, DEFAULT_CONVERSATION);
    await saveGeminiKey(persist, 'test-gemini-key');
    await saveDiscreet(persist, false);
    await saveAutoSummaryEnabled(persist, false);
    await saveTranscriptMode(persist, 'off');
    await saveAutoDisabledLenses(persist, []);
    await saveVoiceTrimEnabled(persist, false);
    await saveNoiseReductionEnabled(persist, false);
    await saveVoiceGateRmsFloor(persist, 200);
    mocks.gate.mockResolvedValue(voice);
    mocks.noise.mockImplementation(async (pcm: Uint8Array) => ({ pcm, status: 'filtered', ms: 5 }));
    mocks.call.mockImplementation(async (opts: CallLensStreamOptions) =>
      'chosenLensId' in (opts.schema as { properties: object }).properties
        ? JSON.stringify({ chosenLensId: 'fact-checker' }) : answer);
    mocks.stream.mockImplementation(async (opts: CallLensStreamOptions) => {
      opts.onGroundingMode?.('grounded');
      opts.onCitations?.([{ domain: 'example.org', url: 'https://example.org/source', title: 'Source' }]);
      return answer;
    });
    await startHudRuntime();
    // Auto is the first picker item. Exercise the real event router and HUD.
    mocks.listener!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: 0 } } as EvenHubEvent);
    await drain();
    expect(currentHudPage()).toBe('active');
    expect(appPhase()).toBe('listening');
  });

  afterEach(async () => { await stopHudRuntime(); await drain(); await saveDiscreet(async () => true, false); vi.useRealTimers(); });

  it('removes deleted answers from visible and hidden active recall', async () => {
    audio(1000); await requestConversationHelp('fact-checker', undefined, false);
    expect(mocks.visible.get('vl-reason')).toContain('Paris');
    await clearSessionHistory(async () => true);
    await refreshHudPage();
    expect(mocks.visible.get('vl-reason') ?? '').not.toContain('Paris');
    await scrollActiveReason(1);
    expect(await scrollActiveReason(-1)).toBe('noop');
    expect(lensResult()).toBeNull();
  });

  it('does not replay an answer deleted while waiting on the menu', async () => {
    const pending = deferred<string>();
    mocks.stream.mockReturnValueOnce(pending.promise);
    audio(1000); tap(); await drain();
    mocks.listener!({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as EvenHubEvent);
    await drain();
    pending.resolve(answer); await drain();
    expect(hasPendingActiveResult()).toBe(true);
    await clearSessionHistory(async () => true);
    await refreshHudPage();
    expect(hasPendingActiveResult()).toBe(false);
    mocks.listener!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: 0 } } as EvenHubEvent);
    await drain();
    expect([...mocks.visible.values()].join(' ')).not.toContain('Paris');
    expect(await scrollActiveReason(-1)).toBe('noop');
  });

  it('cancels pending Speak uploads on pause and does not revive them on resume', async () => {
    vi.useFakeTimers();
    await startConversation('translation');
    await setLensResult({ type: 'translation', sourceLanguage: 'es', sourceText: 'Hola', translatedText: 'Hello', replyStarters: [] });
    mocks.listener!({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as EvenHubEvent); await drain();
    const index = mocks.listItems.indexOf('Speak →');
    expect(index).toBeGreaterThanOrEqual(0);
    mocks.listener!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: index } } as EvenHubEvent); await drain();
    audio(1000); await pauseConversation();
    await vi.advanceTimersByTimeAsync(12000);
    expect(mocks.call).not.toHaveBeenCalled();
    await pauseConversation();
    await vi.advanceTimersByTimeAsync(12000);
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it('aborts a mid-session summary and ignores its late response after Pause', async () => {
    vi.useFakeTimers(); audio(1000); await requestConversationHelp('fact-checker', undefined, false);
    vi.setSystemTime(Date.now() + 61000);
    const pending = deferred<string>(); mocks.call.mockReturnValueOnce(pending.promise);
    mocks.listener!({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as EvenHubEvent); await drain();
    const index = mocks.listItems.findIndex((_, i) => menuOptionAtIndex(i) === 'mid-summary');
    expect(index).toBeGreaterThanOrEqual(0);
    mocks.listener!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: index } } as EvenHubEvent); await drain();
    const signal = mocks.call.mock.calls.at(-1)![0].signal as AbortSignal;
    await pauseConversation();
    const aborted = signal.aborted;
    pending.resolve(JSON.stringify({ title: 'Late summary', summary: 'SHOULD_NOT_APPEAR', topics: [], keyPoints: [] })); await drain();
    expect(aborted).toBe(true);
    expect([...mocks.visible.values()].join(' ')).not.toContain('SHOULD_NOT_APPEAR');
    expect(currentHudPage()).toBe('active');
  });

  it('restores the paused HUD when a canceled summary page finishes rebuilding', async () => {
    vi.useFakeTimers(); audio(1000); await requestConversationHelp('fact-checker', undefined, false);
    vi.setSystemTime(Date.now() + 61000);
    mocks.listener!({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as EvenHubEvent); await drain();
    const index = mocks.listItems.findIndex((_, i) => menuOptionAtIndex(i) === 'mid-summary');
    const page = deferred<void>(); mocks.hudRebuildBarrier = page.promise;
    mocks.listener!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: index } } as EvenHubEvent); await drain();
    await pauseConversation();
    page.resolve(); await drain(); mocks.hudRebuildBarrier = null;
    expect(recordingPaused()).toBe(true);
    expect(currentHudPage()).toBe('active');
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it('discards canceled Prepared assistance after a slow spinner write', async () => {
    await saveMeetingPrepSections(async () => true, [{ id: 'general', label: '', body: 'Review a project.' }]);
    const barrier = deferred<void>();
    mocks.stream.mockImplementationOnce(async () => {
      mocks.hudWriteBarrier = barrier.promise;
      return JSON.stringify({ answer: 'CANCELED_RESULT', source: '' });
    });
    audio(1000);
    const analysis = requestConversationHelp('meeting-prep', undefined, false); await drain();
    const change = startConversation('eli5'); await drain();
    barrier.resolve(); await change; await analysis; await drain();
    expect(activePersona()).toBe('eli5');
    expect(sessionHistory()).toHaveLength(0);
    expect(lensResult()?.type).not.toBe('meeting-prep');
  });

  it('restores listening after switching lenses while a request is in flight', async () => {
    const pending = deferred<string>();
    mocks.stream.mockReturnValueOnce(pending.promise);
    audio(1000); tap(); await drain();
    expect(appPhase()).toBe('thinking');
    await startConversation('eli5');
    pending.reject(new DOMException('Cancelled', 'AbortError'));
    await drain();
    expect(activePersona()).toBe('eli5');
    expect(appPhase()).toBe('listening');
    expect(currentHudPage()).toBe('active');
  });

  it('cancels the pending Speak timer when selecting another lens', async () => {
    vi.useFakeTimers();
    await startConversation('translation');
    await setLensResult({ type: 'translation', sourceLanguage: 'es', sourceText: 'Hola', translatedText: 'Hello', replyStarters: [] });
    mocks.listener!({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as EvenHubEvent);
    await drain();
    const speakIndex = mocks.listItems.indexOf('Speak →');
    expect(speakIndex).toBeGreaterThanOrEqual(0);
    mocks.listener!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: speakIndex } } as EvenHubEvent);
    await drain();
    expect(currentHudPage()).toBe('translation-wearer-speak');
    await startConversation('eli5');
    audio(1000);
    await vi.advanceTimersByTimeAsync(12000);
    expect(activePersona()).toBe('eli5');
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it.each(['list', 'detail'] as const)('invalidates cleared HUD history from the %s page without ending the session', async page => {
    audio(1000); await requestConversationHelp('fact-checker', undefined, false);
    await showHistoryListPage(sessionHistory());
    if (page === 'detail') await showHistoryDetailPage(sessionHistory()[0]!);
    await clearSessionHistory(async () => true);
    await refreshHudPage();
    expect(getHistoryListEntries()).toHaveLength(0);
    expect(currentHudPage()).toBe('history-list');
    expect(appPhase()).toBe('displaying');
  });

  it('removes a deleted session from HUD history but preserves a remaining detail on preference refresh', async () => {
    audio(1000); await requestConversationHelp('fact-checker', undefined, false);
    const entry = sessionHistory()[0]!;
    await showHistoryListPage(sessionHistory());
    await showHistoryDetailPage(entry);
    await refreshHudPage();
    expect(currentHudPage()).toBe('history-detail');
    expect(getHistoryListEntries()).toEqual([entry]);
    await deleteHistorySession(entry.sessionId, async () => true);
    await refreshHudPage();
    expect(getHistoryListEntries()).toHaveLength(0);
    expect(currentHudPage()).toBe('history-list');
  });

  const summary = JSON.stringify({ title: 'Conversation', summary: 'A short summary.', topics: ['Paris'], keyPoints: ['Paris is in France'] });
  async function exitWithSummary() {
    mocks.listener!({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as EvenHubEvent);
    await drain();
    const exitIndex = mocks.listItems.findIndex((_, i) => menuOptionAtIndex(i) === 'exit');
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    mocks.listener!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: exitIndex } } as EvenHubEvent);
    await drain();
    expect(currentHudPage()).toBe('picker');
  }

  it.each(['stop', 'new-session'] as const)('cancels stop-time summary before the voice gate completes on %s', async action => {
    vi.useFakeTimers();
    audio(1000); await requestConversationHelp('fact-checker', undefined, false);
    await saveAutoSummaryEnabled(async () => true, true);
    vi.setSystemTime(Date.now() + 61000);
    const gate = deferred<VoiceBufferAnalysis>();
    mocks.gate.mockReturnValueOnce(gate.promise);
    mocks.call.mockClear();
    await exitWithSummary();
    expect(mocks.gate).toHaveBeenCalledTimes(2);
    if (action === 'stop') await stopHudRuntime();
    else await startConversation('fact-checker');
    gate.resolve(voice); await drain();
    expect(mocks.call).not.toHaveBeenCalled();
    expect(sessionHistory()).toHaveLength(1);
  });

  it('does not persist a late stop-time summary after runtime shutdown', async () => {
    vi.useFakeTimers();
    audio(1000); await requestConversationHelp('fact-checker', undefined, false);
    await saveAutoSummaryEnabled(async () => true, true);
    vi.setSystemTime(Date.now() + 61000);
    const pending = deferred<string>();
    mocks.call.mockReturnValueOnce(pending.promise);
    await exitWithSummary();
    const signal = mocks.call.mock.calls.at(-1)![0].signal as AbortSignal;
    await stopHudRuntime();
    expect(signal.aborted).toBe(true);
    pending.resolve(summary); await drain();
    expect(sessionHistory()).toHaveLength(1);
  });

  it('cancels a periodic summary that is still checking for voice when paused', async () => {
    vi.useFakeTimers();
    await stopHudRuntime();
    await saveAutoSummaryEnabled(async () => true, true);
    await startConversation('fact-checker');
    audio(1000); await requestConversationHelp('fact-checker', undefined, false);
    const gate = deferred<VoiceBufferAnalysis>();
    mocks.gate.mockReturnValueOnce(gate.promise);
    mocks.call.mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.gate).toHaveBeenCalledTimes(2);
    await pauseConversation();
    gate.resolve(voice); await drain();
    expect(recordingPaused()).toBe(true);
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it('cancels summaries before shutdown waits for a slow HUD write', async () => {
    vi.useFakeTimers();
    await stopHudRuntime();
    await saveAutoSummaryEnabled(async () => true, true);
    await startConversation('fact-checker');
    audio(1000); await requestConversationHelp('fact-checker', undefined, false);
    const gate = deferred<VoiceBufferAnalysis>();
    mocks.gate.mockReturnValueOnce(gate.promise);
    mocks.call.mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    const hud = deferred<void>();
    mocks.hudWriteBarrier = hud.promise;
    const shutdown = stopHudRuntime();
    gate.resolve(voice); await drain();
    const callsDuringShutdown = mocks.call.mock.calls.length;
    hud.resolve(); await shutdown;
    mocks.hudWriteBarrier = null;
    expect(callsDuringShutdown).toBe(0);
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it('keeps the microphone paused when switching lenses', async () => {
    await pauseConversation();
    await startConversation('eli5');
    expect(recordingPaused()).toBe(true);
    expect(appPhase()).toBe('listening');
    expect(activePersona()).toBe('eli5');
    audio(1000); tap(); await drain();
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it.each(['complete', 'cancel'] as const)('keeps one stop-time cancellation signal through the final synthesis: %s', async outcome => {
    vi.useFakeTimers();
    await stopHudRuntime();
    await saveAutoSummaryEnabled(async () => true, true);
    await startConversation('fact-checker');
    audio(1000); await requestConversationHelp('fact-checker', undefined, false);
    mocks.call.mockResolvedValueOnce(summary);
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.call).toHaveBeenCalledTimes(1);
    const pending = deferred<string>();
    mocks.call.mockReturnValueOnce(pending.promise);
    await exitWithSummary();
    if (outcome === 'cancel') await startConversation('fact-checker');
    pending.resolve(summary); await drain();
    expect(sessionHistory().map(entry => entry.result.type)).toEqual(outcome === 'cancel'
      ? ['fact-check'] : ['fact-check', 'session-summary', 'session-summary']);
  });

  it('still saves a successful stop-time summary', async () => {
    vi.useFakeTimers();
    audio(1000); await requestConversationHelp('fact-checker', undefined, false);
    await saveAutoSummaryEnabled(async () => true, true);
    vi.setSystemTime(Date.now() + 61000);
    mocks.call.mockResolvedValueOnce(summary);
    await exitWithSummary();
    await drain();
    expect(sessionHistory().map(entry => entry.result.type)).toEqual(['fact-check', 'session-summary']);
  });

  it.each([false, true])('routes up/down, click, and menu Back to answers or dot-only listening (discreet=%s)', async (discreet) => {
    await saveDiscreet(async () => true, discreet);
    setActiveLayout(discreet ? 'discreet-minimal' : 'baseline');
    await showActivePage(getPersona('auto')!);
    mocks.call.mockResolvedValueOnce(JSON.stringify({ chosenLensId: 'trivia' }));
    mocks.stream.mockResolvedValueOnce(JSON.stringify({ claims: [
      { quote: 'First question?', question: 'First question?', answer: 'First answer', description: '', confidence: 'HIGH' },
      { quote: 'Second question?', question: 'Second question?', answer: 'Second answer', description: '', confidence: 'HIGH' },
    ] }));
    audio(1000);
    tap();
    await drain();
    const gesture = async (type?: OsEventTypeList) => {
      const scroll = type === OsEventTypeList.SCROLL_TOP_EVENT || type === OsEventTypeList.SCROLL_BOTTOM_EVENT;
      mocks.listener!(scroll
        ? { textEvent: { eventType: type } } as EvenHubEvent
        : { sysEvent: { eventType: type } } as EvenHubEvent);
      await drain();
    };
    const dotOnly = () => {
      expect(currentHudPage()).toBe('active');
      expect(appPhase()).toBe('listening');
      expect(isActiveHidden()).toBe(true);
      expect([...mocks.visible.values()].filter((text) => text.trim())).toEqual(['•']);
      expect(mocks.visible.has('vl-claim')).toBe(false);
    };
    expect(mocks.visible.get('vl-reason')).toBe('First answer');
    await gesture(OsEventTypeList.SCROLL_TOP_EVENT);
    expect(mocks.visible.get('vl-reason')).toBe('First answer');
    await gesture(OsEventTypeList.SCROLL_BOTTOM_EVENT);
    expect(mocks.visible.get('vl-reason')).toBe('Second answer');
    await gesture(OsEventTypeList.SCROLL_TOP_EVENT);
    expect(mocks.visible.get('vl-reason')).toBe('First answer');
    await gesture(OsEventTypeList.SCROLL_BOTTOM_EVENT);
    await gesture(OsEventTypeList.SCROLL_BOTTOM_EVENT);
    dotOnly();
    await gesture(OsEventTypeList.SCROLL_BOTTOM_EVENT);
    dotOnly();
    await gesture(OsEventTypeList.SCROLL_TOP_EVENT);
    expect(mocks.visible.get('vl-reason')).toBe('Second answer');
    expect(appPhase()).toBe('displaying');
    await gesture(); // Host normalizes a click to an undefined event type.
    expect(currentHudPage()).toBe('menu');
    await gesture(); // Fresh menu highlights Back.
    dotOnly();
    await gesture(OsEventTypeList.SCROLL_TOP_EVENT);
    expect(mocks.visible.get('vl-reason')).toBe('Second answer');
  });

  it('Back hides an answer that arrived while the menu was open, but up can recall it', async () => {
    const response = deferred<string>();
    mocks.stream.mockReturnValueOnce(response.promise);
    audio(1000);
    tap();
    await drain();
    mocks.listener!({ sysEvent: {} } as EvenHubEvent);
    await drain();
    expect(currentHudPage()).toBe('menu');
    response.resolve(answer);
    await drain();
    mocks.listener!({ sysEvent: {} } as EvenHubEvent);
    await drain();
    expect(appPhase()).toBe('listening');
    expect([...mocks.visible.values()].filter((text) => text.trim())).toEqual(['•']);
    mocks.listener!({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } } as EvenHubEvent);
    await drain();
    expect(appPhase()).toBe('displaying');
    expect(mocks.visible.get('vl-reason')).toContain('French capital');
  });

  it('resets the menu selection to Back after previously selecting History', async () => {
    audio(1000);
    tap();
    await drain();
    mocks.listener!({ sysEvent: {} } as EvenHubEvent);
    await drain();
    const historyIndex = Array.from({ length: 20 }, (_, i) => i).find((i) => menuOptionAtIndex(i) === 'history')!;
    mocks.listener!({ listEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT, currentSelectItemIndex: historyIndex } } as EvenHubEvent);
    mocks.listener!({ sysEvent: {} } as EvenHubEvent);
    await drain();
    expect(currentHudPage()).toBe('history-list');
    mocks.listener!({ listEvent: { currentSelectItemIndex: 0 } } as EvenHubEvent);
    await drain();
    expect(currentHudPage()).toBe('active');
    mocks.listener!({ sysEvent: {} } as EvenHubEvent);
    await drain();
    expect(currentHudPage()).toBe('menu');
    mocks.listener!({ sysEvent: {} } as EvenHubEvent);
    await drain();
    expect(currentHudPage()).toBe('active');
    expect(appPhase()).toBe('listening');
    expect([...mocks.visible.values()].filter((text) => text.trim())).toEqual(['•']);
  });

  it('keeps denoising off by default and never runs it for a rejected voice gate', async () => {
    audio(1000); tap(); await drain();
    expect(mocks.noise).not.toHaveBeenCalled();
    await saveNoiseReductionEnabled(async () => true, true);
    mocks.gate.mockResolvedValueOnce({ ...voice, voiceFrames: 0 });
    audio(2000); tap(); await drain();
    expect(mocks.noise).not.toHaveBeenCalled();
  });

  it('uploads filtered PCM while keeping frozen raw audio for subsequent actions', async () => {
    await saveNoiseReductionEnabled(async () => true, true);
    const captured = audio(1000);
    mocks.noise.mockImplementation(async (pcm: Uint8Array) => ({ pcm: new Uint8Array(pcm.length).fill(1), status: 'filtered', ms: 5 }));
    await requestConversationHelp('fact-checker', undefined, false);
    const sent = mocks.stream.mock.calls.at(-1)![0].wav as Uint8Array;
    expect(sent.slice(44)).toEqual(new Uint8Array(captured.length).fill(1));
    expect(mocks.noise.mock.calls[0]![0]).toEqual(captured);
    await saveNoiseReductionEnabled(async () => true, false);
    await requestConversationHelp('fact-checker');
    const reused = mocks.stream.mock.calls.at(-1)![0].wav as Uint8Array;
    expect(reused.slice(44)).toEqual(captured);
    expect(mocks.noise).toHaveBeenCalledTimes(1);
  });

  it('uploads the original PCM when optional denoising falls back', async () => {
    await saveNoiseReductionEnabled(async () => true, true);
    mocks.noise.mockImplementation(async (pcm: Uint8Array) => ({ pcm, status: 'timeout', ms: 1000 }));
    const captured = audio(1000); await requestConversationHelp('fact-checker', undefined, false);
    expect(mocks.stream.mock.calls.at(-1)![0].wav.slice(44)).toEqual(captured);
    expect(appPhase()).toBe('displaying');
  });

  it('does not send audio if cancelled while denoising', async () => {
    await saveNoiseReductionEnabled(async () => true, true);
    const pending = deferred<{ pcm: Uint8Array; status: string; ms: number }>();
    mocks.noise.mockReturnValueOnce(pending.promise);
    const captured = audio(1000); tap(); await drain();
    expect(mocks.noise).toHaveBeenCalledOnce();
    tap(); pending.resolve({ pcm: captured.slice(), status: 'filtered', ms: 5 }); await drain();
    expect(mocks.call).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('does not send audio if the runtime stops while denoising', async () => {
    await saveNoiseReductionEnabled(async () => true, true);
    const pending = deferred<{ pcm: Uint8Array; status: string; ms: number }>();
    mocks.noise.mockReturnValueOnce(pending.promise);
    const captured = audio(1000); tap(); await drain(); await stopHudRuntime();
    pending.resolve({ pcm: captured.slice(), status: 'filtered', ms: 5 }); await drain();
    expect(mocks.call).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('freezes the audio at the tap and leaves audio received during VAD for the next tap', async () => {
    const gate = deferred<VoiceBufferAnalysis>();
    mocks.gate.mockReturnValueOnce(gate.promise);
    const beforeTap = audio(1000);
    tap();
    const duringGate = audio(2000);
    gate.resolve(voice);
    await drain();
    expect(errorMessage()).toBeNull();
    expect(appPhase()).toBe('displaying');
    const first = mocks.stream.mock.calls[0]![0] as CallLensStreamOptions;
    expect(first.wav.length - 44).toBe(beforeTap.length);

    tap();
    await drain();
    expect(mocks.gate.mock.calls[1]![0]).toEqual(duringGate);
  });

  it('allows cancellation while VAD is running without making a model call', async () => {
    const gate = deferred<VoiceBufferAnalysis>();
    mocks.gate.mockReturnValueOnce(gate.promise);
    audio(1000);
    tap();
    tap();
    gate.resolve(voice);
    await drain();
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(appPhase()).toBe('listening');
  });

  it('keeps grounded streaming and citations when the speculative Auto lens matches', async () => {
    audio(1000);
    tap();
    await drain();
    expect(appPhase()).toBe('displaying');
    audio(2000);
    tap();
    await drain();
    expect(appPhase()).toBe('displaying');
    // Two classifiers, two grounded answers; speculation reuses the second answer.
    expect(mocks.call).toHaveBeenCalledTimes(2);
    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect((mocks.stream.mock.calls[1]![0] as CallLensStreamOptions).grounding).toBe('google_search');
    expect(sessionHistory().every((entry) => entry.webCitations?.[0]?.url === 'https://example.org/source')).toBe(true);
  });

  it('does not publish an answer returned after cancellation', async () => {
    const result = deferred<string>();
    mocks.stream.mockReturnValueOnce(result.promise);
    audio(1000);
    tap();
    await drain();
    tap();
    await drain();
    result.resolve(answer);
    await drain();
    expect(appPhase()).toBe('listening');
    expect(sessionHistory()).toHaveLength(0);
  });

  it('leaves a newer answer intact when a cancelled provider completes late', async () => {
    const oldResult = deferred<string>();
    mocks.stream.mockReturnValueOnce(oldResult.promise);
    audio(1000);
    tap();
    await drain();
    tap();
    await drain();
    audio(2000);
    tap();
    await drain();
    expect(appPhase()).toBe('displaying');
    oldResult.resolve(answer);
    await drain();
    expect(appPhase()).toBe('displaying');
    expect(sessionHistory()).toHaveLength(1);
  });

  it('clears queued headings on cancel and ignores late partials', async () => {
    const result = deferred<string>();
    mocks.call.mockResolvedValueOnce(JSON.stringify({ chosenLensId: 'trivia' }));
    let callback: CallLensStreamOptions['onPartialString'];
    mocks.stream.mockImplementationOnce((opts: CallLensStreamOptions) => {
      callback = opts.onPartialString;
      callback?.('answer', 'P');
      callback?.('answer', 'Paris');
      return result.promise;
    });
    audio(1000);
    tap();
    await drain();
    expect(getLensStreamingState().active).toBe(true);
    tap();
    await drain();
    callback?.('answer', 'Late answer');
    expect(getLensStreamingState().active).toBe(false);
    expect(lastHudContent('vl-reason')).toBe('');
    expect(lastHudContent('vl-status')).toBe('•');
    result.resolve(answer);
    await drain();
  });

  it.each(['Error', 'NoSpeechError'])('removes partial HUD text and displays feedback after %s', async (name) => {
    const result = deferred<string>();
    mocks.call.mockResolvedValueOnce(JSON.stringify({ chosenLensId: 'trivia' }));
    mocks.stream.mockImplementationOnce((opts: CallLensStreamOptions) => {
      opts.onPartialString?.('answer', 'Unfinished answer');
      return result.promise;
    });
    audio(1000);
    tap();
    await drain();
    expect(lastHudContent('vl-reason')).toBe('Unfinished answer');
    result.reject(Object.assign(new Error('Provider failed'), { name }));
    await drain();
    expect(lastHudContent('vl-reason')).toBe('');
    expect(lastHudContent('vl-status')).toBe(name === 'NoSpeechError' ? '○' : 'ERR');
    expect(appPhase()).toBe(name === 'NoSpeechError' ? 'listening' : 'error');
    expect(sessionHistory()).toHaveLength(0);
  });

  it('consumes an irrelevant snapshot without saving a blank answer or reporting no speech', async () => {
    mocks.stream.mockResolvedValueOnce(JSON.stringify({ noSpeech: false, claims: [] }));
    const consumed = audio(1000);
    tap();
    await drain();
    expect(appPhase()).toBe('listening');
    expect(errorMessage()).toBeNull();
    expect(sessionHistory()).toHaveLength(0);
    expect(lastHudContent('vl-status')).toBe('•');
    const next = audio(2000);
    tap();
    await drain();
    expect(mocks.gate.mock.calls[1]![0]).toEqual(next);
    expect(mocks.gate.mock.calls[1]![0]).not.toEqual(consumed);
    expect(appPhase()).toBe('displaying');
  });

  it('runs the sole enabled Auto lens without a classifier or speculative duplicate', async () => {
    await saveAutoDisabledLenses(async () => true, AUTO_LENS_CANDIDATES.filter((id) => id !== 'fact-checker'));
    for (const value of [1000, 2000]) {
      audio(value);
      tap();
      await drain();
      expect(appPhase()).toBe('displaying');
    }
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(sessionHistory().every((entry) => entry.lensId === 'fact-checker')).toBe(true);
  });

  it('rejects a classifier pick outside the enabled lenses before analysis', async () => {
    await saveAutoDisabledLenses(async () => true, ['fact-checker']);
    mocks.call.mockResolvedValueOnce(JSON.stringify({ chosenLensId: 'fact-checker' }));
    audio(1000);
    tap();
    await drain();
    expect(appPhase()).toBe('error');
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(sessionHistory()).toHaveLength(0);
  });

  it('keeps already-answered suppression scoped to the lens selected by Auto', async () => {
    audio(1000);
    tap();
    await drain();
    audio(2000);
    mocks.call.mockResolvedValueOnce(JSON.stringify({ chosenLensId: 'trivia' }));
    tap();
    await drain();
    const prompts = mocks.stream.mock.calls.map(([opts]) => (opts as CallLensStreamOptions).prompt);
    // Previous-winner speculation gets the fact-check history; Trivia must
    // still be able to answer a question about the same topic.
    expect(prompts[1]).toContain('ALREADY ANSWERED by this lens');
    expect(prompts[2]).not.toContain('ALREADY ANSWERED');
    const classifier = mocks.call.mock.calls[1]![0] as CallLensStreamOptions;
    expect(classifier.prompt).not.toContain('ALREADY ANSWERED');
  });

  it('shows elapsed seconds after ten seconds, updates once a second, and clears on completion', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const response = deferred<string>();
    mocks.stream.mockReturnValueOnce(response.promise);
    audio(1000);
    tap();
    await drain();
    await vi.advanceTimersByTimeAsync(9999);
    expect(lastHudContent('vl-status')).toMatch(/^[\/\\]$/);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastHudContent('vl-status')).toMatch(/^[\/\\]$/);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastHudContent('vl-status')).toBe('10s');
    const writes = mocks.upgrades.filter((entry) => entry.containerName === 'vl-status').length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(lastHudContent('vl-status')).toBe('13s');
    expect(mocks.upgrades.filter((entry) => entry.containerName === 'vl-status').length - writes).toBe(3);
    response.resolve(answer);
    await drain();
    expect(appPhase()).toBe('displaying');
    expect(lastHudContent('vl-status')).toBe('');
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastHudContent('vl-status')).toBe('');
  });

  it('counts preparation and retry time from the original tap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const gate = deferred<VoiceBufferAnalysis>();
    const response = deferred<string>();
    mocks.gate.mockReturnValueOnce(gate.promise);
    let retry: CallLensStreamOptions['onRetry'];
    mocks.stream.mockImplementationOnce((opts: CallLensStreamOptions) => {
      retry = opts.onRetry;
      return response.promise;
    });
    audio(1000);
    tap();
    await vi.advanceTimersByTimeAsync(6000);
    gate.resolve(voice);
    await drain();
    await vi.advanceTimersByTimeAsync(4001);
    expect(lastHudContent('vl-status')).toBe('10s');
    await retry?.(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(lastHudContent('vl-status')).toBe('11s');
    response.resolve(answer);
    await drain();
  });

  it('cancels the elapsed timer and starts the next analysis from zero', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const response = deferred<string>();
    mocks.stream.mockReturnValueOnce(response.promise);
    audio(1000);
    tap();
    await drain();
    await vi.advanceTimersByTimeAsync(12000);
    expect(lastHudContent('vl-status')).toBe('12s');
    tap();
    await drain();
    await vi.advanceTimersByTimeAsync(3000);
    expect(lastHudContent('vl-status')).toBe('•');
    response.resolve(answer);
    await drain();
    const next = deferred<string>();
    mocks.stream.mockReturnValueOnce(next.promise);
    audio(2000);
    tap();
    await drain();
    await vi.advanceTimersByTimeAsync(2000);
    expect(lastHudContent('vl-status')).toMatch(/^[\/\\]$/);
    next.resolve(answer);
    await drain();
  });

  it('removes the elapsed timer as soon as an answer begins streaming', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const response = deferred<string>();
    mocks.call.mockResolvedValueOnce(JSON.stringify({ chosenLensId: 'trivia' }));
    let partial: CallLensStreamOptions['onPartialString'];
    mocks.stream.mockImplementationOnce((opts: CallLensStreamOptions) => {
      partial = opts.onPartialString;
      return response.promise;
    });
    audio(1000);
    tap();
    await drain();
    await vi.advanceTimersByTimeAsync(12000);
    expect(lastHudContent('vl-status')).toBe('12s');
    partial?.('answer', 'Paris');
    await drain();
    await vi.advanceTimersByTimeAsync(3000);
    expect(lastHudContent('vl-status')).toBe('');
    expect(lastHudContent('vl-reason')).toBe('Paris');
    response.resolve(answer);
    await drain();
  });

  it('keeps elapsed time visible on the menu and clears it when analysis completes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const response = deferred<string>();
    mocks.stream.mockReturnValueOnce(response.promise);
    audio(1000);
    tap();
    await drain();
    await vi.advanceTimersByTimeAsync(12000);
    mocks.listener!({ sysEvent: {} } as EvenHubEvent);
    await drain();
    expect(currentHudPage()).toBe('menu');
    expect(lastHudContent('vl-menu-spin')).toBe('12s');
    await vi.advanceTimersByTimeAsync(1000);
    expect(lastHudContent('vl-menu-spin')).toBe('13s');
    expect(currentHudPage()).toBe('menu');
    response.resolve(answer);
    await drain();
    expect(lastHudContent('vl-menu-spin')).toBe('');
    await vi.advanceTimersByTimeAsync(3000);
    expect(lastHudContent('vl-menu-spin')).toBe('');
  });

  it('does not resume a stopped session when VAD finishes', async () => {
    const gate = deferred<VoiceBufferAnalysis>();
    mocks.gate.mockReturnValueOnce(gate.promise);
    audio(1000);
    tap();
    await stopHudRuntime();
    gate.resolve(voice);
    await drain();
    expect(mocks.call).toHaveBeenCalledTimes(0);
    expect(mocks.stream).toHaveBeenCalledTimes(0);
    expect(appPhase()).toBe('idle');
  });
  it('reuses captured audio for a different action and leaves new speech for the next check', async () => {
    const initial = audio(1000);
    await requestConversationHelp('fact-checker', undefined, false);
    const originalWav = mocks.stream.mock.calls.at(-1)![0].wav;
    audio(2000);
    mocks.stream.mockResolvedValueOnce(JSON.stringify({ useful: true, headline: 'Could you clarify the scope?', detail: '', quote: '', records: [] }));
    await requestConversationHelp('respond');
    expect(mocks.stream.mock.calls.at(-1)![0].wav).toEqual(originalWav);
    expect(sessionHistory().at(-1)?.result.type).toBe('assistance');
    await requestConversationHelp('fact-checker', undefined, false);
    const next = mocks.stream.mock.calls.at(-1)![0].wav as Uint8Array;
    expect(next.slice(44)).not.toEqual(initial);
    expect(new DataView(next.buffer, next.byteOffset).getInt16(44, true)).toBe(2000);
  });

  it('keeps the session and frozen exchange when paused, and discards paused audio', async () => {
    audio(1000); await requestConversationHelp('fact-checker', undefined, false);
    const session = sessionHistory().at(-1)!.sessionId;
    await pauseConversation(); expect(recordingPaused()).toBe(true);
    const count = mocks.stream.mock.calls.length;
    audio(2000); tap(); await drain(); expect(mocks.stream.mock.calls.length).toBe(count);
    mocks.stream.mockResolvedValueOnce(JSON.stringify({ useful: true, headline: 'Short answer', detail: '', quote: '', records: [] }));
    await requestConversationHelp('refine', 'Shorter');
    expect(sessionHistory().at(-1)!.sessionId).toBe(session);
    await pauseConversation(); expect(recordingPaused()).toBe(false);
    audio(3000); await requestConversationHelp('fact-checker', undefined, false);
    const next = mocks.stream.mock.calls.at(-1)![0].wav as Uint8Array;
    expect(next.length).toBe(44 + 3200);
    expect(new DataView(next.buffer, next.byteOffset).getInt16(44, true)).toBe(3000);
  });

  it('keeps persistent configuration off the glasses while retaining quick session actions', async () => {
    mocks.listener!({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as EvenHubEvent);
    await drain();
    const toolsIndex = mocks.listItems.indexOf('Session tools ›');
    expect(toolsIndex).toBeGreaterThanOrEqual(0);
    mocks.listener!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: toolsIndex } } as EvenHubEvent);
    await drain();
    expect(mocks.listItems).toEqual([
      '← Back', 'Pause microphone', 'View live captions',
      getPersona('catch-up')!.name, getPersona('commitments')!.name, 'Dismiss displayed answer',
    ]);
    mocks.listener!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: 1 } } as EvenHubEvent);
    await drain();
    expect(recordingPaused()).toBe(true);
    expect(mocks.listItems).toContain('Resume microphone');
  });

  it('keeps the active session and refreshes profile status when phone settings are saved', async () => {
    await startConversation('fact-checker');
    await saveConversationPreferences(async () => true, { ...DEFAULT_CONVERSATION, profile: 'work' });
    await refreshHudPage();
    expect(currentHudPage()).toBe('active');
    expect(activePersona()).toBe('fact-checker');
    mocks.listener!({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as EvenHubEvent);
    await drain();
    expect(currentHudPage()).toBe('menu');
    await saveConversationPreferences(async () => true, { ...DEFAULT_CONVERSATION, profile: 'understand' });
    await refreshHudPage();
    expect(currentHudPage()).toBe('menu');
    expect(mocks.visible.get('vl-profile')).toBe('Profile: Understand');
    expect(mocks.visible.get('vl-title')).toBe('Lens: Fact Check');
  });

  it('preserves the active lens, audio window, and enabled lenses when the profile changes', async () => {
    await startConversation('fact-checker');
    const duration = settings().bufferDuration;
    const disabled = ['eli5', 'trivia'];
    await saveAutoDisabledLenses(async () => true, disabled);
    await saveConversationPreferences(async () => true, { ...settings().conversation!, profile: 'understand' });
    expect(activePersona()).toBe('fact-checker');
    expect(settings().bufferDuration).toBe(duration);
    expect(settings().autoDisabledLenses).toEqual(disabled);
    audio(1000); tap(); await drain();
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.stream.mock.calls.at(-1)![0].prompt).toContain('understand');
  });

  it('starts the exact HUD lens under Understand and retains an explicitly selected lens on restart', async () => {
    await stopHudRuntime();
    await saveConversationPreferences(async () => true, { ...DEFAULT_CONVERSATION, profile: 'understand' });
    await startHudRuntime();
    mocks.listener!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: 0 } } as EvenHubEvent);
    await drain();
    expect(activePersona()).toBe('auto');
    await stopHudRuntime();
    setActivePersona('fact-checker');
    await startConversation();
    expect(activePersona()).toBe('fact-checker');
  });

  it('intersects the profile candidates with the enabled Auto lenses', async () => {
    await saveAutoDisabledLenses(async () => true, AUTO_LENS_CANDIDATES.filter(id => id !== 'fact-checker'));
    await saveConversationPreferences(async () => true, { ...settings().conversation!, profile: 'work' });
    audio(1000); tap(); await drain();
    expect(mocks.call).not.toHaveBeenCalled(); // A single candidate needs no classifier.
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(sessionHistory().at(-1)?.lensId).toBe('fact-checker');
  });

  it('injects profile goals and selected notes, with criticism outside default routing', async () => {
    await saveConversationPreferences(async () => true, { ...DEFAULT_CONVERSATION, profile: 'work', goal: 'Clarify ownership', contexts: [{ id: 'a', label: 'Project', body: 'Testing required' }, { id: 'b', label: 'Unrelated', body: 'PRIVATE_NOTE' }], selectedContextIds: ['a'] });
    await saveConversationPreferences(async () => true, { ...settings().conversation!, profile: 'work' }); audio(1000); tap(); await drain();
    const classifier = mocks.call.mock.calls.at(-1)![0] as CallLensStreamOptions;
    expect(classifier.prompt).toContain('Clarify ownership'); expect(classifier.prompt).toContain('Testing required'); expect(classifier.prompt).not.toContain('PRIVATE_NOTE');
    const schema = classifier.schema as { properties: { chosenLensId: { enum: string[] } } };
    expect(schema.properties.chosenLensId.enum).toContain('respond'); expect(schema.properties.chosenLensId.enum).toContain('commitments'); expect(schema.properties.chosenLensId.enum).not.toContain('logical-fallacy');
  });

  it('lets Best next help abstain without analysis or history', async () => {
    mocks.call.mockResolvedValueOnce(JSON.stringify({ chosenLensId: 'none' })); audio(1000); tap(); await drain();
    expect(mocks.stream).not.toHaveBeenCalled(); expect(sessionHistory()).toHaveLength(0); expect(appPhase()).toBe('listening');
  });

  it('persists structured records, pins and feedback across history reload', async () => {
    audio(1000);
    mocks.stream.mockResolvedValueOnce(JSON.stringify({ useful: true, headline: 'Plan proposed', detail: '', quote: 'Maybe Friday', records: [{ id: 'plan', kind: 'commitment', status: 'proposed', text: 'Send plan', owner: '', deadline: '', quote: 'Maybe Friday' }] }));
    await requestConversationHelp('commitments', undefined, false);
    const entry = sessionHistory().at(-1)!;
    await updateHistoryEntry(entry.id, { pinned: true, feedback: 'useful' }, async (k, v) => { mocks.storage.set(k, v); return true; });
    await loadHistory(async k => mocks.storage.get(k) ?? '');
    expect(sessionHistory().at(-1)).toMatchObject({ pinned: true, feedback: 'useful', result: { type: 'assistance', records: [{ status: 'proposed', owner: '', deadline: '' }] } });
  });

});
