/* @refresh reload */
import { render } from 'solid-js/web';
import { App } from './App';
import { initBridge } from './runtime/bridge';
import { startHudRuntime } from './runtime/lifecycle';
import {
  loadSettings,
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
    bridge.onLaunchSource((source) => {
      setAppMode(source === 'glassesMenu' ? 'hud' : 'settings');
    });

    bridge.onDeviceStatusChanged((status) => setDeviceStatus(status));

    await loadSettings((k) => bridge.getLocalStorage(k));

    setAvailableModels([settings().geminiModel]);

    const apiKey = settings().geminiApiKey;
    if (apiKey.trim().length >= 10) {
      setModelsLoading(true);
      void import('./llm/gemini').then(({ fetchAvailableModels }) =>
        fetchAvailableModels(apiKey)
          .then((models) => { if (models.length > 0) setAvailableModels(models); })
          .catch(() => { /* keep static fallback */ })
          .finally(() => setModelsLoading(false)),
      );
    }

    setAppPhase('idle');

    // Always push a page to the glasses on boot. If the user is configured
    // they get the persona picker; otherwise they get a "configure on phone"
    // message so the HUD is never silently blank.
    void settings; // signal access kept warm for future config-change reactivity
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
