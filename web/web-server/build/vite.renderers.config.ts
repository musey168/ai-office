import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { repoRoot, upstreamWorkspaceResolver } from '@ai-office/rpc-bridge/build/upstream-resolver'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * One upstream renderer application, compiled as a plain browser bundle.
 *
 * The upstream sources are not modified: this config only changes *how* they
 * are bundled — the base path (`/app/<app>/`, so the app can live under a
 * path prefix on one origin) and the output directory.
 *
 * The app is chosen with `AIOFFICE_APP` because every app needs its own
 * base path, and vite has one base per build.
 */
const app = process.env.AIOFFICE_APP ?? 'docs'
const appRoot = resolve(repoRoot(), 'apps', app, 'src/renderer')

export default defineConfig({
  root: appRoot,
  base: `/app/${app}/`,
  plugins: [react(), upstreamWorkspaceResolver()],
  build: {
    outDir: resolve(packageRoot, 'dist', app),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(appRoot, 'index.html'),
      },
    },
  },
})
