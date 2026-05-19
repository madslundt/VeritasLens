// src/views/SettingsView.tsx
import { createMemo, createSignal, For, Show, type Component } from 'solid-js';
import {
  deviceStatus,
  saveAutoSummaryEnabled,
  saveAutoSummaryInterval,
  saveBufferDuration,
  saveGeminiKey,
  saveGeminiModel,
  saveResponseLanguage,
  sessionHistory,
  settings,
} from '@/state/store';
import { getBridge } from '@/runtime/bridge';
import { isHudRunning, refreshHudPage, startHudRuntime } from '@/runtime/lifecycle';
import {
  GEMINI_MODELS,
  LANGUAGES,
  type AutoSummaryInterval,
  type BufferDuration,
  type GeminiModel,
  type HistoryEntry,
  type LanguageCode,
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

export const SettingsView: Component = () => {
  const [draftKey, setDraftKey] = createSignal(settings().geminiApiKey);
  const [draftModel, setDraftModel] = createSignal<GeminiModel>(settings().geminiModel);
  const [draftLanguage, setDraftLanguage] = createSignal<LanguageCode>(settings().responseLanguage);
  const [draftBuffer, setDraftBuffer] = createSignal<BufferDuration>(settings().bufferDuration);
  const [draftAutoEnabled, setDraftAutoEnabled] = createSignal(settings().autoSummaryEnabled);
  const [draftAutoInterval, setDraftAutoInterval] = createSignal<AutoSummaryInterval>(settings().autoSummaryInterval);
  const [saveState, setSaveState] = createSignal<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [testState, setTestState] = createSignal<'idle' | 'running' | 'ok' | 'fail'>('idle');
  const [testMessage, setTestMessage] = createSignal('');
  const [expandedId, setExpandedId] = createSignal<string | null>(null);

  const isConfigured = createMemo(() => settings().geminiApiKey.trim().length >= 10);
  const canSave = createMemo(() => draftKey().trim().length >= 10);

  const onSave = async () => {
    setSaveState('saving');
    try {
      const bridge = getBridge();
      const setLs = (k: string, v: string) => bridge.setLocalStorage(k, v);
      const results = await Promise.all([
        saveGeminiKey(setLs, draftKey().trim()),
        saveGeminiModel(setLs, draftModel()),
        saveResponseLanguage(setLs, draftLanguage()),
        saveBufferDuration(setLs, draftBuffer()),
        saveAutoSummaryEnabled(setLs, draftAutoEnabled()),
        saveAutoSummaryInterval(setLs, draftAutoInterval()),
      ]);
      if (results.every(Boolean)) {
        setSaveState('saved');
        setTimeout(() => setSaveState('idle'), 1500);
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

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  const renderDetail = (entry: HistoryEntry) => JSON.stringify(entry.result, null, 2);

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
          <span class="field-label">Model</span>
          <select
            value={draftModel()}
            onChange={(e) => setDraftModel(e.currentTarget.value as GeminiModel)}
          >
            <For each={GEMINI_MODELS}>{(m) => <option value={m}>{m}</option>}</For>
          </select>
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

      <section class="session-log">
        <div class="field-header">
          <span class="field-label">Session Log</span>
        </div>
        <Show
          when={sessionHistory().length > 0}
          fallback={<p class="muted">No analyses yet this session.</p>}
        >
          <ul class="history-list">
            <For each={sessionHistory()}>
              {(entry) => (
                <li class="history-row">
                  <button
                    type="button"
                    class="history-question"
                    onClick={() => setExpandedId((prev) => (prev === entry.id ? null : entry.id))}
                  >
                    <span class="history-badge">[{entry.badge}]</span>
                    <span class="history-time">{formatTime(entry.timestamp)}</span>
                    <span class="history-q">{entry.question}</span>
                    <span class="history-lens">{entry.lensName}</span>
                  </button>
                  <Show when={expandedId() === entry.id}>
                    <div class="history-detail"><pre>{renderDetail(entry)}</pre></div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <footer class="privacy">
        Audio is held in a rolling in-memory buffer, never written to disk. Your API key is sent
        only as part of the Gemini request you trigger. Session log is cleared when the app closes.
      </footer>
    </main>
  );
};
