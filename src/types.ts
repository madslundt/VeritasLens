// src/types.ts

/** Result union — every built-in lens returns one of these shapes. */
export type LensResult =
  | { type: 'fact-check'; verdict: 'TRUE' | 'FALSE' | 'UNVERIFIED'; claim: string; reason: string }
  | { type: 'trivia'; question: string; answer: string; description: string }
  | { type: 'logical-fallacy'; fallacy: string; explanation: string }
  | { type: 'stats-check'; verdict: 'PLAUSIBLE' | 'SUSPICIOUS'; stat: string; reason: string }
  | { type: 'bias'; verdict: 'NEUTRAL' | 'BIASED'; direction: string; reason: string }
  | { type: 'translation'; translatedText: string }
  | { type: 'eli5'; explanation: string }
  | { type: 'session-summary'; summary: string };

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
  result: LensResult;
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

export const LANGUAGES: Record<string, string> = {
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
};

export type LanguageCode = keyof typeof LANGUAGES;
export const DEFAULT_LANGUAGE: LanguageCode = 'en';

/** Seconds the rolling PCM buffer holds. */
export type BufferDuration = 30 | 120 | 300 | 600;
export const DEFAULT_BUFFER_DURATION: BufferDuration = 30;

/** Minutes between automatic background summaries. */
export type AutoSummaryInterval = 1 | 2 | 5;
export const DEFAULT_AUTO_SUMMARY_INTERVAL: AutoSummaryInterval = 2;

/** User-configurable settings persisted via the SDK bridge local storage. */
export interface Settings {
  geminiApiKey: string;
  geminiModel: GeminiModel;
  responseLanguage: LanguageCode;
  bufferDuration: BufferDuration;
  autoSummaryEnabled: boolean;
  autoSummaryInterval: AutoSummaryInterval;
}

/** Runtime app state. */
export type AppPhase =
  | 'booting'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'displaying'
  | 'sleeping'
  | 'error';

/** Mode the bundle is running in, determined by SDK LaunchSource. */
export type AppMode = 'settings' | 'hud';
