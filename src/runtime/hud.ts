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
  retry1: 'Retry 1/2',
  retry2: 'Retry 2/2',
};

export type HudPage = 'unconfigured' | 'picker' | 'active' | 'menu' | 'history-list' | 'history-detail' | 'none';

export const ACTIVE_HINT_DEFAULT = 'Tap: menu · Double-tap: check';
export const ACTIVE_HINT_ANALYZING = 'Analyzing · Double-tap to cancel';

export const MENU_OPTIONS = [
  { id: 'fact-check', label: 'Check' },
  { id: 'history', label: 'History' },
  { id: 'cancel', label: 'Cancel' },
  { id: 'exit', label: 'Exit' },
] as const;
export type MenuOptionId = (typeof MENU_OPTIONS)[number]['id'];

const DETAIL_PAGE_CHARS = 200;
const ACTIVE_PAGE_CHARS = 200;
let detailReasonFull = '';
let detailReasonOffset = 0;
let activeReasonFull = '';
let activeReasonOffset = 0;

let bootstrapped = false;
let currentPage: HudPage = 'none';
let menuPersona: Persona | null = null;
let cachedHistoryEntries: HistoryEntry[] = [];
export function getHistoryListEntries(): HistoryEntry[] { return cachedHistoryEntries; }

export function currentHudPage(): HudPage { return currentPage; }

/** Look up the persona at the given index from the host event payload. */
export function personaAtIndex(idx: number | undefined | null): Persona | null {
  const list = getPickerPersonas(settings().bufferDuration);
  const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
  return list[safe] ?? list[0] ?? null;
}

/** Map list index → menu option id. */
export function menuOptionAtIndex(idx: number | undefined | null): MenuOptionId {
  const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
  return MENU_OPTIONS[safe]?.id ?? 'fact-check';
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
  const ok = await getBridge().rebuildPageContainer(buildActivePage());
  if (!ok) throw new Error('rebuildPageContainer (active) failed.');
  currentPage = 'active';
}

export async function showMenuPage(time = ''): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showMenuPage().');
  const ok = await getBridge().rebuildPageContainer(buildMenuPage(time));
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
  const content = STATUS_LABEL[label] ?? `[${label.slice(0, 14)}]`;
  await upgradeText(CONTAINER.status, NAME.status, content);
}

export async function setLensResult(result: LensResult | null): Promise<void> {
  if (currentPage !== 'active' && currentPage !== 'history-detail') return;
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

export async function scrollActiveReason(dir: 1 | -1): Promise<void> {
  if (currentPage !== 'active') return;
  const maxOffset = Math.max(0, activeReasonFull.length - ACTIVE_PAGE_CHARS);
  const newOffset = Math.max(0, Math.min(maxOffset, activeReasonOffset + dir * ACTIVE_PAGE_CHARS));
  if (newOffset === activeReasonOffset) return;
  activeReasonOffset = newOffset;
  await upgradeText(CONTAINER.reason, NAME.reason, activeReasonFull.slice(activeReasonOffset, activeReasonOffset + ACTIVE_PAGE_CHARS));
}

/** Toggle the recording indicator in the bottom-right of the active page. */
export async function setRecIndicator(on: boolean): Promise<void> {
  if (currentPage !== 'active') return;
  await upgradeText(CONTAINER.recIndicator, NAME.recIndicator, on ? '● REC' : '');
}

export async function setActiveHint(content: string): Promise<void> {
  if (currentPage !== 'active') return;
  await upgradeText(CONTAINER.activeHint, NAME.activeHint, content);
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

function formatLensResult(result: LensResult): { top: string; middle: string; bottom: string } {
  const parts = formatLensResultBase(result);
  if (result.autoSelected) {
    return { ...parts, top: parts.top ? `Auto · ${parts.top}` : 'Auto' };
  }
  return parts;
}

function formatLensResultBase(result: LensResult): { top: string; middle: string; bottom: string } {
  switch (result.type) {
    case 'fact-check':
      return {
        top: clip(result.claim, 140),
        middle: result.verdict === 'TRUE' ? '+ TRUE' : result.verdict === 'FALSE' ? '- FALSE' : '? UNVERIFIED',
        bottom: clip(result.reason, 240),
      };
    case 'trivia':
      return { top: clip(result.question, 140), middle: clip(result.answer, 60), bottom: clip(result.description, 240) };
    case 'logical-fallacy':
      return { top: result.fallacy.toUpperCase(), middle: '', bottom: clip(result.explanation, 240) };
    case 'stats-check':
      return {
        top: clip(result.stat, 140),
        middle: result.verdict === 'PLAUSIBLE' ? '+ PLAUSIBLE' : '- SUSPICIOUS',
        bottom: clip(result.reason, 240),
      };
    case 'bias':
      return {
        top: result.direction ? clip(result.direction, 140) : '',
        middle: result.verdict === 'NEUTRAL' ? '+ NEUTRAL' : '- BIASED',
        bottom: clip(result.reason, 240),
      };
    case 'translation':
      return { top: clip(result.translatedText, 140), middle: '', bottom: '' };
    case 'eli5':
      return { top: '', middle: '', bottom: clip(result.explanation, 240) };
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
    content: 'Configure on your phone to begin. Add your Gemini API key from the app menu.',
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
    content: currentPersonas.length > 1 ? 'Swipe ⇅ · Tap to start' : 'Tap to start',
    isEventCapture: 0,
  });
  const Ctor = mode === 'create' ? CreateStartUpPageContainer : RebuildPageContainer;
  return new Ctor({ containerTotalNum: 3, listObject: [list], textObject: [title, hint] });
}

function buildMenuPage(time = ''): RebuildPageContainer {
  const title = new TextContainerProperty({
    containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 8,
    width: 200, height: 36, borderWidth: 0, paddingLength: 4,
    content: 'Menu', isEventCapture: 0,
  });
  const clock = new TextContainerProperty({
    containerID: CONTAINER.clock, containerName: NAME.clock,
    xPosition: SCREEN_W - 112, yPosition: 10, width: 96, height: 28,
    borderWidth: 0, paddingLength: 4, content: time, isEventCapture: 0,
  });
  const list = new ListContainerProperty({
    containerID: CONTAINER.menuList, containerName: NAME.menuList, xPosition: 16, yPosition: 48,
    width: SCREEN_W - 32, height: 200, borderWidth: 0, paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: MENU_OPTIONS.length, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 1,
      itemName: MENU_OPTIONS.map((o) => o.label),
    }),
    isEventCapture: 1,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.pickerHint, containerName: NAME.pickerHint, xPosition: 16, yPosition: 252,
    width: SCREEN_W - 32, height: 28, borderWidth: 0, paddingLength: 4,
    content: 'Swipe ⇅ · Tap to confirm', isEventCapture: 0,
  });
  return new RebuildPageContainer({ containerTotalNum: 4, listObject: [list], textObject: [title, clock, hint] });
}

function buildActivePage(): RebuildPageContainer {
  // Full-screen invisible capturer — sits behind all content so SDK has nothing
  // to scroll visually, but still fires textEvents (swipe) and sysEvents (tap).
  const eventCapture = new TextContainerProperty({
    containerID: CONTAINER.activeList, containerName: NAME.activeList,
    xPosition: 0, yPosition: 0, width: SCREEN_W, height: SCREEN_H,
    borderWidth: 0, paddingLength: 0, content: ' ', isEventCapture: 1,
  });
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
    borderWidth: 0, paddingLength: 4, content: ACTIVE_HINT_DEFAULT,
    isEventCapture: 0,
  });
  return new RebuildPageContainer({ containerTotalNum: 7, listObject: [], textObject: [eventCapture, status, claim, verdict, reason, rec, hint] });
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
}

export function _resetHudBootstrapForTesting(): void {
  bootstrapped = false;
  currentPage = 'none';
  resetHudSessionState();
}
