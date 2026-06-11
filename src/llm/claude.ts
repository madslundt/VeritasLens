// src/llm/claude.ts
//
// Anthropic Claude provider. Claude doesn't accept raw audio on its current
// public API, so this module is a pure text path: the caller transcribes the
// WAV first (via the same `sttHost` flow that DeepSeek/Perplexity use) and
// passes the transcript here.
//
// Structured output uses Anthropic's tool-use shaping: we register a single
// tool whose `input_schema` is the lens's Gemini-shaped JSON Schema, and ask
// Claude to call it. The returned tool call's `input` field IS the structured
// JSON object the lens's `parse()` consumes — same contract as Gemini's
// `responseSchema` path, so the lens parsers don't have to know which
// provider produced the JSON.
//
// Auth: Anthropic uses the `x-api-key` header (not Bearer) and requires
// `anthropic-version`. CORS for the browser is enabled with
// `anthropic-dangerous-direct-browser-access: true` — the Even App WebView
// is a controlled client, so the same model applies as for our other
// browser-issued provider calls.

import {
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  type ClaudeModel,
} from '@/types';
import { MAX_RETRIES, parseRetryAfterMs } from './gemini';
import { withFetchTimeout, UploadTimeoutError } from './fetchTimeout';
import { StreamingJsonParser } from './streamingJsonParser';

export const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const CLAUDE_API_VERSION = '2023-06-01';

const CHAT_TIMEOUT_MS = 60_000;
const LENS_TOOL_NAME = 'emit_lens_result';
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

function resolveModel(raw: string | undefined): ClaudeModel {
  if (raw && (CLAUDE_MODELS as readonly string[]).includes(raw)) {
    return raw as ClaudeModel;
  }
  return DEFAULT_CLAUDE_MODEL;
}

export interface CallClaudeLensOptions {
  apiKey: string;
  /** Transcript of the WAV — Claude has no audio modality on this API. */
  transcript: string;
  /** Fully-built, language-aware system prompt. */
  prompt: string;
  /** Gemini-style responseSchema. Used verbatim as the tool's input_schema. */
  schema: unknown;
  signal?: AbortSignal;
  model?: ClaudeModel | string;
  /** Called before each retry (attempt = 1..MAX_RETRIES). */
  onRetry?: (attempt: number) => void | Promise<void>;
}

interface MessagesResponseContentToolUse {
  type: 'tool_use';
  name: string;
  input: unknown;
}

interface MessagesResponseContentText {
  type: 'text';
  text: string;
}

type MessagesResponseContent = MessagesResponseContentToolUse | MessagesResponseContentText | { type: string };

interface MessagesResponse {
  content?: MessagesResponseContent[];
  stop_reason?: string;
  error?: { type?: string; message?: string };
}

/**
 * Augment the lens schema with the `noSpeech` flag — same shape every other
 * provider in this codebase injects. Lens authors don't have to declare it
 * themselves, and the existing "set noSpeech=true if no speech" preamble in
 * `lifecycle.ts` matches the augmented schema.
 */
function augmentSchema(schema: unknown): Record<string, unknown> {
  const base = (schema ?? {}) as Record<string, unknown>;
  const props = (base['properties'] as Record<string, unknown> | undefined) ?? {};
  return {
    ...base,
    properties: {
      noSpeech: { type: 'boolean', description: 'Set to true if no clear human speech is detected.' },
      ...props,
    },
  };
}

function transcriptUserMessage(transcript: string): string {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) {
    return '[Audio transcript: <empty — no speech captured>]';
  }
  return `[Audio transcript]\n${trimmed}`;
}

/**
 * POST a single message turn to `/v1/messages` and return the raw JSON of the
 * tool-use input as a string — same contract as `callGeminiLens` and
 * `callOpenAiLens`, so the lens's `parse()` consumes it identically.
 */
export async function callLens(opts: CallClaudeLensOptions): Promise<string> {
  if (!opts.apiKey) throw new Error('Missing Anthropic API key.');

  const schema = augmentSchema(opts.schema);
  const body = {
    model: resolveModel(opts.model),
    max_tokens: 2048,
    temperature: 0.2,
    system: opts.prompt,
    tools: [{
      name: LENS_TOOL_NAME,
      description: 'Emit the structured lens result for the audio transcript above.',
      input_schema: schema,
    }],
    tool_choice: { type: 'tool', name: LENS_TOOL_NAME },
    messages: [{
      role: 'user',
      content: transcriptUserMessage(opts.transcript),
    }],
  };
  const bodyJson = JSON.stringify(body);

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
      response = await fetch(CLAUDE_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': CLAUDE_API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: bodyJson,
        signal: attemptCtl.signal,
      });
    } catch (err) {
      attemptCtl.cleanup();
      if (opts.signal?.aborted) throw err;
      if (attemptCtl.timedOut()) {
        lastError = new UploadTimeoutError(
          `Anthropic request timed out after ${CHAT_TIMEOUT_MS / 1000}s.`,
        );
        nextDelayMs = 1000;
        continue;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      nextDelayMs = 1000;
      continue;
    }
    attemptCtl.cleanup();

    if (TRANSIENT_STATUSES.has(response.status)) {
      const errText = await response.text();
      nextDelayMs = parseRetryAfterMs(response.headers.get('retry-after')) ?? (response.status === 429 ? 5000 : 1000);
      lastError = new Error(`Anthropic HTTP ${response.status}: ${truncate(errText, 2000)}`);
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic HTTP ${response.status}: ${truncate(errText, 2000)}`);
    }

    const payload = (await response.json()) as MessagesResponse;
    if (payload.error?.message) {
      throw new Error(`Anthropic error: ${payload.error.message}`);
    }
    const toolUse = payload.content?.find(
      (c): c is MessagesResponseContentToolUse => c.type === 'tool_use' && (c as MessagesResponseContentToolUse).name === LENS_TOOL_NAME,
    );
    if (!toolUse) {
      // Claude can refuse the tool call (e.g. content policy) and just emit
      // text. Surface that text so the wearer sees what happened rather than
      // a vague "no content".
      const fallbackText = payload.content?.find((c): c is MessagesResponseContentText => c.type === 'text')?.text;
      throw new Error(
        fallbackText
          ? `Anthropic skipped the tool call: ${truncate(fallbackText, 500)}`
          : 'Anthropic returned no tool_use content.',
      );
    }
    return JSON.stringify(toolUse.input);
  }

  throw lastError ?? new Error('callClaudeLens: exhausted retries without a result.');
}

// ---------- Streaming variant ----------

export interface CallClaudeLensStreamOptions extends CallClaudeLensOptions {
  /** Fires for each complete object in the first top-level array of the
   *  response. `key` is the array's property name (`claims`, `questions`,
   *  `starters`, …). */
  onPartialClaim?: (claim: Record<string, unknown>, key: string) => void;
  /** Fires when a top-level scalar property finishes parsing — once per key. */
  onPartialField?: (name: string, value: string | number | boolean | null) => void;
  /** Names of string-valued properties whose mid-stream content is surfaced
   *  via `onPartialString` for incremental HUD heading render. */
  watchValueKeys?: ReadonlySet<string>;
  /** Fires while a watched value is being read, with cumulative decoded
   *  content. Caller is expected to throttle HUD commits. */
  onPartialString?: (name: string, partial: string) => void;
  /** Fires as soon as `"noSpeech": true` is visible in the accumulating buffer. */
  onNoSpeech?: () => void;
}

interface ClaudeStreamEvent {
  type: string;
  index?: number;
  content_block?: { type?: string; name?: string };
  delta?: { type?: string; partial_json?: string; stop_reason?: string };
  error?: { type?: string; message?: string };
}

/**
 * Streaming variant of `callLens`. Same retry/timeout policy on connection
 * setup as the non-streaming path; once we start receiving bytes we surface
 * partials immediately and never retry. The tool-use `input` JSON is streamed
 * as `input_json_delta.partial_json` fragments which we accumulate and feed
 * to the shared `StreamingJsonParser`.
 *
 * Returns the accumulated tool-input JSON string on success — identical
 * contract to `callLens` so the lens's existing `parse()` runs unchanged.
 */
export async function callLensStream(opts: CallClaudeLensStreamOptions): Promise<string> {
  if (!opts.apiKey) throw new Error('Missing Anthropic API key.');

  const schema = augmentSchema(opts.schema);
  const body = {
    model: resolveModel(opts.model),
    max_tokens: 2048,
    temperature: 0.2,
    stream: true,
    system: opts.prompt,
    tools: [{
      name: LENS_TOOL_NAME,
      description: 'Emit the structured lens result for the audio transcript above.',
      input_schema: schema,
    }],
    tool_choice: { type: 'tool', name: LENS_TOOL_NAME },
    messages: [{
      role: 'user',
      content: transcriptUserMessage(opts.transcript),
    }],
  };
  const bodyJson = JSON.stringify(body);

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
      response = await fetch(CLAUDE_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-api-key': opts.apiKey,
          'anthropic-version': CLAUDE_API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: bodyJson,
        signal: attemptCtl.signal,
      });
    } catch (err) {
      attemptCtl.cleanup();
      if (opts.signal?.aborted) throw err;
      if (attemptCtl.timedOut()) {
        lastError = new UploadTimeoutError(
          `Anthropic request timed out after ${CHAT_TIMEOUT_MS / 1000}s.`,
        );
        nextDelayMs = 1000;
        continue;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      nextDelayMs = 1000;
      continue;
    }
    attemptCtl.cleanup();

    if (TRANSIENT_STATUSES.has(response.status)) {
      const errText = await response.text();
      nextDelayMs = parseRetryAfterMs(response.headers.get('retry-after')) ?? (response.status === 429 ? 5000 : 1000);
      lastError = new Error(`Anthropic HTTP ${response.status}: ${truncate(errText, 2000)}`);
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic HTTP ${response.status}: ${truncate(errText, 2000)}`);
    }

    if (!response.body) throw new Error('Anthropic stream returned no body.');
    return consumeClaudeStream(response.body, opts);
  }

  throw lastError ?? new Error('callClaudeLensStream: exhausted retries without a stream.');
}

/**
 * Drain Anthropic's `/v1/messages` SSE stream. Tool-use input is split across
 * `content_block_delta` events of subtype `input_json_delta`, each carrying a
 * `partial_json` fragment. We track which content block holds our tool call
 * (by `content_block_start`'s `name`) and accumulate only those fragments.
 */
async function consumeClaudeStream(
  body: ReadableStream<Uint8Array>,
  opts: CallClaudeLensStreamOptions,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new StreamingJsonParser({ watchValueKeys: opts.watchValueKeys });
  let pending = '';
  let toolBlockIndex: number | undefined;
  let saw_tool_use = false;

  // See gemini.ts:consumeStream for the rationale — `attemptCtl.cleanup()`
  // already ran, so the fetch-level abort no longer cancels the body reader.
  // Wire the outer signal directly so a user double-tap during streaming
  // tears down the connection instead of leaving the reader spinning.
  const onAbort = (): void => { void reader.cancel(); };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort);
  }
  const throwIfAborted = (): void => {
    if (!opts.signal?.aborted) return;
    const e = new Error('Aborted');
    e.name = 'AbortError';
    throw e;
  };

  const dispatch = (chunk: string): void => {
    if (!chunk) return;
    parser.feed(chunk, (event) => {
      if (event.type === 'claim') opts.onPartialClaim?.(event.claim, event.key);
      else if (event.type === 'field') opts.onPartialField?.(event.name, event.value);
      else if (event.type === 'valueChunk') opts.onPartialString?.(event.name, event.partial);
      else if (event.type === 'noSpeech') opts.onNoSpeech?.();
    });
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      throwIfAborted();
      pending += decoder.decode(value, { stream: true });
      const events = pending.split(/\r?\n\r?\n/);
      pending = events.pop() ?? '';
      for (const block of events) {
        const data = parseSseDataBlock(block);
        if (data === null) continue;
        const evt = safeJsonParseEvent(data);
        if (!evt) continue;
        if (evt.type === 'error' && evt.error?.message) {
          throw new Error(`Anthropic error: ${evt.error.message}`);
        }
        if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use'
            && evt.content_block.name === LENS_TOOL_NAME) {
          toolBlockIndex = evt.index;
          saw_tool_use = true;
          continue;
        }
        if (evt.type === 'content_block_delta'
            && evt.delta?.type === 'input_json_delta'
            && typeof evt.delta.partial_json === 'string'
            && evt.index === toolBlockIndex) {
          dispatch(evt.delta.partial_json);
        }
      }
    }
    pending += decoder.decode();
    if (pending.trim().length > 0) {
      const data = parseSseDataBlock(pending);
      if (data) {
        const evt = safeJsonParseEvent(data);
        if (evt?.type === 'content_block_delta'
            && evt.delta?.type === 'input_json_delta'
            && typeof evt.delta.partial_json === 'string'
            && evt.index === toolBlockIndex) {
          dispatch(evt.delta.partial_json);
        }
      }
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }

  throwIfAborted();

  parser.end((event) => {
    if (event.type === 'noSpeech') opts.onNoSpeech?.();
  });

  if (!saw_tool_use) {
    throw new Error('Anthropic stream returned no tool_use content.');
  }
  const text = parser.text;
  if (!text) throw new Error('Anthropic stream returned no tool-input fragments.');
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

function safeJsonParseEvent(s: string): ClaudeStreamEvent | null {
  try {
    return JSON.parse(s) as ClaudeStreamEvent;
  } catch {
    return null;
  }
}

/**
 * Reachability probe. Sends a tiny tool-use round-trip with a constant
 * schema, mirroring the real lens path. Failures from a wrong key,
 * unavailable model, or version mismatch surface here.
 */
export async function runSelfTest(
  apiKey: string,
  model?: ClaudeModel | string,
): Promise<{ latencyMs: number }> {
  const prompt = 'Respond by calling the tool with `{"ok": true}`.';
  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  };
  const t0 = performance.now();
  await callLens({ apiKey, transcript: 'self-test', prompt, schema, model });
  return { latencyMs: Math.round(performance.now() - t0) };
}

/**
 * Anthropic exposes `/v1/models` but it doesn't include capability metadata
 * relevant to our path (every chat model can do tool-use). Surface the
 * curated `CLAUDE_MODELS` list and intersect with any ids the API returns,
 * so a newly-released model that we haven't hard-coded yet is still usable
 * once added to the constant. Returns the curated list unchanged when the
 * API is unreachable — matches the offline-first behavior of the Gemini
 * provider's model lister.
 */
export async function fetchAvailableModels(apiKey: string, signal?: AbortSignal): Promise<string[]> {
  if (!apiKey) return [...CLAUDE_MODELS];
  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': CLAUDE_API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      signal,
    });
    if (!response.ok) return [...CLAUDE_MODELS];
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    const apiIds = new Set((data.data ?? []).map((m) => m.id ?? '').filter(Boolean));
    // Surface curated entries first (stable ordering for the UI), then any
    // extra ids the API knows about but we haven't curated yet.
    const curated = (CLAUDE_MODELS as readonly string[]).filter((id) => apiIds.has(id) || apiIds.size === 0);
    const extras = [...apiIds].filter((id) => !(CLAUDE_MODELS as readonly string[]).includes(id)).sort();
    return [...curated, ...extras];
  } catch {
    return [...CLAUDE_MODELS];
  }
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
