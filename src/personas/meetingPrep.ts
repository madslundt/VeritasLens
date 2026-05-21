// src/personas/meetingPrep.ts
import type {
  LanguageCode,
  LensResult,
  MeetingPrepClaim,
  MeetingPrepSection,
} from '@/types';
import { LANGUAGES } from '@/types';
import { isRecord, parseJsonResponse, trimTo } from './_utils';

export const MEETING_PREP_ID = 'meeting-prep';

// Sized to fit the HUD's claim slot (54 px in baseline, 68 px in discreet-
// result) without spilling into the verdict/source line below. Each is ~2
// lines of text on the 576 px-wide display. Detail is generous because it
// renders in the much larger bottom reason slot (~6 lines).
export const MAX_ANSWER_CHARS = 90;
export const MAX_DETAIL_CHARS = 200;
export const MAX_FOLLOW_UP_CHARS = 110;
export const MAX_FOLLOW_UPS = 3;

/**
 * Builds display labels for attachments, filling unlabeled ones with
 * "Attachment 1", "Attachment 2", … so the source enum sent to Gemini is
 * always non-empty and unambiguous. The numbering ignores rows that already
 * have a label so the auto-numbering doesn't shift when the user labels one.
 *
 * Only attachments are passed here — the general-context slot (sections[0])
 * is unlabeled by convention and never enters the source enum.
 */
export function resolveAttachmentLabels(attachments: MeetingPrepSection[]): string[] {
  let noteIdx = 0;
  return attachments.map((s) => {
    const trimmed = s.label.trim();
    if (trimmed) return trimmed;
    noteIdx += 1;
    return `Attachment ${noteIdx}`;
  });
}

const BASE_PROMPT = `You are VeritasLens, a real-time meeting assistant for smart glasses.

The user is in a live meeting. Before the meeting they prepared written context — general notes about the meeting and, optionally, one or more labeled attachments (specific documents, contract excerpts, prepared questions). Both are shown below. They just provided a short audio clip of what was said in the meeting and tapped for help.

Your job:
1. Produce ONE concise primary answer (≤90 chars — must fit two short lines on a smart-glasses HUD) that responds to what was just said, grounded in the prepared context. Be specific, not generic. If the audio doesn't ask a clear question, infer what would help and answer it. Put elaboration in "detail", not "answer".
2. Optionally include a short supporting detail (≤200 chars) — a number, clause reference, comparison, or contrast that gives the answer weight. This is where longer reasoning goes.
3. Optionally suggest 0–3 follow-up prompts (≤110 chars each — also two short HUD lines) the user should ask the OTHER PARTY in the meeting (the counterparty, banker, interviewer, etc.) — not the user themselves. Order by priority. Skip any that don't add real value — fewer is better than padding.
   CRITICAL: Do NOT suggest a follow-up whose answer is already present in the prepared context. If the context already answers something relevant, fold that answer into the primary answer or detail instead of phrasing it as a question for the user to ask. A good follow-up surfaces information the user does NOT already have — it pushes the other party for a number, clause, deadline, or commitment that the prep doesn't contain.
4. When the answer or a follow-up draws on a specific ATTACHMENT, set its "source" field to the matching attachment label (exact match). Omit "source" when the response comes from the general notes or your own knowledge — the general notes are unlabeled and never get a source attribution.

Output strict JSON matching the provided schema. Do not add prose outside JSON.`;

/** Split sections into the general slot + non-empty attachments. */
function partition(sections: MeetingPrepSection[]): {
  generalBody: string;
  attachments: MeetingPrepSection[];
} {
  const generalBody = (sections[0]?.body ?? '').trim();
  const attachments = sections.slice(1).filter((s) => s.body.trim().length > 0);
  return { generalBody, attachments };
}

export function buildMeetingPrepPrompt(
  lang: LanguageCode,
  sections: MeetingPrepSection[],
): string {
  const langName = LANGUAGES[lang] ?? 'English';
  const { generalBody, attachments } = partition(sections);
  const labels = resolveAttachmentLabels(attachments);

  const parts: string[] = [BASE_PROMPT, '\n\nPREPARED CONTEXT:'];

  if (generalBody) {
    parts.push(`\n\n# Notes (general — not a citable source)\n${generalBody}`);
  }

  attachments.forEach((s, i) => {
    parts.push(`\n\n=== ${labels[i]} ===\n${s.body.trim()}`);
  });

  if (labels.length > 0) {
    const enumList = labels.map((l) => `"${l}"`).join(', ');
    parts.push(
      `\n\nATTACHMENT LABELS (use one of these exact strings when setting "source"): ${enumList}`,
    );
  } else {
    parts.push(
      '\n\nNo attachments were provided. Do not include a "source" field on your response.',
    );
  }

  parts.push(
    `\n\nLANGUAGE: Write the answer, detail, and each follow-up prompt in ${langName}.`,
  );
  if (labels.length > 0) {
    parts.push(' Attachment labels in the "source" field must stay as-is regardless of language.');
  }

  return parts.join('');
}

/**
 * Build the response schema for a given set of sections. When the user has
 * provided one or more attachments, the `source` field is enum-bound to the
 * attachment labels so Gemini cannot invent attributions. When there are no
 * attachments, the `source` field is omitted entirely — the general notes
 * are not a citable source and Gemini should not try to attribute to them.
 */
export function buildMeetingPrepSchema(
  sections: MeetingPrepSection[],
): Record<string, unknown> {
  const { attachments } = partition(sections);
  const labels = resolveAttachmentLabels(attachments);

  const followUpItemProps: Record<string, unknown> = {
    prompt: {
      type: 'string',
      description: `Follow-up suggestion (max ${MAX_FOLLOW_UP_CHARS} chars).`,
    },
  };

  const properties: Record<string, unknown> = {
    answer: {
      type: 'string',
      description: `Primary answer (max ${MAX_ANSWER_CHARS} chars).`,
    },
    detail: {
      type: 'string',
      description: `Optional supporting line (max ${MAX_DETAIL_CHARS} chars).`,
    },
    followUps: {
      type: 'array',
      maxItems: MAX_FOLLOW_UPS,
      items: {
        type: 'object',
        properties: followUpItemProps,
        required: ['prompt'],
      },
    },
  };

  if (labels.length > 0) {
    const sourceProp = {
      type: 'string',
      enum: labels,
      description: 'Attachment label this draws from (exact match required).',
    };
    properties['source'] = sourceProp;
    followUpItemProps['source'] = sourceProp;
  }

  return {
    type: 'object',
    properties,
    required: ['answer'],
  };
}

export function parseMeetingPrepResponse(
  text: string,
  sections: MeetingPrepSection[],
): LensResult {
  const raw = parseJsonResponse(text);
  const { attachments } = partition(sections);
  const validLabels = new Set(resolveAttachmentLabels(attachments));
  const claims: MeetingPrepClaim[] = [];

  claims.push({
    text: trimTo(typeof raw['answer'] === 'string' ? raw['answer'] : '', MAX_ANSWER_CHARS),
    source: coerceSource(raw['source'], validLabels),
    detail: trimTo(typeof raw['detail'] === 'string' ? raw['detail'] : '', MAX_DETAIL_CHARS),
  });

  const followUpsRaw = raw['followUps'];
  if (Array.isArray(followUpsRaw)) {
    for (const f of followUpsRaw.slice(0, MAX_FOLLOW_UPS)) {
      if (!isRecord(f)) continue;
      const prompt = trimTo(
        typeof f['prompt'] === 'string' ? f['prompt'] : '',
        MAX_FOLLOW_UP_CHARS,
      );
      if (!prompt) continue;
      claims.push({
        text: prompt,
        source: coerceSource(f['source'], validLabels),
        detail: '',
      });
    }
  }

  return { type: 'meeting-prep', claims };
}

function coerceSource(value: unknown, validLabels: Set<string>): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return validLabels.has(trimmed) ? trimmed : '';
}

/**
 * Placeholder buildPrompt / parse used in the Persona record. Meeting Prep is
 * special-cased in lifecycle.runAnalysis (same pattern as Auto) because its
 * prompt and schema depend on user-supplied sections that change at runtime.
 * Throws to surface logic errors loudly if the generic path is ever reached.
 */
export function buildMeetingPrepPromptStub(): string {
  throw new Error(
    'Meeting Prep buildPrompt should not be called — handled by lifecycle dispatch.',
  );
}

export function parseMeetingPrepResponseStub(_text: string): LensResult {
  throw new Error(
    'Meeting Prep parse should not be called — handled by lifecycle dispatch.',
  );
}
