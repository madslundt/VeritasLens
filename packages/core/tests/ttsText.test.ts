import { describe, it, expect } from 'vitest';
import { toSpeech } from '../src/runtime/ttsText';
import type { LensResult } from '../src/types';

describe('toSpeech', () => {
  it('fact-check: counts verdicts correctly', () => {
    const result: LensResult = {
      type: 'fact-check',
      claims: [
        { quote: 'q1', claim: 'c1', verdict: 'TRUE', reason: 'r1', correction: '' },
        { quote: 'q2', claim: 'c2', verdict: 'FALSE', reason: 'r2', correction: 'x' },
        { quote: 'q3', claim: 'c3', verdict: 'UNVERIFIED', reason: 'r3', correction: '' },
      ],
    };
    expect(toSpeech(result)).toBe('3 claims — 1 true, 1 false, 1 unverifiable.');
  });

  it('translation: returns translatedText', () => {
    const result: LensResult = {
      type: 'translation',
      sourceLanguage: 'es',
      sourceText: 'Hola',
      translatedText: 'Hello',
      replyStarters: [],
    };
    expect(toSpeech(result)).toBe('Hello');
  });

  it('eli5: returns first claim explanation', () => {
    const result: LensResult = {
      type: 'eli5',
      claims: [
        { quote: 'q', explanation: 'It works like a sponge.' },
        { quote: 'q2', explanation: 'Another explanation.' },
      ],
    };
    expect(toSpeech(result)).toBe('It works like a sponge.');
  });

  it('eli5: falls back to oneLine when explanation is absent', () => {
    const result: LensResult = {
      type: 'eli5',
      claims: [
        { quote: 'q', oneLine: 'Short version.' },
      ],
    };
    expect(toSpeech(result)).toBe('Short version.');
  });

  it('session-summary: returns title sentence', () => {
    const result: LensResult = {
      type: 'session-summary',
      title: 'Product launch',
      summary: 'We discussed the launch.',
      topics: [],
      keyPoints: [],
    };
    expect(toSpeech(result)).toBe('Session summary: Product launch.');
  });

  it('logical-fallacy: counts claims', () => {
    const result: LensResult = {
      type: 'logical-fallacy',
      claims: [
        { quote: 'q1', fallacy: 'Ad hominem', explanation: 'e1' },
        { quote: 'q2', fallacy: 'Straw man', explanation: 'e2' },
      ],
    };
    expect(toSpeech(result)).toBe('2 logical fallacies detected.');
  });

  it('bias: no bias when claims empty', () => {
    const result: LensResult = {
      type: 'bias',
      claims: [],
    };
    expect(toSpeech(result)).toBe('No bias detected.');
  });

  it('bias: counts biased claims (singular)', () => {
    const result: LensResult = {
      type: 'bias',
      claims: [
        { quote: 'q1', verdict: 'BIASED', direction: 'left', reason: 'r1' },
        { quote: 'q2', verdict: 'NEUTRAL', direction: '', reason: 'r2' },
      ],
    };
    expect(toSpeech(result)).toBe('1 biased claim detected.');
  });

  it('bias: counts biased claims (plural)', () => {
    const result: LensResult = {
      type: 'bias',
      claims: [
        { quote: 'q1', verdict: 'BIASED', direction: 'left', reason: 'r1' },
        { quote: 'q2', verdict: 'BIASED', direction: 'right', reason: 'r2' },
      ],
    };
    expect(toSpeech(result)).toBe('2 biased claims detected.');
  });

  it('trivia: returns first question text', () => {
    const result: LensResult = {
      type: 'trivia',
      claims: [
        { quote: 'q', question: 'What is the capital of France?', answer: 'Paris', description: 'd' },
      ],
    };
    expect(toSpeech(result)).toBe('Trivia: What is the capital of France?');
  });

  it('meeting-prep: 1 claim', () => {
    const result: LensResult = {
      type: 'meeting-prep',
      claims: [
        { kind: 'answer', text: 'Bring the report.', source: '', detail: '' },
      ],
    };
    expect(toSpeech(result)).toBe('1 meeting prep point.');
  });

  it('meeting-prep: plural claims', () => {
    const result: LensResult = {
      type: 'meeting-prep',
      claims: [
        { kind: 'answer', text: 'Point one.', source: '', detail: '' },
        { kind: 'answer', text: 'Point two.', source: '', detail: '' },
      ],
    };
    expect(toSpeech(result)).toBe('2 meeting prep points.');
  });

  it("devils-advocate: 1 claim", () => {
    const result: LensResult = {
      type: 'devils-advocate',
      claims: [
        { quote: 'q', counterpoint: 'cp', rationale: 'r' },
      ],
    };
    expect(toSpeech(result)).toBe("1 devil's advocate point.");
  });

  it('key-questions: returns first question', () => {
    const result: LensResult = {
      type: 'key-questions',
      claims: [
        { question: 'What is the budget?', context: 'ctx' },
        { question: 'Who is responsible?', context: 'ctx2' },
      ],
    };
    expect(toSpeech(result)).toBe('Key question: What is the budget?');
  });

  it('companion: returns first claim headline', () => {
    const result: LensResult = {
      type: 'companion',
      claims: [
        { quote: 'q', kind: 'fact', headline: 'Did you know that Rome was not built in a day?', detail: 'd' },
      ],
    };
    expect(toSpeech(result)).toBe('Did you know that Rome was not built in a day?');
  });

  it('game: reports score and total', () => {
    const result: LensResult = {
      type: 'game',
      preset: { id: 'p1', format: 'quiz-mc', topic: 'History', difficulty: 'medium', saveToHistory: false },
      questions: [
        { text: 'Q1?', options: ['A', 'B'], correctIndex: 0, reveal: 'r1' },
        { text: 'Q2?', options: ['A', 'B'], correctIndex: 1, reveal: 'r2' },
        { text: 'Q3?', options: ['A', 'B'], correctIndex: 0, reveal: 'r3' },
      ],
      answers: [0, 1, null],
      score: 2,
    };
    expect(toSpeech(result)).toBe('Game complete. Score: 2 of 3.');
  });
});
