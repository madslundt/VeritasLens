/* @refresh reload */
import { render } from 'solid-js/web';
import { App } from './App';
import { initBridge } from './runtime/bridge';
import { startHudRuntime } from './runtime/lifecycle';
import {
  loadHistory,
  loadMeetingPrepSections,
  loadSettings,
  pushDebugEvent,
  setAppMode,
  setAppPhase,
  setAvailableModels,
  setDeviceStatus,
  setErrorMessage,
  setModelsLoading,
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

    window.addEventListener('beforeunload', () => {
      try { disposeLaunchSource(); } catch { /* SDK may already be torn down */ }
      try { disposeDeviceStatus(); } catch { /* SDK may already be torn down */ }
    }, { once: true });

    await loadSettings((k) => bridge.getLocalStorage(k));
    await loadHistory((k) => bridge.getLocalStorage(k));
    await loadMeetingPrepSections((k) => bridge.getLocalStorage(k));

    setAvailableModels([settings().geminiModel]);

    const apiKey = settings().geminiApiKey;
    if (apiKey.trim().length >= 10) {
      setModelsLoading(true);
      void import('./llm/gemini').then(({ fetchAvailableModels }) =>
        fetchAvailableModels(apiKey)
          .then((models) => { if (models.length > 0) setAvailableModels(models); })
          .catch((err) => {
            // Keep the static fallback in the picker, but surface why the live
            // model list is missing so a wedged API key / network is debuggable.
            pushDebugEvent({
              label: 'model-fetch-fail',
              detail: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => setModelsLoading(false)),
      );
    }

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
