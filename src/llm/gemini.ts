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
  /** Gemini responseSchema object. Opaque — forwarded as-is to the API. */
  schema: unknown;
  signal?: AbortSignal;
  model?: GeminiModel | string;
  /** Called before each retry (attempt = 1 or 2). */
  onRetry?: (attempt: number) => void | Promise<void>;
}

const MAX_RETRIES = 2;

/**
 * Send audio + prompt to Gemini and return the raw JSON text from the response.
 * Each lens's parse() function handles decoding the JSON.
 * Retries up to MAX_RETRIES times on 503 responses, calling opts.onRetry before each retry.
 */
export async function callLens(opts: CallLensOptions): Promise<string> {
  if (!opts.apiKey) throw new Error('Missing Gemini API key.');

  const baseSchema = opts.schema as Record<string, unknown>;
  const augmentedSchema = {
    ...baseSchema,
    properties: {
      noSpeech: { type: 'boolean', description: 'Set to true if no clear human speech is detected.' },
      ...((baseSchema['properties'] as Record<string, unknown> | undefined) ?? {}),
    },
  };

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
      responseSchema: augmentedSchema,
    },
  };

  let lastError: Error | undefined;
  let nextDelayMs = 1000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await opts.onRetry?.(attempt);
      await retryDelay(nextDelayMs, opts.signal);
    }

    const response = await fetch(
      `${ENDPOINT(opts.model ?? DEFAULT_GEMINI_MODEL)}?key=${encodeURIComponent(opts.apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal,
      },
    );

    if (response.status === 503 || response.status === 429) {
      const errText = await response.text();
      const hinted =
        parseRetryAfterMs(response.headers.get('retry-after')) ??
        parseGoogleRetryDelayMs(errText);
      nextDelayMs = hinted ?? (response.status === 429 ? 5000 : 1000);
      lastError = new Error(`Gemini HTTP ${response.status}: ${truncate(errText, 200)}`);
      continue;
    }

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

  throw lastError ?? new Error('callLens: exhausted retries without a result.');
}

function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
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
    schema: FACT_CHECKER_SCHEMA,
    model,
  });
  return { latencyMs: Math.round(performance.now() - t0) };
}

interface ModelsListResponse {
  models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
}

/** Fetch available Gemini models that support generateContent, sorted newest-first. */
export async function fetchAvailableModels(apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    { signal },
  );
  if (!response.ok) return [];
  const data = (await response.json()) as ModelsListResponse;
  return (data.models ?? [])
    .filter(
      (m) =>
        m.name?.startsWith('models/gemini-') &&
        m.supportedGenerationMethods?.includes('generateContent'),
    )
    .map((m) => m.name!.replace('models/', ''))
    .sort()
    .reverse();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

const MAX_RETRY_DELAY_MS = 30_000;
const RETRY_DELAY_PATTERN = /^(\d+(?:\.\d+)?)s$/;

/** Parse an HTTP Retry-After header (seconds only — Gemini does not emit HTTP-date here). */
export function parseRetryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (!Number.isFinite(secs) || secs < 0) return null;
  return Math.min(secs * 1000, MAX_RETRY_DELAY_MS);
}

/** Parse Google's quota error body for `retryDelay: "42s"` hints. */
export function parseGoogleRetryDelayMs(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { error?: { details?: Array<{ retryDelay?: string }> } };
    const details = parsed.error?.details;
    if (!Array.isArray(details)) return null;
    for (const d of details) {
      const hint = typeof d?.retryDelay === 'string' ? d.retryDelay.match(RETRY_DELAY_PATTERN) : null;
      if (hint) return Math.min(Math.ceil(Number(hint[1]) * 1000), MAX_RETRY_DELAY_MS);
    }
  } catch { /* malformed body — ignore */ }
  return null;
}
