import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorkspaceError } from './errors'
import { isInside, normalizeForCompare, realizedPath } from './paths'

/**
 * The path fence: the single boundary between a request arriving over HTTP
 * and the server's filesystem.
 *
 * Unlike the upstream CLI — where an unset `GENOFFICE_ALLOWED_ROOTS` means
 * "unrestricted" — a fence must be given explicit roots. The CLI runs on the
 * user's own machine; this runs on a shared server reachable from the LAN,
 * where "unrestricted" would mean "the whole filesystem".
 */
export class Fence {
  /** Realized absolute roots, in configuration order. */
  readonly rootPaths: string[]
  /** The same roots in comparison form. */
  private readonly compareRoots: string[]

  constructor(roots: string[]) {
    const usable = roots.map((root) => root.trim()).filter(Boolean)
    if (usable.length === 0) {
      throw new WorkspaceError(
        'invalid_argument',
        'no workspace root is configured: the server must be given an explicit workspace root',
      )
    }
    this.rootPaths = usable.map((root) => realizedPath(root))
    this.compareRoots = this.rootPaths.map((root) => normalizeForCompare(root))
  }

  /** The root that relative paths are resolved against. */
  get primaryRoot(): string {
    return this.rootPaths[0]!
  }

  /**
   * Absolute filesystem path for a workspace path. An empty path is the
   * workspace root — that is what a file tree sends for its top node.
   * Relative paths resolve against the primary root; absolute paths are
   * accepted only when they land inside a root.
   */
  resolvePath(input: string): string {
    if (typeof input !== 'string') {
      throw new WorkspaceError('invalid_argument', 'a path is required')
    }
    if (input.includes('\0')) {
      throw new WorkspaceError('invalid_argument', 'the path contains a NUL byte')
    }
    if (input === '') return this.primaryRoot
    const abs = input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input)
      ? input
      : resolve(this.primaryRoot, input)
    this.assertInside(abs)
    return abs
  }

  /** Throws unless the path — after symlink resolution — sits inside a root. */
  assertInside(absPath: string): void {
    const real = normalizeForCompare(realizedPath(absPath))
    if (!this.compareRoots.some((root) => isInside(root, real))) {
      throw new WorkspaceError(
        'outside_allowed_roots',
        `refusing to touch a path outside the workspace: ${absPath}`,
        { allowed_roots: [...this.rootPaths] },
      )
    }
  }

  /**
   * Re-check the fence against an open descriptor. The path may have been
   * swapped for a symlink between the check and the open, so the descriptor
   * is compared against the path it was opened through.
   */
  assertOpenHandle(absPath: string, fdStat: { dev: number; ino: number }): void {
    this.assertInside(absPath)
    const pathStat = statSyncSafe(absPath)
    if (!pathStat) return
    if (pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino) {
      throw new WorkspaceError(
        'io_error',
        `the path changed while it was being opened: ${absPath}`,
      )
    }
  }
}

function statSyncSafe(absPath: string): { dev: number; ino: number } | null {
  try {
    const stats = statSync(absPath)
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return null
  }
}
