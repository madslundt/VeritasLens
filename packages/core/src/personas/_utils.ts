// src/personas/_utils.ts

import type { ClaimConfidence } from '@/types';

/** Maximum length, in chars, of a per-claim verbatim audio quote. */
export const MAX_QUOTE_CHARS = 140;

/**
 * JSON-schema fragment to drop into a per-claim `properties` block so every
 * lens declares a `confidence` field with the same enum. Kept as one constant
 * so a new value (HIGH/MED/LOW + future tiers) only changes here.
 */
export const CONFIDENCE_SCHEMA_PROP = {
  type: 'string',
  enum: ['HIGH', 'MED', 'LOW'],
  description: "Certainty that the speech was understood and this lens output is supported: HIGH = clear speech and strong support, MED = reasonable support, LOW = unclear speech or weak support.",
} as const;

/**
 * Prompt rules appended to every claim-style lens prompt so the confidence
 * field is filled consistently across personas. Specifically forces UNVERIFIED
 * over FALSE when confidence would be LOW — keeps the HUD trustworthy at the
 * cost of one verdict tier on borderline calls.
 */
export const CONFIDENCE_PROMPT_RULES =
  'For each claim, set `confidence` to one of "HIGH", "MED", "LOW". ' +
  'Rate both your understanding of the speech and the support for your output. ' +
  'HIGH requires clear speech and strong support appropriate to this lens: reliable evidence for factual answers, ' +
  'faithful meaning for explanations, or identifiable wording and reasoning for interpretive judgments. ' +
  'A verbatim quote alone does not verify an answer or a judgment. Use MED for reasonable but incomplete support ' +
  'and LOW for unclear speech, ambiguous interpretation, or weak evidence. ' +
  'For LOW confidence, use UNVERIFIED for fact verdicts, NEUTRAL for framing, and "None detected" for fallacies; ' +
  'leave corrections, counterFrame, and callOut empty. Never accuse on low confidence.';

/** Speech can be clear while offering nothing this particular lens should output. */
export const LENS_FOCUS_RULES =
  'Stay within this lens\'s task. Prefer one or two useful items; the maximum is a ceiling, not a target. ' +
  'If clear speech contains no suitable content for this lens, return {"noSpeech":false,"claims":[]}. ' +
  'Use noSpeech=true only when no clear human speech is detected. Never invent an item to fill the schema.';

/**
 * Coerce an unknown JSON value into the ClaimConfidence enum. Returns
 * `undefined` for any input that doesn't match the canonical set, so an older
 * persona response (no confidence field) round-trips as undefined and the
 * HUD's tag column stays blank — same behavior as a missing field.
 */
export function coerceConfidence(v: unknown): ClaimConfidence | undefined {
  if (typeof v !== 'string') return undefined;
  const upper = v.trim().toUpperCase();
  if (upper === 'HIGH' || upper === 'MED' || upper === 'LOW') return upper;
  return undefined;
}

/**
 * Collapse markdown link syntax `[label](url)` to just `label`. Web-grounded
 * providers (notably OpenAI Responses with `web_search`) sometimes inline
 * `[Tesla blog](https://tesla.com/...)` into answer text; the HUD renders
 * raw strings and has no markdown layer, so the bare URL leaks onto the
 * display. Bare URLs are left alone — they may legitimately appear in a
 * translation transcript or a user-quoted source.
 */
export function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(\s*[a-z][a-z0-9+.-]*:\/\/[^)\s]+\s*\)/gi, '$1');
}

export function trimTo(text: string, max: number): string {
  const cleaned = stripMarkdownLinks(text);
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

/** Coerce an unknown JSON value into a trimmed quote string. */
export function coerceQuote(v: unknown): string {
  return trimTo(typeof v === 'string' ? v : '', MAX_QUOTE_CHARS);
}

/** Maximum number of claims a claim-shaped lens may return in a single call. */
export const MAX_CLAIMS = 5;

/** Pull a `claims` array from a parsed Gemini response, defensively bounded to MAX_CLAIMS items. */
export function readClaimsArray(raw: Record<string, unknown>): Record<string, unknown>[] {
  const claims = raw['claims'];
  if (!Array.isArray(claims)) return [];
  return claims.filter((c): c is Record<string, unknown> => isRecord(c)).slice(0, MAX_CLAIMS);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class NoRelevantContentError extends Error {
  constructor() { super('No relevant content for this lens.'); this.name = 'NoRelevantContentError'; }
}

export class NoSpeechError extends Error {
  constructor() { super('No clear human speech detected.'); this.name = 'NoSpeechError'; }
}

/** Convert a past Unix timestamp to a human-readable relative time string. */
export function formatRelativeTime(ts: number): string {
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  return `${Math.floor(diffMin / 60)} hr ago`;
}

/**
 * Parse a JSON object from a Gemini text response.
 * Falls back to fenced-JSON extraction if the response has extra prose.
 * Throws NoSpeechError for no speech, or NoRelevantContentError for empty claims.
 */
export function parseJsonResponse(text: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const fenced = /\{[\s\S]*\}/.exec(text);
    if (!fenced) throw new Error('Gemini response was not JSON.');
    raw = JSON.parse(fenced[0]);
  }
  if (!isRecord(raw)) throw new Error('Gemini response was not a JSON object.');
  if (raw['noSpeech'] === true) throw new NoSpeechError();
  if (Array.isArray(raw['claims']) && raw['claims'].length === 0) throw new NoRelevantContentError();
  return raw;
}
