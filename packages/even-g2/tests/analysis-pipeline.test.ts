import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk';
import type { CallLensStreamOptions, VoiceBufferAnalysis } from '@veritaslens/core';

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  call: vi.fn(),
  stream: vi.fn(),
  listener: null as ((event: EvenHubEvent) => void) | null,
  storage: new Map<string, string>(),
  upgrades: [] as Array<{ containerName: string; content: string }>,
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
    rebuildPageContainer: vi.fn(async () => true),
    textContainerUpgrade: vi.fn(async (upgrade: { containerName: string; content: string }) => {
      mocks.upgrades.push(upgrade);
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

import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import { configureSettings } from '@veritaslens/core';
import { startHudRuntime, stopHudRuntime } from '../src/runtime/lifecycle';
import { _resetHudBootstrapForTesting, currentHudPage, getLensStreamingState } from '../src/runtime/hud';
import {
  appPhase, clearSessionHistory, errorMessage, saveAutoSummaryEnabled,
  saveGeminiKey, saveTranscriptMode, saveVoiceGateRmsFloor, saveVoiceTrimEnabled,
  sessionHistory, settings, setErrorMessage,
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
    configureSettings(settings);
    setErrorMessage(null);
    clearSessionHistory();
    _resetHudBootstrapForTesting();
    const persist = async () => true;
    await saveGeminiKey(persist, 'test-gemini-key');
    await saveAutoSummaryEnabled(persist, false);
    await saveTranscriptMode(persist, 'off');
    await saveVoiceTrimEnabled(persist, false);
    await saveVoiceGateRmsFloor(persist, 200);
    mocks.gate.mockResolvedValue(voice);
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

  afterEach(async () => { await stopHudRuntime(); await drain(); });

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
});
