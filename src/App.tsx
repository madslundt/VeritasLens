import { Show, type Component } from 'solid-js';
import { appPhase, errorMessage, setErrorMessage } from './state/store';
import { SettingsView } from './views/SettingsView';

export const App: Component = () => {
  return (
    <Show
      when={appPhase() !== 'booting'}
      fallback={<div class="boot-screen">Connecting to Even App…</div>}
    >
      <Show when={errorMessage()}>
        {(msg) => (
          <div class="error-banner" role="alert" onClick={() => setErrorMessage(null)}>
            {msg()}
            <span class="error-dismiss">✕</span>
          </div>
        )}
      </Show>
      <SettingsView />
    </Show>
  );
};
