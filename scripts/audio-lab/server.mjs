#!/usr/bin/env node
import { createServer } from 'vite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { loadFixture } from './fixture.mjs';

const fixture = await loadFixture();
const candidate = await readFile(new URL('../../packages/core/assets/vad/earshot-1.2.2.wasm', import.meta.url));
const root = fileURLToPath(new URL('.', import.meta.url));
const server = await createServer({
  configFile: false, root,
  server: { host: '0.0.0.0', port: 5174, strictPort: true, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
  optimizeDeps: { exclude: ['@fluidinference/fluidvad', '@jitsi/rnnoise-wasm'] },
  plugins: [{ name: 'audio-lab-assets', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url?.split('?')[0];
      const bytes = url === '/reference.wav' ? fixture : url === '/earshot-1.2.2.wasm' ? candidate : null;
      if (!bytes) return next();
      res.setHeader('Content-Type', url.endsWith('.wav') ? 'audio/wav' : 'application/wasm');
      res.end(bytes);
    });
  } }],
});
await server.listen();
console.log('Audio lab: http://localhost:5174');
for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? []) {
  if (address.family === 'IPv4' && !address.internal) console.log(`Phone on the same Wi-Fi: http://${address.address}:5174`);
}
