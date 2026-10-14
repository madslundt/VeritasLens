// Exercises the throttled streaming-heading write path.
//
// The HUD's reason container is updated by `setLensStreamingHeading` on a
// 150 ms throttle so the bridge isn't bombarded with per-chunk writes that
// strobe on the G2 hardware. These tests verify:
//   1. First partial fires immediately (perceived latency stays low).
//   2. A flurry of partials inside the throttle window coalesce into one
//      trailing flush.
//   3. `clearLensStreamingHeading` cancels the pending flush so a stale
//      partial can't overwrite the final result.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@evenrealities/even_hub_sdk', async () => {
  class Bag {
    constructor(public payload: Record<string, unknown>) {}
  }
  return {
    CreateStartUpPageContainer: Bag,
    RebuildPageContainer: Bag,
    TextContainerProperty: Bag,
    TextContainerUpgrade: Bag,
    ListContainerProperty: Bag,
    ListItemContainerProperty: Bag,
    StartUpPageCreateResult: { success: 0 } as const,
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

const bridge = {
  createStartUpPageContainer: vi.fn(async () => 0),
  rebuildPageContainer: vi.fn(async () => true),
  textContainerUpgrade: vi.fn(async () => true),
  audioControl: vi.fn(async () => true),
  setLocalStorage: vi.fn(async () => true),
  getLocalStorage: vi.fn(async () => ''),
  onEvenHubEvent: vi.fn(() => () => undefined),
};

vi.mock('../src/runtime/bridge', () => ({
  getBridge: () => bridge,
}));

import {
  _resetHudBootstrapForTesting,
  bootstrapHud,
  CONTAINER,
  clearLensStreamingHeading,
  discardLensStreamingHeading,
  getLensStreamingState,
  setLensStreamingHeading,
  setActiveLayout,
  setLensResult,
  setStatus,
  scrollActiveReason,
  getActiveLayout,
  showActivePage,
} from '../src/runtime/hud';
import { getPersona } from '@veritaslens/core';

interface UpgradeRequest {
  payload: { containerID: number; containerName: string; content: string };
}

function reasonContentCalls(): string[] {
  // The mocked bridge is typed loosely; vi.fn's argument tuple defaults to []
  // even though `textContainerUpgrade` is invoked with a single TextContainerUpgrade
  // arg. Cast through `unknown` to read the actual call payload.
  const allCalls = bridge.textContainerUpgrade.mock.calls as unknown as UpgradeRequest[][];
  return allCalls
    .map((c) => c[0])
    .filter((r) => r.payload.containerID === CONTAINER.reason)
    .map((r) => r.payload.content);
}

describe('setLensStreamingHeading throttle', () => {
  beforeEach(async () => {
    _resetHudBootstrapForTesting();
    vi.clearAllMocks();
    bridge.createStartUpPageContainer.mockResolvedValue(0);
    bridge.rebuildPageContainer.mockResolvedValue(true);
    bridge.textContainerUpgrade.mockResolvedValue(true);
    // Prime the HUD bootstrap then enter the active page so streaming writes
    // are not dropped by the `currentPage !== 'active'` guard.
    await bootstrapHud('picker');
    const persona = getPersona('fact-checker')!;
    await showActivePage(persona);
    // Drop the writes the active-page rebuild emitted so the assertions count
    // only streaming writes.
    bridge.textContainerUpgrade.mockClear();
    clearLensStreamingHeading();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearLensStreamingHeading();
    vi.useRealTimers();
  });

  it('writes the first partial immediately to the reason container', async () => {
    setLensStreamingHeading('Pa');
    // Drain the indicator-clear and answer writes without advancing the
    // throttle window.
    await vi.advanceTimersByTimeAsync(0);
    const calls = reasonContentCalls();
    expect(calls).toEqual(['Pa']);
    expect(getLensStreamingState().active).toBe(true);
  });

  it('coalesces a burst of partials into one trailing flush', async () => {
    setLensStreamingHeading('P');
    setLensStreamingHeading('Pa');
    setLensStreamingHeading('Par');
    setLensStreamingHeading('Pari');
    setLensStreamingHeading('Paris');
    await vi.advanceTimersByTimeAsync(0);
    let calls = reasonContentCalls();
    // First call fires immediately with whatever was queued at that moment.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('P');

    await vi.advanceTimersByTimeAsync(150);
    await Promise.resolve();
    calls = reasonContentCalls();
    expect(calls).toHaveLength(2);
    // Trailing flush carries the most recent queued value, not anything
    // in between.
    expect(calls[1]).toBe('Paris');
  });

  it('skips the trailing flush when the queued value equals the last write', async () => {
    setLensStreamingHeading('Paris');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(150);
    setLensStreamingHeading('Paris');
    await vi.advanceTimersByTimeAsync(500);
    expect(reasonContentCalls()).toEqual(['Paris']);
  });

  it('clearLensStreamingHeading cancels a pending trailing flush', async () => {
    setLensStreamingHeading('Pa');
    setLensStreamingHeading('Paris');
    await vi.advanceTimersByTimeAsync(0);
    clearLensStreamingHeading();
    await vi.advanceTimersByTimeAsync(500);
    const calls = reasonContentCalls();
    expect(calls).toEqual(['Pa']);
    expect(getLensStreamingState().active).toBe(false);
  });

  it('creates the full-screen answer body before streaming in discreet mode', async () => {
    setActiveLayout('discreet-minimal');
    await showActivePage(getPersona('translation')!);
    bridge.rebuildPageContainer.mockClear();
    setLensStreamingHeading('Hello from the translated answer');
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce();
    const call = bridge.rebuildPageContainer.mock.calls[0] as unknown as [{ payload: { textObject: Array<{ payload: Record<string, unknown> }> } }];
    const body = call[0].payload.textObject.find((t) => t.payload.containerName === 'vl-reason')!.payload;
    expect(body).toMatchObject({ xPosition: 0, yPosition: 0, width: 576, height: 288, isEventCapture: 1 });
    expect(reasonContentCalls()).toEqual(['Hello from the translated answer']);
  });

  it('waits for a slow layout rebuild before committing the final answer and drops the stale partial', async () => {
    setActiveLayout('discreet-minimal');
    await showActivePage(getPersona('eli5')!);
    let finishRebuild!: (ok: boolean) => void;
    bridge.rebuildPageContainer.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishRebuild = resolve; }));
    setLensStreamingHeading('Old partial');
    await vi.advanceTimersByTimeAsync(0);
    clearLensStreamingHeading();
    const finalWrite = setLensResult({ type: 'eli5', claims: [{ quote: '', explanation: 'Final answer' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(reasonContentCalls()).toEqual([]);
    finishRebuild(true);
    await finalWrite;
    expect(reasonContentCalls()).toEqual(['1/1 · Final answer']);
  });

  it.each(['baseline', 'discreet-minimal'] as const)('discards an unfinished %s heading and preserves completed answers for swipe recall', async (layout) => {
    setActiveLayout(layout);
    await showActivePage(getPersona('trivia')!);
    await setLensResult({ type: 'eli5', claims: [{ quote: '', explanation: 'Completed answer' }] });
    const { blankActiveForThinking } = await import('../src/runtime/hud');
    await blankActiveForThinking();
    setLensStreamingHeading('Unfinished answer');
    await vi.advanceTimersByTimeAsync(0);
    expect(reasonContentCalls().at(-1)).toBe('Unfinished answer');

    // Completion cancels queued writes before parsing. A parse error must
    // still be able to remove the preview after that synchronous clear.
    clearLensStreamingHeading();
    await discardLensStreamingHeading();
    expect(getActiveLayout()).toBe(layout);
    await setStatus('error');
    const writes = bridge.textContainerUpgrade.mock.calls as unknown as UpgradeRequest[][];
    expect(writes.filter(([r]) => r.payload.containerName === 'vl-status').at(-1)?.[0].payload.content).toBe('ERR');
    expect(await scrollActiveReason(-1)).toBe('revealed');
    expect(reasonContentCalls().at(-1)).toBe('1/1 · Completed answer');
  });
});
