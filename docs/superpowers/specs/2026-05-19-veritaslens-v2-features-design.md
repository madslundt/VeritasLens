# VeritasLens v2 — Feature Design

## Context

VeritasLens is a smart glasses app for Even Realities G2 that captures rolling audio and sends it to Google Gemini for analysis on a single temple tap. The current MVP has one built-in fact-checker lens plus unlimited custom lenses. This redesign focuses the product on a curated set of polished built-in lenses (removing custom lenses), adds a configurable buffer for longer context, introduces a history system, and adds an optional background auto-summarizer.

**Primary use case:** real-time fact-checking during conversations. **Secondary:** trivia games, meetings, translation.

**Design constraints:** stealth (no voice triggers), HUD-only primary output, user-controlled analysis only, privacy-first.

---

## 1. Built-in Lens Suite

Remove custom lenses entirely. Replace with 7 built-in lenses, each with its own Gemini response schema, parser, and HUD renderer.

| Lens | HUD Output Format |
|---|---|
| **Fact-checker** | `✓ TRUE` / `✗ FALSE` / `? UNVERIFIED` + claim (2 lines) + reason (2–3 sentences) |
| **Trivia** | Answer in large text + 1-sentence description below |
| **Logical fallacy** | Fallacy name (e.g. `STRAWMAN`) + brief explanation |
| **Stats check** | `PLAUSIBLE` / `SUSPICIOUS` + the specific number/stat + why |
| **Bias detector** | `NEUTRAL` / `BIASED` + direction (left/right/emotional) + why |
| **Translation** | Translated text filling the HUD |
| **ELI5** | Plain-language restatement of the jargon/complex statement |

### Files to create/modify
- `src/personas/factChecker.ts` — keep (already exists)
- `src/personas/trivia.ts` — new
- `src/personas/logicalFallacy.ts` — new
- `src/personas/statsCheck.ts` — new
- `src/personas/biasDetector.ts` — new
- `src/personas/translation.ts` — new
- `src/personas/eli5.ts` — new
- `src/personas/index.ts` — remove custom lens registry, export 7 built-ins only
- `src/types.ts` — add per-lens verdict types
- `src/runtime/hud.ts` — add per-lens HUD renderers
- `src/views/SettingsView.tsx` — remove custom lens management UI

---

## 2. Extended Buffer + Session Summary Lens

### Extended Buffer
Add a **buffer duration** setting: 30s / 2 min / 5 min / 10 min (default 30s).

- `src/runtime/audioBuffer.ts` — make `PcmRingBuffer` capacity configurable from settings
- `src/state/store.ts` — add `bufferDuration` setting, persist via bridge

### Session Summary Lens
A dedicated **Session Summary** lens appears in the picker only when `bufferDuration > 30s`. On tap, sends the entire accumulated buffer to Gemini and returns a structured summary of the conversation so far.

- `src/personas/sessionSummary.ts` — new lens with summary-format schema
- `src/runtime/lifecycle.ts` — conditionally add Session Summary to picker rotation

---

## 3. Auto-Summarizer (Optional)

- Toggle in settings: **Auto-summary on / off**
- Configurable interval: 1 min / 2 min / 5 min
- When triggered, sends current buffer to Session Summary lens silently — result stored in session history, **not displayed on HUD automatically**
- Settings UI must display a **token usage warning**: e.g. "Auto-summary at 2 min intervals ≈ 30 API calls/hour. Significantly higher API cost."

### Files to modify
- `src/runtime/lifecycle.ts` — add background timer that fires summary analysis and writes to history store
- `src/state/store.ts` — add `autoSummaryEnabled`, `autoSummaryInterval` settings
- `src/views/SettingsView.tsx` — add toggle + interval picker + token cost warning

---

## 4. History System

### Phone (SettingsView)
A **Session Log** section in Settings shows all entries from the current session as a list of questions/claims — not answers:
- List view: timestamp + lens name + question/claim text + verdict badge (TRUE/FALSE/PLAUSIBLE/etc.)
- Answer is hidden by default — tap any entry to expand and reveal the full answer/reason
- Tap the expanded entry again to collapse back to the list
- Mirrors the same question-first, answer-on-demand model as the HUD history

### HUD Navigation
Extend the existing menu page with a **History** option:
- **Menu → History** → list of past questions (claim/question text, not full answer) with verdict glyph
- Swipe up/down to scroll through history items
- Single tap on item → shows full answer (same HUD format as original verdict)
- Single tap again → back to history list
- Single tap from history list with no item selected → back to menu

### Double Tap (Universal)
Double tap works the same everywhere: **trigger a new analysis immediately**.
- If on the history page (or any other page), double tap exits to the recording/active screen and shows the new result
- User navigates back to history manually if needed
- Preserves existing double-tap behavior as a universal "analyze now" shortcut

### Files to modify
- `src/state/store.ts` — add `sessionHistory: HistoryEntry[]` signal; `HistoryEntry = { id, timestamp, lens, claim, verdict, fullResult }`
- `src/runtime/lifecycle.ts` — push to history on every completed analysis
- `src/runtime/hud.ts` — add `buildHistoryListPage()` and `buildHistoryDetailPage()` renderers
- `src/views/SettingsView.tsx` — add Session Log section

---

## 5. Removed Features
- Custom lens creation and management (UI removed from SettingsView, registry removed from `personas/index.ts`)

---

## Verification

1. **Lens suite**: Switch between all 7 lenses in picker, trigger analysis, verify each shows its own format on HUD (not the generic TRUE/FALSE template).
2. **Extended buffer**: Set buffer to 5 min, speak for 3 minutes, tap → Session Summary lens should summarize all 3 minutes.
3. **Auto-summarizer**: Enable with 1 min interval, wait 1 min, open History on phone — entry should appear without any HUD display.
4. **History (HUD)**: Run 3 analyses, open Menu → History, swipe through list, tap one to expand, tap again to collapse.
5. **History (phone)**: Open Settings → Session Log, verify all analyses appear as questions with verdict badges, tap to expand answer.
6. **Double tap from history**: Enter HUD history, double tap — should exit history and show fresh analysis result.
7. **Token warning**: Enable auto-summarizer in settings — warning text must be visible near the toggle.
8. **Custom lenses gone**: Confirm no custom lens UI exists in Settings.
