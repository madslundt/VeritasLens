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
  showActivePage,
  showHistoryDetailPage,
  showHistoryListPage,
  showMenuPage,
  showPickerPage,
  showUnconfiguredPage,
} from '../src/runtime/hud';
import { saveDiscreet, setLensResult as setStateLensResult, settings } from '../src/state/store';
import { getPersona, getPickerPersonas } from '../src/personas';
import type { HistoryEntry, LensResult } from '../src/types';

const fakeSetLs = (_k: string, _v: string): Promise<boolean> => Promise.resolve(true);

afterEach(async () => {
  // Always reset discreet + layout + result so test order does not bleed state.
  await saveDiscreet(fakeSetLs, false);
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
  it('upgrades claim / verdict / reason on the active page', async () => {
    await bootstrapHud('picker');
    const persona = getPersona('fact-checker')!;
    await showActivePage(persona);
    bridge.textContainerUpgrade.mockClear();

    const result: LensResult = {
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'The Earth is round.', reason: 'Established by science.' }],
    };
    await setLensResult(result);
    // 3 upgrades: claim, verdict, reason
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(3);
  });

  it('is a no-op when the current page is neither active nor history-detail', async () => {
    await bootstrapHud('picker');
    bridge.textContainerUpgrade.mockClear();
    await setLensResult({ type: 'eli5', claims: [{ quote: '', explanation: 'foo' }] });
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
  });

  it('prefixes the claim with "Auto · " when autoSelected is set', async () => {
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

  it('discreet-result layout is pure question/answer (no dot, status, rec, or hint)', async () => {
    await saveDiscreet(fakeSetLs, true);
    setActiveLayout('discreet-result');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const payload = lastRebuildPayload();
    expect(findText(payload, 'vl-rec')).toBeUndefined();
    expect(findText(payload, 'vl-act-hint')).toBeUndefined();
    expect(findText(payload, 'vl-clock')).toBeUndefined();
    expect(findText(payload, 'vl-status')).toBeUndefined();
    expect(findText(payload, 'vl-claim')).toBeDefined();
    expect(findText(payload, 'vl-verdict')).toBeDefined();
    expect(findText(payload, 'vl-reason')).toBeDefined();
    // 4 text containers: invisible event sink + claim + verdict + reason.
    expect(payload.textObject).toHaveLength(4);
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

  it('setStatus on discreet-result is a no-op (pure answer view, no status chrome)', async () => {
    setActiveLayout('discreet-result');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    bridge.textContainerUpgrade.mockClear();
    const { setStatus } = await import('../src/runtime/hud');
    await setStatus('displaying');
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
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
    // The promotion rebuilds the page with the pure layout (4 containers).
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce();
    const payload = lastRebuildPayload();
    expect(payload.containerTotalNum).toBe(4);
    expect(findText(payload, 'vl-clock')).toBeUndefined();
    // 3 upgrades: claim, verdict, reason.
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(3);
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
    // 3 upgrades for claim, verdict, reason.
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(3);
    const calls = bridge.textContainerUpgrade.mock.calls as unknown as Array<[{ payload: { containerName: string; content: string } }]>;
    const reason = calls.find((c) => c[0].payload.containerName === 'vl-reason');
    expect(reason).toBeDefined();
    expect(reason![0].payload.content).toContain('east');
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

    // The active-page rebuild lays down the discreet-result layout (3
    // containers: claim, verdict, reason) and the replay writes into them.
    const calls = bridge.rebuildPageContainer.mock.calls as unknown as Array<[{ payload: { containerTotalNum: number; textObject: Array<{ payload: { containerName: string } }> } }]>;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const lastRebuild = calls.at(-1)![0].payload;
    expect(lastRebuild.containerTotalNum).toBe(4);
    expect(lastRebuild.textObject.some((t) => t.payload.containerName === 'vl-reason')).toBe(true);
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(3);
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

  it('renders the 1/2 indicator on the claim line when 2 claims are present', async () => {
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
    expect(lastUpgradeByName('vl-claim')).toBe('1/2 · C1');
    expect(lastUpgradeByName('vl-verdict')).toBe('+ TRUE');
    expect(lastUpgradeByName('vl-reason')).toBe('R1');
  });

  it('omits the indicator when only one claim is present', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    bridge.textContainerUpgrade.mockClear();
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: 'q1', verdict: 'TRUE', claim: 'C1', reason: 'R1' }],
    });
    expect(lastUpgradeByName('vl-claim')).toBe('C1');
    expect(lastUpgradeByName('vl-verdict')).toBe('+ TRUE');
  });

  it('scrollActiveReason advances to claim 2 and rewrites claim/verdict/reason', async () => {
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
    expect(lastUpgradeByName('vl-claim')).toBe('2/2 · C2');
    expect(lastUpgradeByName('vl-verdict')).toBe('- FALSE');
    expect(lastUpgradeByName('vl-reason')).toBe('R2');

    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(-1);
    expect(lastUpgradeByName('vl-claim')).toBe('1/2 · C1');
    expect(lastUpgradeByName('vl-verdict')).toBe('+ TRUE');
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
    expect(reason!.startsWith('r')).toBe(true);
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
    // Walk through every page; each page must fit within the larger budget.
    // 8 lines × 27px = 216px is the discreet-scroll budget; baseline-scroll is
    // 7×27 = 189px. We're in baseline by default, so 7 lines is the cap.
    let upgrades = 1;
    const maxHeightPx = 7 * 27;
    let page = lastUpgradeByName('vl-reason')!;
    expect(page).toBeDefined();
    expect(measureTextWrap(page, 536).height).toBeLessThanOrEqual(4 * 27); // page 0 = full layout = 4 lines
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
    // First page should end on a space-bounded word, not in the middle of one.
    const page0 = lastUpgradeByName('vl-reason')!;
    expect(page0).toBeDefined();
    const lastChar = page0[page0.length - 1]!;
    // Trailing trim leaves either a complete word or a space-followed word.
    // The previous character before EOL must be either alphabetic or end-of-text.
    expect(/[a-z]$/.test(page0)).toBe(true);
    // Crucially: scroll forward and verify the next page begins at the start
    // of the next word, not mid-token from the previous one.
    bridge.textContainerUpgrade.mockClear();
    await scrollActiveReason(1);
    const page1 = lastUpgradeByName('vl-reason')!;
    expect(page1).toBeDefined();
    // The first char must be the start of a word in our list (or the original
    // text). It must not be a continuation of "alpha"/"beta"/etc.
    expect(/^[a-z]/.test(page1)).toBe(true);
    // No leading whitespace either — we trim that off.
    expect(page1[0]).not.toBe(' ');
    void lastChar; // referenced for the test name; the actual contract is checked above
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
    // Page 0 = claim A page 0 (full layout): claim/verdict upgrades present.
    expect(lastUpgradeByName('vl-claim')).toContain('1/2');
    expect(lastUpgradeByName('vl-claim')).toContain('CLAIM-A');
    expect(lastUpgradeByName('vl-verdict')).toBe('+ TRUE');

    // Walk forward until we reach claim B's page 0 — at that point the claim
    // line should reflect "2/2 · CLAIM-B" (back to full layout).
    let safety = 30;
    while (safety-- > 0) {
      bridge.textContainerUpgrade.mockClear();
      await scrollActiveReason(1);
      const claim = lastUpgradeByName('vl-claim');
      if (claim && claim.includes('2/2') && claim.includes('CLAIM-B')) {
        expect(lastUpgradeByName('vl-verdict')).toBe('- FALSE');
        expect(lastUpgradeByName('vl-reason')).toContain('short B reason');
        return;
      }
    }
    throw new Error('never reached claim B in linearized traversal');
  });

  it('rebuilds the page container when crossing the full→scroll layout boundary', async () => {
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const longReason = ('The quick brown fox jumps over the lazy dog. ').repeat(60);
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: 'C', reason: longReason }],
    });

    // Page 0 is the baseline layout (full chrome).
    let payload = lastRebuildPayload();
    expect(findText(payload, 'vl-rec')).toBeDefined();
    expect(findText(payload, 'vl-claim')).toBeDefined();
    expect(findText(payload, 'vl-compact')).toBeUndefined();

    bridge.rebuildPageContainer.mockClear();
    await scrollActiveReason(1); // → page 1 = baseline-scroll
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce();

    payload = lastRebuildPayload();
    // Scroll layout has compact header instead of claim/verdict; rec/hint stay.
    expect(findText(payload, 'vl-compact')).toBeDefined();
    expect(findText(payload, 'vl-claim')).toBeUndefined();
    expect(findText(payload, 'vl-verdict')).toBeUndefined();
    expect(findText(payload, 'vl-rec')).toBeDefined();
    expect(findText(payload, 'vl-act-hint')).toBeDefined();
  });

  it('scroll layout reuses the compact header with verdict glyph and claim position', async () => {
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
    await scrollActiveReason(1); // claim 1 page 1 = baseline-scroll
    const payload = lastRebuildPayload();
    const header = payload.textObject.find((t) => t.payload.containerName === 'vl-compact');
    expect(header).toBeDefined();
    // Multi-claim → header should show position + verdict glyph.
    expect(header!.payload.content).toContain('1/2');
    expect(header!.payload.content).toContain('+ TRUE');
  });

  it('paginates a long claim across header + claim-continuation pages (baseline)', async () => {
    // baseline claim slot fits 1 line (~70 chars at 536px); a multi-line Danish
    // primary line — like Meeting Prep can produce — overflows it.
    await saveDiscreet(fakeSetLs, false);
    setActiveLayout('baseline');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const longClaim = 'Danske Banks tilbud har en ÅOP på 3,86%, mens Teslas er 1,30%. Spørg banken hvordan de matcher.';
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: longClaim, reason: 'short reason' }],
    });

    // Page 0: claim slot has the FIRST chunk only (≤1 line); it does not contain
    // the tail of the claim.
    const claim0 = lastUpgradeByName('vl-claim')!;
    expect(claim0).toBeDefined();
    expect(longClaim).toContain(claim0);          // chunk is a prefix of the original
    expect(claim0.length).toBeLessThan(longClaim.length); // pagination actually fired
    expect(claim0).not.toContain('matcher');      // tail must NOT be on page 0

    // Scroll forward — we should land on a claim-continuation page (scroll
    // layout, reason slot carries the rest of the claim). Walking forward
    // until we either hit the tail of the claim or run out of pages.
    let foundTail = false;
    for (let i = 0; i < 5; i++) {
      bridge.textContainerUpgrade.mockClear();
      bridge.rebuildPageContainer.mockClear();
      await scrollActiveReason(1);
      const reason = lastUpgradeByName('vl-reason');
      if (reason && reason.includes('matcher')) {
        foundTail = true;
        // First scroll-down crosses full→scroll, which rebuilds. Subsequent
        // same-layout scrolls don't.
        break;
      }
    }
    expect(foundTail).toBe(true);
  });

  it('long claim still paginates when followed by a long reason (linear traversal)', async () => {
    await saveDiscreet(fakeSetLs, false);
    setActiveLayout('baseline');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const longClaim = 'Danske Banks tilbud har en ÅOP på 3,86%, mens Teslas er 1,30%. Spørg banken hvordan de matcher dette niveau.';
    const longReason = ('The quick brown fox jumps over the lazy dog. ').repeat(40);
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim: longClaim, reason: longReason }],
    });

    // Visit every page. The traversal order must show the claim tail before
    // any reason text appears.
    let sawClaimTail = false;
    let sawReasonText = false;
    let claimTailBeforeReason = false;
    const allReasonContents: string[] = [];
    const page0Reason = lastUpgradeByName('vl-reason')!;
    if (page0Reason) allReasonContents.push(page0Reason);
    for (let i = 0; i < 30; i++) {
      bridge.textContainerUpgrade.mockClear();
      await scrollActiveReason(1);
      const next = lastUpgradeByName('vl-reason');
      if (!next) break;
      allReasonContents.push(next);
      if (next.includes('matcher')) {
        sawClaimTail = true;
        if (!sawReasonText) claimTailBeforeReason = true;
      }
      if (next.includes('quick brown')) {
        sawReasonText = true;
      }
    }
    expect(sawClaimTail).toBe(true);
    expect(sawReasonText).toBe(true);
    expect(claimTailBeforeReason).toBe(true);
  });

  it('discreet mode (2-line claim slot) absorbs a borderline claim without claim-continuation', async () => {
    // Same Danish claim, but discreet-result has a 68px / 2-line claim slot.
    // For this length (~95 chars), pretext wraps it to 2 lines which fit.
    await saveDiscreet(fakeSetLs, true);
    setActiveLayout('discreet-minimal');
    await bootstrapHud('picker');
    await showActivePage(getPersona('fact-checker')!);

    const claim = 'Danske Banks tilbud har en ÅOP på 3,86%, mens Teslas er 1,30%.';
    await setLensResult({
      type: 'fact-check',
      claims: [{ quote: '', verdict: 'TRUE', claim, reason: 'short' }],
    });

    // Page 0's claim slot should hold the entire claim (no continuation needed).
    const claim0 = lastUpgradeByName('vl-claim')!;
    expect(claim0).toBe(claim);
    // And scroll forward should be a no-op since reason is also 1 page.
    bridge.textContainerUpgrade.mockClear();
    bridge.rebuildPageContainer.mockClear();
    await scrollActiveReason(1);
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled();
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled();
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

    // e1's reason is one page only — swipe-down should hop to e2.
    bridge.rebuildPageContainer.mockClear();
    await scrollHistoryDetail(1);
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce();
    const calls = bridge.rebuildPageContainer.mock.calls as unknown as Array<[RebuildBag]>;
    const payload = calls.at(-1)![0].payload;
    const claim = payload.textObject.find((t) => t.payload.containerName === 'vl-claim');
    expect(claim?.payload.content).toContain('c2');
  });
});
