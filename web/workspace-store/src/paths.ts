import { existsSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * macOS (APFS/HFS+) and Windows compare paths case-insensitively; Linux does
 * not. Folding case on Linux would let `/srv/A` and `/srv/a` be treated as
 * the same directory — two different places — so the fold follows the
 * platform rather than being applied unconditionally.
 */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32'

/**
 * Canonical form used for every comparison: NFC (macOS HFS+ stores NFD, so
 * the same name can be two byte sequences) plus case folding where the
 * filesystem folds case.
 */
export function normalizeForCompare(target: string): string {
  const nfc = target.normalize('NFC')
  return CASE_INSENSITIVE ? nfc.toLowerCase() : nfc
}

/**
 * Real location of a path that may not exist yet: the nearest existing
 * ancestor's realpath plus the remaining segments. Resolving the deepest
 * existing ancestor is what makes a symlink inside the workspace point at
 * where it really lives.
 */
export function realizedPath(abs: string): string {
  const tail: string[] = []
  let dir = abs
  while (!existsSync(dir)) {
    tail.unshift(basename(dir))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const real = existsSync(dir) ? realpathSync(dir) : dir
  return tail.length ? join(real, ...tail) : real
}

/**
 * True when `target` is `root` itself or lives under it. A name that merely
 * starts with ".." (`..hidden`) is still inside.
 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Workspace-relative path with forward slashes, for the browser to use. */
export function toRelativePath(root: string, abs: string): string {
  const rel = relative(root, abs)
  return rel.split(sep).join('/')
}

/** File extension without the dot, lowercased; empty when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}
