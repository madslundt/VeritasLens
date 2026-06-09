// tests/personas-game.test.ts
//
// Schema-shape tests for the game-mode persona parser. Each format imposes a
// distinct constraint on the `options` array length and `correctIndex` range;
// these tests lock in those constraints so a malformed LLM response is
// rejected at the runtime boundary rather than silently producing a broken
// session.

import { describe, it, expect } from 'vitest';
import {
  AVOID_LIST_HEADER,
  GAME_RESPONSE_SCHEMA,
  buildGamePrompt,
  buildGameResult,
  parseGameResponse,
  shuffleQuizOptions,
} from '../src/personas/game';
import { GAME_LENGTH, type GameFormat, type GamePreset, type GameQuestion } from '../src/types';

function makeQuizQuestion(i: number, correct: number): unknown {
  return {
    text: `Q${i + 1}`,
    options: ['A', 'B', 'C', 'D'],
    correctIndex: correct,
    reveal: `Because ${correct}`,
  };
}

function makeTrueFalseQuestion(i: number, correct: 0 | 1): unknown {
  return {
    text: `Statement ${i + 1}`,
    options: ['True', 'False'],
    correctIndex: correct,
    reveal: 'Reason',
  };
}

function makeRiddleQuestion(i: number): unknown {
  return {
    text: `Riddle ${i + 1}?`,
    options: [],
    correctIndex: -1,
    reveal: 'The answer.',
  };
}

function makeResponse(questions: unknown[], chosenTopic = ''): string {
  return JSON.stringify({ chosenTopic, questions });
}

describe('parseGameResponse — quiz-mc', () => {
  it('accepts a well-formed 10-question MC payload', () => {
    const text = makeResponse(Array.from({ length: GAME_LENGTH }, (_, i) => makeQuizQuestion(i, i % 4)));
    const parsed = parseGameResponse(text, 'quiz-mc');
    expect(parsed.questions).toHaveLength(GAME_LENGTH);
    expect(parsed.questions[0]!.options).toHaveLength(4);
    expect(parsed.questions[0]!.correctIndex).toBe(0);
    expect(parsed.chosenTopic).toBe('');
  });

  it('rejects an MC payload with the wrong number of options', () => {
    const bad = { ...(makeQuizQuestion(0, 0) as Record<string, unknown>), options: ['only', 'three', 'opts'] };
    const text = makeResponse([bad, ...Array.from({ length: GAME_LENGTH - 1 }, (_, i) => makeQuizQuestion(i + 1, 0))]);
    expect(() => parseGameResponse(text, 'quiz-mc')).toThrow(/options.*expected 4/);
  });

  it('rejects an MC payload with correctIndex out of range', () => {
    const bad = { ...(makeQuizQuestion(0, 0) as Record<string, unknown>), correctIndex: 7 };
    const text = makeResponse([bad, ...Array.from({ length: GAME_LENGTH - 1 }, (_, i) => makeQuizQuestion(i + 1, 0))]);
    expect(() => parseGameResponse(text, 'quiz-mc')).toThrow(/correctIndex/);
  });

  it('rejects a payload with fewer than 10 questions', () => {
    const text = makeResponse(Array.from({ length: 5 }, (_, i) => makeQuizQuestion(i, 0)));
    expect(() => parseGameResponse(text, 'quiz-mc')).toThrow(/expected 10/);
  });
});

describe('parseGameResponse — true-false', () => {
  it('accepts a 10-statement T/F payload with 2 options each', () => {
    const text = makeResponse(Array.from({ length: GAME_LENGTH }, (_, i) => makeTrueFalseQuestion(i, (i % 2) as 0 | 1)));
    const parsed = parseGameResponse(text, 'true-false');
    expect(parsed.questions[0]!.options).toEqual(['True', 'False']);
    expect(parsed.questions[0]!.correctIndex).toBe(0);
  });

  it('rejects a T/F payload with 4 options', () => {
    const bad = { ...(makeTrueFalseQuestion(0, 0) as Record<string, unknown>), options: ['T', 'F', 'Maybe', 'IDK'] };
    const text = makeResponse([bad, ...Array.from({ length: GAME_LENGTH - 1 }, (_, i) => makeTrueFalseQuestion(i + 1, 0))]);
    expect(() => parseGameResponse(text, 'true-false')).toThrow(/options.*expected 2/);
  });
});

describe('parseGameResponse — riddle', () => {
  it('accepts a 10-riddle payload with empty option arrays', () => {
    const text = makeResponse(Array.from({ length: GAME_LENGTH }, (_, i) => makeRiddleQuestion(i)));
    const parsed = parseGameResponse(text, 'riddle');
    expect(parsed.questions).toHaveLength(GAME_LENGTH);
    expect(parsed.questions[0]!.options).toEqual([]);
    expect(parsed.questions[0]!.correctIndex).toBeNull();
  });

  it('rejects a riddle payload that includes options', () => {
    const bad = { ...(makeRiddleQuestion(0) as Record<string, unknown>), options: ['A', 'B'] };
    const text = makeResponse([bad, ...Array.from({ length: GAME_LENGTH - 1 }, (_, i) => makeRiddleQuestion(i + 1))]);
    expect(() => parseGameResponse(text, 'riddle')).toThrow(/expected 0/);
  });
});

describe('parseGameResponse — Random topic surface', () => {
  it('returns the chosenTopic when present', () => {
    const text = makeResponse(
      Array.from({ length: GAME_LENGTH }, (_, i) => makeQuizQuestion(i, 0)),
      'World War II',
    );
    expect(parseGameResponse(text, 'quiz-mc').chosenTopic).toBe('World War II');
  });
});

describe('parseGameResponse — fenced JSON', () => {
  it('parses a payload wrapped in surrounding prose', () => {
    const inner = makeResponse(Array.from({ length: GAME_LENGTH }, (_, i) => makeQuizQuestion(i, 0)));
    const wrapped = `Sure, here's your quiz: ${inner} Have fun!`;
    expect(parseGameResponse(wrapped, 'quiz-mc').questions).toHaveLength(GAME_LENGTH);
  });

  it('throws when no JSON object is present', () => {
    expect(() => parseGameResponse('no json here', 'quiz-mc')).toThrow();
  });
});

describe('buildGameResult', () => {
  const preset: GamePreset = {
    id: 'p1',
    format: 'quiz-mc',
    topic: 'History',
    difficulty: 'medium',
    saveToHistory: true,
  };
  const questions: GameQuestion[] = [
    { text: 'q1', options: ['a', 'b', 'c', 'd'], correctIndex: 0, reveal: '' },
    { text: 'q2', options: ['a', 'b', 'c', 'd'], correctIndex: 1, reveal: '' },
    { text: 'q3', options: ['a', 'b', 'c', 'd'], correctIndex: 2, reveal: '' },
  ];

  it('counts a perfect run as N/N', () => {
    const result = buildGameResult(preset, questions, [0, 1, 2]);
    expect(result.type).toBe('game');
    if (result.type !== 'game') return;
    expect(result.score).toBe(3);
  });

  it('counts a mixed run by matching answer index to correctIndex', () => {
    const result = buildGameResult(preset, questions, [0, 3, 2]);
    if (result.type !== 'game') return;
    expect(result.score).toBe(2);
  });

  it('counts null answers (skipped) as wrong for scored formats', () => {
    const result = buildGameResult(preset, questions, [0, null, null]);
    if (result.type !== 'game') return;
    expect(result.score).toBe(1);
  });

  it('returns score 0 for an all-riddle session (unscored)', () => {
    const riddle: GameQuestion[] = [
      { text: 'r1', options: [], correctIndex: null, reveal: 'a' },
      { text: 'r2', options: [], correctIndex: null, reveal: 'b' },
    ];
    const result = buildGameResult({ ...preset, format: 'riddle' }, riddle, [null, null]);
    if (result.type !== 'game') return;
    expect(result.score).toBe(0);
  });
});

describe('buildGamePrompt', () => {
  const formats: GameFormat[] = ['quiz-mc', 'true-false', 'riddle'];

  it('embeds the user-supplied topic verbatim', () => {
    for (const fmt of formats) {
      const prompt = buildGamePrompt(fmt, 'World War II', 'medium', 'en');
      expect(prompt).toContain('World War II');
    }
  });

  it('asks the model to pick a topic when topic is empty (Random)', () => {
    const prompt = buildGamePrompt('quiz-mc', '', 'medium', 'en');
    expect(prompt).toMatch(/pick.*topic/i);
    expect(prompt).toContain('chosenTopic');
  });

  it('includes the per-difficulty directive', () => {
    expect(buildGamePrompt('quiz-mc', 'X', 'easy', 'en')).toMatch(/EASY/);
    expect(buildGamePrompt('quiz-mc', 'X', 'medium', 'en')).toMatch(/MEDIUM/);
    expect(buildGamePrompt('quiz-mc', 'X', 'hard', 'en')).toMatch(/HARD/);
  });

  it('asks for exactly GAME_LENGTH questions', () => {
    const prompt = buildGamePrompt('quiz-mc', 'X', 'medium', 'en');
    expect(prompt).toContain(String(GAME_LENGTH));
  });
});

describe('GAME_RESPONSE_SCHEMA', () => {
  it('locks the per-question length to GAME_LENGTH at both bounds', () => {
    const items = GAME_RESPONSE_SCHEMA.properties.questions;
    expect(items.minItems).toBe(GAME_LENGTH);
    expect(items.maxItems).toBe(GAME_LENGTH);
  });

  it('marks the top-level questions field as required', () => {
    expect(GAME_RESPONSE_SCHEMA.required).toContain('questions');
  });
});

describe('shuffleQuizOptions', () => {
  /** Deterministic "rng" that walks through a fixed array, looping if needed.
   *  Lets each test pin the shuffle outcome without depending on Math.random. */
  function fixedRng(values: number[]): () => number {
    let i = 0;
    return () => values[i++ % values.length]!;
  }

  it('reorders 4-option quiz items and remaps correctIndex to the same answer text', () => {
    const q: GameQuestion = {
      text: 'Q',
      options: ['A', 'B', 'C', 'D'],
      correctIndex: 0, // correct = 'A'
      reveal: '',
    };
    // Fisher-Yates loops i=3..1; rng values pick j each iteration. With
    // 0.99/0/0 we force swaps so the order ends up non-trivial.
    const [shuffled] = shuffleQuizOptions([q], fixedRng([0.99, 0.0, 0.0]));
    expect(shuffled!.options).toHaveLength(4);
    // Same set of options, same correct answer text — only positions changed.
    expect([...shuffled!.options].sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(shuffled!.options[shuffled!.correctIndex!]).toBe('A');
  });

  it('leaves the 2-option true-false case untouched (positional semantics)', () => {
    const q: GameQuestion = {
      text: 'S',
      options: ['True', 'False'],
      correctIndex: 1,
      reveal: '',
    };
    const [shuffled] = shuffleQuizOptions([q], fixedRng([0.99]));
    expect(shuffled!.options).toEqual(['True', 'False']);
    expect(shuffled!.correctIndex).toBe(1);
  });

  it('leaves riddles untouched (no options, correctIndex null)', () => {
    const q: GameQuestion = {
      text: 'R',
      options: [],
      correctIndex: null,
      reveal: 'ans',
    };
    const [shuffled] = shuffleQuizOptions([q], fixedRng([0.5]));
    expect(shuffled).toEqual(q);
  });

  it('maps every original correctIndex slot to its post-shuffle home across a 10-question set', () => {
    // Build 10 questions with correctIndex 0..3 cycling; verify each one's
    // post-shuffle options[correctIndex] still equals the original
    // options[origCorrect]. Doubles as a regression guard for any future
    // off-by-one in the remap.
    const questions: GameQuestion[] = Array.from({ length: 10 }, (_, i) => ({
      text: `Q${i}`,
      options: [`A${i}`, `B${i}`, `C${i}`, `D${i}`],
      correctIndex: i % 4,
      reveal: '',
    }));
    const out = shuffleQuizOptions(questions);
    for (let i = 0; i < questions.length; i++) {
      const before = questions[i]!;
      const after = out[i]!;
      expect(after.options).toHaveLength(4);
      expect([...after.options].sort()).toEqual([...before.options].sort());
      expect(after.options[after.correctIndex!]).toBe(before.options[before.correctIndex!]);
    }
  });
});

describe('buildGamePrompt avoid-list', () => {
  it('emits no AVOID block when recentQuestions is omitted', () => {
    const prompt = buildGamePrompt('quiz-mc', 'WWII', 'medium', 'en');
    expect(prompt).not.toContain('AVOID');
    // COMMON_OUTPUT_RULES still present.
    expect(prompt).toContain('Do not repeat the same question');
  });

  it('emits no AVOID block when recentQuestions is empty', () => {
    const prompt = buildGamePrompt('quiz-mc', 'WWII', 'medium', 'en', []);
    expect(prompt).not.toContain('AVOID');
  });

  it('splices an AVOID block with bulleted entries on quiz-mc when recentQuestions is non-empty', () => {
    const prompt = buildGamePrompt('quiz-mc', 'WWII', 'medium', 'en', [
      'Who led the Normandy landings?',
      'When did Pearl Harbor happen?',
    ]);
    expect(prompt).toContain(AVOID_LIST_HEADER);
    expect(prompt).toContain('- Who led the Normandy landings?');
    expect(prompt).toContain('- When did Pearl Harbor happen?');
    // Avoid block lives after COMMON_OUTPUT_RULES and before the language
    // directive — assert ordering so a future refactor can't accidentally
    // move it ahead of the rules and de-prioritise it.
    const rulesIdx = prompt.indexOf('Do not repeat the same question');
    const avoidIdx = prompt.indexOf(AVOID_LIST_HEADER);
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(avoidIdx).toBeGreaterThan(rulesIdx);
  });

  it('splices the same AVOID block into the true-false prompt', () => {
    const prompt = buildGamePrompt('true-false', 'physics', 'easy', 'en', ['Light is faster than sound.']);
    expect(prompt).toContain(AVOID_LIST_HEADER);
    expect(prompt).toContain('- Light is faster than sound.');
  });

  it('splices the same AVOID block into the riddle prompt', () => {
    const prompt = buildGamePrompt('riddle', 'classic', 'medium', 'en', ['What has hands but cannot clap?']);
    expect(prompt).toContain(AVOID_LIST_HEADER);
    expect(prompt).toContain('- What has hands but cannot clap?');
  });
});
