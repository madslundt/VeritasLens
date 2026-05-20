// src/runtime/hud.ts
import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';
import { getBridge } from './bridge';
import { getPickerPersonas, type Persona } from '@/personas';
import { settings } from '@/state/store';
import type { HistoryEntry, LensResult } from '@/types';

/**
 * HUD layout for VeritasLens.
 *
 * Display: 576 × 288 px per eye, 4-bit greyscale (single channel, green).
 * Coordinates: origin top-left, x rightwards, y downwards.
 *
 * IMPORTANT: in practice (verified against the simulator) text containers
 * with `isEventCapture=1` only emit SCROLL_TOP_EVENT / SCROLL_BOTTOM_EVENT,
 * not CLICK_EVENT or DOUBLE_CLICK_EVENT. To capture taps we MUST use a
 * `ListContainerProperty` as the event capturer. So every page in this app
 * pairs a list container (events) with text containers (display).
 *
 * Pages:
 *   - "unconfigured"    : single visible message asking the user to configure on phone
 *   - "picker"          : list of registered personas; scroll moves SDK selection,
 *                         tap starts the highlighted one
 *   - "active"          : status / verdict / reason text + a small list at the
 *                         bottom that captures taps (single = menu, double = check)
 *   - "menu"            : four options (Check / History / Cancel / Exit)
 *   - "history-list"    : list of past questions with verdict badge
 *   - "history-detail"  : full result for a selected history entry
 */

export const SCREEN_W = 576;
export const SCREEN_H = 288;

export const CONTAINER = {
  // shared title region (always container 10)
  title: 10,
  // picker page
  pickerList: 11,
  // unconfigured / picker / menu hint at bottom
  pickerHint: 12,
  // menu page
  menuList: 13,
  // active page
  status: 20,
  claim: 21,
  verdict: 22,
  reason: 23,
  activeList: 24,
  recIndicator: 25,
  activeHint: 26,
  clock: 27,
  menuSpinner: 28,
  // history pages
  historyList: 30,
  historyHint: 31,
} as const;

const NAME = {
  title: 'vl-title',
  pickerList: 'vl-pick-lst',
  pickerHint: 'vl-pkr-hint',
  menuList: 'vl-menu-lst',
  status: 'vl-status',
  claim: 'vl-claim',
  verdict: 'vl-verdict',
  reason: 'vl-reason',
  activeList: 'vl-act-lst',
  recIndicator: 'vl-rec',
  activeHint: 'vl-act-hint',
  clock: 'vl-clock',
  menuSpinner: 'vl-menu-spin',
  historyList: 'vl-hist-lst',
  historyHint: 'vl-hist-hint',
} as const;

const STATUS_LABEL: Record<string, string> = {
  idle: 'OK',
  listening: '',
  thinking: '...',
  displaying: '✓',
  sleeping: 'ZZZ',
  error: 'ERR',
};

export type HudPage = 'unconfigured' | 'picker' | 'active' | 'menu' | 'history-list' | 'history-detail' | 'none';

export const ACTIVE_HINT_DEFAULT = 'Tap: menu · Double-tap: check';
export const ACTIVE_HINT_ANALYZING = 'Analyzing · Double-tap to cancel';

export const MENU_OPTIONS = [
  { id: 'back', label: '← Back' },
  { id: 'fact-check', label: 'Check' },
  { id: 'history', label: 'History' },
  { id: 'exit', label: 'Exit' },
] as const;
export type MenuOptionId = (typeof MENU_OPTIONS)[number]['id'];

const DETAIL_PAGE_CHARS = 200;
const ACTIVE_PAGE_CHARS = 200;
let detailReasonFull = '';
let detailReasonOffset = 0;
let activeReasonFull = '';
let activeReasonOffset = 0;
/**
 * For multi-claim results (fact / stats / fallacy / bias), tracks which claim
 * is currently rendered on the active page (0 or 1). Reset on every
 * setLensResult; scroll-down advances, scroll-up reverses. Single-claim
 * results leave this at 0 and fall back to reason pagination as before.
 */
let activeClaimIndex = 0;
let currentActiveResult: LensResult | null = null;
// Stash for results that arrive while the user is off the active page (e.g.
// they opened the menu while analysis was in flight). Consumed when the
// active page is next rebuilt, so the answer they were waiting for is
// surfaced on return instead of being silently dropped.
let pendingActiveResult: LensResult | null = null;
// Last menu-spinner frame written by setMenuSpinner. Used to seed
// buildMenuPage so the spinner is visible immediately when the user opens the
// menu mid-analysis (rather than waiting up to one ticker interval).
let pendingMenuSpinnerFrame = '';

let bootstrapped = false;
let currentPage: HudPage = 'none';
let menuPersona: Persona | null = null;
let cachedHistoryEntries: HistoryEntry[] = [];
/**
 * Sub-mode for the active page. Driven by the lifecycle, read by buildActivePage.
 *   - 'baseline'         : current default; REC + hint + full layout
 *   - 'discreet-minimal' : single recording dot only (no claim/REC/hint)
 *   - 'discreet-result'  : status + claim/verdict/reason + dot, no REC/hint
 */
export type ActiveLayout = 'baseline' | 'discreet-minimal' | 'discreet-result';
let activeLayout: ActiveLayout = 'baseline';
export function getActiveLayout(): ActiveLayout { return activeLayout; }
export function setActiveLayout(layout: ActiveLayout): void { activeLayout = layout; }
export function getHistoryListEntries(): HistoryEntry[] { return cachedHistoryEntries; }

export function currentHudPage(): HudPage { return currentPage; }

/** True iff a result arrived while the user was off the active page. */
export function hasPendingActiveResult(): boolean { return pendingActiveResult !== null; }

/** Look up the persona at the given index from the host event payload. */
export function personaAtIndex(idx: number | undefined | null): Persona | null {
  const list = getPickerPersonas(settings().bufferDuration);
  const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
  return list[safe] ?? list[0] ?? null;
}

/** Map list index → menu option id. */
export function menuOptionAtIndex(idx: number | undefined | null): MenuOptionId {
  const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
  return MENU_OPTIONS[safe]?.id ?? 'back';
}

export async function bootstrapHud(initialPage: 'unconfigured' | 'picker' = 'picker'): Promise<void> {
  if (bootstrapped) {
    if (initialPage === 'unconfigured') await showUnconfiguredPage();
    else await showPickerPage();
    return;
  }
  const page = initialPage === 'unconfigured' ? buildUnconfiguredPage('create') : buildPickerPage('create');
  const result = await getBridge().createStartUpPageContainer(page as CreateStartUpPageContainer);
  if (result !== StartUpPageCreateResult.success) {
    throw new Error(`createStartUpPageContainer failed (code ${result}).`);
  }
  bootstrapped = true;
  currentPage = initialPage;
}

export async function showUnconfiguredPage(): Promise<void> {
  if (!bootstrapped) { await bootstrapHud('unconfigured'); return; }
  const ok = await getBridge().rebuildPageContainer(buildUnconfiguredPage('rebuild') as RebuildPageContainer);
  if (!ok) throw new Error('rebuildPageContainer (unconfigured) failed.');
  currentPage = 'unconfigured';
}

export async function showPickerPage(): Promise<void> {
  if (!bootstrapped) { await bootstrapHud('picker'); return; }
  const ok = await getBridge().rebuildPageContainer(buildPickerPage('rebuild') as RebuildPageContainer);
  if (!ok) throw new Error('rebuildPageContainer (picker) failed.');
  currentPage = 'picker';
}

export async function showActivePage(persona: Persona): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showActivePage().');
  menuPersona = persona;
  // If a result arrived while the user was off the active page (e.g. they
  // opened the menu during analysis), promote the discreet layout so the
  // rebuild lays down claim/verdict/reason containers ready to receive it.
  if (pendingActiveResult && activeLayout === 'discreet-minimal') {
    activeLayout = 'discreet-result';
  }
  const ok = await getBridge().rebuildPageContainer(buildActivePage());
  if (!ok) throw new Error('rebuildPageContainer (active) failed.');
  currentPage = 'active';
  if (pendingActiveResult) {
    const replay = pendingActiveResult;
    pendingActiveResult = null;
    await setLensResult(replay);
  }
}

export async function showMenuPage(): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showMenuPage().');
  const ok = await getBridge().rebuildPageContainer(buildMenuPage());
  if (!ok) throw new Error('rebuildPageContainer (menu) failed.');
  currentPage = 'menu';
}

export async function showHistoryListPage(entries: HistoryEntry[]): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showHistoryListPage().');
  cachedHistoryEntries = entries;
  const ok = await getBridge().rebuildPageContainer(buildHistoryListPage(entries));
  if (!ok) throw new Error('rebuildPageContainer (history-list) failed.');
  currentPage = 'history-list';
}

export async function showHistoryDetailPage(entry: HistoryEntry): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showHistoryDetailPage().');
  detailReasonFull = formatLensResult(entry.result).bottom;
  detailReasonOffset = 0;
  const ok = await getBridge().rebuildPageContainer(buildHistoryDetailPage(entry));
  if (!ok) throw new Error('rebuildPageContainer (history-detail) failed.');
  currentPage = 'history-detail';
}

export async function scrollHistoryDetail(dir: 1 | -1): Promise<void> {
  if (currentPage !== 'history-detail') return;
  const maxOffset = Math.max(0, detailReasonFull.length - DETAIL_PAGE_CHARS);
  const newOffset = Math.max(0, Math.min(maxOffset, detailReasonOffset + dir * DETAIL_PAGE_CHARS));
  if (newOffset === detailReasonOffset) return;
  detailReasonOffset = newOffset;
  await upgradeText(CONTAINER.reason, NAME.reason, detailReasonFull.slice(detailReasonOffset, detailReasonOffset + DETAIL_PAGE_CHARS));
}

export async function restoreHistoryListPage(): Promise<void> {
  await showHistoryListPage(cachedHistoryEntries);
}

/** Resume the previously-active persona page after the menu. */
export async function restoreActivePage(): Promise<void> {
  if (!menuPersona) return;
  await showActivePage(menuPersona);
}

export async function setStatus(label: keyof typeof STATUS_LABEL | string): Promise<void> {
  if (currentPage !== 'active') return;
  // Discreet-result is the pure full-screen answer view — no status chrome.
  if (activeLayout === 'discreet-result') return;
  const content = STATUS_LABEL[label] ?? label;
  // On discreet-minimal the status slot doubles as the recording dot — when
  // status clears (e.g. 'listening'), restore '•' so the user always sees a
  // recording indicator. Baseline keeps the slot empty as before.
  const text = activeLayout === 'discreet-minimal' && content === '' ? '•' : content;
  await upgradeText(CONTAINER.status, NAME.status, text);
}

export async function setLensResult(result: LensResult | null): Promise<void> {
  if (currentPage !== 'active' && currentPage !== 'history-detail') {
    // User is off the active page (typically on the menu after opening it
    // mid-analysis). Stash the answer so the next showActivePage replays it.
    if (result) pendingActiveResult = result;
    return;
  }
  // Reset the claim cursor on every new result so the user always sees claim
  // 1 first; scroll-down can then walk to claim 2 when present.
  activeClaimIndex = 0;
  currentActiveResult = result;
  // Discreet swaps between two page layouts depending on whether an answer is
  // on screen: dot-only while listening/thinking, full-screen question+answer
  // once a result arrives. Promote/demote here so callers don't have to.
  if (currentPage === 'active' && activeLayout === 'discreet-minimal') {
    if (!result) return; // nothing to show — keep the dot
    setActiveLayout('discreet-result');
    const ok = await getBridge().rebuildPageContainer(buildActivePage());
    if (!ok) throw new Error('rebuildPageContainer (discreet-result) failed.');
  } else if (currentPage === 'active' && activeLayout === 'discreet-result' && !result) {
    setActiveLayout('discreet-minimal');
    const ok = await getBridge().rebuildPageContainer(buildActivePage());
    if (!ok) throw new Error('rebuildPageContainer (discreet-minimal) failed.');
    activeReasonFull = '';
    activeReasonOffset = 0;
    return;
  }
  if (!result) {
    activeReasonFull = '';
    activeReasonOffset = 0;
    await Promise.all([
      upgradeText(CONTAINER.claim, NAME.claim, ''),
      upgradeText(CONTAINER.verdict, NAME.verdict, ''),
      upgradeText(CONTAINER.reason, NAME.reason, ''),
    ]);
    return;
  }
  const { top, middle, bottom } = formatLensResult(result);
  let reasonContent = bottom;
  if (currentPage === 'active') {
    activeReasonFull = bottom;
    activeReasonOffset = 0;
    reasonContent = bottom.slice(0, ACTIVE_PAGE_CHARS);
  }
  await Promise.all([
    upgradeText(CONTAINER.claim, NAME.claim, top),
    upgradeText(CONTAINER.verdict, NAME.verdict, middle),
    upgradeText(CONTAINER.reason, NAME.reason, reasonContent),
  ]);
}

/**
 * Try to advance the active page to the next claim. Returns true iff a
 * swap actually happened. Returns false on the last claim, on single-claim
 * results, and when off the active page — letting the caller fall back to
 * the default tap action (open the menu).
 */
export async function tryAdvanceActiveClaim(): Promise<boolean> {
  if (currentPage !== 'active' || !currentActiveResult) return false;
  const total = claimCount(currentActiveResult);
  if (total <= 1) return false;
  const next = activeClaimIndex + 1;
  if (next >= total) return false;
  activeClaimIndex = next;
  const { top, middle, bottom } = formatLensResult(currentActiveResult, activeClaimIndex);
  activeReasonFull = bottom;
  activeReasonOffset = 0;
  await Promise.all([
    upgradeText(CONTAINER.claim, NAME.claim, top),
    upgradeText(CONTAINER.verdict, NAME.verdict, middle),
    upgradeText(CONTAINER.reason, NAME.reason, bottom.slice(0, ACTIVE_PAGE_CHARS)),
  ]);
  return true;
}

export async function scrollActiveReason(dir: 1 | -1): Promise<void> {
  if (currentPage !== 'active') return;
  // Multi-claim swap takes precedence over reason pagination. Scroll-down
  // walks claim 1 → claim 2; scroll-up reverses. When the requested move
  // would fall outside the claim range, fall through to reason pagination so
  // a long single claim's reason can still be scrolled.
  if (currentActiveResult) {
    const total = claimCount(currentActiveResult);
    if (total > 1) {
      const next = activeClaimIndex + dir;
      if (next >= 0 && next < total) {
        activeClaimIndex = next;
        const { top, middle, bottom } = formatLensResult(currentActiveResult, activeClaimIndex);
        activeReasonFull = bottom;
        activeReasonOffset = 0;
        await Promise.all([
          upgradeText(CONTAINER.claim, NAME.claim, top),
          upgradeText(CONTAINER.verdict, NAME.verdict, middle),
          upgradeText(CONTAINER.reason, NAME.reason, bottom.slice(0, ACTIVE_PAGE_CHARS)),
        ]);
        return;
      }
    }
  }
  const maxOffset = Math.max(0, activeReasonFull.length - ACTIVE_PAGE_CHARS);
  const newOffset = Math.max(0, Math.min(maxOffset, activeReasonOffset + dir * ACTIVE_PAGE_CHARS));
  if (newOffset === activeReasonOffset) return;
  activeReasonOffset = newOffset;
  await upgradeText(CONTAINER.reason, NAME.reason, activeReasonFull.slice(activeReasonOffset, activeReasonOffset + ACTIVE_PAGE_CHARS));
}

/** Toggle the recording indicator in the bottom-right of the active page. */
export async function setRecIndicator(on: boolean): Promise<void> {
  if (currentPage !== 'active') return;
  // Discreet layouts have no REC container; suppress unconditionally.
  if (activeLayout !== 'baseline') return;
  await upgradeText(CONTAINER.recIndicator, NAME.recIndicator, on ? '● REC' : '');
}

export async function setActiveHint(content: string): Promise<void> {
  if (currentPage !== 'active') return;
  // Discreet layouts have no hint row.
  if (activeLayout !== 'baseline') return;
  await upgradeText(CONTAINER.activeHint, NAME.activeHint, content);
}

/**
 * Update the small spinner slot left of the clock on the menu page.
 * Always records the frame so a subsequent menu rebuild reflects the current
 * spinner state; only writes to the device when the menu is on screen.
 */
export async function setMenuSpinner(content: string): Promise<void> {
  pendingMenuSpinnerFrame = content;
  if (currentPage !== 'menu') return;
  await upgradeText(CONTAINER.menuSpinner, NAME.menuSpinner, content);
}


async function upgradeText(containerID: number, containerName: string, content: string): Promise<void> {
  const upgrade = new TextContainerUpgrade({
    containerID,
    containerName,
    contentOffset: 0,
    contentLength: 0, // 0 = full replacement (SDK semantics)
    content,
  });
  await getBridge().textContainerUpgrade(upgrade);
}

/** Number of claims renderable per result. 1 for answer-shaped lenses. */
function claimCount(result: LensResult): number {
  switch (result.type) {
    case 'fact-check':
    case 'logical-fallacy':
    case 'stats-check':
    case 'bias':
    case 'trivia':
    case 'eli5':
      return Math.max(1, result.claims.length);
    default:
      return 1;
  }
}

function formatLensResult(result: LensResult, claimIdx: number = 0): { top: string; middle: string; bottom: string } {
  const parts = formatLensResultBase(result, claimIdx);
  const count = claimCount(result);
  // Inline 1/2 · 2/2 indicator on the top (claim) line for multi-claim
  // results, so it sits next to the question rather than the verdict.
  // Keeps the discreet HUD density unchanged — no extra container.
  if (count > 1) {
    const tag = `${claimIdx + 1}/${count}`;
    parts.top = parts.top ? `${tag} · ${parts.top}` : tag;
  }
  if (result.autoSelected) {
    return { ...parts, top: parts.top ? `Auto · ${parts.top}` : 'Auto' };
  }
  return parts;
}

function formatLensResultBase(result: LensResult, claimIdx: number): { top: string; middle: string; bottom: string } {
  switch (result.type) {
    case 'fact-check': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return {
        top: clip(c.claim, 140),
        middle: c.verdict === 'TRUE' ? '+ TRUE' : c.verdict === 'FALSE' ? '- FALSE' : '? UNVERIFIED',
        bottom: clip(c.reason, 240),
      };
    }
    case 'trivia': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return { top: clip(c.question, 140), middle: clip(c.answer, 60), bottom: clip(c.description, 240) };
    }
    case 'logical-fallacy': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return { top: c.fallacy.toUpperCase(), middle: '', bottom: clip(c.explanation, 240) };
    }
    case 'stats-check': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return {
        top: clip(c.stat, 140),
        middle: c.verdict === 'PLAUSIBLE' ? '+ PLAUSIBLE' : '- SUSPICIOUS',
        bottom: clip(c.reason, 240),
      };
    }
    case 'bias': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return {
        top: c.direction ? clip(c.direction, 140) : '',
        middle: c.verdict === 'NEUTRAL' ? '+ NEUTRAL' : '- BIASED',
        bottom: clip(c.reason, 240),
      };
    }
    case 'translation':
      return { top: clip(result.translatedText, 140), middle: '', bottom: '' };
    case 'eli5': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return { top: '', middle: '', bottom: clip(c.explanation, 240) };
    }
    case 'session-summary':
      return { top: '', middle: '', bottom: clip(result.summary, 240) };
  }
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function badgeGlyph(badge: string): string {
  const u = badge.toUpperCase();
  if (u === 'TRUE' || u === 'PLAUSIBLE' || u === 'NEUTRAL') return '+ ';
  if (u === 'FALSE' || u === 'SUSPICIOUS' || u === 'BIASED') return '- ';
  if (u === 'UNVERIFIED') return '? ';
  return '';
}

// ------- page builders ----------------------------------------------------

function buildUnconfiguredPage(mode: 'create' | 'rebuild'): CreateStartUpPageContainer | RebuildPageContainer {
  const title = new TextContainerProperty({
    containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 32,
    width: SCREEN_W - 32, height: 40, borderWidth: 0, paddingLength: 4,
    content: 'VeritasLens', isEventCapture: 0,
  });
  const msg = new TextContainerProperty({
    containerID: CONTAINER.pickerHint, containerName: 'vl-msg', xPosition: 16, yPosition: 96,
    width: SCREEN_W - 32, height: 88, borderWidth: 0, paddingLength: 4,
    content: 'Configure on your phone to begin. Add your Gemini API key from the app menu. Double-tap to exit.',
    isEventCapture: 0,
  });
  const sink = new ListContainerProperty({
    containerID: CONTAINER.pickerList, containerName: NAME.pickerList, xPosition: 16, yPosition: 216,
    width: SCREEN_W - 32, height: 40, borderWidth: 0, paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: 1, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 0,
      itemName: ['Waiting for API key…'],
    }),
    isEventCapture: 1,
  });
  const Ctor = mode === 'create' ? CreateStartUpPageContainer : RebuildPageContainer;
  return new Ctor({ containerTotalNum: 3, listObject: [sink], textObject: [title, msg] });
}

function buildPickerPage(mode: 'create' | 'rebuild'): CreateStartUpPageContainer | RebuildPageContainer {
  const currentPersonas = getPickerPersonas(settings().bufferDuration);
  const title = new TextContainerProperty({
    containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 8,
    width: SCREEN_W - 32, height: 36, borderWidth: 0, paddingLength: 4,
    content: 'Pick a lens', isEventCapture: 0,
  });
  const list = new ListContainerProperty({
    containerID: CONTAINER.pickerList, containerName: NAME.pickerList, xPosition: 16, yPosition: 48,
    width: SCREEN_W - 32, height: 200, borderWidth: 0, paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: currentPersonas.length, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 1,
      itemName: currentPersonas.map((p) => p.name),
    }),
    isEventCapture: 1,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.pickerHint, containerName: NAME.pickerHint, xPosition: 16, yPosition: 252,
    width: SCREEN_W - 32, height: 28, borderWidth: 0, paddingLength: 4,
    content: currentPersonas.length > 1 ? 'Swipe ⇅ · Tap: start · Double-tap: exit' : 'Tap: start · Double-tap: exit',
    isEventCapture: 0,
  });
  const Ctor = mode === 'create' ? CreateStartUpPageContainer : RebuildPageContainer;
  return new Ctor({ containerTotalNum: 3, listObject: [list], textObject: [title, hint] });
}

function buildMenuPage(): RebuildPageContainer {
  // Title sized tight around "Menu" so LVGL's end-of-label caret sits outside
  // the container clip. Clock sized tight around "HH:MM" for the same reason.
  const title = new TextContainerProperty({
    containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 8,
    width: 64, height: 32, borderWidth: 0, paddingLength: 0,
    content: 'Menu', isEventCapture: 0,
  });
  // Spinner sits immediately left of the clock; populated by setMenuSpinner
  // while an analysis is in flight, empty otherwise.
  const spinner = new TextContainerProperty({
    containerID: CONTAINER.menuSpinner, containerName: NAME.menuSpinner,
    xPosition: SCREEN_W - 96, yPosition: 8, width: 24, height: 32,
    borderWidth: 0, paddingLength: 0,
    content: pendingMenuSpinnerFrame, isEventCapture: 0,
  });
  const clock = new TextContainerProperty({
    containerID: CONTAINER.clock, containerName: NAME.clock,
    xPosition: SCREEN_W - 64, yPosition: 8, width: 56, height: 32,
    borderWidth: 0, paddingLength: 0,
    content: formatClockTime(), isEventCapture: 0,
  });
  const list = new ListContainerProperty({
    containerID: CONTAINER.menuList, containerName: NAME.menuList, xPosition: 16, yPosition: 48,
    width: SCREEN_W - 32, height: SCREEN_H - 48, borderWidth: 0, paddingLength: 0,
    itemContainer: new ListItemContainerProperty({
      itemCount: MENU_OPTIONS.length, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 1,
      itemName: MENU_OPTIONS.map((o) => o.label),
    }),
    isEventCapture: 1,
  });
  return new RebuildPageContainer({ containerTotalNum: 4, listObject: [list], textObject: [title, spinner, clock] });
}

function formatClockTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function buildActivePage(): RebuildPageContainer {
  if (activeLayout === 'discreet-minimal') return buildDiscreetMinimalPage();
  if (activeLayout === 'discreet-result') return buildDiscreetResultPage();
  return buildBaselineActivePage();
}

function buildBaselineActivePage(): RebuildPageContainer {
  const eventCapture = makeFullScreenEventSink();
  const status = new TextContainerProperty({
    containerID: CONTAINER.status, containerName: NAME.status,
    xPosition: SCREEN_W - 112, yPosition: 4, width: 96, height: 26,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  const claim = new TextContainerProperty({
    containerID: CONTAINER.claim, containerName: NAME.claim,
    xPosition: 16, yPosition: 34, width: SCREEN_W - 32, height: 54,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  const verdict = new TextContainerProperty({
    containerID: CONTAINER.verdict, containerName: NAME.verdict,
    xPosition: 16, yPosition: 90, width: SCREEN_W - 32, height: 26,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  const reason = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 118, width: SCREEN_W - 32, height: 134,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  const rec = new TextContainerProperty({
    containerID: CONTAINER.recIndicator, containerName: NAME.recIndicator,
    xPosition: SCREEN_W - 96, yPosition: 256, width: 80, height: 28,
    borderWidth: 0, paddingLength: 4, content: '● REC', isEventCapture: 0,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.activeHint, containerName: NAME.activeHint,
    xPosition: 16, yPosition: 256, width: SCREEN_W - 120, height: 28,
    borderWidth: 0, paddingLength: 4, content: ACTIVE_HINT_DEFAULT, isEventCapture: 0,
  });
  return new RebuildPageContainer({
    containerTotalNum: 7, listObject: [],
    textObject: [eventCapture, status, claim, verdict, reason, rec, hint],
  });
}

/**
 * Discreet idle layout — a single recording dot in the top-left and an
 * invisible full-screen list as the event sink. Nothing else on the HUD.
 */
function buildDiscreetMinimalPage(): RebuildPageContainer {
  const sink = makeInvisibleListSink();
  // Single top-right slot that doubles as recording-dot (resting) and
  // status indicator (spinner / "..." / "R1/2"). One container = one
  // LVGL label-cursor caret position; merging the two avoids the second
  // caret in the opposite corner.
  const status = makeDiscreetStatus();
  return new RebuildPageContainer({
    containerTotalNum: 2, listObject: [sink], textObject: [status],
  });
}

/**
 * Discreet result layout — full-screen question/answer, matching the
 * history-detail view. No dot, no status, no hint: once an answer is on
 * screen it fills the available space. The dot only exists in
 * discreet-minimal, which is what the user sees before the answer arrives.
 * The list sink at the bottom-right captures tap (→ menu) and scroll events.
 */
function buildDiscreetResultPage(): RebuildPageContainer {
  const sink = makeInvisibleListSink();
  const claim = new TextContainerProperty({
    containerID: CONTAINER.claim, containerName: NAME.claim,
    xPosition: 16, yPosition: 32, width: SCREEN_W - 32, height: 68,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  const verdict = new TextContainerProperty({
    containerID: CONTAINER.verdict, containerName: NAME.verdict,
    xPosition: 16, yPosition: 102, width: SCREEN_W - 32, height: 26,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  const reason = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 130, width: SCREEN_W - 32, height: 126,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  return new RebuildPageContainer({
    containerTotalNum: 4, listObject: [sink],
    textObject: [claim, verdict, reason],
  });
}

function makeFullScreenEventSink(): TextContainerProperty {
  // Full-screen invisible capturer — sits behind all content so SDK has nothing
  // to scroll visually, but still fires textEvents (swipe) and sysEvents (tap).
  return new TextContainerProperty({
    containerID: CONTAINER.activeList, containerName: NAME.activeList,
    xPosition: 0, yPosition: 0, width: SCREEN_W, height: SCREEN_H,
    borderWidth: 0, paddingLength: 0, content: ' ', isEventCapture: 1,
  });
}

/**
 * Discreet event sink — a tiny list parked at the bottom-right corner. Touch
 * input comes from the temple touchpad regardless of where the sink renders,
 * so we just need *some* container to be the event capturer; we don't need it
 * to cover the screen. Keeping it small and out of the way avoids the list's
 * item-cursor leaking next to the recording dot.
 */
function makeInvisibleListSink(): ListContainerProperty {
  // itemCount=2 (rather than 1) so the SDK has somewhere to "scroll to" and
  // actually fires SCROLL_TOP / SCROLL_BOTTOM listEvents when the user swipes
  // vertically. With a single-item list the SDK suppresses scroll events,
  // which broke multi-claim swipe in discreet mode.
  return new ListContainerProperty({
    containerID: CONTAINER.activeList, containerName: NAME.activeList,
    xPosition: SCREEN_W - 2, yPosition: SCREEN_H - 2, width: 2, height: 2,
    borderWidth: 0, paddingLength: 0,
    itemContainer: new ListItemContainerProperty({
      itemCount: 2, itemWidth: 2, isItemSelectBorderEn: 0,
      itemName: ['', ''],
    }),
    isEventCapture: 1,
  });
}

/** Top-right combined recording / status slot for discreet-minimal.
 * Shows '•' as the resting recording indicator; setStatus overwrites it with
 * the spinner / "..." / "R1/2" during analysis and restores the dot when
 * status clears. Keeping a single container also keeps the LVGL label-cursor
 * caret confined to one corner. */
function makeDiscreetStatus(): TextContainerProperty {
  return new TextContainerProperty({
    containerID: CONTAINER.status, containerName: NAME.status,
    xPosition: SCREEN_W - 59, yPosition: 4, width: 55, height: 26,
    borderWidth: 0, paddingLength: 4, content: '•', isEventCapture: 0,
  });
}

function buildHistoryListPage(entries: HistoryEntry[]): RebuildPageContainer {
  const title = new TextContainerProperty({
    containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 8,
    width: SCREEN_W - 32, height: 36, borderWidth: 0, paddingLength: 4,
    content: 'History', isEventCapture: 0,
  });
  const itemNames = entries.length > 0
    ? ['← Back', ...entries.map((e) => `${badgeGlyph(e.badge)}${clip(e.question, 55)}`)]
    : ['← Back', 'No history yet'];
  const list = new ListContainerProperty({
    containerID: CONTAINER.historyList, containerName: NAME.historyList, xPosition: 16, yPosition: 48,
    width: SCREEN_W - 32, height: 200, borderWidth: 0, paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: itemNames.length, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 1,
      itemName: itemNames,
    }),
    isEventCapture: 1,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.historyHint, containerName: NAME.historyHint, xPosition: 16, yPosition: 252,
    width: SCREEN_W - 32, height: 28, borderWidth: 0, paddingLength: 4,
    content: 'Swipe ⇅ · Tap: detail · Tap ← : back',
    isEventCapture: 0,
  });
  return new RebuildPageContainer({ containerTotalNum: 3, listObject: [list], textObject: [title, hint] });
}

function buildHistoryDetailPage(entry: HistoryEntry): RebuildPageContainer {
  const { top, middle } = formatLensResult(entry.result);
  const reasonContent = detailReasonFull.slice(detailReasonOffset, detailReasonOffset + DETAIL_PAGE_CHARS);
  const claim = new TextContainerProperty({
    containerID: CONTAINER.claim, containerName: NAME.claim,
    xPosition: 16, yPosition: 32, width: SCREEN_W - 32, height: 68,
    borderWidth: 0, paddingLength: 4, content: top, isEventCapture: 0,
  });
  const verdict = new TextContainerProperty({
    containerID: CONTAINER.verdict, containerName: NAME.verdict,
    xPosition: 16, yPosition: 102, width: SCREEN_W - 32, height: 26,
    borderWidth: 0, paddingLength: 4, content: middle, isEventCapture: 0,
  });
  const reason = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 130, width: SCREEN_W - 32, height: 126,
    borderWidth: 0, paddingLength: 4, content: reasonContent, isEventCapture: 1,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.activeList, containerName: NAME.activeList,
    xPosition: 16, yPosition: 260, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4, content: 'Tap: back · Swipe: scroll', isEventCapture: 0,
  });
  return new RebuildPageContainer({ containerTotalNum: 4, listObject: [], textObject: [claim, verdict, reason, hint] });
}

/** Clear per-session HUD state so a fresh session doesn't inherit stale buffers. */
export function resetHudSessionState(): void {
  menuPersona = null;
  cachedHistoryEntries = [];
  detailReasonFull = '';
  detailReasonOffset = 0;
  activeReasonFull = '';
  activeReasonOffset = 0;
  activeClaimIndex = 0;
  currentActiveResult = null;
  activeLayout = 'baseline';
  pendingActiveResult = null;
  pendingMenuSpinnerFrame = '';
}

export function _resetHudBootstrapForTesting(): void {
  bootstrapped = false;
  currentPage = 'none';
  resetHudSessionState();
}
