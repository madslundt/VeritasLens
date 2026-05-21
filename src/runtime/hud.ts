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
  // picker badge — visible only when auto-summary is on
  summaryBadge: 32,
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
  summaryBadge: 'vl-sum-badge',
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
// Claim-slot inner heights:
//   baseline claim       = 62px container, padding 4 → inner 54px = 2 × 27 lines
//   discreet-result claim = 68px container, padding 4 → inner 60px = 2 × 27 lines
// Claim text wider than the slot overflows visually into the verdict row, so
// we paginate any excess into compact-header continuation pages.
const BASELINE_CLAIM_LINES = 2;
const DISCREET_CLAIM_LINES = 2;
// On page 0 of a claim (full header layout), reason height varies by mode but
// inner area accommodates ~4 lines of 27px in both baseline (134-8=126px → 4)
// and discreet-result (126-8=118px → 4).
const FULL_HEADER_REASON_LINES = 4;
// On page 1+ of a claim (compact header layout), reason expands. Baseline
// keeps REC + hint chrome so gets 7 lines; discreet drops chrome for 8 lines.
const BASELINE_SCROLL_REASON_LINES = 7;
const DISCREET_SCROLL_REASON_LINES = 8;

/**
 * One screen-worth of result content. Multi-claim results and long claim/
 * reason text expand into a flat list of these — swipe-down increments the
 * index, swipe-up decrements. `pageWithinClaim === 0` is the full-header
 * page; higher values are compact-header scroll pages.
 *
 * `claimChunk` is set on the header page only — it carries the chunk of the
 * claim that fits the (small) claim slot. `text` is what goes in the reason
 * slot: the first reason chunk for the header page, or a claim-continuation
 * or reason-continuation chunk for scroll pages.
 */
type PageRef = {
  claimIdx: number;
  pageWithinClaim: number;
  text: string;
  claimChunk?: string;
};

/** A page in the session-wide flat list spanning every entry in the current
 * session. Adds `entryIdx` (index into `sessionEntries`) on top of `PageRef`. */
type SessionPageRef = PageRef & { entryIdx: number };

// Session-wide flat scroll model. The cursor walks across every entry in the
// current session (split per claim by the lifecycle), so a swipe-up at the
// first claim of the latest analysis hops to the previous question rather
// than no-op'ing. `latestAnalysisRange` + `useWithinAnalysisIndicator` track
// the indicator format (1/N within-analysis vs X/Y session-relative).
let sessionEntries: HistoryEntry[] = [];
let sessionPages: SessionPageRef[] = [];
let sessionPageIndex = 0;
// True when the active result has been hidden via tap-back from the menu or
// swipe-down past the session end. The session-pages list + index are
// preserved so the next scroll-up can reveal the last session page; the
// visible layout is demoted to baseline / discreet-minimal in the meantime.
let activeHidden = false;
/** First/last entry index of the most recent analysis. Drives the "within
 *  analysis" indicator scope: when the cursor sits inside this range the
 *  indicator counts within-analysis claims; outside, it counts session-wide. */
let latestAnalysisRange: { firstEntry: number; lastEntry: number } | null = null;
/** Indicator mode. Flips to false the first time the cursor leaves
 *  `latestAnalysisRange` (sticks until the next first-analysis-of-session). */
let useWithinAnalysisIndicator = true;
let detailPages: PageRef[] = [];
let detailPageIndex = 0;
/** Tracks which history-detail layout is currently on screen (full vs scroll). */
let detailIsFullLayout = true;
/** Index into cachedHistoryEntries of the entry currently shown on history-detail. */
let historyDetailIndex = -1;
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
  const list = getPickerPersonas();
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
  // history-detail uses the discreet-result-style claim slot (68px / 2 lines).
  detailPages = computePagesForResult(entry.result, DISCREET_SCROLL_REASON_LINES, DISCREET_CLAIM_LINES);
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
  detailPages = computePagesForResult(entry.result, DISCREET_SCROLL_REASON_LINES, DISCREET_CLAIM_LINES);
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

/** Optional context the lifecycle passes after running a new analysis.
 *  Without it (tests, menu replay), `setLensResult` synthesizes a 1-entry
 *  "session" from the result alone — within-analysis scope only. */
export interface SetLensResultContext {
  sessionEntries: HistoryEntry[];
  newEntryIds: ReadonlySet<string>;
}

/** Synthetic id prefix used when `setLensResult(result)` is called without a
 *  session context. Kept stable so a follow-up call replaces the prior synthetic
 *  entry deterministically (rather than accumulating ghost entries). */
const SYNTHETIC_ENTRY_ID = '__veritaslens_synthetic_active__';

function synthesizeEntryFromResult(result: LensResult): HistoryEntry {
  return {
    id: SYNTHETIC_ENTRY_ID,
    sessionId: '',
    timestamp: 0,
    lensId: '',
    lensName: '',
    question: '',
    badge: '',
    quote: '',
    result,
  };
}

export async function setLensResult(result: LensResult | null, context?: SetLensResultContext): Promise<void> {
  if (currentPage !== 'active' && currentPage !== 'history-detail') {
    // User is off the active page (typically on the menu after opening it
    // mid-analysis). Stash the answer so the next showActivePage replays it.
    if (result) pendingActiveResult = result;
    return;
  }

  // Null result paths — clear or demote, matching prior behaviour. Discreet
  // demotes to the dot-only idle layout; baseline-scroll falls back to baseline
  // (so the claim/verdict containers exist again); baseline just clears text.
  if (!result) {
    sessionEntries = [];
    sessionPages = [];
    sessionPageIndex = 0;
    activeHidden = false;
    latestAnalysisRange = null;
    useWithinAnalysisIndicator = true;
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

  const wasEmpty = sessionPages.length === 0;

  if (context) {
    // Lifecycle path — full session view with cross-analysis scroll.
    sessionEntries = context.sessionEntries;
    recomputeSessionPages();
    latestAnalysisRange = computeRangeFromIds(sessionEntries, context.newEntryIds);
    if (wasEmpty && latestAnalysisRange) {
      // First analysis of the session: jump cursor to the first page of the
      // new analysis and start in within-analysis mode (today's behavior).
      sessionPageIndex = firstPageIndexForEntry(latestAnalysisRange.firstEntry);
      useWithinAnalysisIndicator = latestAnalysisClaimCount() > 1;
      activeHidden = false;
    } else {
      // Subsequent analysis: preserve the cursor. The user stays on whatever
      // entry they were reading. The new analysis is reachable by swiping
      // down. activeHidden is preserved (reveal jumps to session end).
      // New entries were appended → existing sessionPageIndex still points to
      // the same entry/page. Clamp in case the prior cursor was past-end.
      if (sessionPageIndex >= sessionPages.length) {
        sessionPageIndex = Math.max(0, sessionPages.length - 1);
      }
      // Indicator mode: only stay within-analysis if the preserved cursor
      // happens to sit inside the new latest range (effectively never, since
      // those entries are brand new and the cursor predates them).
      useWithinAnalysisIndicator = cursorInLatestRange();
    }
  } else {
    // Direct-call path (tests, menu replay): synthesize a 1-entry session
    // holding the multi-claim result whole. Within-analysis indicator uses
    // the claim count of the result, matching today's "1/N" behavior.
    sessionEntries = [synthesizeEntryFromResult(result)];
    recomputeSessionPages();
    latestAnalysisRange = { firstEntry: 0, lastEntry: 0 };
    sessionPageIndex = 0;
    useWithinAnalysisIndicator = claimCount(result) > 1;
    activeHidden = false;
  }

  if (currentPage === 'active' && !activeHidden) {
    await renderActivePage();
  }
}

/** Outcome of a swipe on the active page, used by lifecycle to update app phase. */
export type ScrollActiveResult = 'scrolled' | 'noop' | 'revealed' | 'hidden';

export async function scrollActiveReason(dir: 1 | -1): Promise<ScrollActiveResult> {
  if (currentPage !== 'active') return 'noop';

  // Hidden state: questions were tucked away via tap-back or swipe-down. A
  // swipe-up always reveals the LAST page of the LAST entry (= session end /
  // Y/Y). If a new analysis arrived while hidden, that's where reveal lands.
  // Swipe-down while hidden stays hidden.
  if (activeHidden) {
    if (dir === -1 && sessionPages.length > 0) {
      activeHidden = false;
      sessionPageIndex = sessionPages.length - 1;
      useWithinAnalysisIndicator = false;
      await renderActivePage();
      return 'revealed';
    }
    return 'noop';
  }

  if (sessionPages.length === 0) return 'noop';

  // Swipe-down past the LAST page of the LAST entry hides the result. Layout
  // demotes to listening view; sessionPages stay so a follow-up swipe-up can
  // re-reveal. (= "end of session" boundary.)
  if (dir === 1 && sessionPageIndex === sessionPages.length - 1) {
    await hideActiveResultInPlace();
    return 'hidden';
  }

  const next = sessionPageIndex + dir;
  if (next < 0 || next >= sessionPages.length) return 'noop';
  sessionPageIndex = next;

  // Mode flip: any page outside latestAnalysisRange engages session-relative
  // indicator. Once flipped, stays flipped until the next first-analysis
  // resets it.
  if (useWithinAnalysisIndicator && !cursorInLatestRange()) {
    useWithinAnalysisIndicator = false;
  }

  await renderActivePage();
  return 'scrolled';
}

/** Demote the active page to its idle layout (baseline / discreet-minimal)
 * while keeping `sessionPages` and `sessionPageIndex` intact, so a swipe-up
 * can reveal the last session page again. Shared by swipe-down dismiss and
 * tap-back from the menu. */
async function hideActiveResultInPlace(): Promise<void> {
  activeHidden = true;
  const targetIdle: ActiveLayout = isDiscreetLayout(activeLayout) ? 'discreet-minimal' : 'baseline';
  if (activeLayout !== targetIdle) {
    setActiveLayout(targetIdle);
    const ok = await getBridge().rebuildPageContainer(buildActivePage());
    if (!ok) throw new Error('rebuildPageContainer (hide) failed.');
    return;
  }
  // Already on the idle layout (e.g., single-page baseline). Wipe the visible
  // claim / verdict / reason text but keep the layout containers.
  await Promise.all([
    upgradeText(CONTAINER.claim, NAME.claim, ''),
    upgradeText(CONTAINER.verdict, NAME.verdict, ''),
    upgradeText(CONTAINER.reason, NAME.reason, ''),
  ]);
}

/** Mark the active result as hidden without clearing it. Used by the menu's
 * Back option so the next swipe-up can re-reveal the last session page. */
export function markActiveHidden(): void {
  if (sessionPages.length > 0) activeHidden = true;
}

/** True iff the active result is preserved in memory but currently hidden. */
export function isActiveHidden(): boolean { return activeHidden; }

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
  // Capture the baseline hint at flash time rather than recomputing it from
  // live signals in the timer callback — the picker layout for "now" is the
  // correct thing to restore, even if a settings change has shifted the
  // persona list during the 2.5 s flash window.
  const list = getPickerPersonas();
  const baseline = list.length > 1
    ? 'Swipe ⇅ · Tap: start · Double-tap: exit'
    : 'Tap: start · Double-tap: exit';
  await upgradeText(CONTAINER.pickerHint, NAME.pickerHint, message);
  pickerHintFlashTimer = setTimeout(() => {
    pickerHintFlashTimer = null;
    if (currentPage !== 'picker') return;
    void upgradeText(CONTAINER.pickerHint, NAME.pickerHint, baseline);
  }, ms);
}

export type SummaryBadgeState = 'idle' | 'generating' | 'ready';

let summaryBadgeReadyTimer: ReturnType<typeof setTimeout> | null = null;

function summaryBadgeBaseline(): string {
  return settings().autoSummaryEnabled ? 'auto-summary' : '';
}

/**
 * Drive the picker page's top-right summary badge through final-summary states.
 * No-op when the picker isn't on screen; safe to call from lifecycle hooks.
 *
 * - 'generating' → "generating summary..."
 * - 'ready'      → "summary ready!", auto-reverts to baseline after 2.5 s
 * - 'idle'       → baseline ("auto-summary" if enabled, blank otherwise)
 *
 * When autoSummaryEnabled is false the slot stays blank regardless of state —
 * the feature isn't surfaced to the wearer so progress shouldn't be either.
 */
export async function setSummaryBadgeState(state: SummaryBadgeState): Promise<void> {
  if (currentPage !== 'picker') return;
  if (summaryBadgeReadyTimer) {
    clearTimeout(summaryBadgeReadyTimer);
    summaryBadgeReadyTimer = null;
  }
  if (!settings().autoSummaryEnabled) {
    await upgradeText(CONTAINER.summaryBadge, NAME.summaryBadge, '');
    return;
  }
  if (state === 'generating') {
    await upgradeText(CONTAINER.summaryBadge, NAME.summaryBadge, 'generating summary...');
    return;
  }
  if (state === 'ready') {
    await upgradeText(CONTAINER.summaryBadge, NAME.summaryBadge, 'summary ready!');
    summaryBadgeReadyTimer = setTimeout(() => {
      summaryBadgeReadyTimer = null;
      if (currentPage !== 'picker') return;
      void upgradeText(CONTAINER.summaryBadge, NAME.summaryBadge, summaryBadgeBaseline());
    }, 2500);
    return;
  }
  await upgradeText(CONTAINER.summaryBadge, NAME.summaryBadge, summaryBadgeBaseline());
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

/** Decorate a claim's top line with the position tag and optional Auto badge.
 *  Position goes inside Auto (`Auto · 1/2 · X`) so the badge always reads
 *  first — matching the pre-session-scroll layout. */
function applyClaimPrefixes(top: string, posTag: string, autoSelected: boolean): string {
  let s = top;
  if (posTag) s = s ? `${posTag} · ${s}` : posTag;
  if (autoSelected) s = s ? `Auto · ${s}` : 'Auto';
  return s;
}

/** Base claim/verdict/reason for a result, *without* position tag or Auto
 *  prefix. The indicator/Auto are stamped in at render-time by
 *  `applyClaimPrefixes` because the format depends on the cursor's session
 *  context (within-analysis "1/N" vs session-relative "X/Y"). */
function formatLensResult(result: LensResult, claimIdx: number = 0): { top: string; middle: string; bottom: string } {
  return formatLensResultBase(result, claimIdx);
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
      return { top: '', middle: '', bottom: formatSessionSummaryBody(result) };
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

/**
 * Build the scrollable body for a session-summary entry. Combines the
 * narrative summary with TOPICS and KEY POINTS sections so the existing
 * 200-char-per-page pagination on the detail page walks through every
 * topic and detail captured during the session.
 *
 * Sections with no content are omitted (no stray "TOPICS\n" header). When
 * topics and keyPoints are both empty the body collapses to the summary
 * alone, preserving the original pre-expansion rendering as a fallback.
 */
function formatSessionSummaryBody(result: Extract<LensResult, { type: 'session-summary' }>): string {
  const sections: string[] = [];
  if (result.summary && result.summary.trim().length > 0) {
    sections.push(result.summary.trim());
  }
  const topics = (result.topics ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (topics.length > 0) {
    sections.push(['TOPICS', ...topics.map((t) => `• ${t}`)].join('\n'));
  }
  const keyPoints = (result.keyPoints ?? []).map((k) => k.trim()).filter((k) => k.length > 0);
  if (keyPoints.length > 0) {
    sections.push(['KEY POINTS', ...keyPoints.map((k) => `• ${k}`)].join('\n'));
  }
  return sections.join('\n\n');
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
 * Cached wrapper around `measureTextWrap`. The pagination binary search
 * re-probes overlapping prefixes of the same (text, width) pair many times
 * per claim; on the G2's constrained CPU each probe involves a font-metric
 * lookup. The cache lives for the lifetime of one paginateText call (passed
 * in explicitly so it can't leak across calls) and is keyed on width+text
 * so multiple widths in flight don't collide.
 */
type WrapCache = Map<string, number>;

function cachedLineCount(cache: WrapCache, text: string, innerW: number): number {
  // Pre-pad the key with the width so two paginations at different widths
  // sharing a cache (we never share, but the key is cheap) can't collide.
  const key = `${innerW} ${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const measured = measureTextWrap(text, innerW).lineCount;
  cache.set(key, measured);
  return measured;
}

/**
 * Split arbitrary text into screen-sized chunks. The first page uses the
 * tighter `firstLines` budget (it sits inside a smaller slot); subsequent
 * pages use the larger `scrollLines` budget (compact header above). Word
 * boundaries are preferred; unbreakable runs fall back to character splits.
 */
function paginateText(text: string, innerW: number, firstLines: number, scrollLines: number): string[] {
  const pages: string[] = [];
  let remaining = text;
  let isFirst = true;
  const cache: WrapCache = new Map();
  while (remaining.length > 0) {
    const maxLines = isFirst ? firstLines : scrollLines;
    const { chunk, rest } = takeLines(remaining, innerW, maxLines, cache);
    pages.push(chunk);
    if (rest.length === remaining.length) break; // safety: no forward progress
    remaining = rest;
    isFirst = false;
  }
  return pages.length > 0 ? pages : [''];
}

function takeLines(text: string, innerW: number, maxLines: number, cache: WrapCache): { chunk: string; rest: string } {
  if (cachedLineCount(cache, text, innerW) <= maxLines) return { chunk: text, rest: '' };

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
    if (cachedLineCount(cache, candidate, innerW) <= maxLines) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best === 0) {
    // No word boundary works — the first token alone exceeds the line budget.
    // Fall back to splitting on the codepoint that fits.
    return charSplitFallback(text, innerW, maxLines, cache);
  }
  const chunk = words.slice(0, best).join('').replace(/\s+$/, '');
  const rest = words.slice(best).join('').replace(/^\s+/, '');
  return { chunk, rest };
}

function charSplitFallback(text: string, innerW: number, maxLines: number, cache: WrapCache): { chunk: string; rest: string } {
  let lo = 1;
  let hi = text.length;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cachedLineCount(cache, text.slice(0, mid), innerW) <= maxLines) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { chunk: text.slice(0, best), rest: text.slice(best) };
}

/**
 * Build a flat page list spanning every claim, every claim continuation, and
 * every reason continuation. Page 0 of each claim is the header page (full
 * claim chunk + verdict + first reason chunk). If the claim doesn't fit the
 * claim slot, the overflow continues on compact-header pages before the
 * reason starts; same compact-header layout, just claim text in the reason
 * slot. After claim continuations come the reason continuations.
 */
function computePagesForResult(result: LensResult, scrollLines: number, claimLines: number): PageRef[] {
  const total = claimCount(result);
  const out: PageRef[] = [];
  for (let i = 0; i < total; i++) {
    const { top, bottom } = formatLensResult(result, i);
    // Paginate the claim against the claim slot first, then the scroll slot
    // for any continuations.
    const claimChunks = paginateText(top, REASON_INNER_W, claimLines, scrollLines);
    const reasonChunks = paginateText(bottom, REASON_INNER_W, FULL_HEADER_REASON_LINES, scrollLines);

    // Header page: first claim chunk in claim slot, first reason chunk in reason slot.
    out.push({
      claimIdx: i,
      pageWithinClaim: 0,
      text: reasonChunks[0] ?? '',
      claimChunk: claimChunks[0] ?? '',
    });

    let pageIdx = 1;
    // Claim continuation pages — scroll layout, continuation text in the
    // reason slot (visually "the claim continues here").
    for (let c = 1; c < claimChunks.length; c++) {
      out.push({ claimIdx: i, pageWithinClaim: pageIdx++, text: claimChunks[c]! });
    }
    // Reason continuation pages — scroll layout, continuation text in the
    // reason slot.
    for (let r = 1; r < reasonChunks.length; r++) {
      out.push({ claimIdx: i, pageWithinClaim: pageIdx++, text: reasonChunks[r]! });
    }
  }
  return out;
}

function formatCompactHeader(result: LensResult, claimIdx: number, posTag: string): string {
  const { middle } = formatLensResult(result, claimIdx);
  if (posTag && middle) return `${posTag} · ${middle}`;
  return posTag || middle;
}

function isDiscreetLayout(layout: ActiveLayout): boolean {
  return layout === 'discreet-minimal' || layout === 'discreet-result' || layout === 'discreet-scroll';
}

function targetLayoutForActivePage(page: PageRef): ActiveLayout {
  const discreet = isDiscreetLayout(activeLayout);
  if (page.pageWithinClaim === 0) return discreet ? 'discreet-result' : 'baseline';
  return discreet ? 'discreet-scroll' : 'baseline-scroll';
}

/** The entry the active-page cursor is currently pointing at. */
function currentActiveEntry(): HistoryEntry | null {
  const p = sessionPages[sessionPageIndex];
  return p ? sessionEntries[p.entryIdx] ?? null : null;
}

/** Sum of claims across `sessionEntries[0..entryIdx-1]` — global claim offset
 *  of an entry's first claim. */
function claimsBefore(entryIdx: number): number {
  let sum = 0;
  for (let i = 0; i < entryIdx && i < sessionEntries.length; i++) {
    sum += claimCount(sessionEntries[i]!.result);
  }
  return sum;
}

function totalSessionClaims(): number {
  return claimsBefore(sessionEntries.length);
}

function latestAnalysisClaimCount(): number {
  if (!latestAnalysisRange) return 0;
  return claimsBefore(latestAnalysisRange.lastEntry + 1) - claimsBefore(latestAnalysisRange.firstEntry);
}

function cursorInLatestRange(): boolean {
  if (!latestAnalysisRange) return false;
  const p = sessionPages[sessionPageIndex];
  if (!p) return false;
  return p.entryIdx >= latestAnalysisRange.firstEntry && p.entryIdx <= latestAnalysisRange.lastEntry;
}

/** Build the position tag for the active page's claim line / compact header.
 *  Returns "" when there's nothing to show (single-claim session, or
 *  within-analysis mode with a single-claim latest analysis). */
function activeIndicatorTag(): string {
  const p = sessionPages[sessionPageIndex];
  if (!p) return '';
  if (useWithinAnalysisIndicator && latestAnalysisRange && cursorInLatestRange()) {
    const count = latestAnalysisClaimCount();
    if (count <= 1) return '';
    const offset = (claimsBefore(p.entryIdx) - claimsBefore(latestAnalysisRange.firstEntry)) + p.claimIdx;
    return `${offset + 1}/${count}`;
  }
  const total = totalSessionClaims();
  if (total <= 1) return '';
  const x = claimsBefore(p.entryIdx) + p.claimIdx;
  return `${x + 1}/${total}`;
}

/** Find the contiguous run of `sessionEntries` whose ids are in `newIds`.
 *  Since lifecycle appends new analyses at the tail, this is just the tail
 *  segment — but we scan defensively in case the persistence layer reordered. */
function computeRangeFromIds(
  entries: HistoryEntry[],
  newIds: ReadonlySet<string>,
): { firstEntry: number; lastEntry: number } | null {
  if (entries.length === 0 || newIds.size === 0) return null;
  let first = -1;
  let last = -1;
  for (let i = 0; i < entries.length; i++) {
    if (newIds.has(entries[i]!.id)) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return null;
  return { firstEntry: first, lastEntry: last };
}

/** Index into `sessionPages` of the first page (pageWithinClaim===0,
 *  claimIdx===0) for the given entry. Returns 0 when the entry has no
 *  pages — defensive fallback. */
function firstPageIndexForEntry(entryIdx: number): number {
  for (let i = 0; i < sessionPages.length; i++) {
    if (sessionPages[i]!.entryIdx === entryIdx) return i;
  }
  return 0;
}

/** Rebuild `sessionPages` by paginating every entry's result. The scroll-line
 *  and claim-line budgets follow the current active layout (discreet vs
 *  baseline); a layout change requires re-running this so the chunk sizes
 *  match the new container heights. */
function recomputeSessionPages(): void {
  const discreet = isDiscreetLayout(activeLayout);
  const scrollLines = discreet ? DISCREET_SCROLL_REASON_LINES : BASELINE_SCROLL_REASON_LINES;
  const claimLines = discreet ? DISCREET_CLAIM_LINES : BASELINE_CLAIM_LINES;
  const out: SessionPageRef[] = [];
  for (let i = 0; i < sessionEntries.length; i++) {
    const entry = sessionEntries[i]!;
    const entryPages = computePagesForResult(entry.result, scrollLines, claimLines);
    for (const p of entryPages) out.push({ ...p, entryIdx: i });
  }
  sessionPages = out;
}

/** Render the active page from the session cursor; rebuild the page container
 *  if the target layout differs from the current one. */
async function renderActivePage(): Promise<void> {
  if (currentPage !== 'active') return;
  // Clamp the index in case a result that arrived mid-scroll shortened the
  // page list while a queued scroll event still references the old position.
  if (sessionPages.length > 0 && sessionPageIndex >= sessionPages.length) {
    sessionPageIndex = sessionPages.length - 1;
  }
  const page = sessionPages[sessionPageIndex];
  const entry = currentActiveEntry();
  if (!page || !entry) return;
  const target = targetLayoutForActivePage(page);
  const layoutChanged = target !== activeLayout;
  if (layoutChanged) {
    setActiveLayout(target);
    const ok = await getBridge().rebuildPageContainer(buildActivePage());
    if (!ok) throw new Error('rebuildPageContainer (active) failed.');
  }
  if (page.pageWithinClaim === 0) {
    const { middle } = formatLensResult(entry.result, page.claimIdx);
    const decoratedClaim = applyClaimPrefixes(
      page.claimChunk ?? '',
      activeIndicatorTag(),
      entry.result.autoSelected === true,
    );
    await Promise.all([
      upgradeText(CONTAINER.claim, NAME.claim, decoratedClaim),
      upgradeText(CONTAINER.verdict, NAME.verdict, middle),
      upgradeText(CONTAINER.reason, NAME.reason, page.text),
    ]);
  } else {
    // Compact-header layout. The header content is set inline at build time
    // (uses activeIndicatorTag() of the page that triggered the rebuild). On
    // same-layout scrolls within the same claim only the reason changes.
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
    const { middle } = formatLensResult(entry.result, page.claimIdx);
    const total = cachedHistoryEntries.length;
    const idxTag = total > 1 && historyDetailIndex >= 0 ? `${historyDetailIndex + 1}/${total}` : '';
    const decorated = applyClaimPrefixes(page.claimChunk ?? '', idxTag, entry.result.autoSelected === true);
    await Promise.all([
      upgradeText(CONTAINER.claim, NAME.claim, decorated),
      upgradeText(CONTAINER.verdict, NAME.verdict, middle),
      upgradeText(CONTAINER.reason, NAME.reason, page.text),
    ]);
  } else {
    await upgradeText(CONTAINER.reason, NAME.reason, page.text);
  }
}

// ------- page builders ----------------------------------------------------

/** Sum container counts so a future build-time list change can't drift away
 *  from the SDK's `containerTotalNum` field — that mismatch silently drops
 *  containers on the wire. */
function totalContainers(
  listObject: ReadonlyArray<unknown>,
  textObject: ReadonlyArray<unknown>,
): number {
  return listObject.length + textObject.length;
}

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
  const listObject = [sink];
  const textObject = [title, msg];
  return new Ctor({ containerTotalNum: totalContainers(listObject, textObject), listObject, textObject });
}

function buildPickerPage(mode: 'create' | 'rebuild'): CreateStartUpPageContainer | RebuildPageContainer {
  const currentPersonas = getPickerPersonas();
  const title = new TextContainerProperty({
    containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 8,
    width: 240, height: 36, borderWidth: 0, paddingLength: 4,
    content: 'Pick a lens', isEventCapture: 0,
  });
  const summaryBadge = new TextContainerProperty({
    containerID: CONTAINER.summaryBadge, containerName: NAME.summaryBadge,
    xPosition: SCREEN_W - 196, yPosition: 8, width: 180, height: 32,
    borderWidth: 0, paddingLength: 4,
    content: settings().autoSummaryEnabled ? 'auto-summary' : '',
    isEventCapture: 0,
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
  const listObject = [list];
  const textObject = [title, hint, summaryBadge];
  return new Ctor({ containerTotalNum: totalContainers(listObject, textObject), listObject, textObject });
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
  const listObject = [list];
  const textObject = [title, spinner, clock];
  return new RebuildPageContainer({ containerTotalNum: totalContainers(listObject, textObject), listObject, textObject });
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
  // Claim slot grew from 54→62 px so longer questions can wrap to two lines
  // instead of being silently truncated; verdict and reason shift down by 6
  // and reason shrinks by 6 to absorb the change without disturbing the
  // bottom REC/hint row.
  const claim = new TextContainerProperty({
    containerID: CONTAINER.claim, containerName: NAME.claim,
    xPosition: 16, yPosition: 32, width: SCREEN_W - 32, height: 62,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  // Verdict slot is single-line but holds variable text (trivia answers,
  // meeting-prep "From: <source>", etc.) that can have descenders. h=32 with
  // paddingLength=4 leaves 24 px inner, enough for the full glyph including
  // descender.
  const verdict = new TextContainerProperty({
    containerID: CONTAINER.verdict, containerName: NAME.verdict,
    xPosition: 16, yPosition: 96, width: SCREEN_W - 32, height: 32,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  // Reason at h=126 → inner 118 / 27 ≈ 4.37 lines, still fits the 4-line
  // FULL_HEADER_REASON_LINES budget. Bottom REC/hint row at y=260 unchanged.
  const reason = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 130, width: SCREEN_W - 32, height: 126,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  const rec = new TextContainerProperty({
    containerID: CONTAINER.recIndicator, containerName: NAME.recIndicator,
    xPosition: SCREEN_W - 96, yPosition: 260, width: 80, height: 28,
    borderWidth: 0, paddingLength: 4, content: '● REC', isEventCapture: 0,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.activeHint, containerName: NAME.activeHint,
    xPosition: 16, yPosition: 260, width: SCREEN_W - 120, height: 28,
    borderWidth: 0, paddingLength: 4, content: ACTIVE_HINT_DEFAULT, isEventCapture: 0,
  });
  const textObject = [eventCapture, status, claim, verdict, reason, rec, hint];
  return new RebuildPageContainer({
    containerTotalNum: totalContainers([], textObject), listObject: [], textObject,
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
  const textObject = [sink, status];
  return new RebuildPageContainer({
    containerTotalNum: totalContainers([], textObject), listObject: [], textObject,
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
  // Same descender fix as the baseline verdict — h=32 with paddingLength=4
  // yields 24 px inner area, large enough for the full y/g/p glyph. There's
  // no bottom chrome on this layout, so the reason container also gains
  // space (extends from y=130/h=126 to y=136/h=146) for the same reason on
  // its last paginated line.
  const verdict = new TextContainerProperty({
    containerID: CONTAINER.verdict, containerName: NAME.verdict,
    xPosition: 16, yPosition: 102, width: SCREEN_W - 32, height: 32,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  const reason = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 138, width: SCREEN_W - 32, height: 146,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 0,
  });
  const textObject = [sink, claim, verdict, reason];
  return new RebuildPageContainer({
    containerTotalNum: totalContainers([], textObject), listObject: [], textObject,
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
  const page = sessionPages[sessionPageIndex];
  const entry = currentActiveEntry();
  const headerContent = page && entry ? formatCompactHeader(entry.result, page.claimIdx, activeIndicatorTag()) : '';
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
  const textObject = [sink, header, reason];
  return new RebuildPageContainer({
    containerTotalNum: totalContainers([], textObject), listObject: [], textObject,
  });
}

/**
 * Baseline scroll layout — page 2+ of a claim, keeps REC + hint chrome.
 * Compact header at the top, reason in the middle (7 lines), REC + hint at
 * the bottom at the usual y=256 row.
 */
function buildBaselineScrollPage(): RebuildPageContainer {
  const sink = makeFullScreenEventSink();
  const page = sessionPages[sessionPageIndex];
  const entry = currentActiveEntry();
  const headerContent = page && entry ? formatCompactHeader(entry.result, page.claimIdx, activeIndicatorTag()) : '';
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
  const textObject = [sink, header, reason, rec, hint];
  return new RebuildPageContainer({
    containerTotalNum: totalContainers([], textObject), listObject: [], textObject,
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
  const listObject = [list];
  const textObject = [title, hint];
  return new RebuildPageContainer({ containerTotalNum: totalContainers(listObject, textObject), listObject, textObject });
}

function buildHistoryDetailPage(entry: HistoryEntry, page: PageRef): RebuildPageContainer {
  if (page.pageWithinClaim !== 0) return buildHistoryDetailScrollPage(entry, page);
  const { middle } = formatLensResult(entry.result, page.claimIdx);
  const total = cachedHistoryEntries.length;
  // X/Y position indicator across the current session's entries — only shown
  // when there's more than one, so a single-entry session doesn't get the
  // chrome.
  const idxTag = total > 1 && historyDetailIndex >= 0 ? `${historyDetailIndex + 1}/${total}` : '';
  const decoratedClaim = applyClaimPrefixes(page.claimChunk ?? '', idxTag, entry.result.autoSelected === true);
  // History-detail has no top status chrome, so claim can start higher than
  // the active page (y=24 vs y=32). That extra 8 px absorbs the verdict slot
  // growth (26 → 32) without squeezing the reason container's 4-line budget;
  // descenders on trivia answers and "From: <source>" lines no longer clip.
  const claim = new TextContainerProperty({
    containerID: CONTAINER.claim, containerName: NAME.claim,
    xPosition: 16, yPosition: 24, width: SCREEN_W - 32, height: 68,
    borderWidth: 0, paddingLength: 4, content: decoratedClaim, isEventCapture: 0,
  });
  const verdict = new TextContainerProperty({
    containerID: CONTAINER.verdict, containerName: NAME.verdict,
    xPosition: 16, yPosition: 96, width: SCREEN_W - 32, height: 32,
    borderWidth: 0, paddingLength: 4, content: middle, isEventCapture: 0,
  });
  const reason = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 132, width: SCREEN_W - 32, height: 124,
    borderWidth: 0, paddingLength: 4, content: page.text, isEventCapture: 1,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.activeList, containerName: NAME.activeList,
    xPosition: 16, yPosition: 260, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4, content: 'Tap: back · Swipe: scroll', isEventCapture: 0,
  });
  const textObject = [claim, verdict, reason, hint];
  return new RebuildPageContainer({ containerTotalNum: totalContainers([], textObject), listObject: [], textObject });
}

/** History-detail scroll layout — page 2+ of a claim's reason. Compact header
 * + tall reason area + bottom hint, with the reason container as the event
 * sink so swipes register. */
function buildHistoryDetailScrollPage(entry: HistoryEntry, page: PageRef): RebuildPageContainer {
  // Within-entry "1/N" claim position in the compact header (same as the
  // pre-session-scroll active page behavior). The cross-entry X/Y prefix only
  // lives on full-layout claim chunks.
  const count = claimCount(entry.result);
  const posTag = count > 1 ? `${page.claimIdx + 1}/${count}` : '';
  const headerContent = formatCompactHeader(entry.result, page.claimIdx, posTag);
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
  const textObject = [header, reason, hint];
  return new RebuildPageContainer({ containerTotalNum: totalContainers([], textObject), listObject: [], textObject });
}

/** Clear per-session HUD state so a fresh session doesn't inherit stale buffers. */
export function resetHudSessionState(): void {
  menuPersona = null;
  cachedHistoryEntries = [];
  detailPages = [];
  detailPageIndex = 0;
  detailIsFullLayout = true;
  historyDetailIndex = -1;
  sessionEntries = [];
  sessionPages = [];
  sessionPageIndex = 0;
  activeHidden = false;
  latestAnalysisRange = null;
  useWithinAnalysisIndicator = true;
  activeLayout = 'baseline';
  pendingActiveResult = null;
  pendingMenuSpinnerFrame = '';
  // Cancel any pending picker-hint flash so its 2.5s callback can't fire after
  // the session has been torn down and attempt to upgradeText on a stale page.
  if (pickerHintFlashTimer) {
    clearTimeout(pickerHintFlashTimer);
    pickerHintFlashTimer = null;
  }
}

export function _resetHudBootstrapForTesting(): void {
  bootstrapped = false;
  currentPage = 'none';
  resetHudSessionState();
}
