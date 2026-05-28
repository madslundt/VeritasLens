/* @refresh reload */
import { render } from 'solid-js/web';
import { App } from './App';
import { initBridge } from './runtime/bridge';
import { attachBootstrapTeardown } from './runtime/bootstrap';
import { startHudRuntime } from './runtime/lifecycle';
import {
  loadHistory,
  loadMeetingPrepSections,
  loadSettings,
  setAppMode,
  setAppPhase,
  setAvailableModels,
  setDeviceStatus,
  setErrorMessage,
  settings,
} from './state/store';

import './main.css';

async function bootstrap(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('#root not found in index.html');
  }

  render(() => <App />, root);

  try {
    const bridge = await initBridge();

    // Phone-side WebView mode follows the LaunchSource hint; HUD on glasses
    // runs independently of which mode the phone is in.
    // Capture the SDK's unsubscribe callbacks so a host that keeps the JS
    // context alive across WebView reloads (some embedders do) won't
    // accumulate stale listeners on each reboot.
    const disposeLaunchSource = bridge.onLaunchSource((source) => {
      setAppMode(source === 'glassesMenu' ? 'hud' : 'settings');
    });

    const disposeDeviceStatus = bridge.onDeviceStatusChanged((status) => setDeviceStatus(status));

    // Kept for the teardown helper to abort any future bootstrap-scoped fetch
    // a follow-up may introduce; currently the only thing the teardown does is
    // dispose the SDK subscriptions below.
    const bootstrapAbort = new AbortController();

    window.addEventListener(
      'beforeunload',
      attachBootstrapTeardown(bootstrapAbort, disposeLaunchSource, disposeDeviceStatus),
      { once: true },
    );

    await loadSettings((k) => bridge.getLocalStorage(k));
    await loadHistory((k) => bridge.getLocalStorage(k));
    await loadMeetingPrepSections((k) => bridge.getLocalStorage(k));

    // Picker starts with just the persisted model. Live model-list fetches
    // are user-initiated only (Settings → Refresh models) so the store-review
    // network monitor never sees an unsolicited call to Google's API on boot
    // — past submissions were rejected for unsolicited 4xx responses from a
    // stale persisted key.
    setAvailableModels([settings().geminiModel]);

    setAppPhase('idle');

    // Always push a page to the glasses on boot. If the user is configured
    // they get the persona picker; otherwise they get a "configure on phone"
    // message so the HUD is never silently blank.
    try {
      await startHudRuntime();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  } catch (err) {
    setErrorMessage(err instanceof Error ? err.message : String(err));
    setAppPhase('error');
  }
}

void bootstrap();
