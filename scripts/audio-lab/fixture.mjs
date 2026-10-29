import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const fixtureUrl = 'https://raw.githubusercontent.com/snakers4/silero-vad/fbddc91a5d51f5f448f9c158b327ddf75b9355ad/tests/data/test.wav';
export const fixtureHash = '89f17d9c94c4b31eb320f424628bcbc920abaddbee6e2760fd868bfb1d9a2e47';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function loadFixture() {
  const directory = join(tmpdir(), 'veritaslens-vad');
  const path = join(directory, `${fixtureHash}.wav`);
  try {
    const bytes = await readFile(path);
    if (sha256(bytes) === fixtureHash) return bytes;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(fixtureUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Reference WAV: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== fixtureHash) throw new Error('Reference WAV checksum mismatch');
  await mkdir(directory, { recursive: true }); await writeFile(path, bytes);
  return bytes;
}
