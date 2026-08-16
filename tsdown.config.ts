import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/bridge/index.ts', 'src/bridge/router-entry.ts', 'src/tui/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
