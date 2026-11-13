import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Builds the **upstream** renderer applications as plain browser bundles.
 *
 * The renderer sources stay untouched — this only compiles them, with the
 * base path set so the app can live under `/app/<app>/`. The bridge script
 * is injected at request time by the server, so it does not belong here.
 */
const here = dirname(fileURLToPath(import.meta.url))

const APPS = process.argv.slice(2).length ? process.argv.slice(2) : ['docs', 'shell', 'slides']

for (const app of APPS) {
  process.stdout.write(`\n=== building renderer: ${app} ===\n`)
  const result = spawnSync(
    process.execPath,
    [resolve(here, '../node_modules/vite/bin/vite.js'), 'build', '--config', resolve(here, 'vite.renderers.config.ts')],
    {
      stdio: 'inherit',
      cwd: resolve(here, '..'),
      env: { ...process.env, AIOFFICE_APP: app },
    },
  )
  if (result.status !== 0) {
    process.stderr.write(`renderer build failed for ${app}\n`)
    process.exit(result.status ?? 1)
  }
}
