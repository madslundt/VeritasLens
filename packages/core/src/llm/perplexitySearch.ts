// src/llm/perplexitySearch.ts
//
// Borrowed search bolt-on for chat hosts without native web search. Today
// that's DeepSeek only; the wearer's existing Perplexity API key (already
// used for Sonar chat or just kept on file) is reused to call Perplexity's
// standalone `/search` endpoint. The mechanism mirrors the existing
// `sttHost` cross-host borrow pattern — same configuration story, different
// capability.
//
// Returns `WebCitation[]` so the caller can both (a) inject the results into
// the system prompt and (b) emit the same array via `onCitations` for the
// HUD's sources sub-page. No streaming — the response is small and the
// downstream chat call is what the wearer is actually waiting for.

import type { WebCitation } from '@/types';
import { withFetchTimeout, UploadTimeoutError } from './fetchTimeout';
import { buildCitation, dedupeCitations } from './citations';

const PERPLEXITY_SEARCH_ENDPOINT = 'https://api.perplexity.ai/search';
const SEARCH_TIMEOUT_MS = 15_000;
/** Cap the result list before we stuff it into the system prompt — beyond
 *  8 entries the token cost outweighs the marginal grounding benefit, and
 *  the HUD's history sub-page only renders the first 5. */
const MAX_RESULTS = 8;
/** Hard cap on the query string we send to Perplexity. Real transcripts can
 *  run multi-minute on a 5-min buffer; trimming to a few hundred chars keeps
 *  the search relevant and the API call cheap. */
const MAX_QUERY_CHARS = 500;

export interface PerplexitySearchOptions {
  apiKey: string;
  query: string;
  signal?: AbortSignal;
}

interface PerplexitySearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
}

interface PerplexitySearchResponse {
  results?: PerplexitySearchResult[];
  error?: { message?: string };
}

/**
 * Derive a search query from an audio transcript. Heuristic: take the last
 * `MAX_QUERY_CHARS` characters so the most recent content (the part the
 * wearer most likely wants checked) wins when the buffer is long. Collapse
 * whitespace; drop transcript tags like `[Audio transcript]` that
 * `transcriptUserMessage` prepends so they don't leak into the search.
 */
export function buildSearchQueryFromTranscript(transcript: string): string {
  const cleaned = transcript
    .replace(/\[Audio transcript[^\]]*\]\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= MAX_QUERY_CHARS) return cleaned;
  return cleaned.slice(-MAX_QUERY_CHARS);
}

/**
 * POST a single search query to Perplexity's `/search` endpoint and return
 * deduplicated citations. Throws on a hard failure (bad key, network, signal
 * abort); returns `[]` when the API replied successfully but the result list
 * was empty. Caller decides whether to degrade gracefully — the OpenAI client
 * swallows non-abort failures so the chat call still runs.
 */
export async function perplexitySearch(
  opts: PerplexitySearchOptions,
): Promise<WebCitation[]> {
  if (!opts.apiKey) throw new Error('Missing Perplexity API key for search.');
  const trimmed = opts.query.trim();
  if (!trimmed) return [];

  const attemptCtl = withFetchTimeout(opts.signal, SEARCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(PERPLEXITY_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        query: trimmed,
        max_results: MAX_RESULTS,
      }),
      signal: attemptCtl.signal,
    });
  } catch (err) {
    attemptCtl.cleanup();
    if (opts.signal?.aborted) throw err;
    if (attemptCtl.timedOut()) {
      throw new UploadTimeoutError(
        `Perplexity search timed out after ${SEARCH_TIMEOUT_MS / 1000}s.`,
      );
    }
    throw err;
  }
  attemptCtl.cleanup();

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Perplexity search HTTP ${response.status}: ${truncate(errText, 500)}`,
    );
  }
  const payload = (await response.json()) as PerplexitySearchResponse;
  if (payload.error?.message) {
    throw new Error(`Perplexity search error: ${payload.error.message}`);
  }
  const out: WebCitation[] = [];
  for (const r of payload.results ?? []) {
    const cit = buildCitation({ url: r.url, title: r.title, snippet: r.snippet });
    if (cit) out.push(cit);
  }
  return dedupeCitations(out);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
