import { createMemo, createSignal, For, Show, type Component } from 'solid-js';
import {
  addCustomPersona,
  deviceStatus,
  removeCustomPersona,
  saveGeminiKey,
  saveGeminiModel,
  saveResponseLanguage,
  settings,
} from '@/state/store';
import { getBridge } from '@/runtime/bridge';
import { isHudRunning, refreshHudPage, startHudRuntime } from '@/runtime/lifecycle';
import { GEMINI_MODELS, LANGUAGES, type GeminiModel, type LanguageCode } from '@/types';
import { personas } from '@/personas';

export const SettingsView: Component = () => {
  const [draftKey, setDraftKey] = createSignal(settings().geminiApiKey);
  const [draftModel, setDraftModel] = createSignal<GeminiModel>(settings().geminiModel);
  const [draftLanguage, setDraftLanguage] = createSignal<LanguageCode>(settings().responseLanguage);
  const [saveState, setSaveState] = createSignal<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [testState, setTestState] = createSignal<'idle' | 'running' | 'ok' | 'fail'>('idle');
  const [testMessage, setTestMessage] = createSignal<string>('');

  // Custom-lens form state
  const [isAddingLens, setIsAddingLens] = createSignal(false);
  const [lensName, setLensName] = createSignal('');
  const [lensDesc, setLensDesc] = createSignal('');
  const [lensPrompt, setLensPrompt] = createSignal('');
  const [lensError, setLensError] = createSignal<string | null>(null);

  const lensFormValid = createMemo(
    () => lensName().trim().length > 0 && lensPrompt().trim().length > 0,
  );

  const resetLensForm = () => {
    setLensName('');
    setLensDesc('');
    setLensPrompt('');
    setLensError(null);
  };

  const onAddLens = async () => {
    if (!lensFormValid()) return;
    setLensError(null);
    try {
      const bridge = getBridge();
      await addCustomPersona(
        (k, v) => bridge.setLocalStorage(k, v),
        (k) => bridge.getLocalStorage(k),
        {
          name: lensName().trim(),
          description: lensDesc().trim() || 'Custom lens',
          prompt: lensPrompt().trim(),
        },
      );
      resetLensForm();
      setIsAddingLens(false);
      if (isHudRunning()) await refreshHudPage();
    } catch (err) {
      setLensError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRemoveLens = async (id: string) => {
    try {
      const bridge = getBridge();
      await removeCustomPersona(
        (k, v) => bridge.setLocalStorage(k, v),
        (k) => bridge.getLocalStorage(k),
        id,
      );
      if (isHudRunning()) await refreshHudPage();
    } catch (err) {
      setLensError(err instanceof Error ? err.message : String(err));
    }
  };

  const isConfigured = createMemo(() => settings().geminiApiKey.trim().length >= 10);
  const canSave = createMemo(() => draftKey().trim().length >= 10);

  const onSave = async () => {
    setSaveState('saving');
    try {
      const bridge = getBridge();
      const setLs = (k: string, v: string) => bridge.setLocalStorage(k, v);
      const [keyOk, modelOk, langOk] = await Promise.all([
        saveGeminiKey(setLs, draftKey().trim()),
        saveGeminiModel(setLs, draftModel()),
        saveResponseLanguage(setLs, draftLanguage()),
      ]);
      if (keyOk && modelOk && langOk) {
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
          <Show when={!isAddingLens()}>
            <button
              type="button"
              class="link-button"
              onClick={() => {
                resetLensForm();
                setIsAddingLens(true);
              }}
            >
              + Add lens
            </button>
          </Show>
        </div>

        <ul class="lens-list">
          <For each={personas()}>
            {(p) => (
              <li class="lens-row">
                <div class="lens-info">
                  <strong>{p.name}</strong>
                  <span class="lens-desc">{p.description}</span>
                </div>
                <Show when={!p.builtin}>
                  <button
                    type="button"
                    class="link-button danger"
                    onClick={() => void onRemoveLens(p.id)}
                    title={`Remove "${p.name}"`}
                  >
                    Remove
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>

        <Show when={isAddingLens()}>
          <div class="lens-form">
            <input
              type="text"
              placeholder="Name (e.g. Translator)"
              value={lensName()}
              onInput={(e) => setLensName(e.currentTarget.value)}
              maxLength={32}
            />
            <input
              type="text"
              placeholder="Short description (optional)"
              value={lensDesc()}
              onInput={(e) => setLensDesc(e.currentTarget.value)}
              maxLength={120}
            />
            <textarea
              placeholder="Describe what this lens should do with the last 30 seconds of audio. e.g. 'Translate the speech to English.' or 'Summarize the conversation into action items.' or 'Tell me if I'm talking too much.'"
              value={lensPrompt()}
              onInput={(e) => setLensPrompt(e.currentTarget.value)}
              rows={5}
            />
            <Show when={lensError()}>
              <span class="status err">{lensError()}</span>
            </Show>
            <div class="lens-form-actions">
              <button
                type="button"
                class="primary"
                onClick={() => void onAddLens()}
                disabled={!lensFormValid()}
              >
                Save lens
              </button>
              <button
                type="button"
                class="secondary"
                onClick={() => {
                  setIsAddingLens(false);
                  resetLensForm();
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Show>
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
        Audio is held in a 30-second rolling in-memory buffer, never written to disk. Your API key
        is sent only as part of the Gemini request you trigger.
      </footer>
    </main>
  );
};
