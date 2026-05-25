// src/llm/gemini.ts
import { uint8ToBase64, encodePcmToWav } from '@/runtime/audioBuffer';
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODEL_PATTERN,
  type GeminiModel,
} from '@/types';

/**
 * Validate the model name we interpolate into the endpoint URL. Defense in
 * depth: today `opts.model` comes from our own settings store (populated by
 * the Google listModels endpoint), but any unexpected character would inject
 * directly into the URL. Pattern-based rather than allow-list-based so a new
 * family (gemini-3.x flash-lite, …) works without a code change. Falls back
 * silently to the default if the name is missing or malformed.
 */
function resolveModel(raw: string | undefined): GeminiModel {
  if (raw && GEMINI_MODEL_PATTERN.test(raw)) {
    return raw as GeminiModel;
  }
  return DEFAULT_GEMINI_MODEL;
}

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
  /** Called before each retry (attempt = 1..MAX_RETRIES). */
  onRetry?: (attempt: number) => void | Promise<void>;
}

export const MAX_RETRIES = 3;

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

  // Build the request body once and serialize to JSON immediately so the WAV
  // → base64 string and the intermediate `body` object can be GC'd before the
  // first fetch even leaves the function. Without this, retries hold the body
  // object alive (with its multi-MB base64 string) across every retry-delay.
  const bodyJson = ((): string => {
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
    return JSON.stringify(body);
  })();

  let lastError: Error | undefined;
  let nextDelayMs = 1000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await opts.onRetry?.(attempt);
      await retryDelay(nextDelayMs, opts.signal);
    }

    const response = await fetch(
      `${ENDPOINT(resolveModel(opts.model))}?key=${encodeURIComponent(opts.apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyJson,
        signal: opts.signal,
      },
    );

    if (response.status === 503 || response.status === 429) {
      const errText = await response.text();
      const hinted =
        parseRetryAfterMs(response.headers.get('retry-after')) ??
        parseGoogleRetryDelayMs(errText);
      nextDelayMs = hinted ?? (response.status === 429 ? 5000 : 1000);
      lastError = new Error(`Gemini HTTP ${response.status}: ${truncate(errText, 2000)}`);
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini HTTP ${response.status}: ${truncate(errText, 2000)}`);
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
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      // Detach the abort listener on normal completion so its closure (which
      // captures `timer` and `reject`) can be GC'd. Without this, up to
      // MAX_RETRIES stale listeners accumulate on the signal during a session.
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Reachability probe used by Settings "Run self-test".
 * Sends 1 second of silence and reports round-trip latency. Uses a minimal
 * connectivity-only prompt + schema rather than borrowing a real persona —
 * keeps the LLM transport decoupled from the persona layer so renaming a
 * lens can't break the self-test.
 */
export async function runSelfTest(
  apiKey: string,
  model?: GeminiModel | string,
): Promise<{ latencyMs: number }> {
  const silentPcm = new Uint8Array(16_000 * 2);
  const wav = encodePcmToWav(silentPcm, { sampleRate: 16_000, bitsPerSample: 16, channels: 1 });
  const prompt = 'Respond with `{"ok": true}` to confirm reachability.';
  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  };
  const t0 = performance.now();
  await callLens({ apiKey, wav, prompt, schema, model });
  return { latencyMs: Math.round(performance.now() - t0) };
}

interface ModelsListResponse {
  models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
}

// Positive metadata signal: only models that advertise `generateContent` can
// be called by this app's pipeline. TTS / image / native-audio Live variants
// also expose generateContent though (modality isn't reflected in the model
// list), so we strip them by category keyword. These keywords are stable
// across releases — new chat families (gemini-3.x, …) appear automatically.
const GEMINI_NON_CHAT_KEYWORDS: readonly RegExp[] = [
  /-tts(\b|-)/i,           // gemini-2.5-flash-preview-tts
  /-image(\b|-)/i,         // gemini-2.5-flash-image-preview
  /-native-audio/i,        // Live API
  /-dialog/i,
  /-live/i,
  /-search/i,
  /embedding/i,
];

export function isSupportedGeminiModel(id: string): boolean {
  return id.length > 0 && !GEMINI_NON_CHAT_KEYWORDS.some((re) => re.test(id));
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
    .map((m) => m.name?.replace('models/', '') ?? '')
    .filter(isSupportedGeminiModel)
    .sort()
    .reverse();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

const MAX_RETRY_DELAY_MS = 8_000;
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
