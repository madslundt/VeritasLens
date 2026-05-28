// tests/contracts/no-hardcoded-models.test.ts
//
// `src/types.ts` is the single source of truth for which models the app
// knows about. Any module under `src/llm/`, `src/runtime/`, `src/personas/`,
// `src/state/`, or the entrypoint `src/main.tsx` that hardcodes a
// `gemini-2.5-flash`, `gpt-4o-mini`, or `whisper-1` literal is a place
// where a future edit can silently override the user's selected model —
// exactly the regression class the user reported.
//
// `src/views/` is explicitly out of scope: settings UI legitimately
// displays example model names to users as placeholders / hints.
//
// Trailing `// …` comments are stripped before matching so a regex-filter
// line that documents what it filters via an example in the comment
// (e.g. `/-tts(\b|-)/i,  // gemini-2.5-flash-preview-tts`) doesn't trip.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

const ALLOWED_FILES = new Set<string>([
  // The single source of truth for known model names + their patterns.
  join(SRC_ROOT, 'types.ts'),
]);

// Subtrees in src/ we scan. `views/` is out of scope (renders UI placeholders
// and examples to the user). Everything that *calls* the LLM lives here.
const SCANNED_SUBTREES = [
  join(SRC_ROOT, 'llm'),
  join(SRC_ROOT, 'runtime'),
  join(SRC_ROOT, 'personas'),
  join(SRC_ROOT, 'state'),
];
const SCANNED_FILES = [join(SRC_ROOT, 'main.tsx')];

// Strip a trailing `// …` line comment. Quoted contexts are rare in this
// codebase and the false-positive cost of treating "//" inside a string as
// a comment is acceptable here — this test exists to catch model literals
// in call-site code, not to perform lossless lexing.
function stripTrailingComment(line: string): string {
  const idx = line.indexOf('//');
  if (idx < 0) return line;
  return line.slice(0, idx);
}

// Patterns we treat as model-name literals. Each requires the model name to
// be inside a quoted string ('foo', "foo", or `foo`) — that's what a real
// call-site override looks like. Regex literals (`/-tts/i`), JSX text, and
// bare identifiers are out of scope.
//
// We deliberately exclude bare "gemini" / "openai" identifiers — those
// legitimately appear in branch conditions and provider tags.
const MODEL_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'gemini-<n>', re: /['"`]gemini-\d[^'"`]*['"`]/ },
  { name: 'gpt-<n>',    re: /['"`]gpt-\d[^'"`]*['"`]/ },
  { name: 'whisper-',   re: /['"`]whisper-[^'"`]*['"`]/ },
];

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

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function filesToScan(): string[] {
  const out: string[] = [...SCANNED_FILES];
  for (const root of SCANNED_SUBTREES) out.push(...allTsFiles(root));
  return out.filter((f) => !ALLOWED_FILES.has(f));
}

describe('no hardcoded model names in LLM call-site code', () => {
  for (const pattern of MODEL_PATTERNS) {
    it(`no LLM call-site file contains a literal ${pattern.name}`, () => {
      const offenders: Array<{ file: string; line: number; text: string }> = [];
      for (const file of filesToScan()) {
        const text = readFileSync(file, 'utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i]!;
          if (isCommentLine(raw)) continue;
          const code = stripTrailingComment(raw);
          if (pattern.re.test(code)) {
            offenders.push({
              file: relative(REPO_ROOT, file),
              line: i + 1,
              text: raw.trim(),
            });
          }
        }
      }
      expect(
        offenders,
        `found ${pattern.name} literal outside src/types.ts:\n${offenders
          .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
          .join('\n')}`,
      ).toEqual([]);
    });
  }
});
