// src/llm/openai.ts
//
// OpenAI-compatible provider. Two flavors share this code path:
//   - **Transcribe-then-chat** (OpenAI, Groq): the runtime calls
//     `/audio/transcriptions` first, then sends the transcript as a chat
//     completion. Used when `OPENAI_TRANSCRIBE_MODELS[baseUrl]` resolves.
//   - **Inline audio** (OpenRouter): no transcription endpoint. The WAV is
//     base64-encoded into an `input_audio` content part on the chat-completion
//     request. Used when `OPENAI_INLINE_AUDIO_HOSTS.has(baseUrl)`.
//
// Schema translation: the canonical lens schemas are Gemini-shaped (JSON
// Schema with `type`, `properties`, `required`, `items`, `description`).
// OpenAI's structured-output strict mode requires `additionalProperties:
// false` and that every property appear in `required`. `toStrictSchema`
// recurses the schema and injects both.
import { encodePcmToWav } from '@/runtime/audioBuffer';
import { OPENAI_INLINE_AUDIO_HOSTS, OPENAI_TRANSCRIBE_MODELS, openaiHostLabel, type OpenAiBaseUrl } from '@/types';
import { MAX_RETRIES, parseRetryAfterMs } from './gemini';
import { withFetchTimeout, UploadTimeoutError } from './fetchTimeout';
import { StreamingJsonParser } from './streamingJsonParser';

// Per-attempt deadlines for the OpenAI-compatible path. STT gets a longer
// ceiling because a 5-minute WAV (≈ 9.6 MB) takes meaningful upload time on
// flaky cellular; the chat completion sees a transcript-sized body so 60s is
// plenty. Without these the underlying browser fetch has no upper bound and
// will sit on a stalled socket indefinitely.
const STT_TIMEOUT_MS = 120_000;
const CHAT_TIMEOUT_MS = 60_000;

export interface CallOpenAiLensOptions {
  apiKey: string;
  baseUrl: OpenAiBaseUrl;
  /** Chat-completions model. */
  model: string;
  /**
   * Transcription model id (e.g. `whisper-1` on OpenAI, `whisper-large-v3` on
   * Groq). Required whenever the audio path is transcribe-then-chat; omitted
   * for inline-audio hosts (OpenRouter) where the WAV is attached as an
   * `input_audio` content part on the chat completion itself.
   */
  transcribeModel?: string;
  /**
   * STT host. When omitted or equal to `baseUrl`, STT happens on the chat
   * host (current behavior for OpenAI/Groq). When set to a different host,
   * the runtime posts to that host's `/audio/transcriptions` and only sends
   * the resulting transcript to `baseUrl`'s chat endpoint — the path used by
   * chat-only providers (DeepSeek, Perplexity) that have no STT of their own.
   */
  transcribeBaseUrl?: OpenAiBaseUrl;
  /** API key for `transcribeBaseUrl`. Falls back to `apiKey` when STT runs on the chat host. */
  transcribeApiKey?: string;
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
  if (!opts.apiKey) throw new Error(`Missing ${openaiHostLabel(opts.baseUrl)} API key.`);

  const baseSchema = opts.schema as Record<string, unknown>;
  const augmentedSchema = {
    ...baseSchema,
    properties: {
      noSpeech: { type: 'boolean', description: 'Set to true if no clear human speech is detected.' },
      ...((baseSchema['properties'] as Record<string, unknown> | undefined) ?? {}),
    },
  };
  const strict = toStrictSchema(augmentedSchema);

  // Build per-host user-message content. Three audio paths:
  //   1. Inline-audio hosts (OpenRouter): attach the WAV directly to the chat
  //      completion.
  //   2. Cross-host STT (DeepSeek, Perplexity): transcribe on a different
  //      whitelisted host (Groq/OpenAI Whisper), then send the transcript to
  //      the chat host. The STT key is opts.transcribeApiKey, not opts.apiKey.
  //   3. Same-host transcribe-then-chat (OpenAI, Groq): upload the WAV to the
  //      chat host's own Whisper endpoint with the same key.
  // STT happens outside the retry loop so a 429 from chat doesn't re-burn STT
  // quota by re-uploading the WAV.
  let userContent: unknown;
  if (OPENAI_INLINE_AUDIO_HOSTS.has(opts.baseUrl)) {
    userContent = [
      { type: 'input_audio', input_audio: { data: base64FromBytes(opts.wav), format: 'wav' } },
      { type: 'text', text: 'Analyze the audio above according to the system prompt.' },
    ];
  } else {
    const sttBaseUrl = opts.transcribeBaseUrl ?? opts.baseUrl;
    const sttApiKey = opts.transcribeBaseUrl && opts.transcribeBaseUrl !== opts.baseUrl
      ? (opts.transcribeApiKey ?? '')
      : opts.apiKey;
    if (!sttApiKey) {
      throw new Error(`Missing ${openaiHostLabel(sttBaseUrl)} API key for transcription.`);
    }
    const transcript = await transcribeAudio({
      apiKey: sttApiKey,
      baseUrl: sttBaseUrl,
      model: requireTranscribeModel(opts, sttBaseUrl),
      wav: opts.wav,
      signal: opts.signal,
    });
    userContent = transcriptUserMessage(transcript);
  }

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
      { role: 'system', content: opts.prompt },
      { role: 'user', content: userContent },
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
    // Per-attempt deadline: a hung socket on /chat/completions used to wedge
    // the whole user gesture. Now we abort after CHAT_TIMEOUT_MS and either
    // retry (transient-equivalent) or surface UploadTimeoutError on exhaust.
    const attemptCtl = withFetchTimeout(opts.signal, CHAT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: bodyJson,
        signal: attemptCtl.signal,
      });
    } catch (err) {
      attemptCtl.cleanup();
      if (opts.signal?.aborted) throw err;
      if (attemptCtl.timedOut()) {
        lastError = new UploadTimeoutError(
          `${openaiHostLabel(opts.baseUrl)} chat request timed out after ${CHAT_TIMEOUT_MS / 1000}s.`,
        );
        nextDelayMs = 1000;
        continue;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      nextDelayMs = 1000;
      continue;
    }
    attemptCtl.cleanup();

    if (response.status === 503 || response.status === 429) {
      const errText = await response.text();
      nextDelayMs = parseRetryAfterMs(response.headers.get('retry-after')) ?? (response.status === 429 ? 5000 : 1000);
      lastError = new Error(`${openaiHostLabel(opts.baseUrl)} HTTP ${response.status}: ${truncate(errText, 2000)}`);
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`${openaiHostLabel(opts.baseUrl)} HTTP ${response.status}: ${truncate(errText, 2000)}`);
    }

    const payload = (await response.json()) as ChatCompletionsResponse;
    if (payload.error?.message) throw new Error(`${openaiHostLabel(opts.baseUrl)} error: ${payload.error.message}`);
    const text = payload.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${openaiHostLabel(opts.baseUrl)} returned no message content.`);
    return text;
  }
  throw lastError ?? new Error('callOpenAiLens: exhausted retries without a result.');
}

// ---------- Streaming variant ----------

export interface CallOpenAiLensStreamOptions extends CallOpenAiLensOptions {
  /** Fires for each complete object in the first top-level array of the
   *  response. `key` is the array's property name (`claims`, `questions`,
   *  `starters`, …). */
  onPartialClaim?: (claim: Record<string, unknown>, key: string) => void;
  /** Fires when a top-level scalar property finishes parsing — once per key. */
  onPartialField?: (name: string, value: string | number | boolean | null) => void;
  /** Fires as soon as `"noSpeech": true` is visible in the accumulating buffer. */
  onNoSpeech?: () => void;
}

interface ChatCompletionsChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  error?: { message?: string };
}

/**
 * Streaming variant of `callOpenAiLens`. Same STT-then-chat shape as the
 * non-streaming path, but the chat completion is requested with
 * `stream: true` and the SSE response is drained into the shared
 * `StreamingJsonParser` so the HUD can render the first claim before the full
 * response arrives.
 *
 * Retry policy matches the non-streaming variant on connection setup; once
 * the stream opens we never retry — partial UI already on screen would jitter.
 */
export async function callOpenAiLensStream(opts: CallOpenAiLensStreamOptions): Promise<string> {
  if (!opts.apiKey) throw new Error(`Missing ${openaiHostLabel(opts.baseUrl)} API key.`);

  const baseSchema = opts.schema as Record<string, unknown>;
  const augmentedSchema = {
    ...baseSchema,
    properties: {
      noSpeech: { type: 'boolean', description: 'Set to true if no clear human speech is detected.' },
      ...((baseSchema['properties'] as Record<string, unknown> | undefined) ?? {}),
    },
  };
  const strict = toStrictSchema(augmentedSchema);

  // STT (or inline-audio prep) happens once, outside the retry loop — same
  // pattern as the non-streaming path so a chat-side 429 doesn't re-burn STT
  // quota.
  let userContent: unknown;
  if (OPENAI_INLINE_AUDIO_HOSTS.has(opts.baseUrl)) {
    userContent = [
      { type: 'input_audio', input_audio: { data: base64FromBytes(opts.wav), format: 'wav' } },
      { type: 'text', text: 'Analyze the audio above according to the system prompt.' },
    ];
  } else {
    const sttBaseUrl = opts.transcribeBaseUrl ?? opts.baseUrl;
    const sttApiKey = opts.transcribeBaseUrl && opts.transcribeBaseUrl !== opts.baseUrl
      ? (opts.transcribeApiKey ?? '')
      : opts.apiKey;
    if (!sttApiKey) {
      throw new Error(`Missing ${openaiHostLabel(sttBaseUrl)} API key for transcription.`);
    }
    const transcript = await transcribeAudio({
      apiKey: sttApiKey,
      baseUrl: sttBaseUrl,
      model: requireTranscribeModel(opts, sttBaseUrl),
      wav: opts.wav,
      signal: opts.signal,
    });
    userContent = transcriptUserMessage(transcript);
  }

  const bodyJson = JSON.stringify({
    model: opts.model,
    temperature: 0.2,
    stream: true,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'lens_result', strict: true, schema: strict },
    },
    messages: [
      { role: 'system', content: opts.prompt },
      { role: 'user', content: userContent },
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
    const attemptCtl = withFetchTimeout(opts.signal, CHAT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: bodyJson,
        signal: attemptCtl.signal,
      });
    } catch (err) {
      attemptCtl.cleanup();
      if (opts.signal?.aborted) throw err;
      if (attemptCtl.timedOut()) {
        lastError = new UploadTimeoutError(
          `${openaiHostLabel(opts.baseUrl)} chat request timed out after ${CHAT_TIMEOUT_MS / 1000}s.`,
        );
        nextDelayMs = 1000;
        continue;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      nextDelayMs = 1000;
      continue;
    }
    attemptCtl.cleanup();

    if (response.status === 503 || response.status === 429) {
      const errText = await response.text();
      nextDelayMs = parseRetryAfterMs(response.headers.get('retry-after')) ?? (response.status === 429 ? 5000 : 1000);
      lastError = new Error(`${openaiHostLabel(opts.baseUrl)} HTTP ${response.status}: ${truncate(errText, 2000)}`);
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`${openaiHostLabel(opts.baseUrl)} HTTP ${response.status}: ${truncate(errText, 2000)}`);
    }

    if (!response.body) throw new Error(`${openaiHostLabel(opts.baseUrl)} stream returned no body.`);
    return consumeOpenAiStream(response.body, opts);
  }
  throw lastError ?? new Error('callOpenAiLensStream: exhausted retries without a stream.');
}

/**
 * Drain an OpenAI-compatible chat-completions SSE stream. Each event carries
 * `data: {…}` with `choices[0].delta.content`; the final event is
 * `data: [DONE]`. We accumulate the content fragments and feed them to the
 * shared `StreamingJsonParser`.
 */
async function consumeOpenAiStream(
  body: ReadableStream<Uint8Array>,
  opts: CallOpenAiLensStreamOptions,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new StreamingJsonParser();
  let pending = '';

  const dispatch = (chunk: string): void => {
    if (!chunk) return;
    parser.feed(chunk, (event) => {
      if (event.type === 'claim') opts.onPartialClaim?.(event.claim, event.key);
      else if (event.type === 'field') opts.onPartialField?.(event.name, event.value);
      else if (event.type === 'noSpeech') opts.onNoSpeech?.();
    });
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const events = pending.split(/\r?\n\r?\n/);
      pending = events.pop() ?? '';
      for (const block of events) {
        const data = parseSseDataBlock(block);
        if (data === null) continue;
        if (data === '[DONE]') continue;
        const payload = safeJsonParseChunk(data);
        if (!payload) continue;
        if (payload.error?.message) {
          throw new Error(`${openaiHostLabel(opts.baseUrl)} error: ${payload.error.message}`);
        }
        const delta = payload.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') dispatch(delta);
      }
    }
    pending += decoder.decode();
    if (pending.trim().length > 0) {
      const data = parseSseDataBlock(pending);
      if (data && data !== '[DONE]') {
        const payload = safeJsonParseChunk(data);
        if (payload?.error?.message) {
          throw new Error(`${openaiHostLabel(opts.baseUrl)} error: ${payload.error.message}`);
        }
        const delta = payload?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') dispatch(delta);
      }
    }
  } finally {
    reader.releaseLock();
  }

  parser.end((event) => {
    if (event.type === 'noSpeech') opts.onNoSpeech?.();
  });

  const text = parser.text;
  if (!text) throw new Error(`${openaiHostLabel(opts.baseUrl)} stream returned no content.`);
  return text;
}

function parseSseDataBlock(block: string): string | null {
  const lines = block.split(/\r?\n/);
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

function safeJsonParseChunk(s: string): ChatCompletionsChunk | null {
  try {
    return JSON.parse(s) as ChatCompletionsChunk;
  } catch {
    return null;
  }
}

/**
 * Validate that a transcribe model was passed in. Throws a clear error if
 * the facade forgot to look one up — this should never fire in production
 * but guards against silently sending an `undefined` model id to Whisper.
 * The label uses the STT host (which may differ from the chat host for the
 * cross-host STT path used by DeepSeek/Perplexity).
 */
function requireTranscribeModel(opts: CallOpenAiLensOptions, sttBaseUrl: OpenAiBaseUrl): string {
  if (!opts.transcribeModel) {
    throw new Error(
      `Missing transcribeModel for ${openaiHostLabel(sttBaseUrl)}.`,
    );
  }
  return opts.transcribeModel;
}

/** Standard base64 encoder for raw byte arrays. WAV payloads are small (≤ 5 min × 32 kB/s ≈ 10 MB) so the chunked approach avoids stack overflows on the spread operator. */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize) as unknown as number[];
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
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

export interface TranscribeOptions {
  apiKey: string;
  baseUrl: OpenAiBaseUrl;
  model: string;
  wav: Uint8Array;
  signal?: AbortSignal;
}

export async function transcribeAudio(opts: TranscribeOptions): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([opts.wav as BlobPart], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', opts.model);
  form.append('response_format', 'json');
  // STT_TIMEOUT_MS bounds the upload + Whisper inference. Without it, a
  // stalled connection on a 5-minute WAV (≈ 9.6 MB) sits forever — the bug
  // that prompted item-A in the v0.12.0 plan.
  const attemptCtl = withFetchTimeout(opts.signal, STT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${opts.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: form,
      signal: attemptCtl.signal,
    });
  } catch (err) {
    attemptCtl.cleanup();
    if (opts.signal?.aborted) throw err;
    if (attemptCtl.timedOut()) {
      throw new UploadTimeoutError(
        `${openaiHostLabel(opts.baseUrl)} transcription timed out after ${STT_TIMEOUT_MS / 1000}s (model "${opts.model}"). Try a shorter buffer or a faster connection.`,
      );
    }
    throw err;
  }
  attemptCtl.cleanup();
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `${openaiHostLabel(opts.baseUrl)} transcription HTTP ${response.status} (model "${opts.model}"): ${truncate(errText, 2000)}`,
    );
  }
  const payload = (await response.json()) as TranscriptionResponse;
  if (payload.error?.message) {
    throw new Error(`${openaiHostLabel(opts.baseUrl)} transcription error: ${payload.error.message}`);
  }
  return payload.text ?? '';
}

interface ModelsListResponse {
  data?: Array<{
    id?: string;
    /**
     * OpenRouter-only metadata. Other openai-compatible hosts return just
     * `{id, object, created, owned_by}` with no capability flags, so this is
     * `undefined` there and the audio-modality filter is skipped.
     */
    architecture?: { input_modalities?: string[] };
  }>;
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
  /** Per-host transcription model id. Falls back to OPENAI_TRANSCRIBE_MODELS
   *  when omitted, which keeps inline-audio hosts (OpenRouter) on the
   *  inline-audio branch (the lookup returns undefined). */
  transcribeModel?: string,
  /** Cross-host STT overrides for chat-only hosts (DeepSeek, Perplexity). */
  cross?: { transcribeBaseUrl?: OpenAiBaseUrl; transcribeApiKey?: string },
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
    transcribeModel: transcribeModel || OPENAI_TRANSCRIBE_MODELS[cross?.transcribeBaseUrl ?? baseUrl],
    transcribeBaseUrl: cross?.transcribeBaseUrl,
    transcribeApiKey: cross?.transcribeApiKey,
    wav,
    prompt,
    schema,
  });
  return { latencyMs: Math.round(performance.now() - t0) };
}

/**
 * Fetch chat-completion-capable model ids exposed by the provider.
 *
 * Inline-audio hosts (OpenRouter): also require `architecture.input_modalities`
 * to include `audio`, because we'll attach the WAV inline rather than running
 * STT — picking a non-audio model would 400 at request time.
 */
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
  const inlineAudio = OPENAI_INLINE_AUDIO_HOSTS.has(baseUrl);
  return (data.data ?? [])
    .filter((m) => {
      const id = m.id ?? '';
      if (id.length === 0) return false;
      if (inlineAudio) {
        // OpenRouter exposes an authoritative `input_modalities` capability
        // flag. Trust it instead of running `isSupportedChatModel` — the
        // keyword heuristic would (correctly for plain OpenAI) reject
        // `*-audio-preview` ids that are audio-input-capable on OpenRouter.
        return Array.isArray(m.architecture?.input_modalities)
          && m.architecture!.input_modalities!.includes('audio');
      }
      return isSupportedChatModel(id);
    })
    .map((m) => m.id ?? '')
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
