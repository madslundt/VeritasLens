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
import { measureTextWrap } from '@evenrealities/pretext';
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
  // compact header (used on scroll layouts: page 2+ of a claim)
  compactHeader: 29,
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
  compactHeader: 'vl-compact',
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

export const EXIT_LABEL_WITH_SUMMARY = 'Exit - generate summary';
// Captured at showMenuPage() time; consumed by buildMenuPage() so the Exit row
// reflects whether leaveActiveSession will fire a final summary.
let exitGeneratesSummary = false;

// Line-aware pagination constants. The reason container is the only scrollable
// region. Inner width = container width 544 minus 2*padding (4) = 536px.
// Line height is sourced from pretext (a single-line measurement) so a font
// bump in @evenrealities/pretext doesn't silently break pagination.
const LINE_PX = measureTextWrap('X', 1000).height;
const REASON_INNER_W = SCREEN_W - 32 - 2 * 4; // 536
// On page 0 of a claim (full header layout), reason height varies by mode but
// inner area accommodates ~4 lines of 27px in both baseline (134-8=126px → 4)
// and discreet-result (126-8=118px → 4).
const FULL_HEADER_REASON_LINES = 4;
// On page 1+ of a claim (compact header layout), reason expands. Baseline
// keeps REC + hint chrome so gets 7 lines; discreet drops chrome for 8 lines.
const BASELINE_SCROLL_REASON_LINES = 7;
const DISCREET_SCROLL_REASON_LINES = 8;

/**
 * One screen-worth of result content. Multi-claim results and long reasons
 * expand into a flat list of these — swipe-down increments the index,
 * swipe-up decrements. `pageWithinClaim === 0` is the full-header page
 * (claim + verdict + reason); higher values are scroll pages with a thin
 * header and expanded reason.
 */
type PageRef = { claimIdx: number; pageWithinClaim: number; text: string };

let activePages: PageRef[] = [];
let activePageIndex = 0;
let detailPages: PageRef[] = [];
let detailPageIndex = 0;
/** Tracks which history-detail layout is currently on screen (full vs scroll). */
let detailIsFullLayout = true;
/** Index into cachedHistoryEntries of the entry currently shown on history-detail. */
let historyDetailIndex = -1;
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
 *   - 'baseline'         : default with chrome; full claim/verdict/reason (page 0)
 *   - 'baseline-scroll'  : page 1+ of a claim with chrome — compact header + tall reason
 *   - 'discreet-minimal' : single recording dot only (no claim/REC/hint)
 *   - 'discreet-result'  : pure question/answer, no chrome (page 0)
 *   - 'discreet-scroll'  : page 1+ of a claim, no chrome — compact header + full-height reason
 */
export type ActiveLayout =
  | 'baseline'
  | 'baseline-scroll'
  | 'discreet-minimal'
  | 'discreet-result'
  | 'discreet-scroll';
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

export async function showMenuPage(opts: { exitGeneratesSummary?: boolean } = {}): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showMenuPage().');
  exitGeneratesSummary = opts.exitGeneratesSummary === true;
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
  // Remember where this entry sits in the cached list so scrollHistoryDetail
  // can walk to its neighbours. Falls back to a one-element list if the
  // entry isn't in the cache (defensive).
  const cached = cachedHistoryEntries.indexOf(entry);
  if (cached >= 0) {
    historyDetailIndex = cached;
  } else {
    cachedHistoryEntries = [entry];
    historyDetailIndex = 0;
  }
  detailPages = computePagesForResult(entry.result, /*scrollLines*/ DISCREET_SCROLL_REASON_LINES);
  detailPageIndex = 0;
  const ok = await getBridge().rebuildPageContainer(buildHistoryDetailPage(entry, detailPages[0]!));
  if (!ok) throw new Error('rebuildPageContainer (history-detail) failed.');
  currentPage = 'history-detail';
}

export async function scrollHistoryDetail(dir: 1 | -1): Promise<void> {
  if (currentPage !== 'history-detail') return;
  // Within the current entry, walk the flat page list (linearized across
  // claims + reason sub-pages). When we fall off either edge, hop to the
  // neighbour entry — preserving the cross-entry behaviour.
  const nextIdx = detailPageIndex + dir;
  if (nextIdx >= 0 && nextIdx < detailPages.length) {
    detailPageIndex = nextIdx;
    await renderHistoryDetailPage();
    return;
  }
  const nextEntry = historyDetailIndex + dir;
  if (nextEntry < 0 || nextEntry >= cachedHistoryEntries.length) return;
  historyDetailIndex = nextEntry;
  const entry = cachedHistoryEntries[nextEntry]!;
  detailPages = computePagesForResult(entry.result, DISCREET_SCROLL_REASON_LINES);
  detailPageIndex = 0;
  const ok = await getBridge().rebuildPageContainer(buildHistoryDetailPage(entry, detailPages[0]!));
  if (!ok) throw new Error('rebuildPageContainer (history-detail) failed.');
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
  currentActiveResult = result;

  // Null result paths — clear or demote, matching prior behaviour. Discreet
  // demotes to the dot-only idle layout; baseline-scroll falls back to baseline
  // (so the claim/verdict containers exist again); baseline just clears text.
  if (!result) {
    activePages = [];
    activePageIndex = 0;
    if (currentPage !== 'active') return;
    if (activeLayout === 'discreet-minimal') return; // already idle
    if (isDiscreetLayout(activeLayout)) {
      setActiveLayout('discreet-minimal');
      const ok = await getBridge().rebuildPageContainer(buildActivePage());
      if (!ok) throw new Error('rebuildPageContainer (discreet-minimal) failed.');
      return;
    }
    if (activeLayout === 'baseline-scroll') {
      setActiveLayout('baseline');
      const ok = await getBridge().rebuildPageContainer(buildActivePage());
      if (!ok) throw new Error('rebuildPageContainer (baseline) failed.');
      return;
    }
    await Promise.all([
      upgradeText(CONTAINER.claim, NAME.claim, ''),
      upgradeText(CONTAINER.verdict, NAME.verdict, ''),
      upgradeText(CONTAINER.reason, NAME.reason, ''),
    ]);
    return;
  }

  // Compute the flat page list for this result. Line budget for page 2+ depends
  // on whether the current mode is discreet (no chrome) or baseline (REC+hint).
  const scrollLines = isDiscreetLayout(activeLayout) ? DISCREET_SCROLL_REASON_LINES : BASELINE_SCROLL_REASON_LINES;
  activePages = computePagesForResult(result, scrollLines);
  activePageIndex = 0;
  if (currentPage === 'active') {
    await renderActivePage();
  } else {
    // history-detail: setLensResult is unused on this page in practice (the
    // history flow uses showHistoryDetailPage). Nothing to do.
  }
}

export async function scrollActiveReason(dir: 1 | -1): Promise<void> {
  if (currentPage !== 'active') return;
  if (activePages.length === 0) return;
  const next = activePageIndex + dir;
  if (next < 0 || next >= activePages.length) return;
  activePageIndex = next;
  await renderActivePage();
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

let pickerHintFlashTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Briefly replace the picker page's hint text with a message (e.g. "Add notes
 * in phone settings first"), then restore the standard navigation hint. Used
 * to give the wearer feedback when they tap a picker entry that can't be
 * entered — like Meeting Prep with no configured context.
 *
 * No-op when the picker isn't currently on screen; safe to call from event
 * handlers without checking page state.
 */
export async function flashPickerHint(message: string, ms = 2500): Promise<void> {
  if (currentPage !== 'picker') return;
  if (pickerHintFlashTimer) clearTimeout(pickerHintFlashTimer);
  await upgradeText(CONTAINER.pickerHint, NAME.pickerHint, message);
  pickerHintFlashTimer = setTimeout(() => {
    pickerHintFlashTimer = null;
    if (currentPage !== 'picker') return;
    const list = getPickerPersonas(settings().bufferDuration);
    const baseline = list.length > 1
      ? 'Swipe ⇅ · Tap: start · Double-tap: exit'
      : 'Tap: start · Double-tap: exit';
    void upgradeText(CONTAINER.pickerHint, NAME.pickerHint, baseline);
  }, ms);
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
    case 'meeting-prep':
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
        bottom: c.reason,
      };
    }
    case 'trivia': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return { top: clip(c.question, 140), middle: clip(c.answer, 60), bottom: c.description };
    }
    case 'logical-fallacy': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return { top: c.fallacy.toUpperCase(), middle: '', bottom: c.explanation };
    }
    case 'stats-check': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return {
        top: clip(c.stat, 140),
        middle: c.verdict === 'PLAUSIBLE' ? '+ PLAUSIBLE' : '- SUSPICIOUS',
        bottom: c.reason,
      };
    }
    case 'bias': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return {
        top: c.direction ? clip(c.direction, 140) : '',
        middle: c.verdict === 'NEUTRAL' ? '+ NEUTRAL' : '- BIASED',
        bottom: c.reason,
      };
    }
    case 'eli5': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return { top: '', middle: '', bottom: c.explanation };
    }
    case 'session-summary':
      return { top: '', middle: '', bottom: result.summary };
    case 'meeting-prep': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      // claim 0 is the primary answer; later claims are follow-up prompts.
      // The "→" prefix distinguishes follow-ups from the answer at a glance.
      const text = claimIdx === 0 ? c.text : `→ ${c.text}`;
      const middle = c.source ? `From: ${c.source}` : '';
      return { top: clip(text, 140), middle, bottom: c.detail };
    }
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

// ------- line-aware pagination -------------------------------------------

/**
 * Split a reason string into screen-sized chunks. Page 0 uses the smaller
 * `FULL_HEADER_REASON_LINES` budget (full header above); subsequent pages
 * use the larger `scrollLines` budget (compact header above). Word boundaries
 * are preferred; unbreakable runs fall back to character splits.
 */
function paginateReason(text: string, scrollLines: number): string[] {
  const pages: string[] = [];
  let remaining = text;
  let isFirst = true;
  while (remaining.length > 0) {
    const maxLines = isFirst ? FULL_HEADER_REASON_LINES : scrollLines;
    const { chunk, rest } = takeLines(remaining, REASON_INNER_W, maxLines);
    pages.push(chunk);
    if (rest.length === remaining.length) break; // safety: no forward progress
    remaining = rest;
    isFirst = false;
  }
  return pages.length > 0 ? pages : [''];
}

function takeLines(text: string, innerW: number, maxLines: number): { chunk: string; rest: string } {
  const wholeFits = measureTextWrap(text, innerW);
  if (wholeFits.lineCount <= maxLines) return { chunk: text, rest: '' };

  // Binary search over word boundaries for the largest prefix that fits.
  // `split(/(\s+)/)` preserves separators, so we can rejoin losslessly.
  const words = text.split(/(\s+)/);
  let lo = 0;
  let hi = words.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = words.slice(0, mid).join('');
    if (candidate.length === 0) {
      best = Math.max(best, mid);
      lo = mid + 1;
      continue;
    }
    if (measureTextWrap(candidate, innerW).lineCount <= maxLines) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best === 0) {
    // No word boundary works — the first token alone exceeds the line budget.
    // Fall back to splitting on the codepoint that fits.
    return charSplitFallback(text, innerW, maxLines);
  }
  const chunk = words.slice(0, best).join('').replace(/\s+$/, '');
  const rest = words.slice(best).join('').replace(/^\s+/, '');
  return { chunk, rest };
}

function charSplitFallback(text: string, innerW: number, maxLines: number): { chunk: string; rest: string } {
  let lo = 1;
  let hi = text.length;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measureTextWrap(text.slice(0, mid), innerW).lineCount <= maxLines) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { chunk: text.slice(0, best), rest: text.slice(best) };
}

/** Build a flat page list spanning every claim and every reason sub-page. */
function computePagesForResult(result: LensResult, scrollLines: number): PageRef[] {
  const total = claimCount(result);
  const out: PageRef[] = [];
  for (let i = 0; i < total; i++) {
    const { bottom } = formatLensResult(result, i);
    const chunks = paginateReason(bottom, scrollLines);
    chunks.forEach((text, idx) => out.push({ claimIdx: i, pageWithinClaim: idx, text }));
  }
  return out;
}

function formatCompactHeader(result: LensResult, claimIdx: number): string {
  const { middle } = formatLensResult(result, claimIdx);
  const count = claimCount(result);
  const pos = count > 1 ? `${claimIdx + 1}/${count}` : '';
  if (pos && middle) return `${pos} · ${middle}`;
  return pos || middle;
}

function isDiscreetLayout(layout: ActiveLayout): boolean {
  return layout === 'discreet-minimal' || layout === 'discreet-result' || layout === 'discreet-scroll';
}

function targetLayoutForActivePage(page: PageRef): ActiveLayout {
  const discreet = isDiscreetLayout(activeLayout);
  if (page.pageWithinClaim === 0) return discreet ? 'discreet-result' : 'baseline';
  return discreet ? 'discreet-scroll' : 'baseline-scroll';
}

/** Render `activePages[activePageIndex]` on the active page; rebuild if the
 * target layout differs from the current one. */
async function renderActivePage(): Promise<void> {
  if (currentPage !== 'active') return;
  const page = activePages[activePageIndex];
  if (!page || !currentActiveResult) return;
  const target = targetLayoutForActivePage(page);
  const layoutChanged = target !== activeLayout;
  if (layoutChanged) {
    setActiveLayout(target);
    const ok = await getBridge().rebuildPageContainer(buildActivePage());
    if (!ok) throw new Error('rebuildPageContainer (active) failed.');
  }
  if (page.pageWithinClaim === 0) {
    const { top, middle } = formatLensResult(currentActiveResult, page.claimIdx);
    await Promise.all([
      upgradeText(CONTAINER.claim, NAME.claim, top),
      upgradeText(CONTAINER.verdict, NAME.verdict, middle),
      upgradeText(CONTAINER.reason, NAME.reason, page.text),
    ]);
  } else {
    // Compact-header layout. The header content is set inline at build time,
    // so on layout-cross we only need to update the reason. On same-layout
    // scrolls within the same claim, the header content also doesn't change.
    await upgradeText(CONTAINER.reason, NAME.reason, page.text);
  }
}

/** Render `detailPages[detailPageIndex]` on the history-detail page. */
async function renderHistoryDetailPage(): Promise<void> {
  if (currentPage !== 'history-detail') return;
  const page = detailPages[detailPageIndex];
  const entry = cachedHistoryEntries[historyDetailIndex];
  if (!page || !entry) return;
  const wantsFull = page.pageWithinClaim === 0;
  const layoutChanged = wantsFull !== detailIsFullLayout;
  if (layoutChanged) {
    detailIsFullLayout = wantsFull;
    const ok = await getBridge().rebuildPageContainer(buildHistoryDetailPage(entry, page));
    if (!ok) throw new Error('rebuildPageContainer (history-detail) failed.');
    // Build sets compactHeader / claim+verdict content inline. Only the
    // reason needs an explicit upgrade so callers (and tests) can observe
    // the scroll firing a textContainerUpgrade.
    await upgradeText(CONTAINER.reason, NAME.reason, page.text);
    return;
  }
  if (wantsFull) {
    const { top, middle } = formatLensResult(entry.result, page.claimIdx);
    const total = cachedHistoryEntries.length;
    const idxPrefix = total > 1 && historyDetailIndex >= 0 ? `${historyDetailIndex + 1}/${total} · ` : '';
    await Promise.all([
      upgradeText(CONTAINER.claim, NAME.claim, `${idxPrefix}${top}`),
      upgradeText(CONTAINER.verdict, NAME.verdict, middle),
      upgradeText(CONTAINER.reason, NAME.reason, page.text),
    ]);
  } else {
    await upgradeText(CONTAINER.reason, NAME.reason, page.text);
  }
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
      itemName: MENU_OPTIONS.map((o) => (o.id === 'exit' && exitGeneratesSummary ? EXIT_LABEL_WITH_SUMMARY : o.label)),
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
  switch (activeLayout) {
    case 'discreet-minimal': return buildDiscreetMinimalPage();
    case 'discreet-result': return buildDiscreetResultPage();
    case 'discreet-scroll': return buildDiscreetScrollPage();
    case 'baseline-scroll': return buildBaselineScrollPage();
    case 'baseline':
    default:
      return buildBaselineActivePage();
  }
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
 * Discreet idle layout — a recording dot in the top-right plus an invisible
 * full-screen *text* sink for events. Same sink pattern as baseline: text
 * containers with isEventCapture=1 reliably fire textEvent SCROLL on swipe
 * and sysEvent CLICK on tap on this hardware. A list sink in discreet
 * silently swallowed swipes and emitted taps with a different eventType,
 * which broke claim-walking in discreet mode.
 */
function buildDiscreetMinimalPage(): RebuildPageContainer {
  const sink = makeFullScreenEventSink();
  // Top-right slot that doubles as recording-dot (resting) and status
  // indicator (spinner / "..." / "R1/2"). One container = one LVGL label-
  // cursor caret position; merging the two avoids the second caret in the
  // opposite corner.
  const status = makeDiscreetStatus();
  return new RebuildPageContainer({
    containerTotalNum: 2, listObject: [], textObject: [sink, status],
  });
}

/**
 * Discreet result layout — full-screen question/answer. No dot, no status,
 * no hint: once an answer is on screen it fills the available space. Uses
 * the same text-container event sink as discreet-minimal / baseline so
 * swipes (scroll reason / walk claims) and taps (walk claims → menu) fire
 * reliably.
 */
function buildDiscreetResultPage(): RebuildPageContainer {
  const sink = makeFullScreenEventSink();
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
    containerTotalNum: 4, listObject: [],
    textObject: [sink, claim, verdict, reason],
  });
}

/**
 * Discreet scroll layout — page 2+ of a claim, no chrome. A 1-line compact
 * header at the top (claim position + verdict glyph) plus a tall reason area
 * that holds 8 lines of text. Reason starts at y=36 so the 27px header sits
 * comfortably without overlap.
 */
function buildDiscreetScrollPage(): RebuildPageContainer {
  const sink = makeFullScreenEventSink();
  const page = activePages[activePageIndex];
  const headerContent = page && currentActiveResult ? formatCompactHeader(currentActiveResult, page.claimIdx) : '';
  const header = new TextContainerProperty({
    containerID: CONTAINER.compactHeader, containerName: NAME.compactHeader,
    xPosition: 16, yPosition: 4, width: SCREEN_W - 32, height: 32,
    borderWidth: 0, paddingLength: 2, content: headerContent, isEventCapture: 0,
  });
  // Reason: 8 lines × 27px = 216px text, plus 2×4 padding = 224 container height.
  const reason = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 40, width: SCREEN_W - 32, height: DISCREET_SCROLL_REASON_LINES * LINE_PX + 8,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  return new RebuildPageContainer({
    containerTotalNum: 3, listObject: [],
    textObject: [sink, header, reason],
  });
}

/**
 * Baseline scroll layout — page 2+ of a claim, keeps REC + hint chrome.
 * Compact header at the top, reason in the middle (7 lines), REC + hint at
 * the bottom at the usual y=256 row.
 */
function buildBaselineScrollPage(): RebuildPageContainer {
  const sink = makeFullScreenEventSink();
  const page = activePages[activePageIndex];
  const headerContent = page && currentActiveResult ? formatCompactHeader(currentActiveResult, page.claimIdx) : '';
  const header = new TextContainerProperty({
    containerID: CONTAINER.compactHeader, containerName: NAME.compactHeader,
    xPosition: 16, yPosition: 4, width: SCREEN_W - 32, height: 32,
    borderWidth: 0, paddingLength: 2, content: headerContent, isEventCapture: 0,
  });
  // Reason: 7 lines × 27px = 189px text + 2×4 padding = 197 container height.
  const reason = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 40, width: SCREEN_W - 32, height: BASELINE_SCROLL_REASON_LINES * LINE_PX + 8,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  const rec = new TextContainerProperty({
    containerID: CONTAINER.recIndicator, containerName: NAME.recIndicator,
    xPosition: SCREEN_W - 96, yPosition: 256, width: 80, height: 28,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.activeHint, containerName: NAME.activeHint,
    xPosition: 16, yPosition: 256, width: SCREEN_W - 120, height: 28,
    borderWidth: 0, paddingLength: 4, content: ACTIVE_HINT_DEFAULT, isEventCapture: 0,
  });
  return new RebuildPageContainer({
    containerTotalNum: 5, listObject: [],
    textObject: [sink, header, reason, rec, hint],
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

function buildHistoryDetailPage(entry: HistoryEntry, page: PageRef): RebuildPageContainer {
  if (page.pageWithinClaim !== 0) return buildHistoryDetailScrollPage(entry, page);
  const { top, middle } = formatLensResult(entry.result, page.claimIdx);
  const total = cachedHistoryEntries.length;
  // X/Y position indicator across the current session's entries — only shown
  // when there's more than one, so a single-entry session doesn't get the
  // chrome.
  const idxPrefix = total > 1 && historyDetailIndex >= 0 ? `${historyDetailIndex + 1}/${total} · ` : '';
  const claim = new TextContainerProperty({
    containerID: CONTAINER.claim, containerName: NAME.claim,
    xPosition: 16, yPosition: 32, width: SCREEN_W - 32, height: 68,
    borderWidth: 0, paddingLength: 4, content: `${idxPrefix}${top}`, isEventCapture: 0,
  });
  const verdict = new TextContainerProperty({
    containerID: CONTAINER.verdict, containerName: NAME.verdict,
    xPosition: 16, yPosition: 102, width: SCREEN_W - 32, height: 26,
    borderWidth: 0, paddingLength: 4, content: middle, isEventCapture: 0,
  });
  const reason = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 130, width: SCREEN_W - 32, height: 126,
    borderWidth: 0, paddingLength: 4, content: page.text, isEventCapture: 1,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.activeList, containerName: NAME.activeList,
    xPosition: 16, yPosition: 260, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4, content: 'Tap: back · Swipe: scroll', isEventCapture: 0,
  });
  return new RebuildPageContainer({ containerTotalNum: 4, listObject: [], textObject: [claim, verdict, reason, hint] });
}

/** History-detail scroll layout — page 2+ of a claim's reason. Compact header
 * + tall reason area + bottom hint, with the reason container as the event
 * sink so swipes register. */
function buildHistoryDetailScrollPage(entry: HistoryEntry, page: PageRef): RebuildPageContainer {
  const headerContent = formatCompactHeader(entry.result, page.claimIdx);
  const header = new TextContainerProperty({
    containerID: CONTAINER.compactHeader, containerName: NAME.compactHeader,
    xPosition: 16, yPosition: 4, width: SCREEN_W - 32, height: 32,
    borderWidth: 0, paddingLength: 2, content: headerContent, isEventCapture: 0,
  });
  const reason = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 40, width: SCREEN_W - 32, height: DISCREET_SCROLL_REASON_LINES * LINE_PX + 8,
    borderWidth: 0, paddingLength: 4, content: page.text, isEventCapture: 1,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.activeList, containerName: NAME.activeList,
    xPosition: 16, yPosition: 260, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4, content: 'Tap: back · Swipe: scroll', isEventCapture: 0,
  });
  return new RebuildPageContainer({ containerTotalNum: 3, listObject: [], textObject: [header, reason, hint] });
}

/** Clear per-session HUD state so a fresh session doesn't inherit stale buffers. */
export function resetHudSessionState(): void {
  menuPersona = null;
  cachedHistoryEntries = [];
  detailPages = [];
  detailPageIndex = 0;
  detailIsFullLayout = true;
  historyDetailIndex = -1;
  activePages = [];
  activePageIndex = 0;
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
