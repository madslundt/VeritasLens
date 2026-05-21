# Changelog

## 0.6.0 — 2026-05-21
- New **Meeting Prep** lens: ground answers in context you write on your phone before a meeting — general notes plus optional labeled attachments (contracts, prepared questions) the assistant can cite as sources.

## 0.5.0 — 2026-05-20
- Multi-claim per tap (up to 5) for Fact, Stats, Fallacy, Bias, Trivia, and ELI5. One Gemini call now covers several distinct claims/questions/terms when present.
- Per-claim verbatim source quote (≤140 chars) attached to every result. Most recent claim returned first.
- Single-tap on the active HUD walks forward through claims; falls through to the menu on the last claim. Baseline hint reflects the next action (next claim vs menu).
- Searchable history: settings WebView's History tab gains a `Search` input matching quote / question / verdict / lens name. Each claim becomes its own history row.
- Quality guardrail in prompts: skip mid-sentences and anything not clearly understood — fewer high-confidence claims over padded lists.
- One-time on-load migration wraps any pre-0.5 history entries into the new shape; corrupt entries dropped silently.
- History byte budget bumped from 200 KB to 300 KB to fit the extra payload.
- Internal cleanup: drop unused `_setPersonas` / `PERSONAS` legacy exports; null the in-flight `AbortController` once analysis completes so the WAV snapshot can be reclaimed sooner.

## 0.4.0 — 2026-05-20
- Discreet HUD split: dot-only before answer, full-screen Q+A after.
- Menu spinner: animated indicator while analysis runs.
- Pending-result stash: opening menu mid-check no longer drops the answer.
- Re-analyze from result screen animates again.
- Retries animate through the wait (R1/3, R2/3, R3/3); MAX_RETRIES 2→3.
- History list newest-first; lens name only shown for Auto entries.

## 0.3.1 — 2026-05-19
- Restore the clock on the menu page (regressed in 0.3.0).
- Rename host-exit-dialog call to `requestHostExitConfirm`.

## 0.3.0 — 2026-05-19
- Discreet HUD mode: hide REC, status, and bottom hint while a check is on screen so a bystander sees only the answer.
