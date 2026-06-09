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
