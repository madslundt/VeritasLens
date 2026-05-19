/**
 * Shared types for VeritasLens.
 *
 * Kept deliberately small — domain types only. SDK types are imported
 * directly from `@evenrealities/even_hub_sdk` wherever they're needed.
 */

/** Verdict labels returned by the Fact-Checker persona. */
export type VerdictLabel = 'TRUE' | 'FALSE' | 'UNVERIFIED';

/** Structured result of a fact-check pass. */
export interface Verdict {
  verdict: VerdictLabel;
  /** The claim that was checked (one short sentence). */
  claim: string;
  /** A one-line justification (≤ 80 chars after formatting). */
  reason: string;
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
 * Languages the verdict can be rendered in. Limited to Latin-script European
 * languages for MVP — the HUD's 4-bit greyscale font has guaranteed support
 * for ASCII + extended-Latin glyphs but CJK / Arabic / Hebrew may not render.
 */
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

/** User-configurable settings persisted via the SDK bridge local storage. */
export interface Settings {
  /** Google AI Studio key for Gemini. Never leaves the device except via the Gemini request itself. */
  geminiApiKey: string;
  /** Which Gemini model to use for fact-checking. */
  geminiModel: GeminiModel;
  /** Language the verdict/reason should be rendered in. */
  responseLanguage: LanguageCode;
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

/** Mode the bundle is running in, determined by SDK `LaunchSource`. */
export type AppMode = 'settings' | 'hud';
