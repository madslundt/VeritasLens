import { normalizeOpenAiBaseUrl } from '@veritaslens/core';

/** Alternate addresses of one server, in the wearer's chosen order. */
export function parseFallbackUrls(text: string, primary: string): string[] {
  const primaryUrl = normalizeOpenAiBaseUrl(primary);
  const urls = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map(normalizeOpenAiBaseUrl);
  return [...new Set(urls)].filter((url) => url !== primaryUrl);
}

/** Ignore damaged persisted entries while preserving other servers' settings. */
export function restoreFallbackUrls(raw: string | null): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
    for (const [primary, values] of Object.entries(parsed)) {
      if (!Array.isArray(values)) continue;
      try {
        const normalized = normalizeOpenAiBaseUrl(primary);
        const valid: string[] = [];
        for (const value of values) {
          if (typeof value !== 'string') continue;
          try { valid.push(normalizeOpenAiBaseUrl(value)); } catch { /* skip damaged URL */ }
        }
        result[normalized] = [...new Set(valid)].filter((url) => url !== normalized);
      } catch { /* skip damaged primary URL */ }
    }
  } catch { /* damaged JSON must not prevent startup */ }
  return result;
}
