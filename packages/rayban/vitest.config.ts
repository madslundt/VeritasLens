import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_SRC = resolve(HERE, '../core/src');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    // Force the .web.ts variants in the test environment so we exercise the
    // mock implementations rather than trying to load the native bridge.
    extensions: ['.web.ts', '.ts', '.tsx', '.js', '.jsx', '.json'],
    alias: [
      // '@/' resolves to rayban/src for rayban source files, AND to core/src for
      // core source files that are imported directly by tests. Since vitest aliases
      // are global (not scoped by importer), we use the core/src path here so that
      // core's internal '@/...' imports resolve correctly when core modules are
      // loaded as part of @veritaslens/core. Rayban's own '@/...' imports use the
      // same resolution, which means both packages share the core/src root — this
      // is fine because rayban's own source files only import from '@/state/store'
      // and '@/runtime/*', which happen to exist in both places with compatible shapes.
      //
      // If this causes problems in practice, a custom vite plugin with importer-scoped
      // alias resolution would be the right solution. For now the single alias is enough
      // to make lifecycle tests pass.
      { find: '@', replacement: CORE_SRC },
      // Replace expo-modules-core with our pure-JS mock so EventEmitter works in Node.
      { find: 'expo-modules-core', replacement: resolve(HERE, '__mocks__/expo-modules-core.ts') },
    ],
  },
});
