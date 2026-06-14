// src/llm/citations.ts
//
// Shared helpers for normalizing structured web citations across every
// provider's native web-search shape. Providers disagree wildly:
//
//   - Gemini:        groundingMetadata.groundingChunks[].web.{uri,title}
//   - Claude:        web_search_tool_result content blocks with {url,title,page_age}
//   - OpenAI/OpenRouter: annotations[].url_citation.{url,title,start_index,end_index}
//   - Perplexity:    top-level search_results[].{title,url,snippet,date}
//   - Groq compound: executed_tools[].search_results[].{url,title,snippet}
//
// Each provider client normalizes into the shared `WebCitation` shape (see
// `@/types`) using the helpers here, then emits the deduped array via the
// `onCitations` callback on the streaming facade.

import type { WebCitation } from '@/types';

/** Domain string cap. Matches the existing Meeting Prep `sourceMeta` ceiling
 *  so a citation's domain can be dropped straight into that field without a
 *  second-pass length check. */
export const MAX_DOMAIN_CHARS = 80;

/**
 * Normalise a model-supplied or provider-supplied domain into a bare lowercase
 * domain. Defensive against full URLs, mixed case, trailing slashes, and
 * surrounding whitespace; returns `''` for any recognisably-invalid input
 * (numeric, no dot, control chars, runaway length) so the caller can drop the
 * entry rather than persisting garbage.
 *
 * Intentionally NOT a full RFC-3986 validator — the HUD only renders this
 * string, so the only real risk is visual noise. This is the function that
 * used to live in `personas/meetingPrep.ts`; promoted here so every provider
 * citation extractor uses the same normalization.
 */
export function normalizeWebDomain(value: unknown): string {
  if (typeof value !== 'string') return '';
  let s = value.trim();
  if (!s) return '';
  s = s.replace(/^[a-z]+:\/\//i, '');
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h);
  s = s.toLowerCase();
  if (s.length === 0 || s.length > MAX_DOMAIN_CHARS) return '';
  if (!/^[a-z0-9.-]+\.[a-z][a-z0-9-]*$/.test(s)) return '';
  return s;
}

/**
 * Pull the bare domain out of a URL using the same normalization rules. The
 * URL constructor is browser-native but throws on relative URLs and on
 * `vertexaisearch.cloud.google.com/...` redirects — fall back to a regex so a
 * malformed entry still surfaces a domain when one is recoverable.
 */
export function extractDomainFromUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return '';
  try {
    const u = new URL(value);
    return normalizeWebDomain(u.hostname);
  } catch {
    return normalizeWebDomain(value);
  }
}

/**
 * Build a `WebCitation` from raw provider fields. Returns `null` when no
 * usable domain can be derived (provider returned a junk URL, model echoed
 * back a placeholder, etc.). String fields are trimmed but otherwise kept
 * verbatim — caller decides any truncation policy.
 */
export function buildCitation(input: {
  domain?: unknown;
  url?: unknown;
  title?: unknown;
  snippet?: unknown;
}): WebCitation | null {
  const direct = normalizeWebDomain(input.domain);
  const domain = direct || extractDomainFromUrl(input.url);
  if (!domain) return null;
  const out: WebCitation = { domain };
  if (typeof input.url === 'string' && input.url.trim()) out.url = input.url.trim();
  if (typeof input.title === 'string' && input.title.trim()) out.title = input.title.trim();
  if (typeof input.snippet === 'string' && input.snippet.trim()) out.snippet = input.snippet.trim();
  return out;
}

/**
 * Deduplicate citations. Two citations collide when they share the same
 * `url` (or `domain` when no url is present). The first occurrence wins so
 * later, less-populated entries don't clobber title/snippet captured earlier.
 */
export function dedupeCitations(citations: ReadonlyArray<WebCitation>): WebCitation[] {
  const seen = new Set<string>();
  const out: WebCitation[] = [];
  for (const c of citations) {
    const key = c.url ?? c.domain;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
