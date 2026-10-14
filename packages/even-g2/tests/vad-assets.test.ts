import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

describe('VAD development assets', () => {
  let server: ViteDevServer;
  let origin: string;

  beforeAll(async () => {
    server = await createServer({
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite test server address');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => { await server?.close(); });

  it.each(['/earshot-1.2.2.wasm', '/earshot-1.2.2.wasm?cache=1'])(
    'serves the exact candidate model rather than SPA HTML at %s', async (path) => {
      const expected = await readFile(new URL('../../core/assets/vad/earshot-1.2.2.wasm', import.meta.url));
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/wasm');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
    },
  );
});
