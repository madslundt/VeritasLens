// src/state/store.ts
import { createSignal } from 'solid-js';
import type { DeviceStatus } from '@evenrealities/even_hub_sdk';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_AUTO_MODEL,
  DEFAULT_LANGUAGE,
  DEFAULT_BUFFER_DURATION,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  LANGUAGES,
  OPENAI_BASE_URLS,
  type AppMode,
  type AppPhase,
  type BufferDuration,
  type GeminiModel,
  type HistoryEntry,
  type LanguageCode,
  type LensResult,
  type LlmProvider,
  type MeetingPrepSection,
  type OpenAiBaseUrl,
  type Settings,
} from '@/types';

const SETTINGS_KEY_PROVIDER = 'veritaslens.provider';
const SETTINGS_KEY_GEMINI = 'veritaslens.geminiKey';
const SETTINGS_KEY_MODEL = 'veritaslens.geminiModel';
const SETTINGS_KEY_AUTO_MODEL = 'veritaslens.geminiAutoModel';
const SETTINGS_KEY_OPENAI_KEY = 'veritaslens.openaiKey';
const SETTINGS_KEY_OPENAI_BASE_URL = 'veritaslens.openaiBaseUrl';
const SETTINGS_KEY_OPENAI_MODEL = 'veritaslens.openaiModel';
const SETTINGS_KEY_LANGUAGE = 'veritaslens.responseLanguage';
const SETTINGS_KEY_BUFFER_DURATION = 'veritaslens.bufferDuration';
const SETTINGS_KEY_AUTO_SUMMARY_ENABLED = 'veritaslens.autoSummaryEnabled';
const SETTINGS_KEY_DISCREET = 'veritaslens.discreet';

const HISTORY_KEY = 'veritaslens.history';
const HISTORY_BYTE_BUDGET = 400 * 1024;
const HISTORY_MAX_ENTRIES = 500;

const MEETING_PREP_KEY = 'veritaslens.meetingPrep';
/** Total UTF-8 byte cap for the meeting-prep payload (label+body across all sections). */
export const MEETING_PREP_BYTE_BUDGET = 50 * 1024;
/** Per-label character cap, applied at write time. */
export const MEETING_PREP_LABEL_MAX = 80;

export const [appMode, setAppMode] = createSignal<AppMode>('settings');
export const [appPhase, setAppPhase] = createSignal<AppPhase>('booting');
export const [availableModels, setAvailableModels] = createSignal<string[]>([DEFAULT_GEMINI_MODEL]);
export const [modelsLoading, setModelsLoading] = createSignal<boolean>(false);
export const [activePersona, setActivePersona] = createSignal<string>('fact-checker');
export const [lensResult, setLensResult] = createSignal<LensResult | null>(null);
export const [deviceStatus, setDeviceStatus] = createSignal<DeviceStatus | null>(null);
export const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
export const [sessionHistory, setSessionHistory] = createSignal<HistoryEntry[]>([]);
export const [meetingPrepSections, setMeetingPrepSectionsSignal] = createSignal<MeetingPrepSection[]>([]);

const [settings, setSettings] = createSignal<Settings>({
  provider: DEFAULT_LLM_PROVIDER,
  geminiApiKey: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  geminiAutoModel: DEFAULT_GEMINI_AUTO_MODEL,
  openaiApiKey: '',
  openaiBaseUrl: DEFAULT_OPENAI_BASE_URL,
  openaiModel: DEFAULT_OPENAI_MODEL,
  responseLanguage: DEFAULT_LANGUAGE,
  bufferDuration: DEFAULT_BUFFER_DURATION,
  autoSummaryEnabled: false,
  discreet: false,
});
export { settings };

export async function loadSettings(getLocalStorage: (k: string) => Promise<string>): Promise<void> {
  // Read each key independently so a single failed/corrupt entry doesn't wipe
  // the rest. The coerce* helpers already tolerate null / unknown values.
  const safeGet = async (k: string): Promise<string> => {
    try { return await getLocalStorage(k); } catch { return ''; }
  };
  const [
    rawProvider,
    key,
    rawModel,
    rawAutoModel,
    rawOpenaiKey,
    rawOpenaiBaseUrl,
    rawOpenaiModel,
    rawLang,
    rawBuffer,
    rawAutoEnabled,
    rawDiscreet,
  ] = await Promise.all([
    safeGet(SETTINGS_KEY_PROVIDER),
    safeGet(SETTINGS_KEY_GEMINI),
    safeGet(SETTINGS_KEY_MODEL),
    safeGet(SETTINGS_KEY_AUTO_MODEL),
    safeGet(SETTINGS_KEY_OPENAI_KEY),
    safeGet(SETTINGS_KEY_OPENAI_BASE_URL),
    safeGet(SETTINGS_KEY_OPENAI_MODEL),
    safeGet(SETTINGS_KEY_LANGUAGE),
    safeGet(SETTINGS_KEY_BUFFER_DURATION),
    safeGet(SETTINGS_KEY_AUTO_SUMMARY_ENABLED),
    safeGet(SETTINGS_KEY_DISCREET),
  ]);
  setSettings({
    provider: coerceProvider(rawProvider),
    geminiApiKey: key,
    geminiModel: coerceModel(rawModel),
    geminiAutoModel: coerceAutoModel(rawAutoModel),
    openaiApiKey: rawOpenaiKey,
    openaiBaseUrl: coerceOpenaiBaseUrl(rawOpenaiBaseUrl),
    openaiModel: rawOpenaiModel || DEFAULT_OPENAI_MODEL,
    responseLanguage: coerceLanguage(rawLang),
    bufferDuration: coerceBufferDuration(rawBuffer),
    autoSummaryEnabled: rawAutoEnabled === 'true',
    discreet: rawDiscreet === 'true',
  });
}

type SetLs = (k: string, v: string) => Promise<boolean>;

async function saveSetting<K extends keyof Settings>(
  setLs: SetLs,
  storageKey: string,
  field: K,
  value: Settings[K],
): Promise<boolean> {
  const ok = await setLs(storageKey, String(value));
  if (ok) setSettings({ ...settings(), [field]: value });
  return ok;
}

export const saveProvider = (setLs: SetLs, provider: LlmProvider): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_PROVIDER, 'provider', provider);

export const saveGeminiKey = (setLs: SetLs, key: string): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_GEMINI, 'geminiApiKey', key);

export const saveGeminiModel = (setLs: SetLs, model: GeminiModel): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_MODEL, 'geminiModel', model);

export const saveGeminiAutoModel = (setLs: SetLs, model: GeminiModel): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_AUTO_MODEL, 'geminiAutoModel', model);

export const saveOpenaiKey = (setLs: SetLs, key: string): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_OPENAI_KEY, 'openaiApiKey', key);

export const saveOpenaiBaseUrl = (setLs: SetLs, url: OpenAiBaseUrl): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_OPENAI_BASE_URL, 'openaiBaseUrl', url);

export const saveOpenaiModel = (setLs: SetLs, model: string): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_OPENAI_MODEL, 'openaiModel', model);

export const saveResponseLanguage = (setLs: SetLs, language: LanguageCode): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_LANGUAGE, 'responseLanguage', language);

export const saveBufferDuration = (setLs: SetLs, duration: BufferDuration): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_BUFFER_DURATION, 'bufferDuration', duration);

export const saveAutoSummaryEnabled = (setLs: SetLs, enabled: boolean): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_AUTO_SUMMARY_ENABLED, 'autoSummaryEnabled', enabled);

export const saveDiscreet = (setLs: SetLs, discreet: boolean): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_DISCREET, 'discreet', discreet);

export async function loadHistory(getLocalStorage: (k: string) => Promise<string>): Promise<void> {
  try {
    const raw = await getLocalStorage(HISTORY_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const migrated: HistoryEntry[] = [];
    for (const entry of parsed) {
      const ok = migrateEntry(entry);
      if (ok) migrated.push(ok);
    }
    setSessionHistory(migrated);
  } catch (err) {
    // corrupt or missing — start fresh, but surface the failure in the debug
    // log so a wedged KV (or a JSON.parse exception on user data) is visible
    // in the settings debug panel rather than silently dropping all history.
    pushDebugEvent({
      label: 'history-load-fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Migrate a persisted history entry to the multi-claim shape. Older builds
 * stored claim-shaped lens results flat (e.g. fact-check had top-level
 * verdict/claim/reason); wrap them into a single-element `claims` array with
 * an empty `quote`. Answer-shaped results gain an optional `quote` field —
 * fill missing values with ''. Entries that can't be migrated are dropped.
 */
function migrateEntry(raw: unknown): HistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const result = e['result'];
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const type = r['type'];
  if (typeof type !== 'string') return null;

  const wrap = (item: Record<string, unknown>): unknown[] => [{ quote: '', ...item }];

  let migratedResult: Record<string, unknown> | null = null;
  switch (type) {
    case 'fact-check':
      migratedResult = Array.isArray(r['claims'])
        ? r
        : { type, claims: wrap({ verdict: r['verdict'], claim: r['claim'], reason: r['reason'] }), autoSelected: r['autoSelected'] };
      break;
    case 'stats-check':
      migratedResult = Array.isArray(r['claims'])
        ? r
        : { type, claims: wrap({ verdict: r['verdict'], stat: r['stat'], reason: r['reason'] }), autoSelected: r['autoSelected'] };
      break;
    case 'logical-fallacy':
      migratedResult = Array.isArray(r['claims'])
        ? r
        : { type, claims: wrap({ fallacy: r['fallacy'], explanation: r['explanation'] }), autoSelected: r['autoSelected'] };
      break;
    case 'bias':
      migratedResult = Array.isArray(r['claims'])
        ? r
        : { type, claims: wrap({ verdict: r['verdict'], direction: r['direction'], reason: r['reason'] }), autoSelected: r['autoSelected'] };
      break;
    case 'trivia':
      migratedResult = Array.isArray(r['claims'])
        ? r
        : { type, claims: wrap({ question: r['question'], answer: r['answer'], description: r['description'] }), autoSelected: r['autoSelected'] };
      break;
    case 'eli5':
      migratedResult = Array.isArray(r['claims'])
        ? r
        : { type, claims: wrap({ explanation: r['explanation'] }), autoSelected: r['autoSelected'] };
      break;
    case 'session-summary': {
      const existingTitle = typeof r['title'] === 'string' ? r['title'].trim() : '';
      migratedResult = { quote: '', ...r, title: existingTitle.length > 0 ? existingTitle : 'Summary of conversation' };
      break;
    }
    case 'meeting-prep':
      // No legacy shape exists for meeting-prep; require the claims array.
      if (!Array.isArray(r['claims'])) return null;
      migratedResult = r;
      break;
    default:
      return null;
  }

  return {
    id: String(e['id'] ?? `${Date.now()}-mig`),
    sessionId: String(e['sessionId'] ?? ''),
    timestamp: typeof e['timestamp'] === 'number' ? e['timestamp'] : Date.now(),
    lensId: String(e['lensId'] ?? ''),
    lensName: String(e['lensName'] ?? ''),
    question: String(e['question'] ?? ''),
    badge: String(e['badge'] ?? ''),
    quote: typeof e['quote'] === 'string' ? e['quote'] : '',
    result: migratedResult as HistoryEntry['result'],
  };
}

async function persistHistory(
  setLs: (k: string, v: string) => Promise<boolean>,
  entries: HistoryEntry[]
): Promise<void> {
  let json = JSON.stringify(entries);
  // Compare against UTF-8 byte length, not `.length` (UTF-16 code units), so
  // non-ASCII summaries (Dansk, Norsk, Deutsch) can't sneak past the cap —
  // some characters cost 2-3 bytes but only one code unit each.
  let bytes = utf8ByteLength(json);
  if (bytes > HISTORY_BYTE_BUDGET && entries.length > 0) {
    // Two-shot trim, total ≤3 stringify calls per persist write:
    //   call 1: full entries (above)
    //   call 2: ratio-based estimate using avg bytes/entry of the full list
    //   call 3: if still over, re-estimate from the trimmed list's actual
    //           avg (tail entries can be larger than the full-list avg)
    // A 0.85 safety factor on each pass absorbs estimation error from
    // uneven entry sizes; a single-entry-over-budget is preserved as-is
    // (losing it would discard the answer the user just received).
    const SAFETY = 0.85;
    const estimateKeep = (totalBytes: number, count: number): number => {
      const avg = totalBytes / count;
      return Math.max(1, Math.floor((HISTORY_BYTE_BUDGET / avg) * SAFETY));
    };
    let keep = estimateKeep(bytes, entries.length);
    let trimmed = entries.slice(-keep);
    json = JSON.stringify(trimmed);
    bytes = utf8ByteLength(json);
    if (bytes > HISTORY_BYTE_BUDGET && trimmed.length > 1) {
      const next = estimateKeep(bytes, trimmed.length);
      // Ensure forward progress even if the new estimate ≥ current length
      // (can happen on extreme tail-skew where avg jumps each pass).
      keep = Math.max(1, Math.min(next, trimmed.length - 1));
      trimmed = trimmed.slice(-keep);
      json = JSON.stringify(trimmed);
      bytes = utf8ByteLength(json);
    }
    if (bytes > HISTORY_BYTE_BUDGET) {
      pushDebugEvent({
        label: 'history-oversized-entry',
        detail: `single entry ${Math.round(bytes / 1024)}KB exceeds ${Math.round(HISTORY_BYTE_BUDGET / 1024)}KB cap`,
      });
    }
  }
  await setLs(HISTORY_KEY, json);
}

/**
 * Push a completed analysis result into session history and persist it.
 * Returns a promise that resolves once persistence is done, so callers that
 * need to reload history from storage (e.g. to surface entries written by a
 * sibling WebView context) can await the write first.
 */
export async function pushHistoryEntry(
  entry: Omit<HistoryEntry, 'id' | 'timestamp'>,
  setLs?: (k: string, v: string) => Promise<boolean>
): Promise<string> {
  const [id] = await pushHistoryEntries([entry], setLs);
  return id ?? '';
}

/**
 * Atomically append several entries in one read-modify-write of the signal
 * and one persistHistory call. Lets multi-claim analyses persist N entries
 * without N racing local-storage writes — out-of-order resolves between
 * concurrent persist calls would otherwise let an earlier (shorter) write
 * overwrite a later (complete) one and silently drop claims.
 *
 * Returns the ids of the just-pushed entries in input order. Callers use
 * these to identify which entries belong to the latest analysis (for the
 * session-wide swipe scroll's latestAnalysisRange).
 */
export async function pushHistoryEntries(
  entries: Array<Omit<HistoryEntry, 'id' | 'timestamp'>>,
  setLs?: (k: string, v: string) => Promise<boolean>
): Promise<string[]> {
  if (entries.length === 0) return [];
  const ts = Date.now();
  const fresh: HistoryEntry[] = entries.map((e, i) => ({
    id: `${ts}-${i}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: ts,
    ...e,
  }));
  const next: HistoryEntry[] = [...sessionHistory(), ...fresh].slice(-HISTORY_MAX_ENTRIES);
  setSessionHistory(next);
  if (setLs) await persistHistory(setLs, next);
  return fresh.map((e) => e.id);
}

export function clearSessionHistory(setLs?: (k: string, v: string) => Promise<boolean>): void {
  setSessionHistory([]);
  if (setLs) void setLs(HISTORY_KEY, '[]');
}

/**
 * Drop every history entry sharing `sessionId` and persist the trimmed list.
 * Re-uses `persistHistory` so the byte-budget logic stays applied (a delete
 * followed by another append still settles inside the cap).
 */
export async function deleteHistorySession(
  sessionId: string,
  setLs?: (k: string, v: string) => Promise<boolean>,
): Promise<void> {
  const next = sessionHistory().filter((e) => e.sessionId !== sessionId);
  setSessionHistory(next);
  if (setLs) await persistHistory(setLs, next);
}

function coerceModel(raw: string | null | undefined): GeminiModel {
  if (raw && raw.startsWith('gemini-')) return raw as GeminiModel;
  return DEFAULT_GEMINI_MODEL;
}

function coerceAutoModel(raw: string | null | undefined): GeminiModel {
  if (raw && raw.startsWith('gemini-')) return raw as GeminiModel;
  return DEFAULT_GEMINI_AUTO_MODEL;
}

function coerceLanguage(raw: string | null | undefined): LanguageCode {
  if (raw && raw in LANGUAGES) return raw as LanguageCode;
  return DEFAULT_LANGUAGE;
}

function coerceBufferDuration(raw: string | null | undefined): BufferDuration {
  const n = Number(raw);
  if (n === 30 || n === 120 || n === 300) return n;
  // Back-compat: 0.6.x persisted 600 (10 min); clamp to the new 5-min cap.
  if (n === 600) return 300;
  return DEFAULT_BUFFER_DURATION;
}

function coerceProvider(raw: string | null | undefined): LlmProvider {
  if (raw === 'gemini' || raw === 'openai-compatible') return raw;
  return DEFAULT_LLM_PROVIDER;
}

function coerceOpenaiBaseUrl(raw: string | null | undefined): OpenAiBaseUrl {
  if (raw && (OPENAI_BASE_URLS as readonly string[]).includes(raw)) {
    return raw as OpenAiBaseUrl;
  }
  return DEFAULT_OPENAI_BASE_URL;
}

// ---------- Meeting Prep context ----------

/**
 * Load the persisted meeting-prep sections. Tolerates a missing or corrupt
 * blob — falls back to an empty list rather than throwing.
 */
export async function loadMeetingPrepSections(
  getLocalStorage: (k: string) => Promise<string>,
): Promise<void> {
  try {
    const raw = await getLocalStorage(MEETING_PREP_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    // Older builds wrote sibling `goal` / `role` keys on this blob; those are
    // ignored here. Reading only `sections` keeps existing payloads working
    // without a migration step.
    const sectionsRaw = (parsed as Record<string, unknown>)['sections'];
    if (!Array.isArray(sectionsRaw)) return;
    const sections: MeetingPrepSection[] = [];
    for (const s of sectionsRaw) {
      if (!s || typeof s !== 'object') continue;
      const rec = s as Record<string, unknown>;
      const id = typeof rec['id'] === 'string' && rec['id'] ? rec['id'] : newSectionId();
      const label = typeof rec['label'] === 'string' ? rec['label'] : '';
      const body = typeof rec['body'] === 'string' ? rec['body'] : '';
      sections.push({ id, label, body });
    }
    setMeetingPrepSectionsSignal(sections);
  } catch (err) {
    // Same rationale as loadHistory above: surface the failure so a wedged KV
    // isn't an invisible blank-meeting-prep regression.
    pushDebugEvent({
      label: 'meeting-prep-load-fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Persist meeting-prep sections. Returns `{ ok }` and an error when the
 * payload exceeds the byte budget — the UI shows the message inline so the
 * user can shrink content rather than silently losing edits. Trims labels
 * to MEETING_PREP_LABEL_MAX on write.
 */
export async function saveMeetingPrepSections(
  setLs: SetLs,
  sections: MeetingPrepSection[],
): Promise<{ ok: boolean; error?: string }> {
  const normalized: MeetingPrepSection[] = sections.map((s, i) => ({
    id: s.id || newSectionId(),
    // Section 0 is the general-context slot — unlabeled by convention so it
    // never appears as a citable source. Force-clear any stale label that
    // might have been carried over from an older shape.
    label: i === 0 ? '' : s.label.slice(0, MEETING_PREP_LABEL_MAX),
    body: s.body,
  }));
  const payload = JSON.stringify({ sections: normalized });
  const bytes = utf8ByteLength(payload);
  if (bytes > MEETING_PREP_BYTE_BUDGET) {
    return {
      ok: false,
      error: `Too much text (${Math.round(bytes / 1024)} KB). Limit is ${Math.round(
        MEETING_PREP_BYTE_BUDGET / 1024,
      )} KB.`,
    };
  }
  const ok = await setLs(MEETING_PREP_KEY, payload);
  if (ok) setMeetingPrepSectionsSignal(normalized);
  return { ok };
}

/** True when at least one section has a non-empty body — required for the lens to run. */
export function meetingPrepIsConfigured(): boolean {
  return meetingPrepSections().some((s) => s.body.trim().length > 0);
}

/**
 * Total UTF-8 bytes that a given set of sections will occupy once persisted.
 * Mirrors the exact JSON shape used by saveMeetingPrepSections so the editor's
 * inline counter matches what the cap check will see on the next debounce.
 */
export function computeMeetingPrepBytes(sections: MeetingPrepSection[]): number {
  return utf8ByteLength(JSON.stringify({ sections }));
}

/** Total UTF-8 bytes of the current meeting-prep payload (used by the editor UI). */
export function meetingPrepUsedBytes(): number {
  return computeMeetingPrepBytes(meetingPrepSections());
}

export function newSectionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function utf8ByteLength(s: string): number {
  // Faster than encoder for short strings and avoids a TextEncoder dep in the
  // hot path of the autosave debounce.
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

// ---------- Debug event log ----------

export interface DebugEvent { ts: number; label: string; detail: string; }

export const [debugEvents, setDebugEvents] = createSignal<DebugEvent[]>([]);

export function pushDebugEvent(entry: Omit<DebugEvent, 'ts'>): void {
  setDebugEvents((prev) => [{ ts: Date.now(), ...entry }, ...prev].slice(0, 40));
}

export function clearDebugEvents(): void {
  setDebugEvents([]);
}
