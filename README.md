# VeritasLens

A real-time **contextual intelligence layer** for [Even Realities G2](https://www.evenrealities.com) smart glasses. VeritasLens listens to a configurable rolling buffer of conversation audio and — on a single temple tap — sends the audio to Google Gemini, displaying a glanceable result on the HUD.

> **Silent intelligence for your G2.** Built as a single-bundle web app that runs inside the Even App WebView. No native code, no companion server, no audio leaves the device until *you* trigger a check.

---

## Features

- **8 built-in lenses.** Choose the right tool for the moment or let Auto decide:
  - **Auto** — classifies the audio and routes to the best lens automatically.
  - **Fact Check** — labels the most check-worthy claim as `TRUE / FALSE / UNVERIFIED`.
  - **Trivia** — answers trivia questions with a direct answer and brief description.
  - **Fallacy Check** — names any logical fallacy present in the argument.
  - **Stats Check** — rates a numerical claim as `PLAUSIBLE / SUSPICIOUS`.
  - **Bias Check** — detects political, emotional, or factional bias; rates `NEUTRAL / BIASED`.
  - **Simplify** — explains jargon or complex statements in plain language.
  - **Summary** — summarizes the conversation recorded so far (requires extended buffer).
- **Auto lens.** Makes a fast classification call (using a configurable lighter model) to pick the best analysis lens, then runs the full analysis. Adds ~300–500 ms but requires no manual lens selection.
- **Multi-language responses.** Pick from 11 Latin-script European languages (English, Dansk, Svenska, Norsk, Deutsch, Français, Español, Italiano, Português, Nederlands, Polski). Verdict labels stay in canonical English so HUD glyphs always render correctly.
- **Glanceable HUD layout.** Lens-specific result (verdict, claim, answer, etc.) displayed on the 576×288, 4-bit greyscale display. Result persists until the user takes another action.
- **Session history.** Every analysis is saved to device local storage. Browse the full session log from the HUD (history pages) or the Settings → History tab on your phone.
- **Configurable buffer.** Choose 30 seconds, 2 minutes, 5 minutes, or 10 minutes of rolling PCM. Longer buffers give Gemini more context at the cost of more tokens per request.
- **Auto-summary.** Optionally enable background summaries on a 1, 2, or 5 minute interval. Results appear in History only — no interruption to the HUD.
- **Continuous recording.** The PCM ring buffer keeps filling during compute, display, and menu states so the next analysis can pick up whatever was said in between. A `● REC` indicator shows when the mic is hot.
- **Discreet HUD (optional).** Enabled from Settings. While listening, the on-glasses display shows only a small recording dot — no `● REC` label, no affordance hint. Double-tap reveals an analysis result; the result stays on screen until you open the menu and tap `← Back`. Mic capture is unchanged; this is a display-only mode.
- **Zero-persistence audio.** PCM is held in a single in-memory `Uint8Array` ring buffer. Nothing is written to disk, ever.
- **BYOK (Bring Your Own Key).** Your Gemini API key never leaves the device except as part of the `generateContent` request *you* initiate.

---

## Gestures

| On glasses      | Picker page         | Active session              | Menu                          | History list               |
|-----------------|---------------------|-----------------------------|-------------------------------|----------------------------|
| Single tap      | Start selected lens | Open menu                   | Confirm highlighted option    | Open highlighted entry     |
| Double tap      | Trigger analysis    | Trigger analysis            | Trigger analysis              | Trigger analysis           |
| Swipe up        | —                   | Scroll reason text up       | Cycle highlight up            | Cycle highlight up         |
| Swipe down      | —                   | Scroll reason text down     | Cycle highlight down          | Cycle highlight down       |

Menu options (in order): `← Back` (dismiss any visible answer and return to listening), `Check` (run analysis now), `History` (open the session log), `Exit` (end the session).

On the History Detail page: tap returns to the history list; swipe up/down scrolls the detail text.

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

- **Runtime**: SolidJS + Vite + TypeScript (fine-grained reactivity, ~7 KB runtime).
- **Display**: declarative container model via `@evenrealities/even_hub_sdk` (text + list containers, rebuilt per page transition).
- **Audio**: fixed-capacity PCM ring buffer (configurable 30 s – 10 min × 16 kHz × 16-bit) with in-memory WAV encoding.
- **LLM**: direct REST call to `generativelanguage.googleapis.com` with the audio inline-base64'd as `audio/wav`. Gemini Flash variants typically return results in ~1–3 s.

```
src/
├── main.tsx                # bootstrap; bridge init; auto-launch HUD
├── main.css                # global styles
├── App.tsx                 # SettingsView shell
├── views/SettingsView.tsx  # config UI (lenses, key, model, language, history)
├── runtime/
│   ├── bridge.ts           # SDK singleton + raw-message wiretap
│   ├── audioBuffer.ts      # ring buffer + WAV encoder + base64
│   ├── hud.ts              # HUD pages: unconfigured / picker / active / menu / history
│   └── lifecycle.ts        # event routing, gestures, session state machine
├── personas/
│   ├── index.ts            # persona registry (8 built-in lenses)
│   ├── _utils.ts           # shared prompt helpers
│   ├── auto.ts             # Auto lens classifier prompt + schema + parser
│   ├── factChecker.ts      # Fact Check prompt + schema + parser
│   ├── trivia.ts           # Trivia prompt + schema + parser
│   ├── logicalFallacy.ts   # Fallacy Check prompt + schema + parser
│   ├── statsCheck.ts       # Stats Check prompt + schema + parser
│   ├── biasDetector.ts     # Bias Check prompt + schema + parser
│   ├── eli5.ts             # Simplify prompt + schema + parser
│   └── sessionSummary.ts   # Summary prompt + schema + parser
├── llm/gemini.ts           # generateContent client + model list fetch
├── state/store.ts          # Solid signals + settings + history persistence
└── types.ts                # LensResult, Settings, GeminiModel, LanguageCode, HistoryEntry
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
3. Glasses transition to the **lens picker**. Scroll to highlight a lens, or leave **Auto** selected to let VeritasLens choose.
4. Tap the right temple to start a session. Speak for several seconds, then double-tap to fire an analysis (or single-tap → open menu → Fact-check now).
5. The result appears within ~1–3 s and stays on the HUD until you take the next action.

---

## Tests + build

```bash
npm test          # vitest — 5 test files covering audio buffer, WAV encoder, base64, HUD, personas, store, and Gemini client
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

- Audio is held in a configurable rolling **in-memory** buffer (30 s – 10 min, `Uint8Array`). Eviction is FIFO and the buffer is released when the session ends.
- Nothing is written to disk, IndexedDB, or any external audio store.
- Session history (analysis results) is persisted to the Even App's local key-value store via `bridge.setLocalStorage`. It stays on-device and is never sent to any server.
- The Gemini API key is saved via `bridge.setLocalStorage` (Even App's secure key-value store) and only ever leaves the device as the URL parameter on the `generateContent` request **you trigger**.
- The only outbound network host declared in `app.json` is `https://generativelanguage.googleapis.com`.

---

## Tech notes

- **Why list containers for input?** Text containers with `isEventCapture=1` emit scroll events on this hardware but not click events. List containers reliably emit both, so every interactive page uses a `ListContainerProperty` as the event sink.
- **Why mirror the SDK list cursor in JS?** `listEvent` carries `currentSelectItemIndex`, but the host emits double-tap as a `sysEvent` without that field. The runtime tracks `lastPickerIndex` / `lastMenuIndex` whenever a `listEvent` updates it, so any subsequent `sysEvent` tap knows which item to act on.
- **Why does the Auto lens make two API calls?** The first call is a fast classification step (~300–500 ms) using a configurable lighter model (default: `gemini-2.0-flash-lite`) to determine which analysis lens fits the audio. The second call runs the full analysis with the chosen lens and the main model. Separating the two lets the classifier stay cheap and fast while the analysis step uses the best available model.

---

## License

MIT. See [LICENSE](LICENSE).

---

*Built with the [Even Hub SDK](https://hub.evenrealities.com/docs/getting-started/overview).*
