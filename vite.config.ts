import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Files we copy verbatim into `dist/` so the WebView can load them at the
 * paths the VAD wrapper expects.
 *
 * Only the Silero `.onnx` model is hand-copied — the ORT WASM glue is
 * imported by `@ricky0123/vad-web` via the aliased `onnxruntime-web/wasm`
 * subpath, so Vite handles its asset emission automatically (and uses the
 * pure-WASM variant, not the 26 MB JSEP/WebGPU bundle that the package's
 * default entrypoint would pull in).
 *
 * We tried FP16 conversion to halve the model size (see
 * `scripts/quantize-vad.py` history) — generic ONNX FP16 converters break
 * the legacy model's LSTM subgraphs (Reshape/Shape type mismatches, then
 * topological-sort failures with op blocklists), so we ship FP32 as the
 * vad-web package does. Dynamic INT8 produces a same-size or larger model
 * because Silero is too small for the per-op scale metadata to pay off.
 */
const VAD_ASSETS: Array<{ from: string; to: string }> = [
  {
    from: 'node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx',
    to: 'silero_vad_legacy.onnx',
  },
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

/**
 * Dev-server middleware. Two responsibilities:
 *
 * 1. Serve VAD assets (silero_vad_legacy.onnx) under the runtime-expected
 *    root path by rewriting to their node_modules location.
 *
 * 2. Serve ORT's `.mjs` glue files RAW (skipping Vite's transform pipeline)
 *    so the Worker that ORT spawns can load them. Vite's transform injects
 *    `/@vite/client` imports for HMR which fail to resolve inside a Worker
 *    context, producing
 *    `TypeError: Importing a module script failed.` This middleware reads
 *    the file from node_modules and writes it back unmodified before Vite
 *    gets a chance to touch it.
 */
const ORT_RAW_FILES = [
  'ort.wasm.bundle.min.mjs',
  'ort-wasm-simd-threaded.mjs',
];

function serveVadAssets(): Plugin {
  return {
    name: 'vl-serve-vad-assets',
    apply: 'serve',
    configureServer(server) {
      // 1. Raw ORT .mjs (must run BEFORE Vite's transform middleware).
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        const path = req.url.split('?')[0] ?? '';
        const file = ORT_RAW_FILES.find((name) =>
          path === `/node_modules/onnxruntime-web/dist/${name}`,
        );
        if (!file) return next();
        try {
          const abs = resolve(HERE, 'node_modules/onnxruntime-web/dist', file);
          const { readFile } = await import('node:fs/promises');
          const buf = await readFile(abs);
          res.setHeader('Content-Type', 'text/javascript');
          res.setHeader('Content-Length', String(buf.byteLength));
          res.setHeader('Cache-Control', 'no-cache');
          res.end(buf);
        } catch (err) {
          next(err as Error);
        }
      });
      // 2. Silero model + alias paths.
      server.middlewares.use((req, _res, next) => {
        if (!req.url) return next();
        const url = req.url.split('?')[0] ?? '';
        const asset = VAD_ASSETS.find((a) => url === `/${a.to}`);
        if (!asset) return next();
        if (!existsSync(resolve(HERE, asset.from))) return next();
        req.url = `/${asset.from}`;
        next();
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [solid(), copyVadAssets(), serveVadAssets()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // Redirect the default `onnxruntime-web` entry (which pulls in the
      // 26 MB JSEP/WebGPU-enabled WASM blob) to the pure-WASM subpath. The
      // WebView only needs CPU inference for our small Silero model, and
      // mobile WKWebView lacks WebGPU anyway. Saves ~14 MB in the .ehpk.
      // Anchored regex so `onnxruntime-web/wasm` (used internally by
      // vad-web for the v5 model bindings) is NOT rewritten to a non-
      // existent `/wasm/wasm` subpath.
      { find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' },
    ],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // node_modules is outside Vite's default fs.allow; explicitly allow the
    // VAD asset paths so the dev-time middleware above can stream them.
    fs: {
      allow: ['.', 'node_modules/@ricky0123/vad-web/dist', 'node_modules/onnxruntime-web/dist'],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    minify: 'esbuild',
    cssCodeSplit: false,
  },
  esbuild: {
    // Drop console / debugger only in production builds. Scoping by
    // `command` keeps the dev-server transform leaving `console.*` intact,
    // which is critical for the `import.meta.env.DEV`-gated diagnostic
    // logs (the gating already dead-code-eliminates them in prod, but the
    // `drop` is kept as defense in depth).
    drop: command === 'build' ? ['console', 'debugger'] : [],
    legalComments: 'none',
  },
  // vad-web is a CommonJS-only package (no `module`/`exports` map), so it
  // MUST be pre-bundled by Vite to get CJS→ESM interop. ORT-web, on the
  // other hand, locates its WASM glue at runtime via
  // `new URL('./ort-wasm-simd-threaded.mjs', import.meta.url)`. Pre-bundling
  // it breaks that self-reference (the URL points into `.vite/deps`, where
  // no `.mjs` file lives). Solution: include vad-web but exclude ORT, so
  // vad-web's `require("onnxruntime-web")` is left as a runtime import
  // that Vite resolves to the un-bundled package and its working URL.
  optimizeDeps: {
    include: ['@ricky0123/vad-web'],
    exclude: ['onnxruntime-web', 'onnxruntime-web/wasm'],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}));
