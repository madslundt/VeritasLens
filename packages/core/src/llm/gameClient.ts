// src/llm/gameClient.ts
//
// Text-only generation path for game sessions. Game mode bypasses the audio
// lifecycle entirely (no mic, no WAV, no transcription), so this client makes
// a single text-only request against the active provider and returns the raw
// JSON text the persona parser consumes.
//
// Reuses the retry shape from `callLens` (transient HTTP statuses, Retry-After
// hints, ±25% jitter on fallback delays) so the HUD's R1/3 flash works the
// same way as for lens analyses.

import {
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODEL_PATTERN,
  OPENAI_BASE_URLS,
  type ClaudeModel,
  type GeminiModel,
  type LlmProvider,
  type OpenAiBaseUrl,
} from '@/types';
import { MAX_RETRIES, parseGoogleRetryDelayMs, parseRetryAfterMs } from './gemini';
import { toStrictSchema } from './openai';
import { withFetchTimeout, UploadTimeoutError } from './fetchTimeout';
import { settings } from '@/state/store';

const CHAT_TIMEOUT_MS = 60_000;
const MAX_RETRY_DELAY_MS = 8_000;
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const LENS_TOOL_NAME = 'emit_game_questions';
const CLAUDE_API_VERSION = '2023-06-01';

export interface CallGameOptions {
  prompt: string;
  schema: unknown;
  signal?: AbortSignal;
  /** Called before each retry (attempt = 1..MAX_RETRIES). */
  onRetry?: (attempt: number) => void | Promise<void>;
}

/**
 * Dispatch the game generation call to the active provider. Pulls credentials
 * and model from `settings()` at call time — mirrors how `callLens` works in
 * `src/llm/index.ts`. Returns the raw JSON text from the provider; the
 * persona's `parseGameResponse` consumes it.
 */
export async function callGame(opts: CallGameOptions): Promise<string> {
  const s = settings();
  switch (s.provider) {
    case 'claude':
      return callGameClaude(opts, s.claudeApiKey, resolveClaudeModel(s.claudeModel));
    case 'openai-compatible':
      return callGameOpenAi(
        opts,
        s.openaiApiKeys[s.openaiBaseUrl] ?? '',
        s.openaiBaseUrl,
        s.openaiModel,
      );
    case 'gemini':
    default:
      return callGameGemini(opts, s.geminiApiKey, resolveGeminiModel(s.geminiModel));
  }
}

// ---------- Gemini ----------

const GEMINI_ENDPOINT = (model: string): string =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  promptFeedback?: { blockReason?: string };
}

async function callGameGemini(opts: CallGameOptions, apiKey: string, model: GeminiModel): Promise<string> {
  if (!apiKey) throw new Error('Missing Gemini API key.');
  const bodyJson = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
    generationConfig: {
      temperature: 0.6,
      responseMimeType: 'application/json',
      responseSchema: opts.schema,
    },
  });

  return runWithRetry(opts.signal, opts.onRetry, async (signal) => {
    const response = await fetch(`${GEMINI_ENDPOINT(model)}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyJson,
      signal,
    });
    return parseGeminiResponse(response);
  }, 'Gemini');
}

async function parseGeminiResponse(response: Response): Promise<string> {
  if (!response.ok) {
    const errText = await response.text();
    if (TRANSIENT_STATUSES.has(response.status)) {
      throw new TransientError(
        `Gemini HTTP ${response.status}: ${truncate(errText, 2000)}`,
        response.headers.get('retry-after'),
        errText,
      );
    }
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

// ---------- OpenAI-compatible ----------

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

async function callGameOpenAi(
  opts: CallGameOptions,
  apiKey: string,
  baseUrl: OpenAiBaseUrl,
  model: string,
): Promise<string> {
  if (!apiKey) throw new Error('Missing OpenAI-compatible API key.');
  const strict = toStrictSchema(opts.schema);
  const bodyJson = JSON.stringify({
    model,
    temperature: 0.6,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'game_questions', strict: true, schema: strict },
    },
    messages: [{ role: 'system', content: opts.prompt }],
  });

  if (!(OPENAI_BASE_URLS as readonly string[]).includes(baseUrl)) {
    throw new Error(`Unsupported OpenAI base URL: ${baseUrl}`);
  }

  return runWithRetry(opts.signal, opts.onRetry, async (signal) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: bodyJson,
      signal,
    });
    if (!response.ok) {
      const errText = await response.text();
      if (TRANSIENT_STATUSES.has(response.status)) {
        throw new TransientError(
          `Chat HTTP ${response.status}: ${truncate(errText, 2000)}`,
          response.headers.get('retry-after'),
          null,
        );
      }
      throw new Error(`Chat HTTP ${response.status}: ${truncate(errText, 2000)}`);
    }
    const payload = (await response.json()) as ChatCompletionsResponse;
    if (payload.error?.message) throw new Error(`Chat error: ${payload.error.message}`);
    const text = payload.choices?.[0]?.message?.content;
    if (!text) throw new Error('Chat returned no message content.');
    return text;
  }, 'OpenAI');
}

// ---------- Claude ----------

interface ClaudeContentToolUse { type: 'tool_use'; name: string; input: unknown; }
interface ClaudeContentText { type: 'text'; text: string; }
type ClaudeContent = ClaudeContentToolUse | ClaudeContentText | { type: string };
interface MessagesResponse {
  content?: ClaudeContent[];
  error?: { message?: string };
}

async function callGameClaude(opts: CallGameOptions, apiKey: string, model: ClaudeModel): Promise<string> {
  if (!apiKey) throw new Error('Missing Anthropic API key.');
  const bodyJson = JSON.stringify({
    model,
    max_tokens: 4096,
    temperature: 0.6,
    system: opts.prompt,
    tools: [{
      name: LENS_TOOL_NAME,
      description: 'Emit the structured list of game questions.',
      input_schema: opts.schema,
    }],
    tool_choice: { type: 'tool', name: LENS_TOOL_NAME },
    // Game mode has no transcript — Claude requires at least one user message,
    // so we satisfy that with a single token of context. The tool schema does
    // all the heavy lifting.
    messages: [{ role: 'user', content: 'Generate the questions now.' }],
  });

  return runWithRetry(opts.signal, opts.onRetry, async (signal) => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': CLAUDE_API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: bodyJson,
      signal,
    });
    if (!response.ok) {
      const errText = await response.text();
      if (TRANSIENT_STATUSES.has(response.status)) {
        throw new TransientError(
          `Anthropic HTTP ${response.status}: ${truncate(errText, 2000)}`,
          response.headers.get('retry-after'),
          null,
        );
      }
      throw new Error(`Anthropic HTTP ${response.status}: ${truncate(errText, 2000)}`);
    }
    const payload = (await response.json()) as MessagesResponse;
    if (payload.error?.message) throw new Error(`Anthropic error: ${payload.error.message}`);
    const toolUse = payload.content?.find(
      (c): c is ClaudeContentToolUse => c.type === 'tool_use' && (c as ClaudeContentToolUse).name === LENS_TOOL_NAME,
    );
    if (!toolUse) {
      const fallback = payload.content?.find((c): c is ClaudeContentText => c.type === 'text')?.text;
      throw new Error(
        fallback ? `Anthropic skipped the tool call: ${truncate(fallback, 500)}` : 'Anthropic returned no tool_use content.',
      );
    }
    return JSON.stringify(toolUse.input);
  }, 'Anthropic');
}

// ---------- Shared retry loop ----------

/** Carries server-supplied delay hints back up the retry loop. */
class TransientError extends Error {
  retryAfterHeader: string | null;
  geminiBody: string | null;
  constructor(message: string, retryAfterHeader: string | null, geminiBody: string | null) {
    super(message);
    this.name = 'TransientError';
    this.retryAfterHeader = retryAfterHeader;
    this.geminiBody = geminiBody;
  }
}

async function runWithRetry(
  outerSignal: AbortSignal | undefined,
  onRetry: ((attempt: number) => void | Promise<void>) | undefined,
  attemptOnce: (signal: AbortSignal) => Promise<string>,
  providerLabel: string,
): Promise<string> {
  let lastError: Error | undefined;
  let nextDelayMs = 1000;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await onRetry?.(attempt);
      await retryDelay(nextDelayMs, outerSignal);
    }
    const attemptCtl = withFetchTimeout(outerSignal, CHAT_TIMEOUT_MS);
    try {
      const result = await attemptOnce(attemptCtl.signal);
      attemptCtl.cleanup();
      return result;
    } catch (err) {
      attemptCtl.cleanup();
      if (outerSignal?.aborted) throw err;
      if (attemptCtl.timedOut()) {
        lastError = new UploadTimeoutError(
          `${providerLabel} request timed out after ${CHAT_TIMEOUT_MS / 1000}s.`,
        );
        nextDelayMs = jitter(1000);
        continue;
      }
      if (err instanceof TransientError) {
        const hinted =
          parseRetryAfterMs(err.retryAfterHeader)
          ?? (err.geminiBody ? parseGoogleRetryDelayMs(err.geminiBody) : null);
        nextDelayMs = hinted ?? jitter(1000);
        lastError = err;
        continue;
      }
      // Non-transient — surface immediately. Aborts also land here when the
      // outer signal is not set; the loop above already handled the standard
      // user-cancel path.
      if ((err as Error)?.name === 'AbortError') throw err;
      throw err;
    }
  }
  throw lastError ?? new Error(`${providerLabel} game request: exhausted retries.`);
}

function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
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

function jitter(ms: number): number {
  const factor = 0.75 + Math.random() * 0.5;
  return Math.min(Math.max(Math.round(ms * factor), 250), MAX_RETRY_DELAY_MS);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function resolveGeminiModel(raw: string | undefined): GeminiModel {
  if (raw && GEMINI_MODEL_PATTERN.test(raw)) return raw as GeminiModel;
  return DEFAULT_GEMINI_MODEL;
}

function resolveClaudeModel(raw: string | undefined): ClaudeModel {
  if (raw && (CLAUDE_MODELS as readonly string[]).includes(raw)) return raw as ClaudeModel;
  return DEFAULT_CLAUDE_MODEL;
}

/** Provider label for diagnostics — used by gameClient internals only. */
export function activeProviderLabel(): LlmProvider {
  return settings().provider;
}
