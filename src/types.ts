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
) & {
  /** Set when the Auto lens picked this analysis lens on the user's behalf. */
  autoSelected?: boolean;
};

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

/** Gemini models known to accept inline audio input. */
export const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
] as const;

export type GeminiModel = (typeof GEMINI_MODELS)[number];
export const DEFAULT_GEMINI_MODEL: GeminiModel = 'gemini-2.0-flash';
/**
 * Optional override model for the Auto lens classifier. `null` (the default)
 * means the Auto lens reuses the main model for the classifier call — no
 * separate model is invoked. Set to a lighter/cheaper Gemini model to spend
 * fewer tokens / dodge per-model rate limits on the classify step.
 */
export const DEFAULT_GEMINI_AUTO_MODEL: GeminiModel | null = null;

/**
 * LLM provider id. `gemini` calls Google directly with audio in-line.
 * `openai-compatible` covers OpenAI plus OpenAI-API-compatible hosts (OpenRouter,
 * Groq, …) — these accept text only, so the runtime transcribes the audio via
 * the provider's own STT endpoint before sending it to chat completions.
 */
export type LlmProvider = 'gemini' | 'openai-compatible';
export const DEFAULT_LLM_PROVIDER: LlmProvider = 'gemini';

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
] as const;
export type OpenAiBaseUrl = (typeof OPENAI_BASE_URLS)[number];
export const DEFAULT_OPENAI_BASE_URL: OpenAiBaseUrl = 'https://api.openai.com/v1';

/**
 * Fallback model used by OpenAI-compatible providers when the model picker
 * hasn't been populated yet (first run before `fetchAvailableModels`).
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

/**
 * Per-host transcription model name. Partial because inline-audio hosts
 * (OpenRouter) have no transcription endpoint — the absence of a key is the
 * typed signal that `callOpenAiLens` should take the inline-audio branch
 * instead of calling `/audio/transcriptions`.
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

/** Human-readable host name. Shared by error messages, UI labels, and the settings placeholder lookup. */
export function openaiHostLabel(baseUrl: OpenAiBaseUrl): string {
  switch (baseUrl) {
    case 'https://api.openai.com/v1': return 'OpenAI';
    case 'https://api.groq.com/openai/v1': return 'Groq';
    case 'https://openrouter.ai/api/v1': return 'OpenRouter';
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

  responseLanguage: LanguageCode;
  bufferDuration: BufferDuration;
  autoSummaryEnabled: boolean;
  /**
   * When true, the active HUD hides the REC indicator and affordance hint and
   * shows only a small recording dot until the user double-taps for an
   * analysis. Results stay on screen until explicitly dismissed via the menu's
   * Back item, which also returns the layout to the dot-only view.
   */
  discreet: boolean;
  /**
   * When true (default), the in-browser VAD (Silero, with an FFT fallback)
   * short-circuits taps on silence / non-voice noise — the HUD shows `○`
   * (no voice) or `~` (too noisy) instead of calling the LLM. Disable as a
   * bail-out if the gate misclassifies the user's language or environment;
   * with the gate off, every tap is sent to Gemini regardless of content.
   */
  voiceGateEnabled: boolean;
}

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
