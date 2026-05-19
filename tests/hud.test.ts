// tests/hud.test.ts
//
// Behaviour-lock tests for src/runtime/hud.ts.
// HUD code talks to the SDK via getBridge(); we stub the bridge so the tests
// stay in-process. The session-state regression at the bottom is `.skip`-ed
// until Pass 1 exposes resetHudSessionState() (currently named
// _resetHudBootstrapForTesting).

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  MENU_OPTIONS,
  menuOptionAtIndex,
  personaAtIndex,
  resetHudSessionState,
  scrollActiveReason,
  scrollHistoryDetail,
  setLensResult,
  setRecIndicator,
  showActivePage,
  showHistoryDetailPage,
  showHistoryListPage,
  showMenuPage,
  showPickerPage,
  showUnconfiguredPage,
} from '../src/runtime/hud';
import { getPersona, getPickerPersonas } from '../src/personas';
import type { HistoryEntry, LensResult } from '../src/types';

beforeEach(() => {
  _resetHudBootstrapForTesting();
  vi.clearAllMocks();
  bridge.createStartUpPageContainer.mockResolvedValue(0);
  bridge.rebuildPageContainer.mockResolvedValue(true);
  bridge.textContainerUpgrade.mockResolvedValue(true);
});

describe('personaAtIndex', () => {
  it('returns the persona at the given index (within picker list)', () => {
    const list = getPickerPersonas(120);
    const persona = personaAtIndex(1);
    expect(persona).not.toBeNull();
    expect(persona!.id).toBe(list[1]!.id);
  });

  it('falls back to the first persona when index is undefined / negative', () => {
    const first = getPickerPersonas(120)[0]!;
    expect(personaAtIndex(undefined)!.id).toBe(first.id);
    expect(personaAtIndex(-5)!.id).toBe(first.id);
  });

  it('falls back to the first persona when index is out of range', () => {
    const first = getPickerPersonas(120)[0]!;
    expect(personaAtIndex(999)!.id).toBe(first.id);
  });
});

describe('menuOptionAtIndex', () => {
  it('returns each menu option id by index', () => {
    for (let i = 0; i < MENU_OPTIONS.length; i++) {
      expect(menuOptionAtIndex(i)).toBe(MENU_OPTIONS[i]!.id);
    }
  });

  it('falls back to "fact-check" for invalid indices', () => {
    expect(menuOptionAtIndex(99)).toBe('fact-check');
    expect(menuOptionAtIndex(undefined)).toBe('fact-check');
    expect(menuOptionAtIndex(-1)).toBe('fact-check');
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

    await showMenuPage('12:34');
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
      badge: 'TRUE',
      result: { type: 'fact-check', verdict: 'TRUE', claim: 'c', reason: longReason },
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
      badge: 'TRUE',
      result: { type: 'fact-check', verdict: 'TRUE', claim: 'c', reason: 'short' },
    };
    await showHistoryDetailPage(entry);
    bridge.textContainerUpgrade.mockClear();
    await scrollHistoryDetail(-1);
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
  });
});

describe('setLensResult', () => {
  it('upgrades claim / verdict / reason on the active page', async () => {
    await bootstrapHud('picker');
    const persona = getPersona('fact-checker')!;
    await showActivePage(persona);
    bridge.textContainerUpgrade.mockClear();

    const result: LensResult = {
      type: 'fact-check', verdict: 'TRUE', claim: 'The Earth is round.',
      reason: 'Established by science.',
    };
    await setLensResult(result);
    // 3 upgrades: claim, verdict, reason
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(3);
  });

  it('is a no-op when the current page is neither active nor history-detail', async () => {
    await bootstrapHud('picker');
    bridge.textContainerUpgrade.mockClear();
    await setLensResult({ type: 'eli5', explanation: 'foo' });
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
  });

  it('prefixes the claim with "Auto · " when autoSelected is set', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);
    bridge.textContainerUpgrade.mockClear();

    const result: LensResult = {
      type: 'fact-check', verdict: 'TRUE', claim: 'X', reason: 'Y', autoSelected: true,
    };
    await setLensResult(result);
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[{ payload: { containerName: string; content: string } }]>;
    const claimCall = calls.find((c) => c[0].payload.containerName === 'vl-claim');
    expect(claimCall).toBeDefined();
    expect(claimCall![0].payload.content).toContain('Auto');
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
      lensId: 'trivia', lensName: 'Trivia', question: 'q', badge: 'ANSWER',
      result: { type: 'trivia', question: 'q', answer: 'a', description: 'd' },
    }];
    await showHistoryListPage(entries);
    expect(currentHudPage()).toBe('history-list');
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
      type: 'fact-check', verdict: 'TRUE', claim: 'c', reason: longReason,
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
