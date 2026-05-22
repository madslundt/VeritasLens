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
  fetchAvailableModels as fetchGeminiModels,
  runSelfTest as runGeminiSelfTest,
  MAX_RETRIES,
  parseGoogleRetryDelayMs,
  parseRetryAfterMs,
  type CallLensOptions as GeminiCallLensOptions,
} from './gemini';
import {
  callOpenAiLens,
  fetchOpenAiModels,
  runSelfTest as runOpenAiSelfTest,
} from './openai';
import { OPENAI_TRANSCRIBE_MODELS, type GeminiModel, type LlmProvider, type OpenAiBaseUrl } from '@/types';

export { MAX_RETRIES, parseRetryAfterMs, parseGoogleRetryDelayMs };

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
 * Dispatch the lens call to the active provider. The runtime's existing
 * callLens(...) call sites all pass apiKey + model derived from the Gemini
 * settings; this facade accepts them as overrides but otherwise falls back to
 * the store so callers can stay provider-agnostic.
 */
export async function callLens(opts: CallLensOptions): Promise<string> {
  const s = settings();
  if (s.provider === 'openai-compatible') {
    return callOpenAiLens({
      apiKey: opts.apiKey ?? (s.openaiApiKeys[s.openaiBaseUrl] ?? ''),
      baseUrl: s.openaiBaseUrl,
      model: opts.model ?? s.openaiModel,
      // Per-host transcription model id (OpenAI calls Whisper `whisper-1`,
      // Groq calls it `whisper-large-v3`). Defaulted from the static map so
      // the user never has to pick this themselves.
      transcribeModel: OPENAI_TRANSCRIBE_MODELS[s.openaiBaseUrl],
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
   */
  overrides?: { provider?: LlmProvider; baseUrl?: OpenAiBaseUrl },
): Promise<{ latencyMs: number }> {
  const s = settings();
  const provider = overrides?.provider ?? s.provider;
  const baseUrl = overrides?.baseUrl ?? s.openaiBaseUrl;
  if (provider === 'gemini') {
    return runGeminiSelfTest(apiKey, model as GeminiModel | undefined);
  }
  return runOpenAiSelfTest(apiKey, baseUrl, model ?? s.openaiModel);
}
