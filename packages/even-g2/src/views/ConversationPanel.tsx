import { SettingsIcon } from './SettingsUi';
import { createEffect, on, createMemo, createSignal, For, Show } from 'solid-js';
import { CONVERSATION_PROFILES, DEFAULT_CONVERSATION, collectConversationRecords, exportConversation, resultText } from '@veritaslens/core';
import type { ConversationPreferences, ConversationRecord, HistoryEntry } from '@veritaslens/core';
import { appPhase, settings, saveConversationPreferences, saveAutoModeEnabled, sessionHistory, recordingPaused, liveCaptionText, liveCaptionStatus, updateHistoryEntry } from '@/state/store';
import { getBridge } from '@/runtime/bridge';
import { startConversation, requestConversationHelp, pauseConversation, endConversation, providerConfigurationError } from '@/runtime/lifecycle';

const write = (key: string, value: string) => getBridge().setLocalStorage(key, value);
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export function ConversationPanel() {
  const [draft, setDraft] = createSignal<ConversationPreferences>(structuredClone(settings().conversation ?? DEFAULT_CONVERSATION));
  createEffect(on(() => settings().conversation, value => setDraft(structuredClone(value ?? DEFAULT_CONVERSATION)), { defer: true }));
  const [presetName, setPresetName] = createSignal('');
  const [contextName, setContextName] = createSignal('');
  const [contextBody, setContextBody] = createSignal('');
  const [message, setMessage] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [request, setRequest] = createSignal('');
  const sessionActive = () => ['listening', 'thinking', 'displaying', 'error'].includes(appPhase());
  const run = async (action: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(true); setMessage('');
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not complete this action.'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!await saveConversationPreferences(write, draft())) throw new Error('Could not save session setup.');
    setDraft(structuredClone(settings().conversation!)); setMessage('Session setup saved.');
  };
  const help = (id: string, instruction?: string) => run(async () => { await save(); await requestConversationHelp(id, instruction); });
  return <section class="conversation-card" aria-label="Conversation setup">
    <div class="field-header"><h2>What kind of conversation?</h2></div>
    <div class="conversation-profiles">
      <For each={CONVERSATION_PROFILES}>{profile => <button type="button" class="conversation-profile" aria-pressed={draft().profile === profile.id}
        onClick={() => setDraft(c => ({ ...c, profile: profile.id, tone: profile.id === 'work' ? 'professional' : 'natural' }))}>
        <strong>{profile.name}</strong><span>{profile.description}</span>
      </button>}</For>
    </div>
    <div class="conversation-buttons">
      <button type="button" class="primary" disabled={busy() || providerConfigurationError(settings()) !== null}
        onClick={() => void run(async () => { await save(); await startConversation(CONVERSATION_PROFILES.find(p => p.id === draft().profile)!.defaultLens); })}>
        {sessionActive() ? 'Use this setup' : `Start ${CONVERSATION_PROFILES.find(p => p.id === draft().profile)!.name}`}
      </button>
      <button type="button" class="secondary" onClick={() => void run(save)} disabled={busy()}>Save setup</button>
    </div>
    <details class="conversation-disclosure"><summary>Goals, notes &amp; saved setups<SettingsIcon name="chevron" /></summary><div class="conversation-preparation">
    <label class="conversation-field">My goal <span class="field-hint">Optional — you can start without preparation.</span>
      <input value={draft().goal} maxLength={1000} placeholder={CONVERSATION_PROFILES.find(p => p.id === draft().profile)!.goal}
        onInput={e => setDraft(c => ({ ...c, goal: e.currentTarget.value }))} />
    </label>

      <label class="conversation-field">Boundaries and constraints<textarea maxLength={1000} value={draft().constraints} placeholder="For example: clarify scope before agreeing to a deadline."
        onInput={e => setDraft(c => ({ ...c, constraints: e.currentTarget.value }))} /></label>
      <label class="conversation-field">Response style<select value={draft().tone} onChange={e => setDraft(c => ({ ...c, tone: e.currentTarget.value as ConversationPreferences['tone'] }))}>
        <option value="natural">Natural</option><option value="brief">Brief</option><option value="professional">Professional</option>
      </select></label>
      <label class="conversation-field">Cue duration<select value={draft().cueDurationSec} onChange={e => setDraft(c => ({ ...c, cueDurationSec: Number(e.currentTarget.value) }))}>
        <option value={10}>10 seconds</option><option value={20}>20 seconds</option><option value={60}>60 seconds</option><option value={120}>2 minutes</option>
      </select><span class="field-hint">Pin a cue to keep it visible. Dismissed cues remain in history.</span></label>
      <h3>Selected background</h3><p class="field-hint">Choose only the person or project notes relevant to this session. Selected notes are included in assistance requests.</p>
      <For each={draft().contexts}>{context => <div class="conversation-context">
        <label><input type="checkbox" checked={draft().selectedContextIds.includes(context.id)} onChange={e => {
          const checked = e.currentTarget.checked; setDraft(c => ({ ...c, selectedContextIds: checked ? [...c.selectedContextIds, context.id] : c.selectedContextIds.filter(id => id !== context.id) }));
        }} /> {context.label}</label>
        <p>{context.body}</p><button type="button" class="secondary" onClick={() => setDraft(c => ({ ...c, contexts: c.contexts.filter(x => x.id !== context.id), selectedContextIds: c.selectedContextIds.filter(id => id !== context.id) }))}>Remove note</button>
      </div>}</For>
      <label class="conversation-field">Note name<input value={contextName()} maxLength={80} onInput={e => setContextName(e.currentTarget.value)} placeholder="Person or project" /></label>
      <label class="conversation-field">Background note<textarea value={contextBody()} maxLength={4000} onInput={e => setContextBody(e.currentTarget.value)} /></label>
      <button type="button" class="secondary" disabled={!contextName().trim() || !contextBody().trim() || draft().contexts.length >= 20} onClick={() => {
        const id = newId(); setDraft(c => ({ ...c, contexts: [...c.contexts, { id, label: contextName().trim(), body: contextBody().trim() }], selectedContextIds: [...c.selectedContextIds, id] })); setContextName(''); setContextBody('');
      }}>Add selected note</button>
      <h3>Saved setups</h3><For each={draft().presets}>{preset => <div class="conversation-buttons">
        <button type="button" class="secondary" onClick={() => setDraft(c => ({ ...c, profile: preset.profile, goal: preset.goal, constraints: preset.constraints, selectedContextIds: [...preset.selectedContextIds] }))}>{preset.name}</button>
        <button type="button" class="secondary" aria-label={`Remove ${preset.name}`} onClick={() => setDraft(c => ({ ...c, presets: c.presets.filter(p => p.id !== preset.id) }))}>Remove</button>
      </div>}</For>
      <label class="conversation-field">Save this setup as<input value={presetName()} maxLength={60} placeholder="Project review, interview, dinner…" onInput={e => setPresetName(e.currentTarget.value)} /></label>
      <button type="button" class="secondary" disabled={!presetName().trim() || draft().presets.length >= 12} onClick={() => {
        const c = draft(); setDraft({ ...c, presets: [...c.presets, { id: newId(), name: presetName().trim(), profile: c.profile, goal: c.goal, constraints: c.constraints, selectedContextIds: [...c.selectedContextIds] }] }); setPresetName(''); void run(save);
      }}>Save named setup</button>
    </div></details>
    <Show when={sessionActive()}><div class="conversation-live">
      <h3>Help during the conversation</h3><p class="field-hint">Actions reuse the latest captured exchange. Double-tap on glasses captures a new exchange.</p>
      <div class="conversation-buttons"><For each={[
        ['respond', 'Reply'], ['eli5', 'Explain'], ['fact-checker', 'Check'], ['key-questions', 'Ask'], ['commitments', 'Remember'], ['repair', 'Clarify / disagree'], ['catch-up', 'Catch me up'], ['translation', 'Translate'],
      ]}>{([id, label]) => <button type="button" class="secondary" disabled={busy() || appPhase() === 'thinking' || !sessionActive()} onClick={() => void help(id)}>{label}</button>}</For></div>
      <details><summary>Ask, refine, or correct</summary>
      <label class="conversation-field">Ask about captured speech or correct a result<input value={request()} maxLength={1000} onInput={e => setRequest(e.currentTarget.value)} placeholder="What did we decide? / The name was Alex." /></label>
      <div class="conversation-buttons">
        <button type="button" class="secondary" disabled={!request().trim() || busy() || !sessionActive()} onClick={() => void help('catch-up', request())}>Ask about session</button>
        <button type="button" class="secondary" disabled={!request().trim() || busy() || !sessionActive()} onClick={() => void help('refine', request())}>Correct / refine</button>
        <button type="button" class="secondary" disabled={busy() || !sessionActive()} onClick={() => void help('refine', 'Make the previous answer shorter.')}>Shorter</button>
        <button type="button" class="secondary" disabled={busy() || !sessionActive()} onClick={() => void help('refine', 'Make the suggested response more natural.')}>More natural</button>
      </div>
      </details>
      <label class="toggle-row"><input type="checkbox" checked={settings().autoModeEnabled} onChange={e => { const on = e.currentTarget.checked; void run(() => saveAutoModeEnabled(write, on)); }} /><span>Hands-free assistance</span></label>
      <label class="toggle-row"><input type="checkbox" checked={draft().captionsEnabled} onChange={e => { const on = e.currentTarget.checked; setDraft(c => ({ ...c, captionsEnabled: on })); void run(save); }} /><span>Live captions — sends speech to your configured speech-to-text host while listening</span></label>
      <Show when={draft().captionsEnabled}><div class="conversation-caption" role="status"><small>{liveCaptionStatus() || 'Start a session to see captions.'}</small><p>{liveCaptionText()}</p></div></Show>
      <Show when={sessionActive()}><div class="conversation-buttons">
        <button type="button" class="secondary" disabled={busy()} onClick={() => void run(pauseConversation)}>{recordingPaused() ? 'Resume microphone' : 'Pause microphone'}</button>
        <button type="button" class="secondary" disabled={busy()} onClick={() => void run(endConversation)}>End session</button>
      </div></Show>
    </div></Show>
    <p class="field-hint" role="status">{message()}</p>
  </section>;
}

export function ConversationReview(props: { entries: HistoryEntry[] }) {
  const records = createMemo(() => collectConversationRecords(props.entries));
  const [message, setMessage] = createSignal('');
  const update = async (entry: HistoryEntry, patch: Parameters<typeof updateHistoryEntry>[1]) => {
    try { await updateHistoryEntry(entry.id, patch, write); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save correction.'); }
  };
  const correct = (record: ConversationRecord, field: 'owner' | 'ownerRole' | 'deadline' | 'status' | 'text', value: string) => {
    const entry = [...props.entries].reverse().find(e => e.result.type === 'assistance' && e.result.records.some(r => r.id === record.id));
    if (entry?.result.type !== 'assistance') return;
    void update(entry, { result: { ...entry.result, records: entry.result.records.map(r => r.id === record.id ? { ...r, [field]: value.slice(0, field === 'text' ? 200 : 80) } : r) } });
  };
  const download = (selectedOnly = false) => {
    const url = URL.createObjectURL(new Blob([exportConversation(props.entries, selectedOnly)], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'veritaslens-conversation.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section class="conversation-card" aria-label="Conversation review">
    <h2>Decisions, commitments & open questions</h2><p class="field-hint">Captured moments only. Check the evidence and correct details before relying on them.</p>
    <Show when={records().length > 0} fallback={<p class="field-hint">No structured items captured. Use Remember during the session.</p>}>
      <For each={['decision', 'my-commitment', 'other-commitment', 'unassigned-commitment', 'question'] as const}>{kind => <div><h3>{kind === 'decision' ? 'Decisions' : kind === 'my-commitment' ? 'My commitments' : kind === 'other-commitment' ? 'Other commitments' : kind === 'unassigned-commitment' ? 'Unassigned commitments' : 'Open questions'}</h3>
        <For each={records().filter(r => kind === 'decision' || kind === 'question' ? r.kind === kind : r.kind === 'commitment' && (kind === 'my-commitment' ? r.ownerRole === 'wearer' : kind === 'other-commitment' ? r.ownerRole === 'other' : !r.ownerRole || r.ownerRole === 'unknown'))}>{record => <div class="conversation-context">
          <label class="conversation-field">Item<input value={record.text} onBlur={e => correct(record, 'text', e.currentTarget.value)} /></label>
          <label class="conversation-field">Status<select value={record.status} onChange={e => correct(record, 'status', e.currentTarget.value)}>
            <option value="proposed">Proposed</option><option value="agreed">Agreed</option><option value="open">Open</option><option value="completed">Completed</option>
          </select></label>
          <label class="conversation-field">Whose commitment?<select value={record.ownerRole ?? 'unknown'} onChange={e => correct(record, 'ownerRole', e.currentTarget.value)}><option value="unknown">Unassigned / unknown</option><option value="wearer">Mine</option><option value="other">Someone else</option></select></label>
          <div class="conversation-profiles"><label class="conversation-field">Owner<input value={record.owner} placeholder="Not stated" onBlur={e => correct(record, 'owner', e.currentTarget.value)} /></label>
          <label class="conversation-field">Deadline<input value={record.deadline} placeholder="No deadline agreed" onBlur={e => correct(record, 'deadline', e.currentTarget.value)} /></label></div>
          <blockquote>{record.quote}</blockquote>
        </div>}</For>
      </div>}</For>
    </Show>
    <div class="conversation-buttons"><button type="button" class="secondary" onClick={() => download()}>Export session</button><button type="button" class="secondary" disabled={!props.entries.some(e => e.pinned)} onClick={() => download(true)}>Export pinned items</button></div>
    <details><summary>Pin, rate, or save a moment as background</summary><For each={props.entries}>{entry => <div class="conversation-context"><p>{entry.question || resultText(entry.result).slice(0, 140)}</p>
      <div class="conversation-buttons"><button type="button" class="secondary" aria-pressed={!!entry.pinned} onClick={() => void update(entry, { pinned: !entry.pinned })}>{entry.pinned ? 'Unpin' : 'Pin'}</button>
      <button type="button" class="secondary" aria-pressed={entry.feedback === 'useful'} onClick={() => void update(entry, { feedback: 'useful' })}>Useful</button>
      <button type="button" class="secondary" aria-pressed={entry.feedback === 'not-useful'} onClick={() => void update(entry, { feedback: 'not-useful' })}>Not useful</button>
      <button type="button" class="secondary" onClick={() => void (async () => {
        try { const c = settings().conversation ?? DEFAULT_CONVERSATION;
          if (c.contexts.length >= 20) throw new Error('Remove a background note before adding another.');
          const ok = await saveConversationPreferences(write, { ...c, contexts: [...c.contexts, { id: newId(), label: entry.question.slice(0, 80) || 'Saved moment', body: `Saved interpretation (verify before reuse): ${resultText(entry.result)}\nHeard: ${entry.quote}`.slice(0, 4000) }] });
          if (!ok) throw new Error('Could not save background note.'); setMessage('Saved as background. Select it in your next session setup.');
        } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save background.'); }
      })()}>Save as background</button></div>
    </div>}</For></details><p role="status" class="field-hint">{message()}</p>
  </section>;
}

export function LatestConversationReview() {
  const latestSession = createMemo(() => sessionHistory().at(-1)?.sessionId);
  return <ConversationReview entries={sessionHistory().filter(e => e.sessionId === latestSession())} />;
}
