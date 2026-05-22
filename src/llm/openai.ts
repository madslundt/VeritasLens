// src/llm/openai.ts
//
// OpenAI-compatible provider. Targets the OpenAI Chat Completions API plus
// any API-compatible host pre-whitelisted in app.json (currently OpenRouter
// and Groq). Chat completions accept text only, so the runtime transcribes
// the audio via the provider's own /audio/transcriptions endpoint first and
// concatenates the transcript with the lens prompt.
//
// Schema translation: the canonical lens schemas are Gemini-shaped (JSON
// Schema with `type`, `properties`, `required`, `items`, `description`).
// OpenAI's structured-output strict mode requires `additionalProperties:
// false` and that every property appear in `required`. `toStrictSchema`
// recurses the schema and injects both.
import { DEFAULT_OPENAI_TRANSCRIBE_MODEL, type OpenAiBaseUrl } from '@/types';
import { MAX_RETRIES, parseRetryAfterMs } from './gemini';

export interface CallOpenAiLensOptions {
  apiKey: string;
  baseUrl: OpenAiBaseUrl;
  /** Chat-completions model. */
  model: string;
  /** Transcription model. Falls back to whisper-1 when undefined. */
  transcribeModel?: string;
  /** WAV-encoded audio bytes. Transcribed before chat completions. */
  wav: Uint8Array;
  /** Fully-built, language-aware system prompt. */
  prompt: string;
  /** Gemini-style responseSchema. Translated to OpenAI strict JSON Schema. */
  schema: unknown;
  signal?: AbortSignal;
  /** Called before each retry (attempt = 1..MAX_RETRIES). */
  onRetry?: (attempt: number) => void | Promise<void>;
}

/**
 * Transform a Gemini-shaped JSON Schema into one accepted by OpenAI's strict
 * structured-output mode. Recursive: sets `additionalProperties: false` on
 * every object, and forces `required` to contain every defined property.
 *
 * Note: this strictness intentionally mirrors what OpenAI documents as
 * required for `response_format.json_schema.strict: true`. If a future lens
 * schema uses keywords OpenAI doesn't support (e.g. `format: 'email'`), the
 * model call will fail at request time — the call site surfaces that error.
 */
export function toStrictSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  const out: Record<string, unknown> = {};
  const src = schema as Record<string, unknown>;
  for (const [k, v] of Object.entries(src)) {
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = toStrictSchema(pv);
      }
      out[k] = props;
    } else if (k === 'items') {
      out[k] = toStrictSchema(v);
    } else {
      out[k] = v;
    }
  }
  if (out['type'] === 'object' && out['properties'] && typeof out['properties'] === 'object') {
    const propKeys = Object.keys(out['properties'] as Record<string, unknown>);
    out['additionalProperties'] = false;
    out['required'] = propKeys;
  }
  return out;
}

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

interface TranscriptionResponse {
  text?: string;
  error?: { message?: string };
}

/**
 * Send the WAV through the provider's transcription endpoint and then the
 * transcript + prompt through chat completions. Returns the raw JSON text
 * (the message content) — the lens's `parse()` decodes it.
 *
 * Retries 503 / 429 up to MAX_RETRIES with hint-aware delays, mirroring the
 * Gemini provider.
 */
export async function callOpenAiLens(opts: CallOpenAiLensOptions): Promise<string> {
  if (!opts.apiKey) throw new Error('Missing OpenAI API key.');

  const baseSchema = opts.schema as Record<string, unknown>;
  const augmentedSchema = {
    ...baseSchema,
    properties: {
      noSpeech: { type: 'boolean', description: 'Set to true if no clear human speech is detected.' },
      ...((baseSchema['properties'] as Record<string, unknown> | undefined) ?? {}),
    },
  };
  const strict = toStrictSchema(augmentedSchema);

  // Step 1: transcribe the WAV. Held outside the chat-completions retry loop
  // so we don't re-transcribe on each 429 — Whisper has its own rate limit
  // and re-uploading the WAV would burn quota.
  const transcript = await transcribeAudio({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.transcribeModel ?? DEFAULT_OPENAI_TRANSCRIBE_MODEL,
    wav: opts.wav,
    signal: opts.signal,
  });

  // Build the chat-completions body once so retries don't re-stringify the
  // (potentially long) transcript on every attempt.
  const bodyJson = JSON.stringify({
    model: opts.model,
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'lens_result', strict: true, schema: strict },
    },
    messages: [
      {
        role: 'system',
        content: opts.prompt,
      },
      {
        role: 'user',
        content: transcriptUserMessage(transcript),
      },
    ],
  });

  const endpoint = `${opts.baseUrl}/chat/completions`;
  let lastError: Error | undefined;
  let nextDelayMs = 1000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await opts.onRetry?.(attempt);
      await retryDelay(nextDelayMs, opts.signal);
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: bodyJson,
      signal: opts.signal,
    });

    if (response.status === 503 || response.status === 429) {
      const errText = await response.text();
      nextDelayMs = parseRetryAfterMs(response.headers.get('retry-after')) ?? (response.status === 429 ? 5000 : 1000);
      lastError = new Error(`OpenAI HTTP ${response.status}: ${truncate(errText, 200)}`);
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI HTTP ${response.status}: ${truncate(errText, 200)}`);
    }

    const payload = (await response.json()) as ChatCompletionsResponse;
    if (payload.error?.message) throw new Error(`OpenAI error: ${payload.error.message}`);
    const text = payload.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenAI returned no message content.');
    return text;
  }
  throw lastError ?? new Error('callOpenAiLens: exhausted retries without a result.');
}

function transcriptUserMessage(transcript: string): string {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) {
    // Whisper returns an empty string on silence. Surface this clearly so the
    // model sets noSpeech=true rather than hallucinating content.
    return '[Audio transcript: <empty — no speech captured>]';
  }
  return `[Audio transcript]\n${trimmed}`;
}

interface TranscribeOptions {
  apiKey: string;
  baseUrl: OpenAiBaseUrl;
  model: string;
  wav: Uint8Array;
  signal?: AbortSignal;
}

async function transcribeAudio(opts: TranscribeOptions): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([opts.wav as BlobPart], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', opts.model);
  form.append('response_format', 'json');
  const response = await fetch(`${opts.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: form,
    signal: opts.signal,
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `OpenAI transcription HTTP ${response.status}: ${truncate(errText, 200)}. ` +
        `(This provider may not host the "${opts.model}" model — Groq/OpenRouter ` +
        `do not currently support Whisper. Switch back to Gemini for audio analysis.)`,
    );
  }
  const payload = (await response.json()) as TranscriptionResponse;
  if (payload.error?.message) {
    throw new Error(`OpenAI transcription error: ${payload.error.message}`);
  }
  return payload.text ?? '';
}

interface ModelsListResponse {
  data?: Array<{ id?: string }>;
}

/** Fetch chat-completion-capable model ids exposed by the provider. */
export async function fetchOpenAiModels(
  apiKey: string,
  baseUrl: OpenAiBaseUrl,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!response.ok) return [];
  const data = (await response.json()) as ModelsListResponse;
  return (data.data ?? [])
    .map((m) => m.id ?? '')
    .filter((id) => id.length > 0)
    .sort();
}

function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); return; }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
