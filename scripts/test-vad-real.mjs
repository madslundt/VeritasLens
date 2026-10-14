#!/usr/bin/env node
// Run the production adapter and bundled WASM models without mocked inference.
// Node 22.18+ (native TypeScript support) is required. No LLM calls are made.
// node scripts/test-vad-real.mjs [--speech capture.wav] [--reply reply.wav]
//   [--noise noise.wav] [--compare-legacy] [--report results.json]
// WAV inputs must be mono, 16-bit PCM at 16 kHz. Without --speech, download
// and cache the pinned public Silero reference recording outside the repo.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { SileroVADSession } from '../packages/core/src/runtime/vad/silero.ts';
import { trimPcmToSegments } from '../packages/core/src/runtime/audioBuffer.ts';

const FIXTURE_COMMIT = 'fbddc91a5d51f5f448f9c158b327ddf75b9355ad';
const FIXTURE_URL = `https://raw.githubusercontent.com/snakers4/silero-vad/${FIXTURE_COMMIT}/tests/data/test.wav`;
const FIXTURE_HASH = '89f17d9c94c4b31eb320f424628bcbc920abaddbee6e2760fd868bfb1d9a2e47';
const RATE = 16_000;
const { values } = parseArgs({ options: {
  speech: { type: 'string' },
  reply: { type: 'string', multiple: true, default: [] },
  report: { type: 'string' },
  noise: { type: 'string', multiple: true, default: [] },
  'compare-legacy': { type: 'boolean', default: false },
} });

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function loadSpeech() {
  if (values.speech) return readFile(values.speech);
  const cache = join(tmpdir(), 'veritaslens-vad', `${FIXTURE_HASH}.wav`);
  try {
    const bytes = await readFile(cache);
    if (hash(bytes) === FIXTURE_HASH) return bytes;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(FIXTURE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Reference recording download: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(bytes), FIXTURE_HASH, 'Reference recording checksum mismatch');
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, bytes);
  return bytes;
}

function decodeWav(wav) {
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF', 'Expected a RIFF WAV');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE', 'Expected a WAVE file');
  let pcm;
  let format;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const length = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    assert.ok(start + length <= wav.length, 'Truncated WAV chunk');
    const tag = wav.toString('ascii', offset, offset + 4);
    if (tag === 'fmt ') {
      assert.ok(length >= 16, 'Truncated WAV format');
      format = [wav.readUInt16LE(start), wav.readUInt16LE(start + 2),
        wav.readUInt32LE(start + 4), wav.readUInt16LE(start + 14)];
    }
    if (tag === 'data') pcm = wav.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  assert.deepEqual(format, [1, 1, RATE, 16], 'Use mono 16-bit PCM at 16000 Hz');
  assert.ok(pcm?.length > 0 && pcm.length % 2 === 0, 'Missing or incomplete PCM samples');
  return pcm;
}

function signal(samples, fn) {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(fn(i)))), i * 2);
  }
  return pcm;
}

function rms(pcm) {
  let energy = 0;
  for (let i = 0; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(energy / (pcm.length / 2));
}

const speechWav = await loadSpeech();
const speech = decodeWav(speechWav);
const clip = speech.subarray(0, Math.min(speech.length, RATE * 2 * 6));
const replies = await Promise.all(values.reply.map(async (path) => ({
  name: `reply ${basename(path)}`, pcm: decodeWav(await readFile(path)),
})));
const candidateModel = await readFile(new URL('../packages/core/assets/vad/earshot-1.2.2.wasm', import.meta.url));
const sileroModel = await readFile(new URL('../node_modules/@fluidinference/fluidvad/dist/fluidvad_bg.wasm', import.meta.url));
const noises = await Promise.all(values.noise.map(async (path) => ({
  name: `noise ${basename(path)}`, pcm: decodeWav(await readFile(path)), expected: false,
})));
const nativeFetch = globalThis.fetch;
// Substitute only local asset delivery, leaving both neural models intact.
globalThis.fetch = (url, ...args) => String(url) === './earshot-1.2.2.wasm'
  ? Promise.resolve(new Response(candidateModel, { headers: { 'Content-Type': 'application/wasm' } }))
  : String(url).endsWith('/fluidvad_bg.wasm')
    ? Promise.resolve(new Response(sileroModel, { headers: { 'Content-Type': 'application/wasm' } }))
    : nativeFetch(url, ...args);

const report = {
  node: process.version,
  environment: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  speechSource: values.speech ?? FIXTURE_URL,
  speechSha256: hash(speechWav),
  replySources: values.reply,
  modelSha256: { candidate: hash(candidateModel), silero: hash(sileroModel) },
  runtimeBytes: candidateModel.length + sileroModel.length,
  configuration: { candidate: 'earshot 1.2.2', confirmation: 'Silero v6 / FluidVad 0.2.0',
    threshold: 0.5, minSpeechMs: 200, legacyThreshold: 0.3, legacyMinSpeechMs: 400 },
  noiseSources: values.noise,
  results: [], benchmarks: [], checks: [],
  note: 'Reference audio, synthetic signals, and optional reply recordings; this is not a glasses microphone accuracy benchmark.',
};
let session;
try {
  session = new SileroVADSession();
  const start = performance.now();
  await session.init();
  report.initMs = Math.round(performance.now() - start);
  let seed = 42;
  const noise = signal(RATE * 3, () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return (seed / 4294967296 * 2 - 1) * 1200;
  });
  const scenarios = [
    { name: 'reference speech', pcm: speech, expected: true },
    { name: 'silence', pcm: Buffer.alloc(RATE * 2 * 3), expected: false },
    { name: 'white noise', pcm: noise, expected: false },
    { name: 'DC offset', pcm: signal(RATE * 3, () => 600), expected: false },
    ...[60, 220, 440, 880].map((hz) => ({ name: `tone ${hz} Hz`,
      pcm: signal(RATE * 3, (i) => 1200 * Math.sin(2 * Math.PI * hz * i / RATE)), expected: false })),
    ...[1, 0.5, 0.2, 0.1, 0.05, 0.02].flatMap((gain) => [200, 50].map((floor) => ({
      name: `speech gain ${gain}, RMS floor ${floor}`, floor,
      pcm: signal(clip.length / 2, (i) => clip.readInt16LE(i * 2) * gain),
    }))),
    ...replies.map((reply) => ({ ...reply, expected: true })),
    ...noises,
  ];
  for (const { name, pcm, expected, floor = 200 } of scenarios) {
    const start = performance.now();
    const result = await session.predict(pcm, RATE, floor);
    const detected = result.voiceFrames > 0;
    report.results.push({ name, seconds: pcm.length / (RATE * 2), rms: Math.round(rms(pcm)),
      detected, expected, mismatch: expected === undefined ? undefined : detected !== expected,
      ms: Math.round(performance.now() - start) });
  }

  assert.equal(report.results[0].detected, true, 'Reference speech must be detected');
  assert.equal(report.results[1].detected, false, 'Silence must be rejected');
  report.checks.push('Reference speech detected; silence rejected');

  const segments = await session.extractSpeechSegments(clip, RATE);
  assert.ok(segments.length > 0, 'Speech segments must be extracted');
  for (const segment of segments) {
    assert.ok(segment.start >= 0 && segment.end > segment.start && segment.end <= clip.length / 2);
  }
  // Interleave noise with speech repeatedly to detect state contamination.
  for (let i = 0; i < 5; i++) {
    assert.equal((await session.predict(noise, RATE)).voiceFrames, 0);
    assert.deepEqual(await session.extractSpeechSegments(clip, RATE), segments);
  }
  report.checks.push('Five speech/noise interleavings preserve segment boundaries');
  const parallel = await Promise.all(Array.from({ length: 10 }, (_, i) => i % 2 === 0
    ? session.extractSpeechSegments(clip, RATE) : session.predict(noise, RATE)));
  parallel.forEach((result, i) => i % 2 === 0
    ? assert.deepEqual(result, segments) : assert.equal(result.voiceFrames, 0));
  report.checks.push('Ten concurrent presence/trim requests stay independent');

  for (const rate of [44_100, 48_000]) {
    const samples = clip.length / 2;
    const resampled = signal(Math.floor(samples * rate / RATE), (i) => {
      const position = i * RATE / rate;
      const lower = Math.floor(position);
      const a = clip.readInt16LE(lower * 2);
      const b = clip.readInt16LE(Math.min(samples - 1, lower + 1) * 2);
      return a + (b - a) * (position - lower);
    });
    assert.equal((await session.predict(resampled, rate)).voiceFrames, 1);
    const rateSegments = await session.extractSpeechSegments(resampled, rate);
    assert.ok(rateSegments.length > 0 && rateSegments.every((s) => s.end <= resampled.length / 2));
  }
  report.checks.push('Speech at 44.1/48 kHz resamples correctly with bounded trim offsets');

  const trimmed = trimPcmToSegments(speech, await session.extractSpeechSegments(speech, RATE), { sampleRate: RATE });
  assert.ok(trimmed.length <= speech.length, 'Trimming must not enlarge the upload');
  assert.equal((await session.predict(trimmed, RATE)).voiceFrames, 1, 'Trimming must preserve speech');
  report.trim = { originalBytes: speech.length, trimmedBytes: trimmed.length };
  report.checks.push('Full-recording trim preserves speech and does not enlarge the upload');

  // End in the middle of a 1536-sample inference frame; uploaded offsets
  // must remain inside the original PCM despite the adapter's zero padding.
  const tail = Buffer.concat([Buffer.alloc(RATE * 2 * 2), clip.subarray(0, clip.length - 142)]);
  const tailSegments = await session.extractSpeechSegments(tail, RATE);
  assert.equal((await session.predict(tail, RATE)).voiceFrames, 1);
  assert.ok(tailSegments.length > 0 && tailSegments.every((s) => s.end <= tail.length / 2));
  report.checks.push('Speech at a partial-frame tail is detected and trim offsets are clamped');
  session.dispose();
  assert.deepEqual(await session.extractSpeechSegments(clip, RATE), segments);
  report.checks.push('Dispose/reinitialize preserves real-model results');
  session.dispose();

  if (values['compare-legacy']) {
    const { NonRealTimeVAD } = await import('@ricky0123/vad-web');
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const bytes = await readFile(new URL('../node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx', import.meta.url));
    const legacy = await NonRealTimeVAD.new({
      modelFetcher: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      positiveSpeechThreshold: 0.3, negativeSpeechThreshold: 0.2,
    });
    async function legacyScan(pcm, presence = false) {
      const samples = pcm.length / 2;
      const input = new Float32Array(Math.ceil(samples / 1536) * 1536);
      for (let i = 0; i < samples; i++) input[i] = pcm.readInt16LE(i * 2) / 32768;
      legacy.frameProcessor.endSegment(() => {});
      let found = false;
      try {
        for await (const segment of legacy.run(input, RATE)) {
          found = true;
          if (presence) break;
        }
      } finally { legacy.frameProcessor.endSegment(() => {}); }
      return found;
    }
    for (const scenario of scenarios.filter((s) => s.expected !== undefined)) {
      const legacyDetected = await legacyScan(scenario.pcm, true);
      report.results.find((r) => r.name === scenario.name).legacyDetected = legacyDetected;
    }
    // Alternate order across warmed trials to reduce timing/order bias.
    session = new SileroVADSession();
    await session.init();
    await session.extractSpeechSegments(speech, RATE);
    await legacyScan(speech);
    const timings = { legacyTrimMs: [], cascadeTrimMs: [], legacyGateMs: [], cascadeGateMs: [] };
    for (let trial = 0; trial < 5; trial++) {
      const jobs = [
        ['legacyTrimMs', () => legacyScan(speech)],
        ['cascadeTrimMs', () => session.extractSpeechSegments(speech, RATE)],
        ['legacyGateMs', () => legacyScan(speech, true)],
        ['cascadeGateMs', () => session.predict(speech, RATE)],
      ];
      if (trial % 2) jobs.reverse();
      for (const [name, run] of jobs) {
        const begin = performance.now();
        await run();
        timings[name].push(performance.now() - begin);
      }
    }
    for (const [name, ms] of Object.entries(timings)) {
      report.benchmarks.push({ name, medianMs: Math.round([...ms].sort((a, b) => a - b)[2]), trialsMs: ms.map(Math.round) });
    }
    report.legacyRuntimeBytes = bytes.length + (await readFile(new URL('../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', import.meta.url))).length;
    session.dispose();
  }
  console.table(report.results);
  if (report.benchmarks.length) console.table(report.benchmarks);
  console.log(`${report.checks.length} integration checks passed; ${report.results.filter((r) => r.mismatch).length} diagnostic classification mismatches.`);
} finally {
  session?.dispose();
  globalThis.fetch = nativeFetch;
  if (values.report) await writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
}
