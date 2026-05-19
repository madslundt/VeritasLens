// src/state/store.ts
import { createSignal } from 'solid-js';
import type { DeviceStatus } from '@evenrealities/even_hub_sdk';
import {
  DEFAULT_GEMINI_MODEL,
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
const SETTINGS_KEY_LANGUAGE = 'veritaslens.responseLanguage';
const SETTINGS_KEY_BUFFER_DURATION = 'veritaslens.bufferDuration';
const SETTINGS_KEY_AUTO_SUMMARY_ENABLED = 'veritaslens.autoSummaryEnabled';
const SETTINGS_KEY_AUTO_SUMMARY_INTERVAL = 'veritaslens.autoSummaryInterval';

const HISTORY_KEY = 'veritaslens.history';
const HISTORY_BYTE_BUDGET = 200 * 1024;

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
  responseLanguage: DEFAULT_LANGUAGE,
  bufferDuration: DEFAULT_BUFFER_DURATION,
  autoSummaryEnabled: false,
  autoSummaryInterval: DEFAULT_AUTO_SUMMARY_INTERVAL,
});
export { settings };

export async function loadSettings(getLocalStorage: (k: string) => Promise<string>): Promise<void> {
  try {
    const [key, rawModel, rawLang, rawBuffer, rawAutoEnabled, rawAutoInterval] = await Promise.all([
      getLocalStorage(SETTINGS_KEY_GEMINI),
      getLocalStorage(SETTINGS_KEY_MODEL),
      getLocalStorage(SETTINGS_KEY_LANGUAGE),
      getLocalStorage(SETTINGS_KEY_BUFFER_DURATION),
      getLocalStorage(SETTINGS_KEY_AUTO_SUMMARY_ENABLED),
      getLocalStorage(SETTINGS_KEY_AUTO_SUMMARY_INTERVAL),
    ]);
    setSettings({
      geminiApiKey: key ?? '',
      geminiModel: coerceModel(rawModel),
      responseLanguage: coerceLanguage(rawLang),
      bufferDuration: coerceBufferDuration(rawBuffer),
      autoSummaryEnabled: rawAutoEnabled === 'true',
      autoSummaryInterval: coerceAutoSummaryInterval(rawAutoInterval),
    });
  } catch {
    setSettings({
      geminiApiKey: '',
      geminiModel: DEFAULT_GEMINI_MODEL,
      responseLanguage: DEFAULT_LANGUAGE,
      bufferDuration: DEFAULT_BUFFER_DURATION,
      autoSummaryEnabled: false,
      autoSummaryInterval: DEFAULT_AUTO_SUMMARY_INTERVAL,
    });
  }
}

export async function saveGeminiKey(setLs: (k: string, v: string) => Promise<boolean>, key: string): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_GEMINI, key);
  if (ok) setSettings({ ...settings(), geminiApiKey: key });
  return ok;
}

export async function saveGeminiModel(setLs: (k: string, v: string) => Promise<boolean>, model: GeminiModel): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_MODEL, model);
  if (ok) setSettings({ ...settings(), geminiModel: model });
  return ok;
}

export async function saveResponseLanguage(setLs: (k: string, v: string) => Promise<boolean>, language: LanguageCode): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_LANGUAGE, language);
  if (ok) setSettings({ ...settings(), responseLanguage: language });
  return ok;
}

export async function saveBufferDuration(setLs: (k: string, v: string) => Promise<boolean>, duration: BufferDuration): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_BUFFER_DURATION, String(duration));
  if (ok) setSettings({ ...settings(), bufferDuration: duration });
  return ok;
}

export async function saveAutoSummaryEnabled(setLs: (k: string, v: string) => Promise<boolean>, enabled: boolean): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_AUTO_SUMMARY_ENABLED, String(enabled));
  if (ok) setSettings({ ...settings(), autoSummaryEnabled: enabled });
  return ok;
}

export async function saveAutoSummaryInterval(setLs: (k: string, v: string) => Promise<boolean>, interval: AutoSummaryInterval): Promise<boolean> {
  const ok = await setLs(SETTINGS_KEY_AUTO_SUMMARY_INTERVAL, String(interval));
  if (ok) setSettings({ ...settings(), autoSummaryInterval: interval });
  return ok;
}

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
  let trimmed = [...entries];
  let json = JSON.stringify(trimmed);
  while (json.length > HISTORY_BYTE_BUDGET && trimmed.length > 0) {
    trimmed = trimmed.slice(1);
    json = JSON.stringify(trimmed);
  }
  await setLs(HISTORY_KEY, json);
}

/** Push a completed analysis result into session history and persist it. */
export function pushHistoryEntry(
  entry: Omit<HistoryEntry, 'id' | 'timestamp'>,
  setLs?: (k: string, v: string) => Promise<boolean>
): void {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const next: HistoryEntry[] = [...sessionHistory(), { id, timestamp: Date.now(), ...entry }];
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
