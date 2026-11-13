import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { upstreamWorkspaceResolver } from '@ai-office/rpc-bridge/build/upstream-resolver'

/**
 * `?asset` is an electron-vite convention: the main process imports a file
 * by path. The Node worker needs the same thing — the wasm sits next to the
 * bundle and is referenced relatively, so the build machine and the server
 * may live in different directories.
 */
const PACKAGES_DIR = resolve(__dirname, '../../packages')

/**
 * `__dirname` is a CommonJS global; the upstream main-process modules use it
 * at module level (the renderer/preload paths). In an ESM bundle there is
 * none, so it is replaced with the directory the file actually lives in.
 */
function upstreamDirnamePlugin(): Plugin {
  return {
    name: 'upstream-dirname',
    enforce: 'pre',
    transform(code, id) {
      if (!code.includes('__dirname')) return null
      const file = id.split('?')[0]
      if (!file.includes('/apps/') && !file.includes('/packages/')) return null
      return { code: code.replace(/\b__dirname\b/g, JSON.stringify(dirname(file))), map: null }
    },
  }
}

function nodeAssetPlugin(outDir: string): Plugin {
  const assets: { from: string; name: string }[] = []
  return {
    name: 'node-asset-path',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.endsWith('?asset')) return null
      const file = source.slice(0, -'?asset'.length)
      if (file.startsWith('@genoffice/')) {
        // a package subpath: the upstream exports map points it at src/
        const rest = file.slice('@genoffice/'.length)
        const slash = rest.indexOf('/')
        const pkg = slash === -1 ? rest : rest.slice(0, slash)
        const sub = slash === -1 ? '' : rest.slice(slash + 1)
        const candidate = resolve(PACKAGES_DIR, pkg, 'src', sub)
        if (existsSync(candidate)) return `${candidate}?node-asset`
        return null
      }
      const absolute = file.startsWith('.') && importer ? resolve(dirname(importer), file) : file
      return `${absolute}?node-asset`
    },
    load(id) {
      if (!id.endsWith('?node-asset')) return null
      const file = id.slice(0, -'?node-asset'.length)
      const name = basename(file)
      assets.push({ from: file, name })
      // The bundle refers to the copy next to it, so the build machine and
      // the server may sit in different directories.
      return `export default new URL('./${name}', import.meta.url).href`
    },
    closeBundle() {
      if (!assets.length) return
      mkdirSync(outDir, { recursive: true })
      for (const asset of assets) {
        copyFileSync(asset.from, resolve(outDir, asset.name))
      }
    },
  }
}

/**
 * The build for the server-side engine worker.
 *
 * The upstream engine packages are plain TypeScript, so they are bundled for
 * Node here. Two things are special:
 *
 * - `electron` is aliased to the **server shim** — the upstream app modules
 *   that build the render tree import Electron at the top, and the server
 *   has no windows;
 * - `@genoffice/*` resolves against the upstream checkout's sources (the
 *   same resolver the browser build uses), so a new upstream subpath
 *   resolves without touching this file.
 */
export default defineConfig({
  plugins: [
    upstreamWorkspaceResolver(),
    upstreamDirnamePlugin(),
    nodeAssetPlugin(resolve(__dirname, '../dist')),
  ],
  resolve: {
    alias: [{ find: /^electron$/, replacement: resolve(__dirname, '../src/electron-shim.ts') }],
  },
  build: {
    ssr: true,
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: {
      input: { worker: resolve(__dirname, '../src/worker.ts') },
      output: {
        format: 'es',
        entryFileNames: '[name].mjs',
      },
    },
  },
})
