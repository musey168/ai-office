import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
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
export function upstreamDirnamePlugin(): Plugin {
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

export function nodeAssetPlugin(outDir: string): Plugin {
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
      const name = file.split('/').pop()!
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
 * The upstream slides code reaches the disk through `node:fs`.
 *
 * On the server every path has to pass the workspace fence, so the
 * upstream imports are redirected to the controlled implementation. The
 * worker's own modules keep the real filesystem — the store itself has to
 * talk to the disk to do its job.
 *
 * The upstream code names the functions it uses in its imports, so the
 * generated module has to have exactly those names. They are read off
 * Node's own module surface at build time: whatever the upstream code
 * imports from `node:fs` exists on the real module, so the names line up.
 */
export function controlledFilesystemPlugin(): Plugin {
  const controlledModule = resolve(__dirname, '../src/fs-control.ts')
  const virtual = '\0controlled-fs'
  return {
    name: 'controlled-filesystem',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== 'node:fs' && source !== 'node:fs/promises') return null
      if (!importer) return null
      // The virtual module reaches the real filesystem through itself; it
      // must not be redirected again, or the import would loop.
      if (importer.includes('\0controlled-fs')) return null
      const from = importer.split('?')[0]
      // The engine's own code and the store must reach the real filesystem:
      // the store is what talks to the disk on the workspace's behalf, and
      // the engine's modules handle their own files (the wasm, the probes).
      if (from.includes('engine-pool/src/')) return null
      if (from.includes('workspace-store/')) return null
      return virtual
    },
    load(id) {
      if (id !== virtual) return null
      // The upstream code names the functions it imports; the controlled
      // module answers to exactly those names — the ones that touch the
      // user's documents resolve through the store, the rest are its own
      // scratch files.
      return `
        export * from ${JSON.stringify(controlledModule)}
      `
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
    controlledFilesystemPlugin(),
    nodeAssetPlugin(resolve(__dirname, '../dist')),
    // The PDFium wasm travels with the worker: the upstream lookup falls
    // back to `<resourcesPath>/wasm/<file>`, and the worker's resources
    // path is its own directory.
    {
      name: 'pdfium-wasm',
      closeBundle() {
        try {
          const source = createRequire(import.meta.url).resolve(
            '@embedpdf/pdfium/pdfium.wasm',
          )
          const target = resolve(__dirname, '../dist/wasm')
          mkdirSync(target, { recursive: true })
          copyFileSync(source, resolve(target, 'pdfium.wasm'))
          process.stdout.write(`pdfium.wasm → ${target}\n`)
        } catch (error) {
          process.stderr.write(`pdfium.wasm was not copied: ${String(error)}\n`)
        }
      },
    },
  ],
  resolve: {
    alias: [{ find: /^electron$/, replacement: resolve(__dirname, '../src/electron-shim.ts') }],
  },
  // The worker is copied to the server as a single file, so its
  // dependencies have to be inside it. Left external, the server would need
  // them installed — and the server container has no node_modules. The
  // upstream packages pull in a long tail (jszip, opentype, cfb, …), so
  // everything goes in.
  ssr: { noExternal: true },
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
