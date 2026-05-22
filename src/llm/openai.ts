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
import { encodePcmToWav } from '@/runtime/audioBuffer';
import { OPENAI_TRANSCRIBE_MODELS, type OpenAiBaseUrl } from '@/types';

/**
 * Human-readable host names used in error messages. Falls through to a
 * sensible default if a new base URL is added without updating this map.
 */
const HOST_LABELS: Record<OpenAiBaseUrl, string> = {
  'https://api.openai.com/v1': 'OpenAI',
  'https://api.groq.com/openai/v1': 'Groq',
};
function hostLabel(baseUrl: OpenAiBaseUrl): string {
  return HOST_LABELS[baseUrl] ?? 'OpenAI-compatible';
}
import { MAX_RETRIES, parseRetryAfterMs } from './gemini';

export interface CallOpenAiLensOptions {
  apiKey: string;
  baseUrl: OpenAiBaseUrl;
  /** Chat-completions model. */
  model: string;
  /** Transcription model id for the chosen host (e.g. `whisper-1` on OpenAI, `whisper-large-v3` on Groq). The facade resolves this from a per-host map. */
  transcribeModel: string;
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
  if (!opts.apiKey) throw new Error(`Missing ${hostLabel(opts.baseUrl)} API key.`);

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
    model: opts.transcribeModel,
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
      `OpenAI transcription HTTP ${response.status} (model "${opts.model}"): ${truncate(errText, 200)}`,
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

// OpenAI's /v1/models response shape is `{id, object, created, owned_by}` —
// it carries no capability metadata, and Groq's OpenAI-compatible endpoint
// is the same. So we can't *verify* chat-capability from the API. Instead
// we filter out ids that name a non-chat product category: these keywords
// are stable across vendors and won't collide with future chat-model launches
// (gpt-6, llama-5, qwen-4, …), so the list does not need maintenance when
// new chat families ship.
const NON_CHAT_KEYWORDS: readonly RegExp[] = [
  /whisper/i,            // STT — both OpenAI (whisper-1) and Groq (whisper-large-v3, distil-whisper)
  /transcribe/i,         // gpt-4o-transcribe, gpt-4o-mini-transcribe
  /\btts\b|-tts-|^tts-/i, // tts-1, tts-1-hd, playai-tts-*
  /embedding/i,          // text-embedding-3-*
  /moderation/i,         // omni-moderation-*, text-moderation-*
  /dall-e/i,             // image
  /gpt-image/i,
  /-image-preview/i,     // image-output preview variants
  /-realtime/i,          // websocket-only API
  /-audio-preview/i,     // audio-output variants — our path uses Whisper
  /-search-preview/i,    // tool-bound
  /computer-use/i,       // agent-tool API
  /^babbage-/i,
  /^davinci-/i,
  /^gpt-3\.5-turbo-instruct/i,
];

export function isSupportedChatModel(id: string): boolean {
  return id.length > 0 && !NON_CHAT_KEYWORDS.some((re) => re.test(id));
}

/**
 * End-to-end probe for an OpenAI-compatible host + chat model. Sends 1 s of
 * silence through `/audio/transcriptions` then through `/chat/completions`
 * with a strict JSON schema, mirroring the real lens path. Surfaces failures
 * from either step (bad key, model that doesn't exist on this host, model
 * that rejects strict json_schema).
 */
export async function runSelfTest(
  apiKey: string,
  baseUrl: OpenAiBaseUrl,
  model: string,
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
  await callOpenAiLens({
    apiKey,
    baseUrl,
    model,
    transcribeModel: OPENAI_TRANSCRIBE_MODELS[baseUrl],
    wav,
    prompt,
    schema,
  });
  return { latencyMs: Math.round(performance.now() - t0) };
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
    .filter(isSupportedChatModel)
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
