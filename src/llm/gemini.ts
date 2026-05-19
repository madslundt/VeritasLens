// src/llm/gemini.ts
import { uint8ToBase64, encodePcmToWav } from '@/runtime/audioBuffer';
import { FACT_CHECKER_PROMPT, FACT_CHECKER_SCHEMA } from '@/personas/factChecker';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_LANGUAGE,
  LANGUAGES,
  type GeminiModel,
  type LanguageCode,
} from '@/types';

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
  /** Gemini responseSchema object. */
  schema: Record<string, unknown>;
  signal?: AbortSignal;
  model?: GeminiModel | string;
}

/**
 * Send audio + prompt to Gemini and return the raw JSON text from the response.
 * Each lens's parse() function handles decoding the JSON.
 */
export async function callLens(opts: CallLensOptions): Promise<string> {
  if (!opts.apiKey) throw new Error('Missing Gemini API key.');

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
      responseSchema: opts.schema,
    },
  };

  const response = await fetch(
    `${ENDPOINT(opts.model ?? DEFAULT_GEMINI_MODEL)}?key=${encodeURIComponent(opts.apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    },
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${truncate(errText, 200)}`);
  }

  const payload = (await response.json()) as GenerateContentResponse;
  if (payload.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the prompt: ${payload.promptFeedback.blockReason}`);
  }
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text candidate.');
  return text;
}

/**
 * Reachability probe used by Settings "Run self-test".
 * Sends 1 second of silence and reports latency.
 */
export async function runSelfTest(
  apiKey: string,
  model?: GeminiModel | string,
  language?: LanguageCode,
): Promise<{ latencyMs: number }> {
  const silentPcm = new Uint8Array(16_000 * 2);
  const wav = encodePcmToWav(silentPcm, { sampleRate: 16_000, bitsPerSample: 16, channels: 1 });
  const lang = language ?? DEFAULT_LANGUAGE;
  const langName = LANGUAGES[lang] ?? 'English';
  const prompt =
    `${FACT_CHECKER_PROMPT}\n\n` +
    `LANGUAGE: Write the \`claim\` and \`reason\` fields in ${langName}. ` +
    `The \`verdict\` field MUST stay as one of "TRUE", "FALSE", or "UNVERIFIED".`;
  const t0 = performance.now();
  await callLens({
    apiKey,
    wav,
    prompt,
    schema: FACT_CHECKER_SCHEMA as unknown as Record<string, unknown>,
    model,
  });
  return { latencyMs: Math.round(performance.now() - t0) };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
