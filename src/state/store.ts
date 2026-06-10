// src/state/store.ts
import { createSignal } from 'solid-js';
import type { DeviceStatus } from '@evenrealities/even_hub_sdk';
import {
  AUTO_MODE_SILENCE_MS_MAX,
  AUTO_MODE_SILENCE_MS_MIN,
  AUTO_MODE_START_MS_MAX,
  AUTO_MODE_START_MS_MIN,
  AUTO_MODE_STEP_MS,
  CLAUDE_MODELS,
  DEFAULT_AUTO_MODE_SILENCE_MS,
  DEFAULT_AUTO_MODE_START_MS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_AUTO_MODEL,
  DEFAULT_LANGUAGE,
  DEFAULT_BUFFER_DURATION,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_STT_HOST,
  DEFAULT_STT_MODEL,
  GEMINI_MODEL_PATTERN,
  LANGUAGES,
  OPENAI_BASE_URLS,
  STT_HOSTS,
  type AppMode,
  type AppPhase,
  type BufferDuration,
  type ClaudeModel,
  type GameDifficulty,
  type GameFormat,
  type GamePreset,
  type GeminiModel,
  type HistoryEntry,
  type LanguageCode,
  type LensPartialResult,
  type LensResult,
  type LlmProvider,
  type MeetingPrepSection,
  type OpenAiBaseUrl,
  type Settings,
  type SttHost,
} from '@/types';

const emptyOpenaiKeys = (): Record<OpenAiBaseUrl, string> =>
  OPENAI_BASE_URLS.reduce((acc, url) => {
    acc[url] = '';
    return acc;
  }, {} as Record<OpenAiBaseUrl, string>);

const SETTINGS_KEY_PROVIDER = 'veritaslens.provider';
const SETTINGS_KEY_GEMINI = 'veritaslens.geminiKey';
const SETTINGS_KEY_MODEL = 'veritaslens.geminiModel';
const SETTINGS_KEY_AUTO_MODEL = 'veritaslens.geminiAutoModel';
const SETTINGS_KEY_CLAUDE_KEY = 'veritaslens.claudeKey';
const SETTINGS_KEY_CLAUDE_MODEL = 'veritaslens.claudeModel';
/** Legacy single-key storage. Read once on load and migrated into the per-host map. */
const SETTINGS_KEY_OPENAI_KEY_LEGACY = 'veritaslens.openaiKey';
/** Per-host OpenAI API key. The host base URL is appended as a suffix. */
const SETTINGS_KEY_OPENAI_KEY_PREFIX = 'veritaslens.openaiKey.';
const openaiKeyStorageKey = (baseUrl: OpenAiBaseUrl): string =>
  `${SETTINGS_KEY_OPENAI_KEY_PREFIX}${baseUrl}`;
/** Per-host override for the `/audio/transcriptions` model. Empty value means
 *  "use the default in OPENAI_TRANSCRIBE_MODELS." */
const SETTINGS_KEY_OPENAI_TRANSCRIBE_PREFIX = 'veritaslens.openaiTranscribeModel.';
const openaiTranscribeStorageKey = (baseUrl: OpenAiBaseUrl): string =>
  `${SETTINGS_KEY_OPENAI_TRANSCRIBE_PREFIX}${baseUrl}`;
const SETTINGS_KEY_OPENAI_BASE_URL = 'veritaslens.openaiBaseUrl';
const SETTINGS_KEY_OPENAI_MODEL = 'veritaslens.openaiModel';
/** STT host used for chat-only providers (DeepSeek, Perplexity). One of `STT_HOSTS`. */
const SETTINGS_KEY_STT_HOST = 'veritaslens.sttHost';
/** Transcription model id on `sttHost`. Empty means "use the first entry of `STT_MODELS_BY_HOST[sttHost]`". */
const SETTINGS_KEY_STT_MODEL = 'veritaslens.sttModel';
const SETTINGS_KEY_LANGUAGE = 'veritaslens.responseLanguage';
const SETTINGS_KEY_BUFFER_DURATION = 'veritaslens.bufferDuration';
const SETTINGS_KEY_AUTO_SUMMARY_ENABLED = 'veritaslens.autoSummaryEnabled';
const SETTINGS_KEY_CROSS_SESSION_RECALL = 'veritaslens.crossSessionRecallEnabled';
const SETTINGS_KEY_TRANSCRIPT_ENABLED = 'veritaslens.transcriptEnabled';
const SETTINGS_KEY_TRANSCRIPT_WIDGET_ENABLED = 'veritaslens.transcriptWidgetEnabled';
const SETTINGS_KEY_DISCREET = 'veritaslens.discreet';
const SETTINGS_KEY_VOICE_GATE_RMS = 'veritaslens.voiceGateRmsFloor';
/** Legacy boolean key read only for one-time migration of pre-slider installs. */
const SETTINGS_KEY_VOICE_GATE_LEGACY = 'veritaslens.voiceGateEnabled';
const SETTINGS_KEY_VOICE_TRIM = 'veritaslens.voiceTrimEnabled';
const SETTINGS_KEY_AUTO_DISABLED_LENSES = 'veritaslens.autoDisabledLenses';
const SETTINGS_KEY_AUTO_MODE_ENABLED = 'veritaslens.autoModeEnabled';
const SETTINGS_KEY_AUTO_MODE_START_MS = 'veritaslens.autoModeStartMs';
const SETTINGS_KEY_AUTO_MODE_SILENCE_MS = 'veritaslens.autoModeSilenceMs';
const SETTINGS_KEY_TRANSLATION_SOURCE_LANGS = 'veritaslens.translationSourceLanguages';
const SETTINGS_KEY_TRANSLATION_MODE = 'veritaslens.translationMode';
/** Default RMS floor when neither the new nor legacy key is set. */
const DEFAULT_VOICE_GATE_RMS_FLOOR = 200;
/** Slider granularity exposed in the Settings UI. */
export const VOICE_GATE_RMS_STEP = 50;
/** UI clamp for the slider's upper end; above this is shouting territory. */
export const VOICE_GATE_RMS_MAX = 1000;

/** Parse a persisted auto-mode threshold (in ms), snap to step, and clamp to
 *  the published [min, max] range. Falls back to `fallback` on empty/invalid. */
function coerceAutoModeMs(raw: string, fallback: number, min: number, max: number): number {
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const snapped = Math.round(n / AUTO_MODE_STEP_MS) * AUTO_MODE_STEP_MS;
  return Math.min(max, Math.max(min, snapped));
}

function coerceVoiceGateRmsFloor(raw: string, legacy: string): number {
  // New key wins when present and parseable.
  if (raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      // Snap to step + clamp so a hand-edited storage value can't poison the UI.
      const snapped = Math.round(n / VOICE_GATE_RMS_STEP) * VOICE_GATE_RMS_STEP;
      return Math.min(VOICE_GATE_RMS_MAX, Math.max(0, snapped));
    }
  }
  // Migrate from the legacy boolean: explicit `false` → off (0); anything
  // else (true, missing) → historical default 200.
  if (legacy === 'false') return 0;
  return DEFAULT_VOICE_GATE_RMS_FLOOR;
}

const HISTORY_KEY = 'veritaslens.history';
const HISTORY_BYTE_BUDGET = 400 * 1024;
const HISTORY_MAX_ENTRIES = 500;

const GAME_PRESETS_KEY = 'veritaslens.gamePresets';
/** Hard cap on persisted presets. Glasses picker scrolls but a saner limit
 *  keeps the games sub-picker from becoming unusable on the small display. */
const GAME_PRESETS_MAX = 30;
const GAME_FORMATS: readonly GameFormat[] = ['quiz-mc', 'true-false', 'riddle'];
const GAME_DIFFICULTIES: readonly GameDifficulty[] = ['easy', 'medium', 'hard'];

const MEETING_PREP_KEY = 'veritaslens.meetingPrep';
/** Total UTF-8 byte cap for the meeting-prep payload (label+body across all sections). */
export const MEETING_PREP_BYTE_BUDGET = 50 * 1024;
/** Per-label character cap, applied at write time. */
export const MEETING_PREP_LABEL_MAX = 80;

export const [appMode, setAppMode] = createSignal<AppMode>('settings');
export const [appPhase, setAppPhase] = createSignal<AppPhase>('booting');
export const [availableModels, setAvailableModels] = createSignal<string[]>([DEFAULT_GEMINI_MODEL]);
export const [modelsLoading, setModelsLoading] = createSignal<boolean>(false);
export const [activePersona, setActivePersona] = createSignal<string>('fact-checker');
export const [lensResult, setLensResult] = createSignal<LensResult | null>(null);
/**
 * Partial lens result published as Gemini streams its response. Reset to
 * `null` at the start of every analyze and again when the full `lensResult`
 * lands — so a reactive consumer can use a single `lensPartialResult() ??
 * lensResult()` lookup to pick whichever is current.
 */
export const [lensPartialResult, setLensPartialResult] = createSignal<LensPartialResult | null>(null);
export const [deviceStatus, setDeviceStatus] = createSignal<DeviceStatus | null>(null);
export const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
export const [sessionHistory, setSessionHistory] = createSignal<HistoryEntry[]>([]);
export const [meetingPrepSections, setMeetingPrepSectionsSignal] = createSignal<MeetingPrepSection[]>([]);
export const [gamePresets, setGamePresetsSignal] = createSignal<GamePreset[]>([]);

const [settings, setSettings] = createSignal<Settings>({
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
  transcriptEnabled: true,
  transcriptWidgetEnabled: false,
  discreet: false,
  // VAD gate defaults to the historical RMS floor (200 int16 units). 0
  // disables the gate entirely; lower values are more permissive. Exposed
  // as a step-50 slider in Settings so users with quiet/noisy environments
  // can self-tune without code changes.
  voiceGateRmsFloor: DEFAULT_VOICE_GATE_RMS_FLOOR,
  // VAD-based payload trimming defaults ON: shrinks the WAV to just the
  // detected speech, cutting upload + ingest time on sparse buffers.
  voiceTrimEnabled: true,
  autoDisabledLenses: [],
  // Auto-mode VAD: off by default; user opts in from Settings. Thresholds
  // default to a snappy-but-not-twitchy 1.5 s arm / 2 s silence trigger.
  autoModeEnabled: false,
  autoModeStartMs: DEFAULT_AUTO_MODE_START_MS,
  autoModeSilenceMs: DEFAULT_AUTO_MODE_SILENCE_MS,
  // Default to auto-detect so the Translate lens works for any conversation
  // without configuration; the user can pin a subset from Settings later.
  translationSourceLanguages: 'auto',
  // Default to converse mode so picking the lens for the first time gives the
  // full UX (reply starters); the wearer can switch to listen-in from the
  // Settings → Translate section when they want passive eavesdropping.
  translationMode: 'converse',
});
export { settings };

export async function loadSettings(getLocalStorage: (k: string) => Promise<string>): Promise<void> {
  // Read each key independently so a single failed/corrupt entry doesn't wipe
  // the rest. The coerce* helpers already tolerate null / unknown values.
  const safeGet = async (k: string): Promise<string> => {
    try { return await getLocalStorage(k); } catch { return ''; }
  };
  const perHostKeyReads = OPENAI_BASE_URLS.map((u) =>
    safeGet(openaiKeyStorageKey(u)).then((v) => [u, v] as const),
  );
  const perHostTranscribeReads = OPENAI_BASE_URLS.map((u) =>
    safeGet(openaiTranscribeStorageKey(u)).then((v) => [u, v] as const),
  );
  const [fixedReads, perHostKeys, perHostTranscribe] = await Promise.all([
    Promise.all([
      safeGet(SETTINGS_KEY_PROVIDER),
      safeGet(SETTINGS_KEY_GEMINI),
      safeGet(SETTINGS_KEY_MODEL),
      safeGet(SETTINGS_KEY_AUTO_MODEL),
      safeGet(SETTINGS_KEY_CLAUDE_KEY),
      safeGet(SETTINGS_KEY_CLAUDE_MODEL),
      safeGet(SETTINGS_KEY_OPENAI_KEY_LEGACY),
      safeGet(SETTINGS_KEY_OPENAI_BASE_URL),
      safeGet(SETTINGS_KEY_OPENAI_MODEL),
      safeGet(SETTINGS_KEY_LANGUAGE),
      safeGet(SETTINGS_KEY_BUFFER_DURATION),
      safeGet(SETTINGS_KEY_AUTO_SUMMARY_ENABLED),
      safeGet(SETTINGS_KEY_CROSS_SESSION_RECALL),
      safeGet(SETTINGS_KEY_DISCREET),
      safeGet(SETTINGS_KEY_VOICE_GATE_RMS),
      safeGet(SETTINGS_KEY_VOICE_GATE_LEGACY),
      safeGet(SETTINGS_KEY_VOICE_TRIM),
      safeGet(SETTINGS_KEY_AUTO_DISABLED_LENSES),
      safeGet(SETTINGS_KEY_STT_HOST),
      safeGet(SETTINGS_KEY_STT_MODEL),
      safeGet(SETTINGS_KEY_AUTO_MODE_ENABLED),
      safeGet(SETTINGS_KEY_AUTO_MODE_START_MS),
      safeGet(SETTINGS_KEY_AUTO_MODE_SILENCE_MS),
      safeGet(SETTINGS_KEY_TRANSLATION_SOURCE_LANGS),
      safeGet(SETTINGS_KEY_TRANSLATION_MODE),
      safeGet(SETTINGS_KEY_TRANSCRIPT_ENABLED),
      safeGet(SETTINGS_KEY_TRANSCRIPT_WIDGET_ENABLED),
    ]),
    Promise.all(perHostKeyReads),
    Promise.all(perHostTranscribeReads),
  ]);
  const [
    rawProvider,
    key,
    rawModel,
    rawAutoModel,
    rawClaudeKey,
    rawClaudeModel,
    rawLegacyOpenaiKey,
    rawOpenaiBaseUrl,
    rawOpenaiModel,
    rawLang,
    rawBuffer,
    rawAutoEnabled,
    rawCrossSessionRecall,
    rawDiscreet,
    rawVoiceGateRms,
    rawVoiceGateLegacy,
    rawVoiceTrim,
    rawAutoDisabledLenses,
    rawSttHost,
    rawSttModel,
    rawAutoModeEnabled,
    rawAutoModeStartMs,
    rawAutoModeSilenceMs,
    rawTranslationSourceLangs,
    rawTranslationMode,
    rawTranscriptEnabled,
    rawTranscriptWidgetEnabled,
  ] = fixedReads;
  // Build the per-host key map. If no per-host key exists for the host that
  // was last active, fall back to the legacy single-key storage so users who
  // upgrade from a pre-per-host build don't lose their saved credential.
  const coercedBaseUrl = coerceOpenaiBaseUrl(rawOpenaiBaseUrl);
  const openaiApiKeys = emptyOpenaiKeys();
  for (const entry of perHostKeys) {
    const [url, value] = entry as readonly [OpenAiBaseUrl, string];
    if (value) openaiApiKeys[url] = value;
  }
  if (!openaiApiKeys[coercedBaseUrl] && rawLegacyOpenaiKey) {
    openaiApiKeys[coercedBaseUrl] = rawLegacyOpenaiKey;
  }
  const openaiTranscribeModels = emptyOpenaiKeys();
  for (const entry of perHostTranscribe) {
    const [url, value] = entry as readonly [OpenAiBaseUrl, string];
    if (value) openaiTranscribeModels[url] = value;
  }
  setSettings({
    provider: coerceProvider(rawProvider),
    geminiApiKey: key,
    geminiModel: coerceModel(rawModel),
    geminiAutoModel: coerceAutoModel(rawAutoModel),
    claudeApiKey: rawClaudeKey,
    claudeModel: coerceClaudeModel(rawClaudeModel),
    openaiApiKeys,
    openaiBaseUrl: coercedBaseUrl,
    openaiModel: rawOpenaiModel || DEFAULT_OPENAI_MODEL,
    openaiTranscribeModels,
    sttHost: coerceSttHost(rawSttHost),
    sttModel: rawSttModel || DEFAULT_STT_MODEL,
    responseLanguage: coerceLanguage(rawLang),
    bufferDuration: coerceBufferDuration(rawBuffer),
    autoSummaryEnabled: rawAutoEnabled === 'true',
    crossSessionRecallEnabled: rawCrossSessionRecall === 'true',
    // Default ON — unwritten storage returns '', which lands here as true so
    // existing installs get the transcript feature on their next reload. The
    // user explicitly opts out by saving 'false'.
    transcriptEnabled: rawTranscriptEnabled !== 'false',
    // Opt-in verification affordance — defaults OFF so existing installs
    // never see an unexpected flash. User explicitly enables to confirm
    // captures during testing.
    transcriptWidgetEnabled: rawTranscriptWidgetEnabled === 'true',
    discreet: rawDiscreet === 'true',
    voiceGateRmsFloor: coerceVoiceGateRmsFloor(rawVoiceGateRms, rawVoiceGateLegacy),
    voiceTrimEnabled: rawVoiceTrim === '' ? true : rawVoiceTrim !== 'false',
    autoDisabledLenses: coerceAutoDisabledLenses(rawAutoDisabledLenses),
    autoModeEnabled: rawAutoModeEnabled === 'true',
    autoModeStartMs: coerceAutoModeMs(
      rawAutoModeStartMs,
      DEFAULT_AUTO_MODE_START_MS,
      AUTO_MODE_START_MS_MIN,
      AUTO_MODE_START_MS_MAX,
    ),
    autoModeSilenceMs: coerceAutoModeMs(
      rawAutoModeSilenceMs,
      DEFAULT_AUTO_MODE_SILENCE_MS,
      AUTO_MODE_SILENCE_MS_MIN,
      AUTO_MODE_SILENCE_MS_MAX,
    ),
    translationSourceLanguages: coerceTranslationSourceLanguages(rawTranslationSourceLangs),
    translationMode: coerceTranslationMode(rawTranslationMode),
  });
}

function coerceTranslationMode(raw: string): 'converse' | 'listen-in' {
  // Conservative default: anything we don't recognise becomes 'converse' so a
  // corrupt KV blob never silently strips reply starters out of the lens.
  return raw === 'listen-in' ? 'listen-in' : 'converse';
}

function coerceTranslationSourceLanguages(raw: string): LanguageCode[] | 'auto' {
  // Persisted as either the literal 'auto' or a JSON array of LanguageCode
  // strings. Anything unparseable / unknown falls back to 'auto' so a corrupt
  // KV blob never wedges the Translate lens.
  if (!raw || raw === 'auto') return 'auto';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return 'auto';
    const codes = parsed.filter(
      (x): x is LanguageCode => typeof x === 'string' && x in LANGUAGES,
    );
    return codes.length === 0 ? 'auto' : codes;
  } catch {
    return 'auto';
  }
}

export async function saveTranslationSourceLanguages(
  setLs: SetLs,
  value: LanguageCode[] | 'auto',
): Promise<boolean> {
  const serialized = value === 'auto' ? 'auto' : JSON.stringify(value);
  const ok = await setLs(SETTINGS_KEY_TRANSLATION_SOURCE_LANGS, serialized);
  if (ok) setSettings({ ...settings(), translationSourceLanguages: value });
  return ok;
}

export async function saveTranslationMode(
  setLs: SetLs,
  value: 'converse' | 'listen-in',
): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_TRANSLATION_MODE, value);
  if (ok) setSettings({ ...settings(), translationMode: value });
  return ok;
}

type SetLs = (k: string, v: string) => Promise<boolean>;

async function saveSetting<K extends keyof Settings>(
  setLs: SetLs,
  storageKey: string,
  field: K,
  value: Settings[K],
): Promise<boolean> {
  const ok = await setLs(storageKey, String(value));
  if (ok) setSettings({ ...settings(), [field]: value });
  return ok;
}

export const saveProvider = (setLs: SetLs, provider: LlmProvider): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_PROVIDER, 'provider', provider);

export const saveGeminiKey = (setLs: SetLs, key: string): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_GEMINI, 'geminiApiKey', key);

export const saveGeminiModel = (setLs: SetLs, model: GeminiModel): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_MODEL, 'geminiModel', model);

export const saveClaudeKey = (setLs: SetLs, key: string): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_CLAUDE_KEY, 'claudeApiKey', key);

export const saveClaudeModel = (setLs: SetLs, model: ClaudeModel): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_CLAUDE_MODEL, 'claudeModel', model);

export async function saveGeminiAutoModel(
  setLs: SetLs,
  model: GeminiModel | null,
): Promise<boolean> {
  // Persist `null` as an empty string so loadSettings round-trips it back to
  // null via coerceAutoModel. `String(null)` would write the literal "null".
  const ok = await setLs(SETTINGS_KEY_AUTO_MODEL, model ?? '');
  if (ok) setSettings({ ...settings(), geminiAutoModel: model });
  return ok;
}

/**
 * Persist all per-host OpenAI keys. Writes the storage entry for each host
 * (so a user who entered a key on multiple hosts has all of them saved at
 * once when they hit Save), then updates the in-memory map.
 */
export async function saveOpenaiKeys(
  setLs: SetLs,
  keys: Record<OpenAiBaseUrl, string>,
): Promise<boolean> {
  const writes = await Promise.all(
    OPENAI_BASE_URLS.map((u) => setLs(openaiKeyStorageKey(u), keys[u] ?? '')),
  );
  const ok = writes.every(Boolean);
  if (ok) setSettings({ ...settings(), openaiApiKeys: { ...keys } });
  return ok;
}

export const saveOpenaiBaseUrl = (setLs: SetLs, url: OpenAiBaseUrl): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_OPENAI_BASE_URL, 'openaiBaseUrl', url);

export const saveOpenaiModel = (setLs: SetLs, model: string): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_OPENAI_MODEL, 'openaiModel', model);

export const saveSttHost = (setLs: SetLs, host: SttHost): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_STT_HOST, 'sttHost', host);

export const saveSttModel = (setLs: SetLs, model: string): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_STT_MODEL, 'sttModel', model);

/**
 * Persist all per-host transcription model overrides at once. Empty values
 * are written through (the runtime treats `''` as "use the default in
 * `OPENAI_TRANSCRIBE_MODELS`"), so clearing a custom value sticks.
 */
export async function saveOpenaiTranscribeModels(
  setLs: SetLs,
  models: Record<OpenAiBaseUrl, string>,
): Promise<boolean> {
  const writes = await Promise.all(
    OPENAI_BASE_URLS.map((u) => setLs(openaiTranscribeStorageKey(u), models[u] ?? '')),
  );
  const ok = writes.every(Boolean);
  if (ok) setSettings({ ...settings(), openaiTranscribeModels: { ...models } });
  return ok;
}

export const saveResponseLanguage = (setLs: SetLs, language: LanguageCode): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_LANGUAGE, 'responseLanguage', language);

export const saveBufferDuration = (setLs: SetLs, duration: BufferDuration): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_BUFFER_DURATION, 'bufferDuration', duration);

export const saveAutoSummaryEnabled = (setLs: SetLs, enabled: boolean): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_AUTO_SUMMARY_ENABLED, 'autoSummaryEnabled', enabled);

export const saveCrossSessionRecallEnabled = (setLs: SetLs, enabled: boolean): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_CROSS_SESSION_RECALL, 'crossSessionRecallEnabled', enabled);

export const saveTranscriptEnabled = (setLs: SetLs, enabled: boolean): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_TRANSCRIPT_ENABLED, 'transcriptEnabled', enabled);

export const saveTranscriptWidgetEnabled = (setLs: SetLs, enabled: boolean): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_TRANSCRIPT_WIDGET_ENABLED, 'transcriptWidgetEnabled', enabled);

export async function saveVoiceGateRmsFloor(setLs: SetLs, floor: number): Promise<boolean> {
  // Snap + clamp before persisting so we never write a value the UI couldn't
  // render. `String(floor)` would otherwise round-trip e.g. `175` and the
  // slider would land between stops on the next load.
  const snapped = Math.round(floor / VOICE_GATE_RMS_STEP) * VOICE_GATE_RMS_STEP;
  const clamped = Math.min(VOICE_GATE_RMS_MAX, Math.max(0, snapped));
  return saveSetting(setLs, SETTINGS_KEY_VOICE_GATE_RMS, 'voiceGateRmsFloor', clamped);
}

export const saveVoiceTrimEnabled = (setLs: SetLs, enabled: boolean): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_VOICE_TRIM, 'voiceTrimEnabled', enabled);

export const saveAutoModeEnabled = (setLs: SetLs, enabled: boolean): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_AUTO_MODE_ENABLED, 'autoModeEnabled', enabled);

export async function saveAutoModeStartMs(setLs: SetLs, ms: number): Promise<boolean> {
  const snapped = Math.round(ms / AUTO_MODE_STEP_MS) * AUTO_MODE_STEP_MS;
  const clamped = Math.min(AUTO_MODE_START_MS_MAX, Math.max(AUTO_MODE_START_MS_MIN, snapped));
  return saveSetting(setLs, SETTINGS_KEY_AUTO_MODE_START_MS, 'autoModeStartMs', clamped);
}

export async function saveAutoModeSilenceMs(setLs: SetLs, ms: number): Promise<boolean> {
  const snapped = Math.round(ms / AUTO_MODE_STEP_MS) * AUTO_MODE_STEP_MS;
  const clamped = Math.min(AUTO_MODE_SILENCE_MS_MAX, Math.max(AUTO_MODE_SILENCE_MS_MIN, snapped));
  return saveSetting(setLs, SETTINGS_KEY_AUTO_MODE_SILENCE_MS, 'autoModeSilenceMs', clamped);
}

// Re-export the thresholds + step so SettingsView can render a consistent
// slider without hard-coding magic numbers.
export {
  AUTO_MODE_SILENCE_MS_MAX,
  AUTO_MODE_SILENCE_MS_MIN,
  AUTO_MODE_START_MS_MAX,
  AUTO_MODE_START_MS_MIN,
  AUTO_MODE_STEP_MS,
};

export async function saveAutoDisabledLenses(setLs: SetLs, ids: string[]): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_AUTO_DISABLED_LENSES, JSON.stringify(ids));
  if (ok) setSettings({ ...settings(), autoDisabledLenses: ids });
  return ok;
}

export const saveDiscreet = (setLs: SetLs, discreet: boolean): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_DISCREET, 'discreet', discreet);

export async function loadHistory(getLocalStorage: (k: string) => Promise<string>): Promise<void> {
  try {
    const raw = await getLocalStorage(HISTORY_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const migrated: HistoryEntry[] = [];
    for (const entry of parsed) {
      const ok = migrateEntry(entry);
      if (ok) migrated.push(ok);
    }
    setSessionHistory(migrated);
  } catch (err) {
    // corrupt or missing — start fresh, but surface the failure in the debug
    // log so a wedged KV (or a JSON.parse exception on user data) is visible
    // in the settings debug panel rather than silently dropping all history.
    pushDebugEvent({
      label: 'history-load-fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Migrate a persisted history entry to the multi-claim shape. Older builds
 * stored claim-shaped lens results flat (e.g. fact-check had top-level
 * verdict/claim/reason); wrap them into a single-element `claims` array with
 * an empty `quote`. Answer-shaped results gain an optional `quote` field —
 * fill missing values with ''. Entries that can't be migrated are dropped.
 */
function migrateEntry(raw: unknown): HistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const result = e['result'];
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const type = r['type'];
  if (typeof type !== 'string') return null;

  const wrap = (item: Record<string, unknown>): unknown[] => [{ quote: '', ...item }];

  let migratedResult: Record<string, unknown> | null = null;
  switch (type) {
    case 'fact-check':
      migratedResult = Array.isArray(r['claims'])
        ? r
        : { type, claims: wrap({ verdict: r['verdict'], claim: r['claim'], reason: r['reason'] }), autoSelected: r['autoSelected'] };
      break;
    case 'stats-check':
      migratedResult = Array.isArray(r['claims'])
        ? r
        : { type, claims: wrap({ verdict: r['verdict'], stat: r['stat'], reason: r['reason'] }), autoSelected: r['autoSelected'] };
      break;
    case 'logical-fallacy':
      migratedResult = Array.isArray(r['claims'])
        ? r
        : { type, claims: wrap({ fallacy: r['fallacy'], explanation: r['explanation'] }), autoSelected: r['autoSelected'] };
      break;
    case 'bias':
      migratedResult = Array.isArray(r['claims'])
        ? r
        : { type, claims: wrap({ verdict: r['verdict'], direction: r['direction'], reason: r['reason'] }), autoSelected: r['autoSelected'] };
      break;
    case 'trivia':
      migratedResult = Array.isArray(r['claims'])
        ? r
        : { type, claims: wrap({ question: r['question'], answer: r['answer'], description: r['description'] }), autoSelected: r['autoSelected'] };
      break;
    case 'eli5':
      migratedResult = Array.isArray(r['claims'])
        ? r
        : { type, claims: wrap({ explanation: r['explanation'] }), autoSelected: r['autoSelected'] };
      break;
    case 'session-summary': {
      const existingTitle = typeof r['title'] === 'string' ? r['title'].trim() : '';
      migratedResult = { quote: '', ...r, title: existingTitle.length > 0 ? existingTitle : 'Summary of conversation' };
      break;
    }
    case 'meeting-prep':
      // No legacy shape exists for meeting-prep; require the claims array.
      if (!Array.isArray(r['claims'])) return null;
      migratedResult = r;
      break;
    case 'devils-advocate':
    case 'key-questions':
    case 'sentiment':
      if (!Array.isArray(r['claims'])) return null;
      migratedResult = r;
      break;
    case 'translation':
      // No legacy shape exists for translation; require the new fields.
      if (typeof r['sourceText'] !== 'string' || typeof r['translatedText'] !== 'string') return null;
      migratedResult = r;
      break;
    default:
      return null;
  }

  return {
    id: String(e['id'] ?? `${Date.now()}-mig`),
    sessionId: String(e['sessionId'] ?? ''),
    timestamp: typeof e['timestamp'] === 'number' ? e['timestamp'] : Date.now(),
    lensId: String(e['lensId'] ?? ''),
    lensName: String(e['lensName'] ?? ''),
    question: String(e['question'] ?? ''),
    badge: String(e['badge'] ?? ''),
    quote: typeof e['quote'] === 'string' ? e['quote'] : '',
    result: migratedResult as HistoryEntry['result'],
  };
}

async function persistHistory(
  setLs: (k: string, v: string) => Promise<boolean>,
  entries: HistoryEntry[]
): Promise<void> {
  let json = JSON.stringify(entries);
  // Compare against UTF-8 byte length, not `.length` (UTF-16 code units), so
  // non-ASCII summaries (Dansk, Norsk, Deutsch) can't sneak past the cap —
  // some characters cost 2-3 bytes but only one code unit each.
  let bytes = utf8ByteLength(json);
  if (bytes > HISTORY_BYTE_BUDGET && entries.length > 0) {
    // Two-shot trim, total ≤3 stringify calls per persist write:
    //   call 1: full entries (above)
    //   call 2: ratio-based estimate using avg bytes/entry of the full list
    //   call 3: if still over, re-estimate from the trimmed list's actual
    //           avg (tail entries can be larger than the full-list avg)
    // A 0.85 safety factor on each pass absorbs estimation error from
    // uneven entry sizes; a single-entry-over-budget is preserved as-is
    // (losing it would discard the answer the user just received).
    const SAFETY = 0.85;
    const estimateKeep = (totalBytes: number, count: number): number => {
      const avg = totalBytes / count;
      return Math.max(1, Math.floor((HISTORY_BYTE_BUDGET / avg) * SAFETY));
    };
    let keep = estimateKeep(bytes, entries.length);
    let trimmed = entries.slice(-keep);
    json = JSON.stringify(trimmed);
    bytes = utf8ByteLength(json);
    if (bytes > HISTORY_BYTE_BUDGET && trimmed.length > 1) {
      const next = estimateKeep(bytes, trimmed.length);
      // Ensure forward progress even if the new estimate ≥ current length
      // (can happen on extreme tail-skew where avg jumps each pass).
      keep = Math.max(1, Math.min(next, trimmed.length - 1));
      trimmed = trimmed.slice(-keep);
      json = JSON.stringify(trimmed);
      bytes = utf8ByteLength(json);
    }
    if (bytes > HISTORY_BYTE_BUDGET) {
      pushDebugEvent({
        label: 'history-oversized-entry',
        detail: `single entry ${Math.round(bytes / 1024)}KB exceeds ${Math.round(HISTORY_BYTE_BUDGET / 1024)}KB cap`,
      });
    }
  }
  await setLs(HISTORY_KEY, json);
}

/**
 * Push a completed analysis result into session history and persist it.
 * Returns a promise that resolves once persistence is done, so callers that
 * need to reload history from storage (e.g. to surface entries written by a
 * sibling WebView context) can await the write first.
 */
export async function pushHistoryEntry(
  entry: Omit<HistoryEntry, 'id' | 'timestamp'>,
  setLs?: (k: string, v: string) => Promise<boolean>
): Promise<string> {
  const [id] = await pushHistoryEntries([entry], setLs);
  return id ?? '';
}

/**
 * Atomically append several entries in one read-modify-write of the signal
 * and one persistHistory call. Lets multi-claim analyses persist N entries
 * without N racing local-storage writes — out-of-order resolves between
 * concurrent persist calls would otherwise let an earlier (shorter) write
 * overwrite a later (complete) one and silently drop claims.
 *
 * Returns the ids of the just-pushed entries in input order. Callers use
 * these to identify which entries belong to the latest analysis (for the
 * session-wide swipe scroll's latestAnalysisRange).
 */
export async function pushHistoryEntries(
  entries: Array<Omit<HistoryEntry, 'id' | 'timestamp'>>,
  setLs?: (k: string, v: string) => Promise<boolean>
): Promise<string[]> {
  if (entries.length === 0) return [];
  const ts = Date.now();
  const fresh: HistoryEntry[] = entries.map((e, i) => ({
    id: `${ts}-${i}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: ts,
    ...e,
  }));
  const next: HistoryEntry[] = [...sessionHistory(), ...fresh].slice(-HISTORY_MAX_ENTRIES);
  setSessionHistory(next);
  if (setLs) await persistHistory(setLs, next);
  return fresh.map((e) => e.id);
}

export function clearSessionHistory(setLs?: (k: string, v: string) => Promise<boolean>): void {
  setSessionHistory([]);
  if (setLs) void setLs(HISTORY_KEY, '[]');
}

/**
 * Drop every history entry sharing `sessionId` and persist the trimmed list.
 * Re-uses `persistHistory` so the byte-budget logic stays applied (a delete
 * followed by another append still settles inside the cap).
 */
export async function deleteHistorySession(
  sessionId: string,
  setLs?: (k: string, v: string) => Promise<boolean>,
): Promise<void> {
  const next = sessionHistory().filter((e) => e.sessionId !== sessionId);
  setSessionHistory(next);
  if (setLs) await persistHistory(setLs, next);
}

function coerceModel(raw: string | null | undefined): GeminiModel {
  if (raw && GEMINI_MODEL_PATTERN.test(raw)) return raw as GeminiModel;
  return DEFAULT_GEMINI_MODEL;
}

function coerceAutoModel(raw: string | null | undefined): GeminiModel | null {
  if (raw && GEMINI_MODEL_PATTERN.test(raw)) return raw as GeminiModel;
  return DEFAULT_GEMINI_AUTO_MODEL;
}

function coerceLanguage(raw: string | null | undefined): LanguageCode {
  if (raw && raw in LANGUAGES) return raw as LanguageCode;
  return DEFAULT_LANGUAGE;
}

function coerceBufferDuration(raw: string | null | undefined): BufferDuration {
  const n = Number(raw);
  if (n === 30 || n === 120 || n === 300) return n;
  // Back-compat: 0.6.x persisted 600 (10 min); clamp to the new 5-min cap.
  if (n === 600) return 300;
  return DEFAULT_BUFFER_DURATION;
}

function coerceProvider(raw: string | null | undefined): LlmProvider {
  if (raw === 'gemini' || raw === 'openai-compatible' || raw === 'claude') return raw;
  return DEFAULT_LLM_PROVIDER;
}

function coerceClaudeModel(raw: string | null | undefined): ClaudeModel {
  if (raw && (CLAUDE_MODELS as readonly string[]).includes(raw)) {
    return raw as ClaudeModel;
  }
  return DEFAULT_CLAUDE_MODEL;
}

function coerceOpenaiBaseUrl(raw: string | null | undefined): OpenAiBaseUrl {
  if (raw && (OPENAI_BASE_URLS as readonly string[]).includes(raw)) {
    return raw as OpenAiBaseUrl;
  }
  return DEFAULT_OPENAI_BASE_URL;
}

function coerceSttHost(raw: string | null | undefined): SttHost {
  if (raw && (STT_HOSTS as readonly string[]).includes(raw)) {
    return raw as SttHost;
  }
  return DEFAULT_STT_HOST;
}

function coerceAutoDisabledLenses(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ---------- Game presets ----------

/**
 * Load persisted game presets. Tolerates missing or corrupt blobs — falls
 * back to an empty list rather than throwing. Drops entries that fail to
 * normalize so a single bad row can't poison the whole list.
 */
export async function loadGamePresets(
  getLocalStorage: (k: string) => Promise<string>,
): Promise<void> {
  try {
    const raw = await getLocalStorage(GAME_PRESETS_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const presets: GamePreset[] = [];
    for (const entry of parsed) {
      const normalized = normalizeGamePreset(entry);
      if (normalized) presets.push(normalized);
    }
    setGamePresetsSignal(presets.slice(0, GAME_PRESETS_MAX));
  } catch (err) {
    pushDebugEvent({
      label: 'game-presets-load-fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Persist the full preset list. Returns false if the underlying KV write
 * failed; on success replaces the in-memory signal so the HUD sees the
 * change immediately.
 */
export async function saveGamePresets(
  setLs: SetLs,
  presets: GamePreset[],
): Promise<boolean> {
  const trimmed = presets.slice(0, GAME_PRESETS_MAX);
  const ok = await setLs(GAME_PRESETS_KEY, JSON.stringify(trimmed));
  if (ok) setGamePresetsSignal(trimmed);
  return ok;
}

function normalizeGamePreset(raw: unknown): GamePreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' && r['id'].length > 0 ? r['id'] : newGamePresetId();
  const format = (GAME_FORMATS as readonly string[]).includes(r['format'] as string)
    ? (r['format'] as GameFormat)
    : null;
  if (!format) return null;
  const topic = typeof r['topic'] === 'string' ? r['topic'].slice(0, 200).trim() : '';
  if (!topic) return null;
  const difficulty = (GAME_DIFFICULTIES as readonly string[]).includes(r['difficulty'] as string)
    ? (r['difficulty'] as GameDifficulty)
    : 'medium';
  const saveToHistory = r['saveToHistory'] !== false;
  // Per-preset language override; missing / unknown codes fall back to
  // `null` so the runtime resolves to `settings.responseLanguage`.
  const rawLang = r['language'];
  const language: LanguageCode | null =
    typeof rawLang === 'string' && rawLang in LANGUAGES
      ? (rawLang as LanguageCode)
      : null;
  return { id, format, topic, difficulty, saveToHistory, language };
}

export function newGamePresetId(): string {
  return `gp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Cap exported for UI gating ("max N presets" footer). */
export const GAME_PRESETS_CAP = GAME_PRESETS_MAX;

// ---------- Meeting Prep context ----------

/**
 * Load the persisted meeting-prep sections. Tolerates a missing or corrupt
 * blob — falls back to an empty list rather than throwing.
 */
export async function loadMeetingPrepSections(
  getLocalStorage: (k: string) => Promise<string>,
): Promise<void> {
  try {
    const raw = await getLocalStorage(MEETING_PREP_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    // Older builds wrote sibling `goal` / `role` keys on this blob; those are
    // ignored here. Reading only `sections` keeps existing payloads working
    // without a migration step.
    const sectionsRaw = (parsed as Record<string, unknown>)['sections'];
    if (!Array.isArray(sectionsRaw)) return;
    const sections: MeetingPrepSection[] = [];
    for (const s of sectionsRaw) {
      if (!s || typeof s !== 'object') continue;
      const rec = s as Record<string, unknown>;
      const id = typeof rec['id'] === 'string' && rec['id'] ? rec['id'] : newSectionId();
      const label = typeof rec['label'] === 'string' ? rec['label'] : '';
      const body = typeof rec['body'] === 'string' ? rec['body'] : '';
      sections.push({ id, label, body });
    }
    setMeetingPrepSectionsSignal(sections);
  } catch (err) {
    // Same rationale as loadHistory above: surface the failure so a wedged KV
    // isn't an invisible blank-meeting-prep regression.
    pushDebugEvent({
      label: 'meeting-prep-load-fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Persist meeting-prep sections. Returns `{ ok }` and an error when the
 * payload exceeds the byte budget — the UI shows the message inline so the
 * user can shrink content rather than silently losing edits. Trims labels
 * to MEETING_PREP_LABEL_MAX on write.
 */
export async function saveMeetingPrepSections(
  setLs: SetLs,
  sections: MeetingPrepSection[],
): Promise<{ ok: boolean; error?: string }> {
  const normalized: MeetingPrepSection[] = sections.map((s, i) => ({
    id: s.id || newSectionId(),
    // Section 0 is the general-context slot — unlabeled by convention so it
    // never appears as a citable source. Force-clear any stale label that
    // might have been carried over from an older shape.
    label: i === 0 ? '' : s.label.slice(0, MEETING_PREP_LABEL_MAX),
    body: s.body,
  }));
  const payload = JSON.stringify({ sections: normalized });
  const bytes = utf8ByteLength(payload);
  if (bytes > MEETING_PREP_BYTE_BUDGET) {
    return {
      ok: false,
      error: `Too much text (${Math.round(bytes / 1024)} KB). Limit is ${Math.round(
        MEETING_PREP_BYTE_BUDGET / 1024,
      )} KB.`,
    };
  }
  const ok = await setLs(MEETING_PREP_KEY, payload);
  if (ok) setMeetingPrepSectionsSignal(normalized);
  return { ok };
}

/** True when at least one section has a non-empty body — required for the lens to run. */
export function meetingPrepIsConfigured(): boolean {
  return meetingPrepSections().some((s) => s.body.trim().length > 0);
}

/**
 * Total UTF-8 bytes that a given set of sections will occupy once persisted.
 * Mirrors the exact JSON shape used by saveMeetingPrepSections so the editor's
 * inline counter matches what the cap check will see on the next debounce.
 */
export function computeMeetingPrepBytes(sections: MeetingPrepSection[]): number {
  return utf8ByteLength(JSON.stringify({ sections }));
}

/** Total UTF-8 bytes of the current meeting-prep payload (used by the editor UI). */
export function meetingPrepUsedBytes(): number {
  return computeMeetingPrepBytes(meetingPrepSections());
}

export function newSectionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function utf8ByteLength(s: string): number {
  // Faster than encoder for short strings and avoids a TextEncoder dep in the
  // hot path of the autosave debounce.
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

// ---------- Debug event log ----------

export interface DebugEvent { ts: number; label: string; detail: string; }

export const [debugEvents, setDebugEvents] = createSignal<DebugEvent[]>([]);

export function pushDebugEvent(entry: Omit<DebugEvent, 'ts'>): void {
  setDebugEvents((prev) => [{ ts: Date.now(), ...entry }, ...prev].slice(0, 40));
}

export function clearDebugEvents(): void {
  setDebugEvents([]);
}
