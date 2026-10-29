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
import { getTextWidth, measureTextWrap, pxTruncate } from '@evenrealities/pretext';
import { getBridge } from './bridge';
import { CONVERSATION_PROFILES, formatConversationRecord, getPersona, getPickerPersonas, getSpecializedPersonas, gameDifficultyLabel, gameFormatLabel } from '@veritaslens/core';
import type { Persona, GamePreset, GameSession, HistoryEntry, LensResult } from '@veritaslens/core';
import { activePersona, pushDebugEvent, recordingPaused, settings } from '@/state/store';

/**
 * HUD layout for VeritasLens.
 *
 * Display: 576 × 288 px per eye, 4-bit greyscale (single channel, green).
 * Coordinates: origin top-left, x rightwards, y downwards.
 *
 * Active and answer pages use one full-screen text event capturer: swipes
 * arrive as textEvent, taps as sysEvent. Pickers use native list selection.
 *
 * Pages:
 *   - "unconfigured"    : single visible message asking the user to configure on phone
 *   - "picker"          : list of registered personas; scroll moves SDK selection,
 *                         tap starts the highlighted one
 *   - "active"          : dim corner indicator while listening; full-screen
 *                         answers (single = menu, double = check, swipe = browse)
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
  profile: 37,
  // compact header (used on scroll layouts: page 2+ of a claim)
  compactHeader: 29,
  answerPosition: 34,
  answerLanguage: 35,
  answerPageIndicator: 36,
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
  profile: 'vl-profile',
  compactHeader: 'vl-compact',
  answerPosition: 'vl-position',
  answerLanguage: 'vl-language',
  answerPageIndicator: 'vl-page-pos',
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
  | 'specialized-picker'
  | 'games-picker'
  | 'game-loading'
  | 'game-question'
  | 'game-feedback'
  | 'game-end'
  | 'game-save-prompt'
  | 'translation-picker'
  | 'translation-teleprompter'
  | 'translation-wearer-speak'
  | 'conversation-options'
  | 'captions'
  | 'none';

/** Cached starter the wearer most recently picked on the translation-picker
 *  page. Read by buildTranslationTeleprompterPage so a Say-more retry can
 *  identify which starter to extend. Replaced atomically when a new picker
 *  selection happens. */
export type TranslationStarter = { source: string; translated: string; sourceRomanized?: string };

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

// All answer views use the full canvas without a content inset.
// Derive pagination from the actual inner dimensions and firmware font.
const LINE_PX = measureTextWrap('X', 1000).height;
const BODY_PADDING = 0;
const BODY_INNER_W = SCREEN_W - 2 * BODY_PADDING;
const ANSWER_PAGE_LINES = Math.floor((SCREEN_H - 2 * BODY_PADDING) / LINE_PX);
const PAGE_CONTENT_CAP = 1000; // safe for both rebuilds and upgrades
const BOX_PADDING = 2;
const BOX_BORDER = 1;
const BOX_INSET = BOX_PADDING + BOX_BORDER;
const BOX_GAP = 4;
const BOX_INNER_W = SCREEN_W - 2 * BOX_INSET;

/**
 * One screen-worth of result content. Multi-claim results and long body text
 * expand into a flat list of these — swipe-down increments the index, swipe-up
 * decrements. `question` is the subdued context caption, repeated on every
 * page; `text` carries the answer chunk. `pageWithinClaim` identifies the
 * continuation page within an entry.
 */
type AnswerMetadata = { position?: string; language?: string; pageIndicator?: string };
type AnswerCaption = AnswerMetadata & { question: string };
type PageRef = AnswerMetadata & {
  claimIdx: number;
  pageWithinClaim: number;
  text: string;
  question?: string;
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
let activeAnswerCaption: AnswerCaption | undefined;
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
// Keep the canonical status even while an answer hides it. Dismissing the
// answer restores the current recording / processing indicator in the corner.
let pendingStatusFrame = '';
let cornerStatusWidth = 1;

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
 *  dot fallback used on the listening-state layouts. Both baseline and discreet
 *  idle draw an explicit dot; firmware carets are not a reliable recording
 *  indicator. Answers suppress the corner entirely. */
function statusDisplayText(): string {
  if (!recordingDotEligible) return '';
  if (recordingPaused()) return 'PAUSED';
  if (pendingStatusFrame !== '') return pendingStatusFrame;
  if (activeLayout === 'discreet-minimal') return '•';
  if (activeLayout !== 'baseline') return '';
  // Auto-mode replaces the dot with a short label so the wearer can tell
  // at a glance that no tap is required. Confined to baseline because the
  // discreet layouts are intentionally chrome-free.
  return autoModeIndicator ? 'AUTO' : '•';
}

function statusBrightness(): number {
  return recordingDotEligible ? (recordingPaused() || pendingStatusFrame ? 3 : 1) : 0;
}

async function upgradeStatus(): Promise<void> {
  const content = statusDisplayText();
  const width = cornerStatusGeometry(content).width;
  // The SDK only upgrades text/brightness in place. Move the tight box when
  // its measured width changes; same-width animation frames stay flicker-free.
  // Never rebuild a visible answer just to reposition an empty indicator.
  if (recordingDotEligible && width !== cornerStatusWidth) {
    const ok = await getBridge().rebuildPageContainer(buildActivePage());
    if (!ok) throw new Error('rebuildPageContainer (corner status) failed.');
    return;
  }
  await upgradeText(CONTAINER.status, NAME.status, statusDisplayText(), statusBrightness());
}

/** Toggle the resting "AUTO" indicator in the corner status slot. Called by
 *  the lifecycle when the VAD watcher starts/stops. Idempotent. */
export async function setAutoModeIndicator(on: boolean): Promise<void> {
  if (autoModeIndicator === on) return;
  autoModeIndicator = on;
  if (currentPage !== 'active' || !recordingDotEligible) return;
  await upgradeStatus();
}

let bootstrapped = false;
let currentPage: HudPage = 'none';
let menuPersona: Persona | null = null;
let cachedHistoryEntries: HistoryEntry[] = [];
/**
 * Sub-mode for the active page. Driven by the lifecycle, read by buildActivePage.
 *   - 'baseline'         : full-screen body + dim corner while listening
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

let conversationOptionItems: MenuItem[] = [];
export function conversationOptionAtIndex(index: number): string { return conversationOptionItems[index]?.id ?? 'conversation-back'; }
export async function showConversationOptions(title: string, items: MenuItem[]): Promise<void> {
  conversationOptionItems = [{ id: 'conversation-back', label: '← Back' }, ...items].slice(0, 20);
  const textObject = [new TextContainerProperty({ containerID: 60, containerName: 'vl-conv-title', xPosition: 16, yPosition: 8, width: 544, height: 36, content: title, isEventCapture: 0 })];
  const listObject = [new ListContainerProperty({ containerID: 61, containerName: 'vl-conv-list', xPosition: 16, yPosition: 48, width: 544, height: 224, isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({ itemCount: conversationOptionItems.length, itemWidth: 528, isItemSelectBorderEn: 1, itemName: conversationOptionItems.map(i => i.disabled ? `${i.label} (unavailable)` : i.label) }) })];
  const ok = await getBridge().rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 2, listObject, textObject }));
  if (!ok) throw new Error('Conversation menu could not be displayed.');
  currentPage = 'conversation-options';
}
export async function showCaptionsPage(text: string, status = 'Captured speech · speaker unknown'): Promise<void> {
  const textObject = [
    new TextContainerProperty({ containerID: 62, containerName: 'vl-cap-title', xPosition: 16, yPosition: 0, width: 544, height: 36, content: status.slice(0, 100), isEventCapture: 0 }),
    new TextContainerProperty({ containerID: 63, containerName: 'vl-cap-body', xPosition: 16, yPosition: 40, width: 544, height: 220, content: text.slice(-700) || 'Waiting for speech…', isEventCapture: 0 }),
  ];
  const listObject = [new ListContainerProperty({ containerID: 64, containerName: 'vl-cap-input', xPosition: 16, yPosition: 264, width: 544, height: 24, isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({ itemCount: 1, itemWidth: 528, isItemSelectBorderEn: 0, itemName: ['Tap: menu · Double-tap: help'] }) })];
  if (!await getBridge().rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 3, listObject, textObject }))) throw new Error('Captions page could not be displayed.');
  currentPage = 'captions';
}
export async function updateCaptionsPage(text: string, status = 'Captured speech · speaker unknown'): Promise<void> {
  if (currentPage !== 'captions') return;
  await upgradeText(62, 'vl-cap-title', status.slice(0, 100));
  if (currentPage === 'captions') await upgradeText(63, 'vl-cap-body', text.slice(-700) || 'Waiting for speech…');
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
  if (activeHidden) activeAnswerCaption = undefined;
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
  // History detail uses the same full-screen budget as live answers.
  // Session-relative X/Y reflects the cached
  // history list (which the user can walk via edge swipes); bullets show
  // within-entry page position when this entry spans multiple pages. The
  // X/Y tag is shown even when there's only one cached entry ("1/1") so the
  // wearer never wonders whether the indicator is missing.
  const cachedTotal = cachedHistoryEntries.length;
  const sessionTag = cachedTotal > 0 && historyDetailIndex >= 0
    ? `${historyDetailIndex + 1}/${cachedTotal}`
    : '';
  detailPages = computePagesForResult(entry.result, {
    autoSelected: entry.result.autoSelected === true,
    autoLensLabel: entry.result.autoSelected === true ? entry.lensName : undefined,
    sessionTag,
    groundingMode: entry.groundingMode,
    question: entry.question,
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
  detailPages = computePagesForResult(entry.result, {
    autoSelected: entry.result.autoSelected === true,
    autoLensLabel: entry.result.autoSelected === true ? entry.lensName : undefined,
    sessionTag,
    groundingMode: entry.groundingMode,
    question: entry.question,
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
  const content = (STATUS_LABEL[label] ?? label).trim();
  // Record the canonical status content even when off the active page so the
  // next rebuild can seed the status container with the current spinner /
  // listening state. The recording-dot fallback is applied at write time by
  // statusDisplayText() so it never persists into pendingStatusFrame — a
  // subsequent layout switch (e.g. discreet-minimal → discreet-result) would
  // otherwise carry the dot into the answer view.
  pendingStatusFrame = content;
  if (currentPage !== 'active' || !recordingDotEligible) return;
  await upgradeStatus();
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
let streamingPreviewVisible = false;
let streamingGeneration = 0;
let streamingWrite: Promise<void> = Promise.resolve();

/**
 * Push a streaming partial onto the active page's reason container. Cleared
 * when the final result lands (the normal `setLensResult` path takes over).
 * Off-screen calls (currentPage !== 'active') queue the most recent value
 * but don't write — the lifecycle's `setLensResult` will commit the final
 * answer once the wearer returns.
 */
export function setLensStreamingHeading(text: string): void {
  if (currentPage !== 'active') return;
  if (!streamingActive) streamingGeneration++;
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
function flushStreamingHeading(): Promise<void> {
  if (streamingPending === null) return streamingWrite;
  const next = streamingPending;
  streamingLast = next;
  streamingPending = null;
  const generation = streamingGeneration;
  // A BLE rebuild can outlast the throttle interval. Queue partials and let
  // the final result drain this queue so it cannot write into a missing body.
  streamingWrite = streamingWrite.then(async () => {
    if (generation !== streamingGeneration || currentPage !== 'active') return;
    const wasDotEligible = recordingDotEligible;
    const hadQuestionBox = activeAnswerCaption !== undefined;
    activeAnswerCaption = undefined;
    streamingPreviewVisible = true;
    recordingDotEligible = false;
    await setActiveHint('');
    if (generation !== streamingGeneration || currentPage !== 'active') return;
    if (activeLayout === 'discreet-minimal' || hadQuestionBox) {
      if (activeLayout === 'discreet-minimal') activeLayout = 'discreet-result';
      const ok = await getBridge().rebuildPageContainer(buildActivePage());
      if (!ok) throw new Error('rebuildPageContainer (streaming answer) failed.');
    } else if (wasDotEligible) {
      await upgradeStatus();
    }
    if (generation !== streamingGeneration || currentPage !== 'active') return;
    const preview = paginateText(next, BODY_INNER_W, ANSWER_PAGE_LINES, ANSWER_PAGE_LINES)[0]!;
    await upgradeText(CONTAINER.reason, NAME.reason, preview, 4);
  }).catch((error: unknown) => {
    pushDebugEvent({ label: 'hud-stream-fail', detail: error instanceof Error ? error.message : String(error) });
  });
  return streamingWrite;
}

/**
 * Tear down any pending streaming heading writes. Called by the lifecycle as
 * soon as the final result is ready so a trailing throttled flush can't
 * land *after* `setLensResult`'s rebuild and undo it.
 */
export function clearLensStreamingHeading(): void {
  streamingGeneration++;
  if (streamingTimer) {
    clearTimeout(streamingTimer);
    streamingTimer = null;
  }
  streamingPending = null;
  streamingLast = '';
  streamingActive = false;
}

/** Remove an unfinished answer while preserving completed session pages for recall. */
export async function discardLensStreamingHeading(isCurrent: () => boolean = () => true): Promise<void> {
  clearLensStreamingHeading();
  const generation = streamingGeneration;
  await streamingWrite;
  if (generation !== streamingGeneration || !isCurrent() || !streamingPreviewVisible) return;
  streamingPreviewVisible = false;
  activeHidden = true;
  recordingDotEligible = true;
  if (currentPage === 'active') {
    await hideActiveResultInPlace();
  } else if (isDiscreetLayout(activeLayout)) {
    setActiveLayout('discreet-minimal');
  }
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
  assistance: 'respond',
  'meeting-prep': 'meeting-prep',
  'session-summary': 'session-summary',
  'game': 'game',
  'translation': 'translation',
};

function synthesizeEntryFromResult(result: LensResult, idx = 0): HistoryEntry {
  // When Auto picked this result, the synthetic entry needs a real lensName so
  // the Auto-chose prefix on the active / history-detail page survives the
  // synthetic round-trip (tests + menu-replay).
  const personaId = result.autoSelected
    ? result.type === 'assistance' ? result.action : PERSONA_ID_BY_RESULT_TYPE[result.type]
    : '';
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
    case 'assistance':
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
  await streamingWrite;
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
    const hadQuestionBox = activeAnswerCaption !== undefined;
    activeAnswerCaption = undefined;
    recordingDotEligible = true;
    if (currentPage !== 'active') return;
    if (activeLayout === 'discreet-minimal') {
      if (wasSuppressed) {
        await upgradeStatus();
      }
      return;
    }
    if (isDiscreetLayout(activeLayout) || hadQuestionBox) {
      if (isDiscreetLayout(activeLayout)) setActiveLayout('discreet-minimal');
      const ok = await getBridge().rebuildPageContainer(buildActivePage());
      if (!ok) throw new Error('rebuildPageContainer (discreet-minimal) failed.');
      return;
    }
    await upgradeText(CONTAINER.reason, NAME.reason, '', 0);
    if (wasSuppressed) {
      await upgradeStatus();
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

/** Hide an answer after returning from the menu while preserving swipe recall. */
export async function dismissActiveAnswer(): Promise<void> {
  if (currentPage !== 'active') return;
  await hideActiveResultInPlace();
}

/** Demote the active page to its idle layout (baseline / discreet-minimal)
 * while keeping `sessionPages` and `sessionPageIndex` intact, so a swipe-up
 * can reveal the last session page again. Shared by swipe-down dismiss and
 * tap-back from the menu. */
async function hideActiveResultInPlace(): Promise<void> {
  streamingPreviewVisible = false;
  activeHidden = true;
  // Re-enable the recording dot — the wearer is back to a listening view.
  recordingDotEligible = true;
  const hadQuestionBox = activeAnswerCaption !== undefined;
  activeAnswerCaption = undefined;
  const targetIdle: ActiveLayout = isDiscreetLayout(activeLayout) ? 'discreet-minimal' : 'baseline';
  if (activeLayout !== targetIdle || hadQuestionBox) {
    setActiveLayout(targetIdle);
    const ok = await getBridge().rebuildPageContainer(buildActivePage());
    if (!ok) throw new Error('rebuildPageContainer (hide) failed.');
    return;
  }
  // Already on the idle layout (e.g., single-page baseline). Wipe the unified
  // body so the wearer sees a blank screen between answers and restore the
  // corner recording dot suppressed while the answer was visible.
  await upgradeText(CONTAINER.reason, NAME.reason, '', 0);
  await upgradeStatus();
}

/** Mark the active result as hidden without clearing it. Used by the menu's
 * Back option so the next swipe-up can re-reveal the last session page. */
export function markActiveHidden(): void {
  if (sessionPages.length > 0) activeHidden = true;
}

/** True iff the active result is preserved in memory but currently hidden. */
export function isActiveHidden(): boolean { return activeHidden; }

/** Routine gesture / analysis instructions stay off the recording HUD.
 * Keep this lifecycle hook to clear any transient feedback before continuing. */
export async function setActiveHint(_content: string): Promise<void> {
  if (!activeHintFlashTimer) return;
  clearTimeout(activeHintFlashTimer);
  activeHintFlashTimer = null;
  if (currentPage === 'active' && activeLayout === 'baseline') {
    await upgradeText(CONTAINER.activeHint, NAME.activeHint, '');
  }
}

/**
 * Update the small spinner slot left of the clock on the menu page.
 * Always records the frame so a subsequent menu rebuild reflects the current
 * spinner state; only writes to the device when the menu is on screen.
 */
export async function setMenuSpinner(content: string): Promise<void> {
  content = content.trim();
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
export function seedStatusFrame(content: string): void { pendingStatusFrame = content.trim(); }
export function seedMenuSpinnerFrame(content: string): void { pendingMenuSpinnerFrame = content.trim(); }

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
 * Brief feedback for a rejected check, then return to an empty HUD footer.
 * Never place a message over a visible answer.
 */
export async function flashActiveHint(message: string, ms = 2500): Promise<void> {
  if (currentPage !== 'active') return;
  if (activeLayout !== 'baseline') return;
  if (!recordingDotEligible) return;
  if (activeHintFlashTimer) clearTimeout(activeHintFlashTimer);
  await upgradeText(CONTAINER.activeHint, NAME.activeHint, message);
  activeHintFlashTimer = setTimeout(() => {
    activeHintFlashTimer = null;
    if (currentPage !== 'active') return;
    if (activeLayout !== 'baseline') return;
    void upgradeText(CONTAINER.activeHint, NAME.activeHint, '');
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


async function upgradeText(containerID: number, containerName: string, content: string, textColor?: number): Promise<void> {
  const upgrade = new TextContainerUpgrade({
    containerID,
    containerName,
    contentOffset: 0,
    contentLength: 0, // 0 = full replacement (SDK semantics)
    content,
    textColor,
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
  separator = '\n\n',
): string {
  const { top, middle, bottom } = formatLensResultBase(result, claimIdx, groundingMode, separator);

  // Use blank section rows when they fit; compact pagination uses newlines.
  const sections: string[] = [];
  if (top) sections.push(flowProse(top));
  if (middle) sections.push(flowProse(middle));
  if (bottom) sections.push(result.type === 'session-summary' || result.type === 'translation' || result.type === 'assistance' ? bottom : flowProse(bottom));
  return sections.join(separator);
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
  separator = '\n\n',
): { top: string; middle: string; bottom: string } {
  // `°` after the verdict glyph signals the wearer that this answer came from
  // training data alone — provider couldn't supply web grounding. Only
  // attached to lens types whose verdict slot drives the wearer's confidence
  // decision (fact-check, bias). Other lenses already carry their own
  // groundedness signal in the badge column.
  const groundlessMark = groundingMode === 'groundless' ? '°' : '';
  switch (result.type) {
    case 'assistance': return { top: result.headline, middle: '', bottom: [result.detail, ...result.records.map(formatConversationRecord)].filter(Boolean).join('\n') };
    case 'fact-check': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      const verdictLine = c.verdict === 'TRUE' ? '+ TRUE' : c.verdict === 'FALSE' ? '- FALSE' : '? UNVERIFIED';
      return {
        top: c.claim,
        middle: `${verdictLine}${groundlessMark}`,
        bottom: c.reason,
      };
    }
    case 'trivia': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return {
        top: flowProse(c.question), middle: flowProse(c.answer), bottom: flowProse(c.description),
      };
    }
    case 'logical-fallacy': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return { top: c.fallacy.toUpperCase(), middle: '', bottom: c.explanation };
    }
    case 'bias': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      const verdictLine = c.verdict === 'NEUTRAL' ? '+ NEUTRAL' : '- BIASED';
      return {
        top: c.direction || '',
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
      return { top: '', middle: '', bottom: formatSessionSummaryBody(result, separator) };
    case 'meeting-prep': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      // Each claim kind gets its own visual treatment so the user can tell
      // answer / supporting evidence / follow-up apart while swiping.
      switch (c.kind) {
        case 'answer':
          return {
            top: c.text,
            middle: c.detail,
            bottom: '',
          };
        case 'evidence':
          return {
            top: `"${c.text}"`,
            middle: '',
            bottom: '',
          };
        case 'followup':
          return { top: `→ ${c.text}`, middle: '', bottom: '' };
      }
    }
    case 'devils-advocate': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return { top: c.counterpoint, middle: '', bottom: c.rationale };
    }
    case 'key-questions': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return { top: c.question, middle: '', bottom: c.context };
    }
    case 'companion': {
      const c = result.claims[claimIdx] ?? result.claims[0]!;
      return {
        top: c.headline,
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
      return { top: topic, middle, bottom: summary };
    }
    case 'translation': {
      // The HUD shows the spoken transcript on top, the translation in the
      // middle, and 3 numbered reply starters at the bottom (each rendered
      // as two lines: translated reply first because that's the wearer's
      // primary reading language, then the source-language version
      // underneath so they know what to actually speak).
      // Spell the detected language out ("Danish", "Japanese") so the wearer
      // can verify the lens caught it correctly — a bare "DA" is easy to
      // misread. `languageDisplayName` resolves the BCP-47 code to an English
      // name, falling back to the upper-cased code when it can't.
      // When romanization is enabled and the source is a non-Latin script, the
      // model fills `sourceTextRomanized` / each starter's `sourceRomanized`; we
      // show that IN PLACE OF the native script (one line, not both). Empty
      // otherwise (Latin script or feature off) → native text is shown.
      const sourceLine = withRomanized(result.sourceText, result.sourceTextRomanized);
      const top = sourceLine;
      const middle = result.translatedText;
      const starters = result.replyStarters
        .map((s, i) => `${i + 1}. ${s.translated}\n   ${withRomanized(s.source, s.sourceRomanized)}`)
        .join('\n');
      return { top, middle, bottom: starters };
    }
  }
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function flowProse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Resolve a BCP-47 short code (what the Translate lens returns in
 * `sourceLanguage`, e.g. "da", "ja", "zh") to a human-readable English name
 * ("Danish", "Japanese", "Chinese") so the wearer can confirm the lens
 * identified the language correctly. Uses the platform's `Intl.DisplayNames`,
 * which covers far more languages than our 11-entry `LANGUAGES` dict and would
 * otherwise fall back to native names anyway. Falls back to the upper-cased
 * code when the runtime lacks `Intl.DisplayNames`, the code is unknown (Intl
 * echoes the input back), or it's the lens's "unknown" sentinel.
 */
function languageDisplayName(code: string): string {
  const c = (code || '').trim();
  if (!c || c.toLowerCase() === 'unknown') return 'Unknown';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(c);
    if (name && name.toLowerCase() !== c.toLowerCase()) return name;
  } catch {
    // Intl.DisplayNames unavailable or threw on a malformed code — fall through.
  }
  return c.toUpperCase();
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
function formatSessionSummaryBody(result: Extract<LensResult, { type: 'session-summary' }>, separator: string): string {
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
  return sections.join(separator);
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
  const key = `${innerW}\0${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const measured = measureTextWrap(text, innerW).lineCount;
  cache.set(key, measured);
  return measured;
}

/**
 * Split text against the visible line and SDK character budgets, measuring
 * the inline prefix too. Prefer word boundaries; split long runs by codepoint.
 */
function paginateText(
  text: string, innerW: number, firstLines: number, scrollLines: number,
  prefix = '', maxCharacters = PAGE_CONTENT_CAP,
): string[] {
  const pages: string[] = [];
  let remaining = text;
  let isFirst = true;
  const cache: WrapCache = new Map();
  while (remaining.length > 0) {
    const maxLines = isFirst ? firstLines : scrollLines;
    const { chunk, rest } = takeLines(remaining, innerW, maxLines, cache, prefix, maxCharacters);
    pages.push(chunk);
    if (rest.length === remaining.length) break; // safety: no forward progress
    remaining = rest;
    isFirst = false;
  }
  return pages.length > 0 ? pages : [''];
}

function takeLines(
  text: string, innerW: number, maxLines: number, cache: WrapCache,
  prefix: string, maxCharacters: number, suffix = '',
): { chunk: string; rest: string } {
  const fits = (chunk: string) => prefix.length + chunk.length + suffix.length <= maxCharacters
    && cachedLineCount(cache, prefix + chunk + suffix, innerW) <= maxLines;
  if (fits(text)) return { chunk: text, rest: '' };

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
    if (fits(candidate)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best === 0) {
    // No word boundary works — the first token alone exceeds the line budget.
    // Fall back to splitting on the codepoint that fits.
    return charSplitFallback(text, fits);
  }
  const chunk = words.slice(0, best).join('').replace(/\s+$/, '');
  const rest = words.slice(best).join('').replace(/^\s+/, '');
  return { chunk, rest };
}

function charSplitFallback(text: string, fits: (chunk: string) => boolean): { chunk: string; rest: string } {
  // Split by codepoint so a page boundary cannot separate a surrogate pair.
  const chars = Array.from(text);
  let lo = 1;
  let hi = chars.length;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(chars.slice(0, mid).join(''))) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { chunk: chars.slice(0, best).join(''), rest: chars.slice(best).join('') };
}

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
  separator = '\n\n',
): string {
  const total = claimCount(result);
  const parts: string[] = [];
  for (let i = 0; i < total; i++) {
    const body = formatUnifiedBody(result, i, autoSelected, groundingMode, separator);
    if (body) parts.push(body);
  }
  return parts.join(separator);
}

/**
 * Bottom bullet row showing within-entry page position — `● ○ ○` for page 1
 * of 3, `○ ● ○` for page 2, `○ ○ ●` for page 3. Left-aligned (text-container
 * rendering on this hardware doesn't expose alignment, and a fixed-space
 * leading pad can't be reliably centered across font widths — so we keep it
 * unambiguously left-aligned). Only called when total > 1.
 */
function bulletRow(currentIdx: number, total: number): string {
  // A long answer must not turn the position indicator into several rows.
  if (total > 12) return `${currentIdx + 1}/${total}`;
  const dots: string[] = [];
  for (let i = 0; i < total; i++) dots.push(i === currentIdx ? '●' : '○');
  return dots.join(' ');
}

function questionCaption(question: string, metadata: AnswerMetadata = {}): string {
  const width = captionTextWidth(metadata);
  const lines = metadata.language ? 1 : 2;
  if (measureTextWrap(question, width).lineCount <= lines && question.length <= PAGE_CONTENT_CAP) return question;
  const { chunk } = takeLines(question, width, lines, new Map(), '', PAGE_CONTENT_CAP, '…');
  return `${chunk}…`;
}

function captionTextWidth(metadata: AnswerMetadata): number {
  return metadata.language || !metadata.position ? SCREEN_W : SCREEN_W - getTextWidth(metadata.position) - BOX_GAP;
}

function questionAnswerGeometry(question: string, metadata: AnswerMetadata = {}): {
  height: number; questionY: number; questionWidth: number; questionHeight: number;
  positionWidth: number; answerY: number; answerHeight: number; answerLines: number;
} {
  const questionY = metadata.language ? LINE_PX : 0;
  const questionWidth = captionTextWidth(metadata);
  const questionHeight = measureTextWrap(question, questionWidth).height;
  const height = questionY + questionHeight;
  const positionWidth = metadata.position ? getTextWidth(metadata.position) : 0;
  const answerY = height + BOX_GAP;
  const answerHeight = SCREEN_H - answerY;
  return { height, questionY, questionWidth, questionHeight, positionWidth, answerY, answerHeight, answerLines: Math.floor((answerHeight - 2 * BOX_INSET) / LINE_PX) };
}

function formatAnswerSections(
  result: LensResult, groundingMode: 'grounded' | 'groundless' | undefined, separator: string, contextQuestion = '',
): { question: string; answer: string; language?: string } {
  const { top, middle, bottom } = formatLensResultBase(result, 0, groundingMode, separator);
  const lensName = getPersona(result.type === 'assistance' ? result.action : PERSONA_ID_BY_RESULT_TYPE[result.type])?.name ?? result.type;
  const claim = 'claims' in result ? result.claims[0] : undefined;
  const quote = claim && 'quote' in claim ? flowProse(claim.quote) : '';
  switch (result.type) {
    case 'assistance':
      return { question: flowProse(result.quote) || flowProse(contextQuestion) || lensName, answer: formatEntryBody(result, false, groundingMode, separator) };
    case 'fact-check':
    case 'trivia':
    case 'game':
      return {
        question: flowProse(top) || lensName,
        answer: claimCount(result) > 1
          ? formatEntryBody(result, false, groundingMode, separator)
          : [flowProse(middle), flowProse(bottom)].filter(Boolean).join(separator),
      };
    case 'translation':
      return {
        language: languageDisplayName(result.sourceLanguage), question: flowProse(top) || lensName,
        answer: [flowProse(middle), bottom].filter(Boolean).join(separator),
      };
    case 'session-summary':
      return { question: flowProse(result.title) || lensName, answer: bottom };
    default:
      return { question: quote || flowProse(contextQuestion) || lensName, answer: formatEntryBody(result, false, groundingMode, separator) };
  }
}

/**
 * Build the paginated page list for one entry, with all indicator chrome
 * applied:
 *   - Session-relative `"X/N"` in a separately dimmed position container
 *     (when the caller passes a non-empty `sessionTag`). Stays the same
 *     across every page of this entry so the wearer always knows which
 *     question they're on; only changes when crossing into a different
 *     entry (via the natural page sequence in `sessionPages`).
 *   - Bottom bullet row showing within-entry page position, only when the
 *     entry expands to more than one page.
 *
 * Captions take at most two lines. Paginate against the remaining answer-box
 * dimensions, reserving one indicator line only for multi-page answers.
 */
function computePagesForResult(
  result: LensResult,
  options: {
    autoSelected?: boolean;
    sessionTag?: string;
    autoLensLabel?: string;
    groundingMode?: 'grounded' | 'groundless';
    question?: string;
  } = {},
): PageRef[] {
  const autoSelected = options.autoSelected ?? (result.autoSelected === true);
  const sessionTag = options.sessionTag ?? '';
  const autoPrefix =
    autoSelected && options.autoLensLabel ? options.autoLensLabel : '';

  // The Auto lens label belongs to the question. Position is independent so
  // it can use a dimmer brightness without dimming the question with it.
  const prefix = autoPrefix ? `${autoPrefix} · ` : '';
  const applyPrefix = (chunk: string) => prefix + chunk;

  const sections = formatAnswerSections(result, options.groundingMode, '\n\n', options.question);
  const metadata: AnswerMetadata = { position: sessionTag || undefined, language: sections.language };
  const question = questionCaption(applyPrefix(sections.question), metadata);
  const { answerLines } = questionAnswerGeometry(question, metadata);
  let answer = sections.answer;
  const fitsAnswer = (text: string) => text.length <= PAGE_CONTENT_CAP
    && measureTextWrap(text, BOX_INNER_W).lineCount <= answerLines;
  if (!fitsAnswer(answer)) answer = formatAnswerSections(result, options.groundingMode, '\n', options.question).answer;
  if (fitsAnswer(answer)) return [{ claimIdx: 0, pageWithinClaim: 0, question, ...metadata, text: answer }];
  const chunks = paginateText(answer, BOX_INNER_W, answerLines - 1, answerLines - 1);
  const totalPages = chunks.length;
  return chunks.map((chunk, p) => ({
    claimIdx: 0,
    pageWithinClaim: p,
    question,
    ...metadata,
    pageIndicator: bulletRow(p, totalPages),
    text: chunk,
  }));
}

function isDiscreetLayout(layout: ActiveLayout): boolean {
  return layout === 'discreet-minimal' || layout === 'discreet-result';
}

function targetLayoutForActivePage(): ActiveLayout {
  return isDiscreetLayout(activeLayout) ? 'discreet-result' : 'baseline';
}

function captionGeometryKey(caption?: AnswerCaption): string {
  return caption ? JSON.stringify([questionAnswerGeometry(caption.question, caption), !!caption.pageIndicator]) : '';
}

function captionLanguageText(metadata: AnswerMetadata): string {
  const width = SCREEN_W - (metadata.position ? getTextWidth(metadata.position) + BOX_GAP : 0);
  return pxTruncate(metadata.language ?? '', width);
}

async function upgradeAnswerCaption(caption: AnswerCaption): Promise<void> {
  await upgradeText(CONTAINER.claim, NAME.claim, caption.question, 2);
  if (caption.position) await upgradeText(CONTAINER.answerPosition, NAME.answerPosition, caption.position, 1);
  if (caption.language) await upgradeText(CONTAINER.answerLanguage, NAME.answerLanguage, captionLanguageText(caption), 2);
  if (caption.pageIndicator) await upgradeText(CONTAINER.answerPageIndicator, NAME.answerPageIndicator, caption.pageIndicator, 1);
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
  const totalEntries = sessionEntries.length;
  const out: SessionPageRef[] = [];
  for (let i = 0; i < totalEntries; i++) {
    const entry = sessionEntries[i]!;
    // Always show the session-relative tag — even for a 1-entry session
    // ("1/1") so the wearer never wonders whether the indicator is missing.
    const sessionTag = totalEntries > 0 ? `${i + 1}/${totalEntries}` : '';
    const pages = computePagesForResult(entry.result, {
      autoSelected: entry.result.autoSelected === true,
      autoLensLabel: entry.result.autoSelected === true ? entry.lensName : undefined,
      sessionTag,
      groundingMode: entry.groundingMode,
      question: entry.question,
    });
    for (const p of pages) {
      out.push({ ...p, entryIdx: i });
    }
  }
  sessionPages = out;
}

/** Rebuild only when the mode or question-caption dimensions change. */
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
  streamingPreviewVisible = false;
  const target = targetLayoutForActivePage();
  // Suppress the recording dot the moment an answer is about to land — the
  // dot is the "listening, nothing on screen" indicator. Set this BEFORE any
  // page rebuild so the rebuild seeds the corner with '' instead of '•'.
  const wasDotEligible = recordingDotEligible;
  recordingDotEligible = false;
  await setActiveHint('');
  const caption = page.question === undefined ? undefined : { question: page.question, position: page.position, language: page.language, pageIndicator: page.pageIndicator };
  const layoutChanged = target !== activeLayout || captionGeometryKey(activeAnswerCaption) !== captionGeometryKey(caption);
  activeAnswerCaption = caption;
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
    await upgradeStatus();
  }
  if (caption) await upgradeAnswerCaption(caption);
  await upgradeText(CONTAINER.reason, NAME.reason, page.text, 4);
}

/** Keep the context caption fixed while upgrading history answer pages. */
async function renderHistoryDetailPage(): Promise<void> {
  if (currentPage !== 'history-detail') return;
  const page = detailPages[detailPageIndex];
  const entry = cachedHistoryEntries[historyDetailIndex];
  if (!page || !entry) return;
  if (page.question !== undefined) await upgradeAnswerCaption({ question: page.question, position: page.position, language: page.language, pageIndicator: page.pageIndicator });
  await upgradeText(CONTAINER.reason, NAME.reason, page.text);
}

// ------- mid-summary page helpers -----------------------------------------

type MidSummaryResult = Extract<LensResult, { type: 'session-summary' }>;
let midSummaryQuestion = '';
let teleprompterQuestion = '';

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
    content: 'Choose a lens', isEventCapture: 0,
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
    width: SCREEN_W - 32, height: 168, borderWidth: 0, paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: itemNames.length, itemWidth: SCREEN_W - 48, isItemSelectBorderEn: 1,
      itemName: itemNames,
    }),
    isEventCapture: 1,
  });
  const profile = new TextContainerProperty({
    containerID: CONTAINER.profile, containerName: NAME.profile, xPosition: 16, yPosition: 220,
    width: SCREEN_W - 32, height: 28, paddingLength: 4,
    content: `Profile: ${conversationProfileName()} · Setup on phone`, isEventCapture: 0,
  });
  const hint = new TextContainerProperty({
    containerID: CONTAINER.pickerHint, containerName: NAME.pickerHint, xPosition: 16, yPosition: 252,
    width: SCREEN_W - 32, height: 28, borderWidth: 0, paddingLength: 4,
    content: itemNames.length > 1 ? 'Swipe ⇅ · Tap: start · Double-tap: exit' : 'Tap: start · Double-tap: exit',
    isEventCapture: 0,
  });
  const Ctor = mode === 'create' ? CreateStartUpPageContainer : RebuildPageContainer;
  const listObject = [list];
  const textObject = [title, profile, hint, summaryBadge];
  return new Ctor({ containerTotalNum: totalContainers(listObject, textObject), listObject, textObject });
}

/**
 * Build the picker item labels. The core lenses come first, then the
 * two sub-picker entries pinned at the BOTTOM — Games, then More lenses — so
 * the wearer lands on a core lens (the common case) without scrolling. The
 * lifecycle's `pickerEntryAtIndex` keeps these offsets in sync — if you
 * reorder here, update that too.
 */
// Chevron suffix telegraphs that tapping this row opens a sub-picker
// rather than starting a session — mirrors the platform UI convention
// for "this leads elsewhere".
const PICKER_GAMES_LABEL = 'Games ›';
const PICKER_SPECIALIZED_LABEL = 'More lenses ›';
function conversationProfileName(): string {
  return CONVERSATION_PROFILES.find(p => p.id === settings().conversation?.profile)?.name ?? 'None';
}

function buildPickerItemNames(): string[] {
  return [...getPickerPersonas().map(p => p.name), PICKER_GAMES_LABEL, PICKER_SPECIALIZED_LABEL];
}

export type PickerEntry =
  | { kind: 'games' }
  | { kind: 'specialized' }
  | { kind: 'persona'; persona: Persona };

/**
 * Resolve a picker list index to the entry it represents. With
 * `C = getPickerPersonas().length` (the core lenses), indices `0..C-1` map to
 * those personas; index `C` is the Games sub-picker and index `C+1` is the
 * More lenses sub-picker, both pinned at the bottom. Out-of-range indices fall
 * back to the first persona — picker should never silently no-op on a tap, and
 * falling back to a lens (rather than a sub-picker) matches the typical "I want
 * to ask a question" intent.
 */
export function pickerEntryAtIndex(idx: number | undefined | null): PickerEntry {
  const personas = getPickerPersonas();
  const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
  if (safe < personas.length) {
    const p = personas[safe];
    if (p) return { kind: 'persona', persona: p };
  }
  if (safe === personas.length) return { kind: 'games' };
  if (safe === personas.length + 1) return { kind: 'specialized' };
  const first = personas[0];
  return first ? { kind: 'persona', persona: first } : { kind: 'games' };
}

function buildMenuPage(): RebuildPageContainer {
  // Keep the lens name separate from the conversation profile. Size the clock
  // tightly around "HH:MM" so the LVGL caret stays outside the container clip.
  const titleText = `Lens: ${getPersona(activePersona())?.name ?? 'Menu'}`;
  const processingWidth = Math.ceil(getTextWidth('99999s'));
  const processingX = SCREEN_W - 72 - processingWidth;
  const title = new TextContainerProperty({
    containerID: CONTAINER.title, containerName: NAME.title, xPosition: 16, yPosition: 8,
    width: processingX - 24, height: 32, borderWidth: 0, paddingLength: 0,
    content: titleText, isEventCapture: 0,
  });
  // Spinner sits immediately left of the clock; populated by setMenuSpinner
  // while an analysis is in flight, empty otherwise.
  const spinner = new TextContainerProperty({
    containerID: CONTAINER.menuSpinner, containerName: NAME.menuSpinner,
    xPosition: processingX, yPosition: 8, width: processingWidth, height: LINE_PX,
    borderWidth: 0, paddingLength: 0,
    content: pendingMenuSpinnerFrame, isEventCapture: 0,
  });
  const clock = new TextContainerProperty({
    containerID: CONTAINER.clock, containerName: NAME.clock,
    xPosition: SCREEN_W - 64, yPosition: 8, width: 56, height: 32,
    borderWidth: 0, paddingLength: 0,
    content: formatClockTime(), isEventCapture: 0,
  });
  const profile = new TextContainerProperty({
    containerID: CONTAINER.profile, containerName: NAME.profile, xPosition: 16, yPosition: 40,
    width: SCREEN_W - 32, height: 28, paddingLength: 0,
    content: `Profile: ${conversationProfileName()}${recordingPaused() ? ' · Paused' : ''}`, isEventCapture: 0,
  });
  const list = new ListContainerProperty({
    containerID: CONTAINER.menuList, containerName: NAME.menuList, xPosition: 16, yPosition: 76,
    width: SCREEN_W - 32, height: SCREEN_H - 76 - 32, borderWidth: 0, paddingLength: 0,
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
  const textObject = [title, profile, spinner, clock, hint];
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
 * Normal listening is a dim corner indicator. The empty feedback overlay
 * consumes no answer space; it only lights briefly after a rejected check.
 * Keep the body as event capturer so swipe recall works while it is blank.
 */
function buildBaselineActivePage(): RebuildPageContainer {
  const status = makeCornerStatus();
  const body = makeAnswerSections(activeAnswerCaption?.question, '', recordingDotEligible ? 0 : 4, activeAnswerCaption);
  const hint = new TextContainerProperty({
    containerID: CONTAINER.activeHint, containerName: NAME.activeHint,
    xPosition: BODY_PADDING, yPosition: SCREEN_H - LINE_PX,
    width: BODY_INNER_W, height: LINE_PX,
    borderWidth: 0, paddingLength: 0, content: '', textColor: 2, isEventCapture: 0,
  });
  const textObject = [...body, status, hint];
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
  const status = makeCornerStatus();
  const textObject = [sink, status];
  return new RebuildPageContainer({
    containerTotalNum: totalContainers([], textObject), listObject: [], textObject,
  });
}

/**
 * Discreet answers get the same full-canvas body as normal answers.
 * The status overlay remains empty until the answer is dismissed.
 */
function buildDiscreetResultPage(): RebuildPageContainer {
  const status = makeCornerStatus();
  const body = makeAnswerSections(activeAnswerCaption?.question, '', 4, activeAnswerCaption);
  const textObject = [...body, status];
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
    textColor: 0,
  });
}

function makeAnswerBody(content = '', textColor = 4): TextContainerProperty {
  return new TextContainerProperty({
    containerID: CONTAINER.reason, containerName: NAME.reason,
    xPosition: 0, yPosition: 0, width: SCREEN_W, height: SCREEN_H,
    borderWidth: 0, paddingLength: BODY_PADDING, content, textColor, isEventCapture: 1,
  });
}

function makeAnswerSections(question?: string, content = '', textColor = 4, metadata: AnswerMetadata = {}): TextContainerProperty[] {
  if (question === undefined) return [makeAnswerBody(content, textColor)];
  const { questionY, questionWidth, questionHeight, positionWidth, answerY, answerHeight } = questionAnswerGeometry(question, metadata);
  const box = {
    xPosition: 0, width: SCREEN_W, borderWidth: BOX_BORDER, borderColor: 8,
    borderRadius: 6, paddingLength: BOX_PADDING, textColor,
  };
  const header = [
    new TextContainerProperty({
      containerID: CONTAINER.claim, containerName: NAME.claim,
      xPosition: 0, yPosition: questionY, width: questionWidth, height: questionHeight,
      borderWidth: 0, paddingLength: 0, textColor: textColor === 0 ? 0 : 2,
      content: question, isEventCapture: 0,
    }),
  ];
  if (metadata.position) header.push(new TextContainerProperty({
    containerID: CONTAINER.answerPosition, containerName: NAME.answerPosition,
    xPosition: SCREEN_W - positionWidth, yPosition: 0, width: positionWidth, height: LINE_PX,
    borderWidth: 0, paddingLength: 0, content: metadata.position, textColor: 1, isEventCapture: 0,
  }));
  if (metadata.language) header.push(new TextContainerProperty({
    containerID: CONTAINER.answerLanguage, containerName: NAME.answerLanguage,
    xPosition: 0, yPosition: 0, width: metadata.position ? SCREEN_W - positionWidth - BOX_GAP : SCREEN_W,
    height: LINE_PX, borderWidth: 0, paddingLength: 0, content: captionLanguageText(metadata), textColor: 2, isEventCapture: 0,
  }));
  const body = new TextContainerProperty({
      ...box, containerID: CONTAINER.reason, containerName: NAME.reason,
      yPosition: answerY, height: answerHeight, content, isEventCapture: 1,
    });
  const footer = metadata.pageIndicator ? [new TextContainerProperty({
    containerID: CONTAINER.answerPageIndicator, containerName: NAME.answerPageIndicator,
    xPosition: BOX_INSET, yPosition: SCREEN_H - BOX_INSET - LINE_PX,
    width: BOX_INNER_W, height: LINE_PX, borderWidth: 0, paddingLength: 0,
    content: metadata.pageIndicator, textColor: 1, isEventCapture: 0,
  })] : [];
  return [...header, body, ...footer];
}

/** Tight, padding-free geometry keeps the text at the top-right edge. */
function cornerStatusGeometry(content: string): { xPosition: number; width: number; height: number } {
  const width = Math.min(SCREEN_W, Math.max(1, Math.ceil(getTextWidth(content))));
  const height = Math.max(LINE_PX, measureTextWrap(content, width).height);
  return { xPosition: SCREEN_W - width, width, height };
}

/** Dim recording indicator, brighter brief processing / error feedback.
 * No status glyph is drawn over an answer. */
function makeCornerStatus(): TextContainerProperty {
  const content = statusDisplayText();
  const geometry = cornerStatusGeometry(content);
  cornerStatusWidth = geometry.width;
  return new TextContainerProperty({
    containerID: CONTAINER.status, containerName: NAME.status,
    ...geometry, yPosition: 0,
    borderWidth: 0, paddingLength: 0,
    content,
    textColor: statusBrightness(),
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
  parts.push(formatSessionSummaryBody(result, '\n\n'));
  const body = parts.join('\n\n');
  return measureTextWrap(body, BOX_INNER_W).lineCount <= questionAnswerGeometry(midSummaryQuestion).answerLines
    ? body
    : [loading ? 'Refreshing…' : '', formatSessionSummaryBody(result, '\n')].filter(Boolean).join('\n');
}

function buildMidSummaryPage(pageText: string): RebuildPageContainer {
  const textObject = makeAnswerSections(midSummaryQuestion, pageText);
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

  const nextQuestion = questionCaption(flowProse(result?.title ?? '') || getPersona('session-summary')?.name || 'Session Summary');
  const heightChanged = questionAnswerGeometry(nextQuestion).height !== questionAnswerGeometry(midSummaryQuestion).height;
  midSummaryQuestion = nextQuestion;
  const body = result
    ? buildMidSummaryContentBody(result, loading)
    : (loading ? 'Generating summary...' : 'Nothing to summarize yet');

  // Refresh in place when already on the page so the firmware scroll position
  // is preserved across content updates (e.g. spinner → final summary).
  if (currentPage === 'mid-summary' && !heightChanged) {
    await upgradeText(CONTAINER.claim, NAME.claim, midSummaryQuestion, 2);
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
 * History answers use the full canvas and the same event sink as live answers.
 */
function buildHistoryDetailPage(_entry: HistoryEntry, page: PageRef): RebuildPageContainer {
  const textObject = makeAnswerSections(page.question, page.text, 4, page);
  return new RebuildPageContainer({ containerTotalNum: totalContainers([], textObject), listObject: [], textObject });
}

// ---------- Game pages ----------

/** Sentinel value indicating the games-picker `← Back` row. */
const GAMES_PICKER_BACK_KIND = 'back' as const;
const GAMES_PICKER_RANDOM_LOCATION_KIND = 'random-location' as const;
/** Sentinel value indicating the runtime-only Random preset row. */
const GAMES_PICKER_RANDOM_KIND = 'random' as const;
export type GamesPickerEntry =
  | { kind: typeof GAMES_PICKER_BACK_KIND }
  | { kind: typeof GAMES_PICKER_RANDOM_KIND }
  | { kind: typeof GAMES_PICKER_RANDOM_LOCATION_KIND }
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
    { kind: GAMES_PICKER_RANDOM_LOCATION_KIND },
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
    'Near me — about where I am',
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

// ---------- Specialized lens sub-picker ----------
//
// Mirrors the Games sub-picker: a second-level list reached from the main
// picker's "More lenses ›" row. Lists the 8 non-core lenses plus a "← Back"
// row, and reuses the game* containers (rebuild replaces every container, so
// sharing IDs across these sibling sub-pages is safe).

export type SpecializedPickerEntry =
  | { kind: 'back' }
  | { kind: 'persona'; persona: Persona };

let cachedSpecializedEntries: SpecializedPickerEntry[] = [];

export function specializedPickerEntryAtIndex(idx: number | undefined | null): SpecializedPickerEntry | null {
  const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
  return cachedSpecializedEntries[safe] ?? null;
}

export async function showSpecializedPickerPage(): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showSpecializedPickerPage().');
  const specialized = getSpecializedPersonas();
  cachedSpecializedEntries = [
    { kind: 'back' },
    ...specialized.map((p) => ({ kind: 'persona' as const, persona: p })),
  ];
  const ok = await getBridge().rebuildPageContainer(buildSpecializedPickerPage(specialized));
  if (!ok) throw new Error('rebuildPageContainer (specialized-picker) failed.');
  currentPage = 'specialized-picker';
}

function buildSpecializedPickerPage(specialized: Persona[]): RebuildPageContainer {
  const itemNames = ['← Back', ...specialized.map((p) => clip(p.name, 60))];
  const title = new TextContainerProperty({
    containerID: CONTAINER.gameTitle, containerName: NAME.gameTitle,
    xPosition: 16, yPosition: 8, width: SCREEN_W - 32, height: 36,
    borderWidth: 0, paddingLength: 4, content: 'More lenses', isEventCapture: 0,
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
  const hint = new TextContainerProperty({
    containerID: CONTAINER.gameHint, containerName: NAME.gameHint,
    xPosition: 16, yPosition: 252, width: SCREEN_W - 32, height: 28,
    borderWidth: 0, paddingLength: 4,
    content: 'Tap a lens · ← Back to top', isEventCapture: 0,
  });
  const listObject = [list];
  const textObject = [title, hint];
  return new RebuildPageContainer({
    containerTotalNum: totalContainers(listObject, textObject),
    listObject,
    textObject,
  });
}

/** A null preset is the location stage, before a nearby topic is known. */
export async function showGameLoadingPage(preset: GamePreset | null, retryLabel: string): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showGameLoadingPage().');
  const ok = await getBridge().rebuildPageContainer(buildGameLoadingPage(preset, retryLabel));
  if (!ok) throw new Error('rebuildPageContainer (game-loading) failed.');
  currentPage = 'game-loading';
}

function buildGameLoadingPage(preset: GamePreset | null, retryLabel: string): RebuildPageContainer {
  const headline = !preset ? 'Locating…' : retryLabel ? `Loading ${retryLabel}…` : 'Loading…';
  const topic = preset?.topic || '…picking a topic';
  const sub = preset
    ? clip(`${gameFormatLabel(preset.format)} · ${topic} · ${gameDifficultyLabel(preset.difficulty)}`, 200)
    : 'Finding your location for a local game';
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
  const metadata = { position: `${session.index + 1}/${session.questions.length}` };
  const question = questionCaption(flowProse(q?.text ?? 'Game'), metadata);
  const textObject = makeAnswerSections(question, capContent([headline, flowProse(detail)].filter(Boolean).join('\n\n'), PAGE_CONTENT_CAP), 4, metadata);
  return new RebuildPageContainer({
    containerTotalNum: totalContainers([], textObject), listObject: [], textObject,
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
  const sub = `${gameFormatLabel(session.preset.format)} · ${gameDifficultyLabel(session.preset.difficulty)}`;
  const textObject = makeAnswerSections(questionCaption(flowProse(topic)), `${headline}\n\n${sub}`);
  return new RebuildPageContainer({
    containerTotalNum: totalContainers([], textObject), listObject: [], textObject,
  });
}

/** Clear per-session HUD state so a fresh session doesn't inherit stale buffers. */
export function resetHudSessionState(): void {
  midSummaryQuestion = '';
  teleprompterQuestion = '';
  activeAnswerCaption = undefined;
  clearLensStreamingHeading();
  streamingPreviewVisible = false;
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
  cornerStatusWidth = 1;
  recordingDotEligible = true;
  autoModeIndicator = false;
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

/** Pick the line to show for a foreign-language field: the romanization when
 *  the wearer enabled `romanizeForeignScript` and the model returned one
 *  (non-Latin script), otherwise the native text. We show ONE line, not both —
 *  a wearer who wants Romaji/Pinyin can't read the native script anyway, and
 *  the small HUD has no room to spare. Latin-script speech / feature off →
 *  romanized is empty → native is shown unchanged. */
function withRomanized(native: string, romanized: string | undefined): string {
  const r = (romanized ?? '').trim();
  return r || native;
}

function buildTranslationTeleprompterPage(
  starter: TranslationStarter,
  extended: { source: string; translated: string; sourceRomanized?: string } | null,
): RebuildPageContainer {
  // Source on top in a tall body (what the wearer will read aloud); the
  // wearer-language translation sits at the bottom as a smaller reference.
  // Source font is the same as everywhere else on this hardware — there's no
  // size knob exposed by the SDK; we get "larger" via more vertical space
  // and the natural readability of foreground vs subordinate text.
  const sourceText = withRomanized(
    extended?.source || starter.source || '(empty)',
    extended?.sourceRomanized ?? starter.sourceRomanized,
  );
  const translatedText = extended?.translated || starter.translated || '';
  const question = questionCaption(flowProse(translatedText) || 'Reply');
  const listObject: ListContainerProperty[] = [];
  const textObject = makeAnswerSections(question, capContent(flowProse(sourceText), PAGE_CONTENT_CAP));
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
  teleprompterQuestion = questionCaption(flowProse(starter.translated) || 'Reply');
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
  extendedSourceRomanized?: string,
): Promise<void> {
  if (currentPage !== 'translation-teleprompter') return;
  if (!activeTranslationStarter) return;
  const question = questionCaption(flowProse(extendedTranslated) || 'Reply');
  if (questionAnswerGeometry(question).height !== questionAnswerGeometry(teleprompterQuestion).height) {
    const ok = await getBridge().rebuildPageContainer(buildTranslationTeleprompterPage(activeTranslationStarter, {
      source: extendedSource, translated: extendedTranslated, sourceRomanized: extendedSourceRomanized,
    }));
    if (!ok) throw new Error('rebuildPageContainer (extended translation) failed.');
  } else {
    await upgradeText(CONTAINER.claim, NAME.claim, question, 2);
    await upgradeText(CONTAINER.reason, NAME.reason, flowProse(withRomanized(extendedSource, extendedSourceRomanized)));
  }
  teleprompterQuestion = question;
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
  result: { spoken: string; translated: string; translatedRomanized?: string } | null,
): RebuildPageContainer {
  // Recording state: prominent "Speak now…" prompt; foreign-language line
  // (the translation) lands here once the call returns.
  const bodyText = state === 'recording'
    ? 'Speak now…'
    : withRomanized(result?.translated || '(no speech detected)', result?.translatedRomanized);
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
  translatedRomanized?: string,
): Promise<void> {
  if (currentPage !== 'translation-wearer-speak') return;
  wearerSpeakState = 'result';
  const textObject = makeAnswerSections(
    questionCaption(flowProse(spoken) || 'Translate'),
    capContent(flowProse(withRomanized(translated || '(no speech detected)', translatedRomanized)), PAGE_CONTENT_CAP),
  );
  const ok = await getBridge().rebuildPageContainer(new RebuildPageContainer({
    containerTotalNum: totalContainers([], textObject), listObject: [], textObject,
  }));
  if (!ok) throw new Error('rebuildPageContainer (spoken translation) failed.');
}

export function _resetHudBootstrapForTesting(): void {
  bootstrapped = false;
  currentPage = 'none';
  resetHudSessionState();
}
