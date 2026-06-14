# Changelog

All notable changes to VeritasLens are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses semantic versioning.

## [0.16.4] — 2026-06-14

### Fixed
- **Markdown link URLs no longer leak onto the HUD.** Web-grounded providers — most visibly OpenAI's `/v1/responses` path with the built-in `web_search` tool — sometimes inline `[Tesla blog](https://tesla.com/...)` markdown into a lens's answer text. The HUD renders raw strings with no markdown layer, so the wearer saw the bare URL alongside the label. Fixed at the choke point: a new `stripMarkdownLinks` helper in `personas/_utils.ts` collapses `[label](url)` → `label`, and `trimTo` runs it before any length check — so fact-check, trivia, ELI5, Meeting Prep, Companion, Devil's Advocate, Key Questions, Logical Fallacy, and Session Summary all benefit without touching their individual parsers. Bare URLs (no bracket+paren wrapper) are intentionally left alone — translation transcripts can legitimately quote a URL the speaker said aloud.

## [0.16.3] — 2026-06-14

### Added
- **Native web search on OpenAI, Groq, and DeepSeek** — closing the three remaining `groundless` providers. OpenAI routes grounded calls through the new `/v1/responses` endpoint with the built-in `{type: 'web_search'}` tool (gpt-5*/gpt-4.1*/gpt-4o* only); Groq overrides to the Tavily-backed `groq/compound` family; DeepSeek borrows the wearer's existing Perplexity Search key to pre-fetch results before each chat call, mirroring the existing `sttHost` cross-host borrow pattern.
- **Structured citations from every grounded provider** — `WebCitation` type (`{domain, url?, title?, snippet?}`) plus a new `onCitations` side-channel on `callLensStream`. Every provider client normalises its native citation shape (Gemini `groundingChunks`, Claude `web_search_tool_result`, OpenAI/OpenRouter `url_citation`, Perplexity `search_results`, Groq compound `executed_tools.search_results`) via the shared `citations.ts` helpers.
- **Sources sub-page on the HUD history detail** — when an entry has citations, the wearer can scroll one more notch to see up to 5 deduplicated source domains.
- New OpenAI Responses client (`openaiResponses.ts`) and Perplexity Search bolt-on (`perplexitySearch.ts`), both code-split via dynamic import so wearers who don't use those paths pay no bundle cost.

### Changed
- `resolveProviderGrounding` gains `useResponsesApi` and `prefetchSearch` fields plus a Groq compound model-override branch.
- `HistoryEntry` gains an optional `webCitations?: WebCitation[]` field, populated by the lifecycle when the grounded provider returned anything.
- `normalizeWebDomain` promoted from `personas/meetingPrep.ts` into the shared `llm/citations.ts` so every provider's extractor uses the same defensive normalisation.
- Meeting Prep now backfills `claims[0].sourceMeta` from the first real provider citation when the model returned `source: "Web"` but omitted `webSourceDomain` — closes the silent-no-citation failure mode.
- The Settings grounding-capability hint surfaces DeepSeek's borrow dependency explicitly, prompting the wearer to add a Perplexity key when one isn't on file.

### Notes
- **No new hosts in `app.json`** — Perplexity's `/search` endpoint reuses the existing `https://api.perplexity.ai` whitelist entry.
- **Tests**: new `citations.test.ts` and `perplexitySearch.test.ts`; `grounding.test.ts` updated for the new resolver branches. 487 core tests passing, 187 even-g2 tests passing.

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
