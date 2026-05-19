import { createSignal } from 'solid-js';
import type { DeviceStatus } from '@evenrealities/even_hub_sdk';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_LANGUAGE,
  GEMINI_MODELS,
  LANGUAGES,
  type AppMode,
  type AppPhase,
  type GeminiModel,
  type LanguageCode,
  type Settings,
  type Verdict,
} from '@/types';
import {
  _setPersonas,
  builtinIds,
  getPersonas,
  makeCustomPersona,
  type CustomPersonaData,
  type PersonaId,
} from '@/personas';

/**
 * Global reactive state. We keep this intentionally flat and centralized:
 * the app is small enough that signal-per-concern beats a store-tree.
 */

const SETTINGS_KEY_GEMINI = 'veritaslens.geminiKey';
const SETTINGS_KEY_MODEL = 'veritaslens.geminiModel';
const SETTINGS_KEY_LANGUAGE = 'veritaslens.responseLanguage';
const SETTINGS_KEY_CUSTOM_PERSONAS = 'veritaslens.customPersonas';

export const [appMode, setAppMode] = createSignal<AppMode>('settings');
export const [appPhase, setAppPhase] = createSignal<AppPhase>('booting');
export const [activePersona, setActivePersona] = createSignal<PersonaId>('fact-checker');
export const [verdict, setVerdict] = createSignal<Verdict | null>(null);
export const [deviceStatus, setDeviceStatus] = createSignal<DeviceStatus | null>(null);
export const [errorMessage, setErrorMessage] = createSignal<string | null>(null);


const [settings, setSettings] = createSignal<Settings>({
  geminiApiKey: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  responseLanguage: DEFAULT_LANGUAGE,
});
export { settings };

export async function loadSettings(getLocalStorage: (k: string) => Promise<string>): Promise<void> {
  try {
    const [key, rawModel, rawLang] = await Promise.all([
      getLocalStorage(SETTINGS_KEY_GEMINI),
      getLocalStorage(SETTINGS_KEY_MODEL),
      getLocalStorage(SETTINGS_KEY_LANGUAGE),
    ]);
    setSettings({
      geminiApiKey: key ?? '',
      geminiModel: coerceModel(rawModel),
      responseLanguage: coerceLanguage(rawLang),
    });
  } catch {
    setSettings({
      geminiApiKey: '',
      geminiModel: DEFAULT_GEMINI_MODEL,
      responseLanguage: DEFAULT_LANGUAGE,
    });
  }
}

export async function saveGeminiKey(
  setLocalStorage: (k: string, v: string) => Promise<boolean>,
  key: string,
): Promise<boolean> {
  const ok = await setLocalStorage(SETTINGS_KEY_GEMINI, key);
  if (ok) setSettings({ ...settings(), geminiApiKey: key });
  return ok;
}

export async function saveGeminiModel(
  setLocalStorage: (k: string, v: string) => Promise<boolean>,
  model: GeminiModel,
): Promise<boolean> {
  const ok = await setLocalStorage(SETTINGS_KEY_MODEL, model);
  if (ok) setSettings({ ...settings(), geminiModel: model });
  return ok;
}

export async function saveResponseLanguage(
  setLocalStorage: (k: string, v: string) => Promise<boolean>,
  language: LanguageCode,
): Promise<boolean> {
  const ok = await setLocalStorage(SETTINGS_KEY_LANGUAGE, language);
  if (ok) setSettings({ ...settings(), responseLanguage: language });
  return ok;
}

function coerceModel(raw: string | null | undefined): GeminiModel {
  if (raw && (GEMINI_MODELS as readonly string[]).includes(raw)) {
    return raw as GeminiModel;
  }
  return DEFAULT_GEMINI_MODEL;
}

function coerceLanguage(raw: string | null | undefined): LanguageCode {
  if (raw && raw in LANGUAGES) return raw as LanguageCode;
  return DEFAULT_LANGUAGE;
}

// ---------- Debug event log (temporary; for gesture diagnostics) ----------

export interface DebugEvent {
  ts: number;
  label: string;
  detail: string;
}

export const [debugEvents, setDebugEvents] = createSignal<DebugEvent[]>([]);

export function pushDebugEvent(entry: Omit<DebugEvent, 'ts'>): void {
  const ts = Date.now();
  setDebugEvents((prev) => {
    const next = [{ ts, ...entry }, ...prev];
    return next.slice(0, 40);
  });
}

export function clearDebugEvents(): void {
  setDebugEvents([]);
}

// ---------- Custom personas ----------

async function readStoredCustomPersonas(
  getLocalStorage: (k: string) => Promise<string>,
): Promise<CustomPersonaData[]> {
  try {
    const raw = await getLocalStorage(SETTINGS_KEY_CUSTOM_PERSONAS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is CustomPersonaData =>
        p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.prompt === 'string',
    );
  } catch {
    return [];
  }
}

export async function loadCustomPersonas(getLocalStorage: (k: string) => Promise<string>): Promise<void> {
  const stored = await readStoredCustomPersonas(getLocalStorage);
  const builtins = getPersonas().filter((p) => p.builtin);
  _setPersonas([...builtins, ...stored.map(makeCustomPersona)]);
}

export async function addCustomPersona(
  setLocalStorage: (k: string, v: string) => Promise<boolean>,
  getLocalStorage: (k: string) => Promise<string>,
  draft: { name: string; description: string; prompt: string },
): Promise<void> {
  const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const data: CustomPersonaData = {
    id,
    name: draft.name.trim(),
    description: draft.description.trim(),
    prompt: draft.prompt.trim(),
  };
  if (!data.name || !data.prompt) throw new Error('Name and prompt are required.');
  const stored = await readStoredCustomPersonas(getLocalStorage);
  stored.push(data);
  const ok = await setLocalStorage(SETTINGS_KEY_CUSTOM_PERSONAS, JSON.stringify(stored));
  if (!ok) throw new Error('Could not persist the new lens.');
  _setPersonas([...getPersonas(), makeCustomPersona(data)]);
}

export async function removeCustomPersona(
  setLocalStorage: (k: string, v: string) => Promise<boolean>,
  getLocalStorage: (k: string) => Promise<string>,
  id: PersonaId,
): Promise<void> {
  if (builtinIds().includes(id)) throw new Error('Built-in lenses cannot be removed.');
  const stored = await readStoredCustomPersonas(getLocalStorage);
  const next = stored.filter((p) => p.id !== id);
  const ok = await setLocalStorage(SETTINGS_KEY_CUSTOM_PERSONAS, JSON.stringify(next));
  if (!ok) throw new Error('Could not persist removal.');
  _setPersonas(getPersonas().filter((p) => p.id !== id));
}
