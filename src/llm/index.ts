// src/llm/index.ts
//
// Thin facade over the provider-specific implementations. Reads the active
// provider from the settings store at call time so a mid-session settings
// change (e.g. switching from Gemini to OpenAI) takes effect on the next
// trigger — though the lifecycle's settings-change reactor will tear the
// session down anyway via leaveActiveSession().
//
// Re-exports today's public symbols (callLens, fetchAvailableModels,
// runSelfTest, MAX_RETRIES, parseRetryAfterMs, parseGoogleRetryDelayMs) so
// callers continue importing from '@/llm/gemini' OR '@/llm' interchangeably
// during the transition; new code should import from '@/llm'.

import { settings } from '@/state/store';
import {
  callLens as callGeminiLens,
  callLensStream as callGeminiLensStream,
  GOOGLE_SEARCH_TOOLS,
  fetchAvailableModels as fetchGeminiModels,
  runSelfTest as runGeminiSelfTest,
  MAX_RETRIES,
  parseGoogleRetryDelayMs,
  parseRetryAfterMs,
  type CallLensOptions as GeminiCallLensOptions,
} from './gemini';
import {
  callOpenAiLens,
  callOpenAiLensStream,
  fetchOpenAiModels,
  runSelfTest as runOpenAiSelfTest,
  transcribeAudio,
} from './openai';
import {
  callLens as callClaudeLens,
  callLensStream as callClaudeLensStream,
  fetchAvailableModels as fetchClaudeModels,
  runSelfTest as runClaudeSelfTest,
} from './claude';
import {
  OPENAI_CHAT_ONLY_HOSTS,
  OPENAI_TRANSCRIBE_MODELS,
  STT_MODELS_BY_HOST,
  openaiHostLabel,
  type ClaudeModel,
  type GeminiModel,
  type LlmProvider,
  type OpenAiBaseUrl,
  type SttHost,
} from '@/types';

export { MAX_RETRIES, parseRetryAfterMs, parseGoogleRetryDelayMs, GOOGLE_SEARCH_TOOLS };
export { callGame } from './gameClient';
export type { CallGameOptions } from './gameClient';

/**
 * Provider-agnostic call shape used by the runtime. Re-uses the Gemini
 * signature verbatim — every field is meaningful for OpenAI too (the schema
 * is translated to OpenAI strict format inside the OpenAI provider; the WAV
 * is transcribed to text before chat completions).
 */
export interface CallLensOptions extends Omit<GeminiCallLensOptions, 'apiKey' | 'model'> {
  /** When omitted, the facade reads the active provider's credentials from `settings()`. */
  apiKey?: string;
  /** Provider-specific model id. When omitted, the active provider's stored model is used. */
  model?: string;
}

/**
 * Streaming variant of `CallLensOptions`. Adds the partial / no-speech hooks
 * every provider's SSE path exposes — Gemini via `:streamGenerateContent`,
 * OpenAI-compatible hosts via `stream: true` on `/chat/completions`, and
 * Anthropic via `stream: true` on `/v1/messages`. All three feed the shared
 * `StreamingJsonParser`, so the HUD's partial-render layer behaves the same
 * regardless of provider.
 */
export interface CallLensStreamOptions extends CallLensOptions {
  /**
   * Fires when a complete object inside the first top-level array of the
   * response is parsed. `key` is the array's property name (`claims`,
   * `questions`, `starters`, …) so the caller knows which schema slot the
   * partial fills.
   */
  onPartialClaim?: (claim: Record<string, unknown>, key: string) => void;
  /**
   * Fires when a top-level scalar property (string / number / boolean / null)
   * finishes parsing — once per key. Lets shapes like `translation`
   * (sourceText/translatedText) render incrementally.
   */
  onPartialField?: (name: string, value: string | number | boolean | null) => void;
  onNoSpeech?: () => void;
}

/**
 * Resolve the STT host + key + model for a given chat host. Chat-only hosts
 * (DeepSeek, Perplexity) borrow STT from `settings().sttHost`; everyone else
 * runs STT on their own chat host (current behavior for OpenAI/Groq, or
 * undefined for inline-audio hosts like OpenRouter where the chat call
 * carries the audio inline).
 */
function resolveStt(chatHost: OpenAiBaseUrl): {
  transcribeBaseUrl: OpenAiBaseUrl;
  transcribeApiKey: string;
  transcribeModel: string | undefined;
  isCrossHost: boolean;
} {
  const s = settings();
  if (OPENAI_CHAT_ONLY_HOSTS.has(chatHost)) {
    const sttHost: SttHost = s.sttHost;
    return {
      transcribeBaseUrl: sttHost,
      transcribeApiKey: s.openaiApiKeys[sttHost] ?? '',
      transcribeModel: s.sttModel || STT_MODELS_BY_HOST[sttHost][0],
      isCrossHost: true,
    };
  }
  return {
    transcribeBaseUrl: chatHost,
    transcribeApiKey: s.openaiApiKeys[chatHost] ?? '',
    transcribeModel: s.openaiTranscribeModels[chatHost] || OPENAI_TRANSCRIBE_MODELS[chatHost],
    isCrossHost: false,
  };
}

/**
 * Dispatch the lens call to the active provider. Pulls credentials, model,
 * and STT routing from `settings()` at call time so a mid-session settings
 * change takes effect on the next trigger. For chat-only OpenAI-compatible
 * hosts (DeepSeek, Perplexity) the STT host + key are resolved via
 * `resolveStt`, and a missing STT credential fails fast with a clear error
 * rather than firing a 401 from Whisper.
 */
export async function callLens(opts: CallLensOptions): Promise<string> {
  const s = settings();
  if (s.provider === 'claude') {
    // Claude has no audio modality on this API. Transcribe via the same
    // sttHost path the chat-only OpenAI hosts use (Groq/OpenAI Whisper), then
    // pass the transcript to Anthropic. Fail fast with a clear error if the
    // STT key is missing — surfaces in Settings rather than at /v1/messages.
    const sttHost: SttHost = s.sttHost;
    const sttApiKey = s.openaiApiKeys[sttHost] ?? '';
    if (!sttApiKey) {
      throw new Error(
        `Add a ${openaiHostLabel(sttHost)} API key for transcription before using Anthropic.`,
      );
    }
    const sttModel = s.sttModel || STT_MODELS_BY_HOST[sttHost][0];
    const transcript = await transcribeAudio({
      apiKey: sttApiKey,
      baseUrl: sttHost,
      model: sttModel,
      wav: opts.wav,
      signal: opts.signal,
    });
    return callClaudeLens({
      apiKey: opts.apiKey ?? s.claudeApiKey,
      model: (opts.model as ClaudeModel | undefined) ?? s.claudeModel,
      transcript,
      prompt: opts.prompt,
      schema: opts.schema,
      signal: opts.signal,
      onRetry: opts.onRetry,
    });
  }
  if (s.provider === 'openai-compatible') {
    const chatHost = s.openaiBaseUrl;
    const stt = resolveStt(chatHost);
    if (stt.isCrossHost && !stt.transcribeApiKey) {
      throw new Error(
        `Add a ${openaiHostLabel(stt.transcribeBaseUrl)} API key for transcription before using ${openaiHostLabel(chatHost)}.`,
      );
    }
    return callOpenAiLens({
      apiKey: opts.apiKey ?? (s.openaiApiKeys[chatHost] ?? ''),
      baseUrl: chatHost,
      model: opts.model ?? s.openaiModel,
      transcribeModel: stt.transcribeModel,
      transcribeBaseUrl: stt.isCrossHost ? stt.transcribeBaseUrl : undefined,
      transcribeApiKey: stt.isCrossHost ? stt.transcribeApiKey : undefined,
      wav: opts.wav,
      prompt: opts.prompt,
      schema: opts.schema,
      signal: opts.signal,
      onRetry: opts.onRetry,
    });
  }
  return callGeminiLens({
    apiKey: opts.apiKey ?? s.geminiApiKey,
    model: (opts.model as GeminiModel | undefined) ?? s.geminiModel,
    wav: opts.wav,
    prompt: opts.prompt,
    schema: opts.schema,
    signal: opts.signal,
    onRetry: opts.onRetry,
    tools: opts.tools,
  });
}

/**
 * Streaming dispatcher. Routes to the active provider's SSE implementation:
 *   - Gemini: `:streamGenerateContent?alt=sse`
 *   - OpenAI-compatible (OpenAI / Groq / OpenRouter / DeepSeek / Perplexity):
 *     `/chat/completions` with `stream: true`. STT happens upfront, same as
 *     the non-streaming path.
 *   - Anthropic: `/v1/messages` with `stream: true`. The tool-input JSON is
 *     streamed via `input_json_delta` and accumulated. STT is upstream of
 *     this module (the facade transcribes via the configured `sttHost`).
 *
 * All three feed the same `StreamingJsonParser` and return the full
 * accumulated text on completion, so the caller's `parse()` runs unchanged.
 */
export async function callLensStream(opts: CallLensStreamOptions): Promise<string> {
  const s = settings();
  if (s.provider === 'claude') {
    const sttHost: SttHost = s.sttHost;
    const sttApiKey = s.openaiApiKeys[sttHost] ?? '';
    if (!sttApiKey) {
      throw new Error(
        `Add a ${openaiHostLabel(sttHost)} API key for transcription before using Anthropic.`,
      );
    }
    const sttModel = s.sttModel || STT_MODELS_BY_HOST[sttHost][0];
    const transcript = await transcribeAudio({
      apiKey: sttApiKey,
      baseUrl: sttHost,
      model: sttModel,
      wav: opts.wav,
      signal: opts.signal,
    });
    return callClaudeLensStream({
      apiKey: opts.apiKey ?? s.claudeApiKey,
      model: (opts.model as ClaudeModel | undefined) ?? s.claudeModel,
      transcript,
      prompt: opts.prompt,
      schema: opts.schema,
      signal: opts.signal,
      onRetry: opts.onRetry,
      onPartialClaim: opts.onPartialClaim,
      onPartialField: opts.onPartialField,
      onNoSpeech: opts.onNoSpeech,
    });
  }
  if (s.provider === 'openai-compatible') {
    const chatHost = s.openaiBaseUrl;
    const stt = resolveStt(chatHost);
    if (stt.isCrossHost && !stt.transcribeApiKey) {
      throw new Error(
        `Add a ${openaiHostLabel(stt.transcribeBaseUrl)} API key for transcription before using ${openaiHostLabel(chatHost)}.`,
      );
    }
    return callOpenAiLensStream({
      apiKey: opts.apiKey ?? (s.openaiApiKeys[chatHost] ?? ''),
      baseUrl: chatHost,
      model: opts.model ?? s.openaiModel,
      transcribeModel: stt.transcribeModel,
      transcribeBaseUrl: stt.isCrossHost ? stt.transcribeBaseUrl : undefined,
      transcribeApiKey: stt.isCrossHost ? stt.transcribeApiKey : undefined,
      wav: opts.wav,
      prompt: opts.prompt,
      schema: opts.schema,
      signal: opts.signal,
      onRetry: opts.onRetry,
      onPartialClaim: opts.onPartialClaim,
      onPartialField: opts.onPartialField,
      onNoSpeech: opts.onNoSpeech,
    });
  }
  return callGeminiLensStream({
    apiKey: opts.apiKey ?? s.geminiApiKey,
    model: (opts.model as GeminiModel | undefined) ?? s.geminiModel,
    wav: opts.wav,
    prompt: opts.prompt,
    schema: opts.schema,
    signal: opts.signal,
    onRetry: opts.onRetry,
    tools: opts.tools,
    onPartialClaim: opts.onPartialClaim,
    onNoSpeech: opts.onNoSpeech,
  });
}

/**
 * Fetch the model list for the active provider. Used by the settings UI's
 * model picker.
 */
export async function fetchAvailableModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const s = settings();
  if (s.provider === 'claude') {
    return fetchClaudeModels(apiKey, signal);
  }
  if (s.provider === 'openai-compatible') {
    return fetchOpenAiModels(apiKey, s.openaiBaseUrl, signal);
  }
  return fetchGeminiModels(apiKey, signal);
}

/**
 * End-to-end probe for the active provider against a specific model. Sends a
 * 1 s silence WAV through the real lens path (Gemini: generateContent with
 * inline audio; OpenAI-compatible: Whisper transcription then chat
 * completions with strict JSON schema) so failures from a wrong key, an
 * unavailable model, or a model that rejects structured output all surface
 * here rather than at first real use.
 */
export async function runSelfTest(
  apiKey: string,
  model?: string,
  /**
   * Optional overrides for callers that want to probe an unsaved draft. When
   * omitted the function falls back to the persisted settings store as before.
   * `lightweight` skips the inline-audio payload on the Gemini path (ignored
   * by the OpenAI path, which doesn't have an analogous classifier model).
   *
   * `sttHost` / `sttModel` / `sttApiKey` override the cross-host STT path for
   * chat-only chat hosts (DeepSeek, Perplexity). The Settings UI's Test
   * button passes drafts here so an unsaved STT change is what's probed.
   */
  overrides?: {
    provider?: LlmProvider;
    baseUrl?: OpenAiBaseUrl;
    transcribeModel?: string;
    sttHost?: SttHost;
    sttModel?: string;
    sttApiKey?: string;
    lightweight?: boolean;
  },
): Promise<{ latencyMs: number }> {
  const s = settings();
  const provider = overrides?.provider ?? s.provider;
  const baseUrl = overrides?.baseUrl ?? s.openaiBaseUrl;
  if (provider === 'gemini') {
    return runGeminiSelfTest(apiKey, model as GeminiModel | undefined, {
      lightweight: overrides?.lightweight,
    });
  }
  if (provider === 'claude') {
    return runClaudeSelfTest(apiKey, model as ClaudeModel | undefined);
  }
  if (OPENAI_CHAT_ONLY_HOSTS.has(baseUrl)) {
    const sttHost: SttHost = overrides?.sttHost ?? s.sttHost;
    const sttApiKey = overrides?.sttApiKey ?? (s.openaiApiKeys[sttHost] ?? '');
    if (!sttApiKey) {
      throw new Error(
        `Add a ${openaiHostLabel(sttHost)} API key for transcription before using ${openaiHostLabel(baseUrl)}.`,
      );
    }
    const sttModel =
      overrides?.sttModel
      || overrides?.transcribeModel
      || s.sttModel
      || STT_MODELS_BY_HOST[sttHost][0];
    return runOpenAiSelfTest(apiKey, baseUrl, model ?? s.openaiModel, sttModel, {
      transcribeBaseUrl: sttHost,
      transcribeApiKey: sttApiKey,
    });
  }
  const transcribeModel =
    overrides?.transcribeModel
    || s.openaiTranscribeModels[baseUrl]
    || OPENAI_TRANSCRIBE_MODELS[baseUrl];
  return runOpenAiSelfTest(apiKey, baseUrl, model ?? s.openaiModel, transcribeModel);
}
