import { uint8ToBase64, encodePcmToWav } from '@/runtime/audioBuffer';
import { FACT_CHECKER_PROMPT, FACT_CHECKER_SCHEMA, parseFactCheckerResponse } from '@/personas/factChecker';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_LANGUAGE,
  LANGUAGES,
  type GeminiModel,
  type LanguageCode,
  type Verdict,
} from '@/types';

/**
 * Minimal Gemini client. We talk to the public `generativelanguage` REST API
 * directly — no SDK dependency, no proxy. The user's API key never leaves the
 * device except as part of this request.
 *
 * Endpoint reference: https://ai.google.dev/gemini-api/docs/audio
 */

const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

export interface FactCheckOptions {
  apiKey: string;
  /** WAV-encoded audio bytes. */
  wav: Uint8Array;
  signal?: AbortSignal;
  /** Override the model. Defaults to `DEFAULT_GEMINI_MODEL`. */
  model?: GeminiModel | string;
  /** Language to write the claim / reason in. Defaults to English. */
  language?: LanguageCode;
}

export async function factCheck(opts: FactCheckOptions): Promise<Verdict> {
  if (!opts.apiKey) throw new Error('Missing Gemini API key.');

  const lang = opts.language && opts.language in LANGUAGES ? opts.language : DEFAULT_LANGUAGE;
  const langName = LANGUAGES[lang];
  const localizedPrompt =
    `${FACT_CHECKER_PROMPT}\n\n` +
    `LANGUAGE: Write the \`claim\` and \`reason\` fields in ${langName}. ` +
    `The \`verdict\` field MUST stay as one of the literal strings "TRUE", "FALSE", or "UNVERIFIED" regardless of language.`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: localizedPrompt },
          {
            inlineData: {
              mimeType: 'audio/wav',
              data: uint8ToBase64(opts.wav),
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: FACT_CHECKER_SCHEMA,
    },
  };

  const response = await fetch(`${ENDPOINT(opts.model ?? DEFAULT_GEMINI_MODEL)}?key=${encodeURIComponent(opts.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${truncate(errText, 200)}`);
  }

  const payload = (await response.json()) as GenerateContentResponse;

  if (payload.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the prompt: ${payload.promptFeedback.blockReason}`);
  }

  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini returned no text candidate.');
  }

  return parseFactCheckerResponse(text);
}

/**
 * Reachability probe used by Settings → "Run self-test".
 *
 * Sends a 1-second silent PCM clip and reports latency. The model will most
 * likely return UNVERIFIED (it's silence) — we just want a 200 OK and a
 * parseable response to confirm the key and the chosen model both work.
 */
export async function runSelfTest(
  apiKey: string,
  model?: GeminiModel | string,
  language?: LanguageCode,
): Promise<{ latencyMs: number; verdict: Verdict }> {
  const silentPcm = new Uint8Array(16_000 * 2); // 1 s of 16-bit @ 16 kHz silence
  const wav = encodePcmToWav(silentPcm, { sampleRate: 16_000, bitsPerSample: 16, channels: 1 });
  const t0 = performance.now();
  const verdict = await factCheck({ apiKey, wav, model, language });
  return { latencyMs: Math.round(performance.now() - t0), verdict };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
