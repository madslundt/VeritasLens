// src/state/store.ts
import { createSignal } from 'solid-js';
import type { DeviceStatus } from '@evenrealities/even_hub_sdk';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_AUTO_MODEL,
  DEFAULT_LANGUAGE,
  DEFAULT_BUFFER_DURATION,
  DEFAULT_AUTO_SUMMARY_INTERVAL,
  LANGUAGES,
  type AppMode,
  type AppPhase,
  type AutoSummaryInterval,
  type BufferDuration,
  type GeminiModel,
  type HistoryEntry,
  type LanguageCode,
  type LensResult,
  type Settings,
} from '@/types';

const SETTINGS_KEY_GEMINI = 'veritaslens.geminiKey';
const SETTINGS_KEY_MODEL = 'veritaslens.geminiModel';
const SETTINGS_KEY_AUTO_MODEL = 'veritaslens.geminiAutoModel';
const SETTINGS_KEY_LANGUAGE = 'veritaslens.responseLanguage';
const SETTINGS_KEY_BUFFER_DURATION = 'veritaslens.bufferDuration';
const SETTINGS_KEY_AUTO_SUMMARY_ENABLED = 'veritaslens.autoSummaryEnabled';
const SETTINGS_KEY_AUTO_SUMMARY_INTERVAL = 'veritaslens.autoSummaryInterval';

const HISTORY_KEY = 'veritaslens.history';
const HISTORY_BYTE_BUDGET = 200 * 1024;
const HISTORY_MAX_ENTRIES = 500;

export const [appMode, setAppMode] = createSignal<AppMode>('settings');
export const [appPhase, setAppPhase] = createSignal<AppPhase>('booting');
export const [availableModels, setAvailableModels] = createSignal<string[]>([DEFAULT_GEMINI_MODEL]);
export const [modelsLoading, setModelsLoading] = createSignal<boolean>(false);
export const [activePersona, setActivePersona] = createSignal<string>('fact-checker');
export const [lensResult, setLensResult] = createSignal<LensResult | null>(null);
export const [deviceStatus, setDeviceStatus] = createSignal<DeviceStatus | null>(null);
export const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
export const [sessionHistory, setSessionHistory] = createSignal<HistoryEntry[]>([]);

const [settings, setSettings] = createSignal<Settings>({
  geminiApiKey: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  geminiAutoModel: DEFAULT_GEMINI_AUTO_MODEL,
  responseLanguage: DEFAULT_LANGUAGE,
  bufferDuration: DEFAULT_BUFFER_DURATION,
  autoSummaryEnabled: false,
  autoSummaryInterval: DEFAULT_AUTO_SUMMARY_INTERVAL,
});
export { settings };

export async function loadSettings(getLocalStorage: (k: string) => Promise<string>): Promise<void> {
  // Read each key independently so a single failed/corrupt entry doesn't wipe
  // the rest. The coerce* helpers already tolerate null / unknown values.
  const safeGet = async (k: string): Promise<string> => {
    try { return await getLocalStorage(k); } catch { return ''; }
  };
  const [key, rawModel, rawAutoModel, rawLang, rawBuffer, rawAutoEnabled, rawAutoInterval] = await Promise.all([
    safeGet(SETTINGS_KEY_GEMINI),
    safeGet(SETTINGS_KEY_MODEL),
    safeGet(SETTINGS_KEY_AUTO_MODEL),
    safeGet(SETTINGS_KEY_LANGUAGE),
    safeGet(SETTINGS_KEY_BUFFER_DURATION),
    safeGet(SETTINGS_KEY_AUTO_SUMMARY_ENABLED),
    safeGet(SETTINGS_KEY_AUTO_SUMMARY_INTERVAL),
  ]);
  setSettings({
    geminiApiKey: key,
    geminiModel: coerceModel(rawModel),
    geminiAutoModel: coerceAutoModel(rawAutoModel),
    responseLanguage: coerceLanguage(rawLang),
    bufferDuration: coerceBufferDuration(rawBuffer),
    autoSummaryEnabled: rawAutoEnabled === 'true',
    autoSummaryInterval: coerceAutoSummaryInterval(rawAutoInterval),
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

export const saveGeminiKey = (setLs: SetLs, key: string): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_GEMINI, 'geminiApiKey', key);

export const saveGeminiModel = (setLs: SetLs, model: GeminiModel): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_MODEL, 'geminiModel', model);

export const saveGeminiAutoModel = (setLs: SetLs, model: GeminiModel): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_AUTO_MODEL, 'geminiAutoModel', model);

export const saveResponseLanguage = (setLs: SetLs, language: LanguageCode): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_LANGUAGE, 'responseLanguage', language);

export const saveBufferDuration = (setLs: SetLs, duration: BufferDuration): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_BUFFER_DURATION, 'bufferDuration', duration);

export const saveAutoSummaryEnabled = (setLs: SetLs, enabled: boolean): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_AUTO_SUMMARY_ENABLED, 'autoSummaryEnabled', enabled);

export const saveAutoSummaryInterval = (setLs: SetLs, interval: AutoSummaryInterval): Promise<boolean> =>
  saveSetting(setLs, SETTINGS_KEY_AUTO_SUMMARY_INTERVAL, 'autoSummaryInterval', interval);

export async function loadHistory(getLocalStorage: (k: string) => Promise<string>): Promise<void> {
  try {
    const raw = await getLocalStorage(HISTORY_KEY);
    if (!raw) return;
    const entries: HistoryEntry[] = JSON.parse(raw);
    if (Array.isArray(entries)) setSessionHistory(entries);
  } catch {
    // corrupt or missing — start fresh
  }
}

async function persistHistory(
  setLs: (k: string, v: string) => Promise<boolean>,
  entries: HistoryEntry[]
): Promise<void> {
  let json = JSON.stringify(entries);
  if (json.length > HISTORY_BYTE_BUDGET && entries.length > 0) {
    // Estimate the surviving tail length from the size ratio, then linearly
    // fine-tune by chunks of 10 % to absorb estimation error. This keeps trim
    // work effectively O(log n) on the byte count instead of O(n) re-stringifies.
    const ratio = HISTORY_BYTE_BUDGET / json.length;
    let keep = Math.max(1, Math.floor(entries.length * ratio * 0.9));
    let trimmed = entries.slice(-keep);
    json = JSON.stringify(trimmed);
    while (json.length > HISTORY_BYTE_BUDGET && trimmed.length > 1) {
      keep = Math.max(1, Math.floor(trimmed.length * 0.9));
      trimmed = trimmed.slice(-keep);
      json = JSON.stringify(trimmed);
    }
  }
  await setLs(HISTORY_KEY, json);
}

/** Push a completed analysis result into session history and persist it. */
export function pushHistoryEntry(
  entry: Omit<HistoryEntry, 'id' | 'timestamp'>,
  setLs?: (k: string, v: string) => Promise<boolean>
): void {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const next: HistoryEntry[] = [
    ...sessionHistory(),
    { id, timestamp: Date.now(), ...entry },
  ].slice(-HISTORY_MAX_ENTRIES);
  setSessionHistory(next);
  if (setLs) void persistHistory(setLs, next);
}

export function clearSessionHistory(setLs?: (k: string, v: string) => Promise<boolean>): void {
  setSessionHistory([]);
  if (setLs) void setLs(HISTORY_KEY, '[]');
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
  if (n === 30 || n === 120 || n === 300 || n === 600) return n;
  return DEFAULT_BUFFER_DURATION;
}

function coerceAutoSummaryInterval(raw: string | null | undefined): AutoSummaryInterval {
  const n = Number(raw);
  if (n === 1 || n === 2 || n === 5) return n;
  return DEFAULT_AUTO_SUMMARY_INTERVAL;
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
