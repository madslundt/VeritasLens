import {
  startStream as startCameraStream,
  stopStream as stopCameraStream,
  captureFrame,
  addCameraStateListener,
  addCameraErrorListener,
  addTapListener,
} from '../../modules/expo-meta-camera';
import {
  startRecording,
  stopRecording,
  addAudioChunkListener,
  addAudioStateListener,
  addAudioErrorListener,
} from '../../modules/expo-bluetooth-audio';
import {
  PcmRingBuffer,
  encodePcmToWav,
  callLensStream,
  getPersona,
  toSpeech,
  serializeHistory,
  deserializeHistory,
} from '@veritaslens/core';
import { useStore } from '../state/store';
import { speak } from './tts';
import { playTrigger, playCancel } from './feedback-sounds';
import { getLocalStorage, setLocalStorage } from './bridge-rn';

const HISTORY_KEY = 'veritaslens.history';
const HISTORY_BUDGET = { byteBudget: 2_000_000, maxEntries: 1_000 };

/**
 * Maps a persona's ID to the corresponding LensResult.type discriminant used
 * by the streaming UI. Personas use kebab-case (factChecker.ts → 'fact-checker'),
 * but LensResult variants use lens-domain names ('fact-check', 'bias', etc.).
 * Verified against packages/core/src/types.ts LensResult union and BUILTINS in
 * packages/core/src/personas/index.ts.
 */
const PERSONA_ID_TO_RESULT_TYPE: Record<string, string> = {
  'fact-checker': 'fact-check',
  'trivia': 'trivia',
  'logical-fallacy': 'logical-fallacy',
  'bias-detector': 'bias',
  'eli5': 'eli5',
  'meeting-prep': 'meeting-prep',
  'devils-advocate': 'devils-advocate',
  'key-questions': 'key-questions',
  'companion': 'companion',
  'translation': 'translation',
};

let buffer: PcmRingBuffer | null = null;
let abortController: AbortController | null = null;
const subscriptions: Array<{ remove(): void }> = [];

export async function startLifecycle(): Promise<void> {
  // NOTE: core's configureSettings() is expected to have been called already
  // by bootstrap.ts before startLifecycle() is invoked. Bootstrap is the
  // single caller of configureSettings so the closure includes API keys that
  // Zustand does not hold.

  // Restore persisted history.
  const raw = await getLocalStorage(HISTORY_KEY);
  useStore.getState().setSessionHistory(deserializeHistory(raw));

  // Initialise PCM ring buffer at default sample rate; lifecycle resets it
  // when the first audio chunk arrives with the OS-negotiated rate.
  buffer = new PcmRingBuffer({
    durationSec: useStore.getState().settings.bufferDurationSec,
    sampleRate: 16_000,
  });

  subscriptions.push(addCameraStateListener((e) => {
    useStore.getState().setGlassesConnection({
      cameraStreaming: e.state === 'streaming',
      cameraSdkAvailable: e.state !== 'error',
    });
  }));

  subscriptions.push(addCameraErrorListener((e) => {
    useStore.getState().setGlassesConnection({
      cameraStreaming: false,
      cameraSdkAvailable: e.code !== 'sdk-unavailable',
    });
  }));

  subscriptions.push(addTapListener(() => {
    if (useStore.getState().appPhase === 'thinking') {
      cancelAnalysis();
    } else {
      void triggerAnalysis();
    }
  }));

  subscriptions.push(addAudioStateListener((e) => {
    useStore.getState().setGlassesConnection({ hfpConnected: e.state === 'recording' });
  }));

  subscriptions.push(addAudioErrorListener(() => {
    useStore.getState().setGlassesConnection({ hfpConnected: false });
  }));

  let firstChunk = true;
  subscriptions.push(addAudioChunkListener((e) => {
    if (firstChunk) {
      // Re-create buffer at the actual OS-negotiated sample rate.
      buffer = new PcmRingBuffer({
        durationSec: useStore.getState().settings.bufferDurationSec,
        sampleRate: e.sampleRate,
      });
      firstChunk = false;
    }
    const bytes = base64ToBytes(e.pcm);
    buffer?.append(bytes);
  }));

  await startCameraStream();
  await startRecording();
}

export async function stopLifecycle(): Promise<void> {
  for (const s of subscriptions) s.remove();
  subscriptions.length = 0;
  await stopRecording();
  await stopCameraStream();
  buffer = null;
}

export async function triggerAnalysis(): Promise<void> {
  const state = useStore.getState();
  const conn = state.glassesConnection;
  if (!conn.hfpConnected) return; // gated by Connect-glasses screen
  if (!buffer) return;
  if (state.appPhase === 'thinking') return; // ignore during in-flight

  void playTrigger();
  state.setAppPhase('thinking');

  abortController = new AbortController();

  const wav = encodePcmToWav(buffer.toLinearPcm(), {
    sampleRate: buffer.sampleRate,
    bitsPerSample: 16,
    channels: 1,
  });

  let imageData: string | undefined;
  if (state.settings.cameraEnabled && conn.cameraStreaming) {
    try {
      const frame = await captureFrame();
      imageData = frame.data;
    } catch {
      // Camera unavailable — proceed audio-only.
    }
  }

  const persona = getPersona(state.settings.activeLensId);
  if (!persona) {
    state.setAppPhase('error');
    abortController = null;  // Avoid leaking the controller through the early return.
    return;
  }

  try {
    const responseText = await callLensStream({
      wav,
      imageData,
      // TODO(plan-3-t6): Plumb responseLanguage from settings. Until then,
      // rayban responses are always in English regardless of the wearer's locale.
      // even-g2 reads settings().responseLanguage dynamically.
      prompt: persona.buildPrompt('en'),
      schema: persona.schema,
      signal: abortController.signal,
      onPartialString: (key, value) => {
        // Render whatever the streaming JSON parser has so far. The persona-specific
        // shape isn't fully formed mid-stream; we render the raw key/value so the
        // user sees text appear instead of a loading spinner. The final parsed
        // `result` replaces this on completion.
        const resultType = PERSONA_ID_TO_RESULT_TYPE[persona.id];
        if (!resultType) return; // Auto or unknown persona — skip streaming UI for now
        const partial = { type: resultType, [key]: value } as unknown;
        state.setStreamingResult(partial as never);
      },
    });
    const result = persona.parse(responseText);
    if (!result || result.type === undefined) {
      state.setAppPhase('error');
      return;
    }

    const entry = {
      id: `${Date.now()}`,
      sessionId: 'session',
      timestamp: Date.now(),
      lensId: persona.id,
      lensName: persona.name,
      question: '',
      badge: '',
      quote: '',
      result,
    };
    state.setStreamingResult(null);
    state.appendHistoryEntry(entry);
    state.setAppPhase('displaying');

    // Persist updated history. Read fresh state — the local `state` snapshot is stale
    // after appendHistoryEntry() because Zustand produces a new object on each set().
    const json = serializeHistory(useStore.getState().sessionHistory, HISTORY_BUDGET);
    void setLocalStorage(HISTORY_KEY, json);

    // Speak the persona-specific summary.
    speak(toSpeech(result), {
      rate: state.settings.ttsRate,
      enabled: state.settings.ttsEnabled,
    });
  } catch (err) {
    state.setStreamingResult(null);
    // If this was an abort triggered by cancelAnalysis, the phase is already 'idle'.
    // Don't clobber it with 'error'.
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));
    if (!isAbort) {
      state.setAppPhase('error');
    }
  } finally {
    abortController = null;
  }
}

export function cancelAnalysis(): void {
  // Only transition to idle if we're actually cancelling an in-flight analysis.
  // Without this guard, calling cancelAnalysis while in 'displaying' (e.g., from
  // a UI button) would wipe a freshly-displayed result.
  if (!abortController) return;
  abortController.abort();
  void playCancel();
  const s = useStore.getState();
  s.setStreamingResult(null);
  s.setAppPhase('idle');
}

// --- Internals ---

function base64ToBytes(b64: string): Uint8Array {
  // Expo's global atob exists on RN. For Node test environments, Buffer is available.
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const buf = (globalThis as unknown as { Buffer?: { from: (s: string, e: string) => Uint8Array } }).Buffer;
  return buf ? buf.from(b64, 'base64') : new Uint8Array(0);
}
