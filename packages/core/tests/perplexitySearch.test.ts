import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSearchQueryFromTranscript, perplexitySearch } from '@/llm/perplexitySearch';

describe('buildSearchQueryFromTranscript', () => {
  it('strips the [Audio transcript] preamble', () => {
    expect(buildSearchQueryFromTranscript('[Audio transcript]\nWhat is the base rate?'))
      .toBe('What is the base rate?');
  });

  it('handles the empty-transcript tag', () => {
    expect(buildSearchQueryFromTranscript('[Audio transcript: <empty — no speech captured>]'))
      .toBe('');
  });

  it('collapses whitespace', () => {
    expect(buildSearchQueryFromTranscript('  hello\n\n  world  ')).toBe('hello world');
  });

  it('truncates to the trailing window when over the cap', () => {
    const huge = 'a '.repeat(400) + 'PAYLOAD';
    const out = buildSearchQueryFromTranscript(huge);
    expect(out.endsWith('PAYLOAD')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(500);
  });
});

describe('perplexitySearch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { title: 'BBC News', url: 'https://www.bbc.com/news/x', snippet: 'rate is 1.75%' },
            { title: 'Reuters', url: 'https://www.reuters.com/article/y', snippet: 'inflation' },
            { url: 'not-a-url-junk' },                    // dropped by buildCitation
            { title: 'BBC dup', url: 'https://www.bbc.com/news/x' }, // dedupe
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('POSTs to /search with bearer auth + query body', async () => {
    await perplexitySearch({ apiKey: 'pplx-test', query: 'what is the cpi' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.perplexity.ai/search');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer pplx-test');
    const body = JSON.parse((init as RequestInit).body as string) as { query: string };
    expect(body.query).toBe('what is the cpi');
  });

  it('normalises results into deduped WebCitations', async () => {
    const out = await perplexitySearch({ apiKey: 'pplx-test', query: 'x' });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      domain: 'www.bbc.com',
      url: 'https://www.bbc.com/news/x',
      title: 'BBC News',
      snippet: 'rate is 1.75%',
    });
    expect(out[1]!.domain).toBe('www.reuters.com');
  });

  it('throws on missing key', async () => {
    await expect(perplexitySearch({ apiKey: '', query: 'x' }))
      .rejects.toThrow(/Missing Perplexity API key/);
  });

  it('returns [] for an empty query without making a request', async () => {
    const out = await perplexitySearch({ apiKey: 'pplx-test', query: '   ' });
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
