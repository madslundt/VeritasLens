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

// Sized to fit the HUD's 2-line claim slot (62 px in baseline, 68 px in
// discreet-result) without spilling into the verdict/source line below. The
// HUD also caps the rendered top field at 140 chars via `clip(text, 140)`,
// so 140 is the slot's true ceiling. Detail is generous because it renders
// in the much larger bottom reason slot and auto-paginates if needed.
export const MAX_ANSWER_CHARS = 140;
export const MAX_DETAIL_CHARS = 300;
export const MAX_FOLLOW_UP_CHARS = 110;
// Matches the HUD's `clip(text, 140)` in src/runtime/hud.ts so the evidence
// quote never overflows the answer slot when rendered with surrounding quotes.
export const MAX_EVIDENCE_CHARS = 140;

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
1. Produce ONE specific primary answer (≤140 chars) grounded in the prepared context. Put elaboration in \`detail\`, not \`answer\`.
2. Optionally include a supporting \`detail\` (≤300 chars) — a number, clause reference, comparison, or contrast.
3. When the answer draws on a specific labeled attachment, include an \`evidence\` excerpt — a short verbatim or near-verbatim quote (≤140 chars) from that attachment, with its \`source\`. This lets the user verify the grounding at a glance. Skip \`evidence\` when the answer comes from general notes or your own reasoning.
4. Suggest a single \`followUp\` (≤110 chars) ONLY when the prepared context is genuinely silent on a specific number, clause, deadline, or commitment whose value would change the user's decision. Default is to omit \`followUp\`. Do NOT emit obvious, generic, or socially clumsy questions ("What's your timeline?", "Can you tell me more?"). Do NOT re-ask anything the prep already answers — fold that answer into \`answer\` or \`detail\` instead.
5. Set \`source\` (on the top-level answer and on \`evidence\`) only when drawing from a labeled attachment; never set it for general notes or your own knowledge.

Output strict JSON matching the provided schema. No prose outside JSON.`;

/**
 * Two generic examples anchoring the JSON shape. Example A (the common case)
 * shows evidence grounding and NO follow-up, calibrating the model against
 * the prior version's reflex to always emit follow-ups. Example B shows the
 * legitimate-gap case where one follow-up is warranted. Kept hardcoded (not
 * templated on user input) so the anchor is identical regardless of role/goal.
 */
const FEW_SHOT_EXAMPLE = `EXAMPLE A (no follow-up — the common case):
Heard: "Our current rate is 4.8%. We can offer you 4.2% if you sign today."
Prep: { notes: "Renegotiating mortgage rate; want ≤5y fixed.", Bank contract: "Current rate 4.8%, 25-year term, prepayment penalty 1% of remaining balance." }
Output: {"answer":"4.2% beats your 4.8% — but check the lock window and the 1% penalty.","detail":"Saves ~€120/month at current balance; only worth it if fixed for several years.","source":"Bank contract","evidence":{"source":"Bank contract","quote":"Current rate 4.8%, 25-year term, prepayment penalty 1% of remaining balance."}}

EXAMPLE B (genuine gap — one follow-up):
Heard: "We can give you 4.2% if you sign today."
Prep: { notes: "Renegotiating mortgage rate.", Bank contract: "Current rate 4.8%, 25-year term." }
Output: {"answer":"4.2% beats your 4.8% — but prep doesn't say how long it's fixed.","detail":"Saves ~€120/month; only meaningful if fixed for several years.","source":"Bank contract","evidence":{"source":"Bank contract","quote":"Current rate 4.8%, 25-year term."},"followUp":"Is 4.2% fixed, and for how many years?"}`;

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
    `\n\nLANGUAGE: Write the answer, detail, and follow-up prompt in ${langName}.`,
  );
  if (labels.length > 0) {
    parts.push(
      ' Keep the evidence quote in its original language (verbatim from the attachment).' +
        ' Attachment labels in the "source" field must stay as-is regardless of language.',
    );
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

  const properties: Record<string, unknown> = {
    answer: {
      type: 'string',
      description: `Primary answer (max ${MAX_ANSWER_CHARS} chars).`,
    },
    detail: {
      type: 'string',
      description: `Optional supporting line (max ${MAX_DETAIL_CHARS} chars).`,
    },
    followUp: {
      type: 'string',
      description:
        `Optional single follow-up to ask the other party (max ${MAX_FOLLOW_UP_CHARS} chars). ` +
        'Only set when prep is genuinely silent on a decision-changing detail.',
    },
  };

  if (labels.length > 0) {
    const sourceProp = {
      type: 'string',
      enum: labels,
      description: 'Attachment label this draws from (exact match required).',
    };
    properties['source'] = sourceProp;
    properties['evidence'] = {
      type: 'object',
      description:
        'Short verbatim or near-verbatim excerpt from one attachment that grounds the answer.',
      properties: {
        source: sourceProp,
        quote: {
          type: 'string',
          description: `Excerpt from the attachment (max ${MAX_EVIDENCE_CHARS} chars).`,
        },
      },
      required: ['source', 'quote'],
    };
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
    kind: 'answer',
    text: trimTo(typeof raw['answer'] === 'string' ? raw['answer'] : '', MAX_ANSWER_CHARS),
    source: coerceSource(raw['source'], validLabels),
    detail: trimTo(typeof raw['detail'] === 'string' ? raw['detail'] : '', MAX_DETAIL_CHARS),
  });

  const evidenceRaw = raw['evidence'];
  if (isRecord(evidenceRaw)) {
    const evidenceSource = coerceSource(evidenceRaw['source'], validLabels);
    const evidenceQuote = trimTo(
      typeof evidenceRaw['quote'] === 'string' ? evidenceRaw['quote'] : '',
      MAX_EVIDENCE_CHARS,
    );
    if (evidenceSource && evidenceQuote) {
      claims.push({
        kind: 'evidence',
        text: evidenceQuote,
        source: evidenceSource,
        detail: '',
      });
    }
  }

  const followUp = trimTo(
    typeof raw['followUp'] === 'string' ? raw['followUp'] : '',
    MAX_FOLLOW_UP_CHARS,
  );
  if (followUp) {
    claims.push({
      kind: 'followup',
      text: followUp,
      source: '',
      detail: '',
    });
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
