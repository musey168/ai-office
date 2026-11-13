import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The repository root — the directory that holds `apps/` and `packages/`.
 *
 * Found by walking up from this file rather than by a relative path, so the
 * helper keeps working wherever the package is checked out.
 */
export function repoRoot(): string {
  let dir = here
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(dir, 'packages')) && existsSync(resolve(dir, 'apps'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`cannot locate the repository root above ${here}`)
}

/**
 * Resolve `@genoffice/<pkg>` and `@genoffice/<pkg>/<sub>` against the upstream
 * checkout's sources, the way upstream's own vite configs do. Doing it by
 * rule rather than by an alias list means a new upstream subpath resolves
 * without touching any config of ours.
 */
export function upstreamWorkspaceResolver(): Plugin {
  const packagesDir = resolve(repoRoot(), 'packages')
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
        resolve(packagesDir, pkg, 'src', `${sub}.ts`),
        resolve(packagesDir, pkg, 'src', sub, 'index.ts'),
        resolve(packagesDir, pkg, 'src', `${sub}.tsx`),
      ]
      return candidates.find((candidate) => existsSync(candidate)) ?? null
    },
  }
}
