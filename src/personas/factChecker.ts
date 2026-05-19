import type { Verdict, VerdictLabel } from '@/types';

/**
 * Fact-Checker persona — the only persona in MVP.
 *
 * Strategy: send the most recent ~30 s of audio to Gemini together with a
 * tight system prompt and a strict JSON response schema.
 */

export const FACT_CHECKER_PROMPT = `You are VeritasLens, a real-time fact-check assistant for smart glasses.

The user just provided a short audio clip (up to 30 seconds) of recent conversation. Listen carefully and:

1. Identify the SINGLE most check-worthy factual claim in the audio. If multiple, pick the most consequential or most verifiable.
2. Classify the claim as one of:
   - "TRUE"  : Widely supported by reliable knowledge.
   - "FALSE" : Contradicted by reliable knowledge.
   - "UNVERIFIED" : Cannot confidently classify (opinion, future event, niche fact, ambiguous wording, no check-worthy claim at all).
3. Produce a short claim summary as ONE concise sentence (no more than 110 characters). Phrase it as a statement, not a question.
4. Produce an explanation of 2-3 short sentences (no more than 240 characters total) that justifies the verdict with specific reasoning. Mention the most relevant supporting fact (e.g. exact figures, dates, names) when possible.

Output strict JSON matching the provided schema. Do not add prose outside JSON.
Do not invent facts. Prefer "UNVERIFIED" over guessing.`;

/** JSON schema understood by Gemini's responseSchema. */
export const FACT_CHECKER_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['TRUE', 'FALSE', 'UNVERIFIED'],
    },
    claim: {
      type: 'string',
      description: 'One concise sentence summarizing the claim, phrased as a statement (≤ 110 chars).',
    },
    reason: {
      type: 'string',
      description: 'Two or three short sentences justifying the verdict with specific reasoning (≤ 240 chars).',
    },
  },
  required: ['verdict', 'claim', 'reason'],
} as const;

/** Best-effort normalization of whatever Gemini hands back. */
export function parseFactCheckerResponse(text: string): Verdict {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const fenced = /\{[\s\S]*\}/.exec(text);
    if (!fenced) throw new Error('Gemini response was not JSON.');
    raw = JSON.parse(fenced[0]);
  }
  if (!isRecord(raw)) throw new Error('Gemini response was not a JSON object.');

  const verdict = normalizeLabel(raw['verdict']);
  const claim = typeof raw['claim'] === 'string' ? raw['claim'] : '';
  const reason = typeof raw['reason'] === 'string' ? raw['reason'] : '';

  return {
    verdict,
    claim: trimTo(claim, 110),
    reason: trimTo(reason, 240),
  };
}

function normalizeLabel(value: unknown): VerdictLabel {
  if (typeof value !== 'string') return 'UNVERIFIED';
  const upper = value.trim().toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE' || upper === 'UNVERIFIED') return upper;
  return 'UNVERIFIED';
}

function trimTo(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
