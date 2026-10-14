import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_SRC = resolve(HERE, '../core/src');

/**
 * When Vite traverses `@veritaslens/core` source files (raw TS, no compiled
 * .d.ts), those files contain `@/something` imports that reference core's own
 * src tree. The standard `@/ → ./src` alias resolves to even-g2/src instead.
 * This plugin intercepts those imports and re-maps them to core/src so the
 * bundler can find the files.
 */
function coreAtAlias(): Plugin {
  const EVEN_G2_SRC = resolve(HERE, 'src');
  const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
  function tryResolve(base: string, sub: string): string | undefined {
    for (const ext of EXTENSIONS) {
      const candidate = resolve(base, sub + ext);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }
  return {
    name: 'vl-core-at-alias',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.startsWith('@/')) return;
      if (!importer) return;
      const sub = source.slice(2); // strip '@/'
      // If importer is inside core/src, resolve against core/src
      if (importer.startsWith(CORE_SRC + '/') || importer === CORE_SRC) {
        return tryResolve(CORE_SRC, sub);
      }
      // Otherwise resolve against even-g2/src (the normal case)
      return tryResolve(EVEN_G2_SRC, sub);
    },
  };
}

/** Earshot is a small vendored model. FluidVad's WASM is emitted by Vite. */
const VAD_ASSETS: Array<{ from: string; to: string }> = [
  { from: '../core/assets/vad/earshot-1.2.2.wasm', to: 'earshot-1.2.2.wasm' },
  { from: '../core/assets/vad/EARSHOT-LICENSE', to: 'EARSHOT-LICENSE' },
  { from: '../core/assets/vad/LIBM-LICENSE', to: 'LIBM-LICENSE' },
  { from: '../core/assets/vad/RUST-LICENSE', to: 'RUST-LICENSE' },
  { from: '../../node_modules/@fluidinference/fluidvad/SILERO_LICENSE', to: 'SILERO-LICENSE' },
  { from: '../../node_modules/@fluidinference/fluidvad/LICENSE', to: 'FLUIDVAD-LICENSE' },
];

function copyVadAssets(): Plugin {
  let outDir = 'dist';
  return {
    name: 'vl-copy-vad-assets',
    apply: 'build',
    configResolved(cfg) { outDir = cfg.build.outDir; },
    async closeBundle() {
      const destRoot = resolve(HERE, outDir);
      await mkdir(destRoot, { recursive: true });
      for (const { from, to } of VAD_ASSETS) {
        const src = resolve(HERE, from);
        if (!existsSync(src)) {
          this.error(`VAD asset missing: ${from}. Did npm install run?`);
          return;
        }
        await copyFile(src, join(destRoot, to));
      }
    },
  };
}

/** Serve the vendored candidate model at its document-relative dev URL. */
function serveVadAssets(): Plugin {
  return {
    name: 'vl-serve-vad-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        const url = req.url.split('?')[0] ?? '';
        const asset = VAD_ASSETS.find((a) => url === `/${a.to}`);
        if (!asset) return next();
        try {
          const buf = await readFile(resolve(HERE, asset.from));
          res.setHeader('Content-Type', asset.to.endsWith('.wasm') ? 'application/wasm' : 'text/plain');
          res.setHeader('Content-Length', String(buf.byteLength));
          res.setHeader('Cache-Control', 'no-cache');
          res.end(buf);
        } catch (err) {
          next(err as Error);
        }
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [coreAtAlias(), solid(), copyVadAssets(), serveVadAssets()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The runtime and candidate asset live outside even-g2/src.
    fs: {
      allow: ['.', '../core', '../../node_modules/@fluidinference/fluidvad'],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: false,
    // Drop console/debugger in production via OXC minifier (Vite 8 default).
    // rolldownOptions.output only applies during `vite build`, not the dev
    // server, so no command guard is needed.
    rolldownOptions: {
      output: {
        minify: {
          compress: {
            dropConsole: true,
            dropDebugger: true,
          },
        },
      },
    },
  },
  // Pre-bundling would relocate the WASM glue's import.meta.url away from
  // its model asset. Keep the ESM package at its original location in dev.
  optimizeDeps: { exclude: ['@fluidinference/fluidvad'] },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}));
