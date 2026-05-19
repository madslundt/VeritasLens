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
import { getPersonas, type Persona } from '@/personas';
import type { Verdict, VerdictLabel } from '@/types';

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
 *   - "unconfigured" : single visible message asking the user to configure on phone
 *   - "picker"       : list of registered personas; scroll moves SDK selection,
 *                      tap starts the highlighted one
 *   - "active"       : status / verdict / reason text + a small list at the
 *                      bottom that captures taps (single = menu, double = check)
 *   - "menu"         : two options (Fact-check / Exit) — list-based picker
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
} as const;

const STATUS_LABEL: Record<string, string> = {
  idle: '  OK  ',
  listening: ' MIC  ',
  thinking: ' ...  ',
  displaying: '  ✓   ',
  sleeping: ' ZZZ  ',
  error: ' ERR  ',
};

const VERDICT_GLYPH: Record<VerdictLabel, string> = {
  TRUE: '✓ TRUE',
  FALSE: '✗ FALSE',
  UNVERIFIED: '? UNVERIFIED',
};

export type HudPage = 'unconfigured' | 'picker' | 'active' | 'menu' | 'none';

export const MENU_OPTIONS = [
  { id: 'fact-check', label: 'Fact-check now' },
  { id: 'cancel', label: 'Cancel' },
  { id: 'exit', label: 'Exit to picker' },
] as const;
export type MenuOptionId = (typeof MENU_OPTIONS)[number]['id'];

let bootstrapped = false;
let currentPage: HudPage = 'none';
let menuPersona: Persona | null = null;

export function currentHudPage(): HudPage {
  return currentPage;
}

/** Look up the persona at the given index from the host event payload. */
export function personaAtIndex(idx: number | undefined | null): Persona | null {
  const list = getPersonas();
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
  if (!bootstrapped) {
    await bootstrapHud('unconfigured');
    return;
  }
  const ok = await getBridge().rebuildPageContainer(buildUnconfiguredPage('rebuild') as RebuildPageContainer);
  if (!ok) throw new Error('rebuildPageContainer (unconfigured) failed.');
  currentPage = 'unconfigured';
}

export async function showPickerPage(): Promise<void> {
  if (!bootstrapped) {
    await bootstrapHud('picker');
    return;
  }
  const ok = await getBridge().rebuildPageContainer(buildPickerPage('rebuild') as RebuildPageContainer);
  if (!ok) throw new Error('rebuildPageContainer (picker) failed.');
  currentPage = 'picker';
}

export async function showActivePage(persona: Persona): Promise<void> {
  if (!bootstrapped) {
    throw new Error('bootstrapHud() must run before showActivePage().');
  }
  menuPersona = persona;
  const ok = await getBridge().rebuildPageContainer(buildActivePage(persona));
  if (!ok) throw new Error('rebuildPageContainer (active) failed.');
  currentPage = 'active';
}

export async function showMenuPage(): Promise<void> {
  if (!bootstrapped) throw new Error('bootstrapHud() must run before showMenuPage().');
  const ok = await getBridge().rebuildPageContainer(buildMenuPage());
  if (!ok) throw new Error('rebuildPageContainer (menu) failed.');
  currentPage = 'menu';
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

export async function setVerdict(v: Verdict | null): Promise<void> {
  if (currentPage !== 'active') return;
  if (!v) {
    await Promise.all([
      upgradeText(CONTAINER.claim, NAME.claim, ''),
      upgradeText(CONTAINER.verdict, NAME.verdict, ''),
      upgradeText(CONTAINER.reason, NAME.reason, ''),
    ]);
    return;
  }
  const glyph = VERDICT_GLYPH[v.verdict] ?? v.verdict;
  // Claim wraps across 2 lines in the allocated 56 px height; constrain at
  // ~140 chars (safe for the chosen font; trim if longer). Reason is 2-3
  // short sentences (~240 chars).
  const claimLine = v.claim.length > 140 ? `${v.claim.slice(0, 137)}…` : v.claim;
  const reasonBlock = v.reason.length > 240 ? `${v.reason.slice(0, 237)}…` : v.reason;
  await Promise.all([
    upgradeText(CONTAINER.claim, NAME.claim, claimLine),
    upgradeText(CONTAINER.verdict, NAME.verdict, glyph),
    upgradeText(CONTAINER.reason, NAME.reason, reasonBlock),
  ]);
}

/** Toggle the recording indicator in the bottom-right of the active page. */
export async function setRecIndicator(on: boolean): Promise<void> {
  if (currentPage !== 'active') return;
  await upgradeText(CONTAINER.recIndicator, NAME.recIndicator, on ? '● REC' : '');
}

async function upgradeText(containerID: number, containerName: string, content: string): Promise<void> {
  const upgrade = new TextContainerUpgrade({
    containerID,
    containerName,
    contentOffset: 0,
    contentLength: content.length,
    content,
  });
  await getBridge().textContainerUpgrade(upgrade);
}

// ------- page builders ----------------------------------------------------

function buildUnconfiguredPage(mode: 'create' | 'rebuild'): CreateStartUpPageContainer | RebuildPageContainer {
  // Use the full canvas: title near the top, message in the middle,
  // event-sink near the bottom. Each text container is given generous
  // vertical room so the SDK has space to center the glyphs.
  const title = new TextContainerProperty({
    containerID: CONTAINER.title,
    containerName: NAME.title,
    xPosition: 16,
    yPosition: 32,
    width: SCREEN_W - 32,
    height: 40,
    borderWidth: 0,
    paddingLength: 4,
    content: 'VeritasLens',
    isEventCapture: 0,
  });

  const msg = new TextContainerProperty({
    containerID: CONTAINER.pickerHint,
    containerName: 'vl-msg',
    xPosition: 16,
    yPosition: 96,
    width: SCREEN_W - 32,
    height: 88,
    borderWidth: 0,
    paddingLength: 4,
    content: 'Configure on your phone to begin. Add your Gemini API key from the app menu.',
    isEventCapture: 0,
  });

  // Single-item list acts as the event sink so any user input is routed
  // here cleanly. Full width and generous height for a clean render.
  const sink = new ListContainerProperty({
    containerID: CONTAINER.pickerList,
    containerName: NAME.pickerList,
    xPosition: 16,
    yPosition: 216,
    width: SCREEN_W - 32,
    height: 40,
    borderWidth: 0,
    paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: 1,
      itemWidth: SCREEN_W - 48,
      isItemSelectBorderEn: 0,
      itemName: ['Waiting for API key…'],
    }),
    isEventCapture: 1,
  });

  const Ctor = mode === 'create' ? CreateStartUpPageContainer : RebuildPageContainer;
  return new Ctor({
    containerTotalNum: 3,
    listObject: [sink],
    textObject: [title, msg],
  });
}

function buildPickerPage(mode: 'create' | 'rebuild'): CreateStartUpPageContainer | RebuildPageContainer {
  const title = new TextContainerProperty({
    containerID: CONTAINER.title,
    containerName: NAME.title,
    xPosition: 16,
    yPosition: 32,
    width: SCREEN_W - 32,
    height: 36,
    borderWidth: 0,
    paddingLength: 4,
    content: 'Pick a lens',
    isEventCapture: 0,
  });

  const currentPersonas = getPersonas();
  // Borderless: highlight ring around the selected item is enough structure.
  const list = new ListContainerProperty({
    containerID: CONTAINER.pickerList,
    containerName: NAME.pickerList,
    xPosition: 16,
    yPosition: 88,
    width: SCREEN_W - 32,
    height: 120,
    borderWidth: 0,
    paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: currentPersonas.length,
      itemWidth: SCREEN_W - 48,
      isItemSelectBorderEn: 1,
      itemName: currentPersonas.map((p) => p.name),
    }),
    isEventCapture: 1,
  });

  const hint = new TextContainerProperty({
    containerID: CONTAINER.pickerHint,
    containerName: NAME.pickerHint,
    xPosition: 16,
    yPosition: 224,
    width: SCREEN_W - 32,
    height: 40,
    borderWidth: 0,
    paddingLength: 4,
    content: currentPersonas.length > 1 ? 'Swipe ⇅ · Tap to start' : 'Tap to start',
    isEventCapture: 0,
  });

  const Ctor = mode === 'create' ? CreateStartUpPageContainer : RebuildPageContainer;
  return new Ctor({
    containerTotalNum: 3,
    listObject: [list],
    textObject: [title, hint],
  });
}

function buildMenuPage(): RebuildPageContainer {
  const title = new TextContainerProperty({
    containerID: CONTAINER.title,
    containerName: NAME.title,
    xPosition: 16,
    yPosition: 32,
    width: SCREEN_W - 32,
    height: 36,
    borderWidth: 0,
    paddingLength: 4,
    content: 'Menu',
    isEventCapture: 0,
  });

  const list = new ListContainerProperty({
    containerID: CONTAINER.menuList,
    containerName: NAME.menuList,
    xPosition: 16,
    yPosition: 88,
    width: SCREEN_W - 32,
    height: 120,
    borderWidth: 0,
    paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: MENU_OPTIONS.length,
      itemWidth: SCREEN_W - 48,
      isItemSelectBorderEn: 1,
      itemName: MENU_OPTIONS.map((o) => o.label),
    }),
    isEventCapture: 1,
  });

  const hint = new TextContainerProperty({
    containerID: CONTAINER.pickerHint,
    containerName: NAME.pickerHint,
    xPosition: 16,
    yPosition: 224,
    width: SCREEN_W - 32,
    height: 40,
    borderWidth: 0,
    paddingLength: 4,
    content: 'Swipe ⇅ · Tap to confirm',
    isEventCapture: 0,
  });

  return new RebuildPageContainer({
    containerTotalNum: 3,
    listObject: [list],
    textObject: [title, hint],
  });
}

function buildActivePage(persona: Persona): RebuildPageContainer {
  // Top row: claim on the left, REC + status on the right (stacked indicators).
  const rec = new TextContainerProperty({
    containerID: CONTAINER.recIndicator,
    containerName: NAME.recIndicator,
    xPosition: SCREEN_W - 92,
    yPosition: 32,
    width: 76,
    height: 28,
    borderWidth: 0,
    paddingLength: 4,
    content: '● REC',
    isEventCapture: 0,
  });

  const status = new TextContainerProperty({
    containerID: CONTAINER.status,
    containerName: NAME.status,
    xPosition: SCREEN_W - 92,
    yPosition: 64,
    width: 76,
    height: 28,
    borderWidth: 0,
    paddingLength: 4,
    content: STATUS_LABEL.listening,
    isEventCapture: 0,
  });

  // Question line (one sentence). Two-line wrap zone.
  const claim = new TextContainerProperty({
    containerID: CONTAINER.claim,
    containerName: NAME.claim,
    xPosition: 16,
    yPosition: 32,
    width: SCREEN_W - 116, // room for the REC/status stack on the right
    height: 60,
    borderWidth: 0,
    paddingLength: 4,
    content: '',
    isEventCapture: 0,
  });

  const verdict = new TextContainerProperty({
    containerID: CONTAINER.verdict,
    containerName: NAME.verdict,
    xPosition: 16,
    yPosition: 104,
    width: SCREEN_W - 32,
    height: 36,
    borderWidth: 0,
    paddingLength: 4,
    content: '',
    isEventCapture: 0,
  });

  // 2-3 short sentences.
  const reason = new TextContainerProperty({
    containerID: CONTAINER.reason,
    containerName: NAME.reason,
    xPosition: 16,
    yPosition: 148,
    width: SCREEN_W - 32,
    height: 64,
    borderWidth: 0,
    paddingLength: 4,
    content: '',
    isEventCapture: 0,
  });

  // Bottom strip: full-width event-capturing list with the gesture hint.
  const eventList = new ListContainerProperty({
    containerID: CONTAINER.activeList,
    containerName: NAME.activeList,
    xPosition: 16,
    yPosition: 224,
    width: SCREEN_W - 32,
    height: 40,
    borderWidth: 0,
    paddingLength: 4,
    itemContainer: new ListItemContainerProperty({
      itemCount: 1,
      itemWidth: SCREEN_W - 48,
      isItemSelectBorderEn: 0,
      itemName: ['Tap: menu · Double-tap: fact-check'],
    }),
    isEventCapture: 1,
  });
  void persona;

  return new RebuildPageContainer({
    containerTotalNum: 6,
    listObject: [eventList],
    textObject: [status, claim, verdict, reason, rec],
  });
}

export function _resetHudBootstrapForTesting(): void {
  bootstrapped = false;
  currentPage = 'none';
  menuPersona = null;
}
