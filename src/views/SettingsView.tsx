// src/views/SettingsView.tsx
import { createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, Show, Switch, untrack, type Component } from 'solid-js';
import {
  MEETING_PREP_BYTE_BUDGET,
  MEETING_PREP_LABEL_MAX,
  availableModels,
  clearSessionHistory,
  computeMeetingPrepBytes,
  deleteHistorySession,
  deviceStatus,
  meetingPrepSections,
  modelsLoading,
  newSectionId,
  saveAutoSummaryEnabled,
  saveVoiceGateRmsFloor,
  saveVoiceTrimEnabled,
  VOICE_GATE_RMS_STEP,
  VOICE_GATE_RMS_MAX,
  saveBufferDuration,
  saveDiscreet,
  saveGeminiKey,
  saveGeminiModel,
  saveGeminiAutoModel,
  saveMeetingPrepSections,
  saveOpenaiBaseUrl,
  saveOpenaiKeys,
  saveOpenaiModel,
  saveOpenaiTranscribeModels,
  saveAutoDisabledLenses,
  saveProvider,
  saveSttHost,
  saveSttModel,
  saveResponseLanguage,
  sessionHistory,
  setAvailableModels,
  setModelsLoading,
  settings,
} from '@/state/store';
import { getBridge } from '@/runtime/bridge';
import { isHudRunning, refreshHudPage, startHudRuntime } from '@/runtime/lifecycle';
import {
  LANGUAGES,
  OPENAI_BASE_URLS,
  OPENAI_CHAT_ONLY_HOSTS,
  OPENAI_INLINE_AUDIO_HOSTS,
  OPENAI_TRANSCRIBE_MODELS,
  STT_HOSTS,
  STT_MODELS_BY_HOST,
  openaiHostLabel,
  type BufferDuration,
  type GeminiModel,
  type HistoryEntry,
  type LanguageCode,
  type LensResult,
  type LlmProvider,
  type MeetingPrepSection,
  type OpenAiBaseUrl,
  type SttHost,
} from '@/types';
import { personas } from '@/personas';
import { MEETING_PREP_ID } from '@/personas/meetingPrep';
import { AUTO_LENS_CANDIDATES } from '@/personas/auto';

type ModelTestStatus = { state: 'idle' | 'running' | 'ok' | 'fail' | 'skipped'; message: string };
const IDLE_TEST: ModelTestStatus = { state: 'idle', message: '' };

const BUFFER_OPTIONS: { value: BufferDuration; label: string }[] = [
  { value: 30, label: '30 seconds' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
];

/**
 * Flat host/provider list for the single Provider dropdown. Each non-Gemini
 * entry encodes both `provider` and `openaiBaseUrl` into one composite value
 * so we can keep the UI as one select instead of radio-group + sub-dropdown.
 * Value is parsed by `parseProviderOption` on change.
 */
type ProviderOption =
  | { kind: 'gemini'; value: 'gemini'; label: string }
  | { kind: 'openai-compatible'; value: string; label: string; baseUrl: OpenAiBaseUrl };

const PROVIDER_OPTIONS: ProviderOption[] = [
  { kind: 'gemini', value: 'gemini', label: 'Google Gemini' },
  { kind: 'openai-compatible', value: 'openai-compatible:https://api.openai.com/v1', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { kind: 'openai-compatible', value: 'openai-compatible:https://api.groq.com/openai/v1', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { kind: 'openai-compatible', value: 'openai-compatible:https://openrouter.ai/api/v1', label: 'OpenRouter (audio models)', baseUrl: 'https://openrouter.ai/api/v1' },
  { kind: 'openai-compatible', value: 'openai-compatible:https://api.deepseek.com/v1', label: 'DeepSeek (external STT)', baseUrl: 'https://api.deepseek.com/v1' },
  { kind: 'openai-compatible', value: 'openai-compatible:https://api.perplexity.ai', label: 'Perplexity (web-grounded, external STT)', baseUrl: 'https://api.perplexity.ai' },
];

function providerOptionValue(provider: LlmProvider, baseUrl: OpenAiBaseUrl): string {
  return provider === 'gemini' ? 'gemini' : `openai-compatible:${baseUrl}`;
}

/**
 * Per-host placeholder showing the real prefix issued by that provider so the
 * user immediately sees they're pasting the right kind of key:
 *   OpenAI → `sk-…`
 *   Groq   → `gsk_…`
 */
function openaiKeyPlaceholder(baseUrl: OpenAiBaseUrl): string {
  switch (baseUrl) {
    case 'https://api.groq.com/openai/v1': return 'gsk_…';
    case 'https://api.openai.com/v1': return 'sk-…';
    case 'https://openrouter.ai/api/v1': return 'sk-or-…';
    case 'https://api.deepseek.com/v1': return 'sk-…';
    case 'https://api.perplexity.ai': return 'pplx-…';
  }
}

/**
 * Direct deep link to each host's API-key page. Rendered inline so the
 * `href=` attribute sits on the same line as the URL literal — the
 * network-whitelist contract test (tests/contracts/network-whitelist.test.ts)
 * excludes URLs that appear inside JSX navigation attributes, so this shape
 * is what keeps these *external* dashboard links from tripping the
 * whitelist check (they open in the host browser, not the WebView).
 *
 * URLs are the official console paths as of 2026-Q2; update if a provider
 * reshuffles their dashboard.
 */
const ApiKeyLink: Component<{ host: OpenAiBaseUrl }> = (props) => (
  <Switch>
    <Match when={props.host === 'https://api.openai.com/v1'}>
      <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">platform.openai.com/api-keys</a>
    </Match>
    <Match when={props.host === 'https://api.groq.com/openai/v1'}>
      <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com/keys</a>
    </Match>
    <Match when={props.host === 'https://openrouter.ai/api/v1'}>
      <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">openrouter.ai/keys</a>
    </Match>
    <Match when={props.host === 'https://api.deepseek.com/v1'}>
      <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">platform.deepseek.com/api_keys</a>
    </Match>
    <Match when={props.host === 'https://api.perplexity.ai'}>
      <a href="https://www.perplexity.ai/settings/api" target="_blank" rel="noreferrer">perplexity.ai/settings/api</a>
    </Match>
  </Switch>
);

function parseProviderOption(value: string): { provider: LlmProvider; baseUrl: OpenAiBaseUrl } {
  if (value === 'gemini') {
    return { provider: 'gemini', baseUrl: 'https://api.openai.com/v1' };
  }
  const sep = value.indexOf(':');
  const url = sep > -1 ? value.slice(sep + 1) : '';
  const match = OPENAI_BASE_URLS.find((u) => u === url);
  return { provider: 'openai-compatible', baseUrl: match ?? 'https://api.openai.com/v1' };
}

/**
 * Build the OpenAI model dropdown options. Always includes the currently-
 * saved model so the `<select>`'s `value` binds to a real `<option>` even
 * before the live list returns. Fetched models are appended after, de-duped.
 */
function openaiModelOptions(saved: string, fetched: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (saved) {
    out.push(saved);
    seen.add(saved);
  }
  for (const m of fetched) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

function badgeIcon(badge: string): string {
  const u = badge.toUpperCase();
  if (u === 'TRUE' || u === 'PLAUSIBLE' || u === 'NEUTRAL') return '✓';
  if (u === 'FALSE' || u === 'SUSPICIOUS' || u === 'BIASED') return '✗';
  if (u === 'UNVERIFIED') return '?';
  return '•';
}

function badgeClass(badge: string): string {
  const u = badge.toUpperCase();
  if (u === 'TRUE' || u === 'PLAUSIBLE' || u === 'NEUTRAL') return 'ok';
  if (u === 'FALSE' || u === 'SUSPICIOUS' || u === 'BIASED') return 'bad';
  if (u === 'UNVERIFIED') return 'unk';
  return '';
}

// The expanded history row renders `entry.question` above the <pre>, so this
// formatter intentionally omits both the field that `extractQuestion()` pulled
// from each result variant and the verbatim quote (which is essentially the
// same utterance) — otherwise the question text would appear twice.
function formatResultText(result: LensResult): string {
  switch (result.type) {
    case 'fact-check': {
      return result.claims.map((c, i) => {
        const icon = c.verdict === 'TRUE' ? '✓' : c.verdict === 'FALSE' ? '✗' : '?';
        const head = result.claims.length > 1 ? `Claim ${i + 1}/${result.claims.length}\n` : '';
        return `${head}${icon} ${c.verdict}\n${c.reason}`;
      }).join('\n\n');
    }
    case 'trivia': {
      return result.claims.map((c, i) => {
        const head = result.claims.length > 1 ? `Q${i + 1}/${result.claims.length}\n` : '';
        return `${head}${c.answer}\n${c.description}`;
      }).join('\n\n');
    }
    case 'logical-fallacy': {
      return result.claims.map((c, i) => {
        const head = result.claims.length > 1 ? `Fallacy ${i + 1}/${result.claims.length}\n` : '';
        return `${head}${c.explanation}`;
      }).join('\n\n');
    }
    case 'stats-check': {
      return result.claims.map((c, i) => {
        const icon = c.verdict === 'PLAUSIBLE' ? '✓' : '✗';
        const head = result.claims.length > 1 ? `Stat ${i + 1}/${result.claims.length}\n` : '';
        return `${head}${icon} ${c.verdict}\n${c.reason}`;
      }).join('\n\n');
    }
    case 'bias': {
      return result.claims.map((c, i) => {
        const icon = c.verdict === 'NEUTRAL' ? '✓' : '✗';
        const head = result.claims.length > 1 ? `Claim ${i + 1}/${result.claims.length}\n` : '';
        const firstLine = c.direction ? `${icon} ${c.verdict}` : '';
        const reasonBlock = firstLine ? `${firstLine}\n${c.reason}` : c.reason;
        return `${head}${reasonBlock}`;
      }).join('\n\n');
    }
    case 'eli5': {
      return result.claims.map((c, i) => {
        const head = result.claims.length > 1 ? `${i + 1}/${result.claims.length}\n` : '';
        return `${head}${c.explanation}`;
      }).join('\n\n');
    }
    case 'session-summary': {
      return result.summary;
    }
    case 'meeting-prep': {
      // Primary answer first, then the evidence excerpt (when present), then
      // the gap-driven follow-up (when present). The header on the row already
      // shows entry.question (= primary answer text), so the answer's own text
      // is not repeated here — only the supporting detail and trailing claims.
      const primary = result.claims.find((c) => c.kind === 'answer');
      const evidence = result.claims.find((c) => c.kind === 'evidence');
      const followUp = result.claims.find((c) => c.kind === 'followup');
      const blocks: string[] = [];
      if (primary?.detail) blocks.push(primary.detail);
      if (primary?.source) blocks.push(`From: ${primary.source}`);
      if (evidence) {
        const src = evidence.source ? ` · From: ${evidence.source}` : '';
        blocks.push(`"${evidence.text}"${src}`);
      }
      if (followUp) {
        blocks.push(`→ Follow-up\n${followUp.text}`);
      }
      return blocks.join('\n\n');
    }
    case 'devils-advocate': {
      const c = result.claims[0];
      if (!c) return '';
      return `Counter: ${c.counterpoint}\n\n${c.rationale}`;
    }
    case 'key-questions': {
      return result.claims.map((c, i) => `Q${i + 1}: ${c.question}\n${c.context}`).join('\n\n');
    }
    case 'sentiment': {
      const c = result.claims[0];
      if (!c) return '';
      return `${c.tone}\n\n${c.explanation}`;
    }
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatSessionDate(ts: number): string {
  const now = new Date();
  const d = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  if (ts >= startOfToday) return `Today ${hh}:${mm}`;
  if (ts >= startOfYesterday) return `Yesterday ${hh}:${mm}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const SettingsView: Component = () => {
  const [draftProvider, setDraftProvider] = createSignal<LlmProvider>(settings().provider);
  const [draftKey, setDraftKey] = createSignal(settings().geminiApiKey);
  const [draftModel, setDraftModel] = createSignal<GeminiModel>(settings().geminiModel);
  const [draftAutoModel, setDraftAutoModel] = createSignal<GeminiModel | null>(settings().geminiAutoModel);
  // Per-host draft of OpenAI keys so switching providers (OpenAI ↔ Groq) does
  // not lose what the user typed in another slot. `draftOpenaiKey()` reads the
  // value for whichever host is currently selected in the Provider dropdown.
  const [draftOpenaiKeys, setDraftOpenaiKeys] = createSignal<Record<OpenAiBaseUrl, string>>({ ...settings().openaiApiKeys });
  const [draftOpenaiBaseUrl, setDraftOpenaiBaseUrl] = createSignal<OpenAiBaseUrl>(settings().openaiBaseUrl);
  const draftOpenaiKey = (): string => draftOpenaiKeys()[draftOpenaiBaseUrl()] ?? '';
  const setDraftOpenaiKey = (key: string): void => {
    setDraftOpenaiKeys((prev) => ({ ...prev, [draftOpenaiBaseUrl()]: key }));
  };
  const [draftOpenaiModel, setDraftOpenaiModel] = createSignal<string>(settings().openaiModel);
  // Per-host draft of transcribe model overrides. Empty string for a host
  // means "use the static default from OPENAI_TRANSCRIBE_MODELS"; the helpers
  // below read/write only the slot for the currently-selected base URL.
  const [draftOpenaiTranscribeModels, setDraftOpenaiTranscribeModels] = createSignal<Record<OpenAiBaseUrl, string>>(
    { ...settings().openaiTranscribeModels },
  );
  const draftOpenaiTranscribeModel = (): string =>
    draftOpenaiTranscribeModels()[draftOpenaiBaseUrl()] ?? '';
  const setDraftOpenaiTranscribeModel = (model: string): void => {
    setDraftOpenaiTranscribeModels((prev) => ({ ...prev, [draftOpenaiBaseUrl()]: model }));
  };
  const isInlineAudioHost = (baseUrl: OpenAiBaseUrl): boolean =>
    OPENAI_INLINE_AUDIO_HOSTS.has(baseUrl);
  const isChatOnlyHost = (baseUrl: OpenAiBaseUrl): boolean =>
    OPENAI_CHAT_ONLY_HOSTS.has(baseUrl);
  // Cross-host STT draft. Used only when the active chat host is in
  // OPENAI_CHAT_ONLY_HOSTS — for everyone else, the per-chat-host transcribe
  // override above (draftOpenaiTranscribeModel) carries the same role.
  const [draftSttHost, setDraftSttHost] = createSignal<SttHost>(settings().sttHost);
  const [draftSttModel, setDraftSttModel] = createSignal<string>(settings().sttModel);
  const [openaiModels, setOpenaiModels] = createSignal<string[]>([]);
  const [openaiModelsLoading, setOpenaiModelsLoading] = createSignal(false);
  // Outcome of the most recent /models probe per provider. Used to gate
  // `canSave` so a 401 from the model-list endpoint (the cheapest way to
  // verify a key in this codebase) prevents persisting a bogus key.
  //   idle    — no key yet, or provider currently inactive
  //   loading — debounce + in-flight
  //   ok      — request returned model ids
  //   fail    — network error, non-200, or empty list
  type FetchState = 'idle' | 'loading' | 'ok' | 'fail';
  const [geminiFetchState, setGeminiFetchState] = createSignal<FetchState>('idle');
  const [openaiFetchState, setOpenaiFetchState] = createSignal<FetchState>('idle');
  const [draftLanguage, setDraftLanguage] = createSignal<LanguageCode>(settings().responseLanguage);
  const [draftBuffer, setDraftBuffer] = createSignal<BufferDuration>(settings().bufferDuration);
  const [draftAutoEnabled, setDraftAutoEnabled] = createSignal(settings().autoSummaryEnabled);
  const [draftDiscreet, setDraftDiscreet] = createSignal(settings().discreet);
  const [draftVoiceGate, setDraftVoiceGate] = createSignal(settings().voiceGateRmsFloor);
  const [draftVoiceTrim, setDraftVoiceTrim] = createSignal(settings().voiceTrimEnabled);
  // Local draft of meeting-prep sections. Mirrors the persisted store value but
  // always carries at least one row so the editor never collapses to nothing.
  // Autosaves on debounce; cap violations surface inline in `prepError`.
  const [prepDraft, setPrepDraft] = createSignal<MeetingPrepSection[]>(
    meetingPrepSections().length > 0
      ? meetingPrepSections()
      : [{ id: newSectionId(), label: '', body: '' }],
  );
  // `prepError` carries byte-budget violations returned by the global save;
  // shown inline next to the meter. Cleared on the next successful save.
  const [prepError, setPrepError] = createSignal('');
  const [prepExpanded, setPrepExpanded] = createSignal(false);
  const [autoConfigExpanded, setAutoConfigExpanded] = createSignal(false);
  // Auto-lens enable list is now draft-only — toggles update the local
  // signal and are persisted by the global Save bar alongside the other
  // tabs' drafts, so the user sees the dot indicator on the Lenses tab
  // until they explicitly save.
  const [draftAutoDisabledLenses, setDraftAutoDisabledLenses] =
    createSignal<string[]>(settings().autoDisabledLenses);
  const autoEnabledCount = createMemo(() =>
    AUTO_LENS_CANDIDATES.filter((id) => !draftAutoDisabledLenses().includes(id)).length,
  );
  const autoLensItems = createMemo(() =>
    AUTO_LENS_CANDIDATES.map((id) => {
      const p = personas().find((x) => x.id === id);
      return { id, name: p?.name ?? id };
    }),
  );
  const toggleAutoLens = (id: string): void => {
    setDraftAutoDisabledLenses((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };
  type SaveState = 'idle' | 'saving' | 'saved' | 'error';
  const [saveState, setSaveState] = createSignal<SaveState>('idle');
  // Per-model test status. The Auto-classifier slot is only meaningful when
  // it's distinct from the main model (otherwise we'd double-probe the same
  // endpoint). `running` on either drives the Test button's spinner.
  const [mainTest, setMainTest] = createSignal<ModelTestStatus>(IDLE_TEST);
  const [autoTest, setAutoTest] = createSignal<ModelTestStatus>(IDLE_TEST);
  // Field-level error surfaced under the API key input when Test is hit with
  // an empty/too-short key. Stays attached to the key field (not the model
  // dropdown) because the model isn't the reason for the failure. Cleared as
  // soon as the user edits the API key input.
  const [keyError, setKeyError] = createSignal<string | null>(null);
  /**
   * Reset every transient status surfaced under the form so changing what's
   * being saved/tested doesn't leave stale results visible. Wired to all the
   * inputs that invalidate the previous probe (provider, API key, model
   * pickers) so the next test/save starts from a clean slate.
   */
  const clearStatuses = (): void => {
    setMainTest(IDLE_TEST);
    setAutoTest(IDLE_TEST);
    setKeyError(null);
    setSaveState('idle');
    // Drop any "ok" / "fail" badge from a prior Refresh — it no longer
    // describes the current key/host once the user has edited either.
    setGeminiFetchState('idle');
    setOpenaiFetchState('idle');
  };
  const anyTestRunning = (): boolean =>
    mainTest().state === 'running' || autoTest().state === 'running';
  type SettingsTab = 'lenses' | 'history' | 'settings' | 'llm';
  const [activeTab, setActiveTab] = createSignal<SettingsTab>('lenses');

  // Session log navigation
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
  const [expandedEntryId, setExpandedEntryId] = createSignal<string | null>(null);
  const [searchQuery, setSearchQuery] = createSignal('');
  // Two-tap inline confirm for destructive history actions. The first tap on
  // a row's × stages that row's sessionId; a second tap on the same row's
  // confirm button calls deleteHistorySession. Same shape for clear-all
  // (`'__all__'` sentinel). Tapping the cancel half — or any other row's × —
  // resets the staged id, so only one delete affordance is ever armed at once.
  const [pendingDeleteId, setPendingDeleteId] = createSignal<string | null>(null);
  let pendingDeleteTimer: ReturnType<typeof setTimeout> | null = null;
  const armDelete = (id: string): void => {
    setPendingDeleteId(id);
    if (pendingDeleteTimer) clearTimeout(pendingDeleteTimer);
    // Auto-cancel after 4s if the user walks away without confirming.
    pendingDeleteTimer = setTimeout(() => setPendingDeleteId(null), 4000);
  };
  const cancelDelete = (): void => {
    setPendingDeleteId(null);
    if (pendingDeleteTimer) clearTimeout(pendingDeleteTimer);
    pendingDeleteTimer = null;
  };
  onCleanup(() => {
    if (pendingDeleteTimer) clearTimeout(pendingDeleteTimer);
  });
  const getSetLs = (): ((k: string, v: string) => Promise<boolean>) =>
    (k, v) => getBridge().setLocalStorage(k, v);
  const confirmDeleteSession = async (sessionId: string): Promise<void> => {
    cancelDelete();
    if (selectedSessionId() === sessionId) setSelectedSessionId(null);
    await deleteHistorySession(sessionId, getSetLs());
    await refreshHudPage().catch(() => { /* HUD may not be running yet */ });
  };
  const confirmClearAll = async (): Promise<void> => {
    cancelDelete();
    setSelectedSessionId(null);
    setExpandedEntryId(null);
    clearSessionHistory(getSetLs());
    await refreshHudPage().catch(() => { /* HUD may not be running yet */ });
  };

  // Provider/host change → clear the previously-fetched list immediately so
  // a stale carryover (e.g. OpenAI's gpt-* ids while you've just switched to
  // Groq) doesn't linger while the refetch is in flight. `defer: true` skips
  // the initial run so the persisted list survives first paint. Untracking
  // `draftModel` prevents this effect from re-firing when the user picks a
  // different model from the dropdown.
  createEffect(on([draftProvider, draftOpenaiBaseUrl], ([provider]) => {
    if (provider === 'gemini') {
      setAvailableModels([untrack(draftModel)]);
    } else {
      setOpenaiModels([]);
    }
    // Reset both fetch states so the next dropdown focus re-arms refresh on
    // the new provider/host — a stale "ok" badge from the previous host
    // would otherwise gate the lazy refetch on the new one.
    setGeminiFetchState('idle');
    setOpenaiFetchState('idle');
    // A key-shape error from a previous host doesn't apply to the new one —
    // clear it so the user isn't looking at a red field after switching.
    setKeyError(null);
  }, { defer: true }));

  // Model-list fetches happen in two ways: (a) the dropdown's onFocus calls
  // these refresh functions directly, and (b) the debounced key-watcher effect
  // below auto-refreshes the cached list once the user finishes entering an
  // API key of plausible length. Both call sites are guarded by the same cache
  // check so we don't hit the network when the list is already populated. The
  // provider/host-change effect above resets the lists so a host switch
  // naturally re-arms the next fetch. Pre-0.9.0 a debounced effect fired the
  // /models endpoint on every keystroke; the 800 ms debounce here mitigates
  // the 403-noise problem that flagged in the store-review network monitor.

  function refreshGeminiModels(): void {
    if (modelsLoading() || draftKey().trim().length < 10) return;
    // Already populated — `availableModels` carries the saved model alone
    // before a fetch, and length > 1 means a fetched list is cached.
    if (availableModels().length > 1) return;
    const ac = new AbortController();
    setModelsLoading(true);
    setGeminiFetchState('loading');
    void import('@/llm/gemini').then(({ fetchAvailableModels }) =>
      fetchAvailableModels(draftKey(), ac.signal)
        .then((models) => {
          if (ac.signal.aborted) return;
          if (models.length > 0) {
            setAvailableModels(models);
            setGeminiFetchState('ok');
          } else {
            setGeminiFetchState('fail');
          }
        })
        .catch(() => { if (!ac.signal.aborted) setGeminiFetchState('fail'); })
        .finally(() => { if (!ac.signal.aborted) setModelsLoading(false); }),
    );
  }

  function refreshOpenAiModels(): void {
    if (openaiModelsLoading() || draftOpenaiKey().trim().length < 10) return;
    if (openaiModels().length > 0) return;
    const ac = new AbortController();
    setOpenaiModelsLoading(true);
    setOpenaiFetchState('loading');
    void import('@/llm/openai').then(({ fetchOpenAiModels }) =>
      fetchOpenAiModels(draftOpenaiKey(), draftOpenaiBaseUrl(), ac.signal)
        .then((models) => {
          if (ac.signal.aborted) return;
          if (models.length > 0) {
            setOpenaiModels(models);
            setOpenaiFetchState('ok');
          } else {
            setOpenaiFetchState('fail');
          }
        })
        .catch(() => { if (!ac.signal.aborted) setOpenaiFetchState('fail'); })
        .finally(() => { if (!ac.signal.aborted) setOpenaiModelsLoading(false); }),
    );
  }

  // Auto-refresh the dropdown once the user finishes entering an API key.
  // Each key edit clears the cached list (so the refresh actually re-fetches
  // with the new credential) and schedules a fetch after an 800 ms idle
  // window — long enough that a paste or fast-typed key fires the request
  // exactly once, short enough that the dropdown is ready by the time the
  // user reaches for it. The provider gate skips work for the inactive host
  // (e.g. don't probe Gemini while the user is editing the OpenAI key).
  const KEY_REFRESH_DEBOUNCE_MS = 800;
  let geminiKeyDebounce: ReturnType<typeof setTimeout> | null = null;
  createEffect(on(draftKey, (key) => {
    if (geminiKeyDebounce) clearTimeout(geminiKeyDebounce);
    if (draftProvider() !== 'gemini') return;
    if (key.trim().length < 10) return;
    geminiKeyDebounce = setTimeout(() => {
      setAvailableModels([untrack(draftModel)]);
      setGeminiFetchState('idle');
      refreshGeminiModels();
    }, KEY_REFRESH_DEBOUNCE_MS);
  }, { defer: true }));

  let openaiKeyDebounce: ReturnType<typeof setTimeout> | null = null;
  createEffect(on([draftOpenaiKey, draftOpenaiBaseUrl], ([key]) => {
    if (openaiKeyDebounce) clearTimeout(openaiKeyDebounce);
    if (draftProvider() !== 'openai-compatible') return;
    if (key.trim().length < 10) return;
    openaiKeyDebounce = setTimeout(() => {
      setOpenaiModels([]);
      setOpenaiFetchState('idle');
      refreshOpenAiModels();
    }, KEY_REFRESH_DEBOUNCE_MS);
  }, { defer: true }));

  onCleanup(() => {
    if (geminiKeyDebounce) clearTimeout(geminiKeyDebounce);
    if (openaiKeyDebounce) clearTimeout(openaiKeyDebounce);
  });

  /**
   * Gate Save on a verifiable configuration:
   *  - an API key of plausible length is present, and
   *  - the /models endpoint accepted that key (so 401s don't get persisted),
   *    and
   *  - if the user ran Test model, neither probe failed.
   * The fetch is `idle` momentarily after the key crosses the 10-char
   * threshold (before the 300 ms debounce fires) — we accept that by also
   * allowing `idle`, since the next state transition will quickly disable
   * Save again if the key turns out to be wrong.
   */
  const canSave = createMemo(() => {
    const provider = draftProvider();
    if (mainTest().state === 'fail' || autoTest().state === 'fail') return false;
    if (provider === 'gemini') {
      if (draftKey().trim().length < 10) return false;
      const st = geminiFetchState();
      if (st === 'loading' || st === 'fail') return false;
    } else {
      if (draftOpenaiKey().trim().length < 10) return false;
      const st = openaiFetchState();
      if (st === 'loading' || st === 'fail') return false;
    }
    return true;
  });


  // Meeting-prep edits are draft-only now — persisted by the global Save bar
  // alongside other tabs' drafts. `prepError` is still used to surface byte-
  // budget violations returned from saveMeetingPrepSections when the global
  // save fires, so the user sees inline detail next to the byte meter
  // instead of only the generic "Could not save" toast.

  // Shared helper with the store so the inline counter and the cap check
  // never drift — adding a field to MeetingPrepSection updates both at once.
  const prepUsedBytes = createMemo(() => computeMeetingPrepBytes(prepDraft()));

  /** Whether the general slot (row 0) has any content. */
  const prepGeneralSet = createMemo(
    () => (prepDraft()[0]?.body ?? '').trim().length > 0,
  );
  /** Count of attachments (rows 1+) with non-empty body — the only ones that
   * become citable sources for the lens. */
  const prepAttachmentCount = createMemo(
    () => prepDraft().slice(1).filter((s) => s.body.trim().length > 0).length,
  );
  /** Whether anything at all is configured — gates the empty/ok badge style. */
  const prepConfigured = createMemo(
    () => prepGeneralSet() || prepAttachmentCount() > 0,
  );
  /** Short label shown on the lens row badge. */
  const prepBadgeText = createMemo(() => {
    if (!prepConfigured()) return 'Empty';
    const parts: string[] = [];
    if (prepGeneralSet()) parts.push('Notes');
    if (prepAttachmentCount() > 0) {
      parts.push(`${prepAttachmentCount()} attachment${prepAttachmentCount() === 1 ? '' : 's'}`);
    }
    return parts.join(' · ');
  });
  /** Reactive view onto just the attachments (rows 1+) for the Index loop. */
  const prepAttachments = createMemo(() => prepDraft().slice(1));

  const updateGeneralBody = (body: string): void => {
    setPrepDraft((prev) => prev.map((s, i) => (i === 0 ? { ...s, body } : s)));
  };
  const clearGeneral = (): void => {
    setPrepDraft((prev) => prev.map((s, i) => (i === 0 ? { ...s, label: '', body: '' } : s)));
  };
  const updateAttachment = (id: string, patch: Partial<MeetingPrepSection>): void => {
    setPrepDraft((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };
  const addAttachment = (): void => {
    setPrepDraft((prev) => [...prev, { id: newSectionId(), label: '', body: '' }]);
  };
  const removeAttachment = (id: string): void => {
    setPrepDraft((prev) => prev.filter((s) => s.id !== id));
  };

  // Group history entries by sessionId, preserving insertion order
  const sessionGroups = createMemo(() => {
    const groups = new Map<string, HistoryEntry[]>();
    for (const entry of sessionHistory()) {
      const arr = groups.get(entry.sessionId) ?? [];
      arr.push(entry);
      groups.set(entry.sessionId, arr);
    }
    return [...groups.entries()].map(([id, entries]) => ({
      sessionId: id,
      startTime: entries[0]!.timestamp,
      entries,
    })).reverse();
  });

  const selectedSessionEntries = createMemo(() =>
    sessionGroups().find((g) => g.sessionId === selectedSessionId())?.entries ?? [],
  );

  // Search returns most-recent-first matches across the entire history.
  // Each entry is indexed by question + quote + badge + lensName + tags,
  // joined and lowercased. `tags` are auto-derived at write time (lifecycle's
  // extractTags) and never rendered — they exist purely to broaden recall on
  // this search box, e.g. surfacing an entry by a named entity that only
  // appears in the lens result's detail fields, not the recorded question.
  // Entries written by 0.6.x lack `tags`; the `?? ''` fallback keeps them
  // searchable through the other fields. Empty query collapses back to the
  // session list view.
  const searchMatches = createMemo<HistoryEntry[]>(() => {
    const q = searchQuery().trim().toLowerCase();
    if (q.length === 0) return [];
    const hits: HistoryEntry[] = [];
    const history = sessionHistory();
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i]!;
      const tagBlob = e.tags?.join(' ') ?? '';
      const haystack = `${e.question} ${e.quote} ${e.badge} ${e.lensName} ${tagBlob}`.toLowerCase();
      if (haystack.includes(q)) hits.push(e);
    }
    return hits;
  });

  let savedFadeTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => {
    if (savedFadeTimer) clearTimeout(savedFadeTimer);
  });

  /**
   * Single global save — persists every draft across LLM + Settings tabs in
   * one Promise.all. Refreshes the HUD afterwards so buffer / voice-gate /
   * provider changes take effect on the next analysis. Per-tab dirty memos
   * still drive the action bar's visibility and the "also on …" tail; the
   * write itself is unified for simplicity and to avoid two networked HUD
   * refreshes when both tabs are dirty.
   */
  const onSave = async () => {
    setSaveState('saving');
    try {
      const bridge = getBridge();
      const setLs = (k: string, v: string) => bridge.setLocalStorage(k, v);
      // Meeting-prep returns `{ok, error}` (byte-budget validation), so it
      // runs in parallel with the boolean savers but contributes its own
      // failure path. Resolve to a uniform boolean for the aggregate `ok`
      // check and stash the inline error so it surfaces next to the meter.
      const [
        provider,
        geminiKey,
        geminiModel,
        geminiAuto,
        openaiKeys,
        openaiBaseUrl,
        openaiModel,
        openaiTranscribe,
        sttHost,
        sttModel,
        language,
        buffer,
        autoSummary,
        discreet,
        voiceGate,
        voiceTrim,
        autoDisabled,
        prepResult,
      ] = await Promise.all([
        saveProvider(setLs, draftProvider()),
        saveGeminiKey(setLs, draftKey().trim()),
        saveGeminiModel(setLs, draftModel()),
        saveGeminiAutoModel(setLs, draftAutoModel()),
        saveOpenaiKeys(setLs, Object.fromEntries(
          (Object.entries(draftOpenaiKeys()) as Array<[OpenAiBaseUrl, string]>).map(([u, v]) => [u, v.trim()]),
        ) as Record<OpenAiBaseUrl, string>),
        saveOpenaiBaseUrl(setLs, draftOpenaiBaseUrl()),
        saveOpenaiModel(setLs, draftOpenaiModel()),
        saveOpenaiTranscribeModels(setLs, Object.fromEntries(
          (Object.entries(draftOpenaiTranscribeModels()) as Array<[OpenAiBaseUrl, string]>).map(([u, v]) => [u, v.trim()]),
        ) as Record<OpenAiBaseUrl, string>),
        saveSttHost(setLs, draftSttHost()),
        saveSttModel(setLs, draftSttModel().trim()),
        saveResponseLanguage(setLs, draftLanguage()),
        saveBufferDuration(setLs, draftBuffer()),
        saveAutoSummaryEnabled(setLs, draftAutoEnabled()),
        saveDiscreet(setLs, draftDiscreet()),
        saveVoiceGateRmsFloor(setLs, draftVoiceGate()),
        saveVoiceTrimEnabled(setLs, draftVoiceTrim()),
        saveAutoDisabledLenses(setLs, draftAutoDisabledLenses()),
        saveMeetingPrepSections(setLs, prepDraft()),
      ]);
      if (prepResult.ok) setPrepError('');
      else setPrepError(prepResult.error ?? 'Could not save meeting prep.');
      const allOk = [
        provider, geminiKey, geminiModel, geminiAuto, openaiKeys,
        openaiBaseUrl, openaiModel, openaiTranscribe, sttHost, sttModel,
        language, buffer, autoSummary, discreet, voiceGate, voiceTrim,
        autoDisabled,
      ].every(Boolean) && prepResult.ok;
      if (allOk) {
        // Re-seed the draft signals from the persisted store. The store may
        // have normalized values (e.g. meeting-prep labels are sliced at
        // MEETING_PREP_LABEL_MAX); without this re-seed the draft would
        // retain the un-normalized value and lensDirty would stay true.
        setDraftAutoDisabledLenses(settings().autoDisabledLenses);
        const freshPrep = meetingPrepSections();
        setPrepDraft(
          freshPrep.length > 0
            ? freshPrep
            : [{ id: newSectionId(), label: '', body: '' }],
        );
        setSaveState('saved');
        if (savedFadeTimer) clearTimeout(savedFadeTimer);
        savedFadeTimer = setTimeout(() => setSaveState('idle'), 1500);
        if (!isHudRunning()) await startHudRuntime();
        else await refreshHudPage();
      } else {
        setSaveState('error');
      }
    } catch {
      setSaveState('error');
    }
  };

  /**
   * Dirty flags: drafts vs persisted store. Drive the cross-tab "unsaved
   * changes" bar that surfaces above the bottom nav when the user navigates
   * away from a tab without saving. The bar only fires for tabs the user
   * isn't currently looking at — when they're on the tab itself, the in-tab
   * Save button is already visible.
   */
  const shallowRecordEq = (
    a: Record<string, string>,
    b: Record<string, string>,
  ): boolean => {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) if (a[k] !== b[k]) return false;
    return true;
  };
  const llmDirty = createMemo(() => {
    const s = settings();
    return (
      draftProvider() !== s.provider
      || draftKey() !== s.geminiApiKey
      || draftModel() !== s.geminiModel
      || draftAutoModel() !== s.geminiAutoModel
      || !shallowRecordEq(draftOpenaiKeys() as Record<string, string>, s.openaiApiKeys as Record<string, string>)
      || draftOpenaiBaseUrl() !== s.openaiBaseUrl
      || draftOpenaiModel() !== s.openaiModel
      || !shallowRecordEq(draftOpenaiTranscribeModels() as Record<string, string>, s.openaiTranscribeModels as Record<string, string>)
      || draftSttHost() !== s.sttHost
      || draftSttModel() !== s.sttModel
    );
  });
  const appDirty = createMemo(() => {
    const s = settings();
    return (
      draftLanguage() !== s.responseLanguage
      || draftBuffer() !== s.bufferDuration
      || draftAutoEnabled() !== s.autoSummaryEnabled
      || draftDiscreet() !== s.discreet
      || draftVoiceGate() !== s.voiceGateRmsFloor
      || draftVoiceTrim() !== s.voiceTrimEnabled
    );
  });
  /**
   * Lens-tab dirty flag: covers both the Auto-classifier enable list and
   * the meeting-prep editor. Compared against the persisted store signals
   * (`settings().autoDisabledLenses`, `meetingPrepSections()`) rather than
   * a snapshot — so an outside writer (e.g. lifecycle's session-summary
   * append) doesn't fool the bar into thinking the user has unsaved work.
   */
  const lensDirty = createMemo(() => {
    const a = draftAutoDisabledLenses();
    const b = settings().autoDisabledLenses;
    if (a.length !== b.length) return true;
    const aSet = new Set(a);
    for (const id of b) if (!aSet.has(id)) return true;
    // Normalize meeting-prep before comparing: drop fully-empty rows (so the
    // "always at least one row" seed on a fresh install doesn't read as a
    // dirty diff vs the empty persisted array) and compare by label+body
    // only (ids are regenerated on add, so they're not stable identity).
    const norm = (rows: MeetingPrepSection[]) =>
      rows
        .filter((s) => s.label.trim().length > 0 || s.body.trim().length > 0)
        .map((s) => ({ label: s.label, body: s.body }));
    const draftPrep = norm(prepDraft());
    const persistedPrep = norm(meetingPrepSections());
    if (draftPrep.length !== persistedPrep.length) return true;
    for (let i = 0; i < draftPrep.length; i++) {
      if (
        draftPrep[i]!.label !== persistedPrep[i]!.label
        || draftPrep[i]!.body !== persistedPrep[i]!.body
      ) return true;
    }
    return false;
  });

  const onTest = async () => {
    // Read everything from drafts so the probe matches what the user is about
    // to save. Without this, switching provider/model and hitting Test would
    // test the previously-persisted configuration.
    const provider = draftProvider();
    const baseUrl = draftOpenaiBaseUrl();
    const isOpenAi = provider === 'openai-compatible';
    const apiKey = isOpenAi ? draftOpenaiKey() : draftKey();
    const mainModel = isOpenAi ? draftOpenaiModel() : draftModel();
    // Auto classifier only exists on the Gemini path today, and is optional —
    // a null draft means "reuse the main model", so we don't double-probe.
    // Also skip when the user explicitly picked the same model as the main
    // one (both probes would hit the same endpoint, wasting tokens).
    const auto = draftAutoModel();
    const autoModel = !isOpenAi && auto && auto !== mainModel ? auto : null;

    // Pre-flight: a missing API key isn't a model failure, so surface it on
    // the key input instead of as a model-test result. Skips the network call
    // entirely (and avoids polluting `mainTest` with a key-shaped error).
    if (apiKey.trim().length < 10) {
      setKeyError(
        isOpenAi
          ? `Missing ${openaiHostLabel(baseUrl)} API key.`
          : 'Missing Gemini API key.',
      );
      setMainTest(IDLE_TEST);
      setAutoTest(IDLE_TEST);
      return;
    }
    setKeyError(null);

    setMainTest({ state: 'running', message: '' });
    setAutoTest(autoModel ? { state: 'running', message: '' } : IDLE_TEST);

    // For transcribe-then-chat hosts (OpenAI, Groq) carry the draft transcribe
    // model into the probe so the Test button reflects what Save would do.
    // Empty draft falls back to the static default inside runSelfTest. Inline-
    // audio hosts (OpenRouter) skip transcription entirely — pass undefined.
    // Chat-only hosts (DeepSeek, Perplexity) borrow STT from draftSttHost
    // and use that host's key from the per-host key draft.
    const isChatOnly = isOpenAi && isChatOnlyHost(baseUrl);
    const draftTranscribe = isOpenAi && !isInlineAudioHost(baseUrl) && !isChatOnly
      ? (draftOpenaiTranscribeModel().trim() || undefined)
      : undefined;
    const sttDraftHost: SttHost | undefined = isChatOnly ? draftSttHost() : undefined;
    const sttDraftModel = isChatOnly ? (draftSttModel().trim() || undefined) : undefined;
    const sttDraftApiKey = isChatOnly ? (draftOpenaiKeys()[draftSttHost()] ?? '').trim() : undefined;
    if (isChatOnly && !sttDraftApiKey) {
      // STT key input lives right below the host picker — surface a hint
      // pointing at it rather than asking the user to navigate elsewhere.
      setKeyError(`Add a ${openaiHostLabel(draftSttHost())} API key in the Speech-to-text section so ${openaiHostLabel(baseUrl)} can transcribe.`);
      setMainTest(IDLE_TEST);
      setAutoTest(IDLE_TEST);
      return;
    }
    const { runSelfTest } = await import('@/llm');
    const probe = async (
      model: string,
      probeOpts?: { lightweight?: boolean },
    ): Promise<ModelTestStatus> => {
      try {
        const r = await runSelfTest(apiKey, model, {
          provider,
          baseUrl,
          transcribeModel: draftTranscribe,
          sttHost: sttDraftHost,
          sttModel: sttDraftModel,
          sttApiKey: sttDraftApiKey,
          lightweight: probeOpts?.lightweight,
        });
        return { state: 'ok', message: `Works · ${r.latencyMs} ms` };
      } catch (err) {
        return { state: 'fail', message: err instanceof Error ? err.message : String(err) };
      }
    };

    // Run the main probe first. If it fails, skip the classifier probe — a
    // failing main probe already tells the user their key/model is broken,
    // so burning a second request to deliver the same news is wasteful.
    const mainResult = await probe(mainModel);
    setMainTest(mainResult);
    if (!autoModel) return;
    if (mainResult.state !== 'ok') {
      setAutoTest({ state: 'skipped', message: 'Skipped — main model failed' });
      return;
    }
    // Brief gap so the two requests don't share a per-second RPM window when
    // the user has pointed both at the same model family.
    await new Promise((r) => setTimeout(r, 250));
    setAutoTest(await probe(autoModel, { lightweight: true }));
  };

  // Session detail view. Claim-style answers are the primary content; the
  // end-of-session summary (lensId='session-summary') is rendered last with a
  // muted style so it doesn't compete with the claims for attention.
  const SessionDetailView = () => {
    const entries = selectedSessionEntries();
    const orderedEntries = [...entries].reverse();
    const claimEntries = orderedEntries.filter((e) => e.lensId !== 'session-summary');
    const summaryEntries = orderedEntries.filter((e) => e.lensId === 'session-summary');
    const renderRow = (entry: HistoryEntry, muted: boolean) => (
      <li class="history-row" classList={{ 'history-row-summary': muted }}>
        <button
          type="button"
          class="history-question"
          onClick={() => setExpandedEntryId((prev) => (prev === entry.id ? null : entry.id))}
        >
          <span class={`history-icon ${badgeClass(entry.badge)}`}>{badgeIcon(entry.badge)}</span>
          <span class="history-time">{formatTime(entry.timestamp)}</span>
          <span class="history-q">{entry.question}</span>
        </button>
        <Show when={expandedEntryId() === entry.id}>
          <div class="history-detail">
            <Show when={entry.result.autoSelected && entry.lensName}>
              <p class="history-detail-lens">{entry.lensName}</p>
            </Show>
            <p class="history-detail-question">{entry.question}</p>
            <pre>{formatResultText(entry.result)}</pre>
          </div>
        </Show>
      </li>
    );
    return (
      <div class="session-detail">
        <div class="field-header">
          <button type="button" class="link-button" onClick={() => { setSelectedSessionId(null); setExpandedEntryId(null); }}>
            ← Back
          </button>
          <span class="field-label">
            Session {entries[0] ? formatTime(entries[0].timestamp) : ''}
          </span>
        </div>
        <ul class="history-list">
          <For each={summaryEntries}>{(entry) => renderRow(entry, true)}</For>
          <Show when={summaryEntries.length > 0 && claimEntries.length > 0}>
            <li class="history-row-divider" aria-hidden="true" />
          </Show>
          <For each={claimEntries}>{(entry) => renderRow(entry, false)}</For>
        </ul>
      </div>
    );
  };

  // Flat search-results view — rendered when the search query is non-empty.
  // Each row expands inline to show the full result, same as the session view.
  const SearchResultsView = (props: { matches: HistoryEntry[] }) => (
    <div class="search-results">
      <Show
        when={props.matches.length > 0}
        fallback={<p class="muted">No matches for “{searchQuery()}”.</p>}
      >
        <ul class="history-list">
          <For each={props.matches}>
            {(entry) => (
              <li class="history-row">
                <button
                  type="button"
                  class="history-question"
                  onClick={() => setExpandedEntryId((prev) => (prev === entry.id ? null : entry.id))}
                >
                  <span class={`history-icon ${badgeClass(entry.badge)}`}>{badgeIcon(entry.badge)}</span>
                  <span class="history-time">{formatSessionDate(entry.timestamp)}</span>
                  <span class="history-q">{entry.quote || entry.question}</span>
                </button>
                <Show when={expandedEntryId() === entry.id}>
                  <div class="history-detail">
                    <Show when={entry.lensName}>
                      <p class="history-detail-lens">{entry.lensName}</p>
                    </Show>
                    <p class="history-detail-question">{entry.question}</p>
                    <pre>{formatResultText(entry.result)}</pre>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );

  // Session list view
  const SessionListView = () => (
    <div class="session-list">
      <Show
        when={sessionGroups().length > 0}
        fallback={<p class="muted">No analyses yet this session.</p>}
      >
        <Show
          when={pendingDeleteId() === '__all__'}
          fallback={
            <button
              type="button"
              class="history-clear-all"
              onClick={() => armDelete('__all__')}
            >
              Clear all history
            </button>
          }
        >
          <div class="history-clear-all-confirm">
            <button
              type="button"
              class="history-clear-all-yes"
              onClick={() => void confirmClearAll()}
            >
              Clear all history
            </button>
            <button
              type="button"
              class="history-clear-all-no"
              onClick={cancelDelete}
            >
              Cancel
            </button>
          </div>
        </Show>
        <ul class="history-list">
          <For each={sessionGroups()}>
            {(group) => (
              <li
                class="history-row history-row--with-remove"
                classList={{ 'history-row--arming': pendingDeleteId() === group.sessionId }}
              >
                <button
                  type="button"
                  class="history-question"
                  onClick={() => {
                    if (pendingDeleteId() !== null) { cancelDelete(); return; }
                    setSelectedSessionId(group.sessionId);
                    setExpandedEntryId(null);
                  }}
                >
                  <span class="history-q">{[...new Set(group.entries.map((e) => e.lensName))].join(', ')}</span>
                  <span class="history-time">{formatSessionDate(group.startTime)}</span>
                  <span class="history-badge">{group.entries.length} {group.entries.length === 1 ? 'check' : 'checks'}</span>
                </button>
                <Show
                  when={pendingDeleteId() === group.sessionId}
                  fallback={
                    <button
                      type="button"
                      class="history-row-remove"
                      onClick={(e) => { e.stopPropagation(); armDelete(group.sessionId); }}
                      aria-label="Delete session"
                      title="Delete session"
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                        <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                      </svg>
                    </button>
                  }
                >
                  <div class="history-row-confirm">
                    <button
                      type="button"
                      class="history-row-confirm-yes"
                      onClick={(e) => { e.stopPropagation(); void confirmDeleteSession(group.sessionId); }}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      class="history-row-confirm-no"
                      onClick={(e) => { e.stopPropagation(); cancelDelete(); }}
                    >
                      Cancel
                    </button>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );

  return (
    <main class="settings">
      <header>
        <h1>VeritasLens</h1>
        <p class="tagline">Silent intelligence for your G2.</p>
      </header>

      <Show when={activeTab() === 'lenses'}>
        <>
          <Show
            when={deviceStatus()}
            fallback={<div class="device-badge muted">Waiting for glasses…</div>}
          >
            {(s) => (
              <div class="device-badge">
                <span class={`dot ${s().connectType}`} />
                <span>{s().connectType}</span>
                <Show when={typeof s().batteryLevel === 'number'}>
                  <span class="sep">·</span>
                  <span>{s().batteryLevel}%</span>
                </Show>
                <Show when={s().isWearing}>
                  <span class="sep">·</span>
                  <span>wearing</span>
                </Show>
              </div>
            )}
          </Show>

          <section class="lenses-card">
            <div class="field-header">
              <span class="field-label">Lenses</span>
            </div>
            <ul class="lens-list">
              <For each={personas()}>
                {(p) => (
                  <Switch
                    fallback={
                      <li class="lens-row">
                        <div class="lens-info">
                          <strong>{p.name}</strong>
                          <span class="lens-desc">{p.description}</span>
                        </div>
                      </li>
                    }
                  >
                    <Match when={p.id === 'auto'}>
                      <li
                        class="lens-row lens-row--expandable"
                        classList={{ 'lens-row--open': autoConfigExpanded() }}
                      >
                        <div class="lens-row-head">
                          <div class="lens-row-title">
                            <strong>{p.name}</strong>
                            <span class="lens-tag lens-tag--ok">
                              {autoEnabledCount()} / {AUTO_LENS_CANDIDATES.length}
                            </span>
                          </div>
                          <div class="lens-row-sub">
                            <span class="lens-desc">{p.description}</span>
                            <button
                              type="button"
                              class="meeting-prep-trigger"
                              classList={{ open: autoConfigExpanded() }}
                              aria-expanded={autoConfigExpanded()}
                              onClick={() => setAutoConfigExpanded((v) => !v)}
                            >
                              <span>{autoConfigExpanded() ? 'Done' : 'Configure'}</span>
                              <svg
                                class="meeting-prep-chevron"
                                viewBox="0 0 10 6"
                                width="10"
                                height="6"
                                aria-hidden="true"
                              >
                                <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        <Show when={autoConfigExpanded()}>
                          <div class="meeting-prep-inline">
                            <p class="field-hint">
                              Toggle which lenses Auto mode can choose from.
                            </p>
                            <ul class="meeting-prep-list">
                              <For each={autoLensItems()}>
                                {(item) => (
                                  <li class="lens-row lens-row--toggle">
                                    <label class="toggle-row toggle-row--full">
                                      <input
                                        type="checkbox"
                                        checked={!draftAutoDisabledLenses().includes(item.id)}
                                        onChange={() => toggleAutoLens(item.id)}
                                      />
                                      <span>{item.name}</span>
                                    </label>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </div>
                        </Show>
                      </li>
                    </Match>
                    <Match when={p.id === MEETING_PREP_ID}>
                      <li
                        class="lens-row lens-row--expandable"
                        classList={{ 'lens-row--open': prepExpanded() }}
                      >
                        <div class="lens-row-head">
                          {/* Row 1 — title left, badge right. Full row width so
                              the badge actually reaches the row's right edge. */}
                          <div class="lens-row-title">
                            <strong>{p.name}</strong>
                            <span
                              class="lens-tag"
                              classList={{
                                'lens-tag--empty': !prepConfigured(),
                                'lens-tag--ok': prepConfigured(),
                              }}
                            >
                              {prepBadgeText()}
                            </span>
                          </div>
                          {/* Row 2 — description left, toggle right. */}
                          <div class="lens-row-sub">
                            <span class="lens-desc">{p.description}</span>
                            <button
                              type="button"
                              class="meeting-prep-trigger"
                              classList={{ open: prepExpanded() }}
                              aria-expanded={prepExpanded()}
                              onClick={() => setPrepExpanded((v) => !v)}
                            >
                              <span>{prepExpanded() ? 'Done' : 'Configure'}</span>
                              <svg
                                class="meeting-prep-chevron"
                                viewBox="0 0 10 6"
                                width="10"
                                height="6"
                                aria-hidden="true"
                              >
                                <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        <Show when={prepExpanded()}>
                          <div class="meeting-prep-inline">
                            <p class="field-hint">
                              Lead with your <strong class="meeting-prep-hint-strong">goal</strong> in one sentence,
                              then the background that matters — who you are, who you're meeting, key numbers.
                              <strong class="meeting-prep-hint-strong">Attachments</strong> are labeled chunks
                              (contracts, prepared questions, source documents) the assistant can cite.
                            </p>
                            <ul class="meeting-prep-list">
                              {/* General context — fixed first slot, no label,
                                  cannot be removed (only cleared). */}
                              <li class="meeting-prep-row meeting-prep-row--general">
                                <div class="meeting-prep-row-head">
                                  <span class="meeting-prep-row-tag">General context</span>
                                  <button
                                    type="button"
                                    class="meeting-prep-remove"
                                    onClick={clearGeneral}
                                    disabled={!prepGeneralSet()}
                                    aria-label="Clear general context"
                                    title="Clear"
                                  >
                                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                                    </svg>
                                  </button>
                                </div>
                                <textarea
                                  class="meeting-prep-body"
                                  placeholder={`e.g.\nNegotiate my mortgage rate below 4.2%.\n\nI'm the borrower; meeting with my bank's relationship manager. Current rate 4.8% fixed, 25y term started 2023. No prepayment penalty in original contract.`}
                                  rows={6}
                                  value={prepDraft()[0]?.body ?? ''}
                                  onInput={(e) => updateGeneralBody(e.currentTarget.value)}
                                />
                              </li>
                              {/* Attachments — Index keys by position so the
                                  input/textarea DOM nodes stay mounted while
                                  typing (avoids the focus-loss caused by
                                  rebuilding the row on every keystroke). */}
                              <Index each={prepAttachments()}>
                                {(attachment) => (
                                  <li class="meeting-prep-row meeting-prep-row--attachment">
                                    <div class="meeting-prep-row-head">
                                      <input
                                        type="text"
                                        class="meeting-prep-label"
                                        placeholder="Attachment label (e.g. Bank contract)"
                                        maxLength={MEETING_PREP_LABEL_MAX}
                                        value={attachment().label}
                                        onInput={(e) => updateAttachment(attachment().id, { label: e.currentTarget.value })}
                                      />
                                      <button
                                        type="button"
                                        class="meeting-prep-remove"
                                        onClick={() => removeAttachment(attachment().id)}
                                        aria-label="Remove attachment"
                                        title="Remove attachment"
                                      >
                                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                                          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                                        </svg>
                                      </button>
                                    </div>
                                    <textarea
                                      class="meeting-prep-body"
                                      placeholder="Paste contract text, quote, clause, document excerpt…"
                                      rows={5}
                                      value={attachment().body}
                                      onInput={(e) => updateAttachment(attachment().id, { body: e.currentTarget.value })}
                                    />
                                  </li>
                                )}
                              </Index>
                            </ul>
                            <div class="meeting-prep-actions">
                              <button type="button" class="meeting-prep-add" onClick={addAttachment}>
                                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                                  <path d="M6 1.5v9M1.5 6h9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                                </svg>
                                <span>Add attachment</span>
                              </button>
                              <div
                                class="meeting-prep-meter"
                                classList={{
                                  'meeting-prep-meter--warn': prepUsedBytes() / MEETING_PREP_BYTE_BUDGET >= 0.8 && prepUsedBytes() < MEETING_PREP_BYTE_BUDGET,
                                  'meeting-prep-meter--over': prepUsedBytes() >= MEETING_PREP_BYTE_BUDGET,
                                }}
                              >
                                <div
                                  class="meeting-prep-meter-bar"
                                  style={{ '--fill': `${Math.min(100, Math.round((prepUsedBytes() / MEETING_PREP_BYTE_BUDGET) * 100))}%` }}
                                />
                                <span class="meeting-prep-meter-label">
                                  {Math.round(prepUsedBytes() / 1024)} / {Math.round(MEETING_PREP_BYTE_BUDGET / 1024)} KB
                                </span>
                              </div>
                              <Show when={prepError()}>
                                <span class="status err">{prepError()}</span>
                              </Show>
                            </div>
                          </div>
                        </Show>
                      </li>
                    </Match>
                  </Switch>
                )}
              </For>
            </ul>
          </section>
        </>
      </Show>

      <Show when={activeTab() === 'llm'}>
        <form
          class="config"
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
          }}
        >
            <label class="field">
              <span class="field-label">Provider</span>
              <select
                value={providerOptionValue(draftProvider(), draftOpenaiBaseUrl())}
                onChange={(e) => {
                  const parsed = parseProviderOption(e.currentTarget.value);
                  setDraftProvider(parsed.provider);
                  if (parsed.provider === 'openai-compatible') {
                    setDraftOpenaiBaseUrl(parsed.baseUrl);
                  }
                  clearStatuses();
                }}
              >
                <For each={PROVIDER_OPTIONS}>{(opt) => <option value={opt.value}>{opt.label}</option>}</For>
              </select>
              <span class="field-hint">
                Gemini analyses audio directly. OpenAI and Groq transcribe the
                audio first (Whisper), then analyse the transcript. OpenRouter
                sends the audio inline to multimodal models. One API key per
                host, stored only on this device.
              </span>
            </label>

            <Show when={draftProvider() === 'gemini'}>
              <label class="field">
                <span class="field-label">API key</span>
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder="AIza…"
                  classList={{ 'input-error': keyError() !== null }}
                  value={draftKey()}
                  onInput={(e) => { setDraftKey(e.currentTarget.value); clearStatuses(); }}
                />
                <Show when={keyError()}>
                  <span class="field-error">{keyError()}</span>
                </Show>
                <span class="field-hint">
                  Stored only on this device. Get one at{' '}
                  <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer">
                    aistudio.google.com
                  </a>
                  .
                </span>
              </label>

              <label class="field">
                <span class="field-label">
                  Model
                  <Show when={modelsLoading()}>
                    <span class="spinner inline" />
                  </Show>
                </span>
                <select
                  value={draftModel()}
                  disabled={draftKey().trim().length < 10}
                  onFocus={refreshGeminiModels}
                  onChange={(e) => { setDraftModel(e.currentTarget.value as GeminiModel); clearStatuses(); }}
                >
                  <For each={availableModels()}>{(m) => <option value={m}>{m}</option>}</For>
                </select>
                <Show when={draftKey().trim().length < 10}>
                  <span class="field-hint">Enter an API key above to load available models.</span>
                </Show>
                <Show when={draftKey().trim().length >= 10 && modelsLoading()}>
                  <span class="field-hint">Loading models from Gemini…</span>
                </Show>
                <Show when={draftKey().trim().length >= 10 && !modelsLoading() && geminiFetchState() === 'ok'}>
                  <span class="field-hint">Models available.</span>
                </Show>
                <Show when={draftKey().trim().length >= 10 && !modelsLoading() && geminiFetchState() === 'fail'}>
                  <span class="field-error">Could not load models — check the API key.</span>
                </Show>
                <div class="model-test-row">
                  <button
                    type="button"
                    class="secondary"
                    onClick={onTest}
                    disabled={anyTestRunning() || draftKey().trim().length < 10}
                  >
                    <Show when={anyTestRunning()} fallback="Test model">
                      <span class="spinner inline" />
                      Testing…
                    </Show>
                  </button>
                  <Show when={mainTest().state === 'ok' && mainTest().message}>
                    <span class="status ok">{mainTest().message}</span>
                  </Show>
                  <Show when={mainTest().state === 'fail' && mainTest().message}>
                    <span class="status err">{mainTest().message}</span>
                  </Show>
                  <Show when={autoTest().state === 'ok' && autoTest().message}>
                    <span class="status ok">Classifier: {autoTest().message}</span>
                  </Show>
                  <Show when={autoTest().state === 'fail' && autoTest().message}>
                    <span class="status err">Classifier: {autoTest().message}</span>
                  </Show>
                  <Show when={autoTest().state === 'skipped' && autoTest().message}>
                    <span class="status muted">Classifier: {autoTest().message}</span>
                  </Show>
                </div>
              </label>

              <label class="field">
                <span class="field-label">Auto-lens classifier model</span>
                <select
                  value={draftAutoModel() ?? ''}
                  disabled={draftKey().trim().length < 10 || modelsLoading()}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setDraftAutoModel(v === '' ? null : (v as GeminiModel));
                    clearStatuses();
                  }}
                >
                  <option value="">Use main model (default)</option>
                  <For each={availableModels()}>{(m) => <option value={m}>{m}</option>}</For>
                </select>
                <span class="field-hint">
                  Optional. The Auto lens makes an extra fast call to pick a lens.
                  Leave on “Use main model” to reuse your chosen model, or pick a
                  lighter one (e.g. flash-lite) to stay under per-model rate limits.
                </span>
              </label>
            </Show>

            <Show when={draftProvider() === 'openai-compatible'}>
              <label class="field">
                <span class="field-label">API key</span>
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder={openaiKeyPlaceholder(draftOpenaiBaseUrl())}
                  classList={{ 'input-error': keyError() !== null }}
                  value={draftOpenaiKey()}
                  onInput={(e) => { setDraftOpenaiKey(e.currentTarget.value); clearStatuses(); }}
                />
                <Show when={keyError()}>
                  <span class="field-error">{keyError()}</span>
                </Show>
                <span class="field-hint">
                  Stored only on this device. Get one at <ApiKeyLink host={draftOpenaiBaseUrl()} />.
                </span>
              </label>

              <label class="field">
                <span class="field-label">
                  Model
                  <Show when={openaiModelsLoading()}>
                    <span class="spinner inline" />
                  </Show>
                </span>
                <select
                  value={draftOpenaiModel()}
                  disabled={draftOpenaiKey().trim().length < 10}
                  onFocus={refreshOpenAiModels}
                  onChange={(e) => { setDraftOpenaiModel(e.currentTarget.value); clearStatuses(); }}
                >
                  {/*
                    Always render as a dropdown. Before the fetch lands the only
                    option is whatever's persisted; once the live list arrives
                    we union it with the saved model so a model that's no longer
                    served (or one we couldn't fetch yet) is still selectable
                    until the user picks a fresh one. Picker is NOT disabled
                    while loading — that would close the just-opened native
                    picker on the focus-triggered refetch. User reopens after
                    fetch lands to see the live list.
                  */}
                  <For each={openaiModelOptions(draftOpenaiModel(), openaiModels())}>
                    {(m) => <option value={m}>{m}</option>}
                  </For>
                </select>
                <Show when={draftOpenaiKey().trim().length < 10}>
                  <span class="field-hint">Enter an API key above to load available models.</span>
                </Show>
                <Show when={draftOpenaiKey().trim().length >= 10 && openaiModelsLoading()}>
                  <span class="field-hint">Loading models from this provider…</span>
                </Show>
                <Show when={draftOpenaiKey().trim().length >= 10 && !openaiModelsLoading() && openaiFetchState() === 'ok'}>
                  <span class="field-hint">Models available.</span>
                </Show>
                <Show when={draftOpenaiKey().trim().length >= 10 && !openaiModelsLoading() && openaiFetchState() === 'fail'}>
                  <span class="field-error">Could not load models — check the API key.</span>
                </Show>
                <div class="model-test-row">
                  <button
                    type="button"
                    class="secondary"
                    onClick={onTest}
                    disabled={anyTestRunning() || draftOpenaiKey().trim().length < 10}
                  >
                    <Show when={anyTestRunning()} fallback="Test model">
                      <span class="spinner inline" />
                      Testing…
                    </Show>
                  </button>
                  <Show when={mainTest().state === 'ok' && mainTest().message}>
                    <span class="status ok">{mainTest().message}</span>
                  </Show>
                  <Show when={mainTest().state === 'fail' && mainTest().message}>
                    <span class="status err">{mainTest().message}</span>
                  </Show>
                </div>
              </label>

              <Show when={!isInlineAudioHost(draftOpenaiBaseUrl()) && !isChatOnlyHost(draftOpenaiBaseUrl())}>
                <label class="field">
                  <span class="field-label">Transcription model</span>
                  <select
                    value={draftOpenaiTranscribeModel()}
                    onChange={(e) => { setDraftOpenaiTranscribeModel(e.currentTarget.value); clearStatuses(); }}
                  >
                    <option value="">
                      Default ({OPENAI_TRANSCRIBE_MODELS[draftOpenaiBaseUrl()] ?? ''})
                    </option>
                    <For each={(STT_MODELS_BY_HOST[draftOpenaiBaseUrl() as SttHost] ?? [])}>
                      {(m) => <option value={m}>{m}</option>}
                    </For>
                  </select>
                  <span class="field-hint">
                    Posted to <code>/audio/transcriptions</code> before chat
                    completions on {openaiHostLabel(draftOpenaiBaseUrl())}. The default
                    (<code>{OPENAI_TRANSCRIBE_MODELS[draftOpenaiBaseUrl()] ?? ''}</code>) is
                    the cheapest current pick; override for a different price/quality point.
                  </span>
                </label>
              </Show>

              <Show when={isChatOnlyHost(draftOpenaiBaseUrl())}>
                <div class="config-section-divider" role="separator">
                  <span>Speech-to-text</span>
                </div>
                <p class="field-hint">
                  {openaiHostLabel(draftOpenaiBaseUrl())} doesn't transcribe audio. VeritasLens
                  will send the WAV to a separate Whisper host you pick below and forward only
                  the transcript to {openaiHostLabel(draftOpenaiBaseUrl())}.
                </p>
                <label class="field">
                  <span class="field-label">STT host</span>
                  <select
                    value={draftSttHost()}
                    onChange={(e) => {
                      const next = e.currentTarget.value as SttHost;
                      setDraftSttHost(next);
                      // Reset the STT model whenever the host changes so a stale
                      // Groq model id can't be silently sent to OpenAI Whisper.
                      const first = STT_MODELS_BY_HOST[next][0] ?? '';
                      setDraftSttModel(first);
                      clearStatuses();
                    }}
                  >
                    <For each={STT_HOSTS}>
                      {(h) => <option value={h}>{openaiHostLabel(h)} Whisper</option>}
                    </For>
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">{openaiHostLabel(draftSttHost())} API key</span>
                  <input
                    type="password"
                    autocomplete="off"
                    spellcheck={false}
                    placeholder={openaiKeyPlaceholder(draftSttHost())}
                    value={draftOpenaiKeys()[draftSttHost()] ?? ''}
                    onInput={(e) => {
                      const next = e.currentTarget.value;
                      setDraftOpenaiKeys((prev) => ({ ...prev, [draftSttHost()]: next }));
                      clearStatuses();
                    }}
                  />
                  <span class="field-hint">
                    Used for transcription only — the chat call still goes to {openaiHostLabel(draftOpenaiBaseUrl())}.
                    Get one at <ApiKeyLink host={draftSttHost()} />.
                  </span>
                </label>
                <label class="field">
                  <span class="field-label">STT model</span>
                  <select
                    value={draftSttModel() || STT_MODELS_BY_HOST[draftSttHost()][0]}
                    onChange={(e) => { setDraftSttModel(e.currentTarget.value); clearStatuses(); }}
                  >
                    <For each={STT_MODELS_BY_HOST[draftSttHost()]}>
                      {(m) => <option value={m}>{m}</option>}
                    </For>
                  </select>
                </label>
              </Show>
            </Show>

        </form>
      </Show>

      <Show when={activeTab() === 'settings'}>
        <form
          class="config"
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
          }}
        >
            <label class="field">
              <span class="field-label">Response language</span>
              <select
                value={draftLanguage()}
                onChange={(e) => setDraftLanguage(e.currentTarget.value as LanguageCode)}
              >
                <For each={Object.entries(LANGUAGES)}>
                  {([code, name]) => <option value={code}>{name}</option>}
                </For>
              </select>
            </label>

            <label class="field">
              <span class="field-label">Recording buffer</span>
              <select
                value={draftBuffer()}
                onChange={(e) => setDraftBuffer(Number(e.currentTarget.value) as BufferDuration)}
              >
                <For each={BUFFER_OPTIONS}>{(opt) => <option value={opt.value}>{opt.label}</option>}</For>
              </select>
              <span class="field-hint">
                Longer buffers capture more conversation but cost more per request.
              </span>
            </label>

            <div class="field">
              <span class="field-label">Voice detection sensitivity</span>
              <div class="slider-row">
                <input
                  type="range"
                  min="0"
                  max={VOICE_GATE_RMS_MAX}
                  step={VOICE_GATE_RMS_STEP}
                  value={draftVoiceGate()}
                  onInput={(e) => setDraftVoiceGate(Number(e.currentTarget.value))}
                />
                <span class="slider-value">
                  {draftVoiceGate() === 0 ? 'Off' : `RMS ${draftVoiceGate()}`}
                </span>
              </div>
              <span class="field-hint">
                RMS floor below which a frame counts as silence. <strong>0</strong> turns the gate off
                (every tap is sent to the LLM); <strong>200</strong> is the historical default. Lower
                if quiet speech is being misclassified, higher if background noise is leaking through.
                <br />
                <strong>○</strong> no voice / silence
                <br />
                <strong>~</strong> too noisy to pick up voice
              </span>
            </div>

            <div class="field">
              <span class="field-label">Trim non-speech audio</span>
              <label class="toggle-row">
                <input
                  type="checkbox"
                  checked={draftVoiceTrim()}
                  onChange={(e) => setDraftVoiceTrim(e.currentTarget.checked)}
                />
                <span>Strip silence before sending to the LLM</span>
              </label>
              <span class="field-hint">
                Crops the upload to detected speech segments — smaller payload, less noise for the
                model. Turn off if you want the model to hear ambient sound (music, scene, room tone).
                Has no effect when Silero VAD is unavailable.
              </span>
            </div>

            <div class="field">
              <span class="field-label">Discreet HUD</span>
              <label class="toggle-row">
                <input
                  type="checkbox"
                  checked={draftDiscreet()}
                  onChange={(e) => setDraftDiscreet(e.currentTarget.checked)}
                />
                <span>Hide the hint row while listening</span>
              </label>
              <span class="field-hint">
                Shows only a small recording dot; double-tap reveals the answer until hidden via the menu.
              </span>
            </div>

            <div class="field">
              <span class="field-label">Conversation memory</span>
              <label class="toggle-row">
                <input
                  type="checkbox"
                  checked={draftAutoEnabled()}
                  onChange={(e) => setDraftAutoEnabled(e.currentTarget.checked)}
                />
                <span>Remember earlier moments &amp; summarise the session</span>
              </label>
              <Show when={draftAutoEnabled()}>
                <span class="field-hint warning">
                  Remembers earlier moments in this session and writes a summary to History on exit.
                  ⚠ Sends a provider request periodically while listening (silent ticks skipped).
                </span>
              </Show>
            </div>

          <footer class="privacy">
            Audio is held in a rolling in-memory buffer, never written to disk. Your API key is sent
            only as part of the provider request you trigger. Session log is cleared when the app closes.
          </footer>
        </form>
      </Show>

      <Show when={activeTab() === 'history'}>
        <section class="session-log">
          <input
            class="history-search-input"
            type="text"
            placeholder="Search"
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
          />
          <Show
            when={searchQuery().trim().length > 0}
            fallback={
              <Show when={selectedSessionId() !== null} fallback={<SessionListView />}>
                <SessionDetailView />
              </Show>
            }
          >
            <SearchResultsView matches={searchMatches()} />
          </Show>
        </section>

      </Show>

      {/*
        Bottom-fixed stack: optional Save bar on top, tab nav below. Wrapping
        both in one fixed container guarantees zero gap between them (the
        previous absolute-positioned approach left a few px of background
        bleed-through whenever the bar's hard-coded offset didn't match the
        nav's rendered height) and the shared surface + bottom padding makes
        the home-indicator safe area read as part of the nav rather than a
        floating bottom strip. `canSave` only gates the button when there
        are LLM-side drafts to write; otherwise it would block the user from
        saving plain app preferences just because they haven't yet entered
        an API key.
      */}
      <div class="bottom-stack">
        <Show when={llmDirty() || appDirty() || lensDirty()}>
          <div class="action-bar" role="region" aria-label="Unsaved changes">
            <span class="action-bar-status">
              <span>Unsaved changes</span>
              <Show when={saveState() === 'saved'}>
                <span class="status ok">Saved</span>
              </Show>
              <Show when={saveState() === 'error'}>
                <span class="status err">Could not save</span>
              </Show>
            </span>
            <button
              type="button"
              class="primary"
              disabled={(llmDirty() && !canSave()) || saveState() === 'saving'}
              onClick={() => void onSave()}
            >
              {saveState() === 'saving' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Show>
        <nav class="bottom-nav" role="tablist" aria-label="Sections">
          {/*
            Inline SVG icons, all 22 × 22 viewBox with `currentColor` strokes
            so they pick up the active-state colour. Switched from Unicode
            glyphs (◉ ◷ ⚙ ✦) because iOS rendered them inconsistently:
            `⚙` had emoji-presentation-default (rendered as a colour gear),
            `◉` skewed larger than the rest in iOS's font fallback chain.
            Inline SVG guarantees identical size + monochrome rendering on
            every platform.
          */}
          <For each={[
            { id: 'lenses' as const, label: 'Lenses', dirty: (): boolean => lensDirty(), svg: (
              <svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
                <circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="1.5" />
                <circle cx="11" cy="11" r="3" fill="currentColor" />
              </svg>
            ) },
            { id: 'history' as const, label: 'History', dirty: (): boolean => false, svg: (
              <svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
                <circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="1.5" />
                <path d="M11 6.5v5l3 2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            ) },
            { id: 'settings' as const, label: 'Settings', dirty: (): boolean => appDirty(), svg: (
              <svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
                <circle cx="11" cy="11" r="2.5" fill="none" stroke="currentColor" stroke-width="1.5" />
                <path
                  d="M11 1.5v3M11 17.5v3M3.8 3.8l2.1 2.1M16.1 16.1l2.1 2.1M1.5 11h3M17.5 11h3M3.8 18.2l2.1-2.1M16.1 5.9l2.1-2.1"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            ) },
            { id: 'llm' as const, label: 'LLM', dirty: (): boolean => llmDirty(), svg: (
              <svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
                <path
                  d="M11 2 L12.4 9.6 L20 11 L12.4 12.4 L11 20 L9.6 12.4 L2 11 L9.6 9.6 Z"
                  fill="currentColor"
                />
              </svg>
            ) },
          ]}>
            {(t) => (
              <button
                type="button"
                role="tab"
                class="bottom-nav-btn"
                classList={{ active: activeTab() === t.id }}
                aria-selected={activeTab() === t.id}
                onClick={() => setActiveTab(t.id)}
              >
                <span class="bottom-nav-icon" aria-hidden="true">
                  {t.svg}
                  <Show when={t.dirty()}>
                    <span class="bottom-nav-dot" aria-label="Unsaved changes" />
                  </Show>
                </span>
                <span class="bottom-nav-label">{t.label}</span>
              </button>
            )}
          </For>
        </nav>
      </div>
    </main>
  );
};
