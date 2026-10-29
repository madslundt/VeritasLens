# Changelog

All notable changes to VeritasLens are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses semantic versioning.

## [0.18.2] — 2026-10-29

- Separate session controls from conversation setup: select a lens explicitly in Session; configure profiles, saved setups, captions, and answer display time in phone Settings using Save changes.
- Default new users to no profile while preserving saved profile choices, goals, and notes.
- Preserve the selected lens when changing profiles. Offer None to opt out of profile filtering and show the enabled lenses available to Best next help.
- Keep audio duration configurable only in phone Settings, labeled Audio sent per analysis. Label answer expiry Hide answers after and show audio duration read-only in Session.
- Match phone and glasses lens names. Show Lens and Profile separately on the HUD, remove profile/setup controls and persistent setting toggles from glasses menus, and retain quick session actions.

- Add optional, off-by-default local RNNoise cleanup for G2 snapshots up to 30 seconds. Preserve raw audio and fall back after at most one second; longer snapshots skip cleanup to bound memory. Include model licenses and worker/PCM regression coverage.
- Improve VAD responsiveness with elapsed-time inference yielding and a fast path for native 16 kHz PCM.
- Add an audio lab with real WASM inference, reference fixtures, resampling and fidelity checks, timing reports, and cancellation-safe browser workers.
- Merge unsaved conversation edits with newly saved History notes, and reject over-capacity merges without silently dropping notes.

## [0.18.1] — 2026-10-16

- Add 10- and 15-second audio windows on G2 and Ray-Ban for shorter uploads and less captured context.
- Add a saved Audio upload compression switch on G2, enabled by default. Lossless FLAC reduces Gemini inline audio and OpenAI/Groq transcription uploads without changing the captured samples; turning it off sends WAV.
- Fall back to WAV when encoding is unavailable, too slow, or larger than the original. Custom transcription servers that explicitly reject FLAC get one WAV retry, remembered per server/model for the app run. OpenRouter inline audio and native Ray-Ban uploads retain WAV.
- Apply the compression preference to analysis, shared Auto transcription, live captions, transcript sidecars, and draft connection tests. Include encoder licenses and upload-size/timing diagnostics.
- Update Ray-Ban settings tests to match the current model dropdowns and retain coverage of optional search settings.

## [0.18.0] — 2026-10-14

- Add Everyday, Work, and Understand conversation profiles, with optional goals, constraints, selected background notes, and reusable saved setups.
- Add response assistance, tactful clarification, catch-up, and structured decisions and commitments. Best next help uses the profile and goal and can stay quiet.
- Add opt-in live captions through the configured speech-to-text host, microphone pause/resume, same-exchange refinement, cue expiry, pinning, and usefulness feedback.
- Add editable conversation review with supporting quotes, ownership and deadline corrections, text export, and explicitly selected notes for future sessions.
- Split the phone interface into Session, Lenses, and Games pages. Fold preparation into a disclosure line, group lenses by purpose, preserve session drafts across navigation, and fix list corners in every lens category.
- Tighten lens relevance, uncertainty, and evidence boundaries; preserve later speech for the next check and prevent canceled work from updating the HUD. Keep minimal compatibility handling for the shared result model.

## [0.17.5] — 2026-10-14

- Add optional Tavily evidence to factual game batches across AI providers, including saved topics, Random, and Near me. Search once per batch, outside generation retries; riddles skip search.
- Preserve normal game generation after empty, invalid, failed, or timed-out searches. Retain sources with completed and partial game history, and discard late results after cancellation.
- Keep all lenses and game formats available regardless of the Tavily toggle. Update the network permission description to cover game-topic queries without adding hosts or permission categories.

## [0.17.4] — 2026-10-14

- Simplify LLM and Whisper model selection to dropdowns. Opening a custom-server dropdown loads its available models; manual model fields and separate load buttons are removed.
- Add 1-minute and 3-minute recording windows alongside 30 seconds, 2 minutes, and 5 minutes in G2 and Ray-Ban settings.

## [0.17.3] — 2026-10-14

- Add optional Tavily web search for providers without native search, with isolated credentials, connection testing, citations, and a toggle that preserves the saved key.
- Continue with an ungrounded answer after search errors, invalid responses, or a 15-second timeout. User cancellation still stops analysis.
- Add custom Whisper model discovery and a model picker in G2 and Ray-Ban settings, preserving manual entry and ordered alternate addresses.
- Apply native search model overrides correctly in streamed OpenAI-compatible requests. Add Tavily to the network whitelist without adding permission categories.


## [0.17.2] — 2026-10-14

- Restore the persistent bottom scroll buffer in phone settings. The Even App WebView needs this space even after the keyboard closes; focus-only padding and viewport-driven footer movement could reduce scroll range and make lower controls difficult to reach.

## [0.17.1] — 2026-10-14

- Declare the `phone-microphone` permission required by the existing Phone microphone option. The upload package now includes both microphone permissions.

## [0.17.0] — 2026-10-14

- **Custom chat and Whisper servers.** Configure an OpenAI-compatible base URL, model ID, optional key, and ordered fallback addresses in G2 and Ray-Ban settings. Model loading, connection tests, games, transcription, and analysis use the configured addresses. G2 custom origins must be added to the network whitelist before repacking.
- **Smaller local VAD runtime.** Earshot proposes speech regions and Silero v6 confirms them using local WASM. Model state is serialized and reset between snapshots; short trailing frames and non-16 kHz inputs are handled. Native bundles use a platform-specific FFT adapter so browser WASM is excluded from Hermes builds.
- **More reliable analysis.** Freeze audio at the tap, retain audio arriving during VAD for the next tap, and prevent canceled or superseded work from updating the HUD or consuming the analysis cursor. Auto reuses one transcription across classification and speculative answers, preserving grounding and citations.
- **Clearer results and settings.** G2 answers use the full display with a dim recording indicator between answers. Phone settings have clearer controls and keyboard spacing. Ray-Ban results show complete lens-specific content. Stored history preserves citations, and prompts emphasize the current audio's names, numbers, negation, and qualifiers.
- **Review fixes.** Remove unfinished streamed headings on cancellation, errors, or no-speech verdicts while retaining completed answers for swipe recall. Align optional Whisper sidecar validation between Test and Save. Remove an invalid Expo config plugin that prevented native exports.
- **Release compatibility.** G2 requires Even App 2.2.10 and SDK 0.0.16. Packing explicitly targets SDK 0.0.16; package and manifest versions are 0.17.0.

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
