# Changelog

## 0.4.0 — 2026-05-20

Reliability and clarity pass over the discreet HUD, the menu/analysis
interaction, and the in-flight retry indicator. No new lenses, no schema
changes.

### Highlights

- **Discreet mode is now two real layouts, not one with hidden chrome.**
  Before the answer arrives the HUD is a single top-right slot (the
  recording dot, which becomes the spinner / `R1/3` retry indicator while
  thinking). When the answer arrives the page is replaced with a full-screen
  question + verdict + reason, with no dot or status text in the way. The
  previous build kept the dot and a separate status caret on screen
  simultaneously, which LVGL rendered as a stray label cursor in the
  opposite corner on the simulator.
- **The menu spinner.** Opening the menu while analysis is in flight now
  shows a small animated spinner immediately to the left of the clock, so
  it's obvious that a check is still running and the menu didn't kill it.
- **The "ghost answer" bug is fixed.** Opening the menu mid-analysis used
  to lose the answer when it arrived — the result was written to a page
  that wasn't on screen and then dropped. The HUD now stashes the result
  and replays it when the user returns to the active page (either via
  Back, or by tapping the page sink). `resetHudSessionState()` clears the
  stash on session exit.
- **Re-analyzing from the result screen actually animates again.** A
  double-tap from a populated result page used to get stuck on `...` with
  no spinner — the SDK doesn't refresh containers that already have
  content. The active page is now torn down and rebuilt at the start of
  every check, so the spinner is visible immediately on every path
  (direct double-tap, menu → Check, and the discreet-mode re-entry).
- **The retry indicator animates through the whole wait.** Retries used
  to show a static "Retry 1/2" label that froze for the entire backoff
  and the next request. The spinner now keeps ticking and the label
  becomes its prefix: `R1/3|`, `R1/3/`, `R1/3-`, `R1/3\`. Max retries
  raised from 2 to 3 (matching the 503/429 budget we already burn).
- **Leaving the session aborts in-flight analysis.** Previously a late
  Gemini response could land in a session that no longer existed and
  re-populate a fresh session's pending stash. Exit cancels the request
  before clearing audio / state.
- **History list shows newest first** and the lens name is now only shown
  in the detail view for Auto-routed entries (it's redundant noise for
  explicitly chosen lenses).

### HUD: containers and pages

- New container slot `menuSpinner` (id 28, name `vl-menu-spin`) sits
  immediately left of the clock on the menu page. `buildMenuPage` now
  emits 4 containers (was 3): title, spinner, clock, list. `setMenuSpinner`
  is the only writer; it always records the frame so a fresh menu rebuild
  reflects the current spinner state, and only sends a `textContainerUpgrade`
  when the menu is on screen.
- `discreet-minimal` is now `{ sink, status }` — one list event sink, one
  top-right text container. `setStatus` writes there directly, and a
  cleared status restores `•` so the resting state is always "I'm
  recording". The pre-0.4.0 layout had a stand-alone `recDot` text plus
  a hidden status container, and LVGL surfaced a label-cursor caret
  whenever both were on screen.
- `discreet-result` is now `{ sink, claim, verdict, reason }` — pure
  question/answer, no dot, no status, no REC label, no bottom hint. The
  layout matches the history-detail view, so a bystander glancing at the
  glasses sees only the answer text.
- `setLensResult` promotes `discreet-minimal → discreet-result` when a
  result arrives (rebuilds the page, then writes claim/verdict/reason),
  and demotes back to `discreet-minimal` when the result is cleared.
  Callers no longer have to manage the layout swap themselves —
  `runAnalysis` and `handleBackMenuOption` only set the "starting
  layout" they want.
- `setLensResult` while off the active page (typically the menu) stashes
  the result in `pendingActiveResult` instead of writing to a page that
  isn't on screen. `showActivePage` and `restoreActivePage` consume the
  stash on return; if the persisted layout is `discreet-minimal` and a
  stashed result exists, it's promoted to `discreet-result` before the
  rebuild so the replay has containers to write into.
- `hasPendingActiveResult()` is exposed for the lifecycle to branch on.

### Lifecycle

- `handleBackMenuOption` (Menu → Back) now has two paths:
  - **Pending result waiting:** restore the active page (the stashed
    result is replayed automatically), set status `displaying`, restore
    the default hint, and put the phase at `displaying`.
  - **No pending result:** the original behavior — clear the result,
    reset the layout to discreet-minimal or baseline, and put the phase
    back to `listening`.
- `runAnalysis` now starts every check by clearing the prior result and
  rebuilding the active page. The previous flow only rebuilt when
  promoting baseline → discreet-result, which left the populated result
  page in place on double-tap re-analysis. The result-clear also forces
  `discreet-minimal` while thinking, so the user sees the dot/spinner
  during compute even though the answer is gone.
- `leaveActiveSession` aborts `inflight`, clears the analyzing flag, and
  stops the spinner before tearing down audio / HUD state. This is
  belt-and-braces with `resetHudSessionState` clearing the pending
  stash: even if `callLens` resolves after the abort, there's no active
  page to deliver into.
- The spinner now carries a `spinnerPrefix` string. `onRetry` sets it
  to `R{attempt}/{MAX_RETRIES}` and restarts the timer if it had been
  stopped between attempts. `stopSpinner` resets the prefix and clears
  the menu spinner frame.
- The initial spinner frame is pushed immediately on `startSpinner` so
  the status slot doesn't stay blank for up to 180 ms after analysis
  begins.

### Gemini client

- `MAX_RETRIES` raised from 2 to 3 and exported so the lifecycle can
  build the `R1/3 … R3/3` label without hard-coding the number.
- No protocol or schema changes — `noSpeech` injection,
  `Retry-After`/`retryDelay` parsing, and abort behavior are all
  unchanged.

### Settings view

- Session detail entries render newest-first (`[...entries].reverse()`)
  so the most recent check is at the top of the list when expanding a
  session.
- The per-entry badge tag and lens-name tag in the row header were
  removed — the icon + time + question is enough at a glance, and the
  detail view shows the full result.
- The lens name now only appears in the expanded detail when the entry
  was Auto-routed (`entry.result.autoSelected === true`). For explicit
  lens picks it was redundant with the session header.

### Tests

- `tests/gemini.test.ts` — retry test updated for 3-attempt budget:
  three 503s then success on the fourth call, with `onRetry` invoked at
  attempts 1, 2, 3.
- `tests/hud.test.ts` — 40 tests total (was 28). New coverage:
  - `discreet-minimal` layout shape (single status slot, no clock, no
    rec, no hint).
  - `discreet-result` layout shape (pure 3-container q/a, no dot, no
    status, no rec, no hint).
  - `setStatus` writing to the shared discreet-minimal slot, and
    being a no-op on `discreet-result`.
  - `setLensResult` promote / demote between discreet layouts.
  - `pendingActiveResult` lifecycle: stashed while on menu, replayed on
    `restoreActivePage`, cleared by `resetHudSessionState`, and
    promoting `discreet-minimal → discreet-result` on return.
  - Menu spinner: container present in `buildMenuPage`, `setMenuSpinner`
    writes on the menu / records the frame off the menu, `setMenuSpinner('')`
    clears the recorded frame so a fresh menu opens blank.
- All 113 tests pass; `tsc --noEmit` is clean.

### Compatibility

- `app.json` `min_app_version` and `min_sdk_version` unchanged.
- `permissions` and the network whitelist (`generativelanguage.googleapis.com`)
  unchanged.
- No new persisted settings keys; existing `veritaslens.*` localStorage
  entries are forward-compatible.

---

## 0.3.1 — 2026-05-19

- Restore the clock on the menu page (regressed in 0.3.0).
- Refactor: name the host-exit-dialog call as `requestHostExitConfirm`.

## 0.3.0 — 2026-05-19

- Discreet HUD mode: hide REC, status, and bottom hint while a check is
  on screen so a bystander sees only the answer text. Initial
  implementation; see 0.4.0 for the layout split.

## 0.2.2 — 2026-05-18

- Double-tap to exit from picker and unconfigured pages.

## 0.2.1 — 2026-05-18

- Store assets and accurate permission descriptions in `app.json`.

## 0.2.0 — 2026-05-18

- Allow canceling an in-flight analysis via double-tap.
- Remove the battery-polite throttling feature.
