import { SettingsIcon, lensDescription } from '@/views/SettingsUi';
import { createEffect, on, createMemo, createSignal, For, Show, type Setter } from 'solid-js';
import { CONVERSATION_PROFILES, DEFAULT_CONVERSATION, getPersona, getPickerPersonas, getSpecializedPersonas, profileCandidates, AUTO_LENS_CANDIDATES, collectConversationRecords, exportConversation, resultText } from '@veritaslens/core';
import type { ConversationPreferences, ConversationRecord, HistoryEntry } from '@veritaslens/core';
import { appPhase, settings, saveConversationPreferences, activePersona, sessionHistory, recordingPaused, liveCaptionText, liveCaptionStatus, updateHistoryEntry } from '@/state/store';
import { getBridge } from '@/runtime/bridge';
import { startConversation, requestConversationHelp, pauseConversation, endConversation, providerConfigurationError } from '@/runtime/lifecycle';

const write = (key: string, value: string) => getBridge().setLocalStorage(key, value);
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export function ConversationPanel(props: { onOpenSettings: () => void }) {
  const lenses = () => [...getPickerPersonas(), ...getSpecializedPersonas()];
  const [selectedLens, setSelectedLens] = createSignal(activePersona());
  createEffect(on(activePersona, id => setSelectedLens(id), { defer: true }));
  const [message, setMessage] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [request, setRequest] = createSignal('');
  const profile = () => CONVERSATION_PROFILES.find(p => p.id === settings().conversation?.profile)
    ?? CONVERSATION_PROFILES.find(p => p.id === DEFAULT_CONVERSATION.profile)!;
  const sessionActive = () => ['listening', 'thinking', 'displaying', 'error'].includes(appPhase());
  const run = async (action: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(true); setMessage('');
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not complete this action.'); }
    finally { setBusy(false); }
  };
  const help = (id: string, instruction?: string) => run(() => requestConversationHelp(id, instruction));
  return <section class="conversation-card" aria-label="Session">
    <h2>{sessionActive() ? 'Current session' : 'Start a session'}</h2>
    <p class="field-hint">A session keeps your captured moments together. Choose a lens for the help you need.</p>
    <p role="status">Profile: {profile().name} · Lens: {getPersona(sessionActive() ? activePersona() : selectedLens())?.name}</p>
    <p class="field-hint">Audio sent per analysis: up to {settings().bufferDuration} seconds. Change audio and conversation preferences in Settings on your phone.</p>
    <label class="conversation-field">Lens<select aria-label="Lens" value={selectedLens()} onChange={e => setSelectedLens(e.currentTarget.value)}>
      <For each={lenses()}>{lens => <option value={lens.id}>{lens.name}</option>}</For>
    </select></label>
    <p class="field-hint">{lensDescription(selectedLens(), getPersona(selectedLens())?.description ?? '')}</p>
    <div class="conversation-buttons">
      <button type="button" class="primary" disabled={busy() || providerConfigurationError(settings()) !== null}
        onClick={() => void run(() => startConversation(selectedLens()))}>
        {sessionActive() ? 'Use selected lens' : `Start ${getPersona(selectedLens())?.name}`}
      </button>
      <button type="button" class="secondary" onClick={props.onOpenSettings}>Conversation settings</button>
    </div>
    <Show when={sessionActive()}><div class="conversation-live">
      <h3>Help during the conversation</h3><p class="field-hint">Actions reuse the latest captured exchange. Double-tap on glasses captures a new exchange.</p>
      <div class="conversation-buttons"><For each={[
        'respond', 'eli5', 'fact-checker', 'key-questions', 'commitments', 'repair', 'catch-up', 'translation',
      ]}>{id => <button type="button" class="secondary" disabled={busy() || appPhase() === 'thinking' || !sessionActive()} onClick={() => void help(id)}>{getPersona(id)!.name}</button>}</For></div>
      <details><summary>Ask, refine, or correct</summary>
      <label class="conversation-field">Ask about captured speech or correct a result<input value={request()} maxLength={1000} onInput={e => setRequest(e.currentTarget.value)} placeholder="What did we decide? / The name was Alex." /></label>
      <div class="conversation-buttons">
        <button type="button" class="secondary" disabled={!request().trim() || busy() || !sessionActive()} onClick={() => void help('catch-up', request())}>Ask about session</button>
        <button type="button" class="secondary" disabled={!request().trim() || busy() || !sessionActive()} onClick={() => void help('refine', request())}>Correct / refine</button>
        <button type="button" class="secondary" disabled={busy() || !sessionActive()} onClick={() => void help('refine', 'Make the previous answer shorter.')}>Shorter</button>
        <button type="button" class="secondary" disabled={busy() || !sessionActive()} onClick={() => void help('refine', 'Make the suggested response more natural.')}>More natural</button>
      </div>
      </details>
      <Show when={settings().conversation?.captionsEnabled}><div class="conversation-caption" role="status"><small>{liveCaptionStatus() || 'Start a session to see captions.'}</small><p>{liveCaptionText()}</p></div></Show>
      <Show when={sessionActive()}><div class="conversation-buttons">
        <button type="button" class="secondary" disabled={busy()} onClick={() => void run(pauseConversation)}>{recordingPaused() ? 'Resume microphone' : 'Pause microphone'}</button>
        <button type="button" class="secondary" disabled={busy()} onClick={() => void run(endConversation)}>End session</button>
      </div></Show>
    </div></Show>
    <p class="field-hint" role="status">{message()}</p>
  </section>;
}

export function ConversationSettings(props: {
  preferences: ConversationPreferences;
  onChange: Setter<ConversationPreferences>;
  disabledAutoLenses: string[];
}) {
  const draft = () => props.preferences;
  const setDraft = props.onChange;
  const [presetName, setPresetName] = createSignal('');
  const [contextName, setContextName] = createSignal('');
  const [contextBody, setContextBody] = createSignal('');
  const autoCandidates = () => profileCandidates(draft().profile, AUTO_LENS_CANDIDATES)
    .filter(id => !props.disabledAutoLenses.includes(id));
  return <section class="conversation-card" aria-label="Conversation settings">
    <h2>Conversation profile</h2>
    <p class="field-hint">Optional context for your lens. Changing a profile keeps your selected lens. Best next help chooses only from the enabled lenses listed below.</p>
    <div class="conversation-profiles">
      <For each={CONVERSATION_PROFILES}>{profile => <button type="button" class="conversation-profile" aria-pressed={draft().profile === profile.id}
        onClick={() => setDraft(c => ({ ...c, profile: profile.id, tone: profile.id === 'work' ? 'professional' : 'natural' }))}>
        <strong>{profile.name}</strong><span>{profile.description}</span>
      </button>}</For>
    </div>
    <p class="field-hint">Best next help can choose: {autoCandidates().map(id => getPersona(id)?.name ?? id).join(', ') || 'No lenses enabled'}. Configure enabled lenses in Lenses → Best next help.</p>
    <label class="toggle-row"><input type="checkbox" checked={draft().captionsEnabled} onChange={e => setDraft(c => ({ ...c, captionsEnabled: e.currentTarget.checked }))} /><span>Live captions — sends speech to your configured speech-to-text host while listening</span></label>
    <label class="conversation-field">Hide answers after<select aria-label="Hide answers after" value={draft().cueDurationSec} onChange={e => setDraft(c => ({ ...c, cueDurationSec: Number(e.currentTarget.value) }))}>
        <option value={10}>10 seconds</option><option value={20}>20 seconds</option><option value={60}>60 seconds</option><option value={120}>2 minutes</option>
    </select><span class="field-hint">How long an answer stays on the glasses. Audio sent per analysis is configured separately below. Pinned answers stay visible.</span></label>
    <details class="conversation-disclosure"><summary>Goals, notes &amp; saved setups<SettingsIcon name="chevron" /></summary><div class="conversation-preparation">
    <label class="conversation-field">My goal <span class="field-hint">Optional — you can start without preparation.</span>
      <input value={draft().goal} maxLength={1000} placeholder={CONVERSATION_PROFILES.find(p => p.id === draft().profile)!.goal}
        onInput={e => setDraft(c => ({ ...c, goal: e.currentTarget.value }))} />
    </label>

      <label class="conversation-field">Boundaries and constraints<textarea maxLength={1000} value={draft().constraints} placeholder="For example: clarify scope before agreeing to a deadline."
        onInput={e => setDraft(c => ({ ...c, constraints: e.currentTarget.value }))} /></label>
      <label class="conversation-field">Response style<select aria-label="Response style" value={draft().tone} onChange={e => setDraft(c => ({ ...c, tone: e.currentTarget.value as ConversationPreferences['tone'] }))}>
        <option value="natural">Natural</option><option value="brief">Brief</option><option value="professional">Professional</option>
      </select></label>

      <h3>Selected background</h3><p class="field-hint">Choose only the person or project notes relevant to this session. Selected notes are included in assistance requests.</p>
      <Show when={draft().contexts.length > 20}><p role="alert">Keep at most 20 background notes before saving. Remove a note to make room for the notes saved from History.</p></Show>
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
        const c = draft(); setDraft({ ...c, presets: [...c.presets, { id: newId(), name: presetName().trim(), profile: c.profile, goal: c.goal, constraints: c.constraints, selectedContextIds: [...c.selectedContextIds] }] }); setPresetName('');
      }}>Add named setup</button>
    </div></details>
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
    <Show when={records().length > 0} fallback={<p class="field-hint">No structured items captured. Use Decisions &amp; commitments during the session.</p>}>
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
