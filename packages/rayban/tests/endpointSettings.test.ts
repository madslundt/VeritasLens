import { describe, expect, it } from 'vitest';
import { parseFallbackUrls, restoreFallbackUrls } from '../src/runtime/endpointSettings';

describe('fallback endpoint settings', () => {
  it('preserves alternate address priority while normalizing and removing duplicates and the primary', () => {
    expect(parseFallbackUrls(' https://second.example/v1/\r\n\nhttp://localhost:1234/v1\nhttps://second.example/v1\nhttps://primary.example/v1/', 'https://primary.example/v1'))
      .toEqual(['https://second.example/v1', 'http://localhost:1234/v1']);
  });

  it.each(['javascript:alert(1)', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=secret'])('rejects unsafe fallback URLs before saving: %s', (url) => {
    expect(() => parseFallbackUrls(url, 'https://primary.example/v1')).toThrow();
  });

  it('restores valid server settings despite damaged neighboring records', () => {
    expect(restoreFallbackUrls(JSON.stringify({
      'https://primary.example/v1/': ['https://primary.example/v1', 'https://backup.example/v1/', 1, 'invalid'],
      invalid: ['https://other.example/v1'],
      'https://other.example/v1': null,
    }))).toEqual({ 'https://primary.example/v1': ['https://backup.example/v1'] });
  });

  it.each([null, '{broken', '[]', 'null'])('ignores invalid saved fallback maps: %s', (raw) => {
    expect(restoreFallbackUrls(raw)).toEqual({});
  });
});
