---
name: README rewrite — match features to codebase
description: Spec for updating README.md to reflect the current codebase (9 built-in lenses, no custom lenses, session history, configurable buffer, auto-summary, dual-model config)
type: spec
date: 2026-05-19
---

# README Rewrite Design

## Scope

Full rewrite of `README.md`, keeping all existing top-level sections (Features, Gestures, Architecture, Quick Start, Tests + Build, Release, Privacy, Tech Notes). No new sections added, no sections removed. Same depth and tone as the original.

## Changes per section

### Intro paragraph
- Update to mention "9 built-in lenses" rather than a single fact-checker.
- Keep the "rolling in-memory buffer + single temple tap" framing.

### Features
Remove:
- "Built-in Fact-Checker lens" bullet (was the only built-in)
- "Custom lenses" bullet (code was removed)

Add:
- One bullet describing the 9 built-in lenses: Auto, Fact Check, Trivia, Fallacy Check, Stats Check, Bias Check, Translation, Simplify (ELI5), Summary — with brief per-lens descriptions.
- **Auto lens** bullet: two-pass classifier that picks the best lens automatically; uses a separate lighter model for the classification step.
- **Configurable buffer** bullet: 30 s / 2 min / 5 min / 10 min rolling PCM buffer.
- **Session history** bullet: analyses persisted to device local storage, browseable from HUD history pages and Settings → History tab.
- **Auto-summary** bullet: optional background summaries on a configurable interval (1 / 2 / 5 min); results appear in History only.

Keep unchanged:
- Multi-language responses (11 languages, still accurate)
- Glanceable HUD layout
- Continuous recording / ● REC indicator
- Zero-persistence audio
- BYOK
- Battery-polite mic pause

### Gestures
Rewrite the table. Keep the same column structure but update every row:
- **Single tap on picker**: start selected lens session (unchanged)
- **Single tap on active**: open menu (unchanged)
- **Double tap (any page)**: trigger analysis with active lens (was "Fact-check now shortcut" — now universal from any page)
- **Swipe up on active**: scroll reason text up (was "exit to picker")
- **Swipe down on active**: scroll reason text down (was "clear verdict")
- **Menu options**: Fact-check now / History / Cancel / Exit
- **History List page**: tap item = view detail; swipe up = back to active
- **History Detail page**: tap = back to history list; swipe = scroll detail text

### Architecture
- Keep ASCII bridge diagram unchanged.
- Update file tree: list all 9 persona files (`auto.ts`, `factChecker.ts`, `trivia.ts`, `logicalFallacy.ts`, `statsCheck.ts`, `biasDetector.ts`, `translation.ts`, `eli5.ts`, `sessionSummary.ts`) plus `_utils.ts`.
- Update `personas/index.ts` description to "persona registry (9 built-in lenses)".
- Keep all other file descriptions unchanged.

### Quick Start
- Step 3: "Glasses transition to the **lens picker**." (not "fact-checker page")
- Step 4: updated to reflect selecting a lens from the picker, entering the active session, and double-tapping to fire analysis.
- Keep step 5 (verdict timing) unchanged.

### Tests + Build
- Update test count: 5 test files covering audio buffer, WAV encoder, base64, HUD, personas, store, and Gemini client.
- Keep all commands unchanged.

### Release
No changes.

### Privacy
- Update "30-second rolling buffer" → "configurable rolling buffer (30 s – 10 min)".
- Add: session history is persisted to device local storage via `bridge.setLocalStorage`; cleared when the user clears it or reinstalls the app.
- Keep all other privacy statements unchanged.

### Tech Notes
Remove:
- "Why custom lenses share the Fact-Checker schema?" (custom lenses removed)

Keep:
- "Why list containers for input?"
- "Why mirror the SDK list cursor in JS?"

Add:
- "Why does the Auto lens make two API calls?" — The classifier call (~300–500 ms, lighter model) determines which analysis lens fits the audio, then the full analysis call runs with the chosen lens. Separating them lets the classifier use a cheaper/faster model while keeping the analysis quality high.

## Out of scope
- Changing section order
- Adding new sections
- Modifying `app.json`, source code, or any file other than `README.md`
