import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import type { CachedLocation } from '@veritaslens/core';

const mocks = vi.hoisted(() => ({
  game: vi.fn(),
  probe: vi.fn(),
  listener: null as ((event: EvenHubEvent) => void) | null,
  rebuilds: [] as Array<{ textObject: Array<{ containerName: string; content: string }>; listObject: unknown[] }>,
}));

vi.mock('@veritaslens/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@veritaslens/core')>(),
  callGame: mocks.game,
  warmupVAD: vi.fn(async () => {}),
}));
vi.mock('../src/runtime/location', () => ({
  probeAndCacheLocation: mocks.probe,
  kickOffLocationRefresh: vi.fn(),
  isLocationFresh: () => true,
}));
vi.mock('../src/runtime/bridge', () => ({
  getBridge: () => ({
    createStartUpPageContainer: vi.fn(async () => 0),
    rebuildPageContainer: vi.fn(async (page) => { mocks.rebuilds.push(page); return true; }),
    textContainerUpgrade: vi.fn(async () => true),
    audioControl: vi.fn(async () => true),
    setLocalStorage: vi.fn(async () => true),
    getLocalStorage: vi.fn(async () => ''),
    onEvenHubEvent: (listener: (event: EvenHubEvent) => void) => {
      mocks.listener = listener;
      return () => { mocks.listener = null; };
    },
  }),
}));

import { startHudRuntime, stopHudRuntime } from '../src/runtime/lifecycle';
import { _resetHudBootstrapForTesting, currentHudPage, pickerEntryAtIndex } from '../src/runtime/hud';
import { loadSettings, saveGeminiKey, saveLocationEnabled } from '../src/state/store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function drain() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
function tap(index: number) {
  mocks.listener!({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: index } } as EvenHubEvent);
}
function doubleTap() {
  mocks.listener!({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } } as EvenHubEvent);
}
const location: CachedLocation = { latitude: 55.67, longitude: 12.56, city: 'Copenhagen', country: 'Denmark', countryCode: 'DK', source: 'navigator', resolvedAt: Date.now() };

describe('Near me game through the gesture pipeline', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mocks.rebuilds.length = 0;
    await loadSettings(async () => '');
    await saveGeminiKey(async () => true, 'test-gemini-key');
    await saveLocationEnabled(async () => true, true);
    _resetHudBootstrapForTesting();
    await startHudRuntime();
    let index = 0;
    while (pickerEntryAtIndex(index).kind !== 'games') index++;
    tap(index);
    await drain();
    expect(currentHudPage()).toBe('games-picker');
    mocks.rebuilds.length = 0;
  });
  afterEach(async () => { await stopHudRuntime(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('uses the game loading screen while locating, then generates the local game', async () => {
    const fix = deferred<CachedLocation | null>();
    const generation = deferred<string>();
    mocks.probe.mockReturnValueOnce(fix.promise);
    mocks.game.mockReturnValueOnce(generation.promise);
    tap(2);
    await drain();
    expect(currentHudPage()).toBe('game-loading');
    expect(mocks.rebuilds.at(-1)?.textObject.some((t) => t.content === 'Locating…')).toBe(true);
    expect(mocks.game).not.toHaveBeenCalled();
    fix.resolve(location);
    await drain();
    expect(currentHudPage()).toBe('game-loading');
    expect(mocks.game).toHaveBeenCalledOnce();
    expect(mocks.game.mock.calls[0]![0].prompt).toContain('Copenhagen');
    generation.resolve(JSON.stringify({ questions: Array.from({ length: 10 }, () => ({
      text: 'Question', options: ['A', 'B', 'C', 'D'], correctIndex: 0, reveal: 'Explanation',
    })) }));
    await drain();
  });

  it('cancels locating and does not start a game when the fix arrives late', async () => {
    const fix = deferred<CachedLocation | null>();
    mocks.probe.mockReturnValueOnce(fix.promise);
    tap(2);
    await drain();
    doubleTap();
    await drain();
    expect(currentHudPage()).toBe('games-picker');
    fix.resolve(location);
    await drain();
    expect(mocks.game).not.toHaveBeenCalled();
    expect(currentHudPage()).toBe('games-picker');
  });

  it('stops locating during runtime shutdown without starting a late game', async () => {
    const fix = deferred<CachedLocation | null>();
    mocks.probe.mockReturnValueOnce(fix.promise);
    tap(2);
    await drain();
    await stopHudRuntime();
    fix.resolve(location);
    await drain();
    expect(mocks.game).not.toHaveBeenCalled();
  });

  it('keeps the loading screen during retries and returns to the picker when no fix is available', async () => {
    vi.useFakeTimers();
    mocks.probe.mockResolvedValue(null);
    tap(2);
    await drain();
    await vi.advanceTimersByTimeAsync(7500);
    expect(currentHudPage()).toBe('game-loading');
    expect(mocks.rebuilds).toHaveLength(1);
    expect(mocks.game).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(currentHudPage()).toBe('games-picker');
    expect(mocks.rebuilds.at(-1)?.textObject.some((t) => t.content === 'Could not get your location — try again')).toBe(true);
  });
});
