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
  getLensStreamingState,
  setLensStreamingHeading,
  showActivePage,
} from '../src/runtime/hud';
import { getPersona } from '../src/personas';

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
    // First write is a fire-and-forget upgradeText — drain microtasks.
    await Promise.resolve();
    await Promise.resolve();
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
    await Promise.resolve();
    await Promise.resolve();
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
    await Promise.resolve();
    clearLensStreamingHeading();
    await vi.advanceTimersByTimeAsync(500);
    const calls = reasonContentCalls();
    expect(calls).toEqual(['Pa']);
    expect(getLensStreamingState().active).toBe(false);
  });
});
