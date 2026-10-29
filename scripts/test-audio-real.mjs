#!/usr/bin/env node
// Node 22.18+. Actual WASM inference; no LLM requests or microphone access.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { cpus } from 'node:os';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { decodeWav, wav } from './audio-lab/dsp.mjs';
import { loadFixture, fixtureUrl, sha256 } from './audio-lab/fixture.mjs';

const { values } = parseArgs({ options: { report: { type: 'string' }, samples: { type: 'string' }, filter: { type: 'string', default: 'rnnoise' } } });
if (!['rnnoise', 'rnnoise-modern'].includes(values.filter)) throw new Error('Choose --filter rnnoise or rnnoise-modern');
const { runSuite } = await import('./audio-lab/rnnoise-suite.mjs');
const speech = await loadFixture();
const assets = new Map(await Promise.all([
  ['./earshot-1.2.2.wasm', '../packages/core/assets/vad/earshot-1.2.2.wasm'],
  ['fluidvad_bg.wasm', '../node_modules/@fluidinference/fluidvad/dist/fluidvad_bg.wasm'],
  values.filter === 'rnnoise-modern' ? ['rnnoise-sync.js', '../node_modules/@jitsi/rnnoise-wasm/dist/rnnoise-sync.js']
      : ['rnnoise.wasm', '../node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm'],
].map(async ([url, path]) => [url, await readFile(new URL(path, import.meta.url))])));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const name = String(url) === './earshot-1.2.2.wasm' ? String(url) : String(url).split('/').at(-1);
  const bytes = assets.get(name);
  if (!bytes) throw new Error(`Unexpected network request: ${url}`);
  return new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } });
};
try {
  const { report, samples } = await runSuite(decodeWav(speech), (message) => console.log(message), { variant: values.filter === 'rnnoise-modern' ? 'modern' : 'small' });
  report.environment = { node: process.version, cpu: cpus()[0]?.model, platform: process.platform, arch: process.arch };
  report.fixture = { source: fixtureUrl, sha256: sha256(speech) };
  report.assets = [...assets].map(([name, bytes]) => ({ name, bytes: bytes.length, gzipBytes: gzipSync(bytes).length, sha256: sha256(bytes) }));
  report.memoryAtEnd = process.memoryUsage();
  console.table(report.vad); console.table(report.denoise);
  console.log(JSON.stringify({ checks: report.checks, delayMs: report.delayMs, longWindow: report.longWindow, assets: report.assets }, null, 2));
  if (values.report) await writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
  if (values.samples) {
    await mkdir(values.samples, { recursive: true });
    for (const [name, audio] of Object.entries(samples)) await writeFile(join(values.samples, `${name}.wav`), wav(audio));
  }
} finally { globalThis.fetch = originalFetch; }
