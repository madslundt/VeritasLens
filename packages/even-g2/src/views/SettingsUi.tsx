import { createSignal, Match, Show, Switch, type Component, type JSX } from 'solid-js';

type IconName = 'lens' | 'auto' | 'translation' | 'meeting-prep' | 'fact-checker' | 'trivia'
  | 'logical-fallacy' | 'bias-detector' | 'eli5' | 'devils-advocate' | 'key-questions'
  | 'companion' | 'history' | 'search' | 'arrow' | 'ai' | 'settings' | 'eye' | 'eye-off' | 'chevron';

/** One stroke style for the phone UI; decorative icons never label a control. */
export const SettingsIcon: Component<{ name: string; class?: string }> = (props) => (
  <svg class={props.class} viewBox="0 0 24 24" width="24" height="24"
    fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true">
    <Switch fallback={<circle cx="12" cy="12" r="7" />}>
      <Match when={props.name === 'lens'}>
        <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6.5" /><circle cx="12" cy="12" r="3" />
      </Match>
      <Match when={props.name === 'auto'}>
        <path d="m10 3 1.8 5.2L17 10l-5.2 1.8L10 17l-1.8-5.2L3 10l5.2-1.8L10 3ZM19 14l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3M19 2v6M16 5h6" />
      </Match>
      <Match when={props.name === 'translation'}>
        <path d="M3 5h12M8 3v2M12 5c-1 6-4 9-9 11M5 8c1 3 3 6 7 8M13 21l4-10 4 10M15 17h4" />
      </Match>
      <Match when={props.name === 'meeting-prep'}>
        <path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 12h8M8 16h6" />
      </Match>
      <Match when={props.name === 'fact-checker'}>
        <path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" />
      </Match>
      <Match when={props.name === 'trivia'}>
        <path d="M9 18h6M9 21h6M8 14a6 6 0 1 1 8 0c-1 .9-1 2-1 4H9c0-2 0-3-1-4Z" />
      </Match>
      <Match when={props.name === 'logical-fallacy'}>
        <path d="M8 4H4v16h4M16 4h4v16h-4M10 8l4 8M14 8l-4 8" />
      </Match>
      <Match when={props.name === 'bias-detector'}>
        <path d="M3 5h18M3 12h12M3 19h18" /><circle cx="18" cy="12" r="2" />
      </Match>
      <Match when={props.name === 'eli5'}><path d="M4 6h16M4 12h12M4 18h7" /></Match>
      <Match when={props.name === 'devils-advocate'}>
        <path d="M4 7h14l-3-3M20 17H6l3 3M18 7l-3 3M6 17l3-3" />
      </Match>
      <Match when={props.name === 'key-questions'}>
        <circle cx="12" cy="12" r="9" /><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01" />
      </Match>
      <Match when={props.name === 'companion'}>
        <path d="M21 11a9 9 0 0 1-9 9H4l-1 2V11a9 9 0 0 1 18 0Z" /><path d="M8 11h.01M12 11h.01M16 11h.01" />
      </Match>
      <Match when={props.name === 'history'}>
        <path d="M3 11a9 9 0 1 1 2 7M3 5v6h6M12 7v5l4 2" />
      </Match>
      <Match when={props.name === 'search'}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></Match>
      <Match when={props.name === 'arrow'}><path d="M4 12h16M14 6l6 6-6 6" /></Match>
      <Match when={props.name === 'chevron'}><path d="m6 9 6 6 6-6" /></Match>
      <Match when={props.name === 'ai'}>
        <rect x="4" y="6" width="16" height="15" rx="5" /><path d="M12 2v4M2 12h2M20 12h2M9 12h.01M15 12h.01M9 16h6" />
      </Match>
      <Match when={props.name === 'settings'}>
        <path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="var(--bg)" /><circle cx="16" cy="12" r="2" fill="var(--bg)" /><circle cx="8" cy="18" r="2" fill="var(--bg)" />
      </Match>
      <Match when={props.name === 'eye' || props.name === 'eye-off'}>
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />
        <Show when={props.name === 'eye-off'}><path d="m3 3 18 18" /></Show>
      </Match>
    </Switch>
  </svg>
);

export const ApiKeyInput: Component<{
  value: string;
  placeholder: string;
  error?: boolean;
  label?: string;
  onInput: JSX.EventHandlerUnion<HTMLInputElement, InputEvent>;
}> = (props) => {
  const [visible, setVisible] = createSignal(false);
  return (
    <span class="secret-input">
      <input type={visible() ? 'text' : 'password'} autocomplete="off" autocapitalize="off"
        spellcheck={false} placeholder={props.placeholder} value={props.value}
        aria-label={props.label ?? 'API key'} aria-invalid={props.error || undefined}
        classList={{ 'input-error': !!props.error }} onInput={props.onInput} />
      <button type="button" class="secret-toggle" aria-label={visible() ? 'Hide API key' : 'Show API key'}
        aria-pressed={visible()} onClick={() => setVisible((value) => !value)}>
        <SettingsIcon name={visible() ? 'eye-off' : 'eye'} />
      </button>
    </span>
  );
};

export const LENS_DESCRIPTIONS: Partial<Record<IconName, string>> = {
  auto: 'Choose useful help for your profile and goal, or stay quiet.',
  translation: 'Understand another language and find a reply.',
  'meeting-prep': 'Answers grounded in notes you prepare.',
  'fact-checker': 'Check claims against the facts.',
  trivia: 'A direct answer to your next question.',
  'logical-fallacy': 'Find the weak link in an argument.',
  'bias-detector': 'Notice bias and the framing behind words.',
  eli5: 'Turn complex ideas into plain language.',
  'devils-advocate': 'Consider the strongest counterargument.',
  'key-questions': 'Find the questions worth asking next.',
  companion: 'Discover facts and unexpected connections.',
};

export function lensDescription(id: string, fallback: string): string {
  return LENS_DESCRIPTIONS[id as IconName] ?? fallback;
}
