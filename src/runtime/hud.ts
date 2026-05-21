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
import { getPersona, getPickerPersonas, type Persona } from '@/personas';
import { activePersona, settings } from '@/state/store';
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
  // Clear the status slot once an answer is on screen so the corner spinner
  // disappears — the answer itself is the "done!" signal on every layout.
  displaying: '',
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

// Line-aware pagination constants. The body container is the only scrollable
// region. Inner width = container width 544 minus 2*padding (4) = 536px.
// Line height is sourced from pretext (a single-line measurement) so a font
// bump in @evenrealities/pretext doesn't silently break pagination.
const LINE_PX = measureTextWrap('X', 1000).height;
const BODY_INNER_W = SCREEN_W - 32 - 2 * 4; // 536
// Per-mode line budget for one body page. Each layout has a single unified
// text container that spans from y=4 to the bottom limit allowed by the
// chrome row (REC/hint at y=256 on baseline, hint at y=260 on history detail,
// nothing on discreet). Body container height = lines × LINE_PX + 2×padding.
//   discreet result: y=4, h=280 → 10 × 27 + 8 = 278 px ≤ 280; bottom y=284
//   baseline:        y=4, h=252 → 9 × 27 + 8  = 251 px ≤ 252; bottom y=256
//   history detail:  y=4, h=256 → 9 × 27 + 8  = 251 px ≤ 256; bottom y=260
const DISCREET_PAGE_LINES = 10;
const BASELINE_PAGE_LINES = 9;
const HISTORY_DETAIL_PAGE_LINES = 9;

/**
 * One screen-worth of result content. Multi-claim results and long body text
 * expand into a flat list of these — swipe-down increments the index, swipe-up
 * decrements. The unified body (heading + verdict + reason with blank-line
 * separators) is paginated into one or more pages per claim; `text` carries
 * the chunk for this page. `pageWithinClaim === 0` is the first page of a
 * claim (includes the heading + position tag); higher values are continuation
 * chunks of the same claim's body.
 */
type PageRef = {
  claimIdx: number;
  pageWithinClaim: number;
  text: string;
};

/** A page in the session-wide flat list spanning every entry in the current
 * session. Adds `entryIdx` (index into `sessionEntries`) on top of `PageRef`. */
type SessionPageRef = PageRef & { entryIdx: number };

// Session-wide flat scroll model. The cursor walks across every entry in the
// current session (split per claim by the lifecycle), so a swipe-up at the
// first claim of the latest analysis hops to the previous question rather
// than no-op'ing. The indicator is uniformly session-relative ("X/Y" across
// every claim in the session) so the wearer always knows where they are.
let sessionEntries: HistoryEntry[] = [];
let sessionPages: SessionPageRef[] = [];
let sessionPageIndex = 0;
// True when the active result has been hidden via tap-back from the menu or
// swipe-down past the session end. The session-pages list + index are
// preserved so the next scroll-up can reveal the last session page; the
// visible layout is demoted to baseline / discreet-minimal in the meantime.
let activeHidden = false;
/** First/last entry index of the most recent analysis. Used to jump the
 *  cursor to the new first claim when a result lands. */
let latestAnalysisRange: { firstEntry: number; lastEntry: number } | null = null;
let detailPages: PageRef[] = [];
let detailPageIndex = 0;
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
// Last status frame written by setStatus. Used to seed the vl-status container
// of any active-page layout that gets rebuilt during analysis (e.g. when the
// wearer scrolls to a previous answer mid-check), so the spinner stays visible
// instead of vanishing until the next ticker tick.
let pendingStatusFrame = '';

let bootstrapped = false;
let currentPage: HudPage = 'none';
let menuPersona: Persona | null = null;
let cachedHistoryEntries: HistoryEntry[] = [];
/**
 * Sub-mode for the active page. Driven by the lifecycle, read by buildActivePage.
 *   - 'baseline'         : full-screen unified body container + REC/hint chrome
 *   - 'discreet-minimal' : single recording dot only (no body container)
 *   - 'discreet-result'  : full-screen unified body container, no bottom chrome
 *
 * Page 0 vs continuation pages now share the same container layout (one body
 * box that fills the screen); they differ only in the body text composed for
 * the page. So no separate 'baseline-scroll' / 'discreet-scroll' modes.
 */
export type ActiveLayout =
  | 'baseline'
  | 'discreet-minimal'
  | 'discreet-result';
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
  // history-detail uses its own per-page line budget (9 lines, capped by the
  // bottom hint row at y=260). Session-relative X/Y reflects the cached
  // history list (which the user can walk via edge swipes); bullets show
  // within-entry page position when this entry spans multiple pages. The
  // X/Y tag is shown even when there's only one cached entry ("1/1") so the
  // wearer never wonders whether the indicator is missing.
  const cachedTotal = cachedHistoryEntries.length;
  const sessionTag = cachedTotal > 0 && historyDetailIndex >= 0
    ? `${historyDetailIndex + 1}/${cachedTotal}`
    : '';
  detailPages = computePagesForResult(entry.result, HISTORY_DETAIL_PAGE_LINES, {
    autoSelected: entry.result.autoSelected === true,
    sessionTag,
  });
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
  const cachedTotal = cachedHistoryEntries.length;
  const sessionTag = cachedTotal > 0
    ? `${historyDetailIndex + 1}/${cachedTotal}`
    : '';
  detailPages = computePagesForResult(entry.result, HISTORY_DETAIL_PAGE_LINES, {
    autoSelected: entry.result.autoSelected === true,
    sessionTag,
  });
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
  const content = STATUS_LABEL[label] ?? label;
  // On discreet-minimal the status slot doubles as the recording dot — when
  // status clears (e.g. 'listening'), restore '•' so the user always sees a
  // recording indicator. Other layouts (baseline, discreet-result, scroll)
  // keep the slot empty when content is empty so the wearer doesn't see
  // chrome on the "pure answer" views unless an analysis is actually running.
  const text = activeLayout === 'discreet-minimal' && content === '' ? '•' : content;
  // Record the frame even when off the active page so the next rebuild can
  // seed the status container with the current spinner state.
  pendingStatusFrame = text;
  if (currentPage !== 'active') return;
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

function synthesizeEntryFromResult(result: LensResult, idx = 0): HistoryEntry {
  return {
    id: `${SYNTHETIC_ENTRY_ID}-${idx}`,
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

/** Mirrors `splitResultByClaim` from the lifecycle, inlined here to avoid a
 *  circular import. Used only by the direct-call `setLensResult` path (tests,
 *  menu replay) so the synthetic session has the same per-entry shape lifecycle
 *  produces — keeping the X/Y indicator consistent across both code paths. */
function splitForSynthesis(result: LensResult): LensResult[] {
  switch (result.type) {
    case 'fact-check':
      return result.claims.length <= 1 ? [result]
        : result.claims.map((c) => ({ type: 'fact-check', claims: [c], autoSelected: result.autoSelected }));
    case 'stats-check':
      return result.claims.length <= 1 ? [result]
        : result.claims.map((c) => ({ type: 'stats-check', claims: [c], autoSelected: result.autoSelected }));
    case 'logical-fallacy':
      return result.claims.length <= 1 ? [result]
        : result.claims.map((c) => ({ type: 'logical-fallacy', claims: [c], autoSelected: result.autoSelected }));
    case 'bias':
      return result.claims.length <= 1 ? [result]
        : result.claims.map((c) => ({ type: 'bias', claims: [c], autoSelected: result.autoSelected }));
    case 'trivia':
      return result.claims.length <= 1 ? [result]
        : result.claims.map((c) => ({ type: 'trivia', claims: [c], autoSelected: result.autoSelected }));
    case 'eli5':
      return result.claims.length <= 1 ? [result]
        : result.claims.map((c) => ({ type: 'eli5', claims: [c], autoSelected: result.autoSelected }));
    case 'session-summary':
    case 'meeting-prep':
      return [result];
  }
}

export async function setLensResult(result: LensResult | null, context?: SetLensResultContext): Promise<void> {
  if (currentPage !== 'active' && currentPage !== 'history-detail') {
    // User is off the active page (typically on the menu after opening it
    // mid-analysis). Stash the answer so the next showActivePage replays it.
    if (result) pendingActiveResult = result;
    return;
  }

  // Null result paths — clear or demote, matching prior behaviour. Discreet
  // demotes to the dot-only idle layout; baseline just clears the unified body.
  if (!result) {
    sessionEntries = [];
    sessionPages = [];
    sessionPageIndex = 0;
    activeHidden = false;
    latestAnalysisRange = null;
    if (currentPage !== 'active') return;
    if (activeLayout === 'discreet-minimal') return; // already idle
    if (isDiscreetLayout(activeLayout)) {
      setActiveLayout('discreet-minimal');
      const ok = await getBridge().rebuildPageContainer(buildActivePage());
      if (!ok) throw new Error('rebuildPageContainer (discreet-minimal) failed.');
      return;
    }
    await upgradeText(CONTAINER.reason, NAME.reason, '');
    return;
  }

  if (context) {
    // Lifecycle path — full session view with cross-analysis scroll. Every
    // new analysis jumps the cursor to its first claim and clears the hidden
    // flag so the wearer always sees the question they just asked, regardless
    // of what historical entry they were last viewing or whether they had
    // previously hidden the prior answer.
    sessionEntries = context.sessionEntries;
    recomputeSessionPages();
    latestAnalysisRange = computeRangeFromIds(sessionEntries, context.newEntryIds);
    if (latestAnalysisRange) {
      sessionPageIndex = firstPageIndexForEntry(latestAnalysisRange.firstEntry);
    } else if (sessionPageIndex >= sessionPages.length) {
      // Defensive: no new ids matched any entry — clamp the cursor.
      sessionPageIndex = Math.max(0, sessionPages.length - 1);
    }
    activeHidden = false;
  } else {
    // Direct-call path (tests, menu replay): split the result the same way
    // lifecycle does (per-claim for fact-check / stats-check / etc., one-entry
    // for Meeting Prep / Session Summary) so the synthetic session has the
    // same entry shape and the X/Y indicator behaves identically.
    const splits = splitForSynthesis(result);
    sessionEntries = splits.map((r, i) => synthesizeEntryFromResult(r, i));
    recomputeSessionPages();
    latestAnalysisRange = { firstEntry: 0, lastEntry: sessionEntries.length - 1 };
    sessionPageIndex = 0;
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

  if (dir === 1) {
    // Swipe-down walks page-by-page: continuation pages of the same claim, then
    // the next claim within the entry (for multi-claim entries like Meeting
    // Prep), then the first page of the next entry.
    sessionPageIndex += 1;
    await renderActivePage();
    return 'scrolled';
  }

  // Swipe-up — symmetric counterpart to swipe-down. Walks back exactly one
  // sessionPage so `n` swipes-down can be reversed by `n` swipes-up. The
  // per-answer X/Y prefix + bullet row composed by recomputeSessionPages give
  // the wearer enough context to know when a swipe crosses a question
  // boundary (indicator visibly resets), so we don't need the old
  // "skip-to-previous-entry's-first-page" optimization here.
  if (sessionPageIndex > 0) {
    sessionPageIndex -= 1;
    await renderActivePage();
    return 'scrolled';
  }
  return 'noop';
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
  // Already on the idle layout (e.g., single-page baseline). Wipe the unified
  // body so the wearer sees a blank screen between answers.
  await upgradeText(CONTAINER.reason, NAME.reason, '');
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
 * - 'generating' → "summarizing..."
 * - 'ready'      → "summary ready", auto-reverts to baseline after 2.5 s
 * - 'idle'       → baseline ("auto-summary" if enabled, blank otherwise)
 *
 * Strings are sized to match "auto-summary" (12 chars) — the badge container
 * is 180 px wide and longer text clips on hardware.
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
    await upgradeText(CONTAINER.summaryBadge, NAME.summaryBadge, 'summarizing...');
    return;
  }
  if (state === 'ready') {
    await upgradeText(CONTAINER.summaryBadge, NAME.summaryBadge, 'summary ready');
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

/** Build the unified body string for a single claim's page-0 — combines the
 *  heading, verdict/source, and reason/detail into one text block with
 *  blank-line separators. Empty sections are elided. The position tag (X/Y)
 *  and optional Auto badge prefix the heading line so the wearer always sees
 *  where they are in a multi-claim or auto-classifier flow. */
function formatUnifiedBody(
  result: LensResult,
  claimIdx: number,
  autoSelected: boolean,
): string {
  const { top, middle, bottom } = formatLensResultBase(result, claimIdx);
  // Compose the optional Auto badge prefix for the first line.
  const firstLine = autoSelected && top
    ? `Auto · ${top}`
    : (autoSelected ? 'Auto' : top);

  // Stitch non-empty sections together with a blank line between them so the
  // visual hierarchy (heading | verdict/source | body) remains legible without
  // separate positioned containers.
  const sections: string[] = [];
  if (firstLine) sections.push(firstLine);
  if (middle) sections.push(middle);
  if (bottom) sections.push(bottom);
  return sections.join('\n\n');
}

/** Base heading/verdict/reason triple for a result, *without* position tag or
 *  Auto prefix. The indicator/Auto are stamped in at unified-body composition
 *  time by `formatUnifiedBody` because the format depends on the cursor's
 *  session context (within-analysis "1/N" vs session-relative "X/Y"). */
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
      // Each claim kind gets its own visual treatment so the user can tell
      // answer / supporting evidence / follow-up apart while swiping.
      switch (c.kind) {
        case 'answer':
          // Source attribution lives at the BOTTOM (after the detail) so the
          // wearer reads answer → detail → "From: …" top-to-bottom without the
          // source line interrupting the answer→detail flow.
          return {
            top: clip(c.text, 140),
            middle: c.detail,
            bottom: c.source ? `From: ${c.source}` : '',
          };
        case 'evidence':
          return {
            top: clip(`"${c.text}"`, 140),
            middle: c.source ? `From: ${c.source}` : '',
            bottom: '',
          };
        case 'followup':
          return { top: clip(`→ ${c.text}`, 140), middle: '', bottom: '' };
      }
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
 * Build a flat page list spanning every claim and every continuation chunk.
 * One unified body string is composed per claim (heading + verdict + reason
 * joined with blank lines) and then paginated against a single per-page line
 * budget. Page 0 of each claim carries the heading + position tag; subsequent
 * pageWithinClaim values are pure body continuations (same claim, more text).
 *
 * When the entry expands to more than one page total AND no session-relative
 * posTag is already present on the heading (i.e., this entry is the only one
 * in its session, like a single Meeting Prep question with multiple claims),
 * each page gets an inline "X/Y · " prefix on its first line so the wearer
 * knows where they are. Pagination is rerun with the budget reduced by one
 * line in that case so the prefix can't push the visible body past the
 * container's clip if it forces the first line to wrap.
 *
 * For multi-entry sessions, `formatUnifiedBody` already prepends the
 * session-relative posTag — we skip the within-entry prefix there to avoid
 * stacking two indicators on one line.
 */
/**
 * Compose the unified body for an entire entry by flattening every claim's
 * unified body into one string with a single blank-line separator between
 * claims. This lets short claims (e.g., Meeting Prep's answer + evidence +
 * followup) share a single page when they fit, instead of each forcing its
 * own page break. The blank-line separator is the same width as the
 * separator between sections within a claim — meeting-prep distinguishes
 * claims by their kind-specific prefix (plain answer, quoted evidence,
 * arrow-prefixed followup) rather than by extra vertical whitespace, so we
 * don't pay for double-blank-line claim breaks.
 */
function formatEntryBody(result: LensResult, autoSelected: boolean): string {
  const total = claimCount(result);
  const parts: string[] = [];
  for (let i = 0; i < total; i++) {
    const body = formatUnifiedBody(result, i, autoSelected);
    if (body) parts.push(body);
  }
  return parts.join('\n\n');
}

/**
 * Bottom bullet row showing within-entry page position — `● ○ ○` for page 1
 * of 3, `○ ● ○` for page 2, `○ ○ ●` for page 3. Left-aligned (text-container
 * rendering on this hardware doesn't expose alignment, and a fixed-space
 * leading pad can't be reliably centered across font widths — so we keep it
 * unambiguously left-aligned). Only called when total > 1.
 */
function bulletRow(currentIdx: number, total: number): string {
  const dots: string[] = [];
  for (let i = 0; i < total; i++) dots.push(i === currentIdx ? '●' : '○');
  return dots.join(' ');
}

/**
 * Build the paginated page list for one entry, with all indicator chrome
 * applied:
 *   - Session-relative `"X/N · "` prefix on the first line of every page
 *     (when the caller passes a non-empty `sessionTag`). Stays the same
 *     across every page of this entry so the wearer always knows which
 *     question they're on; only changes when crossing into a different
 *     entry (via the natural page sequence in `sessionPages`).
 *   - Bottom bullet row showing within-entry page position, only when the
 *     entry expands to more than one page.
 *
 * Pagination is two-pass: first to detect multi-page, then with the budget
 * reduced by the appropriate number of lines to make room for the prefix's
 * potential wrap (1 line) + bullet row (2 lines = blank separator + the row
 * itself).
 */
function computePagesForResult(
  result: LensResult,
  pageLines: number,
  options: { autoSelected?: boolean; sessionTag?: string } = {},
): PageRef[] {
  const autoSelected = options.autoSelected ?? (result.autoSelected === true);
  const sessionTag = options.sessionTag ?? '';
  const body = formatEntryBody(result, autoSelected);

  const applyPrefix = (chunk: string) =>
    sessionTag ? `${sessionTag} · ${chunk}` : chunk;

  // First pass with budget reduced only by the prefix overhead (if any).
  const prefixOverhead = sessionTag ? 1 : 0;
  const firstBudget = Math.max(1, pageLines - prefixOverhead);
  const firstPass = paginateText(body, BODY_INNER_W, firstBudget, firstBudget);

  if (firstPass.length <= 1) {
    const text = applyPrefix(firstPass[0] ?? '');
    return [{ claimIdx: 0, pageWithinClaim: 0, text }];
  }

  // Multi-page: also reserve 2 lines for the bottom bullet row + blank-line
  // separator, then re-paginate.
  const finalBudget = Math.max(1, pageLines - prefixOverhead - 2);
  const final = paginateText(body, BODY_INNER_W, finalBudget, finalBudget);
  const totalPages = final.length;
  return final.map((chunk, p) => ({
    claimIdx: 0,
    pageWithinClaim: p,
    text: `${applyPrefix(chunk)}\n\n${bulletRow(p, totalPages)}`,
  }));
}

function isDiscreetLayout(layout: ActiveLayout): boolean {
  return layout === 'discreet-minimal' || layout === 'discreet-result';
}

function pageLinesForActiveLayout(): number {
  return isDiscreetLayout(activeLayout) ? DISCREET_PAGE_LINES : BASELINE_PAGE_LINES;
}

function targetLayoutForActivePage(): ActiveLayout {
  return isDiscreetLayout(activeLayout) ? 'discreet-result' : 'baseline';
}

/** The entry the active-page cursor is currently pointing at. */
function currentActiveEntry(): HistoryEntry | null {
  const p = sessionPages[sessionPageIndex];
  return p ? sessionEntries[p.entryIdx] ?? null : null;
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

/** Rebuild `sessionPages` by paginating every entry's result into unified-body
 *  pages. Session-relative X/Y ("X/N · ") sits on the first line of every
 *  page so the wearer always knows which question they're on; the indicator
 *  stays constant while scrolling within an entry and only changes when the
 *  page sequence crosses into the next entry. Bullets at the bottom show
 *  within-entry page position, only when the entry spans multiple pages. */
function recomputeSessionPages(): void {
  const pageLines = pageLinesForActiveLayout();
  const totalEntries = sessionEntries.length;
  const out: SessionPageRef[] = [];
  for (let i = 0; i < totalEntries; i++) {
    const entry = sessionEntries[i]!;
    // Always show the session-relative tag — even for a 1-entry session
    // ("1/1") so the wearer never wonders whether the indicator is missing.
    const sessionTag = totalEntries > 0 ? `${i + 1}/${totalEntries}` : '';
    const pages = computePagesForResult(entry.result, pageLines, {
      autoSelected: entry.result.autoSelected === true,
      sessionTag,
    });
    for (const p of pages) {
      out.push({ entryIdx: i, claimIdx: p.claimIdx, pageWithinClaim: p.pageWithinClaim, text: p.text });
    }
  }
  sessionPages = out;
}

/** Render the active page from the session cursor. With the unified-body
 *  layout, every page is the same single container — pagination already baked
 *  the heading + verdict + body into `page.text`, so we just push it. A layout
 *  rebuild is only needed when the mode itself changes (baseline ↔ discreet),
 *  not on every page swipe. */
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
  const target = targetLayoutForActivePage();
  const layoutChanged = target !== activeLayout;
  if (layoutChanged) {
    setActiveLayout(target);
    const ok = await getBridge().rebuildPageContainer(buildActivePage());
    if (!ok) throw new Error('rebuildPageContainer (active) failed.');
  }
  await upgradeText(CONTAINER.reason, NAME.reason, page.text);
}

/** Render `detailPages[detailPageIndex]` on the history-detail page. With the
 *  unified-body layout there is only one container layout — no page-0 vs
 *  scroll-page split — so a swipe just upgrades the body text. */
async function renderHistoryDetailPage(): Promise<void> {
  if (currentPage !== 'history-detail') return;
  const page = detailPages[detailPageIndex];
  const entry = cachedHistoryEntries[historyDetailIndex];
  if (!page || !entry) return;
  await upgradeText(CONTAINER.reason, NAME.reason, page.text);
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
  // Title shows the active lens name so the wearer knows which lens this
  // menu belongs to. Clock sized tight around "HH:MM" so LVGL's end-of-label
  // caret sits outside the container clip.
  const titleText = getPersona(activePersona())?.name ?? 'Menu';
  const title = new TextContainerProperty({
    containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 8,
    width: SCREEN_W - 112, height: 32, borderWidth: 0, paddingLength: 0,
    content: titleText, isEventCapture: 0,
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
    case 'baseline':
    default:
      return buildBaselineActivePage();
  }
}

/**
 * Baseline unified layout — a single full-screen body container (heading +
 * verdict + reason composed with blank-line separators) plus the existing
 * top status slot and bottom REC/hint chrome row. Body abuts the chrome at
 * y=256 without overlapping.
 *
 * The body itself is the event capturer (isEventCapture=1). It covers nearly
 * the whole screen, so an underlying full-screen sink would be blocked by
 * it on this hardware. Matches the history-detail page, which also lets the
 * body be the capturer.
 */
function buildBaselineActivePage(): RebuildPageContainer {
  const status = new TextContainerProperty({
    containerID: CONTAINER.status, containerName: NAME.status,
    xPosition: SCREEN_W - 112, yPosition: 4, width: 96, height: 26,
    borderWidth: 0, paddingLength: 4, content: pendingStatusFrame, isEventCapture: 0,
  });
  // Body: y=4, h=252 → bottom 256, abuts REC/hint chrome row. Fits 9 lines
  // (9 × 27 + 8 = 251 ≤ 252). One container holds the entire heading +
  // verdict + reason, paginated upstream into per-page chunks.
  const body = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 4, width: SCREEN_W - 32, height: BASELINE_PAGE_LINES * LINE_PX + 8,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 1,
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
  const textObject = [status, body, rec, hint];
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
 * Discreet result layout — full-screen unified body container with the small
 * top-right status corner overlay. Body starts at y=4 and extends nearly to
 * the screen bottom (h=278 → bottom y=282), holding 10 lines of paginated
 * heading + verdict + reason. The status corner sits at top-right (y=4, x=517+);
 * during result display the status slot is empty (STATUS_LABEL.displaying = ''),
 * so the body's top-right corner is unobstructed.
 *
 * The body itself is the event capturer (isEventCapture=1). It nearly covers
 * the screen, so a separate underlying sink would be blocked by it on this
 * hardware. Matches history-detail, which uses the same pattern.
 */
function buildDiscreetResultPage(): RebuildPageContainer {
  const status = makeCornerStatus();
  const body = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 4, width: SCREEN_W - 32, height: DISCREET_PAGE_LINES * LINE_PX + 8,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 1,
  });
  const textObject = [status, body];
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
    borderWidth: 0, paddingLength: 4,
    content: pendingStatusFrame || '•',
    isEventCapture: 0,
  });
}

/** Small status slot for layouts that otherwise have no chrome (discreet-result,
 *  scroll layouts). Empty when no analysis is running, spinner content during
 *  one — lets the wearer see "still working" while reviewing previous answers. */
function makeCornerStatus(): TextContainerProperty {
  return new TextContainerProperty({
    containerID: CONTAINER.status, containerName: NAME.status,
    xPosition: SCREEN_W - 59, yPosition: 4, width: 55, height: 26,
    borderWidth: 0, paddingLength: 4,
    content: pendingStatusFrame,
    isEventCapture: 0,
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

/**
 * History-detail unified layout — a single body container with the bottom
 * hint row at y=260. Body holds 9 lines of paginated heading + verdict +
 * reason. The body is the event sink (isEventCapture=1) so swipes (scroll
 * pages) and taps (back to history list) fire reliably on this hardware.
 */
function buildHistoryDetailPage(_entry: HistoryEntry, page: PageRef): RebuildPageContainer {
  const body = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 4, width: SCREEN_W - 32, height: HISTORY_DETAIL_PAGE_LINES * LINE_PX + 8,
    borderWidth: 0, paddingLength: 4, content: page.text, isEventCapture: 1,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.activeList, containerName: NAME.activeList,
    xPosition: 16, yPosition: 260, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4, content: 'Tap: back · Swipe: scroll', isEventCapture: 0,
  });
  const textObject = [body, hint];
  return new RebuildPageContainer({ containerTotalNum: totalContainers([], textObject), listObject: [], textObject });
}

/** Clear per-session HUD state so a fresh session doesn't inherit stale buffers. */
export function resetHudSessionState(): void {
  menuPersona = null;
  cachedHistoryEntries = [];
  detailPages = [];
  detailPageIndex = 0;
  historyDetailIndex = -1;
  sessionEntries = [];
  sessionPages = [];
  sessionPageIndex = 0;
  activeHidden = false;
  latestAnalysisRange = null;
  activeLayout = 'baseline';
  pendingActiveResult = null;
  pendingMenuSpinnerFrame = '';
  pendingStatusFrame = '';
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
