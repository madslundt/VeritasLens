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
import { getPersona, getPickerPersonas, gameDifficultyLabel, gameFormatLabel } from '@veritaslens/core';
import type { Persona, GamePreset, GameSession, HistoryEntry, LensResult, WebCitation } from '@veritaslens/core';
import { activePersona, settings } from '@/state/store';

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
  // menu hint footer — empty by default, flashed by flashMenuHint
  menuHint: 33,
  // game pages (40+)
  gameList: 40,
  gameTitle: 41,
  gameBody: 42,
  gameProgress: 43,
  gameHint: 44,
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
  menuHint: 'vl-menu-hint',
  gameList: 'vl-game-lst',
  gameTitle: 'vl-game-title',
  gameBody: 'vl-game-body',
  gameProgress: 'vl-game-prog',
  gameHint: 'vl-game-hint',
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

export type HudPage =
  | 'unconfigured'
  | 'picker'
  | 'active'
  | 'menu'
  | 'history-list'
  | 'history-detail'
  | 'mid-summary'
  | 'games-picker'
  | 'game-loading'
  | 'game-question'
  | 'game-feedback'
  | 'game-end'
  | 'game-save-prompt'
  | 'translation-picker'
  | 'translation-teleprompter'
  | 'translation-wearer-speak'
  | 'none';

/** Cached starter the wearer most recently picked on the translation-picker
 *  page. Read by buildTranslationTeleprompterPage so a Say-more retry can
 *  identify which starter to extend. Replaced atomically when a new picker
 *  selection happens. */
export type TranslationStarter = { source: string; translated: string };

export const ACTIVE_HINT_DEFAULT = 'Tap: menu · Double-tap: check';
export const ACTIVE_HINT_ANALYZING = 'Analyzing · Double-tap to cancel';
export const MENU_HINT_DEFAULT = '';

export const MENU_OPTIONS = [
  { id: 'back', label: '← Back' },
  { id: 'fact-check', label: 'Check' },
  { id: 'history', label: 'History' },
  { id: 'exit', label: 'Exit' },
] as const;
export type MenuOptionId = (typeof MENU_OPTIONS)[number]['id'];

// `disabled` is a code-side no-op guard — the SDK ListItemContainerProperty has no
// item-level disable; lifecycle's handleMenuGesture skips action via a break case.
export type MenuItem = { id: string; label: string; disabled?: boolean };

// Built at showMenuPage() time — concatenation of dynamic items (from lifecycle)
// and the static MENU_OPTIONS. Initialized to the static defaults so
// menuOptionAtIndex works even if called before a showMenuPage call (tests,
// first-run edge cases).
let builtMenuItems: MenuItem[] = MENU_OPTIONS.map((o) => ({ id: o.id, label: o.label }));

export const EXIT_LABEL_WITH_SUMMARY = 'Exit - generate summary';
export const EXIT_LABEL_WITHOUT_SUMMARY = 'Exit - no summary';
// Captured at showMenuPage() time; consumed by buildMenuPage() so the Exit row
// reflects whether leaveActiveSession will fire a final summary. When true the
// static `exit` row is expanded into two rows so the wearer can explicitly
// pick "with summary" vs "without summary"; when false a single plain `Exit`
// row is shown (no summary is possible to generate either way).
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
// Most recent Translate result for this session. Cached separately from
// `sessionEntries` so the menu's "Reply…" item can resolve a picker page
// without having to walk the entry list and find the latest translation —
// and so a Translate result that the wearer hasn't yet landed on the active
// page for (because they opened the menu mid-analysis) is still reachable.
// Cleared on session reset and whenever `setLensResult(null)` fires.
let lastTranslationResult: Extract<LensResult, { type: 'translation' }> | null = null;
// Index of the starter currently highlighted on the translation-picker page.
// Mirrored from `listEvent.currentSelectItemIndex` because index-less click
// sysEvents on this hardware don't re-emit the highlight position.
let lastTranslationStarterIndex = 0;
// The starter the wearer most recently picked on the picker page. Read by
// the teleprompter page builder and by Say-more so a retry expands the same
// chosen line, not a stale one.
let activeTranslationStarter: TranslationStarter | null = null;
// Last menu-spinner frame written by setMenuSpinner. Used to seed
// buildMenuPage so the spinner is visible immediately when the user opens the
// menu mid-analysis (rather than waiting up to one ticker interval).
let pendingMenuSpinnerFrame = '';
// Last status frame written by setStatus. Used to seed the vl-status container
// of any active-page layout that gets rebuilt during analysis (e.g. when the
// wearer scrolls to a previous answer mid-check), so the spinner stays visible
// instead of vanishing until the next ticker tick. Stored as the *canonical*
// content (empty when idle / displaying, '...' while thinking, spinner frame
// while a request is in flight) — the layout-local "show a recording dot when
// status is empty" rule is applied by `statusDisplayText()` so that '•' is
// never baked into the canonical frame.
let pendingStatusFrame = '';

// True while the corner status slot may double as a recording indicator —
// i.e. the mic is hot AND no answer is currently visible. Flipped to false
// the moment an answer is being rendered (so the wearer sees a clean answer
// view), and back to true when the answer is dismissed / hidden.
let recordingDotEligible = true;

// True while auto-mode VAD is actively watching the mic. Causes the resting
// recording indicator on baseline to read 'AUTO' instead of '•' so the wearer
// can tell a tap isn't required. Driven by the lifecycle so this module stays
// free of any settings-store coupling.
let autoModeIndicator = false;

/** Compute the text that should currently be in the corner status slot for
 *  the active layout. Combines the canonical status frame with the recording
 *  dot fallback used on the listening-state layouts. Discreet idle deliberately
 *  shows nothing in the slot — the LVGL label caret already marks the corner —
 *  so the discreet wearer sees only the blinking caret until the spinner kicks
 *  in during analysis. */
function statusDisplayText(): string {
  if (pendingStatusFrame !== '') return pendingStatusFrame;
  if (!recordingDotEligible) return '';
  if (activeLayout !== 'baseline') return '';
  // Auto-mode replaces the dot with a short label so the wearer can tell
  // at a glance that no tap is required. Confined to baseline because the
  // discreet layouts are intentionally chrome-free.
  return autoModeIndicator ? 'AUTO' : '•';
}

/** Toggle the resting "AUTO" indicator in the corner status slot. Called by
 *  the lifecycle when the VAD watcher starts/stops. Idempotent. */
export async function setAutoModeIndicator(on: boolean): Promise<void> {
  if (autoModeIndicator === on) return;
  autoModeIndicator = on;
  if (currentPage !== 'active') return;
  await upgradeText(CONTAINER.status, NAME.status, statusDisplayText());
}

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
export function menuOptionAtIndex(idx: number | undefined | null): string {
  const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
  return builtMenuItems[safe]?.id ?? 'back';
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

export async function showMenuPage(opts: { exitGeneratesSummary?: boolean; dynamicItems?: MenuItem[] } = {}): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showMenuPage().');
  exitGeneratesSummary = opts.exitGeneratesSummary === true;
  const staticItems = MENU_OPTIONS.flatMap((o): MenuItem[] => {
    if (o.id !== 'exit') return [{ id: o.id, label: o.label }];
    // When a summary CAN be generated, give the wearer an explicit choice:
    // the existing "Exit - generate summary" row PLUS a new "Exit - no summary"
    // row that tears the session down without running the stop-time summary
    // chain. When a summary CAN'T be generated (auto-summary disabled, or no
    // intermediate tick fired yet) a single plain "Exit" row is shown — there's
    // nothing to opt out of, so a second row would just be confusing.
    if (exitGeneratesSummary) {
      return [
        { id: 'exit', label: EXIT_LABEL_WITH_SUMMARY },
        { id: 'exit-no-summary', label: EXIT_LABEL_WITHOUT_SUMMARY },
      ];
    }
    return [{ id: o.id, label: o.label }];
  });
  // Dynamic items (mid-summary view/refresh/loading) sit between fact-check
  // and history so they read as session actions alongside their peers.
  const historyIdx = staticItems.findIndex((i) => i.id === 'history');
  const dyn = opts.dynamicItems ?? [];
  builtMenuItems = [
    ...staticItems.slice(0, historyIdx),
    ...dyn,
    ...staticItems.slice(historyIdx),
  ];
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
    autoLensLabel: entry.result.autoSelected === true ? entry.lensName : undefined,
    sessionTag,
    groundingMode: entry.groundingMode,
    webCitations: entry.webCitations,
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
    autoLensLabel: entry.result.autoSelected === true ? entry.lensName : undefined,
    sessionTag,
    groundingMode: entry.groundingMode,
    webCitations: entry.webCitations,
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
  // Record the canonical status content even when off the active page so the
  // next rebuild can seed the status container with the current spinner /
  // listening state. The recording-dot fallback is applied at write time by
  // statusDisplayText() so it never persists into pendingStatusFrame — a
  // subsequent layout switch (e.g. discreet-minimal → discreet-result) would
  // otherwise carry the dot into the answer view.
  pendingStatusFrame = content;
  if (currentPage !== 'active') return;
  await upgradeText(CONTAINER.status, NAME.status, statusDisplayText());
}

// ---------- Streaming heading ----------
//
// Throttled mid-stream write to the reason container. Used by lenses that
// declare `streamHeading` so the wearer sees the payload (Trivia's answer,
// Translate's translatedText, Companion's headline, ELI5's oneLine,
// Fact-check's correction, Meeting Prep's answer) fill in character-by-
// character before the final result lands. The G2's full page rebuild
// strobes if fired per chunk, so this writes to a single named container
// via `upgradeText` and throttles to STREAMING_THROTTLE_MS — visually
// indistinguishable from raw streaming but kind to the bridge bandwidth.

const STREAMING_THROTTLE_MS = 150;
let streamingPending: string | null = null;
let streamingLast = '';
let streamingTimer: ReturnType<typeof setTimeout> | null = null;
let streamingActive = false;

/**
 * Push a streaming partial onto the active page's reason container. Cleared
 * when the final result lands (the normal `setLensResult` path takes over).
 * Off-screen calls (currentPage !== 'active') queue the most recent value
 * but don't write — the lifecycle's `setLensResult` will commit the final
 * answer once the wearer returns.
 */
export function setLensStreamingHeading(text: string): void {
  if (currentPage !== 'active') return;
  streamingActive = true;
  streamingPending = text;
  if (streamingTimer) return;
  // First write fires immediately so the wearer sees something the moment
  // the stream starts; subsequent writes coalesce into a single trailing
  // flush after the throttle window. Skip the immediate write when the
  // value matches the last write — no point re-rendering the same string.
  // Keeps the perceived latency low without burning bridge writes on every
  // chunk.
  if (text !== streamingLast) {
    void flushStreamingHeading();
  } else {
    streamingPending = null;
  }
  streamingTimer = setTimeout(() => {
    streamingTimer = null;
    if (streamingPending !== null && streamingPending !== streamingLast) {
      void flushStreamingHeading();
    }
  }, STREAMING_THROTTLE_MS);
}

/** Internal: drain the pending streaming partial to the reason container. */
async function flushStreamingHeading(): Promise<void> {
  if (streamingPending === null) return;
  const next = streamingPending;
  streamingLast = next;
  streamingPending = null;
  if (currentPage !== 'active') return;
  await upgradeText(CONTAINER.reason, NAME.reason, next);
}

/**
 * Tear down any pending streaming heading writes. Called by the lifecycle as
 * soon as the final result is ready so a trailing throttled flush can't
 * land *after* `setLensResult`'s rebuild and undo it.
 */
export function clearLensStreamingHeading(): void {
  if (streamingTimer) {
    clearTimeout(streamingTimer);
    streamingTimer = null;
  }
  streamingPending = null;
  streamingLast = '';
  streamingActive = false;
}

/** Test helper — observable state of the streaming heading throttle. */
export function getLensStreamingState(): { active: boolean; last: string } {
  return { active: streamingActive, last: streamingLast };
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

/** result.type → persona id. Names are looked up from BUILTINS via
 *  `getPersona(id).name` at call time so renames in personas/index.ts can
 *  never drift from this table. The id mapping itself is unavoidable: some
 *  result types differ from their persona id (e.g. 'bias' ↔ 'bias-detector').
 *  TypeScript's Record exhaustiveness fails the build if a new LensResult
 *  variant is added without a row here. */
const PERSONA_ID_BY_RESULT_TYPE: Record<LensResult['type'], string> = {
  'fact-check': 'fact-checker',
  'trivia': 'trivia',
  'logical-fallacy': 'logical-fallacy',
  'bias': 'bias-detector',
  'eli5': 'eli5',
  'devils-advocate': 'devils-advocate',
  'key-questions': 'key-questions',
  'companion': 'companion',
  'meeting-prep': 'meeting-prep',
  'session-summary': 'session-summary',
  'game': 'game',
  'translation': 'translation',
};

function synthesizeEntryFromResult(result: LensResult, idx = 0): HistoryEntry {
  // When Auto picked this result, the synthetic entry needs a real lensName so
  // the Auto-chose prefix on the active / history-detail page survives the
  // synthetic round-trip (tests + menu-replay).
  const personaId = result.autoSelected ? PERSONA_ID_BY_RESULT_TYPE[result.type] : '';
  const lensName = personaId ? (getPersona(personaId)?.name ?? '') : '';
  return {
    id: `${SYNTHETIC_ENTRY_ID}-${idx}`,
    sessionId: '',
    timestamp: 0,
    lensId: personaId,
    lensName,
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
    case 'key-questions':
      return result.claims.length <= 1 ? [result]
        : result.claims.map((c) => ({ type: 'key-questions' as const, claims: [c], autoSelected: result.autoSelected }));
    case 'devils-advocate':
      return result.claims.length <= 1 ? [result]
        : result.claims.map((c) => ({ type: 'devils-advocate' as const, claims: [c], autoSelected: result.autoSelected }));
    case 'companion':
      return result.claims.length <= 1 ? [result]
        : result.claims.map((c) => ({ type: 'companion' as const, claims: [c], autoSelected: result.autoSelected }));
    case 'game':
      return [result];
    case 'translation':
      return [result];
  }
}

export async function setLensResult(result: LensResult | null, context?: SetLensResultContext): Promise<void> {
  // Cache the latest Translate result regardless of which page we're on so
  // the menu's "Reply…" item can resolve a picker even when the result
  // landed while the wearer was off the active page. NOT cleared on null —
  // null is a transient dismiss (Back from menu) and the wearer might still
  // want to reach the picker via menu without re-translating; the cache is
  // bound to the session via resetHudSessionState.
  if (result && result.type === 'translation') {
    lastTranslationResult = result;
  }
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
    // Re-enable the recording dot — the wearer is back to a listening view.
    // Only write the corner when an answer was previously suppressing the
    // dot, so an already-idle discreet-minimal stays a true no-op.
    const wasSuppressed = !recordingDotEligible;
    recordingDotEligible = true;
    if (currentPage !== 'active') return;
    if (activeLayout === 'discreet-minimal') {
      if (wasSuppressed) {
        await upgradeText(CONTAINER.status, NAME.status, statusDisplayText());
      }
      return;
    }
    if (isDiscreetLayout(activeLayout)) {
      setActiveLayout('discreet-minimal');
      const ok = await getBridge().rebuildPageContainer(buildActivePage());
      if (!ok) throw new Error('rebuildPageContainer (discreet-minimal) failed.');
      return;
    }
    await upgradeText(CONTAINER.reason, NAME.reason, '');
    if (wasSuppressed) {
      await upgradeText(CONTAINER.status, NAME.status, statusDisplayText());
    }
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

/**
 * Blank the active page result for the duration of a new analysis. The wearer's
 * intended UX is "spinner means working; swipe-up to recall the last answer
 * while you wait." This delegates to `hideActiveResultInPlace` so the existing
 * swipe-up reveal path (active-page scrollActiveReason with `activeHidden`)
 * surfaces the last sessionPage with no extra wiring.
 *
 * No-op when there's nothing to hide (first analysis of a session) — the page
 * stays on its idle layout. No-op when the wearer is off the active page
 * (menu/history/picker) since this is a HUD concern only; the lifecycle still
 * starts the spinner in those slots via `startSpinner` separately.
 *
 * A subsequent `setLensResult(result)` — final OR partial — clears
 * `activeHidden` and re-renders, so auto-return is free.
 */
export async function blankActiveForThinking(): Promise<void> {
  if (currentPage !== 'active') return;
  if (sessionPages.length === 0) return;
  if (activeHidden) return;
  await hideActiveResultInPlace();
}

/** Demote the active page to its idle layout (baseline / discreet-minimal)
 * while keeping `sessionPages` and `sessionPageIndex` intact, so a swipe-up
 * can reveal the last session page again. Shared by swipe-down dismiss and
 * tap-back from the menu. */
async function hideActiveResultInPlace(): Promise<void> {
  activeHidden = true;
  // Re-enable the recording dot — the wearer is back to a listening view.
  recordingDotEligible = true;
  const targetIdle: ActiveLayout = isDiscreetLayout(activeLayout) ? 'discreet-minimal' : 'baseline';
  if (activeLayout !== targetIdle) {
    setActiveLayout(targetIdle);
    const ok = await getBridge().rebuildPageContainer(buildActivePage());
    if (!ok) throw new Error('rebuildPageContainer (hide) failed.');
    return;
  }
  // Already on the idle layout (e.g., single-page baseline). Wipe the unified
  // body so the wearer sees a blank screen between answers and restore the
  // corner recording dot suppressed while the answer was visible.
  await upgradeText(CONTAINER.reason, NAME.reason, '');
  await upgradeText(CONTAINER.status, NAME.status, statusDisplayText());
}

/** Mark the active result as hidden without clearing it. Used by the menu's
 * Back option so the next swipe-up can re-reveal the last session page. */
export function markActiveHidden(): void {
  if (sessionPages.length > 0) activeHidden = true;
}

/** True iff the active result is preserved in memory but currently hidden. */
export function isActiveHidden(): boolean { return activeHidden; }

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

/**
 * Synchronously clear the canonical status / menu-spinner buffers. Used by
 * stopSpinner so the next page rebuild (e.g. setLensResult → renderActivePage)
 * cannot bake a stale spinner glyph into a freshly built status container
 * while the async setStatus('listening') / setMenuSpinner('') writes are
 * still in flight.
 */
export function clearStatusFrame(): void { pendingStatusFrame = ''; }
export function clearMenuSpinnerFrame(): void { pendingMenuSpinnerFrame = ''; }

/**
 * Seed the canonical status / menu-spinner buffers without an SDK round trip.
 * Used by the spinner ticker for the *non-visible* slot — the next rebuild of
 * that page will pick the seeded frame up, but we don't queue an extra device
 * write for a slot the wearer can't currently see. Skipping the round trip is
 * what keeps fire-and-forget spinner writes from out-living stopSpinner and
 * landing on top of the answer view.
 */
export function seedStatusFrame(content: string): void { pendingStatusFrame = content; }
export function seedMenuSpinnerFrame(content: string): void { pendingMenuSpinnerFrame = content; }

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

let activeHintFlashTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Briefly replace the active page's hint with a message, then restore
 * `ACTIVE_HINT_DEFAULT`. Used when an analysis is short-circuited (e.g. the
 * no-voice gate fires) so the wearer gets feedback without leaving the
 * listening state. No-op outside the active baseline layout.
 */
export async function flashActiveHint(message: string, ms = 2500): Promise<void> {
  if (currentPage !== 'active') return;
  if (activeLayout !== 'baseline') return;
  if (activeHintFlashTimer) clearTimeout(activeHintFlashTimer);
  await upgradeText(CONTAINER.activeHint, NAME.activeHint, message);
  activeHintFlashTimer = setTimeout(() => {
    activeHintFlashTimer = null;
    if (currentPage !== 'active') return;
    if (activeLayout !== 'baseline') return;
    void upgradeText(CONTAINER.activeHint, NAME.activeHint, ACTIVE_HINT_DEFAULT);
  }, ms);
}

let menuHintFlashTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Briefly show a message in the menu page's bottom hint slot, then revert to
 * `MENU_HINT_DEFAULT`. Used to explain why a disabled menu row (e.g. the
 * mid-summary row before the recording or analysis gate is met) didn't act.
 * No-op when the menu isn't on screen.
 */
export async function flashMenuHint(message: string, ms = 5000): Promise<void> {
  if (currentPage !== 'menu') return;
  if (menuHintFlashTimer) clearTimeout(menuHintFlashTimer);
  await upgradeText(CONTAINER.menuHint, NAME.menuHint, message);
  menuHintFlashTimer = setTimeout(() => {
    menuHintFlashTimer = null;
    if (currentPage !== 'menu') return;
    void upgradeText(CONTAINER.menuHint, NAME.menuHint, MENU_HINT_DEFAULT);
  }, ms);
}

export type SummaryBadgeState = 'idle' | 'generating' | 'ready';

let summaryBadgeReadyTimer: ReturnType<typeof setTimeout> | null = null;

function summaryBadgeBaseline(): string {
  return '';
}

/**
 * Drive the picker page's top-right summary badge through final-summary states.
 * No-op when the picker isn't on screen; safe to call from lifecycle hooks.
 *
 * - 'generating' → "Generating…"
 * - 'ready'      → "Summary ready!", auto-reverts to blank after 2.5 s
 * - 'idle'       → blank
 *
 * Badge container is 180 px wide; strings are sized to fit (≤14 chars).
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
    await upgradeText(CONTAINER.summaryBadge, NAME.summaryBadge, 'Generating…');
    return;
  }
  if (state === 'ready') {
    await upgradeText(CONTAINER.summaryBadge, NAME.summaryBadge, 'Summary ready!');
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
    case 'bias':
    case 'trivia':
    case 'eli5':
    case 'meeting-prep':
    case 'devils-advocate':
    case 'key-questions':
    case 'companion':
      return Math.max(1, result.claims.length);
    case 'game':
    case 'translation':
      return 1;
    default:
      return 1;
  }
}

/** Build the unified body string for a single claim's page-0 — combines the
 *  heading, verdict/source, and reason/detail into one text block with
 *  blank-line separators. Empty sections are elided. */
function formatUnifiedBody(
  result: LensResult,
  claimIdx: number,
  _autoSelected: boolean,
  groundingMode: 'grounded' | 'groundless' = 'grounded',
): string {
  const { top, middle, bottom } = formatLensResultBase(result, claimIdx, groundingMode);

  // Stitch non-empty sections together with a blank line between them so the
  // visual hierarchy (heading | verdict/source | body) remains legible without
  // separate positioned containers.
  const sections: string[] = [];
  if (top) sections.push(top);
  if (middle) sections.push(middle);
  if (bottom) sections.push(bottom);
  return sections.join('\n\n');
}

/** Base heading/verdict/reason triple for a result, *without* position tag or
 *  Auto prefix. The indicator/Auto are stamped in at unified-body composition
 *  time by `formatUnifiedBody` because the format depends on the cursor's
 *  session context (within-analysis "1/N" vs session-relative "X/Y"). */
/**
 * Exported for tests. Production code goes through `formatUnifiedBody` →
 * `formatEntryBody` → `computePagesForResult`; surface this so a unit test
 * can assert that the groundless `°` mark lands on the verdict slot for the
 * lens shapes that carry one (fact-check, bias).
 */
export function formatLensResultBase(
  result: LensResult,
  claimIdx: number,
  groundingMode: 'grounded' | 'groundless' = 'grounded',
): { top: string; middle: string; bottom: string } {
  // `°` after the verdict glyph signals the wearer that this answer came from
  // training data alone — provider couldn't supply web grounding. Only
  // attached to lens types whose verdict slot drives the wearer's confidence
  // decision (fact-check, bias). Other lenses already carry their own
  // groundedness signal in the badge column.
  const groundlessMark = groundingMode === 'groundless' ? '°' : '';
  switch (result.type) {
    case 'fact-check': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      const verdictLine = c.verdict === 'TRUE' ? '+ TRUE' : c.verdict === 'FALSE' ? '- FALSE' : '? UNVERIFIED';
      return {
        top: clip(c.claim, 140),
        middle: `${verdictLine}${groundlessMark}`,
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
    case 'bias': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      const verdictLine = c.verdict === 'NEUTRAL' ? '+ NEUTRAL' : '- BIASED';
      return {
        top: c.direction ? clip(c.direction, 140) : '',
        middle: `${verdictLine}${groundlessMark}`,
        bottom: c.reason,
      };
    }
    case 'eli5': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      // Newer responses populate `oneLine` (heading) + `expanded` (body); the
      // legacy single-blob `explanation` covers history rows from earlier
      // releases. The HUD prefers oneLine on top with expanded below; falls
      // back to whichever is present.
      const top = c.oneLine ?? '';
      const bottom = c.expanded ?? c.explanation ?? '';
      return { top, middle: '', bottom };
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
    case 'devils-advocate': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return { top: clip(c.counterpoint, 140), middle: '', bottom: c.rationale };
    }
    case 'key-questions': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return { top: clip(c.question, 140), middle: '', bottom: c.context };
    }
    case 'companion': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return {
        top: clip(c.headline, 140),
        middle: c.kind.toUpperCase(),
        bottom: c.detail,
      };
    }
    case 'game': {
      const topic = result.preset.topic || 'Random';
      const formatLabel = gameFormatLabel(result.preset.format);
      const scored = result.questions.some((q) => q.correctIndex !== null);
      // Count unanswered slots — a mid-game exit (cancelGame) persists
      // partial sessions, so the wearer needs to see at a glance how much
      // of the game they actually played vs. skipped.
      const unanswered = result.answers.reduce<number>(
        (acc, a) => (a === null ? acc + 1 : acc), 0,
      );
      const middle = scored ? `${result.score} / ${result.questions.length}` : '';
      const unanswerLine = unanswered > 0 ? `${unanswered} unanswered` : '';
      const summary = [
        `${formatLabel} · ${gameDifficultyLabel(result.preset.difficulty)}`,
        unanswerLine,
      ].filter(Boolean).join(' · ');
      return { top: clip(topic, 140), middle, bottom: summary };
    }
    case 'translation': {
      // The HUD shows the spoken transcript on top, the translation in the
      // middle, and 3 numbered reply starters at the bottom (each rendered
      // as two lines: translated reply first because that's the wearer's
      // primary reading language, then the source-language version
      // underneath so they know what to actually speak).
      const srcLang = (result.sourceLanguage || 'xx').toUpperCase().slice(0, 4);
      const top = result.sourceText ? clip(`${srcLang}  ${result.sourceText}`, 220) : '';
      const middle = clip(result.translatedText, 220);
      const starters = result.replyStarters
        .map((s, i) => `${i + 1}. ${s.translated}\n   ${s.source}`)
        .join('\n');
      return { top, middle, bottom: starters };
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
function formatEntryBody(
  result: LensResult,
  autoSelected: boolean,
  groundingMode: 'grounded' | 'groundless' = 'grounded',
): string {
  const total = claimCount(result);
  const parts: string[] = [];
  for (let i = 0; i < total; i++) {
    const body = formatUnifiedBody(result, i, autoSelected, groundingMode);
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

/** Sources sub-page text for a grounded history entry. Up to 5 domains
 *  joined with `·` so the line wraps naturally on the G2's 576px width.
 *  Plain text — the HUD has no link affordance, the wearer goes to a
 *  full URL on their phone via the recall context. */
const MAX_SOURCES_ON_HUD = 5;
function buildSourcesPageText(citations: ReadonlyArray<WebCitation>): string {
  const top = citations.slice(0, MAX_SOURCES_ON_HUD).map((c) => c.domain);
  if (top.length === 0) return '';
  return `Sources: ${top.join(' · ')}`;
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
  options: {
    autoSelected?: boolean;
    sessionTag?: string;
    autoLensLabel?: string;
    groundingMode?: 'grounded' | 'groundless';
    /** Structured citations from the grounded path. When present and
     *  non-empty, an extra "Sources: …" sub-page is appended after the body
     *  pages so the wearer can scroll one more notch to see the domains. */
    webCitations?: ReadonlyArray<WebCitation>;
  } = {},
): PageRef[] {
  const autoSelected = options.autoSelected ?? (result.autoSelected === true);
  const sessionTag = options.sessionTag ?? '';
  const autoPrefix =
    autoSelected && options.autoLensLabel ? options.autoLensLabel : '';
  const body = formatEntryBody(result, autoSelected, options.groundingMode);
  const sourcesText = options.webCitations && options.webCitations.length > 0
    ? buildSourcesPageText(options.webCitations)
    : '';
  const hasSourcesPage = sourcesText.length > 0;

  // Auto prefix and session tag share the first line, joined by ' · ' so the
  // shape is `Fact Check · 1/3 · <body>`. Either or both may be empty.
  const head = [autoPrefix, sessionTag].filter(Boolean).join(' · ');
  const applyPrefix = (chunk: string) => (head ? `${head} · ${chunk}` : chunk);

  // First pass with budget reduced by one line whenever any head prefix is
  // present (covers both the session tag and the auto prefix — they share the
  // same line, so they share the same one-line wrap reserve).
  const prefixOverhead = head ? 1 : 0;
  const firstBudget = Math.max(1, pageLines - prefixOverhead);
  const firstPass = paginateText(body, BODY_INNER_W, firstBudget, firstBudget);

  if (firstPass.length <= 1 && !hasSourcesPage) {
    const text = applyPrefix(firstPass[0] ?? '');
    return [{ claimIdx: 0, pageWithinClaim: 0, text }];
  }

  // Multi-page: also reserve 2 lines for the bottom bullet row + blank-line
  // separator, then re-paginate. The sources sub-page counts toward the bullet
  // total so the wearer sees "● ○ ○" with the last dot reserved for sources.
  const finalBudget = Math.max(1, pageLines - prefixOverhead - 2);
  const final = paginateText(body, BODY_INNER_W, finalBudget, finalBudget);
  const totalPages = final.length + (hasSourcesPage ? 1 : 0);
  const pages: PageRef[] = final.map((chunk, p) => ({
    claimIdx: 0,
    pageWithinClaim: p,
    text: `${applyPrefix(chunk)}\n\n${bulletRow(p, totalPages)}`,
  }));
  if (hasSourcesPage) {
    const sourcesIdx = totalPages - 1;
    pages.push({
      claimIdx: 0,
      pageWithinClaim: sourcesIdx,
      text: `${applyPrefix(sourcesText)}\n\n${bulletRow(sourcesIdx, totalPages)}`,
    });
  }
  return pages;
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
      autoLensLabel: entry.result.autoSelected === true ? entry.lensName : undefined,
      sessionTag,
      groundingMode: entry.groundingMode,
      webCitations: entry.webCitations,
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
  // Suppress the recording dot the moment an answer is about to land — the
  // dot is the "listening, nothing on screen" indicator. Set this BEFORE any
  // page rebuild so the rebuild seeds the corner with '' instead of '•'.
  const wasDotEligible = recordingDotEligible;
  recordingDotEligible = false;
  const layoutChanged = target !== activeLayout;
  if (layoutChanged) {
    setActiveLayout(target);
    const ok = await getBridge().rebuildPageContainer(buildActivePage());
    if (!ok) throw new Error('rebuildPageContainer (active) failed.');
  } else if (wasDotEligible && (activeLayout === 'baseline' || activeLayout === 'discreet-minimal')) {
    // First render of an answer with no layout change, on a layout where the
    // corner was showing the '•' listening dot. Push '' into the corner so
    // the dot gives way to a clean answer view. Subsequent scrolls within
    // the same answer already have wasDotEligible=false and skip this write.
    // Discreet-result has no '•' fallback so no clear write is needed.
    await upgradeText(CONTAINER.status, NAME.status, statusDisplayText());
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

// ------- mid-summary page helpers -----------------------------------------

type MidSummaryResult = Extract<LensResult, { type: 'session-summary' }>;

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
  const itemNames = buildPickerItemNames();
  const title = new TextContainerProperty({
    containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 8,
    width: 240, height: 36, borderWidth: 0, paddingLength: 4,
    content: 'Pick a lens', isEventCapture: 0,
  });
  const summaryBadge = new TextContainerProperty({
    containerID: CONTAINER.summaryBadge, containerName: NAME.summaryBadge,
    xPosition: SCREEN_W - 196, yPosition: 8, width: 180, height: 32,
    borderWidth: 0, paddingLength: 4,
    content: summaryBadgeBaseline(),
    isEventCapture: 0,
  });
  const list = new ListContainerProperty({
    containerID: CONTAINER.pickerList, containerName: NAME.pickerList, xPosition: 16, yPosition: 48,
    width: SCREEN_W - 32, height: 200, borderWidth: 0, paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: itemNames.length, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 1,
      itemName: itemNames,
    }),
    isEventCapture: 1,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.pickerHint, containerName: NAME.pickerHint, xPosition: 16, yPosition: 252,
    width: SCREEN_W - 32, height: 28, borderWidth: 0, paddingLength: 4,
    content: itemNames.length > 1 ? 'Swipe ⇅ · Tap: start · Double-tap: exit' : 'Tap: start · Double-tap: exit',
    isEventCapture: 0,
  });
  const Ctor = mode === 'create' ? CreateStartUpPageContainer : RebuildPageContainer;
  const listObject = [list];
  const textObject = [title, hint, summaryBadge];
  return new Ctor({ containerTotalNum: totalContainers(listObject, textObject), listObject, textObject });
}

/**
 * Build the picker item labels. Games is pinned at the BOTTOM so the wearer
 * lands on a lens (the common case) without scrolling, and Games is one
 * scroll-down away. The lifecycle's `pickerEntryAtIndex` keeps this offset
 * in sync — if you reorder here, update that too.
 */
// Chevron suffix telegraphs that tapping this row opens a sub-picker
// rather than starting a session — mirrors the platform UI convention
// for "this leads elsewhere".
const PICKER_GAMES_LABEL = 'Games ›';
function buildPickerItemNames(): string[] {
  return [...getPickerPersonas().map((p) => p.name), PICKER_GAMES_LABEL];
}

export type PickerEntry =
  | { kind: 'games' }
  | { kind: 'persona'; persona: Persona };

/**
 * Resolve a picker list index to the entry it represents. Indices `0..N-1`
 * map to the personas (N = `getPickerPersonas().length`); index N is the
 * Games sub-picker entry pinned at the bottom of the list. Out-of-range
 * indices fall back to the first persona — picker should never silently
 * no-op on a tap, and falling back to a lens (rather than Games) matches
 * the typical "I want to ask a question" intent.
 */
export function pickerEntryAtIndex(idx: number | undefined | null): PickerEntry {
  const personas = getPickerPersonas();
  const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
  if (safe >= personas.length) return { kind: 'games' };
  const p = personas[safe];
  return p ? { kind: 'persona', persona: p } : { kind: 'games' };
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
    width: SCREEN_W - 32, height: SCREEN_H - 48 - 32, borderWidth: 0, paddingLength: 0,
    itemContainer: new ListItemContainerProperty({
      itemCount: builtMenuItems.length, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 1,
      itemName: builtMenuItems.map((o) => o.label),
    }),
    isEventCapture: 1,
  });
  // Bottom hint footer for flashMenuHint (e.g. why a disabled row didn't act).
  // Empty by default; menuList height is reduced above to leave room.
  const hint = new TextContainerProperty({
    containerID: CONTAINER.menuHint, containerName: NAME.menuHint,
    xPosition: 16, yPosition: SCREEN_H - 28, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4,
    content: MENU_HINT_DEFAULT, isEventCapture: 0,
  });
  const listObject = [list];
  const textObject = [title, spinner, clock, hint];
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
    // Position + dimensions match `makeDiscreetStatus` exactly so the icon
    // sits in the same screen coordinates across layouts — the wearer's
    // mental model of "what does that glyph mean" stays anchored to one
    // visual location. 55-px width comfortably fits the longest content
    // the slot ever shows (spinner with `R1/3` retry prefix = 5 chars).
    // Doubles as the recording dot when listening — statusDisplayText() falls
    // back to '•' when the canonical status is empty and an answer isn't on
    // screen, so baseline and discreet share one visual recording indicator.
    containerID: CONTAINER.status, containerName: NAME.status,
    xPosition: SCREEN_W - 59, yPosition: 4, width: 55, height: 32,
    borderWidth: 0, paddingLength: 4, content: statusDisplayText(), isEventCapture: 0,
  });
  // Body: y=4, h=252 → bottom 256, abuts the hint chrome row. Fits 9 lines
  // (9 × 27 + 8 = 251 ≤ 252). One container holds the entire heading +
  // verdict + reason, paginated upstream into per-page chunks.
  const body = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 4, width: SCREEN_W - 32, height: BASELINE_PAGE_LINES * LINE_PX + 8,
    borderWidth: 0, paddingLength: 4, content: '', isEventCapture: 1,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.activeHint, containerName: NAME.activeHint,
    xPosition: 16, yPosition: 260, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4, content: ACTIVE_HINT_DEFAULT, isEventCapture: 0,
  });
  const textObject = [status, body, hint];
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
    xPosition: SCREEN_W - 59, yPosition: 4, width: 55, height: 32,
    borderWidth: 0, paddingLength: 4,
    content: statusDisplayText(),
    isEventCapture: 0,
  });
}

/** Small status slot for layouts that otherwise have no chrome (discreet-result,
 *  scroll layouts). Empty when no analysis is running, spinner content during
 *  one — lets the wearer see "still working" while reviewing previous answers. */
function makeCornerStatus(): TextContainerProperty {
  return new TextContainerProperty({
    containerID: CONTAINER.status, containerName: NAME.status,
    xPosition: SCREEN_W - 59, yPosition: 4, width: 55, height: 32,
    borderWidth: 0, paddingLength: 4,
    content: statusDisplayText(),
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

function buildMidSummaryContentBody(result: MidSummaryResult, loading: boolean): string {
  const parts: string[] = [];
  if (loading) parts.push('Refreshing…');
  if (result.title.trim()) parts.push(result.title.trim());
  if (result.summary.trim()) parts.push(result.summary.trim());
  const kp = result.keyPoints.map((k) => k.trim()).filter(Boolean);
  if (kp.length > 0) parts.push(kp.join('\n'));
  return parts.join('\n\n');
}

function buildMidSummaryPage(pageText: string): RebuildPageContainer {
  const body = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 16, yPosition: 4, width: SCREEN_W - 32, height: HISTORY_DETAIL_PAGE_LINES * LINE_PX + 8,
    borderWidth: 0, paddingLength: 4, content: pageText, isEventCapture: 1,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.activeList, containerName: NAME.activeList,
    xPosition: 16, yPosition: 260, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4, content: 'Tap: menu · Double-tap: analyze', isEventCapture: 0,
  });
  const textObject = [body, hint];
  return new RebuildPageContainer({ containerTotalNum: totalContainers([], textObject), listObject: [], textObject });
}

// SDK content caps from https://hub.evenrealities.com/docs/guides/display.
const MID_SUMMARY_REBUILD_CAP = 1000;
const MID_SUMMARY_UPGRADE_CAP = 2000;

function capContent(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Mid-summary HUD page. The body container has `isEventCapture: 1` so the
 * firmware handles internal vertical scrolling when the content overflows —
 * we just hand it the full body string. No app-side line slicing.
 */
export async function showMidSummaryPage(
  loading: boolean,
  result: MidSummaryResult | null,
): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showMidSummaryPage().');

  const body = result
    ? buildMidSummaryContentBody(result, loading)
    : (loading ? 'Generating summary...' : 'Nothing to summarize yet');

  // Refresh in place when already on the page so the firmware scroll position
  // is preserved across content updates (e.g. spinner → final summary).
  if (currentPage === 'mid-summary') {
    await upgradeText(CONTAINER.reason, NAME.reason, capContent(body, MID_SUMMARY_UPGRADE_CAP));
    return;
  }

  const ok = await getBridge().rebuildPageContainer(
    buildMidSummaryPage(capContent(body, MID_SUMMARY_REBUILD_CAP)),
  );
  if (!ok) throw new Error('rebuildPageContainer (mid-summary) failed.');
  currentPage = 'mid-summary';
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

// ---------- Game pages ----------

/** Sentinel value indicating the games-picker `← Back` row. */
const GAMES_PICKER_BACK_KIND = 'back' as const;
/** Sentinel value indicating the runtime-only Random preset row. */
const GAMES_PICKER_RANDOM_KIND = 'random' as const;
export type GamesPickerEntry =
  | { kind: typeof GAMES_PICKER_BACK_KIND }
  | { kind: typeof GAMES_PICKER_RANDOM_KIND }
  | { kind: 'preset'; preset: GamePreset };

let cachedGamesEntries: GamesPickerEntry[] = [];

export function gamesPickerEntryAtIndex(idx: number | undefined | null): GamesPickerEntry | null {
  const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
  return cachedGamesEntries[safe] ?? null;
}

export interface ShowGamesPickerOpts {
  /** Optional flash to surface a failure from the previous attempt. */
  errorMessage?: string;
}

export async function showGamesPickerPage(
  presets: GamePreset[],
  opts: ShowGamesPickerOpts = {},
): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showGamesPickerPage().');
  cachedGamesEntries = [
    { kind: GAMES_PICKER_BACK_KIND },
    { kind: GAMES_PICKER_RANDOM_KIND },
    ...presets.map((p) => ({ kind: 'preset' as const, preset: p })),
  ];
  const ok = await getBridge().rebuildPageContainer(buildGamesPickerPage(presets, opts));
  if (!ok) throw new Error('rebuildPageContainer (games-picker) failed.');
  currentPage = 'games-picker';
}

function buildGamesPickerPage(presets: GamePreset[], opts: ShowGamesPickerOpts): RebuildPageContainer {
  const itemNames = [
    '← Back',
    'Random — surprise me',
    ...presets.map((p) => clip(`${p.topic} · ${gameFormatLabel(p.format)}`, 60)),
  ];
  const title = new TextContainerProperty({
    containerID: CONTAINER.gameTitle, containerName: NAME.gameTitle,
    xPosition: 16, yPosition: 8, width: SCREEN_W - 32, height: 36,
    borderWidth: 0, paddingLength: 4, content: 'Games', isEventCapture: 0,
  });
  const list = new ListContainerProperty({
    containerID: CONTAINER.gameList, containerName: NAME.gameList,
    xPosition: 16, yPosition: 48, width: SCREEN_W - 32, height: 200,
    borderWidth: 0, paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: itemNames.length, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 1,
      itemName: itemNames,
    }),
    isEventCapture: 1,
  });
  const hintText = opts.errorMessage && opts.errorMessage.length > 0
    ? opts.errorMessage
    : (presets.length > 0
        ? 'Tap a preset or Random · ← Back to lenses'
        : 'Add presets in phone settings · ← Back to lenses');
  const hint = new TextContainerProperty({
    containerID: CONTAINER.gameHint, containerName: NAME.gameHint,
    xPosition: 16, yPosition: 252, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4, content: hintText, isEventCapture: 0,
  });
  const listObject = [list];
  const textObject = [title, hint];
  return new RebuildPageContainer({
    containerTotalNum: totalContainers(listObject, textObject),
    listObject,
    textObject,
  });
}

export async function showGameLoadingPage(preset: GamePreset, retryLabel: string): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showGameLoadingPage().');
  const ok = await getBridge().rebuildPageContainer(buildGameLoadingPage(preset, retryLabel));
  if (!ok) throw new Error('rebuildPageContainer (game-loading) failed.');
  currentPage = 'game-loading';
}

function buildGameLoadingPage(preset: GamePreset, retryLabel: string): RebuildPageContainer {
  const headline = retryLabel ? `Loading ${retryLabel}…` : 'Loading…';
  const topic = preset.topic ? preset.topic : '…picking a topic';
  const sub = clip(`${gameFormatLabel(preset.format)} · ${topic} · ${gameDifficultyLabel(preset.difficulty)}`, 200);
  const title = new TextContainerProperty({
    containerID: CONTAINER.gameTitle, containerName: NAME.gameTitle,
    xPosition: 16, yPosition: 72, width: SCREEN_W - 32, height: 36,
    borderWidth: 0, paddingLength: 4, content: headline, isEventCapture: 0,
  });
  const body = new TextContainerProperty({
    containerID: CONTAINER.gameBody, containerName: NAME.gameBody,
    xPosition: 16, yPosition: 120, width: SCREEN_W - 32, height: 80,
    borderWidth: 0, paddingLength: 4, content: sub, isEventCapture: 0,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.gameHint, containerName: NAME.gameHint,
    xPosition: 16, yPosition: 252, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4, content: 'Double-tap to cancel', isEventCapture: 0,
  });
  // Invisible event capturer — a single-item list ensures double-tap reliably
  // reaches the lifecycle event router on this hardware.
  const sink = new ListContainerProperty({
    containerID: CONTAINER.gameList, containerName: NAME.gameList,
    xPosition: 0, yPosition: SCREEN_H - 1, width: SCREEN_W, height: 1,
    borderWidth: 0, paddingLength: 0,
    itemContainer: new ListItemContainerProperty({
      itemCount: 1, itemWidth: SCREEN_W, isItemSelectBorderEn: 0, itemName: [' '],
    }),
    isEventCapture: 1,
  });
  return new RebuildPageContainer({
    containerTotalNum: totalContainers([sink], [title, body, hint]),
    listObject: [sink],
    textObject: [title, body, hint],
  });
}

/** Renders the ASCII progress bar shown in the footer of question/feedback pages. */
function formatGameProgress(index: number, total: number): string {
  const cells = 10;
  const filled = total > 0 ? Math.min(cells, Math.max(0, Math.round(((index + 1) / total) * cells))) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(cells - filled)}  ${index + 1}/${total}`;
}

export async function showGameQuestionPage(session: GameSession): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showGameQuestionPage().');
  const ok = await getBridge().rebuildPageContainer(buildGameQuestionPage(session));
  if (!ok) throw new Error('rebuildPageContainer (game-question) failed.');
  currentPage = 'game-question';
}

function buildGameQuestionPage(session: GameSession): RebuildPageContainer {
  const q = session.questions[session.index];
  const questionText = clip(`Q${session.index + 1}. ${q?.text ?? ''}`, 240);
  // Question text occupies the top half; options in the middle as a list;
  // progress bar pinned to the bottom.
  // Title height trimmed from 80→60 px and the list pulled up to y=68 so
  // the 4-option quiz layout fits all four rows with ~44 px per item —
  // previously the 4th option clipped against the progress bar at y=252.
  const title = new TextContainerProperty({
    containerID: CONTAINER.gameTitle, containerName: NAME.gameTitle,
    xPosition: 16, yPosition: 4, width: SCREEN_W - 32, height: 60,
    borderWidth: 0, paddingLength: 4, content: questionText, isEventCapture: 0,
  });
  const isRiddle = !q || q.options.length === 0;
  const optionNames = isRiddle
    ? ['› Tap to reveal']
    : (q!.options.map((o) => clip(o, 60)));
  const list = new ListContainerProperty({
    containerID: CONTAINER.gameList, containerName: NAME.gameList,
    xPosition: 16, yPosition: 68, width: SCREEN_W - 32, height: 176,
    borderWidth: 0, paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: optionNames.length, itemWidth: SCREEN_W - 48,
      isItemSelectBorderEn: isRiddle ? 0 : 1, itemName: optionNames,
    }),
    isEventCapture: 1,
  });
  const progress = new TextContainerProperty({
    containerID: CONTAINER.gameProgress, containerName: NAME.gameProgress,
    xPosition: 16, yPosition: 252, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4,
    content: formatGameProgress(session.index, session.questions.length),
    isEventCapture: 0,
  });
  return new RebuildPageContainer({
    containerTotalNum: totalContainers([list], [title, progress]),
    listObject: [list],
    textObject: [title, progress],
  });
}

export async function showGameFeedbackPage(session: GameSession): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showGameFeedbackPage().');
  const ok = await getBridge().rebuildPageContainer(buildGameFeedbackPage(session));
  if (!ok) throw new Error('rebuildPageContainer (game-feedback) failed.');
  currentPage = 'game-feedback';
}

function buildGameFeedbackPage(session: GameSession): RebuildPageContainer {
  const q = session.questions[session.index];
  const selected = session.answers[session.index];
  let headline = '';
  let detail = '';
  if (!q) {
    headline = '—';
  } else if (q.correctIndex === null) {
    // Riddle — no scoring; reveal directly.
    headline = 'Answer';
    detail = q.reveal;
  } else if (selected === q.correctIndex) {
    headline = '✓ Correct';
    detail = q.reveal;
  } else {
    const correctText = q.options[q.correctIndex] ?? '';
    headline = '✗ Wrong';
    detail = `Answer: ${correctText}\n${q.reveal}`;
  }
  const title = new TextContainerProperty({
    containerID: CONTAINER.gameTitle, containerName: NAME.gameTitle,
    xPosition: 16, yPosition: 8, width: SCREEN_W - 32, height: 40,
    borderWidth: 0, paddingLength: 4, content: clip(headline, 80), isEventCapture: 0,
  });
  const body = new TextContainerProperty({
    containerID: CONTAINER.gameBody, containerName: NAME.gameBody,
    xPosition: 16, yPosition: 52, width: SCREEN_W - 32, height: 192,
    borderWidth: 0, paddingLength: 4, content: clip(detail, 480), isEventCapture: 0,
  });
  const progress = new TextContainerProperty({
    containerID: CONTAINER.gameProgress, containerName: NAME.gameProgress,
    xPosition: 16, yPosition: 252, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4,
    content: formatGameProgress(session.index, session.questions.length),
    isEventCapture: 0,
  });
  // Single-item sink list so click/double-click reach the lifecycle event router.
  const sink = new ListContainerProperty({
    containerID: CONTAINER.gameList, containerName: NAME.gameList,
    xPosition: 0, yPosition: SCREEN_H - 1, width: SCREEN_W, height: 1,
    borderWidth: 0, paddingLength: 0,
    itemContainer: new ListItemContainerProperty({
      itemCount: 1, itemWidth: SCREEN_W, isItemSelectBorderEn: 0, itemName: [' '],
    }),
    isEventCapture: 1,
  });
  return new RebuildPageContainer({
    containerTotalNum: totalContainers([sink], [title, body, progress]),
    listObject: [sink],
    textObject: [title, body, progress],
  });
}

export async function showGameEndPage(session: GameSession): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showGameEndPage().');
  const ok = await getBridge().rebuildPageContainer(buildGameEndPage(session));
  if (!ok) throw new Error('rebuildPageContainer (game-end) failed.');
  currentPage = 'game-end';
}

// ---------- Random-game save prompt ----------

/** Sentinel kinds for the save-prompt list. Back is always index 0. */
const SAVE_PROMPT_BACK_KIND = 'back' as const;
const SAVE_PROMPT_SAVE_KIND = 'save' as const;
export type GameSavePromptEntry =
  | { kind: typeof SAVE_PROMPT_BACK_KIND }
  | { kind: typeof SAVE_PROMPT_SAVE_KIND };

let cachedSavePromptEntries: GameSavePromptEntry[] = [];

export function gameSavePromptEntryAtIndex(
  idx: number | undefined | null,
): GameSavePromptEntry | null {
  const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
  return cachedSavePromptEntries[safe] ?? null;
}

export async function showGameSavePromptPage(session: GameSession): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showGameSavePromptPage().');
  cachedSavePromptEntries = [
    { kind: SAVE_PROMPT_BACK_KIND },
    { kind: SAVE_PROMPT_SAVE_KIND },
  ];
  const ok = await getBridge().rebuildPageContainer(buildGameSavePromptPage(session));
  if (!ok) throw new Error('rebuildPageContainer (game-save-prompt) failed.');
  currentPage = 'game-save-prompt';
}

function buildGameSavePromptPage(session: GameSession): RebuildPageContainer {
  const topic = (session.preset.topic || 'Random').trim();
  const fmt = gameFormatLabel(session.preset.format);
  const headlineText = `Topic: ${topic}`;
  const subText = `${fmt} · ${gameDifficultyLabel(session.preset.difficulty)}`;
  const title = new TextContainerProperty({
    containerID: CONTAINER.gameTitle, containerName: NAME.gameTitle,
    xPosition: 16, yPosition: 8, width: SCREEN_W - 32, height: 56,
    borderWidth: 0, paddingLength: 4, content: clip(headlineText, 80), isEventCapture: 0,
  });
  const sub = new TextContainerProperty({
    containerID: CONTAINER.gameBody, containerName: NAME.gameBody,
    xPosition: 16, yPosition: 68, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4, content: clip(subText, 100), isEventCapture: 0,
  });
  // Back is the first option so an accidental tap lands on the safe choice
  // rather than persisting a preset the wearer didn't intend.
  const itemNames = ['← Back', 'Save as game'];
  const list = new ListContainerProperty({
    containerID: CONTAINER.gameList, containerName: NAME.gameList,
    xPosition: 16, yPosition: 104, width: SCREEN_W - 32, height: 116,
    borderWidth: 0, paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: itemNames.length, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 1,
      itemName: itemNames,
    }),
    isEventCapture: 1,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.gameHint, containerName: NAME.gameHint,
    xPosition: 16, yPosition: 252, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4,
    content: 'Save the random topic as a reusable preset?', isEventCapture: 0,
  });
  return new RebuildPageContainer({
    containerTotalNum: totalContainers([list], [title, sub, hint]),
    listObject: [list],
    textObject: [title, sub, hint],
  });
}

function buildGameEndPage(session: GameSession): RebuildPageContainer {
  const scored = session.questions.some((q) => q.correctIndex !== null);
  let score = 0;
  for (let i = 0; i < session.questions.length; i++) {
    const q = session.questions[i]!;
    if (q.correctIndex === null) continue;
    if (session.answers[i] === q.correctIndex) score += 1;
  }
  const headline = scored ? `${score} / ${session.questions.length}` : 'Done';
  const topic = session.preset.topic || 'Random topic';
  const sub = `${topic} · ${gameFormatLabel(session.preset.format)} · ${gameDifficultyLabel(session.preset.difficulty)}`;
  const title = new TextContainerProperty({
    containerID: CONTAINER.gameTitle, containerName: NAME.gameTitle,
    xPosition: 16, yPosition: 72, width: SCREEN_W - 32, height: 56,
    borderWidth: 0, paddingLength: 4, content: headline, isEventCapture: 0,
  });
  const body = new TextContainerProperty({
    containerID: CONTAINER.gameBody, containerName: NAME.gameBody,
    xPosition: 16, yPosition: 140, width: SCREEN_W - 32, height: 80,
    borderWidth: 0, paddingLength: 4, content: clip(sub, 200), isEventCapture: 0,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.gameHint, containerName: NAME.gameHint,
    xPosition: 16, yPosition: 252, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4, content: 'Tap to return to games', isEventCapture: 0,
  });
  const sink = new ListContainerProperty({
    containerID: CONTAINER.gameList, containerName: NAME.gameList,
    xPosition: 0, yPosition: SCREEN_H - 1, width: SCREEN_W, height: 1,
    borderWidth: 0, paddingLength: 0,
    itemContainer: new ListItemContainerProperty({
      itemCount: 1, itemWidth: SCREEN_W, isItemSelectBorderEn: 0, itemName: [' '],
    }),
    isEventCapture: 1,
  });
  return new RebuildPageContainer({
    containerTotalNum: totalContainers([sink], [title, body, hint]),
    listObject: [sink],
    textObject: [title, body, hint],
  });
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
  lastTranslationResult = null;
  lastTranslationStarterIndex = 0;
  activeTranslationStarter = null;
  wearerSpeakState = 'recording';
  pendingMenuSpinnerFrame = '';
  pendingStatusFrame = '';
  recordingDotEligible = true;
  // Cancel any pending hint / badge flashes so their 2.5s callbacks can't
  // fire after the session has been torn down and attempt to upgradeText on
  // a stale page. The flash callbacks short-circuit on `currentPage` /
  // `activeLayout` mismatches, but during the brief window before the next
  // page is pushed those guards can race with a torn-down page id.
  if (pickerHintFlashTimer) {
    clearTimeout(pickerHintFlashTimer);
    pickerHintFlashTimer = null;
  }
  if (activeHintFlashTimer) {
    clearTimeout(activeHintFlashTimer);
    activeHintFlashTimer = null;
  }
  if (summaryBadgeReadyTimer) {
    clearTimeout(summaryBadgeReadyTimer);
    summaryBadgeReadyTimer = null;
  }
  builtMenuItems = MENU_OPTIONS.map((o) => ({ id: o.id, label: o.label }));
  cachedGamesEntries = [];
}

// ============================================================================
// Translate lens sub-pages
//
// Reply… (from the menu) opens `translation-picker`: a ListContainer with one
// row per reply starter (translated text on each row, so the wearer reads in
// THEIR language to pick). Click on a row pushes `translation-teleprompter`:
// the chosen starter rendered large for reading aloud, with the translation
// underneath. Say more → (from the teleprompter's menu) issues a second LLM
// call that extends the starter into 1-3 sentences; `updateTranslationTeleprompterExtended`
// pushes the new text via upgradeText so the wearer doesn't see a page rebuild
// flash.
// ============================================================================

/** True when there's a cached translation result the menu can offer Reply… for. */
export function hasCachedTranslationResult(): boolean {
  return lastTranslationResult !== null;
}

/** Read-only accessor for the most recent translation result. Lifecycle uses
 *  this to build the picker page on demand. */
export function getLastTranslationResult():
  | Extract<LensResult, { type: 'translation' }>
  | null {
  return lastTranslationResult;
}

/** True when the wearer has chosen a starter and is on (or returning to) the
 *  teleprompter page — drives whether the menu offers Say more →. */
export function hasActiveTranslationStarter(): boolean {
  return activeTranslationStarter !== null;
}

/** Current highlighted index in the translation-picker list. Lifecycle reads
 *  it on click so the SDK's index-less click sysEvent (the double-tap quirk
 *  CLAUDE.md describes) still resolves to the right starter. */
export function getLastTranslationStarterIndex(): number {
  return lastTranslationStarterIndex;
}

/** Lifecycle calls this from the picker's list event so the JS-side mirror
 *  stays in sync with the SDK's highlight. */
export function setLastTranslationStarterIndex(idx: number): void {
  lastTranslationStarterIndex = Math.max(0, idx);
}

function buildTranslationPickerPage(
  result: Extract<LensResult, { type: 'translation' }>,
): RebuildPageContainer {
  // Each row is the TRANSLATED line — the wearer reads in their display
  // language to decide what to say. Pre-clipped to a single visible line per
  // row; the source-language version waits on the teleprompter page.
  const itemNames = result.replyStarters.map((s, i) => {
    const text = s.translated || s.source || '(empty)';
    return `${i + 1}. ${clip(text, 56)}`;
  });
  const title = new TextContainerProperty({
    containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 8,
    width: SCREEN_W - 32, height: 36, borderWidth: 0, paddingLength: 4,
    content: 'Pick a reply', isEventCapture: 0,
  });
  const list = new ListContainerProperty({
    containerID: CONTAINER.pickerList, containerName: NAME.pickerList, xPosition: 16, yPosition: 48,
    width: SCREEN_W - 32, height: 200, borderWidth: 0, paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: itemNames.length, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 1,
      itemName: itemNames,
    }),
    isEventCapture: 1,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.pickerHint, containerName: NAME.pickerHint, xPosition: 16, yPosition: 252,
    width: SCREEN_W - 32, height: 28, borderWidth: 0, paddingLength: 4,
    content: 'Swipe ⇅ · Tap: pick · Double-tap: cancel',
    isEventCapture: 0,
  });
  const listObject = [list];
  const textObject = [title, hint];
  return new RebuildPageContainer({
    containerTotalNum: totalContainers(listObject, textObject),
    listObject,
    textObject,
  });
}

export async function showTranslationPickerPage(
  result: Extract<LensResult, { type: 'translation' }>,
): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showTranslationPickerPage().');
  // Cache the source result so the click handler can resolve a starter — the
  // lifecycle path passes the result through too, but a re-render path (e.g.
  // a future "back to picker" gesture) needs the cache.
  lastTranslationResult = result;
  // Clamp the carried index so a stale value from a prior translation (with
  // a different starter count, e.g. listen-in mode → 0) can't read off the
  // end of the new list.
  if (lastTranslationStarterIndex >= result.replyStarters.length) {
    lastTranslationStarterIndex = 0;
  }
  // Leaving the active page suppresses the recording dot the next active-page
  // rebuild would otherwise re-introduce. Same pattern as showMenuPage.
  recordingDotEligible = true;
  const ok = await getBridge().rebuildPageContainer(buildTranslationPickerPage(result));
  if (!ok) throw new Error('rebuildPageContainer (translation-picker) failed.');
  currentPage = 'translation-picker';
}

function buildTranslationTeleprompterPage(
  starter: TranslationStarter,
  extended: { source: string; translated: string } | null,
): RebuildPageContainer {
  // Source on top in a tall body (what the wearer will read aloud); the
  // wearer-language translation sits at the bottom as a smaller reference.
  // Source font is the same as everywhere else on this hardware — there's no
  // size knob exposed by the SDK; we get "larger" via more vertical space
  // and the natural readability of foreground vs subordinate text.
  const sourceText = extended?.source || starter.source || '(empty)';
  const translatedText = extended?.translated || starter.translated || '';
  const body = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason, xPosition: 16, yPosition: 4,
    width: SCREEN_W - 32, height: 180, borderWidth: 0, paddingLength: 4,
    content: sourceText, isEventCapture: 1,
  });
  const translation = new TextContainerProperty({
    containerID: CONTAINER.activeList, containerName: NAME.activeList, xPosition: 16, yPosition: 188,
    width: SCREEN_W - 32, height: 68, borderWidth: 0, paddingLength: 4,
    content: translatedText, isEventCapture: 0,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.activeHint, containerName: NAME.activeHint, xPosition: 16, yPosition: 260,
    width: SCREEN_W - 32, height: 28, borderWidth: 0, paddingLength: 4,
    content: 'Tap: menu · Double-tap: re-analyze',
    isEventCapture: 0,
  });
  const listObject: ListContainerProperty[] = [];
  const textObject = [body, translation, hint];
  return new RebuildPageContainer({
    containerTotalNum: totalContainers(listObject, textObject),
    listObject,
    textObject,
  });
}

export async function showTranslationTeleprompterPage(
  starter: TranslationStarter,
): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showTranslationTeleprompterPage().');
  activeTranslationStarter = starter;
  recordingDotEligible = true;
  const ok = await getBridge().rebuildPageContainer(buildTranslationTeleprompterPage(starter, null));
  if (!ok) throw new Error('rebuildPageContainer (translation-teleprompter) failed.');
  currentPage = 'translation-teleprompter';
}

/** Push extended Say-more text onto the teleprompter in place — no full
 *  rebuild, so the wearer doesn't see a flash. */
export async function updateTranslationTeleprompterExtended(
  extendedSource: string,
  extendedTranslated: string,
): Promise<void> {
  if (currentPage !== 'translation-teleprompter') return;
  if (!activeTranslationStarter) return;
  await upgradeText(CONTAINER.reason, NAME.reason, extendedSource);
  await upgradeText(CONTAINER.activeList, NAME.activeList, extendedTranslated);
}

/** Read the currently-active starter (the one the wearer picked + landed on
 *  the teleprompter for). Lifecycle reads this to build the Say-more prompt. */
export function getActiveTranslationStarter(): TranslationStarter | null {
  return activeTranslationStarter;
}

// ============================================================================
// Wearer-speak (two-way) sub-page
//
// The wearer-speak page has two render states, both share the same page id
// (`'translation-wearer-speak'`) so dispatching stays simple. While
// recording, the page shows "Speak now…" with a recording dot and a hint
// telling the wearer how to send manually. After the lifecycle's Gemini
// call returns, `updateTranslationWearerSpeakResult` swaps the body in
// place via upgradeText so there's no flicker.
// ============================================================================

function buildTranslationWearerSpeakPage(
  state: 'recording' | 'result',
  result: { spoken: string; translated: string } | null,
): RebuildPageContainer {
  // Recording state: prominent "Speak now…" prompt; foreign-language line
  // (the translation) lands here once the call returns.
  const bodyText = state === 'recording'
    ? 'Speak now…'
    : (result?.translated || '(no speech detected)');
  // Result state: the wearer's own utterance shows below as confirmation
  // ("did I hear you right?"); empty during recording.
  const echoText = state === 'recording'
    ? ''
    : (result?.spoken || '');
  const body = new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason, xPosition: 16, yPosition: 4,
    width: SCREEN_W - 32, height: 180, borderWidth: 0, paddingLength: 4,
    content: bodyText, isEventCapture: 1,
  });
  const echo = new TextContainerProperty({
    containerID: CONTAINER.activeList, containerName: NAME.activeList, xPosition: 16, yPosition: 188,
    width: SCREEN_W - 32, height: 68, borderWidth: 0, paddingLength: 4,
    content: echoText, isEventCapture: 0,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.activeHint, containerName: NAME.activeHint, xPosition: 16, yPosition: 260,
    width: SCREEN_W - 32, height: 28, borderWidth: 0, paddingLength: 4,
    content: state === 'recording'
      ? 'Double-tap: send · Tap: cancel'
      : 'Tap: menu · Double-tap: speak again',
    isEventCapture: 0,
  });
  const listObject: ListContainerProperty[] = [];
  const textObject = [body, echo, hint];
  return new RebuildPageContainer({
    containerTotalNum: totalContainers(listObject, textObject),
    listObject,
    textObject,
  });
}

let wearerSpeakState: 'recording' | 'result' = 'recording';

/** Render state of the wearer-speak page. Lifecycle reads this to decide
 *  whether a single-click should open the menu (result) or cancel (recording),
 *  and whether a double-tap should send-now (recording) or re-record (result). */
export function getWearerSpeakState(): 'recording' | 'result' {
  return wearerSpeakState;
}

export async function showTranslationWearerSpeakPage(): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showTranslationWearerSpeakPage().');
  wearerSpeakState = 'recording';
  recordingDotEligible = true;
  const ok = await getBridge().rebuildPageContainer(buildTranslationWearerSpeakPage('recording', null));
  if (!ok) throw new Error('rebuildPageContainer (translation-wearer-speak) failed.');
  currentPage = 'translation-wearer-speak';
}

/** Swap the wearer-speak page from recording state to result state via
 *  in-place upgradeText calls. */
export async function updateTranslationWearerSpeakResult(
  spoken: string,
  translated: string,
): Promise<void> {
  if (currentPage !== 'translation-wearer-speak') return;
  wearerSpeakState = 'result';
  await upgradeText(CONTAINER.reason, NAME.reason, translated || '(no speech detected)');
  await upgradeText(CONTAINER.activeList, NAME.activeList, spoken || '');
  await upgradeText(CONTAINER.activeHint, NAME.activeHint, 'Tap: menu · Double-tap: speak again');
}

export function _resetHudBootstrapForTesting(): void {
  bootstrapped = false;
  currentPage = 'none';
  resetHudSessionState();
}
