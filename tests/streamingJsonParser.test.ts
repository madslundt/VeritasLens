// tests/streamingJsonParser.test.ts
import { describe, it, expect } from 'vitest';
import { StreamingJsonParser, type StreamingJsonEvent } from '../src/llm/streamingJsonParser';

function collect(chunks: string[]): StreamingJsonEvent[] {
  const events: StreamingJsonEvent[] = [];
  const parser = new StreamingJsonParser();
  for (const c of chunks) parser.feed(c, (e) => events.push(e));
  parser.end((e) => events.push(e));
  return events;
}

describe('StreamingJsonParser', () => {
  it('emits one claim event per completed object in claims array', () => {
    const text = '{"claims":[{"quote":"a","verdict":"TRUE","claim":"A","reason":"r1"},{"quote":"b","verdict":"FALSE","claim":"B","reason":"r2"}]}';
    const events = collect([text]);
    const claims = events.filter((e) => e.type === 'claim');
    expect(claims).toHaveLength(2);
    expect((claims[0] as { type: 'claim'; claim: Record<string, unknown> }).claim['quote']).toBe('a');
    expect((claims[1] as { type: 'claim'; claim: Record<string, unknown> }).claim['quote']).toBe('b');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('handles chunk boundaries inside an object', () => {
    const text = '{"claims":[{"quote":"hello","verdict":"TRUE","claim":"c","reason":"r"}]}';
    // Split into many small chunks
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 3) chunks.push(text.slice(i, i + 3));
    const events = collect(chunks);
    const claims = events.filter((e) => e.type === 'claim');
    expect(claims).toHaveLength(1);
    expect((claims[0] as { type: 'claim'; claim: Record<string, unknown> }).claim['quote']).toBe('hello');
  });

  it('handles chunk boundary mid-string with escaped quotes', () => {
    // Reason text contains an escaped quote — the parser must not mistake the
    // escaped quote inside the string for the end of the string and trip the
    // depth tracker.
    const text = '{"claims":[{"quote":"a","verdict":"TRUE","claim":"He said \\"hi\\"","reason":"r"}]}';
    // Split right inside the escaped sequence
    const events = collect([text.slice(0, 50), text.slice(50)]);
    const claims = events.filter((e) => e.type === 'claim');
    expect(claims).toHaveLength(1);
    expect((claims[0] as { type: 'claim'; claim: Record<string, unknown> }).claim['claim']).toBe('He said "hi"');
  });

  it('does not emit a claim until the closing brace arrives', () => {
    const parser = new StreamingJsonParser();
    const events: StreamingJsonEvent[] = [];
    parser.feed('{"claims":[{"quote":"a","verdict":"TRUE"', (e) => events.push(e));
    expect(events.filter((e) => e.type === 'claim')).toHaveLength(0);
    parser.feed(',"claim":"A","reason":"r"}]}', (e) => events.push(e));
    expect(events.filter((e) => e.type === 'claim')).toHaveLength(1);
  });

  it('emits noSpeech as soon as the flag appears, before any claim', () => {
    const text = '{"noSpeech":true,"claims":[]}';
    const events = collect([text]);
    const noSpeech = events.find((e) => e.type === 'noSpeech');
    expect(noSpeech).toBeDefined();
  });

  it('handles braces inside string values without confusing the depth tracker', () => {
    const text = '{"claims":[{"quote":"see {this} bracket","verdict":"TRUE","claim":"c","reason":"r"}]}';
    const events = collect([text]);
    const claims = events.filter((e) => e.type === 'claim');
    expect(claims).toHaveLength(1);
    expect((claims[0] as { type: 'claim'; claim: Record<string, unknown> }).claim['quote']).toBe('see {this} bracket');
  });

  it('accumulates full text in the .text property for the final parse', () => {
    const parser = new StreamingJsonParser();
    parser.feed('{"claims":[', () => {});
    parser.feed('{"x":1}]}', () => {});
    expect(parser.text).toBe('{"claims":[{"x":1}]}');
  });

  it('reports partial count', () => {
    const parser = new StreamingJsonParser();
    let count = 0;
    parser.feed('{"claims":[{"a":1},{"a":2},{"a":3}]}', (e) => {
      if (e.type === 'claim') count++;
    });
    expect(count).toBe(3);
    expect(parser.partialCount).toBe(3);
  });

  it('emits done exactly once even if end() is called after the close bracket', () => {
    const parser = new StreamingJsonParser();
    const events: StreamingJsonEvent[] = [];
    parser.feed('{"claims":[{"a":1}]}', (e) => events.push(e));
    parser.end((e) => events.push(e));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('emits done from end() when stream cut off before close bracket', () => {
    const parser = new StreamingJsonParser();
    const events: StreamingJsonEvent[] = [];
    parser.feed('{"claims":[{"a":1}', (e) => events.push(e));
    parser.end((e) => events.push(e));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('emits claim events for items in any first top-level array (game.questions)', () => {
    const text = '{"questions":[{"q":"Q1","a":"A1"},{"q":"Q2","a":"A2"}]}';
    const events = collect([text]);
    const claims = events.filter((e) => e.type === 'claim');
    expect(claims).toHaveLength(2);
    expect((claims[0] as { type: 'claim'; key: string; claim: Record<string, unknown> }).key).toBe('questions');
    expect((claims[0] as { type: 'claim'; key: string; claim: Record<string, unknown> }).claim['q']).toBe('Q1');
    expect((claims[1] as { type: 'claim'; key: string; claim: Record<string, unknown> }).claim['q']).toBe('Q2');
  });

  it('emits the array key on claim events for "claims" too (back-compat)', () => {
    const text = '{"claims":[{"quote":"a","verdict":"TRUE","claim":"A","reason":"r"}]}';
    const events = collect([text]);
    const claim = events.find((e) => e.type === 'claim') as
      | { type: 'claim'; key: string; claim: Record<string, unknown> }
      | undefined;
    expect(claim?.key).toBe('claims');
  });

  it('emits field events for top-level scalar strings (translation)', () => {
    const text =
      '{"sourceLanguage":"es","sourceText":"Hola","translatedText":"Hello","starters":[]}';
    const events = collect([text]);
    const fields = events.filter((e) => e.type === 'field') as Array<
      { type: 'field'; name: string; value: string | number | boolean | null }
    >;
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    expect(byName['sourceLanguage']).toBe('es');
    expect(byName['sourceText']).toBe('Hola');
    expect(byName['translatedText']).toBe('Hello');
  });

  it('emits field events for top-level numbers and booleans', () => {
    const text = '{"score":0.85,"complete":true,"count":3,"claims":[]}';
    const events = collect([text]);
    const fields = events.filter((e) => e.type === 'field') as Array<
      { type: 'field'; name: string; value: string | number | boolean | null }
    >;
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    expect(byName['score']).toBe(0.85);
    expect(byName['complete']).toBe(true);
    expect(byName['count']).toBe(3);
  });

  it('handles mixed top-level fields, arrays, and chunk boundaries', () => {
    const text =
      '{"sourceLanguage":"fr","sourceText":"Bonjour","starters":[{"source":"Salut","translated":"Hi"},{"source":"Merci","translated":"Thanks"}]}';
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 5) chunks.push(text.slice(i, i + 5));
    const events = collect(chunks);
    const fields = events.filter((e) => e.type === 'field') as Array<
      { type: 'field'; name: string; value: string | number | boolean | null }
    >;
    expect(fields.find((f) => f.name === 'sourceLanguage')?.value).toBe('fr');
    expect(fields.find((f) => f.name === 'sourceText')?.value).toBe('Bonjour');
    const claims = events.filter((e) => e.type === 'claim') as Array<
      { type: 'claim'; key: string; claim: Record<string, unknown> }
    >;
    expect(claims).toHaveLength(2);
    expect(claims[0]!.key).toBe('starters');
    expect(claims[0]!.claim['source']).toBe('Salut');
  });

  it('does not emit a field for noSpeech (handled separately as noSpeech event)', () => {
    const text = '{"noSpeech":true,"claims":[]}';
    const events = collect([text]);
    const fields = events.filter((e) => e.type === 'field');
    expect(fields).toHaveLength(0);
    expect(events.find((e) => e.type === 'noSpeech')).toBeDefined();
  });

  it('emits each field exactly once even on repeated feed() calls', () => {
    const parser = new StreamingJsonParser();
    const events: StreamingJsonEvent[] = [];
    parser.feed('{"sourceText":"abc"', (e) => events.push(e));
    parser.feed(',"translatedText":"xyz"}', (e) => events.push(e));
    const fields = events.filter((e) => e.type === 'field');
    expect(fields).toHaveLength(2);
  });
});
