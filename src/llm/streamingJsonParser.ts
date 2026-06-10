// src/llm/streamingJsonParser.ts

/**
 * Streaming JSON parser for SSE chunks. Surfaces partials as soon as values
 * complete at the top level of the response object so the HUD can render
 * incrementally before the whole JSON arrives.
 *
 * Emitted events:
 *   - `noSpeech` — `"noSpeech": true` appears anywhere in the buffer. Fires
 *     before any other event so the HUD can short-circuit to the `○` glyph.
 *   - `field`    — a top-level scalar property (string / number / boolean /
 *     null) finished parsing. One emit per key. Covers shapes like
 *     `translation` (sourceLanguage, sourceText, translatedText, …) and
 *     `sessionSummary` (topic, summary).
 *   - `claim`    — a complete object inside the FIRST top-level array,
 *     whatever its key (`claims`, `questions`, `starters`, …). The key is
 *     surfaced on the event so callers know which schema slot it fills.
 *   - `done`     — root object closed, or the stream ended.
 *
 * The parser is forgiving: malformed fragments are silently skipped because
 * the lens's own `parse()` runs the final text through strict validation.
 * The streaming layer is purely a perceived-latency optimization.
 */

export type StreamingJsonEvent =
  | { type: 'claim'; key: string; claim: Record<string, unknown> }
  | { type: 'field'; name: string; value: string | number | boolean | null }
  | { type: 'noSpeech' }
  | { type: 'done' };

export type StreamingJsonListener = (event: StreamingJsonEvent) => void;

const NO_SPEECH_PATTERN = /"noSpeech"\s*:\s*true/;

type Mode =
  | 'before_root'
  | 'find_key'
  | 'find_colon'
  | 'find_value'
  | 'in_string_value'
  | 'in_literal_value'
  | 'in_root_object'
  | 'in_root_array'
  | 'find_comma'
  | 'done';

export class StreamingJsonParser {
  private buffer = '';
  private pos = 0;

  // String parsing state — preserved across feeds because a chunk can split
  // mid-string. Once `inString` is true, every char belongs to the string
  // until the unescaped closing quote.
  private inString = false;
  private escapeNext = false;

  // Total nesting depth. Increments on `{` and `[`, decrements on `}` and `]`.
  private depth = 0;

  // Top-level state machine — what we're currently looking for at depth 1.
  private mode: Mode = 'before_root';

  // While reading a key string, the index of the first char of the key.
  private keyStart = -1;
  // The most recently completed root-level key, waiting for its value.
  private currentKey: string | null = null;

  // For string and literal values: where the value starts in the buffer.
  // For strings, includes the opening quote so `JSON.parse(slice)` works.
  private valueStart = -1;

  // First top-level array tracking. Once `rootArrayKey` is set, items in
  // that array emit `claim` events; subsequent arrays at the root level are
  // walked through without item emission (their objects still fall under
  // depth tracking but we don't synthesize partials for them — the schemas
  // we care about have only one streamable array per response).
  private rootArrayKey: string | null = null;
  private arrayBracketDepth = 0;     // depth at which the array's own `[` lives
  private currentItemStart = -1;     // start of the object item currently being read

  // Single-shot emission flags.
  private noSpeechEmitted = false;
  private doneEmitted = false;
  private emittedFieldKeys = new Set<string>();
  private claimsEmitted = 0;

  /** Append a new SSE text chunk and emit any partials that just completed. */
  feed(chunk: string, onEvent: StreamingJsonListener): void {
    if (!chunk) return;
    this.buffer += chunk;

    // noSpeech can sit anywhere in the top-level object — check eagerly so
    // we can flash the `○` glyph before any item arrives.
    if (!this.noSpeechEmitted && NO_SPEECH_PATTERN.test(this.buffer)) {
      this.noSpeechEmitted = true;
      onEvent({ type: 'noSpeech' });
    }

    while (this.pos < this.buffer.length && this.mode !== 'done') {
      const ch = this.buffer[this.pos]!;

      // Strings dominate — every char between unescaped quotes belongs to
      // the string and bypasses the structural state machine.
      if (this.escapeNext) {
        this.escapeNext = false;
        this.pos++;
        continue;
      }
      if (this.inString) {
        if (ch === '\\') {
          this.escapeNext = true;
          this.pos++;
          continue;
        }
        if (ch === '"') {
          this.inString = false;
          if (this.mode === 'find_key') {
            this.currentKey = this.buffer.slice(this.keyStart, this.pos);
            this.mode = 'find_colon';
          } else if (this.mode === 'in_string_value') {
            this.emitStringField(onEvent, this.valueStart, this.pos);
            this.mode = 'find_comma';
          }
          // String values that live inside a nested object/array contribute
          // nothing — depth tracking has already been suspended for them.
          this.pos++;
          continue;
        }
        this.pos++;
        continue;
      }

      switch (this.mode) {
        case 'before_root': {
          if (ch === '{') {
            this.depth = 1;
            this.mode = 'find_key';
          }
          this.pos++;
          break;
        }
        case 'find_key': {
          if (ch === '"') {
            this.inString = true;
            this.keyStart = this.pos + 1;
          } else if (ch === '}') {
            this.depth = 0;
            this.emitDone(onEvent);
          }
          this.pos++;
          break;
        }
        case 'find_colon': {
          if (ch === ':') this.mode = 'find_value';
          this.pos++;
          break;
        }
        case 'find_value': {
          if (ch === '"') {
            this.inString = true;
            this.valueStart = this.pos;
            this.mode = 'in_string_value';
            this.pos++;
          } else if (ch === '{') {
            this.depth++;
            this.mode = 'in_root_object';
            this.pos++;
          } else if (ch === '[') {
            this.depth++;
            if (this.rootArrayKey === null && this.currentKey !== null) {
              this.rootArrayKey = this.currentKey;
              this.arrayBracketDepth = this.depth - 1;
              this.currentItemStart = -1;
              this.mode = 'in_root_array';
            } else {
              // A second top-level array (rare) — walk it as a nested object.
              this.mode = 'in_root_object';
            }
            this.pos++;
          } else if (isLiteralStart(ch)) {
            this.valueStart = this.pos;
            this.mode = 'in_literal_value';
            this.pos++;
          } else {
            this.pos++;
          }
          break;
        }
        case 'in_literal_value': {
          if (isLiteralEnd(ch)) {
            const raw = this.buffer.slice(this.valueStart, this.pos);
            this.emitLiteralField(onEvent, raw);
            if (ch === ',') {
              this.mode = 'find_key';
              this.pos++;
            } else if (ch === '}') {
              this.depth = 0;
              this.emitDone(onEvent);
              this.pos++;
            } else {
              // whitespace — let `find_comma` handle the next structural char
              this.mode = 'find_comma';
              this.pos++;
            }
          } else {
            this.pos++;
          }
          break;
        }
        case 'in_root_object': {
          // Walk through any nested object — depth tracking only, no events.
          if (ch === '{' || ch === '[') {
            this.depth++;
          } else if (ch === '}' || ch === ']') {
            this.depth--;
            if (this.depth === 1) this.mode = 'find_comma';
          }
          this.pos++;
          break;
        }
        case 'in_root_array': {
          if (ch === '{') {
            if (this.depth === this.arrayBracketDepth + 1 && this.currentItemStart === -1) {
              this.currentItemStart = this.pos;
            }
            this.depth++;
          } else if (ch === '[') {
            this.depth++;
          } else if (ch === '}') {
            this.depth--;
            if (this.depth === this.arrayBracketDepth + 1 && this.currentItemStart !== -1) {
              const objText = this.buffer.slice(this.currentItemStart, this.pos + 1);
              this.currentItemStart = -1;
              try {
                const parsed = JSON.parse(objText) as Record<string, unknown>;
                this.claimsEmitted++;
                onEvent({ type: 'claim', key: this.rootArrayKey ?? '', claim: parsed });
              } catch {
                // Defensive — depth tracking should make this unreachable.
              }
            }
          } else if (ch === ']') {
            this.depth--;
            if (this.depth === this.arrayBracketDepth) {
              this.mode = 'find_comma';
            }
          }
          this.pos++;
          break;
        }
        case 'find_comma': {
          if (ch === ',') {
            this.mode = 'find_key';
          } else if (ch === '}') {
            this.depth = 0;
            this.emitDone(onEvent);
          }
          this.pos++;
          break;
        }
      }
    }
  }

  /** Force the `done` event if the stream ended without us seeing the root close. */
  end(onEvent: StreamingJsonListener): void {
    if (!this.doneEmitted) {
      this.doneEmitted = true;
      onEvent({ type: 'done' });
    }
  }

  /** Full accumulated text — caller passes this to the lens's `parse()`. */
  get text(): string {
    return this.buffer;
  }

  /** Count of `claim` events emitted so far. Useful for tests and HUD. */
  get partialCount(): number {
    return this.claimsEmitted;
  }

  private emitStringField(
    onEvent: StreamingJsonListener,
    openQuotePos: number,
    closeQuotePos: number,
  ): void {
    if (this.currentKey === null) return;
    const key = this.currentKey;
    this.currentKey = null;
    if (this.emittedFieldKeys.has(key)) return;
    this.emittedFieldKeys.add(key);
    if (key === 'noSpeech') return;
    try {
      const raw = this.buffer.slice(openQuotePos, closeQuotePos + 1);
      const value = JSON.parse(raw) as string;
      onEvent({ type: 'field', name: key, value });
    } catch {
      // Defensive — JSON.parse on a properly delimited string should not fail.
    }
  }

  private emitLiteralField(onEvent: StreamingJsonListener, raw: string): void {
    if (this.currentKey === null) return;
    const key = this.currentKey;
    this.currentKey = null;
    if (this.emittedFieldKeys.has(key)) return;
    this.emittedFieldKeys.add(key);
    if (key === 'noSpeech') return;
    try {
      const value = JSON.parse(raw.trim()) as number | boolean | null;
      onEvent({ type: 'field', name: key, value });
    } catch {
      // Partial literal — skip; final lens parse will handle it.
    }
  }

  private emitDone(onEvent: StreamingJsonListener): void {
    this.mode = 'done';
    if (this.doneEmitted) return;
    this.doneEmitted = true;
    onEvent({ type: 'done' });
  }
}

function isLiteralStart(ch: string): boolean {
  return (
    ch === '-' ||
    (ch >= '0' && ch <= '9') ||
    ch === 't' ||
    ch === 'f' ||
    ch === 'n'
  );
}

function isLiteralEnd(ch: string): boolean {
  return (
    ch === ',' ||
    ch === '}' ||
    ch === ']' ||
    ch === ' ' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '\t'
  );
}
