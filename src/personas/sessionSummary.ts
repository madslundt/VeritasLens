// src/personas/sessionSummary.ts
import type { LensResult, LanguageCode } from '@/types';
import { LANGUAGES } from '@/types';
import { trimTo, parseJsonResponse, coerceQuote } from './_utils';

// Identifiers used when persisting auto-generated summary entries to history.
// The persona is no longer exposed in the picker — these constants exist so
// the auto-summary path can attribute its history rows without a registered
// persona to look up.
export const SESSION_SUMMARY_ID = 'session-summary';
export const SESSION_SUMMARY_NAME = 'Summary';

const MAX_TITLE_CHARS = 60;
const MAX_SUMMARY_CHARS = 2000;
const MAX_TOPICS = 12;
const MAX_TOPIC_CHARS = 140;
const MAX_KEY_POINTS = 20;
const MAX_KEY_POINT_CHARS = 200;

const BASE_PROMPT = `You are VeritasLens, a conversation summarizer for smart glasses.

The user has provided an audio clip of a conversation. Produce a thorough record of what was discussed — NOT a one-line conclusion.

1. \`title\` (≤60 chars) phrased like "Summary of <topic>" — e.g. "Summary of bank meeting", "Summary of project planning". Infer the topic from the conversation; if it is unclear, use "Summary of conversation".

2. \`topics\`: list EVERY distinct topic that came up, in the order it was discussed. One short phrase per topic (≤120 chars). Aim for 4–10 topics in a multi-minute conversation; do not collapse multiple topics into one bullet. Include side discussions and brief asides, not just the headline topic.

3. \`keyPoints\`: capture the concrete details a reader needs to recall later. Aim for 6–15 bullets when the conversation is substantive. Include:
   - Decisions that were made (and by whom, when stated)
   - Action items, with the owner and any deadline
   - Named people, companies, products, places
   - Specific numbers, percentages, amounts, dates, deadlines
   - Risks, concerns, or open questions raised
   One bullet per item (≤180 chars). Do not pad with filler — but do not omit a real detail just to stay short.

4. \`summary\`: a thorough narrative that walks through the WHOLE conversation in the order it unfolded. Target 600–1500 characters across 2–4 paragraphs. Do NOT open with "The meeting ended …" or limit yourself to a conclusion — describe what was actually discussed from start to finish, weaving in the topics and key points above.

5. \`quote\` (optional, ≤140 chars): a verbatim line from the audio that best captures the conversation.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

/** One prior segment passed to the final consolidation call as PRIOR CONTEXT. */
export interface PriorSummarySegment {
  title?: string;
  summary: string;
  topics?: string[];
  keyPoints?: string[];
}

export interface SessionSummaryOptions {
  /**
   * Running summaries from earlier intervals of the same session whose audio
   * has since fallen out of the ring buffer. Used by the final end-of-session
   * call so the summary can cover the whole conversation, not just the tail.
   */
  previousSummaries?: PriorSummarySegment[];
}

function isMeaningfulSegment(seg: PriorSummarySegment): boolean {
  if (seg.summary && seg.summary.trim().length > 0) return true;
  if (seg.topics && seg.topics.some((t) => t.trim().length > 0)) return true;
  if (seg.keyPoints && seg.keyPoints.some((k) => k.trim().length > 0)) return true;
  return false;
}

function renderPriorSegment(seg: PriorSummarySegment, index: number): string {
  const header = `=== Segment ${index + 1}${seg.title ? `: ${seg.title}` : ''} ===`;
  const lines: string[] = [header];
  if (seg.summary && seg.summary.trim().length > 0) {
    lines.push(seg.summary.trim());
  }
  const topics = (seg.topics ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (topics.length > 0) {
    lines.push(`Topics: ${topics.join(' · ')}`);
  }
  const keyPoints = (seg.keyPoints ?? []).map((k) => k.trim()).filter((k) => k.length > 0);
  if (keyPoints.length > 0) {
    lines.push('Key points:');
    for (const k of keyPoints) lines.push(`- ${k}`);
  }
  return lines.join('\n');
}

export function buildSessionSummaryPrompt(
  lang: LanguageCode,
  options?: SessionSummaryOptions,
): string {
  const langName = LANGUAGES[lang] ?? 'English';
  const langDirective = `LANGUAGE: Write \`title\`, \`summary\`, \`topics\`, and \`keyPoints\` in ${langName}. \`quote\` stays in the original spoken language.`;
  const prior = (options?.previousSummaries ?? []).filter(isMeaningfulSegment);
  if (prior.length === 0) {
    return `${BASE_PROMPT}\n\n${langDirective}`;
  }
  const segments = prior.map((seg, i) => renderPriorSegment(seg, i)).join('\n\n');
  const priorBlock =
    `PRIOR CONTEXT: These are running summaries of earlier segments of the same conversation whose audio is no longer in the buffer. Merge them with the new audio to produce one consolidated summary that covers the WHOLE session. Keep every topic and key point that appeared in any segment — do not drop detail just because it was from an earlier segment.\n\n${segments}`;
  return `${BASE_PROMPT}\n\n${priorBlock}\n\n${langDirective}`;
}

export const SESSION_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Short topical heading like "Summary of bank meeting" (max 60 chars).',
    },
    summary: {
      type: 'string',
      description:
        'Thorough narrative summary covering the entire conversation in order. Aim for 600-1500 chars across 2-4 paragraphs. Do NOT just conclude — describe what was discussed throughout.',
    },
    topics: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Every distinct topic that came up, in the order it was discussed. One short phrase per topic (≤120 chars). Include all topics, not only the main one.',
    },
    keyPoints: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Important concrete details: decisions, action items with owners/dates, named people/companies, specific numbers/percentages/amounts/dates, risks, open questions. One bullet per item (≤180 chars).',
    },
    quote: {
      type: 'string',
      description: 'Verbatim audio snippet of the most salient line (max 140 chars).',
    },
  },
  required: ['title', 'summary', 'topics', 'keyPoints'],
} as const;

function readStringArray(
  raw: Record<string, unknown>,
  key: string,
  maxItems: number,
  perItemMax: number,
): string[] {
  const value = raw[key];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    out.push(trimTo(trimmed, perItemMax));
    if (out.length >= maxItems) break;
  }
  return out;
}

export function parseSessionSummaryResponse(text: string): LensResult {
  const raw = parseJsonResponse(text);
  const rawTitle = typeof raw['title'] === 'string' ? raw['title'].trim() : '';
  return {
    type: 'session-summary',
    title: trimTo(rawTitle.length > 0 ? rawTitle : 'Summary of conversation', MAX_TITLE_CHARS),
    summary: trimTo(typeof raw['summary'] === 'string' ? raw['summary'] : '', MAX_SUMMARY_CHARS),
    topics: readStringArray(raw, 'topics', MAX_TOPICS, MAX_TOPIC_CHARS),
    keyPoints: readStringArray(raw, 'keyPoints', MAX_KEY_POINTS, MAX_KEY_POINT_CHARS),
    quote: coerceQuote(raw['quote']),
  };
}

// Re-exported for tests that want to assert the parser's caps without
// recomputing the numbers.
export const SESSION_SUMMARY_LIMITS = {
  MAX_TITLE_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_TOPICS,
  MAX_TOPIC_CHARS,
  MAX_KEY_POINTS,
  MAX_KEY_POINT_CHARS,
} as const;

