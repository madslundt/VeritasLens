import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatRelativeTime } from '../src/personas/_utils';

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
