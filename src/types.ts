// src/types.ts

/**
 * Per-claim shapes for the claim-shaped lenses. Each carries a verbatim
 * `quote` snippet from the audio so a single tap can cover up to MAX_CLAIMS
 * distinct items and history stays searchable.
 */
export interface FactClaim { quote: string; claim: string; verdict: 'TRUE' | 'FALSE' | 'UNVERIFIED'; reason: string; }
export interface StatsClaim { quote: string; verdict: 'PLAUSIBLE' | 'SUSPICIOUS'; stat: string; reason: string; }
export interface FallacyClaim { quote: string; fallacy: string; explanation: string; }
export interface BiasClaim { quote: string; verdict: 'NEUTRAL' | 'BIASED'; direction: string; reason: string; }
export interface TriviaClaim { quote: string; question: string; answer: string; description: string; }
export interface Eli5Claim { quote: string; explanation: string; }

export interface DevilsAdvocateClaim {
  quote: string;
  counterpoint: string;
  rationale: string;
}

export interface KeyQuestionClaim {
  question: string;
  context: string;
}

export interface SentimentClaim {
  quote: string;
  tone: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED';
  explanation: string;
}

/**
 * Per-entry shape for the Meeting Prep lens. `claims[0]` is always the primary
 * answer; an optional `evidence` claim follows when the answer is grounded in
 * a labeled attachment; an optional `followup` claim is the last entry, and
 * only appears when prep is silent on a decision-changing detail.
 */
export type MeetingPrepClaimKind = 'answer' | 'evidence' | 'followup';

export interface MeetingPrepClaim {
  /** Discriminator for renderers — claim 0 is always 'answer'. */
  kind: MeetingPrepClaimKind;
  /** Answer text, verbatim evidence excerpt, or follow-up prompt depending on `kind`. */
  text: string;
  /**
   * Attachment label this draws from — constrained to the user's attachment
   * labels via a dynamic enum in the response schema. Empty on follow-ups and
   * when the answer is not grounded in a specific attachment.
   */
  source: string;
  /** Optional supporting line. Only set on the answer claim. */
  detail: string;
}

/** Result union — every built-in lens returns one of these shapes. */
export type LensResult = (
  | { type: 'fact-check'; claims: FactClaim[] }
  | { type: 'trivia'; claims: TriviaClaim[] }
  | { type: 'logical-fallacy'; claims: FallacyClaim[] }
  | { type: 'stats-check'; claims: StatsClaim[] }
  | { type: 'bias'; claims: BiasClaim[] }
  | { type: 'eli5'; claims: Eli5Claim[] }
  | { type: 'session-summary'; title: string; summary: string; topics: string[]; keyPoints: string[]; quote?: string }
  | { type: 'meeting-prep'; claims: MeetingPrepClaim[] }
  | { type: 'devils-advocate'; claims: DevilsAdvocateClaim[] }
  | { type: 'key-questions'; claims: KeyQuestionClaim[] }
  | { type: 'sentiment'; claims: SentimentClaim[] }
  | {
      type: 'game';
      preset: GamePreset;
      questions: GameQuestion[];
      /** User's selected option per question; null for skipped riddle. */
      answers: (number | null)[];
      /** Correct-answer count. Always 0 for riddle (unscored). */
      score: number;
    }
) & {
  /** Set when the Auto lens picked this analysis lens on the user's behalf. */
  autoSelected?: boolean;
};

// ---------- Game mode ----------

/** Game format the preset will run. Each maps to a distinct prompt builder. */
export type GameFormat = 'quiz-mc' | 'true-false' | 'riddle';

/** Coarse difficulty knob translated into a prompt instruction per format. */
export type GameDifficulty = 'easy' | 'medium' | 'hard';

/** Fixed session length. Each completed session asks exactly this many questions. */
export const GAME_LENGTH = 10;

/** Human-readable label for a format. Shared by Settings UI and HUD. */
export function gameFormatLabel(format: GameFormat): string {
  switch (format) {
    case 'quiz-mc': return 'Quiz';
    case 'true-false': return 'True / False';
    case 'riddle': return 'Riddle';
  }
}

/** Human-readable label for a difficulty. Shared by Settings UI and HUD. */
export function gameDifficultyLabel(difficulty: GameDifficulty): string {
  switch (difficulty) {
    case 'easy': return 'Easy';
    case 'medium': return 'Medium';
    case 'hard': return 'Hard';
  }
}

/** Saved preset created on the phone. Random is a runtime sentinel — never persisted. */
export interface GamePreset {
  id: string;
  format: GameFormat;
  /** Free-form topic — also doubles as the user-visible label. Empty only when the preset is the runtime-only Random sentinel. */
  topic: string;
  difficulty: GameDifficulty;
  /** When true, the completed session is appended to history (with the score + recap). */
  saveToHistory: boolean;
}

/**
 * One question in a generated game session. `options` length is format-bound:
 *   - quiz-mc: 4 options, `correctIndex` ∈ [0, 4)
 *   - true-false: 2 options, `correctIndex` ∈ [0, 2)
 *   - riddle: 0 options, `correctIndex` is null (no scoring)
 * `reveal` is the per-question explanation (or the riddle answer).
 */
export interface GameQuestion {
  text: string;
  options: string[];
  correctIndex: number | null;
  reveal: string;
}

/** Live game state. Never persisted; abandoning a game discards it. */
export interface GameSession {
  /** Resolved preset. For Random, this is the materialized concrete preset. */
  preset: GamePreset;
  questions: GameQuestion[];
  /** 0-based index of the current question. */
  index: number;
  /** User's selected option per question; null for skipped riddle. */
  answers: (number | null)[];
  phase: 'loading' | 'question' | 'feedback' | 'end';
}

/** Sentinel preset id used by the runtime Random entry. Never persisted. */
export const RANDOM_GAME_PRESET_ID = '__random__';

/**
 * One labeled context block the user prepared before a meeting, e.g. pasted
 * contract text or questions to ask. Persisted under `veritaslens.meetingPrep`.
 */
export interface MeetingPrepSection {
  /** Stable id used as the row key in the editor. */
  id: string;
  /** User-visible label (e.g. "Bank contract"). Empty labels are auto-named "Note 1", "Note 2", … at prompt-build time. */
  label: string;
  /** Free-form pasted/typed context. */
  body: string;
}

/** One entry in the in-memory session history. */
export interface HistoryEntry {
  id: string;
  sessionId: string;
  timestamp: number;
  lensId: string;
  lensName: string;
  /** Short preview label shown in the history list. */
  question: string;
  /** Compact verdict badge (TRUE / PLAUSIBLE / BIASED / ANSWER / etc.). */
  badge: string;
  /** Verbatim source quote(s) joined with " · ". Used to make history searchable. */
  quote: string;
  result: LensResult;
  /**
   * Auto-derived topic / entity / verdict tokens used purely to widen the
   * history search predicate — never rendered. Optional for back-compat with
   * entries persisted by 0.6.x and earlier. Populated at write time via
   * `extractTags` in `lifecycle.ts`.
   */
  tags?: string[];
}

/** Curated Gemini models we know accept inline audio input. Used as the
 *  first-run default and as a fallback when the dynamic `/v1beta/models`
 *  listing isn't available yet. The runtime accepts any model name matching
 *  `GEMINI_MODEL_PATTERN`, so a newer family (gemini-3.x, …) returned by the
 *  Google listModels endpoint is usable without a code change. */
export const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
] as const;

/** URL-safe validator for any `gemini-*` model id. Limits the path segment to
 *  lowercase letters, digits, dashes, and dots so a corrupted local-storage
 *  value can't slip an unsafe character into the endpoint URL. */
export const GEMINI_MODEL_PATTERN = /^gemini-[a-z0-9.-]+$/;

export type GeminiModel = `gemini-${string}`;
export const DEFAULT_GEMINI_MODEL: GeminiModel = 'gemini-2.5-flash';
/**
 * Optional override model for the Auto lens classifier. `null` (the default)
 * means the Auto lens reuses the main model for the classifier call — no
 * separate model is invoked. Users can pick a lighter/cheaper Gemini model
 * from the settings UI to spend fewer tokens or dodge per-model rate limits
 * on the classify step.
 */
export const DEFAULT_GEMINI_AUTO_MODEL: GeminiModel | null = null;

/**
 * LLM provider id. `gemini` calls Google directly with audio in-line.
 * `openai-compatible` covers OpenAI plus OpenAI-API-compatible hosts (OpenRouter,
 * Groq, …) — these accept text only, so the runtime transcribes the audio via
 * the provider's own STT endpoint before sending it to chat completions.
 * `claude` is text-only and reuses the chat-only cross-host STT path: the
 * runtime transcribes on `sttHost` (Groq/OpenAI Whisper) then sends the
 * transcript to Anthropic.
 */
export type LlmProvider = 'gemini' | 'openai-compatible' | 'claude';
export const DEFAULT_LLM_PROVIDER: LlmProvider = 'gemini';

/**
 * Default Claude model. Sonnet-4.6 is the production sweet-spot — faster
 * than Opus at comparable quality on short structured-output tasks, and
 * Anthropic guarantees parity on tool-use shaping. Users can switch to
 * Haiku-4.5 for cost or Opus-4.7 for highest reasoning quality from the UI.
 */
export const CLAUDE_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];
export const DEFAULT_CLAUDE_MODEL: ClaudeModel = 'claude-sonnet-4-6';

/**
 * OpenAI-compatible base URLs that ship in the packaged whitelist. Free-text
 * custom URLs are intentionally NOT supported — the Even Hub `permissions.
 * network.whitelist` is fixed at pack time, so a URL the user types into the
 * settings would be blocked by the WebView's permission policy anyway. Each
 * entry in this list must have its host added to `app.json` too.
 *
 * Two flavors live in this list:
 *   - **Transcribe-then-chat hosts** (OpenAI, Groq): expose `/audio/transcriptions`
 *     so the runtime can Whisper the WAV before chat completions. Each needs
 *     an entry in `OPENAI_TRANSCRIBE_MODELS` below.
 *   - **Inline-audio hosts** (OpenRouter): no transcription endpoint, but
 *     forward `input_audio` chat-completion content parts to backends that
 *     accept them. Listed in `OPENAI_INLINE_AUDIO_HOSTS`; the model picker
 *     filters to audio-capable models from `/models`.
 */
export const OPENAI_BASE_URLS = [
  'https://api.openai.com/v1',
  'https://api.groq.com/openai/v1',
  'https://openrouter.ai/api/v1',
  'https://api.deepseek.com/v1',
  'https://api.perplexity.ai',
] as const;
export type OpenAiBaseUrl = (typeof OPENAI_BASE_URLS)[number];
export const DEFAULT_OPENAI_BASE_URL: OpenAiBaseUrl = 'https://api.openai.com/v1';

/**
 * Fallback model used by OpenAI-compatible providers when the model picker
 * hasn't been populated yet (first run before `fetchAvailableModels`).
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

/**
 * Per-host transcription model name. Partial because not every host can
 * transcribe itself: inline-audio hosts (OpenRouter) accept audio on the chat
 * endpoint, and chat-only hosts (DeepSeek, Perplexity) have no audio surface
 * at all and must borrow STT from another whitelisted host (see `STT_HOSTS`).
 *
 * Same `/audio/transcriptions` path across OpenAI and Groq, only the model
 * id differs (`whisper-1` vs `whisper-large-v3`). One API key per host
 * authenticates both that endpoint and chat-completions.
 */
export const OPENAI_TRANSCRIBE_MODELS: Partial<Record<OpenAiBaseUrl, string>> = {
  'https://api.openai.com/v1': 'whisper-1',
  'https://api.groq.com/openai/v1': 'whisper-large-v3',
};

/**
 * Hosts that accept audio inline in chat-completions (`input_audio` content
 * part) instead of via a separate transcription endpoint. The model list for
 * these hosts is filtered to entries whose `/models` metadata declares
 * `audio` as an input modality.
 */
export const OPENAI_INLINE_AUDIO_HOSTS: ReadonlySet<OpenAiBaseUrl> = new Set<OpenAiBaseUrl>([
  'https://openrouter.ai/api/v1',
]);

/**
 * Chat-only hosts: OpenAI-compatible for `/chat/completions` but with no
 * transcription endpoint and no audio modality on their chat models. The
 * runtime borrows STT from a separate whitelisted host (`Settings.sttHost`)
 * before posting the transcript to these hosts.
 */
export const OPENAI_CHAT_ONLY_HOSTS: ReadonlySet<OpenAiBaseUrl> = new Set<OpenAiBaseUrl>([
  'https://api.deepseek.com/v1',
  'https://api.perplexity.ai',
]);

/**
 * Hosts the runtime will route STT through when the chat host can't do its
 * own. Each entry must also appear in `OPENAI_BASE_URLS` (so it has a key
 * slot in `Settings.openaiApiKeys`) and in `OPENAI_TRANSCRIBE_MODELS` (so it
 * exposes `/audio/transcriptions`). No new whitelist entries needed in
 * `app.json` — these hosts are already permitted.
 */
export const STT_HOSTS = [
  'https://api.openai.com/v1',
  'https://api.groq.com/openai/v1',
] as const;
export type SttHost = (typeof STT_HOSTS)[number];
/** Groq Whisper is the recommended default — free tier, faster than OpenAI Whisper. */
export const DEFAULT_STT_HOST: SttHost = 'https://api.groq.com/openai/v1';
/**
 * Concrete transcription models surfaced in the Settings STT dropdown for
 * each host. First entry is the default when `Settings.sttModel` is empty.
 * Static list rather than a `/models` probe because OpenAI/Groq's listing
 * doesn't tag transcription models specifically, so the keyword filter in
 * `isSupportedChatModel` rejects them anyway.
 */
export const STT_MODELS_BY_HOST: Record<SttHost, readonly string[]> = {
  'https://api.openai.com/v1': ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
  'https://api.groq.com/openai/v1': ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'],
};
export const DEFAULT_STT_MODEL: string = STT_MODELS_BY_HOST[DEFAULT_STT_HOST][0]!;

/** Human-readable host name. Shared by error messages, UI labels, and the settings placeholder lookup. */
export function openaiHostLabel(baseUrl: OpenAiBaseUrl): string {
  switch (baseUrl) {
    case 'https://api.openai.com/v1': return 'OpenAI';
    case 'https://api.groq.com/openai/v1': return 'Groq';
    case 'https://openrouter.ai/api/v1': return 'OpenRouter';
    case 'https://api.deepseek.com/v1': return 'DeepSeek';
    case 'https://api.perplexity.ai': return 'Perplexity';
  }
}

export const LANGUAGES = {
  en: 'English',
  da: 'Dansk',
  sv: 'Svenska',
  no: 'Norsk',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  pt: 'Português',
  nl: 'Nederlands',
  pl: 'Polski',
} as const;

export type LanguageCode = keyof typeof LANGUAGES;
export const DEFAULT_LANGUAGE: LanguageCode = 'en';

/** Seconds the rolling PCM buffer holds. */
export type BufferDuration = 30 | 120 | 300;
export const DEFAULT_BUFFER_DURATION: BufferDuration = 30;

/** User-configurable settings persisted via the SDK bridge local storage. */
export interface Settings {
  /** Active provider for lens analyses. */
  provider: LlmProvider;

  geminiApiKey: string;
  geminiModel: GeminiModel;

  /**
   * Anthropic API key for the Claude provider. Claude is text-only — the
   * runtime transcribes via the same `sttHost` path the chat-only OpenAI
   * providers (DeepSeek, Perplexity) use, then sends the transcript to
   * Anthropic. The STT key is read from `openaiApiKeys[sttHost]`.
   */
  claudeApiKey: string;
  claudeModel: ClaudeModel;
  /**
   * Optional override model for the Auto lens classifier. `null` means the
   * classifier call reuses the main `geminiModel` — no separate model is
   * configured. Pick a lighter/cheaper model when you want to keep the
   * classify step under a different rate-limit envelope from the analysis.
   */
  geminiAutoModel: GeminiModel | null;

  /**
   * API keys for the OpenAI-compatible providers, keyed by host base URL.
   * Each host (OpenAI, Groq, …) needs its own key, so switching between them
   * via the Provider dropdown does not lose previously-entered credentials.
   */
  openaiApiKeys: Record<OpenAiBaseUrl, string>;
  /** Base URL of the OpenAI-compatible host. Must be one of OPENAI_BASE_URLS. */
  openaiBaseUrl: OpenAiBaseUrl;
  /** Chat-completions model. Populated via fetchAvailableModels after key entry. */
  openaiModel: string;
  /**
   * Per-host override for the `/audio/transcriptions` model. Empty string for
   * a host means "use the static default from `OPENAI_TRANSCRIBE_MODELS`".
   * Stored per host (like `openaiApiKeys`) so swapping between OpenAI and Groq
   * preserves each side's customization. Ignored for inline-audio hosts where
   * `OPENAI_TRANSCRIBE_MODELS[host]` is undefined.
   */
  openaiTranscribeModels: Record<OpenAiBaseUrl, string>;
  /**
   * STT host borrowed when the active chat host can't transcribe (DeepSeek,
   * Perplexity). The runtime hits this host's `/audio/transcriptions`
   * endpoint, then sends the transcript to the chat host's `/chat/completions`.
   * The STT API key is read from `openaiApiKeys[sttHost]` — no separate key
   * field, since these hosts are already whitelisted as chat providers too.
   */
  sttHost: SttHost;
  /**
   * Transcription model id on `sttHost`. Empty means "use the first entry of
   * `STT_MODELS_BY_HOST[sttHost]`". Persisted separately from the per-host
   * chat overrides so the same host can drive its own chat AND act as STT
   * for a different chat host with independent model picks.
   */
  sttModel: string;

  responseLanguage: LanguageCode;
  bufferDuration: BufferDuration;
  autoSummaryEnabled: boolean;
  /**
   * When true, the next session starts with the most-recent summaries from
   * persisted history seeded into the recall-context block. Lets the LLM
   * keep track of long-running topics across power-cycles or short breaks.
   * Off by default — summaries of past sessions are sent to the provider as
   * part of every prompt, so this is a privacy-affecting toggle.
   */
  crossSessionRecallEnabled: boolean;
  /**
   * When true, the active HUD hides the REC indicator and affordance hint and
   * shows only a small recording dot until the user double-taps for an
   * analysis. Results stay on screen until explicitly dismissed via the menu's
   * Back item, which also returns the layout to the dot-only view.
   */
  discreet: boolean;
  /**
   * Sensitivity of the in-browser VAD gate, expressed as an int16 RMS floor.
   * A 250 ms frame whose RMS sits below this value counts as silence, and a
   * buffer with no energetic frames short-circuits the tap before the LLM
   * call (HUD shows `○` no voice / `~` too noisy). `0` disables the gate
   * entirely so every tap reaches the LLM regardless of content. Steps of
   * 50 in the Settings UI; `200` is the historical default (≈ −44 dBFS) and
   * lower values are more permissive — useful when a quiet mic capture is
   * being misclassified as silence.
   */
  voiceGateRmsFloor: number;
  /**
   * When true (default), the WAV uploaded to the LLM is trimmed to just the
   * Silero-detected speech segments (with small padding and brief join
   * silences). Cuts upload + base64 + server ingestion time on long buffers
   * with sparse speech. Silently no-ops when only the FFT fallback is
   * available, since FFT does not produce segment boundaries.
   */
  voiceTrimEnabled: boolean;
  /**
   * Lens IDs excluded from the Auto dispatcher. Default `[]` means all
   * Auto candidates are enabled. Stored as a JSON-serialised string array
   * under `veritaslens.autoDisabledLenses`.
   */
  autoDisabledLenses: string[];
  /**
   * Auto mode: when true, the runtime watches the live mic for voice
   * activity and auto-triggers an analysis once the wearer has spoken for
   * at least `autoModeStartMs` and then been silent for at least
   * `autoModeSilenceMs`. Mid-utterance pauses shorter than the silence
   * threshold do not fire. Reuses `voiceGateRmsFloor` as the VAD threshold
   * so the user has a single sensitivity knob.
   */
  autoModeEnabled: boolean;
  /** Continuous voice duration (ms) required before the watcher arms. */
  autoModeStartMs: number;
  /** Trailing silence (ms) after the watcher is armed that triggers analysis. */
  autoModeSilenceMs: number;
}

/** Defaults for the auto-mode thresholds. Used as initial values and as
 *  the fallback when coercing an unparseable / out-of-range persisted entry. */
export const DEFAULT_AUTO_MODE_START_MS = 1500;
export const DEFAULT_AUTO_MODE_SILENCE_MS = 2000;
/** Slider clamps for the Settings UI. */
export const AUTO_MODE_START_MS_MIN = 500;
export const AUTO_MODE_START_MS_MAX = 5000;
export const AUTO_MODE_SILENCE_MS_MIN = 500;
export const AUTO_MODE_SILENCE_MS_MAX = 5000;
export const AUTO_MODE_STEP_MS = 250;

/** Runtime app state. */
export type AppPhase =
  | 'booting'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'displaying'
  | 'error';

/** Mode the bundle is running in, determined by SDK LaunchSource. */
export type AppMode = 'settings' | 'hud';
