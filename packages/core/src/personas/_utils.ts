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
  description: "Model self-rated certainty: HIGH = verbatim & verifiable, MED = mostly sure, LOW = inference / unclear audio.",
} as const;

/**
 * Prompt rules appended to every claim-style lens prompt so the confidence
 * field is filled consistently across personas. Specifically forces UNVERIFIED
 * over FALSE when confidence would be LOW — keeps the HUD trustworthy at the
 * cost of one verdict tier on borderline calls.
 */
export const CONFIDENCE_PROMPT_RULES =
  'For each claim, set `confidence` to one of "HIGH", "MED", "LOW". ' +
  'Use HIGH only when the claim is verbatim from the audio AND verifiable. ' +
  'Use LOW when the claim depends on inference, unclear audio, or weak evidence. ' +
  'If `confidence` would be LOW and a verdict-style field would be FALSE / SUSPICIOUS / BIASED, ' +
  'prefer the neutral verdict (UNVERIFIED / PLAUSIBLE / NEUTRAL) — never accuse on low confidence.';

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
 * Throws NoSpeechError if the model signals no speech was detected.
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
  return raw;
}
