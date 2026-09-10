import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/bridge/index.ts',
    'src/bridge/file-uploads.ts',
    'src/bridge/router-entry.ts',
    'src/tui/index.ts',
  ],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  // pnpm's store paths can resolve outside the project when the release
  // audit builds an archive with node_modules linked to the workspace.
  // Canonicalize those paths before Rolldown hashes a chunk so the committed
  // lib/ is reproducible from a clean archive at any filesystem location.
  plugins: [
    {
      name: 'canonicalize-node-module-paths',
      renderChunk(code) {
        const canonical = code.replace(/^(\/\/#region )(.*)$/gm, (_line, prefix, path) => {
          const nodeModules = path.indexOf('node_modules/')
          return nodeModules >= 0
            ? `${prefix}${path.slice(nodeModules)}`
            : `${prefix}${path}`
        })
        return canonical === code ? null : { code: canonical, map: null }
      },
    },
  ],
  outputOptions: {
    // Keep sourcemap sources rooted at the package's node_modules path too;
    // otherwise absolute realpaths make the map differ even when JS does not.
    sourcemapPathTransform(source) {
      const marker = '/node_modules/'
      const nodeModules = source.indexOf(marker)
      return nodeModules >= 0
        ? `../node_modules/${source.slice(nodeModules + marker.length)}`
        : source
    },
  },
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
