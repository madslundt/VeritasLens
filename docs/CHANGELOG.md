# Changelog

All notable changes to VeritasLens are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses semantic versioning.

## [0.16.0] — 2026-06-12

### Added
- **Interval trigger for Auto listen** — fires after `autoModeIntervalMs` (default 30 s, settings range 15–120 s) of continuous armed audio without a silence trigger. Solves the "flowing conversation never pauses, auto-mode never fires" starvation case from 0.15. Settings: new slider alongside the existing min-voice / trailing-silence controls.
- **Relevance gate** (`src/runtime/relevanceGate.ts`) — synchronous `shouldAnalyze(segments, lensId)` runs before every auto-trigger fire and suppresses the LLM call when the recent transcript tail doesn't contain content the active lens can act on. Per-lens regex patterns for fact-checker, trivia, key-questions, eli5, logical-fallacy, bias-detector, devils-advocate. Auto lens uses only the filler blocklist (yeah / mm-hmm / okay / right / sure / …).
- **Contextual hint** under the Auto listen sliders when transcript mode is off, recommending transcript mode for smarter Auto listen behaviour.

### Changed
- `AutoModeConfig` gains `getIntervalMs: () => number` (required) and `shouldAnalyze?: () => boolean` (optional — omission keeps the v3 always-fire baseline).
- Auto-mode value labels in Settings now share `min-width: 10rem` so the three slider tracks line up regardless of label length.

### Notes
- **Fails open everywhere it matters.** Empty transcript tail → fire. Unknown lens id (translation, meeting-prep, companion, session-summary, future) → fire. Any non-ASCII letter in the tail → fire (Danish ø / German ü / French é / Cyrillic / CJK never get suppressed by English-only regex).
- **Wearer-speak bypass.** When `wearerSpeakActive` is true (Translate two-way recording mode), the gate is skipped entirely so a deliberate wearer utterance is never silently dropped.
- **Tap-triggered analysis is untouched.** Only Auto mode goes through the gate.
- The interval timer also resets on gate suppression, so a suppressed fire doesn't re-evaluate the gate every tick after the threshold crosses.

## [0.15.0] — 2026-06-11

### Added
- **Companion lens** — surfaces up to 5 short tidbits the wearer can drop into a live conversation. Four kinds: `fact`, `stat`, `story`, `connection`. Bundled as one history entry per tap so a set of related tidbits stays grouped. HUD badge shows the per-tidbit `KIND` (`FACT` / `STAT` / `STORY` / `CONNECTION`).
- Companion uses **Google Search grounding** (same path as Fact Check / Trivia / Devil's Advocate) so any line the wearer might repeat aloud is verified against fresh web results instead of training memory.
- Companion prompt enforces an explicit interestingness bar ("if a reasonably educated adult would already know it, drop it"), an anti-recap rule (must add NEW information), and a mix-kinds rule so multiple tidbits don't pile up as the same flavor.

### Changed
- **Fact Check** now covers numerical claims too — description updated to reflect that it labels the most check-worthy claim, including stats, as TRUE / FALSE / UNVERIFIED.
- **Bias Detector** renamed to **Framing Check** — broadens scope to political, factional, emotional, and tonal framing.

### Removed
- **Stats Check lens** — its job is absorbed by Fact Check, which now handles numerical claims directly.
- **Sentiment (Tone Check) lens** — interpretive lens with low usage; tone signal is now covered implicitly by Framing Check.
- Auto classifier no longer lists `stats-check` or `sentiment` as candidates.

### Notes
- The Companion lens is **manual-only** and not reachable through the Auto classifier — it surfaces tidbits opportunistically rather than analytically, so wearers pick it deliberately when they want conversational material.
