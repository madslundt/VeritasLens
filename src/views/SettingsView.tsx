// src/views/SettingsView.tsx
import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, Show, untrack, type Component } from 'solid-js';
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
  saveProvider,
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
  OPENAI_INLINE_AUDIO_HOSTS,
  OPENAI_TRANSCRIBE_MODELS,
  openaiHostLabel,
  type BufferDuration,
  type GeminiModel,
  type HistoryEntry,
  type LanguageCode,
  type LensResult,
  type LlmProvider,
  type MeetingPrepSection,
  type OpenAiBaseUrl,
} from '@/types';
import { personas } from '@/personas';
import { MEETING_PREP_ID } from '@/personas/meetingPrep';

type ModelTestStatus = { state: 'idle' | 'running' | 'ok' | 'fail'; message: string };
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
  }
}

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
  const [prepStatus, setPrepStatus] = createSignal<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [prepError, setPrepError] = createSignal('');
  const [prepExpanded, setPrepExpanded] = createSignal(false);
  const [saveState, setSaveState] = createSignal<'idle' | 'saving' | 'saved' | 'error'>('idle');
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
  };
  const anyTestRunning = (): boolean =>
    mainTest().state === 'running' || autoTest().state === 'running';
  const [activeTab, setActiveTab] = createSignal<'config' | 'history'>('config');

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
    // A key-shape error from a previous host doesn't apply to the new one —
    // clear it so the user isn't looking at a red field after switching.
    setKeyError(null);
  }, { defer: true }));

  createEffect(() => {
    const provider = draftProvider();
    const key = draftKey();
    if (provider !== 'gemini') {
      setModelsLoading(false);
      setGeminiFetchState('idle');
      return;
    }
    if (key.trim().length < 10) {
      setModelsLoading(false);
      setGeminiFetchState('idle');
      return;
    }
    // Flip loading on immediately so the model dropdown stays disabled across
    // the debounce window (otherwise it briefly re-enables between key-entry
    // and the actual fetch start).
    setModelsLoading(true);
    setGeminiFetchState('loading');
    const ac = new AbortController();
    const debounce = setTimeout(() => {
      void import('@/llm/gemini').then(({ fetchAvailableModels }) =>
        fetchAvailableModels(key, ac.signal)
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
    }, 300);
    onCleanup(() => {
      clearTimeout(debounce);
      ac.abort();
    });
  });

  // Mirror of the Gemini models effect, but for the OpenAI-compatible provider.
  // Refetches whenever the key OR the base URL changes — different hosts under
  // the same OpenAI API expose different model catalogs, so a URL switch must
  // invalidate the cached list.
  createEffect(() => {
    const provider = draftProvider();
    const key = draftOpenaiKey();
    const baseUrl = draftOpenaiBaseUrl();
    if (provider !== 'openai-compatible') {
      setOpenaiModelsLoading(false);
      setOpenaiFetchState('idle');
      return;
    }
    if (key.trim().length < 10) {
      setOpenaiModelsLoading(false);
      setOpenaiFetchState('idle');
      return;
    }
    setOpenaiModelsLoading(true);
    setOpenaiFetchState('loading');
    const ac = new AbortController();
    const debounce = setTimeout(() => {
      void import('@/llm/openai').then(({ fetchOpenAiModels }) =>
        fetchOpenAiModels(key, baseUrl, ac.signal)
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
    }, 300);
    onCleanup(() => {
      clearTimeout(debounce);
      ac.abort();
    });
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


  // Autosave the meeting-prep draft on debounce. Stays separate from the main
  // Save button (which handles every other setting) because the editor is
  // dynamic — multiple add/remove ops in a row would otherwise force the user
  // to mash Save constantly. Persisted serialization happens through the
  // bridge LocalStorage path used by every other setting.
  let prepSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let prepSavedFadeTimer: ReturnType<typeof setTimeout> | null = null;
  createEffect(() => {
    const next = prepDraft();
    if (prepSaveTimer) clearTimeout(prepSaveTimer);
    prepSaveTimer = setTimeout(async () => {
      setPrepStatus('saving');
      const bridge = getBridge();
      const result = await saveMeetingPrepSections(
        (k, v) => bridge.setLocalStorage(k, v),
        next,
      );
      if (result.ok) {
        setPrepStatus('saved');
        setPrepError('');
        if (prepSavedFadeTimer) clearTimeout(prepSavedFadeTimer);
        prepSavedFadeTimer = setTimeout(() => setPrepStatus('idle'), 1500);
      } else {
        setPrepStatus('error');
        setPrepError(result.error ?? 'Could not save meeting prep.');
      }
    }, 600);
  });
  onCleanup(() => {
    if (prepSaveTimer) clearTimeout(prepSaveTimer);
    if (prepSavedFadeTimer) clearTimeout(prepSavedFadeTimer);
  });

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
  onCleanup(() => { if (savedFadeTimer) clearTimeout(savedFadeTimer); });

  const onSave = async () => {
    setSaveState('saving');
    try {
      const bridge = getBridge();
      const setLs = (k: string, v: string) => bridge.setLocalStorage(k, v);
      const results = await Promise.all([
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
        saveResponseLanguage(setLs, draftLanguage()),
        saveBufferDuration(setLs, draftBuffer()),
        saveAutoSummaryEnabled(setLs, draftAutoEnabled()),
        saveDiscreet(setLs, draftDiscreet()),
        saveVoiceGateRmsFloor(setLs, draftVoiceGate()),
        saveVoiceTrimEnabled(setLs, draftVoiceTrim()),
      ]);
      if (results.every(Boolean)) {
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
    const draftTranscribe = isOpenAi && !isInlineAudioHost(baseUrl)
      ? (draftOpenaiTranscribeModel().trim() || undefined)
      : undefined;
    const { runSelfTest } = await import('@/llm');
    const probe = async (model: string): Promise<ModelTestStatus> => {
      try {
        const r = await runSelfTest(apiKey, model, { provider, baseUrl, transcribeModel: draftTranscribe });
        return { state: 'ok', message: `Works · ${r.latencyMs} ms` };
      } catch (err) {
        return { state: 'fail', message: err instanceof Error ? err.message : String(err) };
      }
    };

    const tasks: Promise<void>[] = [probe(mainModel).then((r) => { setMainTest(r); })];
    if (autoModel) tasks.push(probe(autoModel).then((r) => { setAutoTest(r); }));
    await Promise.all(tasks);
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

      <div class="tab-bar" role="tablist">
        <button
          type="button"
          role="tab"
          class="tab-btn"
          classList={{ active: activeTab() === 'config' }}
          onClick={() => setActiveTab('config')}
        >
          Settings
        </button>
        <button
          type="button"
          role="tab"
          class="tab-btn"
          classList={{ active: activeTab() === 'history' }}
          onClick={() => setActiveTab('history')}
        >
          History
        </button>
      </div>

      <Show when={activeTab() === 'config'}>
        <>
          <section class="lenses-card">
            <div class="field-header">
              <span class="field-label">Lenses</span>
            </div>
            <ul class="lens-list">
              <For each={personas()}>
                {(p) => (
                  <Show
                    when={p.id === MEETING_PREP_ID}
                    fallback={(
                      <li class="lens-row">
                        <div class="lens-info">
                          <strong>{p.name}</strong>
                          <span class="lens-desc">{p.description}</span>
                        </div>
                      </li>
                    )}
                  >
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
                            <Show when={prepStatus() === 'saving'}>
                              <span class="status">Saving…</span>
                            </Show>
                            <Show when={prepStatus() === 'saved'}>
                              <span class="status ok">Saved</span>
                            </Show>
                            <Show when={prepStatus() === 'error'}>
                              <span class="status err">{prepError() || 'Could not save'}</span>
                            </Show>
                          </div>
                        </div>
                      </Show>
                    </li>
                  </Show>
                )}
              </For>
            </ul>
          </section>

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
                  disabled={draftKey().trim().length < 10 || modelsLoading()}
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
                  Stored only on this device. Get one from your provider's
                  dashboard.
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
                  disabled={draftOpenaiKey().trim().length < 10 || openaiModelsLoading() || openaiModels().length === 0}
                  onChange={(e) => { setDraftOpenaiModel(e.currentTarget.value); clearStatuses(); }}
                >
                  {/*
                    Always render as a dropdown. Before the fetch lands the only
                    option is whatever's persisted; once the live list arrives
                    we union it with the saved model so a model that's no longer
                    served (or one we couldn't fetch yet) is still selectable
                    until the user picks a fresh one.
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

              <Show when={!isInlineAudioHost(draftOpenaiBaseUrl())}>
                <label class="field">
                  <span class="field-label">Transcription model</span>
                  <input
                    type="text"
                    autocomplete="off"
                    spellcheck={false}
                    placeholder={OPENAI_TRANSCRIBE_MODELS[draftOpenaiBaseUrl()] ?? ''}
                    value={draftOpenaiTranscribeModel()}
                    onInput={(e) => { setDraftOpenaiTranscribeModel(e.currentTarget.value); clearStatuses(); }}
                  />
                  <span class="field-hint">
                    Posted to <code>/audio/transcriptions</code> before chat
                    completions. Leave blank to use the {openaiHostLabel(draftOpenaiBaseUrl())} default
                    (<code>{OPENAI_TRANSCRIBE_MODELS[draftOpenaiBaseUrl()] ?? ''}</code>); override
                    with e.g. <code>gpt-4o-mini-transcribe</code> or <code>whisper-large-v3-turbo</code>
                    if the default has been deprecated or you want a different price/quality point.
                  </span>
                </label>
              </Show>
            </Show>

            <div class="config-section-divider" role="separator">
              <span>App settings</span>
            </div>

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
              <span class="field-label">Summary</span>
              <label class="toggle-row">
                <input
                  type="checkbox"
                  checked={draftAutoEnabled()}
                  onChange={(e) => setDraftAutoEnabled(e.currentTarget.checked)}
                />
                <span>Enable background summaries</span>
              </label>
              <Show when={draftAutoEnabled()}>
                <span class="field-hint warning">
                  ⚠ Sends a provider request every 5 minutes during a session, plus a
                  last-tick and a final-synthesis request when you exit the session
                  (or change provider/model/key/buffer-duration settings). Both
                  appear in History; ticks with no voice are skipped automatically.
                </span>
              </Show>
            </div>

            <div class="form-actions">
              <button type="submit" class="primary" disabled={!canSave() || saveState() === 'saving'}>
                {saveState() === 'saving' ? 'Saving…' : 'Save'}
              </button>
              <Show when={saveState() === 'saved'}>
                <span class="status ok">Saved</span>
              </Show>
              <Show when={saveState() === 'error'}>
                <span class="status err">Could not save</span>
              </Show>
            </div>
          </form>

          <footer class="privacy">
            Audio is held in a rolling in-memory buffer, never written to disk. Your API key is sent
            only as part of the provider request you trigger. Session log is cleared when the app closes.
          </footer>
        </>
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
    </main>
  );
};
