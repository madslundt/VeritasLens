import type { HistoryEntry } from '@/types';

function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c < 0xd800 || c >= 0xe000) n += 3;
    else { i++; n += 4; }
  }
  return n;
}

export interface HistorySerializeOptions {
  byteBudget: number;
  maxEntries: number;
}

export function serializeHistory(
  entries: HistoryEntry[],
  { byteBudget, maxEntries }: HistorySerializeOptions,
): string {
  const capped = entries.length > maxEntries ? entries.slice(-maxEntries) : entries;
  let json = JSON.stringify(capped);
  let bytes = utf8ByteLength(json);
  if (bytes <= byteBudget || capped.length === 0) return json;

  const SAFETY = 0.85;
  const estimateKeep = (totalBytes: number, count: number): number => {
    const avg = totalBytes / count;
    return Math.max(1, Math.floor((byteBudget / avg) * SAFETY));
  };

  let keep = estimateKeep(bytes, capped.length);
  let trimmed = capped.slice(-keep);
  json = JSON.stringify(trimmed);
  bytes = utf8ByteLength(json);

  if (bytes > byteBudget && trimmed.length > 1) {
    const next = estimateKeep(bytes, trimmed.length);
    keep = Math.max(1, Math.min(next, trimmed.length - 1));
    trimmed = trimmed.slice(-keep);
    json = JSON.stringify(trimmed);
  }

  return json;
}

export function deserializeHistory(raw: string | null | undefined): HistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as HistoryEntry[];
  } catch {
    return [];
  }
}
