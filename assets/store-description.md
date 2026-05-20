# VeritasLens — Even Hub store copy

## Tagline

Silent intelligence for your G2 — tap to fact-check what was just said.

## Short description (~50 words)

Tap your Even Realities G2 to analyse the last few seconds of conversation. VeritasLens sends a short audio snippet to Google Gemini and returns a glanceable verdict on the HUD — fact, fallacy, bias, stats, summary, and more. Bring your own key. Audio never leaves the device unless you trigger a check.

## Long description (~200 words)

VeritasLens turns the right temple of your Even Realities G2 into a contextual intelligence trigger. A configurable in-memory audio buffer (30 seconds to 10 minutes) captures the conversation around you. Tap the temple and VeritasLens sends a single audio snippet to Google Gemini, then draws a glanceable result on the 576×288 HUD.

Pick the right lens for the moment, or leave **Auto** on and let VeritasLens classify the audio and route to the best one: Fact Check, Trivia, Fallacy Check, Stats Check, Bias Check, Simplify, or Summary. Responses are returned in any of 11 European languages. Verdict labels stay canonical so the HUD always renders correctly.

Every analysis is saved to a local on-device session log, browsable from the HUD or the Settings → History tab on your phone. Optional auto-summary runs quietly in the background on a 1, 2, or 5 minute cadence.

Bring your own Gemini API key. The key is stored on-device, never synced. Audio lives only in memory and is dropped immediately after each request — nothing is written to disk, ever. The single outbound host is `generativelanguage.googleapis.com`.

No companion server. No telemetry. Tap, analyse, glance.
