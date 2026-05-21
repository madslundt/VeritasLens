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
 * Per-entry shape for the Meeting Prep lens. The first entry in `claims` is
 * the primary answer to whatever the user just heard; any further entries are
 * follow-up prompts the user could ask next, in priority order.
 */
export interface MeetingPrepClaim {
  /** Primary answer text or follow-up prompt. */
  text: string;
  /**
   * Section label this draws from — constrained to the user's section labels
   * via a dynamic enum in the response schema. Empty string when the response
   * is not grounded in any specific section.
   */
  source: string;
  /** Optional supporting line (numbers, contract clause refs, contrasts). Typically only set on the primary answer. */
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
  | { type: 'session-summary'; title: string; summary: string; quote?: string }
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

/**
 * Optional one-line user intent + perspective passed alongside sections. When
 * set they steer Gemini's answer toward an outcome and orient its follow-ups
 * to the user's side of the conversation. Both default to empty strings —
 * absence means "not configured" and the prompt omits the perspective block.
 */
export interface MeetingPrepPayload {
  /** What the user is trying to achieve in this meeting. Free text, capped at save time. */
  goal: string;
  /** Which side of the conversation the user is on (Buyer / Seller / Candidate / Interviewer / custom). Free string. */
  role: string;
  sections: MeetingPrepSection[];
}

/** Preset role chips offered in the UI. The committed value is still a plain string. */
export const MEETING_PREP_ROLE_PRESETS = ['Buyer', 'Seller', 'Candidate', 'Interviewer'] as const;
export type MeetingPrepRolePreset = (typeof MEETING_PREP_ROLE_PRESETS)[number];

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
/** Model used by the Auto lens to classify which lens fits best. Lighter/faster by default. */
export const DEFAULT_GEMINI_AUTO_MODEL: GeminiModel = 'gemini-2.0-flash-lite';

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
export type BufferDuration = 30 | 120 | 300 | 600;
export const DEFAULT_BUFFER_DURATION: BufferDuration = 30;

/** Minutes between automatic background summaries. */
export type AutoSummaryInterval = 1 | 2 | 5;
export const DEFAULT_AUTO_SUMMARY_INTERVAL: AutoSummaryInterval = 2;

/** User-configurable settings persisted via the SDK bridge local storage. */
export interface Settings {
  geminiApiKey: string;
  geminiModel: GeminiModel;
  /** Model used by the Auto lens classifier (typically a lighter/cheaper model). */
  geminiAutoModel: GeminiModel;
  responseLanguage: LanguageCode;
  bufferDuration: BufferDuration;
  autoSummaryEnabled: boolean;
  autoSummaryInterval: AutoSummaryInterval;
  /**
   * When true, the active HUD hides the REC indicator and affordance hint and
   * shows only a small recording dot until the user double-taps for an
   * analysis. Results stay on screen until explicitly dismissed via the menu's
   * Back item, which also returns the layout to the dot-only view.
   */
  discreet: boolean;
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
