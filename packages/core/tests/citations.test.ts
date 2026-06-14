import { describe, expect, it } from 'vitest';
import {
  buildCitation,
  dedupeCitations,
  extractDomainFromUrl,
  normalizeWebDomain,
} from '@/llm/citations';

describe('normalizeWebDomain', () => {
  it('strips protocol, path, query, fragment', () => {
    expect(normalizeWebDomain('https://www.bbc.co.uk/news/world?utm=x#top')).toBe('www.bbc.co.uk');
  });

  it('lowercases', () => {
    expect(normalizeWebDomain('Reuters.COM')).toBe('reuters.com');
  });

  it('rejects junk', () => {
    expect(normalizeWebDomain('')).toBe('');
    expect(normalizeWebDomain('   ')).toBe('');
    expect(normalizeWebDomain('example')).toBe('');           // no TLD
    expect(normalizeWebDomain('not a domain')).toBe('');      // space-injected
    expect(normalizeWebDomain('a'.repeat(120))).toBe('');     // over-length
    expect(normalizeWebDomain(null)).toBe('');
    expect(normalizeWebDomain(42)).toBe('');
  });

  it('preserves subdomains', () => {
    expect(normalizeWebDomain('api.nationalbanken.dk')).toBe('api.nationalbanken.dk');
  });
});

describe('extractDomainFromUrl', () => {
  it('parses real URLs via URL constructor', () => {
    expect(extractDomainFromUrl('https://www.bbc.com/news')).toBe('www.bbc.com');
  });

  it('falls back to regex on relative or malformed URLs', () => {
    expect(extractDomainFromUrl('reuters.com/article/123')).toBe('reuters.com');
  });

  it('returns empty for junk', () => {
    expect(extractDomainFromUrl(undefined)).toBe('');
    expect(extractDomainFromUrl('   ')).toBe('');
  });
});

describe('buildCitation', () => {
  it('builds from a URL', () => {
    expect(buildCitation({ url: 'https://www.bbc.com/news', title: 'BBC' })).toEqual({
      domain: 'www.bbc.com',
      url: 'https://www.bbc.com/news',
      title: 'BBC',
    });
  });

  it('builds from a bare domain', () => {
    expect(buildCitation({ domain: 'reuters.com' })).toEqual({ domain: 'reuters.com' });
  });

  it('prefers explicit domain over URL host', () => {
    expect(buildCitation({ domain: 'override.com', url: 'https://other.com/x' })?.domain).toBe('override.com');
  });

  it('returns null when no domain is recoverable', () => {
    expect(buildCitation({ url: 'not-a-url' })).toBeNull();
    expect(buildCitation({})).toBeNull();
  });

  it('drops empty title/snippet', () => {
    const cit = buildCitation({ domain: 'a.com', title: '   ', snippet: '' });
    expect(cit).toEqual({ domain: 'a.com' });
  });
});

describe('dedupeCitations', () => {
  it('dedupes by URL when present', () => {
    const dedup = dedupeCitations([
      { domain: 'a.com', url: 'https://a.com/x', title: 'first' },
      { domain: 'a.com', url: 'https://a.com/x', title: 'duplicate' },
      { domain: 'a.com', url: 'https://a.com/y' },
    ]);
    expect(dedup).toHaveLength(2);
    expect(dedup[0]!.title).toBe('first'); // first wins
  });

  it('falls back to domain key when no URL', () => {
    const dedup = dedupeCitations([
      { domain: 'a.com' },
      { domain: 'a.com' },
      { domain: 'b.com' },
    ]);
    expect(dedup).toHaveLength(2);
  });
});
