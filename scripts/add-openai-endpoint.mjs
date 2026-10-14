#!/usr/bin/env node
// Even Hub requires explicit origins in the packaged network permission.
import { readFile, writeFile } from 'node:fs/promises';

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error('Usage: node scripts/add-openai-endpoint.mjs <API base URL> [more URLs]');
  process.exit(1);
}
const origins = inputs.map((raw) => {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new Error('Endpoints must use HTTP or HTTPS without credentials, query parameters, or fragments.');
  }
  return url.origin;
});
const path = new URL('../packages/even-g2/app.json', import.meta.url);
const manifest = JSON.parse(await readFile(path, 'utf8'));
const permission = manifest.permissions.find((p) => p.name === 'network');
if (!permission) throw new Error('The Even G2 manifest has no network permission.');
permission.whitelist = [...new Set([...permission.whitelist, ...origins])];
permission.desc = 'Sends audio to your chosen transcription provider and transcripts to your chosen LLM, including configured custom endpoints. Keys and audio are sent only for requests you initiate.';
await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
console.log('Endpoint origins added. Rebuild and repack the Even G2 app before installing.');
