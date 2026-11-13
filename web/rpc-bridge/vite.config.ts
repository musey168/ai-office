import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * Builds the browser-side bridge: one bundle per app, from the **upstream**
 * preload source, with `electron` aliased to our shim.
 *
 * The upstream preload scripts are the channel contract — every method name,
 * argument shape and return shape comes from there. We do not restate it.
 */
const APPS = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'shell'] as const

const PACKAGES_DIR = resolve(__dirname, '../../packages')

/**
 * Resolve `@genoffice/<pkg>` and `@genoffice/<pkg>/<sub>` against the upstream
 * checkout's sources, the way upstream's own vite config does. Doing it by
 * rule rather than by an alias list means a new upstream subpath resolves
 * without touching this file.
 */
function upstreamWorkspaceResolver(): Plugin {
  return {
    name: 'genoffice-upstream-resolver',
    enforce: 'pre',
    resolveId(source) {
      if (!source.startsWith('@genoffice/')) return null
      const rest = source.slice('@genoffice/'.length)
      const slash = rest.indexOf('/')
      const pkg = slash === -1 ? rest : rest.slice(0, slash)
      const sub = slash === -1 ? 'index' : rest.slice(slash + 1)
      const candidates = [
        resolve(PACKAGES_DIR, pkg, 'src', `${sub}.ts`),
        resolve(PACKAGES_DIR, pkg, 'src', sub, 'index.ts'),
        resolve(PACKAGES_DIR, pkg, 'src', `${sub}.tsx`),
      ]
      return candidates.find((candidate) => existsSync(candidate)) ?? null
    },
  }
}

export default defineConfig({
  plugins: [upstreamWorkspaceResolver()],
  resolve: {
    alias: [{ find: /^electron$/, replacement: resolve(__dirname, 'src/shim.ts') }],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    rollupOptions: {
      input: Object.fromEntries(
        APPS.map((app) => [app, resolve(__dirname, '../../apps', app, 'src/preload/index.ts')]),
      ),
      output: {
        // ES modules: the browser loads them with <script type="module">, and
        // module scripts run in document order, so the bridge can be
        // injected before the renderer's own entry.
        format: 'es',
        entryFileNames: '[name].js',
      },
    },
  },
})
