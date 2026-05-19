import { Show, type Component } from 'solid-js';
import { appPhase, errorMessage } from './state/store';
import { SettingsView } from './views/SettingsView';

export const App: Component = () => {
  return (
    <Show
      when={appPhase() !== 'booting'}
      fallback={<div class="boot-screen">Connecting to Even App…</div>}
    >
      <Show when={errorMessage()}>
        {(msg) => <div class="error-banner" role="alert">{msg()}</div>}
      </Show>
      <SettingsView />
    </Show>
  );
};
