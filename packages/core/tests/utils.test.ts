import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatRelativeTime, stripMarkdownLinks, trimTo } from '../src/personas/_utils';

describe('formatRelativeTime', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns "just now" when less than 60 seconds ago', () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:30Z'));
    const ts = new Date('2026-01-01T12:00:00Z').getTime();
    expect(formatRelativeTime(ts)).toBe('just now');
  });

  it('returns "1 min ago" at 60 seconds', () => {
    vi.setSystemTime(new Date('2026-01-01T12:01:00Z'));
    const ts = new Date('2026-01-01T12:00:00Z').getTime();
    expect(formatRelativeTime(ts)).toBe('1 min ago');
  });

  it('returns "59 min ago" at 59 minutes', () => {
    vi.setSystemTime(new Date('2026-01-01T12:59:00Z'));
    const ts = new Date('2026-01-01T12:00:00Z').getTime();
    expect(formatRelativeTime(ts)).toBe('59 min ago');
  });

  it('returns "1 hr ago" at exactly 60 minutes', () => {
    vi.setSystemTime(new Date('2026-01-01T13:00:00Z'));
    const ts = new Date('2026-01-01T12:00:00Z').getTime();
    expect(formatRelativeTime(ts)).toBe('1 hr ago');
  });

  it('returns "3 hr ago" at 3 hours', () => {
    vi.setSystemTime(new Date('2026-01-01T15:00:00Z'));
    const ts = new Date('2026-01-01T12:00:00Z').getTime();
    expect(formatRelativeTime(ts)).toBe('3 hr ago');
  });
});

describe('stripMarkdownLinks', () => {
  it('replaces a markdown link with its label', () => {
    expect(stripMarkdownLinks('Released via [Tesla blog](https://tesla.com/dk/fsd).'))
      .toBe('Released via Tesla blog.');
  });

  it('handles multiple links in one string', () => {
    expect(stripMarkdownLinks('See [a](https://a.com) and [b](http://b.com).'))
      .toBe('See a and b.');
  });

  it('leaves bare URLs alone', () => {
    expect(stripMarkdownLinks('Source: https://tesla.com/fsd'))
      .toBe('Source: https://tesla.com/fsd');
  });

  it('leaves footnote-style brackets alone (no parenthesised url follows)', () => {
    expect(stripMarkdownLinks('See [1] and [note].')).toBe('See [1] and [note].');
  });

  it('does not collapse a bracket+paren pair whose paren content is not a URL', () => {
    expect(stripMarkdownLinks('[label](not a url)')).toBe('[label](not a url)');
  });
});

describe('trimTo', () => {
  it('strips markdown links before measuring length', () => {
    const raw = 'Released via [Tesla blog](https://tesla.com/dk/fsd) in 2024.';
    // Without stripping the markdown the string is >40 chars; after stripping
    // it fits comfortably and the URL is gone.
    expect(trimTo(raw, 60)).toBe('Released via Tesla blog in 2024.');
  });

  it('trims to length after stripping', () => {
    const raw = '[A](https://x.com) ' + 'y'.repeat(50);
    const out = trimTo(raw, 10);
    expect(out.length).toBe(10);
    expect(out.endsWith('…')).toBe(true);
  });
});
