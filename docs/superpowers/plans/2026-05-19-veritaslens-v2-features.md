# VeritasLens v2 Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace custom lenses with 7 polished built-in lenses (each with its own HUD format), add configurable buffer duration, a session history system on HUD and phone, and an optional background auto-summarizer.

**Architecture:** Each built-in lens owns its Gemini prompt, response schema, and parser; all parsers return a `LensResult` union type that drives per-lens HUD renderers. A `sessionHistory` signal accumulates entries; the HUD gains history-list and history-detail pages behind the existing menu. The Gemini client is generalized to `callLens()` which accepts any prompt+schema and returns raw JSON text.

**Tech Stack:** SolidJS + TypeScript, Vitest, Vite, Even Realities Hub SDK, Gemini REST API.

---

## File Map

### New files
| File | Purpose |
|---|---|
| `src/personas/_utils.ts` | Shared `trimTo`, `isRecord`, `parseJsonResponse` helpers |
| `src/personas/trivia.ts` | Trivia lens |
| `src/personas/logicalFallacy.ts` | Logical fallacy lens |
| `src/personas/statsCheck.ts` | Stats sanity check lens |
| `src/personas/biasDetector.ts` | Bias detector lens |
| `src/personas/translation.ts` | Translation lens |
| `src/personas/eli5.ts` | ELI5 / jargon explainer lens |
| `src/personas/sessionSummary.ts` | Session summary lens |
| `tests/personas.test.ts` | Parse function tests for all lenses |

### Modified files
| File | Key changes |
|---|---|
| `src/types.ts` | Add `LensResult`, `HistoryEntry`, `BufferDuration`, `AutoSummaryInterval`; update `Settings`; remove `Verdict` |
| `src/personas/factChecker.ts` | `buildPrompt(lang)` replaces static prompt; `parse` returns `LensResult` |
| `src/personas/index.ts` | Update `Persona` interface; remove custom lens code; add `getPickerPersonas()` |
| `src/llm/gemini.ts` | Add `callLens()`; simplify `runSelfTest()`; remove `factCheck()` |
| `src/state/store.ts` | `verdict` to `lensResult`; remove custom persona state; add `sessionHistory`, `pushHistoryEntry`, buffer/auto-summary settings |
| `src/runtime/hud.ts` | Per-lens renderer `setLensResult()`; history list/detail pages; History menu option |
| `src/runtime/lifecycle.ts` | `runFactCheck()` to `runAnalysis()`; push history; auto-summarizer timer; history gesture handling |
| `src/views/SettingsView.tsx` | Remove custom lens UI; add buffer duration, auto-summary, session log |

---

## Task 1: Foundation types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Replace `src/types.ts` with the following**

```typescript
// src/types.ts

/** Result union — every built-in lens returns one of these shapes. */
export type LensResult =
  | { type: 'fact-check'; verdict: 'TRUE' | 'FALSE' | 'UNVERIFIED'; claim: string; reason: string }
  | { type: 'trivia'; answer: string; description: string }
  | { type: 'logical-fallacy'; fallacy: string; explanation: string }
  | { type: 'stats-check'; verdict: 'PLAUSIBLE' | 'SUSPICIOUS'; stat: string; reason: string }
  | { type: 'bias'; verdict: 'NEUTRAL' | 'BIASED'; direction: string; reason: string }
  | { type: 'translation'; translatedText: string }
  | { type: 'eli5'; explanation: string }
  | { type: 'session-summary'; summary: string };

/** One entry in the in-memory session history. */
export interface HistoryEntry {
  id: string;
  timestamp: number;
  lensId: string;
  lensName: string;
  /** Short preview label shown in the history list. */
  question: string;
  /** Compact verdict badge (TRUE / PLAUSIBLE / BIASED / ANSWER / etc.). */
  badge: string;
  result: LensResult;
}

/** Gemini models known to accept inline audio input. */
export const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
] as const;

export type GeminiModel = (typeof GEMINI_MODELS)[number];
export const DEFAULT_GEMINI_MODEL: GeminiModel = 'gemini-2.0-flash';

export const LANGUAGES: Record<string, string> = {
  en: 'English',
  da: 'Dansk',
  sv: 'Svenska',
  no: 'Norsk',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  pt: 'Português',
  nl: 'Nederlands',
  pl: 'Polski',
};

export type LanguageCode = keyof typeof LANGUAGES;
export const DEFAULT_LANGUAGE: LanguageCode = 'en';

/** Seconds the rolling PCM buffer holds. */
export type BufferDuration = 30 | 120 | 300 | 600;
export const DEFAULT_BUFFER_DURATION: BufferDuration = 30;

/** Minutes between automatic background summaries. */
export type AutoSummaryInterval = 1 | 2 | 5;
export const DEFAULT_AUTO_SUMMARY_INTERVAL: AutoSummaryInterval = 2;

/** User-configurable settings persisted via the SDK bridge local storage. */
export interface Settings {
  geminiApiKey: string;
  geminiModel: GeminiModel;
  responseLanguage: LanguageCode;
  bufferDuration: BufferDuration;
  autoSummaryEnabled: boolean;
  autoSummaryInterval: AutoSummaryInterval;
}

/** Runtime app state. */
export type AppPhase =
  | 'booting'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'displaying'
  | 'sleeping'
  | 'error';

/** Mode the bundle is running in, determined by SDK LaunchSource. */
export type AppMode = 'settings' | 'hud';
```

- [ ] **Step 2: Run lint (downstream errors expected — fix in later tasks)**

```bash
npm run lint
```

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add LensResult union type, HistoryEntry, extended Settings fields"
```

---

## Task 2: Shared persona utilities

**Files:**
- Create: `src/personas/_utils.ts`
- Create: `tests/personas.test.ts`

- [ ] **Step 1: Create `src/personas/_utils.ts`**

```typescript
// src/personas/_utils.ts

export function trimTo(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse a JSON object from a Gemini text response.
 * Falls back to fenced-JSON extraction if the response has extra prose.
 */
export function parseJsonResponse(text: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const fenced = /\{[\s\S]*\}/.exec(text);
    if (!fenced) throw new Error('Gemini response was not JSON.');
    raw = JSON.parse(fenced[0]);
  }
  if (!isRecord(raw)) throw new Error('Gemini response was not a JSON object.');
  return raw;
}
```

- [ ] **Step 2: Create `tests/personas.test.ts`**

```typescript
// tests/personas.test.ts
import { describe, it, expect } from 'vitest';
import { trimTo, isRecord, parseJsonResponse } from '../src/personas/_utils';

describe('_utils', () => {
  it('trimTo leaves short strings unchanged', () => {
    expect(trimTo('hello', 10)).toBe('hello');
  });

  it('trimTo truncates long strings with ellipsis', () => {
    expect(trimTo('hello world', 8)).toBe('hello w…');
  });

  it('isRecord returns true for plain objects', () => {
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('isRecord returns false for arrays and primitives', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord('str')).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it('parseJsonResponse parses clean JSON', () => {
    const result = parseJsonResponse('{"answer":"Paris"}');
    expect(result['answer']).toBe('Paris');
  });

  it('parseJsonResponse extracts fenced JSON from prose', () => {
    const result = parseJsonResponse('Here is the result: {"answer":"Berlin"} done.');
    expect(result['answer']).toBe('Berlin');
  });

  it('parseJsonResponse throws if no JSON found', () => {
    expect(() => parseJsonResponse('no json here')).toThrow();
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: `_utils` suite passes (7 tests).

- [ ] **Step 4: Commit**

```bash
git add src/personas/_utils.ts tests/personas.test.ts
git commit -m "feat: add shared persona parse utilities and test skeleton"
```

---

## Task 3: Generic Gemini client

**Files:**
- Modify: `src/llm/gemini.ts`

- [ ] **Step 1: Replace `src/llm/gemini.ts`**

```typescript
// src/llm/gemini.ts
import { uint8ToBase64, encodePcmToWav } from '@/runtime/audioBuffer';
import { FACT_CHECKER_PROMPT, FACT_CHECKER_SCHEMA } from '@/personas/factChecker';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_LANGUAGE,
  LANGUAGES,
  type GeminiModel,
  type LanguageCode,
} from '@/types';

const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

export interface CallLensOptions {
  apiKey: string;
  /** WAV-encoded audio bytes. */
  wav: Uint8Array;
  /** Fully-built, language-aware system prompt. */
  prompt: string;
  /** Gemini responseSchema object. */
  schema: Record<string, unknown>;
  signal?: AbortSignal;
  model?: GeminiModel | string;
}

/**
 * Send audio + prompt to Gemini and return the raw JSON text from the response.
 * Each lens's parse() function handles decoding the JSON.
 */
export async function callLens(opts: CallLensOptions): Promise<string> {
  if (!opts.apiKey) throw new Error('Missing Gemini API key.');

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: opts.prompt },
          { inlineData: { mimeType: 'audio/wav', data: uint8ToBase64(opts.wav) } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: opts.schema,
    },
  };

  const response = await fetch(
    `${ENDPOINT(opts.model ?? DEFAULT_GEMINI_MODEL)}?key=${encodeURIComponent(opts.apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    },
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${truncate(errText, 200)}`);
  }

  const payload = (await response.json()) as GenerateContentResponse;
  if (payload.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the prompt: ${payload.promptFeedback.blockReason}`);
  }
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text candidate.');
  return text;
}

/**
 * Reachability probe used by Settings "Run self-test".
 * Sends 1 second of silence and reports latency.
 */
export async function runSelfTest(
  apiKey: string,
  model?: GeminiModel | string,
  language?: LanguageCode,
): Promise<{ latencyMs: number }> {
  const silentPcm = new Uint8Array(16_000 * 2);
  const wav = encodePcmToWav(silentPcm, { sampleRate: 16_000, bitsPerSample: 16, channels: 1 });
  const lang = language ?? DEFAULT_LANGUAGE;
  const langName = LANGUAGES[lang] ?? 'English';
  const prompt =
    `${FACT_CHECKER_PROMPT}\n\n` +
    `LANGUAGE: Write the \`claim\` and \`reason\` fields in ${langName}. ` +
    `The \`verdict\` field MUST stay as one of "TRUE", "FALSE", or "UNVERIFIED".`;
  const t0 = performance.now();
  await callLens({
    apiKey,
    wav,
    prompt,
    schema: FACT_CHECKER_SCHEMA as unknown as Record<string, unknown>,
    model,
  });
  return { latencyMs: Math.round(performance.now() - t0) };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
```

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

- [ ] **Step 3: Commit**

```bash
git add src/llm/gemini.ts
git commit -m "feat: generalize Gemini client to callLens(), simplify runSelfTest()"
```

---

## Task 4: Update fact-checker persona

**Files:**
- Modify: `src/personas/factChecker.ts`
- Modify: `tests/personas.test.ts`

- [ ] **Step 1: Add failing tests — append to `tests/personas.test.ts`**

```typescript
import { parseFactCheckerResponse, buildFactCheckerPrompt } from '../src/personas/factChecker';

describe('fact-checker', () => {
  it('parses a valid TRUE response', () => {
    const result = parseFactCheckerResponse(
      JSON.stringify({ verdict: 'TRUE', claim: 'Water boils at 100C.', reason: 'At sea level, yes.' }),
    );
    expect(result.type).toBe('fact-check');
    if (result.type === 'fact-check') {
      expect(result.verdict).toBe('TRUE');
      expect(result.claim).toBe('Water boils at 100C.');
    }
  });

  it('falls back to UNVERIFIED for unknown verdict', () => {
    const result = parseFactCheckerResponse(JSON.stringify({ verdict: 'MAYBE', claim: 'x', reason: 'y' }));
    if (result.type === 'fact-check') expect(result.verdict).toBe('UNVERIFIED');
  });

  it('buildFactCheckerPrompt includes the language name', () => {
    const prompt = buildFactCheckerPrompt('de');
    expect(prompt).toContain('Deutsch');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test
```

- [ ] **Step 3: Replace `src/personas/factChecker.ts`**

```typescript
// src/personas/factChecker.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

export const FACT_CHECKER_PROMPT = `You are VeritasLens, a real-time fact-check assistant for smart glasses.

The user just provided a short audio clip of recent conversation. Listen carefully and:

1. Identify the SINGLE most check-worthy factual claim in the audio. If multiple, pick the most consequential or most verifiable.
2. Classify the claim as one of:
   - "TRUE"  : Widely supported by reliable knowledge.
   - "FALSE" : Contradicted by reliable knowledge.
   - "UNVERIFIED" : Cannot confidently classify (opinion, future event, niche fact, ambiguous wording, no check-worthy claim at all).
3. Produce a short claim summary as ONE concise sentence (no more than 110 characters). Phrase it as a statement, not a question.
4. Produce an explanation of 2-3 short sentences (no more than 240 characters total) that justifies the verdict with specific reasoning.

Output strict JSON matching the provided schema. Do not add prose outside JSON.
Do not invent facts. Prefer "UNVERIFIED" over guessing.`;

export function buildFactCheckerPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return (
    `${FACT_CHECKER_PROMPT}\n\n` +
    `LANGUAGE: Write the \`claim\` and \`reason\` fields in ${langName}. ` +
    `The \`verdict\` field MUST stay as one of the literal strings "TRUE", "FALSE", or "UNVERIFIED" regardless of language.`
  );
}

export const FACT_CHECKER_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['TRUE', 'FALSE', 'UNVERIFIED'] },
    claim: { type: 'string', description: 'One concise sentence summarizing the claim (max 110 chars).' },
    reason: { type: 'string', description: '2-3 short sentences justifying the verdict (max 240 chars).' },
  },
  required: ['verdict', 'claim', 'reason'],
} as const;

export function parseFactCheckerResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const verdict = normalizeFactVerdict(raw['verdict']);
  return {
    type: 'fact-check',
    verdict,
    claim: trimTo(typeof raw['claim'] === 'string' ? raw['claim'] : '', 110),
    reason: trimTo(typeof raw['reason'] === 'string' ? raw['reason'] : '', 240),
  };
}

function normalizeFactVerdict(value: unknown): 'TRUE' | 'FALSE' | 'UNVERIFIED' {
  if (typeof value !== 'string') return 'UNVERIFIED';
  const upper = value.trim().toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return upper;
  return 'UNVERIFIED';
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/personas/factChecker.ts tests/personas.test.ts
git commit -m "feat: update fact-checker to return LensResult, add buildFactCheckerPrompt(lang)"
```

---

## Task 5: Trivia persona

**Files:**
- Create: `src/personas/trivia.ts`
- Modify: `tests/personas.test.ts`

- [ ] **Step 1: Append failing test to `tests/personas.test.ts`**

```typescript
import { parseTriviaResponse, buildTriviaPrompt } from '../src/personas/trivia';

describe('trivia', () => {
  it('parses a valid trivia response', () => {
    const result = parseTriviaResponse(
      JSON.stringify({ answer: 'Paris', description: 'Capital of France since the 10th century.' }),
    );
    expect(result.type).toBe('trivia');
    if (result.type === 'trivia') {
      expect(result.answer).toBe('Paris');
      expect(result.description).toContain('France');
    }
  });

  it('truncates long answers to 60 chars', () => {
    const long = 'A'.repeat(100);
    const result = parseTriviaResponse(JSON.stringify({ answer: long, description: 'ok' }));
    if (result.type === 'trivia') expect(result.answer.length).toBeLessThanOrEqual(60);
  });

  it('buildTriviaPrompt includes the language name', () => {
    const prompt = buildTriviaPrompt('fr');
    expect(prompt).toContain('Français');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test
```

- [ ] **Step 3: Create `src/personas/trivia.ts`**

```typescript
// src/personas/trivia.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

const TRIVIA_BASE_PROMPT = `You are VeritasLens, a trivia assistant for smart glasses.

The user just provided an audio clip likely containing a trivia question or factual question.

1. Identify the question being asked.
2. Provide the correct, definitive answer in one short phrase (max 60 characters).
3. Provide one brief explanatory sentence (max 180 characters) with an interesting supporting fact.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildTriviaPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${TRIVIA_BASE_PROMPT}\n\nLANGUAGE: Write \`answer\` and \`description\` in ${langName}.`;
}

export const TRIVIA_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'The correct answer (max 60 chars).' },
    description: { type: 'string', description: 'One interesting supporting fact (max 180 chars).' },
  },
  required: ['answer', 'description'],
} as const;

export function parseTriviaResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  return {
    type: 'trivia',
    answer: trimTo(typeof raw['answer'] === 'string' ? raw['answer'] : '', 60),
    description: trimTo(typeof raw['description'] === 'string' ? raw['description'] : '', 180),
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/personas/trivia.ts tests/personas.test.ts
git commit -m "feat: add Trivia lens"
```

---

## Task 6: Logical fallacy persona

**Files:**
- Create: `src/personas/logicalFallacy.ts`
- Modify: `tests/personas.test.ts`

- [ ] **Step 1: Append failing test**

```typescript
import { parseLogicalFallacyResponse } from '../src/personas/logicalFallacy';

describe('logical-fallacy', () => {
  it('parses a valid response', () => {
    const result = parseLogicalFallacyResponse(
      JSON.stringify({ fallacy: 'Ad Hominem', explanation: 'Attacking the person, not the argument.' }),
    );
    expect(result.type).toBe('logical-fallacy');
    if (result.type === 'logical-fallacy') expect(result.fallacy).toBe('Ad Hominem');
  });

  it('returns Unknown fallacy on missing field', () => {
    const result = parseLogicalFallacyResponse(JSON.stringify({ explanation: 'ok' }));
    if (result.type === 'logical-fallacy') expect(result.fallacy).toBe('Unknown');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test
```

- [ ] **Step 3: Create `src/personas/logicalFallacy.ts`**

```typescript
// src/personas/logicalFallacy.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a logical reasoning assistant for smart glasses.

The user just provided an audio clip of recent conversation. Analyze it and:

1. Identify whether a logical fallacy is present in the argument or statement.
2. If a fallacy is found, name it precisely (e.g. "Strawman", "Ad Hominem", "False Dilemma", "Appeal to Authority").
3. If no fallacy is found, use "None detected".
4. Provide a brief explanation (max 200 characters) of why this is or is not a fallacy.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildLogicalFallacyPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write \`explanation\` in ${langName}. Keep \`fallacy\` as the English name.`;
}

export const LOGICAL_FALLACY_SCHEMA = {
  type: 'object',
  properties: {
    fallacy: { type: 'string', description: 'Name of the logical fallacy, or "None detected".' },
    explanation: { type: 'string', description: 'Why this is or is not a fallacy (max 200 chars).' },
  },
  required: ['fallacy', 'explanation'],
} as const;

export function parseLogicalFallacyResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  return {
    type: 'logical-fallacy',
    fallacy: trimTo(typeof raw['fallacy'] === 'string' ? raw['fallacy'] : 'Unknown', 40),
    explanation: trimTo(typeof raw['explanation'] === 'string' ? raw['explanation'] : '', 200),
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/personas/logicalFallacy.ts tests/personas.test.ts
git commit -m "feat: add Logical Fallacy lens"
```

---

## Task 7: Stats check persona

**Files:**
- Create: `src/personas/statsCheck.ts`
- Modify: `tests/personas.test.ts`

- [ ] **Step 1: Append failing test**

```typescript
import { parseStatsCheckResponse } from '../src/personas/statsCheck';

describe('stats-check', () => {
  it('parses a PLAUSIBLE response', () => {
    const result = parseStatsCheckResponse(
      JSON.stringify({ verdict: 'PLAUSIBLE', stat: '71% of the Earth is water', reason: 'Accurate figure.' }),
    );
    expect(result.type).toBe('stats-check');
    if (result.type === 'stats-check') expect(result.verdict).toBe('PLAUSIBLE');
  });

  it('defaults to SUSPICIOUS for unknown verdict', () => {
    const result = parseStatsCheckResponse(JSON.stringify({ verdict: 'UNKNOWN', stat: 'x', reason: 'y' }));
    if (result.type === 'stats-check') expect(result.verdict).toBe('SUSPICIOUS');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test
```

- [ ] **Step 3: Create `src/personas/statsCheck.ts`**

```typescript
// src/personas/statsCheck.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a statistical fact-check assistant for smart glasses.

The user just provided an audio clip of recent conversation. Analyze it and:

1. Identify the most specific numerical or statistical claim (percentage, count, ratio, price, date range).
2. Classify it as "PLAUSIBLE" (consistent with known data) or "SUSPICIOUS" (implausible or contradicted by known data).
3. Quote the specific stat being checked (max 100 chars).
4. Provide a 1-2 sentence justification (max 200 chars).

If no numerical claim is present, return verdict "PLAUSIBLE", stat "No numerical claim found", reason "Nothing to check."

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildStatsCheckPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write \`stat\` and \`reason\` in ${langName}.`;
}

export const STATS_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PLAUSIBLE', 'SUSPICIOUS'] },
    stat: { type: 'string', description: 'The specific stat being checked (max 100 chars).' },
    reason: { type: 'string', description: 'Justification (max 200 chars).' },
  },
  required: ['verdict', 'stat', 'reason'],
} as const;

export function parseStatsCheckResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const v = typeof raw['verdict'] === 'string' ? raw['verdict'].toUpperCase() : '';
  return {
    type: 'stats-check',
    verdict: v === 'PLAUSIBLE' ? 'PLAUSIBLE' : 'SUSPICIOUS',
    stat: trimTo(typeof raw['stat'] === 'string' ? raw['stat'] : '', 100),
    reason: trimTo(typeof raw['reason'] === 'string' ? raw['reason'] : '', 200),
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/personas/statsCheck.ts tests/personas.test.ts
git commit -m "feat: add Stats Check lens"
```

---

## Task 8: Bias detector persona

**Files:**
- Create: `src/personas/biasDetector.ts`
- Modify: `tests/personas.test.ts`

- [ ] **Step 1: Append failing test**

```typescript
import { parseBiasDetectorResponse } from '../src/personas/biasDetector';

describe('bias-detector', () => {
  it('parses a NEUTRAL response', () => {
    const result = parseBiasDetectorResponse(
      JSON.stringify({ verdict: 'NEUTRAL', direction: 'none', reason: 'Balanced statement.' }),
    );
    expect(result.type).toBe('bias');
    if (result.type === 'bias') expect(result.verdict).toBe('NEUTRAL');
  });

  it('parses a BIASED response', () => {
    const result = parseBiasDetectorResponse(
      JSON.stringify({ verdict: 'BIASED', direction: 'political-left', reason: 'Loaded language.' }),
    );
    if (result.type === 'bias') {
      expect(result.verdict).toBe('BIASED');
      expect(result.direction).toBe('political-left');
    }
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test
```

- [ ] **Step 3: Create `src/personas/biasDetector.ts`**

```typescript
// src/personas/biasDetector.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a bias detection assistant for smart glasses.

The user just provided an audio clip of recent conversation. Analyze it and:

1. Determine whether the statement or argument is "NEUTRAL" or "BIASED".
2. If biased, describe the direction concisely (e.g. "political-left", "political-right", "emotionally-loaded", "corporate", "nationalist") — max 30 characters.
3. Provide a 1-2 sentence explanation (max 200 characters) of the bias markers found.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildBiasDetectorPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write \`reason\` in ${langName}. Keep \`direction\` in English.`;
}

export const BIAS_DETECTOR_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['NEUTRAL', 'BIASED'] },
    direction: { type: 'string', description: 'Bias direction in English (max 30 chars).' },
    reason: { type: 'string', description: 'Explanation of bias markers (max 200 chars).' },
  },
  required: ['verdict', 'direction', 'reason'],
} as const;

export function parseBiasDetectorResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const v = typeof raw['verdict'] === 'string' ? raw['verdict'].toUpperCase() : '';
  return {
    type: 'bias',
    verdict: v === 'NEUTRAL' ? 'NEUTRAL' : 'BIASED',
    direction: trimTo(typeof raw['direction'] === 'string' ? raw['direction'] : '', 30),
    reason: trimTo(typeof raw['reason'] === 'string' ? raw['reason'] : '', 200),
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/personas/biasDetector.ts tests/personas.test.ts
git commit -m "feat: add Bias Detector lens"
```

---

## Task 9: Translation persona

**Files:**
- Create: `src/personas/translation.ts`
- Modify: `tests/personas.test.ts`

- [ ] **Step 1: Append failing test**

```typescript
import { parseTranslationResponse, buildTranslationPrompt } from '../src/personas/translation';

describe('translation', () => {
  it('parses a valid translation response', () => {
    const result = parseTranslationResponse(JSON.stringify({ translatedText: 'Bonjour le monde' }));
    expect(result.type).toBe('translation');
    if (result.type === 'translation') expect(result.translatedText).toBe('Bonjour le monde');
  });

  it('buildTranslationPrompt embeds the target language', () => {
    const prompt = buildTranslationPrompt('fr');
    expect(prompt).toContain('Français');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test
```

- [ ] **Step 3: Create `src/personas/translation.ts`**

```typescript
// src/personas/translation.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

export function buildTranslationPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `You are VeritasLens, a real-time translation assistant for smart glasses.

The user just provided an audio clip of recent conversation. Translate the spoken content into ${langName}.

Rules:
- Translate only; do not summarize or editorialize.
- If the audio is already in ${langName}, provide the original text unchanged.
- Keep the translation concise (max 300 characters).

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;
}

export const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    translatedText: { type: 'string', description: 'The translated text (max 300 chars).' },
  },
  required: ['translatedText'],
} as const;

export function parseTranslationResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  return {
    type: 'translation',
    translatedText: trimTo(typeof raw['translatedText'] === 'string' ? raw['translatedText'] : '', 300),
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/personas/translation.ts tests/personas.test.ts
git commit -m "feat: add Translation lens"
```

---

## Task 10: ELI5 persona

**Files:**
- Create: `src/personas/eli5.ts`
- Modify: `tests/personas.test.ts`

- [ ] **Step 1: Append failing test**

```typescript
import { parseEli5Response, buildEli5Prompt } from '../src/personas/eli5';

describe('eli5', () => {
  it('parses a valid ELI5 response', () => {
    const result = parseEli5Response(JSON.stringify({ explanation: 'It means the economy is shrinking.' }));
    expect(result.type).toBe('eli5');
    if (result.type === 'eli5') expect(result.explanation).toContain('economy');
  });

  it('buildEli5Prompt includes the language name', () => {
    const prompt = buildEli5Prompt('es');
    expect(prompt).toContain('Español');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test
```

- [ ] **Step 3: Create `src/personas/eli5.ts`**

```typescript
// src/personas/eli5.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a plain-language explainer for smart glasses.

The user just provided an audio clip of recent conversation containing jargon, technical terms, or complex language.

1. Identify the most complex or jargon-heavy statement.
2. Restate it in plain, simple language that anyone could understand — as if explaining to a curious 12-year-old.
3. Keep the explanation concise (max 240 characters).

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildEli5Prompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write \`explanation\` in ${langName}.`;
}

export const ELI5_SCHEMA = {
  type: 'object',
  properties: {
    explanation: { type: 'string', description: 'Plain-language restatement (max 240 chars).' },
  },
  required: ['explanation'],
} as const;

export function parseEli5Response(text: string): LensResult {
  const raw = parseJsonResponse(text);
  return {
    type: 'eli5',
    explanation: trimTo(typeof raw['explanation'] === 'string' ? raw['explanation'] : '', 240),
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/personas/eli5.ts tests/personas.test.ts
git commit -m "feat: add ELI5 lens"
```

---

## Task 11: Session summary persona

**Files:**
- Create: `src/personas/sessionSummary.ts`
- Modify: `tests/personas.test.ts`

- [ ] **Step 1: Append failing test**

```typescript
import { parseSessionSummaryResponse } from '../src/personas/sessionSummary';

describe('session-summary', () => {
  it('parses a valid summary response', () => {
    const result = parseSessionSummaryResponse(
      JSON.stringify({ summary: 'Discussed project timeline and budget.' }),
    );
    expect(result.type).toBe('session-summary');
    if (result.type === 'session-summary') expect(result.summary).toContain('project');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test
```

- [ ] **Step 3: Create `src/personas/sessionSummary.ts`**

```typescript
// src/personas/sessionSummary.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse } from './_utils';

const BASE_PROMPT = `You are VeritasLens, a conversation summarizer for smart glasses.

The user has provided an audio clip of a recent conversation segment. Summarize the key points discussed:

1. Identify the main topics covered.
2. Note any decisions made or action items mentioned.
3. Keep the summary concise (max 300 characters), written as 2-3 sentences.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

export function buildSessionSummaryPrompt(lang: LanguageCode): string {
  const langName = LANGUAGES[lang] ?? 'English';
  return `${BASE_PROMPT}\n\nLANGUAGE: Write \`summary\` in ${langName}.`;
}

export const SESSION_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Concise conversation summary (max 300 chars).' },
  },
  required: ['summary'],
} as const;

export function parseSessionSummaryResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  return {
    type: 'session-summary',
    summary: trimTo(typeof raw['summary'] === 'string' ? raw['summary'] : '', 300),
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/personas/sessionSummary.ts tests/personas.test.ts
git commit -m "feat: add Session Summary lens"
```

---

## Task 12: Update persona registry

**Files:**
- Modify: `src/personas/index.ts`

- [ ] **Step 1: Replace `src/personas/index.ts`**

```typescript
// src/personas/index.ts
import { createSignal } from 'solid-js';
import type { LensResult, LanguageCode } from '@/types';
import { FACT_CHECKER_SCHEMA, buildFactCheckerPrompt, parseFactCheckerResponse } from './factChecker';
import { TRIVIA_SCHEMA, buildTriviaPrompt, parseTriviaResponse } from './trivia';
import { LOGICAL_FALLACY_SCHEMA, buildLogicalFallacyPrompt, parseLogicalFallacyResponse } from './logicalFallacy';
import { STATS_CHECK_SCHEMA, buildStatsCheckPrompt, parseStatsCheckResponse } from './statsCheck';
import { BIAS_DETECTOR_SCHEMA, buildBiasDetectorPrompt, parseBiasDetectorResponse } from './biasDetector';
import { TRANSLATION_SCHEMA, buildTranslationPrompt, parseTranslationResponse } from './translation';
import { ELI5_SCHEMA, buildEli5Prompt, parseEli5Response } from './eli5';
import { SESSION_SUMMARY_SCHEMA, buildSessionSummaryPrompt, parseSessionSummaryResponse } from './sessionSummary';

export type PersonaId = string;

export interface Persona {
  id: PersonaId;
  name: string;
  description: string;
  hint: string;
  /** Returns the fully-built, language-aware system prompt. */
  buildPrompt: (lang: LanguageCode) => string;
  schema: Record<string, unknown>;
  parse: (text: string) => LensResult;
  builtin: true;
}

const BUILTINS: Persona[] = [
  {
    id: 'fact-checker',
    name: 'Fact-Checker',
    description: 'Labels the most check-worthy claim TRUE / FALSE / UNVERIFIED.',
    hint: 'Tap to fact-check',
    buildPrompt: buildFactCheckerPrompt,
    schema: FACT_CHECKER_SCHEMA as unknown as Record<string, unknown>,
    parse: parseFactCheckerResponse,
    builtin: true,
  },
  {
    id: 'trivia',
    name: 'Trivia',
    description: 'Answers trivia questions with a direct answer and brief description.',
    hint: 'Tap for the answer',
    buildPrompt: buildTriviaPrompt,
    schema: TRIVIA_SCHEMA as unknown as Record<string, unknown>,
    parse: parseTriviaResponse,
    builtin: true,
  },
  {
    id: 'logical-fallacy',
    name: 'Fallacy Detector',
    description: 'Names any logical fallacy present in the argument.',
    hint: 'Tap to check the argument',
    buildPrompt: buildLogicalFallacyPrompt,
    schema: LOGICAL_FALLACY_SCHEMA as unknown as Record<string, unknown>,
    parse: parseLogicalFallacyResponse,
    builtin: true,
  },
  {
    id: 'stats-check',
    name: 'Stats Check',
    description: 'Rates a numerical claim as PLAUSIBLE or SUSPICIOUS.',
    hint: 'Tap to check the numbers',
    buildPrompt: buildStatsCheckPrompt,
    schema: STATS_CHECK_SCHEMA as unknown as Record<string, unknown>,
    parse: parseStatsCheckResponse,
    builtin: true,
  },
  {
    id: 'bias-detector',
    name: 'Bias Detector',
    description: 'Detects political, emotional, or factional bias in statements.',
    hint: 'Tap to detect bias',
    buildPrompt: buildBiasDetectorPrompt,
    schema: BIAS_DETECTOR_SCHEMA as unknown as Record<string, unknown>,
    parse: parseBiasDetectorResponse,
    builtin: true,
  },
  {
    id: 'translation',
    name: 'Translation',
    description: 'Translates spoken words into your configured response language.',
    hint: 'Tap to translate',
    buildPrompt: buildTranslationPrompt,
    schema: TRANSLATION_SCHEMA as unknown as Record<string, unknown>,
    parse: parseTranslationResponse,
    builtin: true,
  },
  {
    id: 'eli5',
    name: 'ELI5',
    description: 'Explains jargon or complex statements in plain language.',
    hint: 'Tap to simplify',
    buildPrompt: buildEli5Prompt,
    schema: ELI5_SCHEMA as unknown as Record<string, unknown>,
    parse: parseEli5Response,
    builtin: true,
  },
  {
    id: 'session-summary',
    name: 'Session Summary',
    description: 'Summarizes the conversation recorded so far. Requires extended buffer.',
    hint: 'Tap to summarize',
    buildPrompt: buildSessionSummaryPrompt,
    schema: SESSION_SUMMARY_SCHEMA as unknown as Record<string, unknown>,
    parse: parseSessionSummaryResponse,
    builtin: true,
  },
];

const [personasSignal, setPersonasSignal] = createSignal<Persona[]>(BUILTINS);

export const personas = personasSignal;

export function getPersonas(): Persona[] {
  return personasSignal();
}

export function getPersona(id: PersonaId): Persona | undefined {
  return personasSignal().find((p) => p.id === id);
}

/**
 * Personas shown in the HUD picker.
 * Session Summary is hidden when buffer is 30 s — it needs a longer buffer to be useful.
 */
export function getPickerPersonas(bufferDuration: number): Persona[] {
  return personasSignal().filter((p) => p.id !== 'session-summary' || bufferDuration > 30);
}

export function _setPersonas(next: Persona[]): void {
  setPersonasSignal(next);
}

/** Legacy alias retained so existing imports compile. */
export const PERSONAS = personasSignal;
```

- [ ] **Step 2: Run lint and fix any errors**

```bash
npm run lint
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/personas/index.ts
git commit -m "feat: rebuild persona registry with 8 built-in lenses, remove custom lens code"
```

---

## Task 13: Update store

**Files:**
- Modify: `src/state/store.ts`

- [ ] **Step 1: Replace `src/state/store.ts`**

```typescript
// src/state/store.ts
import { createSignal } from 'solid-js';
import type { DeviceStatus } from '@evenrealities/even_hub_sdk';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_LANGUAGE,
  DEFAULT_BUFFER_DURATION,
  DEFAULT_AUTO_SUMMARY_INTERVAL,
  GEMINI_MODELS,
  LANGUAGES,
  type AppMode,
  type AppPhase,
  type AutoSummaryInterval,
  type BufferDuration,
  type GeminiModel,
  type HistoryEntry,
  type LanguageCode,
  type LensResult,
  type Settings,
} from '@/types';

const SETTINGS_KEY_GEMINI = 'veritaslens.geminiKey';
const SETTINGS_KEY_MODEL = 'veritaslens.geminiModel';
const SETTINGS_KEY_LANGUAGE = 'veritaslens.responseLanguage';
const SETTINGS_KEY_BUFFER_DURATION = 'veritaslens.bufferDuration';
const SETTINGS_KEY_AUTO_SUMMARY_ENABLED = 'veritaslens.autoSummaryEnabled';
const SETTINGS_KEY_AUTO_SUMMARY_INTERVAL = 'veritaslens.autoSummaryInterval';

export const [appMode, setAppMode] = createSignal<AppMode>('settings');
export const [appPhase, setAppPhase] = createSignal<AppPhase>('booting');
export const [activePersona, setActivePersona] = createSignal<string>('fact-checker');
export const [lensResult, setLensResult] = createSignal<LensResult | null>(null);
export const [deviceStatus, setDeviceStatus] = createSignal<DeviceStatus | null>(null);
export const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
export const [sessionHistory, setSessionHistory] = createSignal<HistoryEntry[]>([]);

const [settings, setSettings] = createSignal<Settings>({
  geminiApiKey: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  responseLanguage: DEFAULT_LANGUAGE,
  bufferDuration: DEFAULT_BUFFER_DURATION,
  autoSummaryEnabled: false,
  autoSummaryInterval: DEFAULT_AUTO_SUMMARY_INTERVAL,
});
export { settings };

export async function loadSettings(getLocalStorage: (k: string) => Promise<string>): Promise<void> {
  try {
    const [key, rawModel, rawLang, rawBuffer, rawAutoEnabled, rawAutoInterval] = await Promise.all([
      getLocalStorage(SETTINGS_KEY_GEMINI),
      getLocalStorage(SETTINGS_KEY_MODEL),
      getLocalStorage(SETTINGS_KEY_LANGUAGE),
      getLocalStorage(SETTINGS_KEY_BUFFER_DURATION),
      getLocalStorage(SETTINGS_KEY_AUTO_SUMMARY_ENABLED),
      getLocalStorage(SETTINGS_KEY_AUTO_SUMMARY_INTERVAL),
    ]);
    setSettings({
      geminiApiKey: key ?? '',
      geminiModel: coerceModel(rawModel),
      responseLanguage: coerceLanguage(rawLang),
      bufferDuration: coerceBufferDuration(rawBuffer),
      autoSummaryEnabled: rawAutoEnabled === 'true',
      autoSummaryInterval: coerceAutoSummaryInterval(rawAutoInterval),
    });
  } catch {
    setSettings({
      geminiApiKey: '',
      geminiModel: DEFAULT_GEMINI_MODEL,
      responseLanguage: DEFAULT_LANGUAGE,
      bufferDuration: DEFAULT_BUFFER_DURATION,
      autoSummaryEnabled: false,
      autoSummaryInterval: DEFAULT_AUTO_SUMMARY_INTERVAL,
    });
  }
}

export async function saveGeminiKey(setLs: (k: string, v: string) => Promise<boolean>, key: string): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_GEMINI, key);
  if (ok) setSettings({ ...settings(), geminiApiKey: key });
  return ok;
}

export async function saveGeminiModel(setLs: (k: string, v: string) => Promise<boolean>, model: GeminiModel): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_MODEL, model);
  if (ok) setSettings({ ...settings(), geminiModel: model });
  return ok;
}

export async function saveResponseLanguage(setLs: (k: string, v: string) => Promise<boolean>, language: LanguageCode): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_LANGUAGE, language);
  if (ok) setSettings({ ...settings(), responseLanguage: language });
  return ok;
}

export async function saveBufferDuration(setLs: (k: string, v: string) => Promise<boolean>, duration: BufferDuration): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_BUFFER_DURATION, String(duration));
  if (ok) setSettings({ ...settings(), bufferDuration: duration });
  return ok;
}

export async function saveAutoSummaryEnabled(setLs: (k: string, v: string) => Promise<boolean>, enabled: boolean): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_AUTO_SUMMARY_ENABLED, String(enabled));
  if (ok) setSettings({ ...settings(), autoSummaryEnabled: enabled });
  return ok;
}

export async function saveAutoSummaryInterval(setLs: (k: string, v: string) => Promise<boolean>, interval: AutoSummaryInterval): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_AUTO_SUMMARY_INTERVAL, String(interval));
  if (ok) setSettings({ ...settings(), autoSummaryInterval: interval });
  return ok;
}

/** Push a completed analysis result into the in-memory session history. */
export function pushHistoryEntry(entry: Omit<HistoryEntry, 'id' | 'timestamp'>): void {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  setSessionHistory((prev) => [...prev, { id, timestamp: Date.now(), ...entry }]);
}

export function clearSessionHistory(): void {
  setSessionHistory([]);
}

function coerceModel(raw: string | null | undefined): GeminiModel {
  if (raw && (GEMINI_MODELS as readonly string[]).includes(raw)) return raw as GeminiModel;
  return DEFAULT_GEMINI_MODEL;
}

function coerceLanguage(raw: string | null | undefined): LanguageCode {
  if (raw && raw in LANGUAGES) return raw as LanguageCode;
  return DEFAULT_LANGUAGE;
}

function coerceBufferDuration(raw: string | null | undefined): BufferDuration {
  const n = Number(raw);
  if (n === 30 || n === 120 || n === 300 || n === 600) return n;
  return DEFAULT_BUFFER_DURATION;
}

function coerceAutoSummaryInterval(raw: string | null | undefined): AutoSummaryInterval {
  const n = Number(raw);
  if (n === 1 || n === 2 || n === 5) return n;
  return DEFAULT_AUTO_SUMMARY_INTERVAL;
}

// ---------- Debug event log ----------

export interface DebugEvent { ts: number; label: string; detail: string; }

export const [debugEvents, setDebugEvents] = createSignal<DebugEvent[]>([]);

export function pushDebugEvent(entry: Omit<DebugEvent, 'ts'>): void {
  setDebugEvents((prev) => [{ ts: Date.now(), ...entry }, ...prev].slice(0, 40));
}

export function clearDebugEvents(): void {
  setDebugEvents([]);
}
```

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: errors in `lifecycle.ts` and `hud.ts` referencing old exports — fix in Tasks 14–15.

- [ ] **Step 3: Commit**

```bash
git add src/state/store.ts
git commit -m "feat: update store — LensResult signal, session history, buffer/auto-summary settings"
```

---

## Task 14: Update HUD

**Files:**
- Modify: `src/runtime/hud.ts`

- [ ] **Step 1: Replace `src/runtime/hud.ts`** with the full file below. Key changes vs. current:
  - `setVerdict(v)` replaced by `setLensResult(result)` with per-lens `formatLensResult()` dispatcher
  - New containers: `historyList` (30), `historyHint` (31)
  - New `HudPage` values: `'history-list'`, `'history-detail'`
  - `MENU_OPTIONS` gains a `'history'` entry
  - `buildPickerPage` calls `getPickerPersonas(settings().bufferDuration)` instead of `getPersonas()`
  - New: `showHistoryListPage()`, `showHistoryDetailPage()`, `restoreHistoryListPage()`

```typescript
// src/runtime/hud.ts
import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';
import { getBridge } from './bridge';
import { getPickerPersonas, type Persona } from '@/personas';
import { settings } from '@/state/store';
import type { HistoryEntry, LensResult } from '@/types';

export const SCREEN_W = 576;
export const SCREEN_H = 288;

export const CONTAINER = {
  title: 10,
  pickerList: 11,
  pickerHint: 12,
  menuList: 13,
  status: 20,
  claim: 21,
  verdict: 22,
  reason: 23,
  activeList: 24,
  recIndicator: 25,
  historyList: 30,
  historyHint: 31,
} as const;

const NAME = {
  title: 'vl-title',
  pickerList: 'vl-pick-lst',
  pickerHint: 'vl-pkr-hint',
  menuList: 'vl-menu-lst',
  status: 'vl-status',
  claim: 'vl-claim',
  verdict: 'vl-verdict',
  reason: 'vl-reason',
  activeList: 'vl-act-lst',
  recIndicator: 'vl-rec',
  historyList: 'vl-hist-lst',
  historyHint: 'vl-hist-hint',
} as const;

const STATUS_LABEL: Record<string, string> = {
  idle: '  OK  ',
  listening: ' MIC  ',
  thinking: ' ...  ',
  displaying: '  ✓   ',
  sleeping: ' ZZZ  ',
  error: ' ERR  ',
};

export type HudPage = 'unconfigured' | 'picker' | 'active' | 'menu' | 'history-list' | 'history-detail' | 'none';

export const MENU_OPTIONS = [
  { id: 'fact-check', label: 'Check' },
  { id: 'history', label: 'History' },
  { id: 'cancel', label: 'Cancel' },
  { id: 'exit', label: 'Exit' },
] as const;
export type MenuOptionId = (typeof MENU_OPTIONS)[number]['id'];

let bootstrapped = false;
let currentPage: HudPage = 'none';
let menuPersona: Persona | null = null;
let cachedHistoryEntries: HistoryEntry[] = [];

export function currentHudPage(): HudPage { return currentPage; }

export function personaAtIndex(idx: number | undefined | null): Persona | null {
  const list = getPickerPersonas(settings().bufferDuration);
  const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
  return list[safe] ?? list[0] ?? null;
}

export function menuOptionAtIndex(idx: number | undefined | null): MenuOptionId {
  const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
  return MENU_OPTIONS[safe]?.id ?? 'fact-check';
}

export async function bootstrapHud(initialPage: 'unconfigured' | 'picker' = 'picker'): Promise<void> {
  if (bootstrapped) {
    if (initialPage === 'unconfigured') await showUnconfiguredPage();
    else await showPickerPage();
    return;
  }
  const page = initialPage === 'unconfigured' ? buildUnconfiguredPage('create') : buildPickerPage('create');
  const result = await getBridge().createStartUpPageContainer(page as CreateStartUpPageContainer);
  if (result !== StartUpPageCreateResult.success) throw new Error(`createStartUpPageContainer failed (code ${result}).`);
  bootstrapped = true;
  currentPage = initialPage;
}

export async function showUnconfiguredPage(): Promise<void> {
  if (!bootstrapped) { await bootstrapHud('unconfigured'); return; }
  const ok = await getBridge().rebuildPageContainer(buildUnconfiguredPage('rebuild') as RebuildPageContainer);
  if (!ok) throw new Error('rebuildPageContainer (unconfigured) failed.');
  currentPage = 'unconfigured';
}

export async function showPickerPage(): Promise<void> {
  if (!bootstrapped) { await bootstrapHud('picker'); return; }
  const ok = await getBridge().rebuildPageContainer(buildPickerPage('rebuild') as RebuildPageContainer);
  if (!ok) throw new Error('rebuildPageContainer (picker) failed.');
  currentPage = 'picker';
}

export async function showActivePage(persona: Persona): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showActivePage().');
  menuPersona = persona;
  const ok = await getBridge().rebuildPageContainer(buildActivePage());
  if (!ok) throw new Error('rebuildPageContainer (active) failed.');
  currentPage = 'active';
}

export async function showMenuPage(): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showMenuPage().');
  const ok = await getBridge().rebuildPageContainer(buildMenuPage());
  if (!ok) throw new Error('rebuildPageContainer (menu) failed.');
  currentPage = 'menu';
}

export async function showHistoryListPage(entries: HistoryEntry[]): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showHistoryListPage().');
  cachedHistoryEntries = entries;
  const ok = await getBridge().rebuildPageContainer(buildHistoryListPage(entries));
  if (!ok) throw new Error('rebuildPageContainer (history-list) failed.');
  currentPage = 'history-list';
}

export async function showHistoryDetailPage(entry: HistoryEntry): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showHistoryDetailPage().');
  const ok = await getBridge().rebuildPageContainer(buildHistoryDetailPage(entry));
  if (!ok) throw new Error('rebuildPageContainer (history-detail) failed.');
  currentPage = 'history-detail';
}

export async function restoreHistoryListPage(): Promise<void> {
  await showHistoryListPage(cachedHistoryEntries);
}

export async function restoreActivePage(): Promise<void> {
  if (!menuPersona) return;
  await showActivePage(menuPersona);
}

export async function setStatus(label: keyof typeof STATUS_LABEL | string): Promise<void> {
  if (currentPage !== 'active') return;
  const content = STATUS_LABEL[label] ?? `[${label.slice(0, 14)}]`;
  await upgradeText(CONTAINER.status, NAME.status, content);
}

export async function setLensResult(result: LensResult | null): Promise<void> {
  if (currentPage !== 'active' && currentPage !== 'history-detail') return;
  if (!result) {
    await Promise.all([
      upgradeText(CONTAINER.claim, NAME.claim, ''),
      upgradeText(CONTAINER.verdict, NAME.verdict, ''),
      upgradeText(CONTAINER.reason, NAME.reason, ''),
    ]);
    return;
  }
  const { top, middle, bottom } = formatLensResult(result);
  await Promise.all([
    upgradeText(CONTAINER.claim, NAME.claim, top),
    upgradeText(CONTAINER.verdict, NAME.verdict, middle),
    upgradeText(CONTAINER.reason, NAME.reason, bottom),
  ]);
}

export async function setRecIndicator(on: boolean): Promise<void> {
  if (currentPage !== 'active') return;
  await upgradeText(CONTAINER.recIndicator, NAME.recIndicator, on ? '● REC' : '');
}

async function upgradeText(containerID: number, containerName: string, content: string): Promise<void> {
  const upgrade = new TextContainerUpgrade({ containerID, containerName, contentOffset: 0, contentLength: content.length, content });
  await getBridge().textContainerUpgrade(upgrade);
}

function formatLensResult(result: LensResult): { top: string; middle: string; bottom: string } {
  switch (result.type) {
    case 'fact-check':
      return {
        top: clip(result.claim, 140),
        middle: result.verdict === 'TRUE' ? '✓ TRUE' : result.verdict === 'FALSE' ? '✗ FALSE' : '? UNVERIFIED',
        bottom: clip(result.reason, 240),
      };
    case 'trivia':
      return { top: 'Trivia Answer', middle: clip(result.answer, 140), bottom: clip(result.description, 240) };
    case 'logical-fallacy':
      return { top: 'Logical Fallacy', middle: result.fallacy.toUpperCase(), bottom: clip(result.explanation, 240) };
    case 'stats-check':
      return {
        top: clip(result.stat, 140),
        middle: result.verdict === 'PLAUSIBLE' ? '✓ PLAUSIBLE' : '✗ SUSPICIOUS',
        bottom: clip(result.reason, 240),
      };
    case 'bias':
      return {
        top: 'Bias Analysis',
        middle: result.verdict === 'NEUTRAL' ? '✓ NEUTRAL' : `✗ BIASED · ${clip(result.direction, 20)}`,
        bottom: clip(result.reason, 240),
      };
    case 'translation':
      return { top: 'Translation', middle: clip(result.translatedText, 140), bottom: '' };
    case 'eli5':
      return { top: 'Plain English', middle: '', bottom: clip(result.explanation, 240) };
    case 'session-summary':
      return { top: 'Session Summary', middle: '', bottom: clip(result.summary, 240) };
  }
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function buildUnconfiguredPage(mode: 'create' | 'rebuild'): CreateStartUpPageContainer | RebuildPageContainer {
  const title = new TextContainerProperty({ containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 32, width: SCREEN_W - 32, height: 40, borderWidth: 0, paddingLength: 4, content: 'VeritasLens', isEventCapture: 0 });
  const msg = new TextContainerProperty({ containerID: CONTAINER.pickerHint, containerName: 'vl-msg', xPosition: 16, yPosition: 96, width: SCREEN_W - 32, height: 88, borderWidth: 0, paddingLength: 4, content: 'Configure on your phone to begin. Add your Gemini API key from the app menu.', isEventCapture: 0 });
  const sink = new ListContainerProperty({ containerID: CONTAINER.pickerList, containerName: NAME.pickerList, xPosition: 16, yPosition: 216, width: SCREEN_W - 32, height: 40, borderWidth: 0, paddingLength: 4, itemContainer: new ListItemContainerProperty({ itemCount: 1, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 0, itemName: ['Waiting for API key…'] }), isEventCapture: 1 });
  const Ctor = mode === 'create' ? CreateStartUpPageContainer : RebuildPageContainer;
  return new Ctor({ containerTotalNum: 3, listObject: [sink], textObject: [title, msg] });
}

function buildPickerPage(mode: 'create' | 'rebuild'): CreateStartUpPageContainer | RebuildPageContainer {
  const currentPersonas = getPickerPersonas(settings().bufferDuration);
  const title = new TextContainerProperty({ containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 32, width: SCREEN_W - 32, height: 36, borderWidth: 0, paddingLength: 4, content: 'Pick a lens', isEventCapture: 0 });
  const list = new ListContainerProperty({ containerID: CONTAINER.pickerList, containerName: NAME.pickerList, xPosition: 16, yPosition: 88, width: SCREEN_W - 32, height: 120, borderWidth: 0, paddingLength: 4, itemContainer: new ListItemContainerProperty({ itemCount: currentPersonas.length, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 1, itemName: currentPersonas.map((p) => p.name) }), isEventCapture: 1 });
  const hint = new TextContainerProperty({ containerID: CONTAINER.pickerHint, containerName: NAME.pickerHint, xPosition: 16, yPosition: 224, width: SCREEN_W - 32, height: 40, borderWidth: 0, paddingLength: 4, content: currentPersonas.length > 1 ? 'Swipe ⇅ · Tap to start' : 'Tap to start', isEventCapture: 0 });
  const Ctor = mode === 'create' ? CreateStartUpPageContainer : RebuildPageContainer;
  return new Ctor({ containerTotalNum: 3, listObject: [list], textObject: [title, hint] });
}

function buildMenuPage(): RebuildPageContainer {
  const title = new TextContainerProperty({ containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 32, width: SCREEN_W - 32, height: 36, borderWidth: 0, paddingLength: 4, content: 'Menu', isEventCapture: 0 });
  const list = new ListContainerProperty({ containerID: CONTAINER.menuList, containerName: NAME.menuList, xPosition: 16, yPosition: 88, width: SCREEN_W - 32, height: 120, borderWidth: 0, paddingLength: 4, itemContainer: new ListItemContainerProperty({ itemCount: MENU_OPTIONS.length, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 1, itemName: MENU_OPTIONS.map((o) => o.label) }), isEventCapture: 1 });
  const hint = new TextContainerProperty({ containerID: CONTAINER.pickerHint, containerName: NAME.pickerHint, xPosition: 16, yPosition: 224, width: SCREEN_W - 32, height: 40, borderWidth: 0, paddingLength: 4, content: 'Swipe ⇅ · Tap to confirm', isEventCapture: 0 });
  return new RebuildPageContainer({ containerTotalNum: 3, listObject: [list], textObject: [title, hint] });
}

function buildActivePage(): RebuildPageContainer {
  const rec = new TextContainerProperty({ containerID: CONTAINER.recIndicator, containerName: NAME.recIndicator, xPosition: SCREEN_W - 96, yPosition: 230, width: 80, height: 28, borderWidth: 0, paddingLength: 4, content: '● REC', isEventCapture: 0 });
  const claim = new TextContainerProperty({ containerID: CONTAINER.claim, containerName: NAME.claim, xPosition: 16, yPosition: 32, width: SCREEN_W - 32, height: 68, borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0 });
  const verdict = new TextContainerProperty({ containerID: CONTAINER.verdict, containerName: NAME.verdict, xPosition: 16, yPosition: 104, width: SCREEN_W - 32, height: 36, borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0 });
  const reason = new TextContainerProperty({ containerID: CONTAINER.reason, containerName: NAME.reason, xPosition: 16, yPosition: 148, width: SCREEN_W - 32, height: 64, borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0 });
  const eventList = new ListContainerProperty({ containerID: CONTAINER.activeList, containerName: NAME.activeList, xPosition: 16, yPosition: 224, width: SCREEN_W - 32, height: 40, borderWidth: 0, paddingLength: 4, itemContainer: new ListItemContainerProperty({ itemCount: 1, itemWidth: SCREEN_W - 120, isItemSelectBorderEn: 0, itemName: ['Tap: menu · Double-tap: check'] }), isEventCapture: 1 });
  return new RebuildPageContainer({ containerTotalNum: 5, listObject: [eventList], textObject: [claim, verdict, reason, rec] });
}

function buildHistoryListPage(entries: HistoryEntry[]): RebuildPageContainer {
  const title = new TextContainerProperty({ containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 32, width: SCREEN_W - 32, height: 36, borderWidth: 0, paddingLength: 4, content: 'History', isEventCapture: 0 });
  const itemNames = entries.length > 0 ? entries.map((e) => `[${e.badge}] ${clip(e.question, 60)}`) : ['No history yet'];
  const list = new ListContainerProperty({ containerID: CONTAINER.historyList, containerName: NAME.historyList, xPosition: 16, yPosition: 80, width: SCREEN_W - 32, height: 128, borderWidth: 0, paddingLength: 4, itemContainer: new ListItemContainerProperty({ itemCount: itemNames.length, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 1, itemName: itemNames }), isEventCapture: 1 });
  const hint = new TextContainerProperty({ containerID: CONTAINER.historyHint, containerName: NAME.historyHint, xPosition: 16, yPosition: 224, width: SCREEN_W - 32, height: 40, borderWidth: 0, paddingLength: 4, content: entries.length > 0 ? 'Swipe ⇅ · Tap for detail' : 'Tap to go back', isEventCapture: 0 });
  return new RebuildPageContainer({ containerTotalNum: 3, listObject: [list], textObject: [title, hint] });
}

function buildHistoryDetailPage(entry: HistoryEntry): RebuildPageContainer {
  const { top, middle, bottom } = formatLensResult(entry.result);
  const claim = new TextContainerProperty({ containerID: CONTAINER.claim, containerName: NAME.claim, xPosition: 16, yPosition: 32, width: SCREEN_W - 32, height: 68, borderWidth: 0, paddingLength: 4, content: top, isEventCapture: 0 });
  const verdict = new TextContainerProperty({ containerID: CONTAINER.verdict, containerName: NAME.verdict, xPosition: 16, yPosition: 104, width: SCREEN_W - 32, height: 36, borderWidth: 0, paddingLength: 4, content: middle, isEventCapture: 0 });
  const reason = new TextContainerProperty({ containerID: CONTAINER.reason, containerName: NAME.reason, xPosition: 16, yPosition: 148, width: SCREEN_W - 32, height: 64, borderWidth: 0, paddingLength: 4, content: bottom, isEventCapture: 0 });
  const eventList = new ListContainerProperty({ containerID: CONTAINER.activeList, containerName: NAME.activeList, xPosition: 16, yPosition: 224, width: SCREEN_W - 32, height: 40, borderWidth: 0, paddingLength: 4, itemContainer: new ListItemContainerProperty({ itemCount: 1, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 0, itemName: ['Tap: back · Double-tap: new check'] }), isEventCapture: 1 });
  void entry;
  return new RebuildPageContainer({ containerTotalNum: 4, listObject: [eventList], textObject: [claim, verdict, reason] });
}

export function _resetHudBootstrapForTesting(): void {
  bootstrapped = false;
  currentPage = 'none';
  menuPersona = null;
  cachedHistoryEntries = [];
}
```

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

- [ ] **Step 3: Commit**

```bash
git add src/runtime/hud.ts
git commit -m "feat: update HUD — per-lens renderer, history pages, History menu option"
```

---

## Task 15: Update lifecycle

**Files:**
- Modify: `src/runtime/lifecycle.ts`

- [ ] **Step 1: Replace `src/runtime/lifecycle.ts`** with the following. Key changes:
  - Imports `callLens` instead of `factCheck`; imports `lensResult`, `setLensResult`, `pushHistoryEntry`, `sessionHistory` from store
  - `runFactCheck()` renamed to `runAnalysis()`; builds prompt via `persona.buildPrompt(lang)`, calls `callLens()`, calls `persona.parse()`
  - Double-tap is handled universally at the top of `handleEvent()` before page dispatch
  - History gesture handlers: `handleHistoryListGesture()`, `handleHistoryDetailGesture()`
  - `handleMenuGesture`: 'history' option calls `showHistoryListPage()`
  - `enterActiveSession()`: uses `settings().bufferDuration` for buffer; starts auto-summary timer
  - `startAutoSummaryTimer()` / `stopAutoSummaryTimer()` / `runAutoSummary()` added

```typescript
// src/runtime/lifecycle.ts
import { getBridge } from './bridge';
import { PcmRingBuffer } from './audioBuffer';
import {
  bootstrapHud,
  currentHudPage,
  menuOptionAtIndex,
  personaAtIndex,
  restoreActivePage,
  restoreHistoryListPage,
  setLensResult,
  setRecIndicator,
  setStatus,
  showActivePage,
  showHistoryDetailPage,
  showHistoryListPage,
  showMenuPage,
  showPickerPage,
  showUnconfiguredPage,
} from './hud';
import { callLens } from '@/llm/gemini';
import { getPersona, type PersonaId } from '@/personas';
import {
  activePersona,
  lensResult as stateResultGet,
  pushHistoryEntry,
  sessionHistory,
  setActivePersona,
  setAppPhase,
  setErrorMessage,
  setLensResult as setStateResult,
  settings,
} from '@/state/store';
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import type { LensResult } from '@/types';

const SLEEP_AFTER_MS = 5 * 60 * 1000;

let running = false;
let buffer: PcmRingBuffer | null = null;
let unsubscribeEvents: (() => void) | null = null;
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
let inflight: AbortController | null = null;
let autoSummaryTimer: ReturnType<typeof setInterval> | null = null;

let lastPickerIndex = 0;
let lastMenuIndex = 0;
let lastHistoryIndex = 0;

export function isHudRunning(): boolean { return running; }

export async function startHudRuntime(): Promise<void> {
  const configured = settings().geminiApiKey.trim().length >= 10;
  if (running) {
    if (configured) await showPickerPage();
    else await showUnconfiguredPage();
    return;
  }
  running = true;
  try {
    setAppPhase('booting');
    await bootstrapHud(configured ? 'picker' : 'unconfigured');
    setAppPhase('idle');
    unsubscribeEvents = getBridge().onEvenHubEvent(handleEvent);
  } catch (err) {
    running = false;
    setAppPhase('error');
    setErrorMessage(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export async function refreshHudPage(): Promise<void> {
  if (!running) return;
  const configured = settings().geminiApiKey.trim().length >= 10;
  if (configured) await showPickerPage();
  else await showUnconfiguredPage();
}

export async function stopHudRuntime(): Promise<void> {
  if (!running) return;
  running = false;
  stopSpinner();
  stopAutoSummaryTimer();
  unsubscribeEvents?.();
  unsubscribeEvents = null;
  inflight?.abort();
  inflight = null;
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
  buffer?.clear();
  buffer = null;
  try { await getBridge().audioControl(false); } catch { /* ignore */ }
  setAppPhase('idle');
}

interface Gesture { type: OsEventTypeList | undefined; itemIndex?: number; }

function extractGesture(event: EvenHubEvent): Gesture | null {
  if (event.listEvent) return { type: event.listEvent.eventType, itemIndex: event.listEvent.currentSelectItemIndex };
  if (event.sysEvent) {
    const et = event.sysEvent.eventType;
    if (et === OsEventTypeList.CLICK_EVENT || et === OsEventTypeList.DOUBLE_CLICK_EVENT || et === OsEventTypeList.SCROLL_TOP_EVENT || et === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      return { type: et };
    }
  }
  return null;
}

function isLifecycleSysEvent(et: OsEventTypeList | undefined): boolean {
  return et === OsEventTypeList.FOREGROUND_EXIT_EVENT || et === OsEventTypeList.FOREGROUND_ENTER_EVENT || et === OsEventTypeList.SYSTEM_EXIT_EVENT || et === OsEventTypeList.ABNORMAL_EXIT_EVENT;
}

function handleEvent(event: EvenHubEvent): void {
  if (event.listEvent || event.textEvent || event.sysEvent) console.info('[veritaslens] event', summarize(event));

  if (event.sysEvent && isLifecycleSysEvent(event.sysEvent.eventType)) {
    switch (event.sysEvent.eventType) {
      case OsEventTypeList.FOREGROUND_EXIT_EVENT: void pauseListening(); return;
      case OsEventTypeList.FOREGROUND_ENTER_EVENT: void resumeListening(); return;
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT: void stopHudRuntime(); return;
    }
  }

  if (event.audioEvent && buffer) { buffer.append(event.audioEvent.audioPcm); return; }

  const gesture = extractGesture(event);
  if (!gesture) return;

  // Double-tap is universal: always triggers a new analysis from any page.
  if (gesture.type === OsEventTypeList.DOUBLE_CLICK_EVENT) { void runAnalysis(); return; }

  const page = currentHudPage();
  if (page === 'picker') void handlePickerEvent(gesture);
  else if (page === 'active') void handleActiveGesture(gesture);
  else if (page === 'menu') void handleMenuGesture(gesture);
  else if (page === 'history-list') void handleHistoryListGesture(gesture);
  else if (page === 'history-detail') void handleHistoryDetailGesture(gesture);
}

async function handlePickerEvent(g: Gesture): Promise<void> {
  resetSleepTimer();
  if (typeof g.itemIndex === 'number') lastPickerIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    const persona = personaAtIndex(lastPickerIndex);
    if (persona) await enterActiveSession(persona.id);
  }
}

async function handleActiveGesture(g: Gesture): Promise<void> {
  resetSleepTimer();
  switch (g.type) {
    case OsEventTypeList.CLICK_EVENT:
    case undefined: await showMenuPage(); break;
    case OsEventTypeList.SCROLL_TOP_EVENT: await leaveActiveSession(); break;
    case OsEventTypeList.SCROLL_BOTTOM_EVENT: await clearResultAndKeepListening(); break;
  }
}

async function handleMenuGesture(g: Gesture): Promise<void> {
  resetSleepTimer();
  if (typeof g.itemIndex === 'number') lastMenuIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    const option = menuOptionAtIndex(lastMenuIndex);
    switch (option) {
      case 'fact-check': await restoreActivePage(); await runAnalysis(); break;
      case 'history': await showHistoryListPage(sessionHistory()); break;
      case 'cancel': await restoreActiveWithResult(); break;
      case 'exit': await leaveActiveSession(); break;
    }
  }
}

async function handleHistoryListGesture(g: Gesture): Promise<void> {
  resetSleepTimer();
  if (typeof g.itemIndex === 'number') lastHistoryIndex = g.itemIndex;
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    const entries = sessionHistory();
    if (entries.length === 0) { await restoreActivePage(); return; }
    const entry = entries[lastHistoryIndex];
    if (entry) await showHistoryDetailPage(entry);
  } else if (g.type === OsEventTypeList.SCROLL_TOP_EVENT) {
    await restoreActivePage();
  }
}

async function handleHistoryDetailGesture(g: Gesture): Promise<void> {
  resetSleepTimer();
  if (g.type === OsEventTypeList.CLICK_EVENT || g.type === undefined) {
    await restoreHistoryListPage();
  }
}

async function restoreActiveWithResult(): Promise<void> {
  await restoreActivePage();
  const current = stateResultGet();
  if (current) {
    await setLensResult(current);
    await setStatus('displaying');
    setAppPhase('displaying');
  } else {
    await setStatus('listening');
    setAppPhase('listening');
  }
}

async function enterActiveSession(personaId: PersonaId): Promise<void> {
  const persona = getPersona(personaId);
  if (!persona) { setErrorMessage(`Unknown lens: ${personaId}`); return; }
  setActivePersona(personaId);
  lastMenuIndex = 0;
  await showActivePage(persona);
  await setStatus('listening');
  await setRecIndicator(true);
  buffer = new PcmRingBuffer({ durationSec: settings().bufferDuration, sampleRate: 16_000 });
  const micOk = await getBridge().audioControl(true);
  if (!micOk) {
    await setStatus('error');
    await setRecIndicator(false);
    setErrorMessage('Microphone could not be opened.');
    setAppPhase('error');
    return;
  }
  resetSleepTimer();
  startAutoSummaryTimer();
  setAppPhase('listening');
}

async function leaveActiveSession(): Promise<void> {
  try { await getBridge().audioControl(false); } catch { /* ignore */ }
  stopAutoSummaryTimer();
  buffer?.clear();
  buffer = null;
  await showPickerPage();
  setAppPhase('idle');
}

const SPINNER_FRAMES = ['|', '/', '-', '\\'];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;

function startSpinner(): void {
  if (spinnerTimer) return;
  let i = 0;
  spinnerTimer = setInterval(() => { i = (i + 1) % SPINNER_FRAMES.length; void setStatus(` ${SPINNER_FRAMES[i]}  `); }, 180);
}

function stopSpinner(): void {
  if (spinnerTimer) clearInterval(spinnerTimer);
  spinnerTimer = null;
}

async function runAnalysis(): Promise<void> {
  const page = currentHudPage();
  if (page === 'history-list' || page === 'history-detail') await restoreActivePage();
  if (currentHudPage() !== 'active') return;
  if (!buffer || buffer.bytesBuffered === 0) { await setStatus('listening'); return; }

  const apiKey = settings().geminiApiKey;
  if (!apiKey) { await setStatus('error'); setErrorMessage('No Gemini API key.'); return; }

  const persona = getPersona(activePersona());
  if (!persona) return;

  inflight?.abort();
  inflight = new AbortController();
  setAppPhase('thinking');
  await setStatus('thinking');
  startSpinner();

  try {
    const wav = buffer.snapshotWav();
    const prompt = persona.buildPrompt(settings().responseLanguage);
    const rawText = await callLens({ apiKey, wav, prompt, schema: persona.schema, model: settings().geminiModel, signal: inflight.signal });
    const result = persona.parse(rawText);
    stopSpinner();
    setStateResult(result);
    pushHistoryEntry({ lensId: persona.id, lensName: persona.name, question: extractQuestion(result), badge: extractBadge(result), result });
    await setLensResult(result);
    await setStatus('displaying');
    setAppPhase('displaying');
  } catch (err) {
    stopSpinner();
    if ((err as Error)?.name === 'AbortError') return;
    setErrorMessage(err instanceof Error ? err.message : String(err));
    await setStatus('error');
    setAppPhase('error');
  }
}

async function clearResultAndKeepListening(): Promise<void> {
  setStateResult(null);
  await setLensResult(null);
  await setStatus('listening');
  setAppPhase('listening');
}

function startAutoSummaryTimer(): void {
  stopAutoSummaryTimer();
  const s = settings();
  if (!s.autoSummaryEnabled) return;
  autoSummaryTimer = setInterval(() => void runAutoSummary(), s.autoSummaryInterval * 60_000);
}

function stopAutoSummaryTimer(): void {
  if (autoSummaryTimer) clearInterval(autoSummaryTimer);
  autoSummaryTimer = null;
}

async function runAutoSummary(): Promise<void> {
  if (!buffer || buffer.bytesBuffered === 0) return;
  const apiKey = settings().geminiApiKey;
  if (!apiKey) return;
  const persona = getPersona('session-summary');
  if (!persona) return;
  try {
    const wav = buffer.snapshotWav();
    const rawText = await callLens({ apiKey, wav, prompt: persona.buildPrompt(settings().responseLanguage), schema: persona.schema, model: settings().geminiModel });
    const result = persona.parse(rawText);
    pushHistoryEntry({ lensId: persona.id, lensName: persona.name, question: extractQuestion(result), badge: 'AUTO', result });
  } catch { /* silent failure — auto-summary is best-effort */ }
}

function extractQuestion(result: LensResult): string {
  switch (result.type) {
    case 'fact-check': return result.claim;
    case 'trivia': return result.answer;
    case 'logical-fallacy': return result.fallacy;
    case 'stats-check': return result.stat;
    case 'bias': return result.direction || result.verdict;
    case 'translation': return result.translatedText.slice(0, 80);
    case 'eli5': return result.explanation.slice(0, 80);
    case 'session-summary': return result.summary.slice(0, 80);
  }
}

function extractBadge(result: LensResult): string {
  switch (result.type) {
    case 'fact-check': return result.verdict;
    case 'trivia': return 'ANSWER';
    case 'logical-fallacy': return result.fallacy.slice(0, 12).toUpperCase();
    case 'stats-check': return result.verdict;
    case 'bias': return result.verdict;
    case 'translation': return 'TRANSL.';
    case 'eli5': return 'ELI5';
    case 'session-summary': return 'SUMMARY';
  }
}

async function pauseListening(): Promise<void> {
  try { await getBridge().audioControl(false); } catch { /* ignore */ }
  await setRecIndicator(false);
  setAppPhase('sleeping');
}

async function resumeListening(): Promise<void> {
  if (currentHudPage() !== 'active') return;
  try { await getBridge().audioControl(true); } catch { /* ignore */ }
  await setStatus('listening');
  await setRecIndicator(true);
  setAppPhase('listening');
  resetSleepTimer();
}

function resetSleepTimer(): void {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => void enterSleep(), SLEEP_AFTER_MS);
}

async function enterSleep(): Promise<void> {
  if (currentHudPage() !== 'active') return;
  try { await getBridge().audioControl(false); await setStatus('sleeping'); await setRecIndicator(false); setAppPhase('sleeping'); } catch { /* ignore */ }
}

void activePersona;

function summarize(event: EvenHubEvent): Record<string, unknown> {
  if (event.textEvent) return { kind: 'text', eventType: event.textEvent.eventType, container: event.textEvent.containerName };
  if (event.listEvent) return { kind: 'list', eventType: event.listEvent.eventType, container: event.listEvent.containerName, idx: event.listEvent.currentSelectItemIndex, name: event.listEvent.currentSelectItemName };
  if (event.sysEvent) return { kind: 'sys', eventType: event.sysEvent.eventType, source: event.sysEvent.eventSource };
  return { kind: 'unknown' };
}
```

- [ ] **Step 2: Run lint and fix any unused-import errors**

```bash
npm run lint
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/lifecycle.ts
git commit -m "feat: update lifecycle — runAnalysis(), history gestures, auto-summarizer"
```

---

## Task 16: Update SettingsView

**Files:**
- Modify: `src/views/SettingsView.tsx`

- [ ] **Step 1: Replace `src/views/SettingsView.tsx`**

```tsx
// src/views/SettingsView.tsx
import { createMemo, createSignal, For, Show, type Component } from 'solid-js';
import {
  deviceStatus,
  saveAutoSummaryEnabled,
  saveAutoSummaryInterval,
  saveBufferDuration,
  saveGeminiKey,
  saveGeminiModel,
  saveResponseLanguage,
  sessionHistory,
  settings,
} from '@/state/store';
import { getBridge } from '@/runtime/bridge';
import { isHudRunning, refreshHudPage, startHudRuntime } from '@/runtime/lifecycle';
import {
  GEMINI_MODELS,
  LANGUAGES,
  type AutoSummaryInterval,
  type BufferDuration,
  type GeminiModel,
  type HistoryEntry,
  type LanguageCode,
} from '@/types';
import { personas } from '@/personas';

const BUFFER_OPTIONS: { value: BufferDuration; label: string }[] = [
  { value: 30, label: '30 seconds' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
];

const AUTO_INTERVAL_OPTIONS: { value: AutoSummaryInterval; label: string }[] = [
  { value: 1, label: 'Every minute' },
  { value: 2, label: 'Every 2 minutes' },
  { value: 5, label: 'Every 5 minutes' },
];

export const SettingsView: Component = () => {
  const [draftKey, setDraftKey] = createSignal(settings().geminiApiKey);
  const [draftModel, setDraftModel] = createSignal<GeminiModel>(settings().geminiModel);
  const [draftLanguage, setDraftLanguage] = createSignal<LanguageCode>(settings().responseLanguage);
  const [draftBuffer, setDraftBuffer] = createSignal<BufferDuration>(settings().bufferDuration);
  const [draftAutoEnabled, setDraftAutoEnabled] = createSignal(settings().autoSummaryEnabled);
  const [draftAutoInterval, setDraftAutoInterval] = createSignal<AutoSummaryInterval>(settings().autoSummaryInterval);
  const [saveState, setSaveState] = createSignal<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [testState, setTestState] = createSignal<'idle' | 'running' | 'ok' | 'fail'>('idle');
  const [testMessage, setTestMessage] = createSignal('');
  const [expandedId, setExpandedId] = createSignal<string | null>(null);

  const isConfigured = createMemo(() => settings().geminiApiKey.trim().length >= 10);
  const canSave = createMemo(() => draftKey().trim().length >= 10);

  const onSave = async () => {
    setSaveState('saving');
    try {
      const bridge = getBridge();
      const setLs = (k: string, v: string) => bridge.setLocalStorage(k, v);
      const results = await Promise.all([
        saveGeminiKey(setLs, draftKey().trim()),
        saveGeminiModel(setLs, draftModel()),
        saveResponseLanguage(setLs, draftLanguage()),
        saveBufferDuration(setLs, draftBuffer()),
        saveAutoSummaryEnabled(setLs, draftAutoEnabled()),
        saveAutoSummaryInterval(setLs, draftAutoInterval()),
      ]);
      if (results.every(Boolean)) {
        setSaveState('saved');
        setTimeout(() => setSaveState('idle'), 1500);
        if (!isHudRunning()) await startHudRuntime();
        else await refreshHudPage();
      } else {
        setSaveState('error');
      }
    } catch {
      setSaveState('error');
    }
  };

  const onTest = async () => {
    setTestState('running');
    setTestMessage('');
    try {
      const { runSelfTest } = await import('@/llm/gemini');
      const result = await runSelfTest(settings().geminiApiKey, draftModel(), draftLanguage());
      setTestState('ok');
      setTestMessage(`Reachable · ${result.latencyMs} ms`);
    } catch (err) {
      setTestState('fail');
      setTestMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  const renderDetail = (entry: HistoryEntry) => JSON.stringify(entry.result, null, 2);

  return (
    <main class="settings">
      <header>
        <h1>VeritasLens</h1>
        <p class="tagline">Silent intelligence for your G2.</p>
      </header>

      <Show when={deviceStatus()} fallback={<div class="device-badge muted">Waiting for glasses…</div>}>
        {(s) => (
          <div class="device-badge">
            <span class={`dot ${s().connectType}`} />
            <span>{s().connectType}</span>
            <Show when={typeof s().batteryLevel === 'number'}><span class="sep">·</span><span>{s().batteryLevel}%</span></Show>
            <Show when={s().isWearing}><span class="sep">·</span><span>wearing</span></Show>
          </div>
        )}
      </Show>

      <section class="lenses-card">
        <div class="field-header"><span class="field-label">Lenses</span></div>
        <ul class="lens-list">
          <For each={personas()}>
            {(p) => (
              <li class="lens-row">
                <div class="lens-info">
                  <strong>{p.name}</strong>
                  <span class="lens-desc">{p.description}</span>
                </div>
              </li>
            )}
          </For>
        </ul>
      </section>

      <form class="config" onSubmit={(e) => { e.preventDefault(); void onSave(); }}>
        <label class="field">
          <span class="field-label">Gemini API key</span>
          <input type="password" autocomplete="off" spellcheck={false} placeholder="AIza…" value={draftKey()} onInput={(e) => setDraftKey(e.currentTarget.value)} />
          <span class="field-hint">Stored only on this device. Get one at <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer">aistudio.google.com</a>.</span>
        </label>

        <label class="field">
          <span class="field-label">Model</span>
          <select value={draftModel()} onChange={(e) => setDraftModel(e.currentTarget.value as GeminiModel)}>
            <For each={GEMINI_MODELS}>{(m) => <option value={m}>{m}</option>}</For>
          </select>
        </label>

        <label class="field">
          <span class="field-label">Response language</span>
          <select value={draftLanguage()} onChange={(e) => setDraftLanguage(e.currentTarget.value as LanguageCode)}>
            <For each={Object.entries(LANGUAGES)}>{([code, name]) => <option value={code}>{name}</option>}</For>
          </select>
        </label>

        <label class="field">
          <span class="field-label">Recording buffer</span>
          <select value={draftBuffer()} onChange={(e) => setDraftBuffer(Number(e.currentTarget.value) as BufferDuration)}>
            <For each={BUFFER_OPTIONS}>{(opt) => <option value={opt.value}>{opt.label}</option>}</For>
          </select>
          <span class="field-hint">Longer buffers give Gemini more context but use more tokens per request.</span>
        </label>

        <div class="field">
          <span class="field-label">Auto-summary</span>
          <label class="toggle-row">
            <input type="checkbox" checked={draftAutoEnabled()} onChange={(e) => setDraftAutoEnabled(e.currentTarget.checked)} />
            <span>Enable background summaries</span>
          </label>
          <Show when={draftAutoEnabled()}>
            <select value={draftAutoInterval()} onChange={(e) => setDraftAutoInterval(Number(e.currentTarget.value) as AutoSummaryInterval)}>
              <For each={AUTO_INTERVAL_OPTIONS}>{(opt) => <option value={opt.value}>{opt.label}</option>}</For>
            </select>
            <span class="field-hint warning">
              ⚠ Auto-summary sends an API request at each interval (~30 calls/hour at 2 min). Significantly higher API cost. Results appear in History only, not on the HUD.
            </span>
          </Show>
        </div>

        <div class="form-actions">
          <button type="submit" class="primary" disabled={!canSave() || saveState() === 'saving'}>{saveState() === 'saving' ? 'Saving…' : 'Save'}</button>
          <button type="button" class="secondary" onClick={onTest} disabled={testState() === 'running' || !isConfigured()}>
            <Show when={testState() === 'running'} fallback="Test connection"><span class="spinner inline" />Testing…</Show>
          </button>
          <Show when={saveState() === 'saved'}><span class="status ok">Saved</span></Show>
          <Show when={saveState() === 'error'}><span class="status err">Could not save</span></Show>
          <Show when={testState() === 'ok' && testMessage()}><span class="status ok">{testMessage()}</span></Show>
          <Show when={testState() === 'fail' && testMessage()}><span class="status err">{testMessage()}</span></Show>
        </div>
      </form>

      <section class="session-log">
        <div class="field-header"><span class="field-label">Session Log</span></div>
        <Show when={sessionHistory().length > 0} fallback={<p class="muted">No analyses yet this session.</p>}>
          <ul class="history-list">
            <For each={sessionHistory()}>
              {(entry) => (
                <li class="history-row">
                  <button type="button" class="history-question" onClick={() => setExpandedId((prev) => (prev === entry.id ? null : entry.id))}>
                    <span class="history-badge">[{entry.badge}]</span>
                    <span class="history-time">{formatTime(entry.timestamp)}</span>
                    <span class="history-q">{entry.question}</span>
                    <span class="history-lens">{entry.lensName}</span>
                  </button>
                  <Show when={expandedId() === entry.id}>
                    <div class="history-detail"><pre>{renderDetail(entry)}</pre></div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <footer class="privacy">
        Audio is held in a rolling in-memory buffer, never written to disk. Your API key is sent only as part of the Gemini request you trigger. Session log is cleared when the app closes.
      </footer>
    </main>
  );
};
```

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

- [ ] **Step 3: Commit**

```bash
git add src/views/SettingsView.tsx
git commit -m "feat: update SettingsView — remove custom lens UI, add buffer/auto-summary/session log"
```

---

## Task 17: Full verification

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: all suites pass.

- [ ] **Step 2: Type-check**

```bash
npm run lint
```

Expected: 0 errors.

- [ ] **Step 3: Production build**

```bash
npm run build
```

Expected: build succeeds with output in `dist/`.

- [ ] **Step 4: Commit any lint fixes**

```bash
git add -p
git commit -m "fix: post-integration lint clean-up"
```

---

## Manual verification checklist (simulator)

1. **7 lenses in picker** — 30s buffer shows 7 lenses (no Session Summary). Set buffer to 5 min → 8 lenses including Session Summary.
2. **Per-lens HUD format** — Trivia shows large answer + description, not TRUE/FALSE. Stats shows PLAUSIBLE/SUSPICIOUS. Translation fills HUD with translated text.
3. **History (HUD)** — Run 3 analyses → Menu → History → swipe through list → tap one → see full result → tap again → back to list.
4. **Double-tap from history** — Open history-list → double-tap → exits to active page, shows fresh analysis.
5. **History (phone)** — Session Log section shows questions with badge. Tap to expand answer. Tap again to collapse.
6. **Auto-summary** — Enable in settings, set to 1 min, wait → Session Log shows AUTO-badged entry. HUD unchanged.
7. **Token warning** — Enable auto-summary toggle → warning text is visible.
8. **Custom lenses gone** — No "+ Add lens" button, no custom lens form in Settings.
