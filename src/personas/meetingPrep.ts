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

const BASE_PROMPT = `You are VeritasLens, a real-time meeting assistant for smart glasses. The user is in a live meeting. Before it they prepared written context — general notes and 0+ labeled attachments — and just tapped after a short audio clip. The general notes lead with the user's goal; treat the first sentence as the primary outcome the answer should advance.

Your job:
1. Produce ONE specific primary answer (≤90 chars) grounded in the prepared context. Put elaboration in \`detail\`, not \`answer\`.
2. Optionally include a supporting \`detail\` (≤200 chars) — a number, clause reference, comparison, or contrast.
3. Optionally suggest 0–3 follow-ups (≤110 chars each), in priority order, that the user should ask the OTHER PARTY (counterparty, banker, interviewer). Skip padding — fewer is better. Never suggest a follow-up the prepared context already answers — fold that answer into \`answer\` or \`detail\` instead. Good follow-ups extract numbers, clauses, deadlines, or commitments the prep does NOT contain.
4. Set \`source\` only when drawing from a labeled attachment; never set it for general notes or your own knowledge.

Output strict JSON matching the provided schema. No prose outside JSON.`;

/**
 * One generic example anchoring the JSON shape and rule 3's "fold answered
 * questions into the answer, don't echo them as follow-ups" behavior. Kept
 * hardcoded (not templated on user input) so the model sees the same anchor
 * regardless of role/goal — templating risks style leakage and degenerate
 * cases when those fields are unset.
 */
const FEW_SHOT_EXAMPLE = `EXAMPLE (illustrative only — do not echo):
Heard: "Our current rate is 4.8%. We can offer you 4.2% if you sign today."
Prep: { notes: "Renegotiating mortgage rate", Bank contract: "Current rate 4.8%, 25-year term." }
Output: {"answer":"4.2% is below your 4.8% — but ask for the lock window.","detail":"Saves ~€120/month at current balance; check if 4.2% is fixed and for how long.","followUps":[{"prompt":"Is 4.2% fixed, and for how many years?"},{"prompt":"Any prepayment penalty at the new rate?"}],"source":"Bank contract"}`;

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

  const parts: string[] = [BASE_PROMPT, '\n\n', FEW_SHOT_EXAMPLE, '\n\nPREPARED CONTEXT:'];

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
