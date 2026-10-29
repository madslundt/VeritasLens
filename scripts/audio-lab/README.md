# Audio lab

Actual Earshot/Silero v6 and RNNoise WASM inference using the G2's 16 kHz mono
PCM format. The G2 app ships the pinned small RNNoise build as an optional,
off-by-default setting for snapshots up to 30 seconds; longer app snapshots use
the original audio to bound memory. The lab shares the app's DSP engine and resampler;
the modern RNNoise model remains lab-only and is excluded from `.ehpk` builds.
Requires Node 22.18+ and `npm ci`.

```sh
npm run test:audio -- --report /tmp/audio-results.json --samples /tmp/audio-samples
npm run test:audio -- --filter rnnoise-modern --report /tmp/audio-modern.json
npm run audio:lab
```

Open the printed Wi-Fi address on iPhone Safari and Android Chrome. Keep the
tab visible, select a filter, tap **Run reference tests**, then **Download results**. The page
loads locally served model assets; it makes no LLM calls and needs no API key,
microphone permission, AudioContext, SharedArrayBuffer, or isolation headers.
The pinned public speech fixture is downloaded and checksum-verified by the
server on first run, then cached in the OS temp directory. Optional WAVs are
read in the browser and are never uploaded to the server.

Inference runs in a module worker. Cancel terminates that worker, including
its model state. Compare the three playback samples at equal playback volume.
The optional WAV input must contain clear speech and be mono PCM16 at 16 kHz.
The suite uses its first six seconds, surrounded by one second of silence.

The default is Jitsi's **RNNoise 0.1 small** WASM build (112,141 bytes plus
about 12 KB of glue). The optional **RNNoise 0.2 modern** build embeds its WASM
in about 1.9 MB of JavaScript. Both are shipped by `@jitsi/rnnoise-wasm@0.2.1`;
the package version is not the model version. Only the selected model loads.

The shorter suite checks speech/noise detection, quiet speech, three controlled
SNRs, two suppression strengths, independent recurrent states, and partial-frame
handling. It measures one 30-second snapshot, stage timings, and interface timer
responsiveness. One WASM module is reused, with a new small recurrent state per
independent clip. Full suppression and a 50/50 blend with time-aligned original
audio are compared to expose the noise-reduction/fidelity tradeoff.

The path boosts low audio before model inference (maximum 64×,
RMS target 0.05, peak headroom 0.9), then reverses that gain afterward. This
addresses the model's absolute-level sensitivity without making uploads louder.

The resampler applies antialiasing and caches polyphase coefficients. Its G2
16↔48 kHz path shares input reads between interpolation phases, pairs symmetric
decimation coefficients, and handles clip boundaries outside the inner loop.
This keeps the same coefficients and zero-padded edges while reducing work;
new exports identify it as `windowed-sinc-3x-v2`. Reference edge samples, spectral
checks, and comparisons with the original implementation cover the optimization.
Active
filter delay is measured once on the unmixed reference, then compensated for
all comparisons. Six DSP tests
check round-trip fidelity, alias rejection, delay calibration, PCM conversion,
and invalid inputs. Real RNNoise tests cover zero-strength passthrough,
concurrent independent states, stable WASM heap size, and invalid strength.

The former DeepFilterNet build has been removed from the lab. The supplied
iPhone 17 Chrome run took about 60 seconds per 30-second snapshot, including
about seven seconds of model creation. This runtime fails the mobile latency
goal even if model creation were removed. It is not an app integration candidate.

SI-SDR measures fidelity to the unmixed reference, which may itself contain
natural recording noise. It is **not** an intelligibility score or transcription
accuracy measurement. Noise-only RMS
reduction also does not establish preservation of speech.

Desktop Chromium/WebKit and CPU throttling are useful compatibility checks;
they cannot establish smartphone speed, peak memory, battery use, or Even App
WebView compatibility. Before shipping, repeat on physical phones inside the
Even App, using real glasses captures and ground-truth transcripts. Include
quiet rooms, traffic, wind, cafés, distant speakers, and competing speech;
compare word errors and names/numbers with denoising both enabled and disabled.

Model/package source: https://github.com/jitsi/rnnoise-wasm

RNNoise upstream: https://github.com/xiph/rnnoise

Reference fixture: https://github.com/snakers4/silero-vad/tree/fbddc91a5d51f5f448f9c158b327ddf75b9355ad/tests/data
