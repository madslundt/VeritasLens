// tests/contracts/network-whitelist.test.ts
//
// Every fetch call site reachable in production must target a host that
// `app.json.permissions[network].whitelist` declares. The Even App runtime
// blocks any request to an undeclared host, so a typo'd URL or a new fetch
// added to an unwhitelisted host manifests as a 404 / network failure at
// install-review time — exactly the regression that bit us in 0.8.1.
//
// This file pins the contract three ways:
//   1. Every static `https://…` URL literal in production source is on the
//      whitelist. (Static-grep.)
//   2. Every entry in OPENAI_BASE_URLS is on the whitelist. (Type-level
//      enforcement; this file is the assertion.)
//   3. No code on the boot path makes an unsolicited network request.
//      0.8.1 (`HEAD /$discovery/rest`) and 0.8.2 (`GET /v1beta/models`) were
//      both rejected by the store reviewer's network monitor — the only safe
//      posture is "fetch on explicit user gesture only". `src/main.tsx` and
//      `src/runtime/lifecycle.ts` must not call `fetch(` and must not contain
//      any `prewarm*` helper.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import appJson from '../../app.json';
import { OPENAI_BASE_URLS } from '../../src/types';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

const networkPermission = (appJson.permissions ?? []).find(
  (p) => (p as { name?: string }).name === 'network',
) as { name: string; whitelist?: string[] } | undefined;
const whitelistOrigins = (networkPermission?.whitelist ?? []).map((u) => new URL(u).origin);

function allTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...allTsFiles(full));
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const URL_LITERAL = /https:\/\/[A-Za-z0-9.-]+(?:\:\d+)?(?:\/[^\s'"`]*)?/g;

// Comment markers we trust — references to docs / vendor URLs in JSDoc
// shouldn't trip the contract. We match against the *line*, so a URL on a
// commented line is excluded.
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

// Attributes that produce navigation in the host browser, not a WebView fetch.
// The Even App network whitelist applies to in-app HTTP requests; external
// links open outside the WebView and don't need to be on it.
const NAVIGATION_ATTRS = /(?:href|src|cite|action|formaction|poster)\s*=\s*["'`]?$/;

// Heuristic: was this URL written as an HTML/JSX navigation attribute? If so,
// it's a user-facing link, not a fetch site, and is out of scope for the
// whitelist contract.
function isNavigationAttribute(line: string, urlStart: number): boolean {
  const prefix = line.slice(0, urlStart);
  return NAVIGATION_ATTRS.test(prefix);
}

describe('network whitelist contract', () => {
  it('app.json declares a network permission with a whitelist', () => {
    expect(networkPermission).toBeDefined();
    expect(whitelistOrigins.length).toBeGreaterThan(0);
  });

  it('every OPENAI_BASE_URLS host is whitelisted', () => {
    for (const baseUrl of OPENAI_BASE_URLS) {
      const origin = new URL(baseUrl).origin;
      expect(whitelistOrigins, `whitelist missing origin for ${baseUrl}`)
        .toContain(origin);
    }
  });

  it('every static https:// URL literal in src/ targets a whitelisted host', () => {
    const offenders: Array<{ file: string; line: number; url: string }> = [];
    for (const file of allTsFiles(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (isCommentLine(line)) continue;
        for (const m of line.matchAll(URL_LITERAL)) {
          if (m.index === undefined) continue;
          if (isNavigationAttribute(line, m.index)) continue;
          // Strip trailing punctuation that crept past the regex.
          const cleaned = m[0].replace(/[),.;:!?]+$/, '');
          let origin: string;
          try {
            origin = new URL(cleaned).origin;
          } catch {
            continue;
          }
          if (!whitelistOrigins.includes(origin)) {
            offenders.push({
              file: relative(REPO_ROOT, file),
              line: i + 1,
              url: cleaned,
            });
          }
        }
      }
    }
    expect(
      offenders,
      `unwhitelisted hosts found:\n${offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.url}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('the boot path makes no unsolicited fetch and exposes no prewarm helper', () => {
    // Pins the 0.9.0 posture: every fetch must be triggered by an explicit
    // user gesture (lens run, settings dropdown focus, Test button). The boot
    // path — `main.tsx` and `lifecycle.ts` — must contain neither `fetch(`
    // nor a `prewarm*` symbol nor any `/$discovery/rest` literal that an
    // earlier release used.
    for (const rel of ['main.tsx', join('runtime', 'lifecycle.ts')]) {
      const text = readFileSync(join(SRC_ROOT, rel), 'utf8');
      expect(text, `${rel} should not call fetch directly`).not.toMatch(/\bfetch\(/);
      expect(text, `${rel} should not declare a prewarm helper`).not.toMatch(/\bprewarm\w*/i);
      expect(text, `${rel} should not reference Google's discovery endpoint`)
        .not.toMatch(/\$discovery/);
    }
  });
});
