// src/llm/openaiResponses.ts
//
// OpenAI Responses API client — used **only** when a grounded lens runs
// against the OpenAI host. Chat Completions stays the default for every
// other call (it's faster, has wider model support, and matches the shape
// every other OpenAI-compatible host expects). When the grounding resolver
// picks `useResponsesApi: true`, the facade dispatches here instead.
//
// Why Responses, not Chat: OpenAI's built-in `web_search` tool is exposed
// only on `/v1/responses`. The body shape, streaming events, and citation
// annotations all differ from Chat Completions — keeping the two clients
// separate avoids a fork that would have to be maintained on every Chat
// Completions code path.
//
// Audio: Responses accepts text input only on most models. We reuse the
// existing Whisper transcription helper from `openai.ts` (`transcribeAudio`)
// so the cross-host STT story (DeepSeek borrows from Groq, etc.) isn't
// duplicated here.

import {
  OPENAI_TRANSCRIBE_MODELS,
  openaiHostLabel,
  type OpenAiBaseUrl,
  type WebCitation,
} from '@/types';
import { MAX_RETRIES, parseRetryAfterMs } from './gemini';
import { withFetchTimeout, UploadTimeoutError } from './fetchTimeout';
import { StreamingJsonParser } from './streamingJsonParser';
import { buildCitation, dedupeCitations } from './citations';
import { toStrictSchema, transcribeAudio } from './openai';

const CHAT_TIMEOUT_MS = 60_000;
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface CallOpenAiResponsesLensOptions {
  apiKey: string;
  baseUrl: OpenAiBaseUrl;
  /** Responses-API-capable model id (gpt-5*, gpt-4.1*, gpt-4o* — the grounding
   *  resolver gates this). */
  model: string;
  /** STT model. Required — Responses accepts text input only on our path. */
  transcribeModel?: string;
  /** Cross-host STT (DeepSeek/Perplexity pattern is not exercised here, but
   *  kept for symmetry with `CallOpenAiLensOptions`). */
  transcribeBaseUrl?: OpenAiBaseUrl;
  transcribeApiKey?: string;
  wav: Uint8Array;
  prompt: string;
  schema: unknown;
  signal?: AbortSignal;
  onRetry?: (attempt: number) => void | Promise<void>;
  onTranscript?: (text: string) => void;
  imageData?: string;
}

export interface CallOpenAiResponsesLensStreamOptions extends CallOpenAiResponsesLensOptions {
  onPartialClaim?: (claim: Record<string, unknown>, key: string) => void;
  onPartialField?: (name: string, value: string | number | boolean | null) => void;
  watchValueKeys?: ReadonlySet<string>;
  onPartialString?: (name: string, partial: string) => void;
  onNoSpeech?: () => void;
  /** Fires once at end-of-stream with deduplicated `url_citation` annotations
   *  emitted by the built-in `web_search` tool. */
  onCitations?: (citations: WebCitation[]) => void;
}

interface ResponsesAnnotation {
  type?: string;
  url?: string;
  title?: string;
  /** OpenAI Responses uses `url_citation` as the annotation type but the
   *  fields are inline on the annotation object, not nested. Keeping a
   *  defensive fallback for any future nesting. */
  url_citation?: { url?: string; title?: string };
}

interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  annotation?: ResponsesAnnotation;
  /** `response.completed` carries the final aggregated message with
   *  `output[].content[].annotations[]`. */
  response?: {
    output?: Array<{
      type?: string;
      content?: Array<{
        type?: string;
        annotations?: ResponsesAnnotation[];
      }>;
    }>;
  };
  error?: { message?: string };
}

function transcriptUserMessage(transcript: string): string {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) {
    return '[Audio transcript: <empty — no speech captured>]';
  }
  return `[Audio transcript]\n${trimmed}`;
}

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

function buildResponsesBody(opts: {
  model: string;
  prompt: string;
  transcript: string;
  imageData?: string;
  schema: unknown;
  stream: boolean;
}): string {
  const userContent: unknown[] = [{ type: 'input_text', text: transcriptUserMessage(opts.transcript) }];
  if (opts.imageData) {
    userContent.unshift({
      type: 'input_image',
      image_url: `data:image/jpeg;base64,${opts.imageData}`,
    });
  }
  return JSON.stringify({
    model: opts.model,
    instructions: opts.prompt,
    input: [{ role: 'user', content: userContent }],
    tools: [{ type: 'web_search' }],
    stream: opts.stream,
    temperature: 0.2,
    text: {
      format: {
        type: 'json_schema',
        name: 'lens_result',
        strict: true,
        schema: opts.schema,
      },
    },
  });
}

function extractResponsesCitations(evt: ResponsesStreamEvent): WebCitation[] {
  const out: WebCitation[] = [];
  // Annotation streamed alongside output_text.
  if (evt.annotation) {
    const a = evt.annotation;
    const src = a.url_citation ?? a;
    const cit = buildCitation({ url: src.url, title: src.title });
    if (cit) out.push(cit);
  }
  // response.completed event with aggregated output.
  for (const item of evt.response?.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      for (const ann of part.annotations ?? []) {
        const src = ann.url_citation ?? ann;
        const cit = buildCitation({ url: src.url, title: src.title });
        if (cit) out.push(cit);
      }
    }
  }
  return out;
}

export async function callOpenAiResponsesLensStream(
  opts: CallOpenAiResponsesLensStreamOptions,
): Promise<string> {
  if (!opts.apiKey) throw new Error(`Missing ${openaiHostLabel(opts.baseUrl)} API key.`);

  // STT first — Responses on text input only.
  const sttBaseUrl = opts.transcribeBaseUrl ?? opts.baseUrl;
  const sttApiKey = opts.transcribeBaseUrl && opts.transcribeBaseUrl !== opts.baseUrl
    ? (opts.transcribeApiKey ?? '')
    : opts.apiKey;
  if (!sttApiKey) {
    throw new Error(`Missing ${openaiHostLabel(sttBaseUrl)} API key for transcription.`);
  }
  const transcribeModel = opts.transcribeModel || OPENAI_TRANSCRIBE_MODELS[sttBaseUrl];
  if (!transcribeModel) {
    throw new Error(`Missing transcribeModel for ${openaiHostLabel(sttBaseUrl)}.`);
  }
  const transcript = await transcribeAudio({
    apiKey: sttApiKey,
    baseUrl: sttBaseUrl,
    model: transcribeModel,
    wav: opts.wav,
    signal: opts.signal,
  });
  try { opts.onTranscript?.(transcript); } catch { /* subscriber errors must not break the lens call */ }

  const schema = toStrictSchema(augmentSchema(opts.schema));
  const bodyJson = buildResponsesBody({
    model: opts.model,
    prompt: opts.prompt,
    transcript,
    imageData: opts.imageData,
    schema,
    stream: true,
  });
  const endpoint = `${opts.baseUrl}/responses`;

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
          `${openaiHostLabel(opts.baseUrl)} responses request timed out after ${CHAT_TIMEOUT_MS / 1000}s.`,
        );
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      nextDelayMs = 1000;
      continue;
    }
    attemptCtl.cleanup();

    if (TRANSIENT_STATUSES.has(response.status)) {
      const errText = await response.text();
      nextDelayMs = parseRetryAfterMs(response.headers.get('retry-after')) ?? (response.status === 429 ? 5000 : 1000);
      lastError = new Error(`${openaiHostLabel(opts.baseUrl)} HTTP ${response.status}: ${truncate(errText, 2000)}`);
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`${openaiHostLabel(opts.baseUrl)} HTTP ${response.status}: ${truncate(errText, 2000)}`);
    }
    if (!response.body) throw new Error(`${openaiHostLabel(opts.baseUrl)} responses stream returned no body.`);
    return consumeResponsesStream(response.body, opts);
  }
  throw lastError ?? new Error('callOpenAiResponsesLensStream: exhausted retries without a stream.');
}

async function consumeResponsesStream(
  body: ReadableStream<Uint8Array>,
  opts: CallOpenAiResponsesLensStreamOptions,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new StreamingJsonParser({ watchValueKeys: opts.watchValueKeys });
  let pending = '';
  const citationAccumulator: WebCitation[] = [];

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
        if (data === '[DONE]') continue;
        const evt = safeJsonParseEvent(data);
        if (!evt) continue;
        if (evt.error?.message) {
          throw new Error(`${openaiHostLabel(opts.baseUrl)} error: ${evt.error.message}`);
        }
        // Text fragments arrive on `response.output_text.delta`.
        if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
          dispatch(evt.delta);
        }
        // Annotations arrive on `response.output_text.annotation.added`.
        if (evt.type === 'response.output_text.annotation.added' && evt.annotation) {
          citationAccumulator.push(...extractResponsesCitations(evt));
        }
        // Final aggregated response — pick up any annotations not surfaced
        // mid-stream (older Responses revisions only emit on `.completed`).
        if (evt.type === 'response.completed' && evt.response) {
          citationAccumulator.push(...extractResponsesCitations(evt));
        }
      }
    }
    pending += decoder.decode();
    if (pending.trim().length > 0) {
      const data = parseSseDataBlock(pending);
      if (data && data !== '[DONE]') {
        const evt = safeJsonParseEvent(data);
        if (evt) {
          if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
            dispatch(evt.delta);
          }
          if (evt.type === 'response.completed' && evt.response) {
            citationAccumulator.push(...extractResponsesCitations(evt));
          }
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

  if (citationAccumulator.length > 0 && opts.onCitations) {
    try { opts.onCitations(dedupeCitations(citationAccumulator)); } catch { /* subscriber errors must not break the lens call */ }
  }

  const text = parser.text;
  if (!text) throw new Error(`${openaiHostLabel(opts.baseUrl)} responses stream returned no content.`);
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

function safeJsonParseEvent(s: string): ResponsesStreamEvent | null {
  try {
    return JSON.parse(s) as ResponsesStreamEvent;
  } catch {
    return null;
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
