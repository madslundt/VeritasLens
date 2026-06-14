# VeritasLens

A real-time **contextual intelligence layer** for smart glasses. VeritasLens listens to a configurable rolling buffer of conversation audio and — on a single temple tap — streams it to your chosen LLM, displaying a glanceable result on the HUD or phone.

> **Silent intelligence for your glasses.** Built as a single web bundle for the Even App WebView and a React Native companion for Ray-Ban Meta. No server, no native code on G2, no audio leaves the device until *you* trigger a check.

---

## Monorepo layout

VeritasLens is an npm-workspaces monorepo. The platform-agnostic brain lives in `@veritaslens/core` and is consumed by two host packages:

```
packages/
├── core/        # @veritaslens/core — lenses, LLM providers, audio buffer, VAD,
│                #   streaming JSON parser, transcript, history, store shim
├── even-g2/     # @veritaslens/even-g2 — SolidJS WebView app for Even Realities G2
│                #   (the HUD-driven primary target — `.ehpk` for Even Hub)
└── rayban/      # @veritaslens/rayban — Expo / React Native app for Ray-Ban Meta
                 #   (phone-driven; BLE audio + camera via custom Expo modules)
```

Run any workspace script from the root:

```bash
npm install                         # installs all workspaces
npm test    --workspaces            # run tests in every package
npm run lint --workspaces           # tsc --noEmit across the tree
npm run build --workspaces --if-present
```

Or target a single workspace:

```bash
npm run dev   --workspace=@veritaslens/even-g2     # Vite dev server on :5173
npm run sim   --workspace=@veritaslens/even-g2     # Even Realities desktop simulator
npm run pack  --workspace=@veritaslens/even-g2     # build → dist/veritaslens.ehpk
npm start     --workspace=@veritaslens/rayban      # Expo dev server
```

---

## Lenses (11 built-in)

Pick one in the picker, or let **Auto** decide. Every lens streams structured JSON via `StreamingJsonParser`, so the HUD fills in as the response arrives.

| Lens | What it does | Web grounding |
|---|---|---|
| **Auto** | Classifies the audio and routes to the best lens. Two-call: fast classifier + full analysis. | inherited |
| **Fact Check** | Labels up to 5 check-worthy claims (including numerical ones) `TRUE / FALSE / UNVERIFIED`, with a `correction` line on FALSE. | ✓ |
| **Trivia** | Direct answer + brief description, with optional alt phrasing. | ✓ |
| **Fallacy Check** | Names the logical fallacy and gives a polite `callOut` phrase. | — |
| **Framing Check** | Detects political, factional, emotional, or tonal framing; offers a `counterFrame`. | — |
| **Simplify** | Plain-language restatement: punchy `oneLine` + richer `expanded`. | — |
| **Devil's Advocate** | Strongest counterargument plus a conversational `pivot` lead-in. | ✓ |
| **Key Questions** | Open / unanswered questions ranked `CRITICAL / IMPORTANT / NICE`. | — |
| **Companion** | Up to 5 short tidbits — facts, stats, anecdotes, or unexpected connections. | ✓ |
| **Translate** | Listens to a foreign-language speaker, shows their words + translation, and (Converse mode) suggests 3 reply starters. Auto mode = hands-free continuous translation. | — |
| **Meeting Prep** | Real-time answers grounded in notes + labeled attachments you wrote on your phone beforehand. Every answer carries a verbatim **evidence** excerpt; an opt-in **follow-up** fires only when prep is silent on a decision-changing detail. | — |

Each lens also returns a self-rated `HIGH / MED / LOW` confidence per claim and a verbatim ≤140-char `quote` from the audio.

Plus a built-in **Lens Game** mode (`personas/game.ts`, `runtime/gameHistory.ts`) that turns recent conversation into a 1-question quiz.

---

## LLM providers

Bring your own key — one per provider, stored on-device. The chat host and audio path differ per provider; routing lives in `core/src/llm/index.ts`.

| Provider | Chat host | Audio path | Notes |
|---|---|---|---|
| **Gemini** (default) | `generativelanguage.googleapis.com` | Inline `generateContent` audio | Only provider with `google_search` grounding. |
| **Claude** | `api.anthropic.com` | STT sidecar → tool-use streaming | Borrows STT from a `SttHost` (Groq Whisper or OpenAI Whisper). |
| **OpenAI** | `api.openai.com/v1` | `/audio/transcriptions` (whisper-1) → `/chat/completions` | Self-transcribes. |
| **Groq** | `api.groq.com/openai/v1` | `/audio/transcriptions` (whisper-large-v3) → `/chat/completions` | Self-transcribes; recommended STT for Claude / chat-only hosts. |
| **OpenRouter** | `openrouter.ai/api/v1` | Inline `input_audio` content part | Model picker filters to audio-capable models. |
| **DeepSeek** | `api.deepseek.com/v1` | Borrowed STT → chat completions | Needs a separate key for the chosen STT host. |
| **Perplexity** | `api.perplexity.ai` | Borrowed STT → chat completions | Same chat-only pattern as DeepSeek. |

The **Test** button in Settings runs `runSelfTest()` against the active draft, so an unsaved key/model surfaces failures before first real use.

---

## Features

- **Streaming HUD.** Every lens emits structured JSON as it's generated. Headings (Trivia answer, Translate text, Companion headline, Simplify one-liner, Fact correction) fill in character-by-character via `streamHeading` watchers; multi-claim lenses pop each claim onto the HUD as it closes.
- **Multi-claim per tap.** Fact, Framing, Fallacy, Trivia, Simplify, Companion, Devil's Advocate, and Key Questions can return up to 5 distinct items per request. Single-tap walks forward through them.
- **Per-claim verbatim quote.** ≤140-char source quote attached to every claim, most recent first.
- **Skip silence and noise.** Local Silero VAD (`@ricky0123/vad-web`) gates every tap; silent or too-noisy taps short-circuit before any API call. HUD flashes `○` (no voice) or `~` (too noisy).
- **Rolling transcript.** A multi-source transcript (`core/src/runtime/transcript.ts`) merges STT byproducts and inline audio output across taps so later lenses see what was said earlier in the session — at zero extra API spend on providers that already transcribe.
- **Multi-language responses.** 11 Latin-script European languages (English, Dansk, Svenska, Norsk, Deutsch, Français, Español, Italiano, Português, Nederlands, Polski). Verdict labels stay canonical English so HUD glyphs render correctly.
- **Glanceable HUD layout.** Lens-specific result on the 576×288 4-bit greyscale G2 display. Result persists until the next action.
- **Searchable session history.** Every analysis is persisted (KV store on G2, encrypted SecureStore for keys on Rayban). Search matches quote / question / verdict / lens name **and auto-derived tags** from each entry's content.
- **End-of-session Summary.** Leaving a session — manually or by changing provider, model, key, or buffer length — writes a final 5-minute interval summary plus an overall synthesis. Silent intervals are skipped.
- **Configurable buffer.** 30 s, 1 min, 2 min, or 5 min of rolling PCM (capped at 5 min to match the Summary cadence).
- **Continuous recording.** The PCM ring buffer keeps filling during compute / display / menu so the next analysis covers anything said in between. A `●` indicator shows when the mic is hot.
- **Hide / re-reveal via swipe.** Swipe down past the last answer hides the result; swipe up brings it back.
- **Session-wide swipe scroll.** Swipe up/down walks every answer in the session, not just the latest. `X/Y` indicator counts session entries.
- **Previous answer stays on screen during analysis.** Last result remains visible with a small top-right spinner during the next call.
- **Discreet HUD (optional).** Listening shows only a small recording dot — no `● REC` label, no affordance hint. Mic capture is unchanged; display-only.
- **Exit menu opt-out.** A separate `Exit` action ends the session *without* writing the stop-time summary, for when you'd rather not bake a transcript into history.
- **Zero-persistence audio.** PCM lives in a single in-memory ring buffer. Nothing is ever written to disk.
- **BYOK.** Per-provider keys never leave the device except as part of the request you trigger.

---

## Gestures (G2)

| On glasses | Picker | Active session | Menu | History list |
|---|---|---|---|---|
| Single tap | Start selected lens | Next claim → menu after last | Confirm highlight | Open entry |
| Double tap | Trigger analysis | Trigger analysis (cancels in-flight) | Trigger analysis | Trigger analysis |
| Swipe up | — | Previous answer (cross-entry) | Cycle up | Cycle up |
| Swipe down | — | Next answer / hide past last | Cycle down | Cycle down |

Menu: `← Back`, `Check`, `History`, `Exit` (writes summary), `Exit (no summary)`.

The right-temple touchpad is the primary input. The host normalizes `CLICK_EVENT (0)` to `undefined` and routes `DOUBLE_CLICK_EVENT` through `sysEvent` without an index; the runtime mirrors list cursors in JS to handle both paths.

---

## Architecture

```d2
direction: right

g2: "G2 glasses"
rayban: "Ray-Ban Meta"

even_app: "Even App (phone)" {
  webview: "WebView bridge"
  even_g2: "even-g2 SolidJS app"
  webview -> even_g2
}

rn_app: "Expo / RN app (phone)" {
  modules: "Custom Expo modules" {
    audio: "expo-bluetooth-audio"
    camera: "expo-meta-camera"
  }
  bridge_rn: "bridge-rn.ts" {
    kv: "AsyncStorage (KV)"
    secure: "expo-secure-store"
  }
}

core: "@veritaslens/core" {
  shape: hexagon
  style.fill: "#f5f5f5"
}

providers: "LLM providers" {
  grid-columns: 2
  gemini: Gemini
  claude: Claude
  openai: OpenAI
  groq: Groq
  openrouter: OpenRouter
  deepseek: DeepSeek
  perplexity: Perplexity
}

g2 <-> even_app: "BLE 5.2" {style.stroke-dash: 3}
rayban <-> rn_app.modules: "BLE audio + camera" {style.stroke-dash: 3}

even_app.even_g2 -> core
rn_app.bridge_rn -> core
rn_app.modules -> core: "PCM frames"

core -> providers: "fetch (streaming)"
```

### `@veritaslens/core`

The platform-agnostic brain. No DOM, no React, no Solid in the hot path (Solid is used only for the persona registry signal and the settings shim).

```
packages/core/
├── index.ts                       # public surface
└── src/
    ├── types.ts                   # LensResult union, Settings, providers, model lists
    ├── llm/
    │   ├── index.ts               # provider router (callLens, callLensStream, runSelfTest)
    │   ├── gemini.ts              # generateContent client + model fetch
    │   ├── openai.ts              # whisper + chat completions (OpenAI / Groq / DeepSeek / Perplexity / OpenRouter)
    │   ├── claude.ts              # messages API + tool-use streaming
    │   ├── gameClient.ts          # Lens Game streaming client
    │   ├── tools.ts               # web-grounding tool spec + provider resolution
    │   ├── streamingJsonParser.ts # claim / field / valueChunk / noSpeech events
    │   └── fetchTimeout.ts        # AbortController-aware fetch with timeout
    ├── personas/
    │   ├── index.ts               # registry + LensGrounding + StreamHeadingConfig
    │   ├── _utils.ts              # shared prompt helpers
    │   ├── auto.ts                # Auto classifier
    │   ├── factChecker.ts         # Fact Check
    │   ├── trivia.ts              # Trivia
    │   ├── logicalFallacy.ts      # Fallacy Check
    │   ├── biasDetector.ts        # Framing Check
    │   ├── eli5.ts                # Simplify
    │   ├── devilsAdvocate.ts      # Devil's Advocate
    │   ├── keyQuestions.ts        # Key Questions
    │   ├── companion.ts           # Companion
    │   ├── translation.ts         # Translate (Converse + Listen-in)
    │   ├── meetingPrep.ts         # Meeting Prep (prep-grounded answers)
    │   ├── sessionSummary.ts      # End-of-session summary
    │   └── game.ts                # Lens Game
    ├── runtime/
    │   ├── audioBuffer.ts         # PCM ring buffer + WAV encoder + base64
    │   ├── autoMode.ts            # Auto-lens routing
    │   ├── transcript.ts          # rolling transcript (multi-source merge)
    │   ├── transcriptSource.ts    # transcript source modes (chat-byproduct, inline)
    │   ├── recallContext.ts       # cross-tap context builder
    │   ├── relevanceGate.ts       # short-circuit irrelevant taps
    │   ├── history.ts             # persisted history + tag derivation
    │   ├── gameHistory.ts         # Lens Game history
    │   ├── ttsText.ts             # text → spoken summary
    │   └── vad/                   # Silero VAD adapter (warmup + analysis)
    └── state/store.ts             # Settings shim injected by hosts at bootstrap
```

### `@veritaslens/even-g2`

The SolidJS WebView app that runs inside the Even App on G2.

```
packages/even-g2/
├── app.json                       # Even Hub manifest (package_id, permissions, whitelist)
├── index.html
├── vite.config.ts
└── src/
    ├── main.tsx                   # bootstrap; bridge init; auto-launch HUD
    ├── main.css
    ├── App.tsx                    # SettingsView shell
    ├── views/SettingsView.tsx     # config UI (lenses, providers, keys, models, language, history)
    ├── state/store.ts             # Solid signals + settings + history persistence
    └── runtime/
        ├── bridge.ts              # SDK singleton + raw-message wiretap
        ├── bootstrap.ts           # configureSettings + configureDebugEvents into core
        ├── hud.ts                 # HUD pages: unconfigured / picker / active / menu / history
        ├── lifecycle.ts           # event routing, gestures, session state machine
        └── game.ts                # Lens Game HUD pages
```

`main.tsx` boots the same bundle in two modes determined by the SDK's `LaunchSource`. In `settings` mode (phone) it renders `SettingsView`; in `glassesMenu` mode it skips straight to the HUD. Both modes share one Solid signal store, so settings writes propagate to the HUD instantly.

### `@veritaslens/rayban`

The Expo / React Native companion for Meta Ray-Ban glasses. Audio and camera arrive over BLE via two custom Expo modules under `packages/rayban/modules/`:

- **`expo-bluetooth-audio`** — captures the Ray-Ban mic stream over BLE.
- **`expo-meta-camera`** — triggers and reads back camera frames from the glasses.

The phone is the primary surface (the Ray-Ban hardware has no display); the four-tab UI (`Home`, `Conversation`, `LLM`, `Settings`) lets the wearer review results on the handset while the glasses stay silent. Secrets land in `expo-secure-store` (Keychain on iOS) via the bridge's `isSecureKey` filter; everything else goes to `AsyncStorage`.

### Three coordinated state machines (G2)

1. **App phase** (`AppPhase` in `types.ts`): `booting → idle → listening → thinking → displaying → error`.
2. **HUD page** (`currentHudPage()` in `runtime/hud.ts`): `unconfigured | picker | active | menu | history-list | history-detail`. Every page is built by pushing a fresh `WidgetTree` via `bridge.rebuild(...)`.
3. **Session lifecycle** (`runtime/lifecycle.ts`): mic open/close, PCM ring buffer alloc/clear, auto-summary timer, in-flight `AbortController`.

`lifecycle.ts` is the single event router. `bridge.onEvenHubEvent` fans into `extractGesture()` → a per-page handler.

### Audio path (G2)

`runtime/audioBuffer.ts` is a fixed-capacity ring buffer of raw 16 kHz / 16-bit / mono PCM with an in-memory WAV encoder and base64 encoder. Capacity is `bufferDuration × 16000 × 2` bytes. Nothing is ever written to disk; the buffer is cleared on `leaveActiveSession()` and on `stopHudRuntime()`.

Recording is **continuous** during compute / display / menu states so the next analysis can include audio captured while the previous result was on-screen.

### Adding a lens

1. Create `packages/core/src/personas/<name>.ts` with `build<Name>Prompt`, `<NAME>_SCHEMA`, `parse<Name>Response`.
2. Extend the `LensResult` union in `packages/core/src/types.ts`.
3. Register the persona in `BUILTINS` in `packages/core/src/personas/index.ts`. Add `grounding: 'google_search'` if it's retrieval-bound, `streamHeading` if it should fill in character-by-character.
4. Add `extractQuestion()` and `extractBadge()` cases for the new variant in `packages/even-g2/src/runtime/lifecycle.ts` (the `LensResult` switch is exhaustive — TS will fail the build until you handle it).
5. Add a test in `packages/core/tests/personas.test.ts`.

### Adding a provider

1. Extend `LlmProvider` (or add a new `OpenAiBaseUrl` entry plus the right inline-audio / chat-only set membership) in `packages/core/src/types.ts`.
2. Add the host to `permissions.network.whitelist` in `packages/even-g2/app.json`.
3. Add a streaming client (`packages/core/src/llm/<provider>.ts`) that returns a string and emits `claim` / `field` / `valueChunk` / `noSpeech` into the shared `StreamingJsonParser`.
4. Wire it into `callLensStream` in `packages/core/src/llm/index.ts` — forward `onPartialClaim`, `onPartialField`, `watchValueKeys`, `onPartialString`, and `onNoSpeech`, otherwise heading streaming silently degrades.
5. Add SSE-consumer tests covering happy path, abort mid-stream, transient 503/429 retry, and `noSpeech`.

### Retries

`callLens` retries 503/429 up to `MAX_RETRIES` (currently 3), honoring `Retry-After` and Google's structured `retryDelay: "42s"` (`parseRetryAfterMs`, `parseGoogleRetryDelayMs`), each clamped to `MAX_RETRY_DELAY_MS = 8000 ms`. Each retry calls `onRetry(attempt)` which the lifecycle uses to flash `R1/3`, `R2/3`, `R3/3` on the HUD.

---

## Quick start (G2)

Requires Node ≥ 20 and the Even App on your phone (or the Even Realities simulator).

```bash
npm install
npm run dev   --workspace=@veritaslens/even-g2   # Vite on 0.0.0.0:5173
npm run qr    --workspace=@veritaslens/even-g2   # QR for the Even App to scan
# or
npm run sim   --workspace=@veritaslens/even-g2   # desktop simulator
```

Once loaded inside the Even App / simulator:

1. The phone shows the configuration screen; glasses show **"Configure on your phone to begin."**
2. Pick a provider, paste its API key, choose a model + language, optionally **Test connection**, hit **Save**.
3. Glasses transition to the **lens picker**. Scroll to highlight a lens, or leave **Auto** selected.
4. Tap the right temple to start a session. Speak, then double-tap to fire an analysis (or single-tap → menu → Check).
5. The result streams onto the HUD within ~1–3 s and stays until the next action.

API keys: [aistudio.google.com](https://aistudio.google.com/) (Gemini) · [console.anthropic.com](https://console.anthropic.com/) (Claude) · [platform.openai.com](https://platform.openai.com/) (OpenAI) · [console.groq.com](https://console.groq.com/) (Groq) · [openrouter.ai](https://openrouter.ai/) · [platform.deepseek.com](https://platform.deepseek.com/) · [perplexity.ai](https://www.perplexity.ai/settings/api).

After dev-server changes the Even App WebView usually needs a manual reload (gear → reload bundle) — Vite HMR does not propagate over the bridge.

## Quick start (Ray-Ban Meta)

```bash
npm install
npm run prebuild --workspace=@veritaslens/rayban     # generate native projects
npm run ios      --workspace=@veritaslens/rayban     # or: android
```

The Ray-Ban app needs the custom Expo modules (`expo-bluetooth-audio`, `expo-meta-camera`) — those are autolinked from `packages/rayban/modules/` on prebuild. iOS deployment target is 17.0; Android `minSdkVersion` is 29 (audio/camera/BLE foreground-service permissions are declared in `app.json`).

---

## Tests + build

```bash
# All packages
npm test --workspaces

# Core only — the bulk of unit coverage (audio buffer, WAV encoder, base64,
# personas, providers, streaming JSON parser, VAD, transcript, history)
npm test --workspace=@veritaslens/core

# Even-g2 only — HUD page transitions, bridge wiretap, store, lens streaming,
# main bootstrap, game wiring, tag derivation
npm test --workspace=@veritaslens/even-g2

# Lint (tsc --noEmit) across the tree
npm run lint --workspaces

# Production build of the G2 bundle → packages/even-g2/dist/
npm run build --workspace=@veritaslens/even-g2
```

Single-file / single-test runs against a workspace:

```bash
npm test --workspace=@veritaslens/core -- tests/personas.test.ts
npm test --workspace=@veritaslens/core -- tests/personas.test.ts -t "fact"
```

---

## Release (G2 `.ehpk`)

### 1. Validate `app.json`

| Field | Expected value |
|---|---|
| `package_id` | `com.veritaslens.app` |
| `edition` | `"202601"` |
| `name` | `"VeritasLens"` (≤ 20 chars) |
| `version` | Semver `x.y.z` — bump for each release |
| `min_app_version` | `"2.0.0"` |
| `min_sdk_version` | `"0.0.10"` |
| `entrypoint` | `"index.html"` |

The `network` whitelist must contain every provider host:

- `https://generativelanguage.googleapis.com`
- `https://api.anthropic.com`
- `https://api.openai.com`
- `https://api.groq.com`
- `https://openrouter.ai`
- `https://api.deepseek.com`
- `https://api.perplexity.ai`

### 2. Build, pack, verify, submit

```bash
npm run build --workspace=@veritaslens/even-g2
npm run pack  --workspace=@veritaslens/even-g2
ls -lh packages/even-g2/veritaslens.ehpk
```

Add `--check` after `pack` to verify `package_id` availability on the store before packing. Upload the `.ehpk` to the Even Hub developer portal.

---

## Privacy

- Audio is held in a configurable rolling **in-memory** PCM ring buffer (30 s – 5 min). Eviction is FIFO; the buffer is released when the session ends.
- Nothing is written to disk, IndexedDB, or any external audio store.
- Voice-activity detection (Silero ONNX) runs **locally** in the WebView / RN bundle before any network call; silent or too-noisy taps never leave the device.
- Session history (analysis results, not audio) is persisted on-device — Even App KV on G2, `AsyncStorage` on Rayban — and never sent to any server.
- API keys are stored per-provider on-device. On Rayban they land in `expo-secure-store` (iOS Keychain); on G2 they sit in the Even App KV store alongside other settings.
- The only outbound hosts declared in `app.json` are the seven LLM providers above. Each request goes directly from the WebView / phone to the provider you chose; there is no VeritasLens server in the loop.

---

## Tech notes

- **Why list containers for input on G2?** Text containers with `isEventCapture=1` emit scroll but not click on this hardware. List containers reliably emit both, so every interactive page uses a `ListContainerProperty` as the event sink.
- **Why mirror the SDK list cursor in JS?** `listEvent` carries `currentSelectItemIndex`, but the host emits double-tap as a `sysEvent` without it. The runtime tracks `lastPickerIndex` / `lastMenuIndex` / `lastHistoryIndex` whenever a `listEvent` updates it, so the next `sysEvent` tap knows which item to act on.
- **Why does Auto make two API calls?** A fast classification call (~300–500 ms) on a configurable lighter model (default `gemini-2.0-flash-lite`) picks the lens; a second call runs the full analysis with the main model. Separation lets the classifier stay cheap while analysis uses the best available model.
- **Why transcribe first for Claude / OpenAI / Groq / DeepSeek / Perplexity?** These hosts don't take inline audio in the same chat call. The adapter calls Whisper (`/audio/transcriptions`) first, then feeds the transcript into the analysis prompt. The transcript is also surfaced via `onTranscript` so the rolling `transcript.ts` builds session-wide context at zero extra API spend.
- **Why does `streamHeading` exist?** Multi-claim lenses already get claim-by-claim streaming via `onPartialClaim`. For single-string heading lenses (Trivia answer, Translate text, Companion headline, Simplify oneLine, Fact correction) the persona opts into intra-claim streaming so the wearer's payload fills in character-by-character before the long form lands.

---

## License

MIT. See [LICENSE](LICENSE).

---

*Built with the [Even Hub SDK](https://hub.evenrealities.com/docs/getting-started/overview) and [Expo](https://expo.dev).*
