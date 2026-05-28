// src/personas/_utils.ts

/** Maximum length, in chars, of a per-claim verbatim audio quote. */
export const MAX_QUOTE_CHARS = 140;

export function trimTo(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
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
