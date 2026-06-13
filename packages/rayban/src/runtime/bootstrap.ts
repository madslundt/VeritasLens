/**
 * bootstrap.ts
 *
 * Boot-time hydration of persisted settings (including SecureStore-backed API
 * keys) and wiring of core's settings accessor.
 *
 * Responsibility split
 * ─────────────────────
 * • Zustand store (`useStore.getState().settings`) holds non-secret settings
 *   (models, active lens, TTS rate, …). These are read by the UI layer.
 *
 * • `cachedFullSettings` (module-level closure) holds the complete `Settings`
 *   shape that @veritaslens/core needs — including API keys that are never put
 *   in Zustand. `configureSettings(() => cachedFullSettings)` gives core a live
 *   reference to this closure so every `settings()` call returns the latest
 *   snapshot even after `patchFullSettings` updates it.
 *
 * Call order
 * ──────────
 * App entry-point:
 *   await bootstrap();          // hydrates store + closure + calls configureSettings
 *   // lifecycle.ts startLifecycle() already called by bootstrap() as last step
 */

import {
  configureSettings,
  OPENAI_BASE_URLS,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_AUTO_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_STT_HOST,
  DEFAULT_STT_MODEL,
  DEFAULT_LANGUAGE,
  DEFAULT_BUFFER_DURATION,
  DEFAULT_TRANSCRIPT_MODE,
  DEFAULT_AUTO_MODE_START_MS,
  DEFAULT_AUTO_MODE_SILENCE_MS,
  DEFAULT_AUTO_MODE_INTERVAL_MS,
} from '@veritaslens/core';
import type {
  Settings,
  OpenAiBaseUrl,
  LlmProvider,
  SttHost,
  TranscriptMode,
} from '@veritaslens/core';
import { useStore } from '../state/store';
import type { RaybanSettings } from '../state/store';
import { getLocalStorage } from './bridge-rn';
import { startLifecycle } from './lifecycle';

// ---------------------------------------------------------------------------
// Storage key constants (mirrored from even-g2 so history can be shared)
// ---------------------------------------------------------------------------

const KEY_PROVIDER = 'veritaslens.provider';
const KEY_GEMINI_API_KEY = 'veritaslens.geminiApiKey';
const KEY_GEMINI_MODEL = 'veritaslens.geminiModel';
const KEY_CLAUDE_API_KEY = 'veritaslens.claudeApiKey';
const KEY_CLAUDE_MODEL = 'veritaslens.claudeModel';
const KEY_OPENAI_KEY_PREFIX = 'veritaslens.openaiKey.';
const KEY_OPENAI_BASE_URL = 'veritaslens.openaiBaseUrl';
const KEY_OPENAI_MODEL = 'veritaslens.openaiModel';
const KEY_STT_HOST = 'veritaslens.sttHost';
const KEY_STT_MODEL = 'veritaslens.sttModel';
const KEY_ACTIVE_LENS = 'veritaslens.activeLensId';
const KEY_CAMERA_ENABLED = 'veritaslens.cameraEnabled';
const KEY_TTS_ENABLED = 'veritaslens.ttsEnabled';
const KEY_TTS_RATE = 'veritaslens.ttsRate';
const KEY_BUFFER_DURATION = 'veritaslens.bufferDurationSec';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emptyOpenaiKeys = (): Record<OpenAiBaseUrl, string> =>
  OPENAI_BASE_URLS.reduce((acc, url) => {
    acc[url] = '';
    return acc;
  }, {} as Record<OpenAiBaseUrl, string>);

// ---------------------------------------------------------------------------
// Module-level closure that holds the full settings including API keys.
// configureSettings points core's getter at this reference so updates via
// patchFullSettings are immediately visible to callLensStream etc.
// ---------------------------------------------------------------------------

let cachedFullSettings: Settings = {
  provider: DEFAULT_LLM_PROVIDER,
  geminiApiKey: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  geminiAutoModel: DEFAULT_GEMINI_AUTO_MODEL,
  claudeApiKey: '',
  claudeModel: DEFAULT_CLAUDE_MODEL,
  openaiApiKeys: emptyOpenaiKeys(),
  openaiBaseUrl: DEFAULT_OPENAI_BASE_URL,
  openaiModel: DEFAULT_OPENAI_MODEL,
  openaiTranscribeModels: emptyOpenaiKeys(),
  sttHost: DEFAULT_STT_HOST,
  sttModel: DEFAULT_STT_MODEL,
  responseLanguage: DEFAULT_LANGUAGE,
  bufferDuration: DEFAULT_BUFFER_DURATION,
  autoSummaryEnabled: false,
  crossSessionRecallEnabled: false,
  transcriptMode: DEFAULT_TRANSCRIPT_MODE,
  discreet: false,
  voiceGateRmsFloor: 200,
  voiceTrimEnabled: true,
  autoDisabledLenses: [],
  autoModeEnabled: false,
  autoModeStartMs: DEFAULT_AUTO_MODE_START_MS,
  autoModeSilenceMs: DEFAULT_AUTO_MODE_SILENCE_MS,
  autoModeIntervalMs: DEFAULT_AUTO_MODE_INTERVAL_MS,
  translationSourceLanguages: 'auto',
  translationMode: 'converse',
};

/**
 * Merge a partial `Settings` object into the cached closure. Call this
 * whenever the user saves new API keys from the settings UI so core picks up
 * the change without a full restart.
 */
export function patchFullSettings(partial: Partial<Settings>): void {
  cachedFullSettings = { ...cachedFullSettings, ...partial };
}

// ---------------------------------------------------------------------------
// bootstrap()
// ---------------------------------------------------------------------------

/**
 * Hydrate persisted settings (AsyncStorage + SecureStore) into both:
 *  1. The Zustand store (non-secret fields only)
 *  2. `cachedFullSettings` (all fields including API keys)
 *
 * Then register `cachedFullSettings` as core's settings getter and start the
 * lifecycle (camera + audio + tap listener).
 *
 * Must be called once at app launch, before any lens call fires.
 */
export async function bootstrap(): Promise<void> {
  // --- Read persisted values in parallel ----------------------------------------

  const [
    provider,
    geminiApiKey,
    geminiModel,
    claudeApiKey,
    claudeModel,
    openaiBaseUrl,
    openaiModel,
    sttHost,
    sttModel,
    activeLensId,
    cameraEnabledRaw,
    ttsEnabledRaw,
    ttsRateRaw,
    bufferDurationRaw,
    ...openaiKeyValues
  ] = await Promise.all([
    getLocalStorage(KEY_PROVIDER),
    getLocalStorage(KEY_GEMINI_API_KEY),
    getLocalStorage(KEY_GEMINI_MODEL),
    getLocalStorage(KEY_CLAUDE_API_KEY),
    getLocalStorage(KEY_CLAUDE_MODEL),
    getLocalStorage(KEY_OPENAI_BASE_URL),
    getLocalStorage(KEY_OPENAI_MODEL),
    getLocalStorage(KEY_STT_HOST),
    getLocalStorage(KEY_STT_MODEL),
    getLocalStorage(KEY_ACTIVE_LENS),
    getLocalStorage(KEY_CAMERA_ENABLED),
    getLocalStorage(KEY_TTS_ENABLED),
    getLocalStorage(KEY_TTS_RATE),
    getLocalStorage(KEY_BUFFER_DURATION),
    // Per-host OpenAI API keys — one read per host
    ...OPENAI_BASE_URLS.map((url) => getLocalStorage(`${KEY_OPENAI_KEY_PREFIX}${url}`)),
  ]);

  // --- Build the per-host OpenAI keys record ------------------------------------

  const openaiApiKeys = emptyOpenaiKeys();
  OPENAI_BASE_URLS.forEach((url, i) => {
    const v = openaiKeyValues[i];
    if (v) openaiApiKeys[url] = v;
  });

  // --- Coerce and apply the effective values ------------------------------------

  const effectiveProvider: LlmProvider =
    provider === 'gemini' || provider === 'openai-compatible' || provider === 'claude'
      ? (provider as LlmProvider)
      : DEFAULT_LLM_PROVIDER;

  const effectiveSttHost: SttHost =
    sttHost === 'https://api.openai.com/v1' || sttHost === 'https://api.groq.com/openai/v1'
      ? (sttHost as SttHost)
      : DEFAULT_STT_HOST;

  const effectiveOpenaiBaseUrl: OpenAiBaseUrl =
    openaiBaseUrl && (OPENAI_BASE_URLS as readonly string[]).includes(openaiBaseUrl)
      ? (openaiBaseUrl as OpenAiBaseUrl)
      : DEFAULT_OPENAI_BASE_URL;

  const bufferDurationParsed = Number(bufferDurationRaw ?? '');
  const effectiveBufferDuration: RaybanSettings['bufferDurationSec'] =
    bufferDurationParsed === 30 || bufferDurationParsed === 120 || bufferDurationParsed === 300
      ? bufferDurationParsed
      : 30;

  // --- Hydrate Zustand store (non-secret fields) --------------------------------

  useStore.getState().updateSettings({
    provider: effectiveProvider,
    geminiModel: geminiModel ?? DEFAULT_GEMINI_MODEL,
    claudeModel: claudeModel ?? DEFAULT_CLAUDE_MODEL,
    openaiBaseUrl: effectiveOpenaiBaseUrl,
    openaiModel: openaiModel ?? DEFAULT_OPENAI_MODEL,
    sttHost: effectiveSttHost,
    sttModel: sttModel ?? DEFAULT_STT_MODEL,
    activeLensId: activeLensId ?? 'fact-checker',
    cameraEnabled: cameraEnabledRaw !== 'false',
    ttsEnabled: ttsEnabledRaw !== 'false',
    ttsRate: Number(ttsRateRaw ?? '') || 1.0,
    bufferDurationSec: effectiveBufferDuration,
  });

  // --- Hydrate the full settings closure (includes API keys) --------------------

  const storeSettings = useStore.getState().settings;

  cachedFullSettings = {
    ...cachedFullSettings,
    provider: storeSettings.provider,
    geminiApiKey: geminiApiKey ?? '',
    geminiModel: storeSettings.geminiModel as Settings['geminiModel'],
    claudeApiKey: claudeApiKey ?? '',
    claudeModel: storeSettings.claudeModel as Settings['claudeModel'],
    openaiApiKeys,
    openaiBaseUrl: storeSettings.openaiBaseUrl as Settings['openaiBaseUrl'],
    openaiModel: storeSettings.openaiModel,
    sttHost: storeSettings.sttHost,
    sttModel: storeSettings.sttModel,
  };

  // --- Wire core's settings accessor to the closure ----------------------------
  //
  // This is the single source of truth: lifecycle.ts does NOT call
  // configureSettings — bootstrap is the only caller, ensuring the closure
  // (with API keys) is always in scope.

  configureSettings(() => cachedFullSettings);

  // --- Start the hardware lifecycle --------------------------------------------

  await startLifecycle();
}
