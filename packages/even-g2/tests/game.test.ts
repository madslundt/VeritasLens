// tests/game.test.ts
//
// State-machine tests for the game runtime. The HUD layer and LLM client are
// stubbed — these tests assert the session transitions (loading → question →
// feedback → end), score tallies, Random-preset materialization, and the
// cancel path.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// SDK + bridge stubs — same shape as tests/hud.test.ts so importing modules
// that touch the bridge doesn't blow up at module-evaluation time.
vi.mock('@evenrealities/even_hub_sdk', async () => {
  class Bag { constructor(public payload: Record<string, unknown>) {} }
  return {
    CreateStartUpPageContainer: Bag,
    RebuildPageContainer: Bag,
    TextContainerProperty: Bag,
    TextContainerUpgrade: Bag,
    ListContainerProperty: Bag,
    ListItemContainerProperty: Bag,
    StartUpPageCreateResult: { success: 0 },
    OsEventTypeList: {
      CLICK_EVENT: 1,
      DOUBLE_CLICK_EVENT: 2,
      SCROLL_TOP_EVENT: 3,
      SCROLL_BOTTOM_EVENT: 4,
      FOREGROUND_EXIT_EVENT: 5,
      FOREGROUND_ENTER_EVENT: 6,
      SYSTEM_EXIT_EVENT: 7,
      ABNORMAL_EXIT_EVENT: 8,
    },
    DeviceStatus: class {},
  };
});

const { bridge, hudCalls, callGameMock } = vi.hoisted(() => ({
  bridge: {
    setLocalStorage: vi.fn(async () => true),
    getLocalStorage: vi.fn(async () => ''),
  },
  hudCalls: {
    picker: vi.fn(async (..._args: unknown[]) => undefined),
    loading: vi.fn(async (..._args: unknown[]) => undefined),
    question: vi.fn(async (..._args: unknown[]) => undefined),
    feedback: vi.fn(async (..._args: unknown[]) => undefined),
    end: vi.fn(async (..._args: unknown[]) => undefined),
  },
  callGameMock: vi.fn(async (_opts: { signal?: AbortSignal }) => ''),
}));

vi.mock('../src/runtime/bridge', () => ({
  getBridge: () => bridge,
}));

vi.mock('../src/runtime/hud', () => ({
  showGamesPickerPage: hudCalls.picker,
  showGameLoadingPage: hudCalls.loading,
  showGameQuestionPage: hudCalls.question,
  showGameFeedbackPage: hudCalls.feedback,
  showGameEndPage: hudCalls.end,
}));

vi.mock('@veritaslens/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@veritaslens/core')>();
  return { ...actual, callGame: callGameMock };
});

import {
  advance,
  cancelGame,
  currentGameSession,
  materializeRandomPreset,
  selectAnswer,
  startGame,
} from '../src/runtime/game';
import { GAME_LENGTH, RANDOM_GAME_PRESET_ID } from '@veritaslens/core';
import type { GamePreset } from '@veritaslens/core';

const quizPreset: GamePreset = {
  id: 'p1',
  format: 'quiz-mc',
  topic: 'World War II',
  difficulty: 'medium',
  saveToHistory: false,
};

function makeQuizPayload(): string {
  return JSON.stringify({
    chosenTopic: '',
    questions: Array.from({ length: GAME_LENGTH }, (_, i) => ({
      text: `Q${i + 1}`,
      options: ['A', 'B', 'C', 'D'],
      correctIndex: i % 4,
      reveal: 'Because.',
    })),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  callGameMock.mockReset();
  // Defensive: drop any leftover session from a previous test.
  await cancelGame().catch(() => undefined);
  hudCalls.picker.mockClear();
});

describe('materializeRandomPreset', () => {
  it('returns a concrete preset with a known format and Medium difficulty', () => {
    const p = materializeRandomPreset();
    expect(['quiz-mc', 'true-false', 'riddle']).toContain(p.format);
    expect(p.difficulty).toBe('medium');
    expect(p.saveToHistory).toBe(true);
    expect(p.id).toBe(RANDOM_GAME_PRESET_ID);
    expect(p.topic).toBe('');
  });
});

describe('startGame', () => {
  it('transitions loading → question on success and pushes the loading + question HUD pages', async () => {
    callGameMock.mockResolvedValueOnce(makeQuizPayload());
    await startGame(quizPreset);
    const session = currentGameSession();
    expect(session).not.toBeNull();
    expect(session!.phase).toBe('question');
    expect(session!.questions).toHaveLength(GAME_LENGTH);
    expect(session!.index).toBe(0);
    expect(hudCalls.loading).toHaveBeenCalledTimes(1);
    expect(hudCalls.question).toHaveBeenCalledTimes(1);
  });

  it('bounces back to the games-picker with an error message on parse failure', async () => {
    callGameMock.mockResolvedValueOnce('not-json');
    await startGame(quizPreset);
    expect(currentGameSession()).toBeNull();
    expect(hudCalls.picker).toHaveBeenCalledTimes(1);
    const lastCall = hudCalls.picker.mock.calls.at(-1) as unknown[] | undefined;
    expect(lastCall?.[1]).toMatchObject({ errorMessage: expect.any(String) });
  });

  it('folds chosenTopic from a Random response back into the live preset', async () => {
    callGameMock.mockResolvedValueOnce(JSON.stringify({
      chosenTopic: 'Marine biology',
      questions: Array.from({ length: GAME_LENGTH }, (_, i) => ({
        text: `Q${i + 1}`, options: ['A', 'B', 'C', 'D'], correctIndex: 0, reveal: '',
      })),
    }));
    await startGame({ ...quizPreset, id: RANDOM_GAME_PRESET_ID, topic: '' });
    expect(currentGameSession()!.preset.topic).toBe('Marine biology');
  });
});

describe('selectAnswer + advance', () => {
  beforeEach(async () => {
    callGameMock.mockResolvedValueOnce(makeQuizPayload());
    await startGame(quizPreset);
  });

  it('selectAnswer records the choice and moves to feedback', async () => {
    await selectAnswer(2);
    const session = currentGameSession();
    expect(session!.phase).toBe('feedback');
    expect(session!.answers[0]).toBe(2);
    expect(hudCalls.feedback).toHaveBeenCalledTimes(1);
  });

  it('advance from feedback returns to the next question', async () => {
    await selectAnswer(0);
    await advance();
    const session = currentGameSession();
    expect(session!.phase).toBe('question');
    expect(session!.index).toBe(1);
    expect(hudCalls.question).toHaveBeenCalledTimes(2); // initial + advance
  });

  it('full run transitions to phase end on the last advance', async () => {
    for (let i = 0; i < GAME_LENGTH; i++) {
      await selectAnswer(0);
      await advance();
    }
    const session = currentGameSession();
    expect(session!.phase).toBe('end');
    expect(hudCalls.end).toHaveBeenCalledTimes(1);
  });

  it('end-page tap clears the session and returns to the games-picker', async () => {
    for (let i = 0; i < GAME_LENGTH; i++) {
      await selectAnswer(0);
      await advance();
    }
    // hudCalls.picker counts: 0 so far (no error on success path); after one
    // more advance from 'end' we expect picker to be shown.
    await advance();
    expect(currentGameSession()).toBeNull();
    expect(hudCalls.picker).toHaveBeenCalledTimes(1);
  });
});

describe('cancelGame', () => {
  it('clears the session immediately and returns to the games-picker', async () => {
    callGameMock.mockResolvedValueOnce(makeQuizPayload());
    await startGame(quizPreset);
    await cancelGame();
    expect(currentGameSession()).toBeNull();
    expect(hudCalls.picker).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight callGame', async () => {
    let abortObserved = false;
    callGameMock.mockImplementationOnce((opts) => {
      return new Promise<string>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          abortObserved = true;
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        });
      });
    });
    const pending = startGame(quizPreset);
    // Let the call start.
    await new Promise((r) => setTimeout(r, 0));
    await cancelGame();
    await pending; // resolves once abort propagates
    expect(abortObserved).toBe(true);
    expect(currentGameSession()).toBeNull();
  });
});
