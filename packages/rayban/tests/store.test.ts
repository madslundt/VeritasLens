import { useStore, AppPhase } from '../src/state/store';

describe('rayban store', () => {
  beforeEach(() => {
    // Reset to initial state between tests.
    useStore.setState(useStore.getInitialState(), true);
  });

  it('starts in idle phase with no result', () => {
    const s = useStore.getState();
    expect(s.appPhase).toBe<AppPhase>('idle');
    expect(s.lastResult).toBeNull();
  });

  it('setAppPhase updates the phase', () => {
    useStore.getState().setAppPhase('listening');
    expect(useStore.getState().appPhase).toBe<AppPhase>('listening');
  });

  it('appendHistoryEntry pushes onto the front and bumps lastResult', () => {
    const entry = {
      id: '1',
      sessionId: 's1',
      timestamp: 1000,
      lensId: 'fact-check',
      lensName: 'Fact Check',
      question: 'q',
      badge: 'b',
      quote: '',
      result: { type: 'fact-check' as const, claims: [] },
    };
    useStore.getState().appendHistoryEntry(entry);
    const s = useStore.getState();
    expect(s.sessionHistory[0]).toEqual(entry);
    expect(s.lastResult).toEqual(entry);
  });

  it('updateSettings merges partial settings', () => {
    useStore.getState().updateSettings({ activeLensId: 'translation' });
    expect(useStore.getState().settings.activeLensId).toBe('translation');
    expect(useStore.getState().settings.cameraEnabled).toBe(true); // default preserved
  });

  it('setGlassesConnection updates HFP and camera flags', () => {
    useStore.getState().setGlassesConnection({ hfpConnected: true, cameraStreaming: true });
    const c = useStore.getState().glassesConnection;
    expect(c.hfpConnected).toBe(true);
    expect(c.cameraStreaming).toBe(true);
  });
});
