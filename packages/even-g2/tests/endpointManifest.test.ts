import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

describe('custom endpoint packaging helper', () => {
  it('adds deduplicated origins and rejects a bad batch before writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'veritaslens-manifest-'));
    try {
      await mkdir(join(root, 'scripts'));
      await mkdir(join(root, 'packages/even-g2'), { recursive: true });
      const script = join(root, 'scripts/add-openai-endpoint.mjs');
      await copyFile(resolve(__dirname, '../../../scripts/add-openai-endpoint.mjs'), script);
      const manifest = join(root, 'packages/even-g2/app.json');
      await writeFile(manifest, JSON.stringify({ permissions: [{ name: 'network', whitelist: ['https://api.openai.com'] }] }));
      const add = spawnSync(process.execPath, [script, 'https://custom.example/proxy/v1', 'https://custom.example/v1']);
      expect(add.status).toBe(0);
      const saved = await readFile(manifest, 'utf8');
      expect(JSON.parse(saved).permissions[0].whitelist).toEqual(['https://api.openai.com', 'https://custom.example']);
      const invalid = spawnSync(process.execPath, [script, 'https://another.example/v1', 'https://host/v1?']);
      expect(invalid.status).not.toBe(0);
      expect(await readFile(manifest, 'utf8')).toBe(saved);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
