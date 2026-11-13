import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { upstreamWorkspaceResolver } from './src/build/upstream-resolver'

/**
 * Builds the browser-side bridge: one bundle per app, from the **upstream**
 * preload source, with `electron` aliased to our shim.
 *
 * The upstream preload scripts are the channel contract — every method name,
 * argument shape and return shape comes from there. We do not restate it.
 */
const APPS = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'shell'] as const

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
      input: {
        // The polyfill every page needs, before the app's bridge.
        polyfill: resolve(__dirname, 'src/polyfill-entry.ts'),
        ...Object.fromEntries(
          APPS.map((app) => [
            app,
            resolve(__dirname, '../../apps', app, 'src/preload/index.ts'),
          ]),
        ),
      },
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
