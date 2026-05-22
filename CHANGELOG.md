# Changelog

## 0.7.0 — 2026-05-22
- **More providers**: bring your own OpenAI or Groq key as an alternative to Gemini. OpenAI and Groq transcribe the audio first (Whisper) and then analyse the transcript; one API key per provider.
- **Skip silence and noise**: taps with nothing to analyse short-circuit before an API call. The HUD flashes an `○` icon and shows "No speech captured" instead of waiting on a pointless request.
- **End-of-session Summary**: leaving the lens — manually or by changing provider / model / API key / buffer length — now writes a final interval Summary plus an overall session synthesis. Silent intervals are skipped.
- **Recording buffer** capped at 5 minutes (down from 10) to match the new fixed Summary cadence (every 5 minutes, no longer configurable).
- **History search** now also matches auto-derived tags from each entry's content, so a topic, verdict, or entity name finds entries that don't have the word in the recorded question.
- "Auto-summary" relabelled to **Summary** in the HUD and settings.

## 0.6.0 — 2026-05-21
- New **Meeting Prep** lens: ground answers in context you write on your phone before a meeting — general notes plus optional labeled attachments (contracts, prepared questions) the assistant can cite as sources. Every answer is grounded in a verbatim **evidence** excerpt from the cited attachment; follow-up questions are opt-in by the model — emitted only when prep is silent on a decision-changing detail. HUD swipes through three distinct claim kinds — **answer → evidence → follow-up** (evidence in quotes, follow-up with `→`).
- **Auto-summary** rewired to one consolidated entry per session: interval ticks accumulate in memory as context and a single summary is written to History when you exit the session. Sessions shorter than the interval produce no entry. In the phone History view the summary sits at the top of each session with a muted style so claim-style results below keep visual focus. Picker top-right badge reflects final-summary state: `summarizing…` while the end-of-session summary is generating, `summary ready` briefly when it lands, then back to `auto-summary`.
- Remove the **Summary** lens from the picker. Auto-summary still produces an end-of-session entry in History; per-tap summaries no longer compete with claim-style lenses, since any model can include a summary in its own output.
- **Hide / re-reveal** via swipe gestures: swipe down past the last answer page hides the result and returns the HUD to recording; a follow-up swipe up brings the same last page back. Tap → Back uses the same hidden state, so swipe-up after dismissing via the menu now reveals the last page you were viewing (previously jumped one back).
- **Session-wide swipe scroll**: swipe up/down on the active page walks every answer in the current session, not just the most recent analysis. A new analysis jumps the cursor to its first answer. The `X/Y` indicator counts session entries (questions asked), so Meeting Prep's answer/evidence/follow-up claims share a single position. Swipe-up always crosses one question at a time — from any Meeting Prep sub-claim it jumps straight to the previous entry's first page instead of walking back through evidence/follow-up first.
- **Previous answer stays on screen during analysis**: the HUD no longer collapses to a dot mid-check — the last result stays visible with a small spinner in the top-right corner.
- Baseline HUD claim slot grew from one line to two so longer questions wrap instead of being truncated.
- **History management**: settings History tab gains a per-session delete (round iOS-style × button on each session row, two-tap inline confirm) and a "Clear all history" footer button. History byte budget raised from 200 KB → 400 KB to comfortably hold multi-session auto-summaries; meeting-prep budget unchanged at 50 KB.

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
