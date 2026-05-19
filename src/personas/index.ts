import { createSignal } from 'solid-js';
import { FACT_CHECKER_PROMPT, FACT_CHECKER_SCHEMA, parseFactCheckerResponse } from './factChecker';
import type { Verdict } from '@/types';

/**
 * Persona registry.
 *
 * A persona is (system prompt + response schema + parser + display copy).
 * The catalogue is mutable at runtime — built-in personas live forever,
 * user-created custom personas can be added/removed.
 */

export type PersonaId = string;

export interface Persona {
  id: PersonaId;
  name: string;
  description: string;
  /** Short call-to-action stored alongside the persona; not currently shown on HUD. */
  hint: string;
  prompt: string;
  schema: Record<string, unknown>;
  parse: (text: string) => Verdict;
  /** Built-in personas cannot be deleted by the user. */
  builtin: boolean;
}

/** Serializable shape of a user-created persona. */
export interface CustomPersonaData {
  id: PersonaId;
  name: string;
  description: string;
  prompt: string;
}

const FACT_CHECKER: Persona = {
  id: 'fact-checker',
  name: 'Fact-Checker',
  description:
    'Identifies the most check-worthy factual claim in the last 30 seconds and labels it TRUE / FALSE / UNVERIFIED.',
  hint: 'Tap to fact-check',
  prompt: FACT_CHECKER_PROMPT,
  schema: FACT_CHECKER_SCHEMA as unknown as Record<string, unknown>,
  parse: parseFactCheckerResponse,
  builtin: true,
};

const BUILTINS: Persona[] = [FACT_CHECKER];

const [personasSignal, setPersonasSignal] = createSignal<Persona[]>(BUILTINS);

/** Reactive accessor — returns the current persona list. */
export const personas = personasSignal;

export function getPersonas(): Persona[] {
  return personasSignal();
}

export function getPersona(id: PersonaId): Persona | undefined {
  return personasSignal().find((p) => p.id === id);
}

export function builtinIds(): PersonaId[] {
  return BUILTINS.map((p) => p.id);
}

/**
 * Wrap a user-supplied intent description with the boilerplate that pins
 * the response format. The user just describes *what* the lens should do
 * with the audio — we handle the JSON envelope, the verdict labels, and
 * the length constraints so the HUD renderer keeps working uniformly.
 */
export function wrapCustomPrompt(userIntent: string): string {
  return `You are VeritasLens, an audio analysis assistant for smart glasses.

The user just provided a short audio clip (up to 30 seconds) of recent conversation. Your task, described by the user:

${userIntent.trim()}

Apply this task to the audio and report the result. Output strict JSON matching the provided schema:
- "verdict": one of "TRUE", "FALSE", "UNVERIFIED". Use "TRUE" for affirmative/positive outcomes, "FALSE" for negative outcomes, and "UNVERIFIED" if the audio doesn't apply, is unclear, or you cannot confidently complete the task.
- "claim": ONE concise sentence (max 110 characters) phrased as a statement that summarizes what was heard or your primary finding.
- "reason": 2-3 short sentences (max 240 characters total) of detail or explanation that supports the verdict.

Do not add prose outside JSON. Do not invent facts. Prefer "UNVERIFIED" over guessing.`;
}

/**
 * Build a Persona from a stored custom-persona record. Custom personas reuse
 * the Fact-Checker response schema/parser; only the system prompt is bespoke.
 */
export function makeCustomPersona(data: CustomPersonaData): Persona {
  return {
    id: data.id,
    name: data.name,
    description: data.description,
    hint: `Tap to apply: ${data.name}`,
    prompt: wrapCustomPrompt(data.prompt),
    schema: FACT_CHECKER_SCHEMA as unknown as Record<string, unknown>,
    parse: parseFactCheckerResponse,
    builtin: false,
  };
}

/** Replace the entire persona list (used internally by store load/add/remove). */
export function _setPersonas(next: Persona[]): void {
  setPersonasSignal(next);
}

/** Legacy alias retained so existing imports keep working. */
export const PERSONAS = personasSignal;
