// tests/gameHistory.test.ts
import { describe, it, expect } from 'vitest';
import {
  MAX_RECENT_GAME_QUESTIONS,
  MAX_RECENT_GAME_QUESTIONS_CHARS,
  MAX_RECENT_RANDOM_TOPICS,
  extractRecentGameQuestions,
  extractRecentRandomTopics,
} from '../src/runtime/gameHistory';
import { RANDOM_GAME_PRESET_ID } from '../src/types';
import type { GamePreset, GameQuestion, HistoryEntry, LensResult } from '../src/types';

function makeGameQuestion(text: string): GameQuestion {
  return { text, options: ['a', 'b', 'c', 'd'], correctIndex: 0, reveal: '' };
}

function makeGameEntry(opts: {
  id?: string;
  format: 'quiz-mc' | 'true-false' | 'riddle';
  difficulty: 'easy' | 'medium' | 'hard';
  topic: string;
  questionTexts: string[];
  withTags?: boolean;
}): HistoryEntry {
  const preset: GamePreset = {
    id: opts.id ?? 'gp-x',
    format: opts.format,
    topic: opts.topic,
    difficulty: opts.difficulty,
    saveToHistory: true,
  };
  const result: LensResult = {
    type: 'game',
    preset,
    questions: opts.questionTexts.map(makeGameQuestion),
    answers: opts.questionTexts.map(() => 0),
    score: opts.questionTexts.length,
  };
  return {
    id: `e-${Math.random().toString(36).slice(2, 6)}`,
    sessionId: `s-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    lensId: 'game',
    lensName: 'Game',
    question: opts.topic,
    badge: `${opts.questionTexts.length}/${opts.questionTexts.length}`,
    quote: '',
    result,
    tags: opts.withTags === false
      ? undefined
      : [opts.format, opts.difficulty, opts.topic.toLowerCase()].filter(Boolean),
  };
}

const savedPreset: GamePreset = {
  id: 'gp-1',
  format: 'quiz-mc',
  topic: 'WWII',
  difficulty: 'medium',
  saveToHistory: true,
};

const randomPreset: GamePreset = {
  id: RANDOM_GAME_PRESET_ID,
  format: 'quiz-mc',
  topic: '',
  difficulty: 'medium',
  saveToHistory: true,
};

describe('extractRecentGameQuestions', () => {
  it('returns [] for empty history', () => {
    expect(extractRecentGameQuestions([], savedPreset)).toEqual([]);
  });

  it('returns the matching entry\'s question texts in original order, newest entry first', () => {
    const older = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'WWII',
      questionTexts: ['Old Q1', 'Old Q2'],
    });
    const newer = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'WWII',
      questionTexts: ['New Q1', 'New Q2'],
    });
    // sessionHistory pushes newest at END — mirror that.
    const out = extractRecentGameQuestions([older, newer], savedPreset);
    expect(out).toEqual(['New Q1', 'New Q2', 'Old Q1', 'Old Q2']);
  });

  it('skips entries whose lensId is not "game"', () => {
    const gameRow = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'WWII',
      questionTexts: ['Real game question'],
    });
    const factRow: HistoryEntry = {
      ...gameRow,
      id: 'fact-1',
      lensId: 'fact-check',
      lensName: 'Fact Check',
      result: { type: 'fact-check', claims: [] },
    };
    expect(extractRecentGameQuestions([factRow, gameRow], savedPreset))
      .toEqual(['Real game question']);
  });

  it('saved preset: skips game entries with a different topic', () => {
    const wrongTopic = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'Roman Empire',
      questionTexts: ['Roman Q'],
    });
    const rightTopic = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'WWII',
      questionTexts: ['WWII Q'],
    });
    expect(extractRecentGameQuestions([wrongTopic, rightTopic], savedPreset))
      .toEqual(['WWII Q']);
  });

  it('saved preset: also skips entries with a mismatched difficulty or format', () => {
    const wrongDifficulty = makeGameEntry({
      format: 'quiz-mc', difficulty: 'easy', topic: 'WWII',
      questionTexts: ['Easy Q'],
    });
    const wrongFormat = makeGameEntry({
      format: 'true-false', difficulty: 'medium', topic: 'WWII',
      questionTexts: ['TF Q'],
    });
    const right = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'WWII',
      questionTexts: ['Right Q'],
    });
    expect(extractRecentGameQuestions([wrongDifficulty, wrongFormat, right], savedPreset))
      .toEqual(['Right Q']);
  });

  it('Random preset: pulls cross-topic matches for same format+difficulty', () => {
    const entries = [
      makeGameEntry({ format: 'quiz-mc', difficulty: 'medium', topic: 'WWII', questionTexts: ['Q from WWII'] }),
      makeGameEntry({ format: 'quiz-mc', difficulty: 'medium', topic: 'Cinema', questionTexts: ['Q from Cinema'] }),
      // Should be skipped — different difficulty.
      makeGameEntry({ format: 'quiz-mc', difficulty: 'hard', topic: 'Cinema', questionTexts: ['Hard Q'] }),
    ];
    const out = extractRecentGameQuestions(entries, randomPreset);
    expect(out).toContain('Q from WWII');
    expect(out).toContain('Q from Cinema');
    expect(out).not.toContain('Hard Q');
  });

  it('dedupes verbatim duplicates across prior entries', () => {
    const a = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'WWII',
      questionTexts: ['Dup Q', 'Unique A'],
    });
    const b = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'WWII',
      questionTexts: ['Dup Q', 'Unique B'],
    });
    const out = extractRecentGameQuestions([a, b], savedPreset);
    // Newest first → 'Dup Q' comes from `b`, 'Unique B' too, then from `a`
    // we only add 'Unique A' since 'Dup Q' is already there.
    expect(out).toEqual(['Dup Q', 'Unique B', 'Unique A']);
  });

  it('honors the count cap', () => {
    // 30 questions; cap at 5.
    const entry = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'WWII',
      questionTexts: Array.from({ length: 30 }, (_, i) => `Q${i}`),
    });
    const out = extractRecentGameQuestions([entry], savedPreset, 5);
    expect(out).toHaveLength(5);
    expect(out).toEqual(['Q0', 'Q1', 'Q2', 'Q3', 'Q4']);
  });

  it('honors the char cap by trimming oversized lists', () => {
    // Distinct texts so the dedup pass doesn't collapse them. Each is 200
    // chars; with the +1 separator the projected cost is 201/question, so
    // a 500-char cap admits exactly 2 (2 * 201 = 402; a 3rd would push
    // to 603 > 500).
    const entry = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'WWII',
      questionTexts: Array.from({ length: 5 }, (_, i) => `${i}`.padEnd(200, 'x')),
    });
    const out = extractRecentGameQuestions([entry], savedPreset, 100, 500);
    expect(out).toHaveLength(2);
  });

  it('legacy entries without `tags` are skipped without throwing', () => {
    const taggedRight = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'WWII',
      questionTexts: ['Tagged Q'],
    });
    const legacy = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'WWII',
      questionTexts: ['Legacy Q'],
      withTags: false,
    });
    expect(extractRecentGameQuestions([legacy, taggedRight], savedPreset))
      .toEqual(['Tagged Q']);
  });

  it('exports sane budget constants', () => {
    expect(MAX_RECENT_GAME_QUESTIONS).toBeGreaterThan(0);
    expect(MAX_RECENT_GAME_QUESTIONS_CHARS).toBeGreaterThan(0);
  });

  it('skips trivially empty question texts', () => {
    const entry = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'WWII',
      questionTexts: ['   ', 'Real Q'],
    });
    expect(extractRecentGameQuestions([entry], savedPreset)).toEqual(['Real Q']);
  });
});

describe('extractRecentRandomTopics', () => {
  it('returns [] for a saved preset (only Random has chosen-topic history to dedup)', () => {
    const entry = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'Space exploration',
      questionTexts: ['Q'],
    });
    expect(extractRecentRandomTopics([entry], savedPreset)).toEqual([]);
  });

  it('returns the past Random topics newest-first for Random preset matching format+difficulty', () => {
    const older = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'Renaissance art',
      questionTexts: ['Q1'],
    });
    const newer = makeGameEntry({
      format: 'quiz-mc', difficulty: 'medium', topic: 'Space exploration',
      questionTexts: ['Q2'],
    });
    expect(extractRecentRandomTopics([older, newer], randomPreset))
      .toEqual(['Space exploration', 'Renaissance art']);
  });

  it('case-insensitive dedup so "Space" / "SPACE" / "space" count once', () => {
    const a = makeGameEntry({ format: 'quiz-mc', difficulty: 'medium', topic: 'Space', questionTexts: ['Q'] });
    const b = makeGameEntry({ format: 'quiz-mc', difficulty: 'medium', topic: 'SPACE', questionTexts: ['Q'] });
    const c = makeGameEntry({ format: 'quiz-mc', difficulty: 'medium', topic: 'space', questionTexts: ['Q'] });
    const out = extractRecentRandomTopics([a, b, c], randomPreset);
    expect(out).toHaveLength(1);
  });

  it('skips entries whose format or difficulty does not match', () => {
    const wrongDiff = makeGameEntry({ format: 'quiz-mc', difficulty: 'hard', topic: 'Sports', questionTexts: ['Q'] });
    const wrongFmt = makeGameEntry({ format: 'true-false', difficulty: 'medium', topic: 'Cinema', questionTexts: ['Q'] });
    const right = makeGameEntry({ format: 'quiz-mc', difficulty: 'medium', topic: 'Music', questionTexts: ['Q'] });
    expect(extractRecentRandomTopics([wrongDiff, wrongFmt, right], randomPreset)).toEqual(['Music']);
  });

  it('honors the count cap', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeGameEntry({ format: 'quiz-mc', difficulty: 'medium', topic: `Topic ${i}`, questionTexts: ['Q'] }),
    );
    const out = extractRecentRandomTopics(entries, randomPreset, 3);
    expect(out).toHaveLength(3);
  });

  it('exports a sane MAX_RECENT_RANDOM_TOPICS constant', () => {
    expect(MAX_RECENT_RANDOM_TOPICS).toBeGreaterThan(0);
  });
});
