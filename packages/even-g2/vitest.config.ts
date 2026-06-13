import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

const HERE = dirname(fileURLToPath(import.meta.url));
// Resolve the core package directory. During tests the workspace symlink
// @veritaslens/core → ../core (sibling package directory).
const CORE_ROOT = resolve(HERE, '../core');
const CORE_SRC = resolve(CORE_ROOT, 'src');
const G2_SRC = resolve(HERE, 'src');

/**
 * When core source files (which use `@/` to mean core/src) are loaded by the
 * even-g2 vitest runner, a global `@/ → even-g2/src` alias would break them.
 * This plugin resolves `@/…` relative to the *importer*: core files get
 * core/src, everything else gets even-g2/src.
 *
 * We return `null` and let Vite's normal resolver finish the job (extension
 * lookup, etc.) — we only rewrite the virtual alias path.
 */
const dualAtAliasPlugin: Plugin = {
  name: 'dual-at-alias',
  enforce: 'pre',
  async resolveId(id, importer, opts) {
    if (!id.startsWith('@/')) return null;
    const sub = id.slice(2); // strip '@/'
    const base = importer && importer.startsWith(CORE_ROOT) ? CORE_SRC : G2_SRC;
    const rewritten = `${base}/${sub}`;
    // Let Vite's default resolver finish (extension lookup, etc.)
    return this.resolve(rewritten, importer, { ...opts, skipSelf: true });
  },
};

export default defineConfig({
  plugins: [solid(), dualAtAliasPlugin],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
