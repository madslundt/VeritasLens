import type { WebCitation } from '@/types';
import { buildCitation, dedupeCitations } from '@/llm/citations';
import { withFetchTimeout, UploadTimeoutError, throwIfAborted } from '@/llm/fetchTimeout';

export async function tavilySearch(opts: { apiKey: string; query: string; signal?: AbortSignal }): Promise<WebCitation[]> {
  if (!opts.apiKey.trim()) throw new Error('Add a Tavily API key.');
  const query = opts.query.trim();
  if (!query) return [];
  const attempt = withFetchTimeout(opts.signal, 15_000);
  let onAbort = (): void => {};
  // Some WebView/native transports do not reject promptly on abort. Race the
  // entire operation (including JSON reading) so optional search is bounded.
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(attempt.signal.reason ?? new DOMException('Aborted', 'AbortError'));
    attempt.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    throwIfAborted(attempt.signal);
    const request = async (): Promise<WebCitation[]> => {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey.trim()}` },
        body: JSON.stringify({ query: query.slice(-500), search_depth: 'basic', max_results: 8, include_answer: false, include_raw_content: false }),
        signal: attempt.signal,
      });
      if (!response.ok) throw new Error(`Tavily search HTTP ${response.status}.`);
      const payload: unknown = await response.json();
      throwIfAborted(attempt.signal);
      const results = payload && typeof payload === 'object' && 'results' in payload ? payload.results : undefined;
      if (!Array.isArray(results)) throw new Error('Tavily returned an invalid search response.');
      const citations: WebCitation[] = [];
      for (const result of results.slice(0, 32)) {
        if (!result || typeof result !== 'object') continue;
        const citation = buildCitation({
          url: typeof result.url === 'string' ? result.url : undefined,
          title: typeof result.title === 'string' ? result.title : undefined,
          snippet: typeof result.content === 'string' ? result.content.slice(0, 2000) : undefined,
        });
        if (citation) citations.push(citation);
      }
      return dedupeCitations(citations).slice(0, 8);
    };
    return await Promise.race([request(), aborted]);
  } catch (error) {
    if (!opts.signal?.aborted && attempt.timedOut()) throw new UploadTimeoutError('Tavily search timed out.');
    throw error;
  } finally {
    attempt.signal.removeEventListener('abort', onAbort);
    attempt.cleanup();
  }
}
