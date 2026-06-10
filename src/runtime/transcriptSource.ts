// src/runtime/transcriptSource.ts
//
// Provider-aware transcript source. Picks the cheapest path to a tagged
// transcript segment for the currently-active provider:
//
//   - **chat-byproduct** (Claude, OpenAI-compatible transcribe-then-chat hosts):
//     the lens call already runs STT before chat. The lifecycle wires
//     `onTranscript` directly into `appendSegment`. No work in this module —
//     `shouldRunWhisperSidecar()` returns false and the lifecycle is a no-op.
//
//   - **whisper-sidecar** (Gemini, OpenRouter inline-audio): the lens call
//     consumes audio inline and never produces a transcript. We make a parallel
//     call to the user's configured `sttHost` (Groq Whisper by default — free
//     tier, fast) and append the result. Adds ~200–400 ms of background work
//     but doesn't block the lens response; `appendSegment` is a no-op when the
//     sidecar resolves after the session has rotated.
//
// Sidecar failures (missing STT key, network error, model rejection) are
// swallowed silently — the rolling transcript is a context enrichment, not a
// critical path. A missing STT key just means Gemini / OpenRouter users see
// an empty transcript block, identical to the pre-Layer-B baseline.

import { settings } from '@/state/store';
import { transcribeAudio } from '@/llm/openai';
import { STT_MODELS_BY_HOST } from '@/types';
import {
  appendSegment,
  currentSessionId,
  type TranscriptSpeaker,
} from './transcript';

/**
 * True when the active provider's lens call does NOT produce a transcript as
 * a side effect — i.e. the runtime needs to fire a parallel Whisper call to
 * get a transcript segment. Today: Gemini (multimodal inline audio) and
 * OpenRouter (inline-audio chat completions). Claude + every transcribe-then-
 * chat OpenAI-compatible host already produce a transcript via the
 * `onTranscript` callback, so this returns false there.
 */
export function shouldRunWhisperSidecar(): boolean {
  const s = settings();
  if (s.provider === 'gemini') return true;
  if (s.provider === 'openai-compatible') {
    return s.openaiBaseUrl === 'https://openrouter.ai/api/v1';
  }
  return false;
}

/**
 * Fire a parallel transcription call against the user's STT host and append
 * the result as a tagged transcript segment. Resolves silently on every
 * failure path — sidecar errors must never break the lens call.
 *
 * The session id is captured at fire time and re-checked before append, so a
 * late-arriving sidecar from a torn-down session cannot pollute the next
 * session's transcript.
 */
export async function runWhisperSidecar(
  wav: Uint8Array,
  speaker: TranscriptSpeaker,
  signal?: AbortSignal,
): Promise<void> {
  if (!shouldRunWhisperSidecar()) return;

  const expectedSession = currentSessionId();
  if (!expectedSession) return;

  const s = settings();
  const sttHost = s.sttHost;
  const sttApiKey = s.openaiApiKeys[sttHost] ?? '';
  if (!sttApiKey) return;
  const sttModel = s.sttModel || STT_MODELS_BY_HOST[sttHost]?.[0];
  if (!sttModel) return;

  try {
    const transcript = await transcribeAudio({
      apiKey: sttApiKey,
      baseUrl: sttHost,
      model: sttModel,
      wav,
      signal,
    });

    // A new session could have started while we were waiting on Whisper.
    // Appending the stale segment would attribute prior-session content to
    // the new conversation.
    if (currentSessionId() !== expectedSession) return;

    const trimmed = transcript.trim();
    if (!trimmed) return;

    const now = Date.now();
    appendSegment({
      speaker,
      text: trimmed,
      startedAt: now,
      endedAt: now,
    });
  } catch {
    /* sidecar failures are silent — context enrichment, not a critical path */
  }
}
