import { SileroVADSession } from '../../packages/core/src/runtime/vad/silero.ts';
import { denoiseRnnoise } from './rnnoise.mjs';
import { floatToPcm, findDelay, mix, noise, rms, siSdr } from './dsp.mjs';

const rounded = (n) => Math.round(n * 100) / 100;
function check(ok, message) { if (!ok) throw new Error(message); }

export async function runSuite(reference, progress = () => {}, { variant = 'small' } = {}) {
  const denoise = (audio, options) => denoiseRnnoise(audio, { ...options, variant });
  const started = performance.now();
  const report = { environment: globalThis.navigator?.userAgent ?? `Node ${globalThis.process?.version}`,
    crossOriginIsolated: globalThis.crossOriginIsolated ?? false,
    hardwareConcurrency: globalThis.navigator?.hardwareConcurrency ?? null,
    configuration: { denoiser: `@jitsi/rnnoise-wasm@0.2.1 / RNNoise ${variant === 'small' ? '0.1 small' : '0.2 modern'}`, sampleRate: 16000,
      resampler: 'windowed-sinc-3x-v2',
      note: 'Short comparison with synthetic noise and one reference; not a transcription accuracy test.' },
    vad: [], denoise: [], checks: [] };
  const clean = new Float32Array(8 * 16000); clean.set(reference.subarray(0, 6 * 16000), 16000);
  const background = noise(clean.length);
  const cases = [
    { name: 'clean speech', audio: clean, expected: true },
    { name: 'quiet speech', audio: Float32Array.from(clean, x => x * 0.02), floor: 50, expected: true },
    { name: 'silence', audio: new Float32Array(clean.length), expected: false },
    { name: 'noise only', audio: Float32Array.from(background, x => x * 0.2), expected: false },
    ...[10, 0, -5].map(snr => ({ name: `speech ${snr} dB SNR`, audio: mix(clean, background, snr), expected: true })),
  ];
  const vad = new SileroVADSession();
  const samples = {};
  try {
    progress('Initializing VAD…'); const init = performance.now(); await vad.init(); report.vadInitMs = rounded(performance.now() - init);
    progress('Calibrating RNNoise delay on reference speech…');
    const calibration = await denoise(clean);
    report.denoiserColdInitMs = calibration.timing.initMs;
    const delay = findDelay(clean, calibration.delayed);
    report.delaySamples = delay; report.delayMs = delay / 16;
    report.cleanSiSdrDb = rounded(siSdr(clean, calibration.delayed.subarray(delay, delay + clean.length)));
    check(delay > 0 && report.cleanSiSdrDb > 0, 'RNNoise delay calibration failed');
    for (const scenario of cases) {
      progress(`RNNoise comparison: ${scenario.name}`);
      const start = performance.now();
      const raw = await vad.predict(floatToPcm(scenario.audio), 16000, scenario.floor ?? 200);
      report.vad.push({ name: scenario.name, detected: raw.voiceFrames > 0, expected: scenario.expected, gateMs: rounded(performance.now() - start) });
      for (const strength of scenario.name.includes('speech') ? [0.5, 1] : [1]) {
        const result = await denoise(scenario.audio, { delay, strength });
        const detected = (await vad.predict(floatToPcm(result.audio), 16000, scenario.floor ?? 200)).voiceFrames > 0;
        const row = { name: scenario.name, ...result.timing, detected, expected: scenario.expected,
          inputRms: rounded(rms(scenario.audio) * 32768), outputRms: rounded(rms(result.audio) * 32768) };
        if (scenario.name.startsWith('speech')) {
          row.inputSiSdrDb = rounded(siSdr(clean, scenario.audio)); row.outputSiSdrDb = rounded(siSdr(clean, result.audio));
          row.improvementDb = rounded(row.outputSiSdrDb - row.inputSiSdrDb);
        }
        if (scenario.name === 'clean speech') row.referenceFidelityDb = rounded(siSdr(clean, result.audio));
        report.denoise.push(row);
        if (scenario.name === 'speech 0 dB SNR' && strength === 0.5) {
          samples.clean = clean; samples.noisy = scenario.audio; samples.denoised = result.audio;
        }
        if (scenario.name === 'silence') check(rms(result.audio) < 1e-8, 'RNNoise generates sound from silence');
      }
    }
    report.vadMismatches = report.vad.filter(r => r.detected !== r.expected).length;
    report.denoisedDetectionMismatches = report.denoise.filter(r => r.detected !== r.expected).length;
    report.normalizedDetectionMismatches = report.denoisedDetectionMismatches;
    check(report.vadMismatches === 0, 'Raw VAD baseline failed');
    report.checks.push('Raw speech/noise detection matches all reference cases');
    // Keep filter failures as diagnostic results rather than hiding the report.
    if (!report.denoisedDetectionMismatches) report.checks.push('RNNoise preserves expected detection in every tested case');
    progress('Checking partial frames and independent RNNoise state…');
    const tail = clean.subarray(16000, 7 * 16000 - 73);
    const a = await denoise(tail, { delay }); const b = await denoise(tail, { delay });
    check(a.audio.length === tail.length && a.audio.every((v, i) => v === b.audio[i]), 'RNNoise snapshot state or partial-frame failure');
    report.checks.push('Independent RNNoise states are deterministic and preserve partial-frame length');
    progress('Measuring one 30-second RNNoise snapshot…');
    const long = new Float32Array(30 * 16000);
    for (let offset = 0; offset < long.length; offset += reference.length) long.set(reference.subarray(0, long.length - offset), offset);
    const trimStart = performance.now(); await vad.extractSpeechSegments(floatToPcm(long), 16000);
    report.longWindow = { seconds: 30, vadTrimMs: [rounded(performance.now() - trimStart)], denoise: [(await denoise(long, { delay })).timing] };
    report.totalSuiteMs = rounded(performance.now() - started);
    return { report, samples };
  } finally { vad.dispose(); }
}
