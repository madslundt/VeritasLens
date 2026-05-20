// src/views/SettingsView.tsx
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Component } from 'solid-js';
import {
  availableModels,
  deviceStatus,
  modelsLoading,
  saveAutoSummaryEnabled,
  saveAutoSummaryInterval,
  saveBufferDuration,
  saveDiscreet,
  saveGeminiKey,
  saveGeminiModel,
  saveGeminiAutoModel,
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
  type AutoSummaryInterval,
  type BufferDuration,
  type GeminiModel,
  type HistoryEntry,
  type LanguageCode,
  type LensResult,
} from '@/types';
import { personas } from '@/personas';

const BUFFER_OPTIONS: { value: BufferDuration; label: string }[] = [
  { value: 30, label: '30 seconds' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
];

const AUTO_INTERVAL_OPTIONS: { value: AutoSummaryInterval; label: string }[] = [
  { value: 1, label: 'Every minute' },
  { value: 2, label: 'Every 2 minutes' },
  { value: 5, label: 'Every 5 minutes' },
];

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

function formatResultText(result: LensResult): string {
  switch (result.type) {
    case 'fact-check': {
      return result.claims.map((c, i) => {
        const icon = c.verdict === 'TRUE' ? '✓' : c.verdict === 'FALSE' ? '✗' : '?';
        const head = result.claims.length > 1 ? `Claim ${i + 1}/${result.claims.length}\n` : '';
        const quoteLine = c.quote ? `“${c.quote}”\n` : '';
        return `${head}${quoteLine}${icon} ${c.verdict} — ${c.claim}\n${c.reason}`;
      }).join('\n\n');
    }
    case 'trivia': {
      const q = result.quote ? `“${result.quote}”\n\n` : '';
      return `${q}${result.answer}\n\n${result.description}`;
    }
    case 'logical-fallacy': {
      return result.claims.map((c, i) => {
        const head = result.claims.length > 1 ? `Fallacy ${i + 1}/${result.claims.length}\n` : '';
        const quoteLine = c.quote ? `“${c.quote}”\n` : '';
        return `${head}${quoteLine}${c.fallacy}\n${c.explanation}`;
      }).join('\n\n');
    }
    case 'stats-check': {
      return result.claims.map((c, i) => {
        const icon = c.verdict === 'PLAUSIBLE' ? '✓' : '✗';
        const head = result.claims.length > 1 ? `Stat ${i + 1}/${result.claims.length}\n` : '';
        const quoteLine = c.quote ? `“${c.quote}”\n` : '';
        return `${head}${quoteLine}${icon} ${c.verdict} — ${c.stat}\n${c.reason}`;
      }).join('\n\n');
    }
    case 'bias': {
      return result.claims.map((c, i) => {
        const icon = c.verdict === 'NEUTRAL' ? '✓' : '✗';
        const head = result.claims.length > 1 ? `Claim ${i + 1}/${result.claims.length}\n` : '';
        const quoteLine = c.quote ? `“${c.quote}”\n` : '';
        const firstLine = c.direction
          ? `${icon} ${c.verdict} · ${c.direction}`
          : `${icon} ${c.verdict}`;
        return `${head}${quoteLine}${firstLine}\n${c.reason}`;
      }).join('\n\n');
    }
    case 'translation': {
      const q = result.quote ? `“${result.quote}”\n\n` : '';
      return `${q}${result.translatedText}`;
    }
    case 'eli5': {
      const q = result.quote ? `“${result.quote}”\n\n` : '';
      return `${q}${result.explanation}`;
    }
    case 'session-summary': {
      const q = result.quote ? `“${result.quote}”\n\n` : '';
      return `${q}${result.summary}`;
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
  const [draftKey, setDraftKey] = createSignal(settings().geminiApiKey);
  const [draftModel, setDraftModel] = createSignal<GeminiModel>(settings().geminiModel);
  const [draftAutoModel, setDraftAutoModel] = createSignal<GeminiModel>(settings().geminiAutoModel);
  const [draftLanguage, setDraftLanguage] = createSignal<LanguageCode>(settings().responseLanguage);
  const [draftBuffer, setDraftBuffer] = createSignal<BufferDuration>(settings().bufferDuration);
  const [draftAutoEnabled, setDraftAutoEnabled] = createSignal(settings().autoSummaryEnabled);
  const [draftAutoInterval, setDraftAutoInterval] = createSignal<AutoSummaryInterval>(settings().autoSummaryInterval);
  const [draftDiscreet, setDraftDiscreet] = createSignal(settings().discreet);
  const [saveState, setSaveState] = createSignal<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [testState, setTestState] = createSignal<'idle' | 'running' | 'ok' | 'fail'>('idle');
  const [testMessage, setTestMessage] = createSignal('');
  const [activeTab, setActiveTab] = createSignal<'config' | 'history'>('config');

  // Session log navigation
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
  const [expandedEntryId, setExpandedEntryId] = createSignal<string | null>(null);
  const [searchQuery, setSearchQuery] = createSignal('');

  createEffect(() => {
    const key = draftKey();
    if (key.trim().length < 10) return;
    const ac = new AbortController();
    const debounce = setTimeout(() => {
      setModelsLoading(true);
      void import('@/llm/gemini').then(({ fetchAvailableModels }) =>
        fetchAvailableModels(key, ac.signal)
          .then((models) => { if (!ac.signal.aborted && models.length > 0) setAvailableModels(models); })
          .catch(() => { /* keep static fallback */ })
          .finally(() => { if (!ac.signal.aborted) setModelsLoading(false); }),
      );
    }, 300);
    onCleanup(() => {
      clearTimeout(debounce);
      ac.abort();
    });
  });

  const isConfigured = createMemo(() => settings().geminiApiKey.trim().length >= 10);
  const canSave = createMemo(() => draftKey().trim().length >= 10);

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
  // Each entry is indexed by question + quote + badge + lensName, joined
  // and lowercased. Empty query collapses back to the session list view.
  const searchMatches = createMemo<HistoryEntry[]>(() => {
    const q = searchQuery().trim().toLowerCase();
    if (q.length === 0) return [];
    const hits: HistoryEntry[] = [];
    const history = sessionHistory();
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i]!;
      const haystack = `${e.question} ${e.quote} ${e.badge} ${e.lensName}`.toLowerCase();
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
        saveGeminiKey(setLs, draftKey().trim()),
        saveGeminiModel(setLs, draftModel()),
        saveGeminiAutoModel(setLs, draftAutoModel()),
        saveResponseLanguage(setLs, draftLanguage()),
        saveBufferDuration(setLs, draftBuffer()),
        saveAutoSummaryEnabled(setLs, draftAutoEnabled()),
        saveAutoSummaryInterval(setLs, draftAutoInterval()),
        saveDiscreet(setLs, draftDiscreet()),
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
    setTestState('running');
    setTestMessage('');
    try {
      const { runSelfTest } = await import('@/llm/gemini');
      const result = await runSelfTest(settings().geminiApiKey, draftModel(), draftLanguage());
      setTestState('ok');
      setTestMessage(`Reachable · ${result.latencyMs} ms`);
    } catch (err) {
      setTestState('fail');
      setTestMessage(err instanceof Error ? err.message : String(err));
    }
  };

  // Session detail view
  const SessionDetailView = () => {
    const entries = selectedSessionEntries();
    const orderedEntries = [...entries].reverse();
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
          <For each={orderedEntries}>
            {(entry) => (
              <li class="history-row">
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
                    <Show when={entry.result.autoSelected}>
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
                    <p class="history-detail-lens">{entry.lensName}</p>
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
        <ul class="history-list">
          <For each={sessionGroups()}>
            {(group) => (
              <li class="history-row">
                <button
                  type="button"
                  class="history-question"
                  onClick={() => { setSelectedSessionId(group.sessionId); setExpandedEntryId(null); }}
                >
                  <span class="history-q">{[...new Set(group.entries.map((e) => e.lensName))].join(', ')}</span>
                  <span class="history-time">{formatSessionDate(group.startTime)}</span>
                  <span class="history-badge">{group.entries.length} {group.entries.length === 1 ? 'check' : 'checks'}</span>
                </button>
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
                  <li class="lens-row">
                    <div class="lens-info">
                      <strong>{p.name}</strong>
                      <span class="lens-desc">{p.description}</span>
                    </div>
                  </li>
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
              <span class="field-label">Gemini API key</span>
              <input
                type="password"
                autocomplete="off"
                spellcheck={false}
                placeholder="AIza…"
                value={draftKey()}
                onInput={(e) => setDraftKey(e.currentTarget.value)}
              />
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
                onChange={(e) => setDraftModel(e.currentTarget.value as GeminiModel)}
              >
                <For each={availableModels()}>{(m) => <option value={m}>{m}</option>}</For>
              </select>
              <Show when={!isConfigured() && !modelsLoading()}>
                <span class="field-hint">Enter an API key above to load available models.</span>
              </Show>
            </label>

            <label class="field">
              <span class="field-label">Auto-lens classifier model</span>
              <select
                value={draftAutoModel()}
                onChange={(e) => setDraftAutoModel(e.currentTarget.value as GeminiModel)}
              >
                <For each={availableModels()}>{(m) => <option value={m}>{m}</option>}</For>
              </select>
              <span class="field-hint">
                The Auto lens makes an extra fast call to pick a lens. Use a lighter model (e.g. flash-lite) to stay under rate limits.
              </span>
            </label>

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
                Longer buffers give Gemini more context but use more tokens per request.
              </span>
            </label>

            <div class="field">
              <span class="field-label">Discreet HUD</span>
              <label class="toggle-row">
                <input
                  type="checkbox"
                  checked={draftDiscreet()}
                  onChange={(e) => setDraftDiscreet(e.currentTarget.checked)}
                />
                <span>Hide REC indicator and hint while listening</span>
              </label>
              <span class="field-hint">
                Shows only a small recording dot on the glasses while a lens is active.
                Double-tap reveals the answer (without the REC label or the tap hint at the
                bottom). The answer stays on screen until you open the menu and tap Hide.
                Takes effect on the next lens session.
              </span>
            </div>

            <div class="field">
              <span class="field-label">Auto-summary</span>
              <label class="toggle-row">
                <input
                  type="checkbox"
                  checked={draftAutoEnabled()}
                  onChange={(e) => setDraftAutoEnabled(e.currentTarget.checked)}
                />
                <span>Enable background summaries</span>
              </label>
              <Show when={draftAutoEnabled()}>
                <select
                  value={draftAutoInterval()}
                  onChange={(e) => setDraftAutoInterval(Number(e.currentTarget.value) as AutoSummaryInterval)}
                >
                  <For each={AUTO_INTERVAL_OPTIONS}>
                    {(opt) => <option value={opt.value}>{opt.label}</option>}
                  </For>
                </select>
                <span class="field-hint warning">
                  ⚠ Auto-summary sends an API request at each interval (~30 calls/hour at 2 min).
                  Significantly higher API cost. Results appear in History only, not on the HUD.
                </span>
              </Show>
            </div>

            <div class="form-actions">
              <button type="submit" class="primary" disabled={!canSave() || saveState() === 'saving'}>
                {saveState() === 'saving' ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                class="secondary"
                onClick={onTest}
                disabled={testState() === 'running' || !isConfigured()}
              >
                <Show when={testState() === 'running'} fallback="Test connection">
                  <span class="spinner inline" />
                  Testing…
                </Show>
              </button>
              <Show when={saveState() === 'saved'}>
                <span class="status ok">Saved</span>
              </Show>
              <Show when={saveState() === 'error'}>
                <span class="status err">Could not save</span>
              </Show>
              <Show when={testState() === 'ok' && testMessage()}>
                <span class="status ok">{testMessage()}</span>
              </Show>
              <Show when={testState() === 'fail' && testMessage()}>
                <span class="status err">{testMessage()}</span>
              </Show>
            </div>
          </form>

          <footer class="privacy">
            Audio is held in a rolling in-memory buffer, never written to disk. Your API key is sent
            only as part of the Gemini request you trigger. Session log is cleared when the app closes.
          </footer>
        </>
      </Show>

      <Show when={activeTab() === 'history'}>
        <section class="session-log">
          <label class="field history-search">
            <span class="field-label">Search history</span>
            <input
              type="search"
              placeholder="Find by quote, claim, lens…"
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
            />
          </label>
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
