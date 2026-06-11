# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

VeritasLens is a SolidJS + TypeScript single-bundle web app that runs **inside the Even Realities G2 Even App WebView**. There is no companion server. The app talks to the glasses through `@evenrealities/even_hub_sdk` and sends audio snapshots to a wearer-chosen LLM provider on user gesture.

### Supported LLM providers

`src/types.ts` defines `LlmProvider = 'gemini' | 'openai-compatible' | 'claude'`; the `openai-compatible` route fans out across five concrete hosts via `OPENAI_BASE_URLS`. Routing lives in `src/llm/index.ts:callLensStream` (analysis) and `src/llm/gameClient.ts` (the Lens Game). All providers stream structured JSON via `StreamingJsonParser`.

| Provider | Chat host | Audio path | Notes |
|---|---|---|---|
| Gemini (default) | `generativelanguage.googleapis.com` | Inline (`generateContent` with `inlineData` audio) | Default; only provider with `google_search` grounding. `src/llm/gemini.ts`. |
| Claude | `api.anthropic.com` | STT sidecar → tool-use streaming | Always borrows STT from a `SttHost` (Groq Whisper or OpenAI Whisper). `src/llm/claude.ts`. |
| OpenAI | `api.openai.com/v1` | `/audio/transcriptions` (whisper-1) → `/chat/completions` | Self-transcribes. |
| Groq | `api.groq.com/openai/v1` | `/audio/transcriptions` (whisper-large-v3) → `/chat/completions` | Self-transcribes; recommended default STT for Claude and chat-only hosts. |
| OpenRouter | `openrouter.ai/api/v1` | Inline audio (`input_audio` content part) | Model picker filters to audio-capable models via `OPENAI_INLINE_AUDIO_HOSTS`. Whisper sidecar still fires so the tagged transcript matches Gemini's path. |
| DeepSeek | `api.deepseek.com/v1` | Borrowed STT host → chat-completions | `OPENAI_CHAT_ONLY_HOSTS`; needs a separate key for the chosen `SttHost`. |
| Perplexity | `api.perplexity.ai` | Borrowed STT host → chat-completions | Same chat-only pattern as DeepSeek. |

API keys are stored per provider/host in `Settings.geminiApiKey`, `Settings.claudeApiKey`, and `Settings.openaiApiKeys` (a `Record<OpenAiBaseUrl, string>`). The cross-host STT relationship is captured by `Settings.sttHost` + `Settings.sttModel`. The `Test` button in Settings runs `runSelfTest()` against the active draft so an unsaved key/model surfaces failures before first real use.

When adding a provider:
1. Extend `LlmProvider` (or add a new `OpenAiBaseUrl` entry plus the right inline-audio / chat-only set membership).
2. Add the host to `permissions.network.whitelist` in `app.json`.
3. Add a streaming client (`src/llm/<provider>.ts`) that returns a string and emits `claim` / `field` / `valueChunk` / `noSpeech` events into the shared `StreamingJsonParser`.
4. Wire it into `callLensStream` in `src/llm/index.ts` — forward `onPartialClaim`, `onPartialField`, `watchValueKeys`, `onPartialString`, and `onNoSpeech`, otherwise heading streaming (Translate, Trivia) silently degrades.
5. Add SSE-consumer tests in `tests/<provider>.test.ts` covering happy path, abort mid-stream, transient 503/429 retry, and `noSpeech`.

## Commands

```bash
npm run dev        # vite dev server on 0.0.0.0:5173 (strictPort) so the phone WebView can reach it
npm run sim        # launch Even Realities desktop simulator pointed at the dev server
npm run lint       # tsc --noEmit (this project has no ESLint)
npm test           # vitest run (single pass)
npm run test:watch # vitest watch
npx vitest run tests/hud.test.ts                       # single test file
npx vitest run tests/personas.test.ts -t "fact"        # single test by name pattern
npm run build      # tsc --noEmit + vite production build → dist/
npm run pack       # evenhub pack app.json ./dist -o veritaslens.ehpk
npx evenhub qr     # generate QR code for the Even App to scan the dev URL
```

After dev-server changes the Even App WebView usually needs a manual reload (gear → reload bundle) — Vite HMR does not propagate over the bridge.

## Architecture

### Runtime split: settings WebView vs. HUD on glasses

`main.tsx` boots the same bundle in two modes determined by the SDK's `LaunchSource`:

- **`settings` mode** (`source !== 'glassesMenu'`): the phone shows `SettingsView.tsx`. The HUD on glasses still runs in parallel — `startHudRuntime()` is always called.
- **`hud` mode** (`source === 'glassesMenu'`): the phone WebView is incidental; the glasses HUD is the primary surface.

Both modes share one Solid signal store (`src/state/store.ts`). Settings writes propagate to the HUD instantly via reactivity.

### Three coordinated state machines

1. **App phase** (`AppPhase` in `types.ts`): `booting → idle → listening → thinking → displaying → error`. Owned by `setAppPhase` in the store.
2. **HUD page** (`currentHudPage()` in `runtime/hud.ts`): `unconfigured | picker | active | menu | history-list | history-detail`. Every page is built by pushing a fresh `WidgetTree` to the SDK via `bridge.rebuild(...)`.
3. **Session lifecycle** (`runtime/lifecycle.ts`): mic open/close, PCM ring buffer alloc/clear, auto-summary timer, in-flight `AbortController`.

`lifecycle.ts` is the single event router. `bridge.onEvenHubEvent` fans into `extractGesture()` → a per-page handler. Double-tap is universal: it triggers analysis from any page (and cancels an in-flight one when `analyzing === true`).

### The double-tap quirk

The host normalizes protobuf event types so that `CLICK_EVENT (0)` arrives as `undefined`, and `DOUBLE_CLICK_EVENT` arrives as a `sysEvent` *without* `currentSelectItemIndex`. To handle this:

- `extractGesture()` treats `undefined` as click and accepts a `sysEvent` whose `eventType` is one of the four interactive types.
- `lastPickerIndex` / `lastMenuIndex` / `lastHistoryIndex` are mirrored in JS whenever a `listEvent` carries an index, so that a subsequent index-less `sysEvent` tap knows what was highlighted.
- Pages use a `ListContainerProperty` as their event sink even when they look like text-only pages, because list containers reliably emit both click and scroll on this hardware. Text containers with `isEventCapture=1` emit scroll but not click.

If you add a new page, mirror the picker pattern: build a list container, register it as the focus, and update a JS-side `last*Index` from `listEvent` so the next tap is correctly attributed.

### Audio path

`runtime/audioBuffer.ts` is a fixed-capacity ring buffer of raw 16 kHz / 16-bit / mono PCM, with an in-memory WAV encoder and base64 encoder. Capacity is `bufferDuration × 16000 × 2` bytes. Nothing is ever written to disk; the buffer is cleared on `leaveActiveSession()` and on `stopHudRuntime()`.

When the mic is hot, every `audioEvent` from the bridge is appended to the buffer. Recording is **continuous** during compute / display / menu states so the next analysis can include audio captured while the previous result was on-screen.

### Persona / lens model

Each lens in `src/personas/*.ts` exports three things: a prompt builder `(lang) => string`, a Gemini `responseSchema`, and a `parse(text)` returning a discriminated-union `LensResult`. `personas/index.ts` registers them in `BUILTINS`. The **Auto** lens is special — it runs `parseAutoClassifierResponse` first, then dispatches to the chosen lens for a second `callLens` call with the main model.

`callLens()` in `src/llm/gemini.ts` always injects a `noSpeech: boolean` property into the response schema and `lifecycle.ts` adds a "focus only on clear human speech, set noSpeech=true if none detected" preamble to every prompt. Personas don't need to declare `noSpeech` themselves.

When adding a lens:
1. Create `src/personas/<name>.ts` with `buildXPrompt`, `X_SCHEMA`, `parseXResponse`.
2. Extend the `LensResult` union in `src/types.ts`.
3. Register the persona in `BUILTINS` in `src/personas/index.ts`.
4. Add `extractQuestion()` and `extractBadge()` cases in `runtime/lifecycle.ts` (the `LensResult` switch is exhaustive — TS will fail the build until you handle the new variant).
5. Add a test in `tests/personas.test.ts`.

### Persistence

Settings and history go through `bridge.setLocalStorage` / `bridge.getLocalStorage` (the Even App's KV store). Keys are namespaced under `veritaslens.*` (see top of `src/state/store.ts`). The history blob is JSON, capped at `HISTORY_BYTE_BUDGET = 400 KB` and `HISTORY_MAX_ENTRIES = 500`, trimmed FIFO. The Gemini API key uses the same store — there is no separate secure storage tier on this platform.

### Retries

`callLens` retries 503/429 up to `MAX_RETRIES` times (currently 3), honoring `Retry-After` headers and Google's structured `retryDelay: "42s"` hints (`parseRetryAfterMs`, `parseGoogleRetryDelayMs`), each clamped to a `MAX_RETRY_DELAY_MS = 8_000` ms ceiling. Each retry calls `onRetry(attempt)`, which the lifecycle uses to flash `R1/3`, `R2/3`, `R3/3` on the HUD.

### Path alias

`@/*` → `src/*` (both in `tsconfig.json` and `vite.config.ts`). Use it consistently — imports in production code use `@/...` rather than relative paths.

## Release packaging

`app.json` drives the `.ehpk` submission. Bump `version` (semver) for each release. `min_app_version` and `min_sdk_version` must match what the SDK actually requires. `permissions.network.whitelist` covers every supported LLM provider host: `https://generativelanguage.googleapis.com` (Gemini), `https://api.anthropic.com` (Claude), and the five OpenAI-compatible hosts — `https://api.openai.com`, `https://api.groq.com`, `https://openrouter.ai`, `https://api.deepseek.com`, `https://api.perplexity.ai`. Any new provider host must be added here before it can be reached from the WebView. Build then pack:

```bash
npm run build
npx evenhub pack app.json dist -o veritaslens.ehpk
```

## Testing notes

- Tests live in `tests/` and use Vitest with `environment: 'node'` (see `vite.config.ts`). DOM-dependent code paths are mocked rather than rendered.
- `tests/personas.test.ts` validates each persona's `parse()` against representative Gemini responses — extend it when changing a lens schema.
- `tests/hud.test.ts` covers HUD page transitions using a fake bridge.
- The SDK is not exercised by tests; the bridge is mocked. Behavior that depends on real device gestures must be verified through `npm run sim` or on hardware.
