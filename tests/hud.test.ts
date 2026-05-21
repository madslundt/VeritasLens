// tests/hud.test.ts
//
// Behaviour-lock tests for src/runtime/hud.ts.
// HUD code talks to the SDK via getBridge(); we stub the bridge so the tests
// stay in-process. The session-state regression at the bottom is `.skip`-ed
// until Pass 1 exposes resetHudSessionState() (currently named
// _resetHudBootstrapForTesting).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The SDK ships ES classes whose constructors we instantiate from hud.ts.
// They serialize fine when we just stash the args; replace with thin stubs.
vi.mock('@evenrealities/even_hub_sdk', async () => {
  const StartUpPageCreateResult = { success: 0 } as const;
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
    StartUpPageCreateResult,
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

// Bridge stub — every page op returns success.
const bridge = {
  createStartUpPageContainer: vi.fn(async () => 0), // success
  rebuildPageContainer: vi.fn(async () => true),
  textContainerUpgrade: vi.fn(async () => true),
  audioControl: vi.fn(async () => true),
  setLocalStorage: vi.fn(async () => true),
  getLocalStorage: vi.fn(async () => ''),
  onEvenHubEvent: vi.fn(() => () => {}),
};

vi.mock('../src/runtime/bridge', () => ({
  getBridge: () => bridge,
}));

import {
  _resetHudBootstrapForTesting,
  bootstrapHud,
  currentHudPage,
  hasPendingActiveResult,
  isActiveHidden,
  markActiveHidden,
  MENU_OPTIONS,
  menuOptionAtIndex,
  personaAtIndex,
  resetHudSessionState,
  scrollActiveReason,
  scrollHistoryDetail,
  setActiveLayout,
  setLensResult,
  setMenuSpinner,
  setRecIndicator,
  setSummaryBadgeState,
  showActivePage,
  showHistoryDetailPage,
  showHistoryListPage,
  showMenuPage,
  showPickerPage,
  showUnconfiguredPage,
} from '../src/runtime/hud';
import { saveAutoSummaryEnabled, saveDiscreet, setLensResult as setStateLensResult, settings } from '../src/state/store';
import { getPersona, getPickerPersonas } from '../src/personas';
import type { HistoryEntry, LensResult } from '../src/types';

const fakeSetLs = (_k: string, _v: string): Promise<boolean> => Promise.resolve(true);

afterEach(async () => {
  // Always reset discreet + layout + result so test order does not bleed state.
  await saveDiscreet(fakeSetLs, false);
  await saveAutoSummaryEnabled(fakeSetLs, false);
  setActiveLayout('baseline');
  setStateLensResult(null);
});

beforeEach(() => {
  _resetHudBootstrapForTesting();
  vi.clearAllMocks();
  bridge.createStartUpPageContainer.mockResolvedValue(0);
  bridge.rebuildPageContainer.mockResolvedValue(true);
  bridge.textContainerUpgrade.mockResolvedValue(true);
});

describe('personaAtIndex', () => {
  it('returns the persona at the given index (within picker list)', () => {
    const list = getPickerPersonas();
    const persona = personaAtIndex(1);
    expect(persona).not.toBeNull();
    expect(persona!.id).toBe(list[1]!.id);
  });

  it('falls back to the first persona when index is undefined / negative', () => {
    const first = getPickerPersonas()[0]!;
    expect(personaAtIndex(undefined)!.id).toBe(first.id);
    expect(personaAtIndex(-5)!.id).toBe(first.id);
  });

  it('falls back to the first persona when index is out of range', () => {
    const first = getPickerPersonas()[0]!;
    expect(personaAtIndex(999)!.id).toBe(first.id);
  });
});

describe('menuOptionAtIndex', () => {
  it('returns each menu option id by index', () => {
    for (let i = 0; i < MENU_OPTIONS.length; i++) {
      expect(menuOptionAtIndex(i)).toBe(MENU_OPTIONS[i]!.id);
    }
  });

  it('falls back to "back" for invalid indices', () => {
    expect(menuOptionAtIndex(99)).toBe('back');
    expect(menuOptionAtIndex(undefined)).toBe('back');
    expect(menuOptionAtIndex(-1)).toBe('back');
  });
});

describe('page lifecycle', () => {
  it('starts at "none" before bootstrap', () => {
    expect(currentHudPage()).toBe('none');
  });

  it('transitions to "picker" after bootstrap', async () => {
    await bootstrapHud('picker');
    expect(currentHudPage()).toBe('picker');
    expect(bridge.createStartUpPageContainer).toHaveBeenCalledOnce();
  });

  it('transitions to "unconfigured" after bootstrap("unconfigured")', async () => {
    await bootstrapHud('unconfigured');
    expect(currentHudPage()).toBe('unconfigured');
  });

  it('show*Page calls rebuild and updates currentHudPage', async () => {
    await bootstrapHud('picker');
    await showPickerPage();
    expect(currentHudPage()).toBe('picker');
    await showUnconfiguredPage();
    expect(currentHudPage()).toBe('unconfigured');

    const persona = getPersona('fact-checker')!;
    await showActivePage(persona);
    expect(currentHudPage()).toBe('active');

    await showMenuPage();
    expect(currentHudPage()).toBe('menu');
  });

  it('showHistoryDetailPage stores the formatted reason for scroll', async () => {
    await bootstrapHud('picker');
    const persona = getPersona('fact-checker')!;
    await showActivePage(persona);

    const longReason = 'r'.repeat(800);
    const entry: HistoryEntry = {
      id: 'h1', timestamp: 1, sessionId: 's',
      lensId: 'fact-checker', lensName: 'Fact Check', question: 'q',
      badge: 'TRUE', quote: '',
      result: { type: 'fact-check', claims: [{ quote: '', verdict: 'TRUE', claim: 'c', reason: longReason }] },
    };
    await showHistoryDetailPage(entry);
    expect(currentHudPage()).toBe('history-detail');

    // Scrolling down should issue a textContainerUpgrade.
    bridge.textContainerUpgrade.mockClear();
    await scrollHistoryDetail(1);
    expect(bridge.textContainerUpgrade).toHaveBeenCalledOnce();
  });

  it('scrollHistoryDetail clamps at 0 when already at the top', async () => {
    await bootstrapHud('picker');
    const persona = getPersona('fact-checker')!;
    await showActivePage(persona);
    const entry: HistoryEntry = {
      id: 'h1', timestamp: 1, sessionId: 's',
      lensId: 'fact-checker', lensName: 'Fact Check', question: 'q',
      badge: 'TRUE', quote: '',
      result: { type: 'fact-check', claims: [{ quote: '', verdict: 'TRUE', claim: 'c', reason: 'short' }] },
    };
    await showHistoryDetailPage(entry);
    bridge.textContainerUpgrade.mockClear();
    await scrollHistoryDetail(-1);
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
  });
});

describe('setLensResult', () => {
  it('writes the unified body (heading + verdict + reason) into a single text container', async () => {
    await bootstrapHud('picker');
    const persona = getPersona('fact-checker')!;
    await showActivePage(persona);
    bridge.textContainerUpgrade.mockClear();

    const result: LensResult = {
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'The Earth is round.', reason: 'Established by science.' }],
    };
    await setLensResult(result);
    // Unified body: 1 upgrade (only vl-reason). The body composes heading +
    // verdict glyph + reason with blank-line separators.
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1);
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[{ payload: { containerName: string; content: string } }]>;
    expect(calls[0]![0].payload.containerName).toBe('vl-reason');
    const body = calls[0]![0].payload.content;
    expect(body).toContain('The Earth is round.');
    expect(body).toContain('+ TRUE');
    expect(body).toContain('Established by science.');
  });

  it('is a no-op when the current page is neither active nor history-detail', async () => {
    await bootstrapHud('picker');
    bridge.textContainerUpgrade.mockClear();
    await setLensResult({ type: 'eli5', claims: [{ quote: '', explanation: 'foo' }] });
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
  });

  it('prefixes the body heading with "Auto · " when autoSelected is set', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    bridge.textContainerUpgrade.mockClear();

    const result: LensResult = {
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'X', reason: 'Y' }],
      autoSelected: true,
    };
    await setLensResult(result);
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[{ payload: { containerName: string; content: string } }]>;
    const bodyCall = calls.find((c) => c[0].payload.containerName === 'vl-reason');
    expect(bodyCall).toBeDefined();
    // Session-relative X/Y prefix comes first ("1/1 · "), then the Auto badge
    // sits inside the entry body just before the heading.
    expect(bodyCall![0].payload.content).toContain('Auto · X');
  });
});

describe('setRecIndicator', () => {
  it('only writes on the active page', async () => {
    await bootstrapHud('picker');
    bridge.textContainerUpgrade.mockClear();
    await setRecIndicator(true);
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();

    await showActivePage(getPersona('fact-checker')!);
    bridge.textContainerUpgrade.mockClear();
    await setRecIndicator(true);
    expect(bridge.textContainerUpgrade).toHaveBeenCalledOnce();
  });
});

describe('setSummaryBadgeState', () => {
  type UpgradeBag = { payload: { containerName: string; content: string } };

  function badgeWrites(): string[] {
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[UpgradeBag]>;
    return calls
      .filter((c) => c[0].payload.containerName === 'vl-sum-badge')
      .map((c) => c[0].payload.content);
  }

  it('writes "summarizing..." when auto-summary is enabled', async () => {
    await saveAutoSummaryEnabled(fakeSetLs, true);
    await bootstrapHud('picker');
    bridge.textContainerUpgrade.mockClear();
    await setSummaryBadgeState('generating');
    expect(badgeWrites()).toEqual(['summarizing...']);
  });

  it('flashes "summary ready" then reverts to "auto-summary" after 2.5s', async () => {
    vi.useFakeTimers();
    try {
      await saveAutoSummaryEnabled(fakeSetLs, true);
      await bootstrapHud('picker');
      bridge.textContainerUpgrade.mockClear();
      await setSummaryBadgeState('ready');
      expect(badgeWrites()).toEqual(['summary ready']);
      vi.advanceTimersByTime(2500);
      await Promise.resolve();
      expect(badgeWrites()).toEqual(['summary ready', 'auto-summary']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the badge blank when auto-summary is disabled', async () => {
    await saveAutoSummaryEnabled(fakeSetLs, false);
    await bootstrapHud('picker');
    bridge.textContainerUpgrade.mockClear();
    await setSummaryBadgeState('generating');
    await setSummaryBadgeState('ready');
    expect(badgeWrites()).toEqual(['', '']);
  });

  it('is a no-op when not on the picker page', async () => {
    await saveAutoSummaryEnabled(fakeSetLs, true);
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    bridge.textContainerUpgrade.mockClear();
    await setSummaryBadgeState('generating');
    expect(badgeWrites()).toEqual([]);
  });
});

describe('scrollActiveReason', () => {
  it('is a no-op when not on active page', async () => {
    await bootstrapHud('picker');
    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(1);
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
  });
});

describe('showHistoryListPage', () => {
  it('caches entries so restoreHistoryListPage can replay them', async () => {
    await bootstrapHud('picker');
    const entries: HistoryEntry[] = [{
      id: 'h', timestamp: 1, sessionId: 's',
      lensId: 'trivia', lensName: 'Trivia', question: 'q', badge: 'ANSWER', quote: '',
      result: { type: 'trivia', claims: [{ quote: '', question: 'q', answer: 'a', description: 'd' }] },
    }];
    await showHistoryListPage(entries);
    expect(currentHudPage()).toBe('history-list');
  });
});

describe('discreet mode', () => {
  type TextBag = { payload: { containerName: string; content: string } };
  type RebuildBag = { payload: { containerTotalNum: number; textObject: TextBag[]; listObject: unknown[] } };

  function lastRebuildPayload(): RebuildBag['payload'] {
    const calls = bridge.rebuildPageContainer.mock.calls as unknown as Array<[RebuildBag]>;
    return calls.at(-1)![0].payload;
  }

  function findText(payload: RebuildBag['payload'], name: string): TextBag['payload'] | undefined {
    return payload.textObject.find((t) => t.payload.containerName === name)?.payload;
  }

  it('MENU_OPTIONS leads with "← Back" and has no Hide entry', () => {
    expect(MENU_OPTIONS[0]?.id).toBe('back');
    expect(MENU_OPTIONS[0]?.label).toBe('← Back');
    expect(MENU_OPTIONS.find((o) => (o.id as string) === 'hide')).toBeUndefined();
  });

  it('menuOptionAtIndex maps index 0 back to "back"', () => {
    expect(menuOptionAtIndex(0)).toBe('back');
  });

  it('baseline layout renders REC + hint and omits the rec dot', async () => {
    await saveDiscreet(fakeSetLs, false);
    setActiveLayout('baseline');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const payload = lastRebuildPayload();
    expect(findText(payload, 'vl-rec')?.content).toBe('● REC');
    expect(findText(payload, 'vl-act-hint')?.content).toBe('Tap: menu · Double-tap: check');
    expect(findText(payload, 'vl-clock')).toBeUndefined();
  });

  it('discreet-minimal layout has a single top-right slot showing the rec dot + event sink', async () => {
    await saveDiscreet(fakeSetLs, true);
    setActiveLayout('discreet-minimal');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const payload = lastRebuildPayload();
    // Discreet now uses a text-container event sink (same as baseline) so
    // both swipe and tap fire reliably on hardware; that adds one text
    // container alongside the status/dot, and the listObject is empty.
    expect(payload.textObject).toHaveLength(2);
    expect(payload.listObject).toHaveLength(0);
    expect(findText(payload, 'vl-status')?.content).toBe('•');
    expect(findText(payload, 'vl-clock')).toBeUndefined();
    expect(findText(payload, 'vl-rec')).toBeUndefined();
    expect(findText(payload, 'vl-act-hint')).toBeUndefined();
  });

  it('discreet-result layout is a single unified body container (no rec or hint chrome) plus a corner status slot for the spinner', async () => {
    await saveDiscreet(fakeSetLs, true);
    setActiveLayout('discreet-result');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const payload = lastRebuildPayload();
    expect(findText(payload, 'vl-rec')).toBeUndefined();
    expect(findText(payload, 'vl-act-hint')).toBeUndefined();
    expect(findText(payload, 'vl-clock')).toBeUndefined();
    // Status container exists (for spinner during a background analysis) but
    // is empty when nothing is running, so the answer view stays clean.
    expect(findText(payload, 'vl-status')).toBeDefined();
    expect(findText(payload, 'vl-status')?.content).toBe('');
    // Unified body — no separate claim/verdict containers anymore.
    expect(findText(payload, 'vl-claim')).toBeUndefined();
    expect(findText(payload, 'vl-verdict')).toBeUndefined();
    expect(findText(payload, 'vl-reason')).toBeDefined();
    // 2 text containers: status (top-right corner) + unified body. The body
    // is itself the event capturer (isEventCapture=1) — no separate sink
    // needed since it covers nearly the whole screen.
    expect(payload.textObject).toHaveLength(2);
    expect(payload.listObject).toHaveLength(0);
  });

  it('setRecIndicator is a no-op while a discreet layout is active', async () => {
    setActiveLayout('discreet-minimal');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    bridge.textContainerUpgrade.mockClear();
    await setRecIndicator(true);
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
  });

  it('setStatus on discreet-minimal writes to the shared top-right slot', async () => {
    setActiveLayout('discreet-minimal');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    bridge.textContainerUpgrade.mockClear();
    const { setStatus } = await import('../src/runtime/hud');
    await setStatus('thinking');
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[{ payload: { containerName: string; content: string } }]>;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].payload.containerName).toBe('vl-status');
    expect(calls[0]![0].payload.content).toBe('...');
  });

  it('setStatus on discreet-result writes to the corner status slot (so the spinner stays visible while reviewing previous answers)', async () => {
    setActiveLayout('discreet-result');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    bridge.textContainerUpgrade.mockClear();
    const { setStatus } = await import('../src/runtime/hud');
    await setStatus('thinking');
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[{ payload: { containerName: string; content: string } }]>;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].payload.containerName).toBe('vl-status');
    expect(calls[0]![0].payload.content).toBe('...');
  });

  it('setLensResult(null) in discreet-minimal stays on dot-only (no upgrades, no rebuild)', async () => {
    setActiveLayout('discreet-minimal');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    bridge.textContainerUpgrade.mockClear();
    bridge.rebuildPageContainer.mockClear();
    await setLensResult(null);
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled();
  });

  it('setLensResult promotes discreet-minimal → discreet-result when a result arrives', async () => {
    setActiveLayout('discreet-minimal');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    bridge.textContainerUpgrade.mockClear();
    bridge.rebuildPageContainer.mockClear();
    await setLensResult({ type: 'eli5', claims: [{ quote: '', explanation: 'x' }] });
    // The promotion rebuilds the page with the unified layout (2 containers:
    // status + unified body — the body is its own event capturer).
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce();
    const payload = lastRebuildPayload();
    expect(payload.containerTotalNum).toBe(2);
    expect(findText(payload, 'vl-clock')).toBeUndefined();
    // 1 upgrade: the unified body container.
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1);
  });

  it('setLensResult(null) on discreet-result demotes back to discreet-minimal', async () => {
    setActiveLayout('discreet-minimal');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    await setLensResult({ type: 'eli5', claims: [{ quote: '', explanation: 'x' }] }); // promote

    bridge.textContainerUpgrade.mockClear();
    bridge.rebuildPageContainer.mockClear();
    await setLensResult(null);
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce();
    const payload = lastRebuildPayload();
    expect(findText(payload, 'vl-status')?.content).toBe('•');
    expect(findText(payload, 'vl-claim')).toBeUndefined();
    // Demotion path skips the text upgrades — the dot-only layout has no
    // claim/verdict/reason containers to write into.
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
  });

  it('settings().discreet reflects saveDiscreet result', async () => {
    await saveDiscreet(fakeSetLs, true);
    expect(settings().discreet).toBe(true);
    await saveDiscreet(fakeSetLs, false);
    expect(settings().discreet).toBe(false);
  });
});

describe('resetHudSessionState', () => {
  it('clears the cached active-reason scroll buffer so a stale scroll is a no-op', async () => {
    await bootstrapHud('picker');
    const persona = getPersona('fact-checker')!;
    await showActivePage(persona);

    // Populate the active-reason buffer with content that overflows the page,
    // so scrollActiveReason has something to move through.
    const longReason = 'r'.repeat(800);
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'c', reason: longReason }],
    });

    // Sanity check: scroll moves the buffer (textContainerUpgrade fires).
    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(1);
    expect(bridge.textContainerUpgrade).toHaveBeenCalledOnce();

    // After reset, scrolling should be a no-op even on the active page —
    // because the cached full-reason is empty, maxOffset is 0.
    resetHudSessionState();
    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(1);
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
  });

  it('clears the cached menuPersona so restoreActivePage cannot replay stale state', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    resetHudSessionState();

    // After reset, switch to a non-active page first, then attempt to restore.
    // The internal menuPersona is now null, so showActivePage is not invoked.
    await showPickerPage();
    bridge.rebuildPageContainer.mockClear();
    const { restoreActivePage } = await import('../src/runtime/hud');
    await restoreActivePage();
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled();
  });
});

describe('pending result on menu', () => {
  it('setLensResult while on the menu stashes the result without writing the HUD', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    await showMenuPage();

    bridge.textContainerUpgrade.mockClear();
    bridge.rebuildPageContainer.mockClear();
    expect(hasPendingActiveResult()).toBe(false);

    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'C', reason: 'R' }],
    });

    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled();
    expect(hasPendingActiveResult()).toBe(true);
  });

  it('returning to the active page consumes the pending result and renders it', async () => {
    await bootstrapHud('picker');
    const persona = getPersona('fact-checker')!;
    await showActivePage(persona);
    await showMenuPage();
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'FALSE', claim: 'The Sun rises in the west.', reason: 'It rises in the east.' }],
    });
    expect(hasPendingActiveResult()).toBe(true);

    bridge.textContainerUpgrade.mockClear();
    bridge.rebuildPageContainer.mockClear();

    const { restoreActivePage } = await import('../src/runtime/hud');
    await restoreActivePage();

    expect(currentHudPage()).toBe('active');
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce();
    // 1 upgrade: the unified body container.
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1);
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[{ payload: { containerName: string; content: string } }]>;
    const reason = calls.find((c) => c[0].payload.containerName === 'vl-reason');
    expect(reason).toBeDefined();
    // Unified body contains the heading, verdict glyph, and reason text together.
    expect(reason![0].payload.content).toContain('east');
    expect(reason![0].payload.content).toContain('The Sun rises in the west.');
    expect(reason![0].payload.content).toContain('- FALSE');
    expect(hasPendingActiveResult()).toBe(false);
  });

  it('setLensResult while on the active page renders directly and does not set pending', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    await setLensResult({ type: 'eli5', claims: [{ quote: '', explanation: 'hello' }] });
    expect(hasPendingActiveResult()).toBe(false);

    // Re-entering the active page should not replay anything.
    bridge.textContainerUpgrade.mockClear();
    bridge.rebuildPageContainer.mockClear();
    await showActivePage(getPersona('fact-checker')!);
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce();
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
  });

  it('a pending result promotes discreet-minimal to discreet-result on return', async () => {
    await saveDiscreet(fakeSetLs, true);
    setActiveLayout('discreet-minimal');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    await showMenuPage();

    await setLensResult({ type: 'eli5', claims: [{ quote: '', explanation: 'because reasons' }] });
    expect(hasPendingActiveResult()).toBe(true);

    bridge.textContainerUpgrade.mockClear();
    bridge.rebuildPageContainer.mockClear();

    const { restoreActivePage } = await import('../src/runtime/hud');
    await restoreActivePage();

    // The active-page rebuild lays down the unified discreet-result layout
    // (2 containers: status + unified body) and the replay writes the
    // composed body into it.
    const calls = bridge.rebuildPageContainer.mock.calls as unknown as Array<[{ payload: { containerTotalNum: number; textObject: Array<{ payload: { containerName: string } }> } }]>;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const lastRebuild = calls.at(-1)![0].payload;
    expect(lastRebuild.containerTotalNum).toBe(2);
    expect(lastRebuild.textObject.some((t) => t.payload.containerName === 'vl-reason')).toBe(true);
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1);
    expect(hasPendingActiveResult()).toBe(false);
  });

  it('resetHudSessionState clears a pending result', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    await showMenuPage();
    await setLensResult({ type: 'eli5', claims: [{ quote: '', explanation: 'x' }] });
    expect(hasPendingActiveResult()).toBe(true);

    resetHudSessionState();
    expect(hasPendingActiveResult()).toBe(false);
  });
});

describe('multi-claim active page', () => {
  type TextBag = { payload: { containerName: string; content: string } };

  function lastUpgradeByName(name: string): string | undefined {
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[TextBag]>;
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i]![0].payload.containerName === name) return calls[i]![0].payload.content;
    }
    return undefined;
  }

  it('prefixes every page with the session-relative X/Y when the session has multiple entries', async () => {
    // Fact-check splits multi-claim results into per-claim entries via
    // splitForSynthesis, so the session ends up with 2 entries here. Each
    // entry's pages carry the session-relative "X/2 · " prefix so the wearer
    // always sees which question they're on.
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    bridge.textContainerUpgrade.mockClear();
    await setLensResult({
      type: 'fact-check',
      claims: [
        { quote: 'q1', verdict: 'TRUE', claim: 'C1', reason: 'R1' },
        { quote: 'q2', verdict: 'FALSE', claim: 'C2', reason: 'R2' },
      ],
    });
    expect(lastUpgradeByName('vl-reason')).toBe('1/2 · C1\n\n+ TRUE\n\nR1');
  });

  it('always shows the session-relative indicator — even for a 1-entry session ("1/1")', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    bridge.textContainerUpgrade.mockClear();
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: 'q1', verdict: 'TRUE', claim: 'C1', reason: 'R1' }],
    });
    // Single-entry single-claim body: "1/1 · " prefix + heading + verdict + reason.
    expect(lastUpgradeByName('vl-reason')).toBe('1/1 · C1\n\n+ TRUE\n\nR1');
  });

  it('scrollActiveReason advances to claim 2 and rewrites the unified body with the new session-relative prefix', async () => {
    const { scrollActiveReason } = await import('../src/runtime/hud');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    await setLensResult({
      type: 'fact-check',
      claims: [
        { quote: 'q1', verdict: 'TRUE', claim: 'C1', reason: 'R1' },
        { quote: 'q2', verdict: 'FALSE', claim: 'C2', reason: 'R2' },
      ],
    });

    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(1);
    expect(lastUpgradeByName('vl-reason')).toBe('2/2 · C2\n\n- FALSE\n\nR2');

    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(-1);
    expect(lastUpgradeByName('vl-reason')).toBe('1/2 · C1\n\n+ TRUE\n\nR1');
  });

  it('scrollActiveReason past the last claim falls back to reason pagination', async () => {
    const { scrollActiveReason } = await import('../src/runtime/hud');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const longReason = 'r'.repeat(800);
    await setLensResult({
      type: 'fact-check',
      claims: [
        { quote: 'q1', verdict: 'TRUE', claim: 'C1', reason: 'R1' },
        { quote: 'q2', verdict: 'FALSE', claim: 'C2', reason: longReason },
      ],
    });

    // Advance to claim 2.
    await scrollActiveReason(1);
    // Advancing again should now paginate claim 2's reason rather than no-op.
    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(1);
    const reason = lastUpgradeByName('vl-reason');
    expect(reason).toBeDefined();
    // Multi-page entries get a per-answer "X/Y · " prefix and a bullet row
    // at the bottom — the body content is sandwiched between them. The
    // continuation page must contain a stretch of 'r's from the long reason.
    expect(reason).toContain('rrrrrr');
  });
});

describe('hide / reveal active result via scroll edges', () => {
  type TextBag = { payload: { containerName: string; content: string } };
  function lastUpgradeByName(name: string): string | undefined {
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[TextBag]>;
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i]![0].payload.containerName === name) return calls[i]![0].payload.content;
    }
    return undefined;
  }

  const twoClaims: LensResult = {
    type: 'fact-check',
    claims: [
      { quote: 'q1', verdict: 'TRUE', claim: 'C1', reason: 'R1' },
      { quote: 'q2', verdict: 'FALSE', claim: 'C2', reason: 'R2' },
    ],
  };

  it('markActiveHidden + scroll-up reveals the last page', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    await setLensResult(twoClaims);
    await scrollActiveReason(1); // advance to last page (claim 2)

    markActiveHidden();
    expect(isActiveHidden()).toBe(true);

    bridge.textContainerUpgrade.mockClear();
    const outcome = await scrollActiveReason(-1);
    expect(outcome).toBe('revealed');
    expect(isActiveHidden()).toBe(false);
    expect(lastUpgradeByName('vl-reason')).toContain('C2');
  });

  it('scroll-up while hidden with no result in memory is a noop', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    // No result was set, but markActiveHidden refuses without pages — still
    // exercise the "hidden + empty" branch directly via scrollActiveReason.
    bridge.textContainerUpgrade.mockClear();
    bridge.rebuildPageContainer.mockClear();
    const outcome = await scrollActiveReason(-1);
    expect(outcome).toBe('noop');
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled();
  });

  it('scroll-down past the last page hides the result (preserved for re-reveal)', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    await setLensResult(twoClaims);
    await scrollActiveReason(1); // last page

    const outcome = await scrollActiveReason(1);
    expect(outcome).toBe('hidden');
    expect(isActiveHidden()).toBe(true);

    // A follow-up swipe-up re-reveals the same last page the user was viewing.
    const followUp = await scrollActiveReason(-1);
    expect(followUp).toBe('revealed');
    expect(isActiveHidden()).toBe(false);
    expect(lastUpgradeByName('vl-reason')).toContain('C2');
  });

  it('scroll-down while hidden is a noop', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    await setLensResult(twoClaims);
    markActiveHidden();

    bridge.textContainerUpgrade.mockClear();
    bridge.rebuildPageContainer.mockClear();
    const outcome = await scrollActiveReason(1);
    expect(outcome).toBe('noop');
    expect(isActiveHidden()).toBe(true);
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled();
  });

  it('setLensResult clears the hidden flag', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    await setLensResult(twoClaims);
    markActiveHidden();
    expect(isActiveHidden()).toBe(true);

    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: 'q', verdict: 'TRUE', claim: 'fresh', reason: 'r' }],
    });
    expect(isActiveHidden()).toBe(false);
  });
});

describe('session-wide swipe scroll', () => {
  type TextBag = { payload: { containerName: string; content: string } };
  function lastUpgradeByName(name: string): string | undefined {
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[TextBag]>;
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i]![0].payload.containerName === name) return calls[i]![0].payload.content;
    }
    return undefined;
  }

  function entry(opts: { id: string; sessionId?: string; verdict: 'TRUE' | 'FALSE'; claim: string; reason?: string }): HistoryEntry {
    return {
      id: opts.id, timestamp: 1, sessionId: opts.sessionId ?? 's',
      lensId: 'fact-checker', lensName: 'Fact Check', question: opts.claim,
      badge: opts.verdict, quote: '',
      result: { type: 'fact-check', claims: [{ quote: '', verdict: opts.verdict, claim: opts.claim, reason: opts.reason ?? 'r' }] },
    };
  }

  it('first analysis: 1/N within-analysis, scroll-up at first claim noop (single analysis)', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const e1 = entry({ id: 'e1', verdict: 'TRUE', claim: 'CLAIM-A', reason: 'RA' });
    const e2 = entry({ id: 'e2', verdict: 'FALSE', claim: 'CLAIM-B', reason: 'RB' });
    // Single analysis that just landed: 2 split entries, both belong to the
    // latest analysis.
    await setLensResult(e2.result, { sessionEntries: [e1, e2], newEntryIds: new Set(['e1', 'e2']) });

    // Cursor at first new entry → unified body starts with "1/2 · CLAIM-A".
    expect(lastUpgradeByName('vl-reason')).toContain('CLAIM-A');

    // Swipe-up from first claim: there's no earlier entry, so noop.
    bridge.textContainerUpgrade.mockClear();
    const outcome = await scrollActiveReason(-1);
    expect(outcome).toBe('noop');
  });

  it('subsequent analysis jumps cursor to its first claim; swipe-up crosses to session indicator', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const eOld1 = entry({ id: 'o1', verdict: 'TRUE',  claim: 'OLD-1' });
    const eOld2 = entry({ id: 'o2', verdict: 'FALSE', claim: 'OLD-2' });
    const eNew1 = entry({ id: 'n1', verdict: 'TRUE',  claim: 'NEW-1' });
    const eNew2 = entry({ id: 'n2', verdict: 'FALSE', claim: 'NEW-2' });
    // First analysis: 2 old entries.
    await setLensResult(eOld2.result, { sessionEntries: [eOld1, eOld2], newEntryIds: new Set(['o1', 'o2']) });
    // Subsequent analysis: 2 new entries appended. Cursor jumps to the new
    // first claim (NEW-1) so the wearer sees the new question immediately.
    await setLensResult(eNew2.result, { sessionEntries: [eOld1, eOld2, eNew1, eNew2], newEntryIds: new Set(['n1', 'n2']) });

    // Indicator is uniformly session-relative: new first claim is position
    // 3 of 4 total claims.
    expect(lastUpgradeByName('vl-reason')).toContain('NEW-1');

    // Swipe down advances within the session → 4/4 · NEW-2.
    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(1);
    expect(lastUpgradeByName('vl-reason')).toContain('NEW-2');

    // Swipe down past the last page hides (session end).
    const outcome = await scrollActiveReason(1);
    expect(outcome).toBe('hidden');
    expect(isActiveHidden()).toBe(true);

    // Reveal jumps to the last session page (Y/Y) in session mode.
    bridge.textContainerUpgrade.mockClear();
    const reveal = await scrollActiveReason(-1);
    expect(reveal).toBe('revealed');
    expect(lastUpgradeByName('vl-reason')).toContain('NEW-2');
  });

  it('indicator is always session-relative X/Y, with no mode transitions', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const eOld1 = entry({ id: 'o1', verdict: 'TRUE',  claim: 'OLD-1' });
    const eOld2 = entry({ id: 'o2', verdict: 'FALSE', claim: 'OLD-2' });
    const eNew1 = entry({ id: 'n1', verdict: 'TRUE',  claim: 'NEW-1' });
    const eNew2 = entry({ id: 'n2', verdict: 'FALSE', claim: 'NEW-2' });
    await setLensResult(eOld2.result, { sessionEntries: [eOld1, eOld2], newEntryIds: new Set(['o1', 'o2']) });
    await setLensResult(eNew2.result, { sessionEntries: [eOld1, eOld2, eNew1, eNew2], newEntryIds: new Set(['n1', 'n2']) });

    // Cursor lands on the new first claim with session indicator 3/4.
    expect(lastUpgradeByName('vl-reason')).toContain('NEW-1');

    // Swipe up walks back into older entries — still X/Y session-relative.
    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(-1);
    expect(lastUpgradeByName('vl-reason')).toContain('OLD-2');

    // Swipe back down to the new first claim — same X/Y format, same number.
    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(1);
    expect(lastUpgradeByName('vl-reason')).toContain('NEW-1');
  });

  it('no indicator on a single-claim, single-entry session', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const eOnly = entry({ id: 'a', verdict: 'TRUE', claim: 'ONLY' });
    await setLensResult(eOnly.result, { sessionEntries: [eOnly], newEntryIds: new Set(['a']) });
    expect(lastUpgradeByName('vl-reason')).toContain('ONLY');
  });

  it('hidden reveal after new analysis lands on Y/Y (last session page)', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const eOld = entry({ id: 'o', verdict: 'TRUE', claim: 'OLD' });
    const eNew = entry({ id: 'n', verdict: 'FALSE', claim: 'NEW' });

    // First analysis with 1 entry → no indicator. Hide.
    await setLensResult(eOld.result, { sessionEntries: [eOld], newEntryIds: new Set(['o']) });
    markActiveHidden();
    expect(isActiveHidden()).toBe(true);

    // New analysis arrives → activeHidden is cleared so the wearer always
    // sees the new answer (matches the "show the first answer once analysis
    // is done" expectation).
    await setLensResult(eNew.result, { sessionEntries: [eOld, eNew], newEntryIds: new Set(['n']) });
    expect(isActiveHidden()).toBe(false);
    expect(lastUpgradeByName('vl-reason')).toContain('NEW');
  });

  it('manual hide (without new analysis) preserves the cursor; reveal returns to where the user was', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const e1 = entry({ id: '1', verdict: 'TRUE',  claim: 'A' });
    const e2 = entry({ id: '2', verdict: 'FALSE', claim: 'B' });
    await setLensResult(e2.result, { sessionEntries: [e1, e2], newEntryIds: new Set(['1', '2']) });

    // Walk to claim 2 and hide.
    await scrollActiveReason(1);
    expect(lastUpgradeByName('vl-reason')).toContain('B');
    await scrollActiveReason(1); // hides (past last page)
    expect(isActiveHidden()).toBe(true);

    // Reveal lands on Y/Y in session mode.
    bridge.textContainerUpgrade.mockClear();
    const outcome = await scrollActiveReason(-1);
    expect(outcome).toBe('revealed');
    expect(lastUpgradeByName('vl-reason')).toContain('B');
  });
});

describe('menu spinner', () => {
  type TextBag = { payload: { containerName: string; content: string } };
  type RebuildBag = { payload: { textObject: TextBag[] } };

  function lastRebuildTexts(): TextBag['payload'][] {
    const calls = bridge.rebuildPageContainer.mock.calls as unknown as Array<[RebuildBag]>;
    return calls.at(-1)![0].payload.textObject.map((t) => t.payload);
  }

  it('buildMenuPage includes a spinner container next to the clock', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    await showMenuPage();

    const names = lastRebuildTexts().map((t) => t.containerName);
    expect(names).toContain('vl-menu-spin');
    expect(names).toContain('vl-clock');
  });

  it('setMenuSpinner writes to the spinner slot when on the menu page', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    await showMenuPage();

    bridge.textContainerUpgrade.mockClear();
    await setMenuSpinner('|');
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[{ payload: { containerName: string; content: string } }]>;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].payload.containerName).toBe('vl-menu-spin');
    expect(calls[0]![0].payload.content).toBe('|');
  });

  it('setMenuSpinner is a no-op write off the menu page but still records the frame', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    bridge.textContainerUpgrade.mockClear();
    await setMenuSpinner('/');
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();

    // The recorded frame is used to seed buildMenuPage on the next showMenuPage,
    // so the spinner appears immediately on rebuild instead of waiting a tick.
    await showMenuPage();
    const spinner = lastRebuildTexts().find((t) => t.containerName === 'vl-menu-spin');
    expect(spinner?.content).toBe('/');
  });

  it('setMenuSpinner("") clears the recorded frame so a fresh menu starts blank', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    await setMenuSpinner('-');
    await setMenuSpinner('');

    await showMenuPage();
    const spinner = lastRebuildTexts().find((t) => t.containerName === 'vl-menu-spin');
    expect(spinner?.content).toBe('');
  });
});

describe('line-aware pagination', () => {
  type TextBag = { payload: { containerName: string; content: string; height?: number; width?: number; paddingLength?: number } };
  type RebuildBag = { payload: { containerTotalNum: number; textObject: TextBag[]; listObject: unknown[] } };

  function lastRebuildPayload(): RebuildBag['payload'] {
    const calls = bridge.rebuildPageContainer.mock.calls as unknown as Array<[RebuildBag]>;
    return calls.at(-1)![0].payload;
  }
  function findText(payload: RebuildBag['payload'], name: string): TextBag['payload'] | undefined {
    return payload.textObject.find((t) => t.payload.containerName === name)?.payload;
  }
  function lastUpgradeByName(name: string): string | undefined {
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[{ payload: { containerName: string; content: string } }]>;
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i]![0].payload.containerName === name) return calls[i]![0].payload.content;
    }
    return undefined;
  }

  it('paginates a long reason into multiple pages, each fitting the line budget', async () => {
    const { measureTextWrap } = await import('@evenrealities/pretext');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    // ~2000-char prose so it definitely overflows even the larger scroll
    // budget. Use real words so word-boundary breaks happen.
    const longReason = ('The quick brown fox jumps over the lazy dog. ').repeat(60);
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'C', reason: longReason }],
    });
    // Walk through every page; each page must fit within the unified-body
    // budget. Baseline = 9 lines × 27px = 243px. Page 0 now uses the same
    // budget as continuation pages (one container, no claim/verdict slot
    // eating the top of the screen).
    let upgrades = 1;
    const maxHeightPx = 9 * 27;
    let page = lastUpgradeByName('vl-reason')!;
    expect(page).toBeDefined();
    expect(measureTextWrap(page, 536).height).toBeLessThanOrEqual(maxHeightPx);
    while (true) {
      bridge.textContainerUpgrade.mockClear();
      await scrollActiveReason(1);
      const next = lastUpgradeByName('vl-reason');
      if (!next) break; // hit the end
      expect(measureTextWrap(next, 536).height).toBeLessThanOrEqual(maxHeightPx);
      page = next;
      upgrades++;
      if (upgrades > 50) throw new Error('runaway pagination loop');
    }
    expect(upgrades).toBeGreaterThan(1);
  });

  it('paginates without mid-word cuts when word boundaries exist', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    const reason = ('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon ').repeat(8);
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'C', reason }],
    });
    // First page should end on a space-bounded word, not in the middle of
    // one. Multi-page entries get an inline "X/Y · " prefix on the first
    // line and a left-aligned bullet row "● ○ ○…" at the bottom — strip
    // both for the word-boundary check on the body chunk itself.
    const strip = (page: string) =>
      page.replace(/^\d+\/\d+ · /, '').replace(/\n\n[●○]( [●○])+$/, '');
    const page0Body = strip(lastUpgradeByName('vl-reason')!);
    expect(page0Body).toBeDefined();
    expect(/[a-z]$/.test(page0Body)).toBe(true);
    // Crucially: scroll forward and verify the next page begins at the start
    // of the next word, not mid-token from the previous one.
    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(1);
    const page1Body = strip(lastUpgradeByName('vl-reason')!);
    expect(page1Body).toBeDefined();
    // The first char must be the start of a word in our list. It must not be
    // a continuation of "alpha"/"beta"/etc.
    expect(/^[a-z]/.test(page1Body)).toBe(true);
    // No leading whitespace either — we trim that off.
    expect(page1Body[0]).not.toBe(' ');
  });

  it('linearizes multi-claim navigation: each claim contributes 1+ pages in order', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const longReason = ('The quick brown fox jumps over the lazy dog. ').repeat(60);
    await setLensResult({
      type: 'fact-check',
      claims: [
        { quote: '', verdict: 'TRUE',  claim: 'CLAIM-A', reason: longReason },
        { quote: '', verdict: 'FALSE', claim: 'CLAIM-B', reason: 'short B reason' },
      ],
    });
    // Page 0 of claim A's entry: unified body has the heading and verdict.
    // Per-answer X/Y prefix appears because the long reason makes the entry
    // multi-page (split by splitForSynthesis into per-claim entries).
    expect(lastUpgradeByName('vl-reason')).toContain('CLAIM-A');
    expect(lastUpgradeByName('vl-reason')).toContain('+ TRUE');

    // Walk forward until we reach claim B's body. CLAIM-B's reason is short
    // (single page), so its body has no per-answer prefix or bullets.
    let safety = 30;
    while (safety-- > 0) {
      bridge.textContainerUpgrade.mockClear();
      await scrollActiveReason(1);
      const body = lastUpgradeByName('vl-reason');
      if (body && body.includes('CLAIM-B')) {
        expect(body).toContain('- FALSE');
        expect(body).toContain('short B reason');
        return;
      }
    }
    throw new Error('never reached claim B in linearized traversal');
  });

  it('scrolling within the same mode does NOT rebuild the page container — only upgrades the body', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const longReason = ('The quick brown fox jumps over the lazy dog. ').repeat(60);
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'C', reason: longReason }],
    });

    // Initial layout: baseline unified body (sink + status + body + rec + hint).
    const payload = lastRebuildPayload();
    expect(findText(payload, 'vl-rec')).toBeDefined();
    expect(findText(payload, 'vl-act-hint')).toBeDefined();
    expect(findText(payload, 'vl-reason')).toBeDefined();
    expect(findText(payload, 'vl-claim')).toBeUndefined();
    expect(findText(payload, 'vl-verdict')).toBeUndefined();
    expect(findText(payload, 'vl-compact')).toBeUndefined();

    // Unified model: scrolling page 0 → page 1 stays in the same baseline
    // layout, so it must NOT rebuild — just push the next body chunk via
    // textContainerUpgrade. This guards against re-introducing a
    // full↔scroll layout boundary.
    bridge.rebuildPageContainer.mockClear();
    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(1);
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled();
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1);
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[{ payload: { containerName: string } }]>;
    expect(calls[0]![0].payload.containerName).toBe('vl-reason');
  });

  it('continuation pages still carry the body in vl-reason (no separate compact header)', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const longReason = ('The quick brown fox jumps over the lazy dog. ').repeat(60);
    await setLensResult({
      type: 'fact-check',
      claims: [
        { quote: '', verdict: 'TRUE',  claim: 'C1', reason: longReason },
        { quote: '', verdict: 'FALSE', claim: 'C2', reason: 'short' },
      ],
    });
    // Page 0 unified body contains heading + verdict + start of reason.
    // The long-reason entry paginates to multiple pages so it carries the
    // per-answer X/Y prefix (e.g. "1/9 · ") on its first line.
    expect(lastUpgradeByName('vl-reason')).toMatch(/^\d+\/\d+ · /);
    expect(lastUpgradeByName('vl-reason')).toContain('+ TRUE');

    // Scroll forward — continuation page carries more of the body, no
    // separate compact header.
    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(1);
    const next = lastUpgradeByName('vl-reason');
    expect(next).toBeDefined();
    // No vl-compact container exists in the rebuild payload either.
    const payload = lastRebuildPayload();
    expect(findText(payload, 'vl-compact')).toBeUndefined();
  });

  it('paginates a long claim through the unified body (baseline)', async () => {
    // With the unified body, the heading + verdict + reason all flow through
    // the same single text container. A long Meeting-Prep-style primary line
    // simply pushes its tail into later pages of the same body.
    await saveDiscreet(fakeSetLs, false);
    setActiveLayout('baseline');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    // ≥105 chars so it overflows the 9-line baseline page budget when combined
    // with the verdict glyph + reason; the unique tail marker must live before
    // char 139 (the formatLensResultBase 140-char clip).
    const longClaim = 'Danske Banks tilbud har en ÅOP på 3,86%, mens Teslas er 1,30%. Spørg banken hvordan de matcher dette tilbud SLUTORD.';
    const longReason = ('The quick brown fox jumps over the lazy dog. ').repeat(20);
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: longClaim, reason: longReason }],
    });

    // Page 0 body starts with the heading (possibly truncated by pagination).
    const page0 = lastUpgradeByName('vl-reason')!;
    expect(page0).toBeDefined();

    // Scroll forward — the SLUTORD tail of the heading must appear in some
    // page's body chunk (it's near the start of the unified body so it lands
    // on page 0 or page 1).
    let foundTail = page0.includes('SLUTORD');
    for (let i = 0; i < 10 && !foundTail; i++) {
      bridge.textContainerUpgrade.mockClear();
      await scrollActiveReason(1);
      const body = lastUpgradeByName('vl-reason');
      if (body && body.includes('SLUTORD')) foundTail = true;
    }
    expect(foundTail).toBe(true);
  });

  it('long claim still paginates when followed by a long reason (linear traversal)', async () => {
    await saveDiscreet(fakeSetLs, false);
    setActiveLayout('baseline');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const longClaim = 'Danske Banks tilbud har en ÅOP på 3,86%, mens Teslas er 1,30%. Spørg banken hvordan de matcher dette tilbud SLUTORD.';
    const longReason = ('The quick brown fox jumps over the lazy dog. ').repeat(40);
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: longClaim, reason: longReason }],
    });

    // In the unified body, the heading + verdict + reason appear in that
    // order. SLUTORD (in the heading) must precede 'quick brown' (in the
    // reason) — either within the same page, or in an earlier page.
    let sawClaimTail = false;
    let sawReasonText = false;
    let claimTailBeforeReason = false;
    const pages: string[] = [];
    const page0Body = lastUpgradeByName('vl-reason');
    if (page0Body) pages.push(page0Body);
    for (let i = 0; i < 30; i++) {
      bridge.textContainerUpgrade.mockClear();
      await scrollActiveReason(1);
      const next = lastUpgradeByName('vl-reason');
      if (!next) break;
      pages.push(next);
    }
    for (let i = 0; i < pages.length; i++) {
      const body = pages[i]!;
      const slutordIdx = body.indexOf('SLUTORD');
      const reasonIdx = body.indexOf('quick brown');
      if (slutordIdx >= 0) {
        sawClaimTail = true;
        // Within this page, SLUTORD must precede 'quick brown' (or 'quick
        // brown' might not be on this page yet, which is fine).
        if (reasonIdx < 0 || slutordIdx < reasonIdx) {
          if (!sawReasonText) claimTailBeforeReason = true;
        }
      }
      if (reasonIdx >= 0) sawReasonText = true;
    }
    expect(sawClaimTail).toBe(true);
    expect(sawReasonText).toBe(true);
    expect(claimTailBeforeReason).toBe(true);
  });

  it('discreet mode body fits a short fact-check on a single page (no continuation)', async () => {
    // A short single-claim fact-check (~95-char heading + short reason)
    // composes into ~5 lines of unified body, well under the discreet 10-line
    // page budget — so no continuation page is created.
    await saveDiscreet(fakeSetLs, true);
    setActiveLayout('discreet-minimal');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const claim = 'Danske Banks tilbud har en ÅOP på 3,86%, mens Teslas er 1,30%.';
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim, reason: 'short' }],
    });

    // Page 0's body should hold the entire content: heading + verdict + reason.
    const body = lastUpgradeByName('vl-reason')!;
    expect(body).toContain(claim);
    expect(body).toContain('+ TRUE');
    expect(body).toContain('short');
    // The result has a single page, so swipe-down past it hides the answer
    // rather than no-op'ing — the "no more pages to scroll" outcome.
    const outcome = await scrollActiveReason(1);
    expect(outcome).toBe('hidden');
  });

  it('history-detail entry hop still fires at the flat-page edges', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const e1: HistoryEntry = {
      id: 'h1', timestamp: 2, sessionId: 's',
      lensId: 'fact-checker', lensName: 'Fact Check', question: 'q1',
      badge: 'TRUE', quote: '',
      result: { type: 'fact-check', claims: [{ quote: '', verdict: 'TRUE', claim: 'c1', reason: 'r1' }] },
    };
    const e2: HistoryEntry = {
      id: 'h2', timestamp: 1, sessionId: 's',
      lensId: 'fact-checker', lensName: 'Fact Check', question: 'q2',
      badge: 'FALSE', quote: '',
      result: { type: 'fact-check', claims: [{ quote: '', verdict: 'FALSE', claim: 'c2', reason: 'r2' }] },
    };
    await showHistoryListPage([e1, e2]);
    await showHistoryDetailPage(e1);

    // e1's body fits on one page — swipe-down should hop to e2 and rebuild
    // with the new entry's unified body in the body container.
    bridge.rebuildPageContainer.mockClear();
    await scrollHistoryDetail(1);
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce();
    const calls = bridge.rebuildPageContainer.mock.calls as unknown as Array<[RebuildBag]>;
    const payload = calls.at(-1)![0].payload;
    const body = payload.textObject.find((t) => t.payload.containerName === 'vl-reason');
    expect(body?.payload.content).toContain('c2');
  });
});

// =========================================================================
// Regression guards for the unified-body refactor.
//
// These tests lock in the behavioural contract the user requested when we
// collapsed the claim/verdict/reason slots into one full-screen text box:
//   1. each lens type composes a recognisable unified body
//   2. typical Meeting Prep results fit on one page (no unnecessary split)
//   3. truly over-long content still paginates
//   4. multi-claim navigation still walks one page-set per claim
//   5. a scroll within a mode never triggers a layout rebuild
//   6. the rendered page has a single body container (not 3 positioned slots)
// =========================================================================
describe('unified-body regression guards', () => {
  type TextBag = { payload: { containerName: string; content: string } };
  type RebuildBag = { payload: { containerTotalNum: number; textObject: TextBag[]; listObject: unknown[] } };

  function lastRebuildPayload(): RebuildBag['payload'] {
    const calls = bridge.rebuildPageContainer.mock.calls as unknown as Array<[RebuildBag]>;
    return calls.at(-1)![0].payload;
  }
  function lastUpgradeByName(name: string): string | undefined {
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[TextBag]>;
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i]![0].payload.containerName === name) return calls[i]![0].payload.content;
    }
    return undefined;
  }
  function bodyCallCount(): number {
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[TextBag]>;
    return calls.filter((c) => c[0].payload.containerName === 'vl-reason').length;
  }

  it('composes the unified body per lens type with blank-line separators', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    // Fact-check: "1/1 · " prefix + top + verdict + reason
    bridge.textContainerUpgrade.mockClear();
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'C', reason: 'R' }],
    });
    expect(lastUpgradeByName('vl-reason')).toBe('1/1 · C\n\n+ TRUE\n\nR');

    // ELI5: no top, no middle → just the explanation, prefixed with "1/1 · ".
    bridge.textContainerUpgrade.mockClear();
    await setLensResult({ type: 'eli5', claims: [{ quote: '', explanation: 'because reasons' }] });
    expect(lastUpgradeByName('vl-reason')).toBe('1/1 · because reasons');

    // Meeting-prep answer: "1/1 · " prefix + heading + detail + "From: …".
    // Source attribution sits at the BOTTOM so the answer→detail flow isn't
    // interrupted by the source line.
    bridge.textContainerUpgrade.mockClear();
    await setLensResult({
      type: 'meeting-prep',
      claims: [{ kind: 'answer', text: '4.2% beats your 4.8%', source: 'Bank contract', detail: 'Saves ~€120/month' }],
    });
    const body = lastUpgradeByName('vl-reason')!;
    expect(body).toContain('4.2% beats your 4.8%');
    expect(body).toContain('Saves ~€120/month');
    expect(body).toContain('From: Bank contract');
    // Sections separated by blank lines; "1/1 · " sits inline on the heading.
    expect(body.split('\n\n')).toEqual([
      '1/1 · 4.2% beats your 4.8%',
      'Saves ~€120/month',
      'From: Bank contract',
    ]);
  });

  it('omits empty sections instead of leaving stray blank lines', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    bridge.textContainerUpgrade.mockClear();

    // Meeting-prep follow-up: top only (no source, no detail). The "1/1 · "
    // prefix lands on the heading line.
    await setLensResult({
      type: 'meeting-prep',
      claims: [{ kind: 'followup', text: 'Did you compare ECB fixed-rate?', source: '', detail: '' }],
    });
    const body = lastUpgradeByName('vl-reason')!;
    // No trailing blanks, no doubled \n\n\n\n separator.
    expect(body).toBe('1/1 · → Did you compare ECB fixed-rate?');
    expect(body).not.toContain('\n\n\n');
  });

  it('fits a typical Meeting Prep answer (heading + source + 180-char detail) on one page', async () => {
    // This is THE regression — under the old 3-slot layout, a ~180-char detail
    // spilled onto a near-empty scroll page. Under the unified layout (10 lines
    // in discreet) the entire body fits on one page, so no swipe is needed.
    await saveDiscreet(fakeSetLs, true);
    setActiveLayout('discreet-minimal');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const detail = 'Saves about one hundred and twenty euros per month if locked in before June; consider the five-year fixed for an inflation buffer.';
    bridge.textContainerUpgrade.mockClear();
    bridge.rebuildPageContainer.mockClear();
    await setLensResult({
      type: 'meeting-prep',
      claims: [{ kind: 'answer', text: '4.2% beats your 4.8%', source: 'Bank contract', detail }],
    });

    // The whole body should be a single page — exactly one body upgrade and
    // swipe-down past the first page hides the answer (not "scroll to page 2").
    expect(bodyCallCount()).toBe(1);
    const outcome = await scrollActiveReason(1);
    expect(outcome).toBe('hidden');
  });

  it('over-long content still paginates across multiple pages of unified body', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    // ~600-char reason — well over any per-page budget.
    const longReason = ('The quick brown fox jumps over the lazy dog. ').repeat(20);
    bridge.textContainerUpgrade.mockClear();
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'C', reason: longReason }],
    });

    const page0 = lastUpgradeByName('vl-reason')!;
    expect(page0).toBeDefined();

    // Walking forward should produce at least one continuation page.
    let extraPages = 0;
    let safety = 30;
    while (safety-- > 0) {
      bridge.textContainerUpgrade.mockClear();
      const outcome = await scrollActiveReason(1);
      if (outcome === 'hidden' || outcome === 'noop') break;
      const next = lastUpgradeByName('vl-reason');
      if (!next || next === page0) break;
      extraPages++;
    }
    expect(extraPages).toBeGreaterThanOrEqual(1);
  });

  it('flattens Meeting Prep claims into one entry body — content packs into ≤2 pages instead of one-page-per-claim', async () => {
    // Meeting Prep is one session entry by design (answer + evidence +
    // followup belong to one question). Claims are flattened into a single
    // entry body so they pack efficiently — instead of always 3 pages (one
    // per claim) like the old per-claim model, short content fits in 1-2
    // pages.
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    bridge.textContainerUpgrade.mockClear();
    await setLensResult({
      type: 'meeting-prep',
      claims: [
        { kind: 'answer',   text: 'A', source: 'S', detail: 'D' },
        { kind: 'evidence', text: 'E', source: 'S', detail: '' },
        { kind: 'followup', text: 'F', source: '',  detail: '' },
      ],
    });

    // Walk all pages and collect the body text.
    const pages: string[] = [lastUpgradeByName('vl-reason')!];
    let safety = 5;
    while (safety-- > 0) {
      bridge.textContainerUpgrade.mockClear();
      const outcome = await scrollActiveReason(1);
      if (outcome !== 'scrolled') break;
      pages.push(lastUpgradeByName('vl-reason')!);
    }

    // All three claims must appear somewhere across the pages.
    const combined = pages.join('\n');
    expect(combined).toContain('A');           // answer text
    expect(combined).toContain('D');           // detail
    expect(combined).toContain('From: S');     // source
    expect(combined).toContain('"E"');         // evidence quote
    expect(combined).toContain('→ F');         // followup arrow

    // Packs into ≤2 pages (was 3 pages with the old one-page-per-claim model).
    expect(pages.length).toBeLessThanOrEqual(2);
  });

  it('multi-entry sessions still get X/Y position tags on the unified body', async () => {
    // Sanity guard that the session-relative X/Y tag still appears when the
    // session actually has multiple entries (the per-claim split paths used
    // by fact-check / bias / etc.).
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    bridge.textContainerUpgrade.mockClear();
    await setLensResult({
      type: 'fact-check',
      claims: [
        { quote: '', verdict: 'TRUE',  claim: 'A', reason: 'rA' },
        { quote: '', verdict: 'FALSE', claim: 'B', reason: 'rB' },
      ],
    });
    expect(lastUpgradeByName('vl-reason')).toContain('A');
    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(1);
    expect(lastUpgradeByName('vl-reason')).toContain('B');
  });

  it('scrolling within a layout never rebuilds the page container — only upgrades the body', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const longReason = ('alpha beta gamma delta epsilon zeta eta theta iota kappa ').repeat(25);
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'C', reason: longReason }],
    });
    bridge.rebuildPageContainer.mockClear();
    bridge.textContainerUpgrade.mockClear();

    // Multiple scrolls within the same baseline layout — no rebuilds.
    for (let i = 0; i < 3; i++) {
      const outcome = await scrollActiveReason(1);
      if (outcome === 'hidden' || outcome === 'noop') break;
    }
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled();
    expect(bridge.textContainerUpgrade.mock.calls.length).toBeGreaterThan(0);
  });

  it('the baseline result layout has exactly one result text container (not 3 positioned slots)', async () => {
    await saveDiscreet(fakeSetLs, false);
    setActiveLayout('baseline');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const payload = lastRebuildPayload();
    const resultContainers = payload.textObject.filter((t) =>
      t.payload.containerName === 'vl-reason'
      || t.payload.containerName === 'vl-claim'
      || t.payload.containerName === 'vl-verdict'
      || t.payload.containerName === 'vl-compact'
    );
    expect(resultContainers).toHaveLength(1);
    expect(resultContainers[0]!.payload.containerName).toBe('vl-reason');
  });

  it('Meeting Prep with long content paginates the flattened entry body into multiple pages', async () => {
    // With claim-flattening, a multi-claim Meeting Prep result still
    // paginates when the combined content exceeds the page budget. The wearer
    // gets bullets at the bottom showing within-entry page position and can
    // walk pages symmetrically.
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    // Long detail so the flattened body exceeds the per-page line budget.
    const longDetail = ('This is a long answer detail sentence. ').repeat(15);
    await setLensResult({
      type: 'meeting-prep',
      claims: [
        { kind: 'answer',   text: 'A', source: 'S', detail: longDetail },
        { kind: 'evidence', text: 'E', source: 'S', detail: '' },
        { kind: 'followup', text: 'F', source: '',  detail: '' },
      ],
    });

    // Page 0 should have a bullet row at the bottom because the entry is
    // multi-page now.
    const page0 = lastUpgradeByName('vl-reason')!;
    expect(page0).toMatch(/●/);

    // Swipe forward → next page of the same entry. Swipe back → page 0.
    // Symmetric.
    bridge.textContainerUpgrade.mockClear();
    const forward = await scrollActiveReason(1);
    expect(forward).toBe('scrolled');

    bridge.textContainerUpgrade.mockClear();
    const back = await scrollActiveReason(-1);
    expect(back).toBe('scrolled');
    expect(lastUpgradeByName('vl-reason')).toBe(page0);

    // Swipe-up at sessionPageIndex=0 → noop.
    bridge.textContainerUpgrade.mockClear();
    const noop = await scrollActiveReason(-1);
    expect(noop).toBe('noop');
  });

  it('always shows session-relative X/Y (even 1/1 for a 1-entry session); bullets only on multi-page entries', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    // Single-entry single-page: "1/1 · " prefix, no bullets.
    bridge.textContainerUpgrade.mockClear();
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'C', reason: 'R' }],
    });
    const shortBody = lastUpgradeByName('vl-reason')!;
    expect(shortBody).toBe('1/1 · C\n\n+ TRUE\n\nR');
    expect(shortBody).not.toMatch(/[●○]/);

    // Single-entry multi-page (Meeting Prep with a long detail): "1/1 · "
    // prefix on every page; bullets at the bottom show within-entry page
    // position.
    bridge.textContainerUpgrade.mockClear();
    const longDetail = ('This is a long answer detail sentence. ').repeat(15);
    await setLensResult({
      type: 'meeting-prep',
      claims: [{ kind: 'answer', text: 'A', source: 'S', detail: longDetail }],
    });
    const page0 = lastUpgradeByName('vl-reason')!;
    expect(page0.startsWith('1/1 · ')).toBe(true);
    expect(page0).toMatch(/●/);
  });

  it('multi-entry sessions show session-relative X/Y on every page (constant within an entry, changes across entries)', async () => {
    // Two single-page Meeting Prep entries → every page of Q1 starts with
    // "1/2 · ", every page of Q2 starts with "2/2 · ". The wearer always
    // sees which question they're on; the indicator only changes when the
    // page sequence crosses into the next entry.
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const mkEntry = (id: string, text: string): HistoryEntry => ({
      id, timestamp: 1, sessionId: 's',
      lensId: 'meeting-prep', lensName: 'Meeting Prep', question: text,
      badge: '', quote: '',
      result: { type: 'meeting-prep', claims: [
        { kind: 'answer', text, source: 'Src', detail: 'Detail' },
      ] },
    });
    const e1 = mkEntry('e1', 'Q1');
    const e2 = mkEntry('e2', 'Q2');

    bridge.textContainerUpgrade.mockClear();
    await setLensResult(e2.result, { sessionEntries: [e1, e2], newEntryIds: new Set(['e2']) });
    expect(lastUpgradeByName('vl-reason')!.startsWith('2/2 · Q2')).toBe(true);

    bridge.textContainerUpgrade.mockClear();
    const outcome = await scrollActiveReason(-1);
    expect(outcome).toBe('scrolled');
    expect(lastUpgradeByName('vl-reason')!.startsWith('1/2 · Q1')).toBe(true);
  });

  it('session-relative X/Y stays constant while scrolling within the same entry, then changes on entry crossover', async () => {
    // Q1 with a long detail (multi-page), Q2 with a short answer (single-
    // page). Every page of Q1 should start with "1/2 · "; Q2's single page
    // starts with "2/2 · ".
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const longDetail = ('Detail sentence here. ').repeat(20);
    const e1: HistoryEntry = {
      id: 'e1', timestamp: 1, sessionId: 's',
      lensId: 'meeting-prep', lensName: 'Meeting Prep', question: 'Q1',
      badge: '', quote: '',
      result: { type: 'meeting-prep', claims: [
        { kind: 'answer', text: 'Q1', source: 'S', detail: longDetail },
      ] },
    };
    const e2: HistoryEntry = {
      id: 'e2', timestamp: 1, sessionId: 's',
      lensId: 'meeting-prep', lensName: 'Meeting Prep', question: 'Q2',
      badge: '', quote: '',
      result: { type: 'meeting-prep', claims: [
        { kind: 'answer', text: 'Q2', source: 'S', detail: 'short' },
      ] },
    };

    await setLensResult(e1.result, { sessionEntries: [e1, e2], newEntryIds: new Set(['e1']) });

    // Walk to the start: jump back to Q1's first page.
    let safety = 30;
    while (safety-- > 0) {
      const cur = lastUpgradeByName('vl-reason') ?? '';
      if (cur.startsWith('1/2 · Q1')) break;
      bridge.textContainerUpgrade.mockClear();
      const outcome = await scrollActiveReason(-1);
      if (outcome !== 'scrolled') break;
    }
    expect(lastUpgradeByName('vl-reason')!.startsWith('1/2 · Q1')).toBe(true);

    // Advance forward; every page until Q2's start must still say "1/2 · ".
    let crossedToQ2 = false;
    safety = 30;
    while (safety-- > 0) {
      bridge.textContainerUpgrade.mockClear();
      const outcome = await scrollActiveReason(1);
      if (outcome !== 'scrolled') break;
      const cur = lastUpgradeByName('vl-reason')!;
      if (cur.startsWith('2/2 · ')) { crossedToQ2 = true; break; }
      expect(cur.startsWith('1/2 · ')).toBe(true);
    }
    expect(crossedToQ2).toBe(true);
  });

  it('swipe is symmetric: n swipes-down followed by n swipes-up returns to the starting page', async () => {
    // Two single-page Meeting Prep entries form a 2-page session. Swipe down
    // 1× from Q1 → Q2. Swipe up 1× → Q1. Symmetric.
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const mkEntry = (id: string, text: string): HistoryEntry => ({
      id, timestamp: 1, sessionId: 's',
      lensId: 'meeting-prep', lensName: 'Meeting Prep', question: text,
      badge: '', quote: '',
      result: { type: 'meeting-prep', claims: [
        { kind: 'answer', text, source: 'S', detail: 'D' },
      ] },
    });
    const e1 = mkEntry('e1', 'Q1');
    const e2 = mkEntry('e2', 'Q2');

    await setLensResult(e2.result, { sessionEntries: [e1, e2], newEntryIds: new Set(['e2']) });
    expect(lastUpgradeByName('vl-reason')!.startsWith('2/2 · Q2')).toBe(true);

    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(-1);
    expect(lastUpgradeByName('vl-reason')!.startsWith('1/2 · Q1')).toBe(true);

    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(1);
    expect(lastUpgradeByName('vl-reason')!.startsWith('2/2 · Q2')).toBe(true);
  });

  it('the active-page body container captures events itself (isEventCapture=1)', async () => {
    // Regression: if the body is isEventCapture=0 with a sink behind it, the
    // body blocks swipes from reaching the sink on this hardware — and the
    // wearer can no longer swipe back to the previous question on the
    // recording screen. Lock it in for both modes.
    type PayloadBag = { payload: { containerName: string; isEventCapture: number } };

    // Baseline mode.
    await saveDiscreet(fakeSetLs, false);
    setActiveLayout('baseline');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    let payload = lastRebuildPayload();
    let body = (payload.textObject as unknown as PayloadBag[]).find((t) => t.payload.containerName === 'vl-reason');
    expect(body).toBeDefined();
    expect(body!.payload.isEventCapture).toBe(1);

    // Discreet-result mode.
    await saveDiscreet(fakeSetLs, true);
    setActiveLayout('discreet-result');
    await showActivePage(getPersona('fact-checker')!);
    payload = lastRebuildPayload();
    body = (payload.textObject as unknown as PayloadBag[]).find((t) => t.payload.containerName === 'vl-reason');
    expect(body).toBeDefined();
    expect(body!.payload.isEventCapture).toBe(1);
  });

  it('the history-detail layout has exactly one result text container', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    const entry: HistoryEntry = {
      id: 'h', timestamp: 1, sessionId: 's',
      lensId: 'fact-checker', lensName: 'Fact Check', question: 'q',
      badge: 'TRUE', quote: '',
      result: { type: 'fact-check', claims: [{ quote: '', verdict: 'TRUE', claim: 'c', reason: 'r' }] },
    };
    await showHistoryDetailPage(entry);

    const payload = lastRebuildPayload();
    const resultContainers = payload.textObject.filter((t) =>
      t.payload.containerName === 'vl-reason'
      || t.payload.containerName === 'vl-claim'
      || t.payload.containerName === 'vl-verdict'
      || t.payload.containerName === 'vl-compact'
    );
    expect(resultContainers).toHaveLength(1);
    expect(resultContainers[0]!.payload.containerName).toBe('vl-reason');
  });
});
