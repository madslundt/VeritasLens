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
 * Cap on the bare source domain the model echoes back when `source === 'Web'`.
 * Real public-record domains run well under this (e.g. `nationalbanken.dk` is
 * 17 chars). The cap is a safety net against a runaway response — a full URL
 * or a paragraph slipping into the slot — not an aesthetic limit. Render-site
 * trimming for the SettingsView history detail is independent of this.
 */
export const MAX_SOURCE_META_CHARS = 80;

/** Sentinel source value used when the answer is drawn from a web search
 *  result rather than one of the user's attachments. Only valid when grounding
 *  is enabled — see {@link MeetingPrepOptions}. */
export const WEB_SOURCE_LABEL = 'Web';

/** Optional behaviour flags threaded through schema / prompt / parse. */
export interface MeetingPrepOptions {
  /** When true the schema admits `'Web'` as a source value, the prompt
   *  teaches the model when to use it, and the parser propagates the model's
   *  `webSourceDomain` onto `claims[0].sourceMeta`. */
  webGrounding?: boolean;
}

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

/**
 * Mortgage-rate web-conflict example. Used only when web grounding is on; the
 * generic FEW_SHOT block above stays in place so the model also sees what an
 * un-grounded answer looks like. Anchors the model on three behaviours:
 *   1. Prep stays the source of truth for the wearer's deal (here, the user's
 *      own 4.8% rate from the bank contract attachment).
 *   2. Web is consulted to verify a public/market claim the counterparty
 *      asserts (here, "the base rate is 4.8%").
 *   3. When the public fact contradicts the counterparty's claim, the answer
 *      flags the conflict with `source: "Web"` and echoes the source domain
 *      via `webSourceDomain`.
 */
const FEW_SHOT_EXAMPLE_C_WEB = `EXAMPLE C (web-grounded — counterparty cites a public number the web contradicts):
Heard: "Our 4.2% offer is generous — the current base rate set by the central bank is 4.8%, so you're getting a discount."
Prep: { notes: "Renegotiating mortgage rate; want ≤5y fixed.", Bank contract: "Current rate 4.8%, 25-year term." }
Web search result: Nationalbanken.dk publishes the current Danish base rate as 1.75%.
Output: {"answer":"The central bank's base rate is 1.75%, not 4.8% — 4.2% isn't a discount, it's a 2.45-pt margin.","detail":"Your own contract is at 4.8% (the rate they may be referring to), but the public base rate is far lower.","source":"Web","webSourceDomain":"nationalbanken.dk","evidence":{"source":"Bank contract","quote":"Current rate 4.8%, 25-year term."}}`;

/** Web-grounding rules appended to the prompt only when the caller turns
 *  grounding on. Keeping the rules in their own constant lets the un-grounded
 *  prompt stay identical to v1 (no behaviour drift) and keeps the rules' "use
 *  Web for public/market claims, not for the wearer's own deal" priority
 *  explicit so the model can't drift toward citing Web for everything. */
const WEB_GROUNDING_RULES = `

WEB SEARCH IS AVAILABLE:
- Use prep notes and attachments as the source of truth for the wearer's own deal — their contract, their goals, their history. Never set "source" to "Web" for facts only the wearer's prep can know.
- Use web search to verify what the COUNTERPARTY asserts about the public world — current rates, company facts, regulatory numbers, time-sensitive market data. When the counterparty's claim conflicts with current public reality, flag the conflict in "answer" and set "source": "Web".
- When you set "source": "Web", you MUST set "webSourceDomain" to the bare source domain (e.g. "nationalbanken.dk"). No "https://", no path, no full URL. Use only a domain that actually appeared in your web search results — do not invent one. If web search produced no usable result, omit "source" and "webSourceDomain" entirely; do not fabricate a citation.
- Web evidence does NOT go in the "evidence" field — that slot remains reserved for verbatim attachment excerpts. If both an attachment quote and a web fact are relevant, keep the attachment quote in "evidence" and flag the web conflict in "answer".`;

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
  opts: MeetingPrepOptions = {},
): string {
  const langName = LANGUAGES[lang] ?? 'English';
  const { generalBody, attachments } = partition(sections);
  const labels = resolveAttachmentLabels(attachments);
  const webGrounding = opts.webGrounding === true;

  // The grounded path always appends Example C *after* the generic A+B pair so
  // the model still sees what a non-grounded answer looks like — Example C is
  // additive, not a replacement.
  const fewShot = webGrounding
    ? `${FEW_SHOT_EXAMPLE}\n\n${FEW_SHOT_EXAMPLE_C_WEB}`
    : FEW_SHOT_EXAMPLE;

  const parts: string[] = [BASE_PROMPT];
  if (webGrounding) parts.push(WEB_GROUNDING_RULES);
  parts.push('\n\n', fewShot, '\n\nPREPARED CONTEXT:');

  if (generalBody) {
    parts.push(`\n\n# Notes (general — not a citable source)\n${generalBody}`);
  }

  attachments.forEach((s, i) => {
    parts.push(`\n\n=== ${labels[i]} ===\n${s.body.trim()}`);
  });

  // When grounding is on, `"Web"` joins the attachment labels (or stands on
  // its own when the user has no attachments). Concatenating into a single
  // enum hint keeps the model's source choice unambiguous regardless of
  // whether attachments are present.
  const sourceLabels = webGrounding ? [...labels, WEB_SOURCE_LABEL] : labels;
  if (sourceLabels.length > 0) {
    const enumList = sourceLabels.map((l) => `"${l}"`).join(', ');
    const heading = webGrounding
      ? 'SOURCE LABELS (use one of these exact strings when setting "source")'
      : 'ATTACHMENT LABELS (use one of these exact strings when setting "source")';
    parts.push(`\n\n${heading}: ${enumList}`);
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
  if (webGrounding) {
    // Domains are ASCII regardless of `langName`; an attempt to localise
    // ("nationalbankens.dk") would mangle a real hostname. Pin it explicitly.
    parts.push(
      ' The "Web" source label and any "webSourceDomain" value stay in English / ASCII regardless of language.',
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
  opts: MeetingPrepOptions = {},
): Record<string, unknown> {
  const { attachments } = partition(sections);
  const labels = resolveAttachmentLabels(attachments);
  const webGrounding = opts.webGrounding === true;

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

  // Top-level `source` enum carries both the attachment labels and the `Web`
  // sentinel (when grounding is on). The `evidence.source` enum stays bound
  // to attachment labels only — evidence excerpts are reserved for verbatim
  // attachment text; web facts surface only in `answer` + the top-level
  // `source` / `webSourceDomain` pair.
  const topSourceLabels = webGrounding ? [...labels, WEB_SOURCE_LABEL] : labels;
  if (topSourceLabels.length > 0) {
    properties['source'] = {
      type: 'string',
      enum: topSourceLabels,
      description: webGrounding
        ? 'Source this draws from — an attachment label, or "Web" when grounded in a web search result. Exact match required.'
        : 'Attachment label this draws from (exact match required).',
    };
  }
  if (labels.length > 0) {
    const evidenceSourceProp = {
      type: 'string',
      enum: labels,
      description: 'Attachment label this draws from (exact match required).',
    };
    properties['evidence'] = {
      type: 'object',
      description:
        'Short verbatim or near-verbatim excerpt from one attachment that grounds the answer.',
      properties: {
        source: evidenceSourceProp,
        quote: {
          type: 'string',
          description: `Excerpt from the attachment (max ${MAX_EVIDENCE_CHARS} chars).`,
        },
      },
      required: ['source', 'quote'],
    };
  }
  if (webGrounding) {
    properties['webSourceDomain'] = {
      type: 'string',
      description:
        `Bare domain you drew from when source === "Web" (e.g. "nationalbanken.dk"). ` +
        'No "https://", no path, no full URL. Must be a domain that appeared in your web search results. ' +
        'Required when source === "Web", omitted otherwise.',
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
  opts: MeetingPrepOptions = {},
): LensResult {
  const raw = parseJsonResponse(text);
  const { attachments } = partition(sections);
  const webGrounding = opts.webGrounding === true;
  // Evidence excerpts are reserved for attachment text — the `Web` sentinel is
  // valid only on the top-level `source`, never inside `evidence.source`.
  const attachmentLabels = new Set(resolveAttachmentLabels(attachments));
  const topSourceLabels = webGrounding
    ? new Set([...attachmentLabels, WEB_SOURCE_LABEL])
    : attachmentLabels;
  const claims: MeetingPrepClaim[] = [];

  const answerSource = coerceSource(raw['source'], topSourceLabels);
  // The model only fills sourceMeta when it has set source: "Web" — otherwise
  // an attachment label is its own attribution and the field is meaningless.
  const sourceMeta =
    webGrounding && answerSource === WEB_SOURCE_LABEL
      ? normalizeWebDomain(raw['webSourceDomain'])
      : '';
  claims.push({
    kind: 'answer',
    text: trimTo(typeof raw['answer'] === 'string' ? raw['answer'] : '', MAX_ANSWER_CHARS),
    source: answerSource,
    detail: trimTo(typeof raw['detail'] === 'string' ? raw['detail'] : '', MAX_DETAIL_CHARS),
    ...(sourceMeta ? { sourceMeta } : {}),
  });

  const evidenceRaw = raw['evidence'];
  if (isRecord(evidenceRaw)) {
    const evidenceSource = coerceSource(evidenceRaw['source'], attachmentLabels);
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
 * Normalise a model-supplied `webSourceDomain` into a bare lowercase domain.
 * Defensive against a misbehaving model that emits a full URL, mixed case, a
 * trailing slash, or surrounding whitespace; returns '' for any
 * recognisably-invalid input (numeric, no dot, control chars, runaway length)
 * so the parser drops it rather than persisting garbage onto `sourceMeta`.
 *
 * Intentionally NOT a full RFC-3986 validator — the HUD renders this string,
 * it isn't used for navigation, so the only real risk is visual noise.
 */
function normalizeWebDomain(value: unknown): string {
  if (typeof value !== 'string') return '';
  let s = value.trim();
  if (!s) return '';
  // Strip a leading protocol if the model slipped one in.
  s = s.replace(/^[a-z]+:\/\//i, '');
  // Drop any path / query / fragment — domain only.
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h);
  s = s.toLowerCase();
  if (s.length === 0 || s.length > MAX_SOURCE_META_CHARS) return '';
  // Must contain a dot and at least one alphabetic TLD character — rules out
  // raw IPs and obvious placeholder garbage like "example" without a TLD.
  if (!/^[a-z0-9.-]+\.[a-z][a-z0-9-]*$/.test(s)) return '';
  return s;
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
