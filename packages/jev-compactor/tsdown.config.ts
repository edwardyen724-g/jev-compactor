import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    platform: 'node',
    target: 'node20',
    clean: true,
  },
  {
    entry: { cli: 'src/cli.ts', mcp: 'src/mcp.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
