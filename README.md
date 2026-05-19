# VeritasLens

A real-time **contextual intelligence layer** for [Even Realities G2](https://www.evenrealities.com) smart glasses. VeritasLens listens to the last ~30 seconds of conversation in a rolling, in-memory buffer and — on a single temple tap — sends the audio to Google Gemini, displaying a glanceable verdict on the HUD.

> **Silent intelligence for your G2.** Built as a single-bundle web app that runs inside the Even App WebView. No native code, no companion server, no audio leaves the device until *you* trigger a check.

---

## Features

- **Built-in Fact-Checker lens.** Picks the single most check-worthy factual claim from the audio, classifies it as `TRUE / FALSE / UNVERIFIED`, returns a one-sentence claim plus a 2–3 sentence explanation.
- **Custom lenses.** Create your own lenses with a name + plain-language intent ("Translate the speech to English", "Summarize into action items", "Tell me if I'm talking too much"). The JSON envelope is handled behind the scenes.
- **Multi-language responses.** Pick from 11 Latin-script European languages (English, Dansk, Svenska, Norsk, Deutsch, Français, Español, Italiano, Português, Nederlands, Polski). Verdict labels stay in canonical English so HUD glyphs always render correctly.
- **Glanceable HUD layout.** Claim, verdict glyph (`✓ TRUE` / `✗ FALSE` / `? UNVERIFIED`), and reason — all on the 576×288, 4-bit greyscale display. Verdict persists until the user takes another action; no auto-clear timer.
- **Continuous recording.** The 30-second PCM ring buffer keeps filling during compute, display, and menu states so the next fact-check can pick up whatever was said in between. A `● REC` indicator shows when the mic is hot.
- **Zero-persistence audio.** PCM is held in a single in-memory `Uint8Array` ring buffer. Nothing is written to disk, ever.
- **BYOK (Bring Your Own Key).** Your Gemini API key never leaves the device except as the destination of the `generateContent` request *you* initiate.
- **Battery polite.** Mic auto-pauses after 5 min of gesture inactivity and on foreground exit; resumes on next interaction.

---

## Gestures

| On glasses        | Picker page          | Active session            | Menu                       |
|-------------------|----------------------|---------------------------|----------------------------|
| Single tap        | Start highlighted lens | Open menu                 | Confirm highlighted option |
| Double tap        | Start highlighted lens | **Fact-check now** (shortcut) | Confirm highlighted option |
| Swipe up / down   | Cycle highlight      | Swipe up = exit to picker · Swipe down = clear verdict | Cycle highlight |

The right temple touchpad is the primary input. The host normalizes `CLICK_EVENT (0)` to `undefined` and routes `DOUBLE_CLICK_EVENT` through `sysEvent`; the runtime handles both paths.

---

## Architecture

```
[ G2 glasses ] ⇄ BLE 5.2 ⇄ [ Even App (Flutter, phone) ] ⇄ WebView bridge ⇄ [ VeritasLens (this app) ]
       │                              │                                            │
       │ 16 kHz PCM mic               │ onEvenHubEvent (audio / list / sys)        │ fetch
       │ touchpad gestures            │ callEvenApp (audioControl, rebuild …)      ▼
       └─ text + image HUD draws                                              [ Gemini 2.x API ]
```

- **Runtime**: SolidJS + Vite + TypeScript (fine-grained reactivity, ~7 KB runtime, ~108 KB total bundle / ~42 KB gzipped).
- **Display**: declarative container model via `@evenrealities/even_hub_sdk` (text + list containers, rebuilt per page transition).
- **Audio**: fixed-capacity PCM ring buffer (30 s × 16 kHz × 16-bit = 960 KB) with in-memory WAV encoding.
- **LLM**: direct REST call to `generativelanguage.googleapis.com` with the audio inline-base64'd as `audio/wav`. Gemini Flash variants typically return verdicts in ~1–3 s.

```
src/
├── main.tsx                # bootstrap; bridge init; auto-launch HUD
├── App.tsx                 # SettingsView shell
├── views/SettingsView.tsx  # config UI (lenses, key, model, language)
├── runtime/
│   ├── bridge.ts           # SDK singleton + raw-message wiretap
│   ├── audioBuffer.ts      # ring buffer + WAV encoder + base64
│   ├── hud.ts              # HUD pages: unconfigured / picker / active / menu
│   └── lifecycle.ts        # event routing, gestures, session state machine
├── personas/
│   ├── index.ts            # persona registry (built-in + user-created)
│   └── factChecker.ts      # built-in Fact-Checker prompt + schema + parser
├── llm/gemini.ts           # generateContent client
├── state/store.ts          # Solid signals + settings persistence
└── types.ts                # Verdict, Settings, GeminiModel, LanguageCode
```

---

## Quick start

Requires Node ≥ 20 and the Even App on your phone (or the Even Realities simulator).

```bash
# Install
npm install

# Dev server (Vite, on 0.0.0.0:5173 so the phone can reach it)
npm run dev

# In another terminal: generate a QR for the Even App to scan
npx evenhub qr

# Or: open the desktop simulator instead
npm run sim
```

Once the bundle loads inside the Even App / simulator:

1. The phone shows the configuration screen, the glasses show **"Configure on your phone to begin."**
2. Paste your Gemini API key (get one at [aistudio.google.com](https://aistudio.google.com/)), pick a model and language, hit **Save**.
3. Glasses transition to the lens picker. Tap the right temple → fact-checker page with `● REC` and `MIC` indicators.
4. Speak a factual claim for ~10 s. Single-tap to open the menu and pick **Fact-check now**, or double-tap to fire one directly.
5. Verdict appears within ~1–3 s and stays on the HUD until you take the next action.

---

## Tests + build

```bash
npm test          # vitest — 9 tests covering the PCM ring buffer + WAV encoder + base64
npm run lint      # tsc --noEmit
npm run build     # tsc check + vite production build → dist/
```

Packaging an `.ehpk` for Even Hub submission:

```bash
npm run build
npx evenhub pack app.json ./dist -o veritaslens.ehpk
# Or, after `evenhub login`, with availability check:
npx evenhub pack app.json ./dist -o veritaslens.ehpk --check
```

---

## Release

Follow these steps to produce a distributable `.ehpk` and submit it to the Even Hub store.

### 1. Validate `app.json`

Confirm every field is correct before packing:

| Field | Expected value |
|---|---|
| `package_id` | `com.veritaslens.app` |
| `edition` | `"202601"` |
| `name` | `"VeritasLens"` (≤ 20 chars) |
| `version` | Semver `x.y.z` — bump for each release |
| `min_app_version` | `"2.0.0"` |
| `min_sdk_version` | `"0.0.10"` |
| `entrypoint` | `"index.html"` |
| `permissions` | array of objects with `name` + `desc` (+ `whitelist` for `network`) |
| `supported_languages` | `["en"]` |

### 2. Build

```bash
npm run build
```

Verify `dist/index.html` exists before continuing.

### 3. Pack

```bash
npx evenhub pack app.json dist -o veritaslens.ehpk
```

Add `--check` to verify the `package_id` is available on the store before packing:

```bash
npx evenhub pack app.json dist -o veritaslens.ehpk --check
```

### 4. Verify

```bash
ls -lh veritaslens.ehpk
```

Confirm the file is present and non-zero in size.

### 5. Submit

Upload `veritaslens.ehpk` to the **Even Hub developer portal** for review. The portal runs compatibility checks and publishes the app to G2 users after approval.

---

## Privacy

- Audio is held in a 30-second rolling **in-memory** buffer (`Uint8Array`). Eviction is FIFO and the buffer is released when the session ends.
- Nothing is persisted to disk, IndexedDB, or any external store.
- The Gemini API key is saved via `bridge.setLocalStorage` (Even App's secure key-value store) and only ever leaves the device as the URL parameter on the `generateContent` request **you trigger**.
- The only outbound network host declared in `app.json` is `https://generativelanguage.googleapis.com`.

---

## Tech notes

- **Why list containers for input?** Text containers with `isEventCapture=1` emit scroll events on this hardware but not click events. List containers reliably emit both, so every interactive page uses a `ListContainerProperty` as the event sink.
- **Why mirror the SDK list cursor in JS?** `listEvent` carries `currentSelectItemIndex`, but the host emits double-tap as a `sysEvent` without that field. The runtime tracks `lastPickerIndex` / `lastMenuIndex` whenever a `listEvent` updates it, so any subsequent `sysEvent` tap knows which item to act on.
- **Why custom lenses share the Fact-Checker schema?** The HUD renderer expects `{ verdict, claim, reason }` to map to its three display zones. Custom lenses just supply the *intent*; `wrapCustomPrompt()` in `personas/index.ts` adds the JSON envelope instructions automatically.

---

## License

MIT. See [LICENSE](LICENSE) when added.

---

*Built with the [Even Hub SDK](https://hub.evenrealities.com/docs/getting-started/overview).*
