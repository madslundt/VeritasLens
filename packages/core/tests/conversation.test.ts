import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeConversationPreferences, DEFAULT_CONVERSATION, conversationDirective, profileCandidates, capturedConversationContext, collectConversationRecords, exportConversation } from '../src/runtime/conversation';
import { parseAssistanceResponse } from '../src/personas/assistance';
import { parseAutoClassifierResponse } from '../src/personas/auto';
import { LiveCaptionCapture } from '../src/runtime/captions';
import type { HistoryEntry, ConversationRecord } from '../src/types';

const proposal: ConversationRecord = { id: 'deployment', kind: 'commitment', status: 'proposed', text: 'Send the deployment plan', owner: '', ownerRole: 'unknown', deadline: '', quote: 'Maybe we could send the plan Friday.' };
const entry = (records: ConversationRecord[], timestamp = 1): HistoryEntry => ({ id: String(timestamp), timestamp, sessionId: 's', lensId: 'commitments', lensName: 'Remember', question: 'Plan', badge: '', quote: proposal.quote, result: { type: 'assistance', action: 'commitments', headline: 'Plan proposed', detail: '', quote: proposal.quote, records } });

describe('conversation profiles and evidence', () => {
  it('recovers corrupt preferences and removes dangling background references', () => {
    expect(normalizeConversationPreferences('{bad')).toEqual(DEFAULT_CONVERSATION);
    const c = normalizeConversationPreferences({ profile: 'work', cueDurationSec: -10, contexts: [{ id: 'p', label: 'Project', body: 'Scope' }], selectedContextIds: ['p', 'missing', 'p'], presets: [{ id: '1', name: 'Meeting', selectedContextIds: ['missing'] }] });
    expect(c.profile).toBe('work'); expect(c.cueDurationSec).toBe(5); expect(c.selectedContextIds).toEqual(['p']); expect(c.presets[0].selectedContextIds).toEqual([]);
  });
  it('includes only selected notes, goal, and boundaries in the provider prompt', () => {
    const c = normalizeConversationPreferences({ goal: 'Clarify scope', constraints: 'Do not agree yet', contexts: [{ id: 'a', label: 'Selected', body: 'Public scope' }, { id: 'b', label: 'Private', body: 'Unrelated private note' }], selectedContextIds: ['a'] });
    const prompt = conversationDirective(c);
    expect(prompt).toContain('Clarify scope'); expect(prompt).toContain('Do not agree yet'); expect(prompt).toContain('Public scope'); expect(prompt).not.toContain('Unrelated private note');
  });
  it('keeps unsolicited argument criticism out of all standard profiles', () => {
    const candidates = ['respond', 'eli5', 'commitments', 'logical-fallacy', 'bias-detector', 'devils-advocate'];
    expect(profileCandidates('everyday', candidates)).toEqual(['respond', 'eli5']);
    expect(profileCandidates('work', candidates)).toEqual(['respond', 'eli5', 'commitments']);
    expect(profileCandidates('understand', candidates)).toEqual(['respond', 'eli5']);
  });
  it('accepts Auto abstention without silently routing to another lens', () => { expect(parseAutoClassifierResponse('{"chosenLensId":"none"}', ['respond'])).toEqual({ chosenLensId: 'none' }); });
  it('permits no useful response and omits records missing evidence', () => {
    expect(() => parseAssistanceResponse('{"useful":false,"headline":""}', 'respond')).toThrow('No relevant content');
    const result = parseAssistanceResponse(JSON.stringify({ useful: true, headline: 'No deadline agreed', records: [proposal, { ...proposal, id: 'fake', quote: '' }] }), 'commitments');
    expect(result.type).toBe('assistance'); if (result.type !== 'assistance') return;
    expect(result.records).toHaveLength(1); expect(result.records[0].status).toBe('proposed'); expect(result.records[0].deadline).toBe('');
  });
  it('updates an existing proposal only through a later explicit record and exports ownership separately', () => {
    const agreed = { ...proposal, status: 'agreed' as const, ownerRole: 'wearer' as const, owner: 'Alex', quote: 'I will send it tomorrow.' };
    const entries = [entry([proposal]), { ...entry([agreed], 2), quote: agreed.quote, pinned: true }];
    expect(collectConversationRecords(entries)).toEqual([agreed]);
    const exported = exportConversation(entries, true);
    expect(exported).toContain('My commitments'); expect(exported).toContain('AGREED'); expect(exported).toContain('No deadline agreed'); expect(exported).toContain(agreed.quote); expect(exported).not.toContain('Maybe we could');
  });
  it('keeps bounded evidence valid JSON and distinguishes interpretations from speech', () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({ ...entry([], i + 1), quote: 'x'.repeat(2000), result: { type: 'assistance' as const, action: 'respond' as const, headline: `Moment ${i}`, detail: 'y'.repeat(2000), quote: '', records: [] } }));
    const prompt = capturedConversationContext(entries, 'Transcript '.repeat(2000));
    const payload = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
    expect(prompt).toContain('partial coverage'); expect(payload.transcript.length).toBeLessThanOrEqual(12000);
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(24000); expect(payload.moments.at(-1).result).toContain('Moment 79');
  });
});

afterEach(() => vi.useRealTimers());
describe('live caption lifecycle', () => {
  const pcm = new Uint8Array(32000); new Int16Array(pcm.buffer).fill(1000);
  it('serializes requests and suppresses late text after stopping', async () => {
    vi.useFakeTimers();
    let complete!: (text: string) => void;
    const transcribe = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
    const onCaption = vi.fn(); const source = vi.fn(() => ({ pcm, sampleRate: 16000, endOffset: pcm.length }));
    const capture = new LiveCaptionCapture({ source, onCaption, onError: vi.fn(), transcribe, intervalMs: 1000 });
    capture.start(); await vi.advanceTimersByTimeAsync(1000); expect(transcribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000); expect(transcribe).toHaveBeenCalledTimes(1);
    capture.stop(); complete('Stale speech'); await Promise.resolve(); await Promise.resolve();
    expect(onCaption).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('advances successful captions to avoid resending the same chunk', async () => {
    vi.useFakeTimers(); const onCaption = vi.fn();
    const source = vi.fn((cursor: number) => ({ pcm: cursor ? new Uint8Array(0) : pcm, sampleRate: 16000, endOffset: pcm.length }));
    const transcribe = vi.fn(async () => 'Hello'); const capture = new LiveCaptionCapture({ source, transcribe, onCaption, onError: vi.fn(), intervalMs: 1000 });
    capture.start(); await vi.advanceTimersByTimeAsync(3000);
    expect(transcribe).toHaveBeenCalledTimes(1); expect(source).toHaveBeenLastCalledWith(pcm.length); expect(onCaption).toHaveBeenCalledWith('Hello', expect.any(Number), expect.any(Number)); capture.stop();
  });
  it('does not upload silence and can restart from a fresh audio cursor', async () => {
    vi.useFakeTimers(); const transcribe = vi.fn(async () => 'Hello');
    const source = vi.fn(() => ({ pcm: new Uint8Array(32000), sampleRate: 16000, endOffset: 32000 }));
    const capture = new LiveCaptionCapture({ source, transcribe, onCaption: vi.fn(), onError: vi.fn(), intervalMs: 1000 });
    capture.start(); await vi.advanceTimersByTimeAsync(1000); expect(transcribe).not.toHaveBeenCalled(); capture.stop();
    capture.start(64000); await vi.advanceTimersByTimeAsync(1000); expect(source).toHaveBeenLastCalledWith(64000); capture.stop();
  });
});
