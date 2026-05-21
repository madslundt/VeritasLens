import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    minify: 'esbuild',
    cssCodeSplit: false,
  },
  esbuild: {
    // The two `console.*` call sites in src/ are both `import.meta.env.DEV`-
    // gated, so dropping unconditionally in prod removes no observable
    // logging. `debugger` should never reach prod either.
    drop: ['console', 'debugger'],
    legalComments: 'none',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
