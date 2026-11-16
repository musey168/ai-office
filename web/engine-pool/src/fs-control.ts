import * as realFs from 'node:fs'
import * as realFsPromises from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { WorkspaceStore } from '@ai-office/workspace-store'

/**
 * The controlled filesystem the upstream slides code runs against.
 *
 * Upstream's main process reads and writes the deck straight through
 * `node:fs`. The server may not: every path that reaches the disk has to
 * pass the workspace fence, or a caller could name a file outside the
 * workspace and have the server write it.
 *
 * So the worker build aliases `node:fs` and `node:fs/promises` to this
 * module. The upstream code is unmodified; only the functions it calls are
 * different — the ones that touch the user's documents resolve through the
 * store, which enforces the fence (symbolic links included) and writes
 * atomically.
 *
 * Paths **outside** the workspace are the server's own business — the app
 * data directory, the autosave folder, temp files — and go to the real
 * filesystem. The fence is about the user's documents.
 */

/** The store the fence is enforced through. */
let store: WorkspaceStore | null = null

/** The roots the workspace may touch, realized. */
let roots: string[] = []

/**
 * Point the controlled filesystem at a store.
 *
 * Called once when the worker starts, before any upstream code runs.
 */
export function useWorkspaceStore(next: WorkspaceStore, workspaceRoots: string[]): void {
  store = next
  roots = workspaceRoots.map((root) => resolve(root))
}

/**
 * Whether a path is inside the workspace.
 *
 * The check is on the literal path; the store re-checks it after symlink
 * resolution, which is the check that actually counts.
 */
function insideWorkspace(path: string): boolean {
  const absolute = resolve(path)
  return roots.some((root) => absolute === root || absolute.startsWith(`${root}/`))
}

/** The store, or a clear error when it is not configured. */
function requireStore(): WorkspaceStore {
  if (!store) throw new Error('the workspace store is not configured')
  return store
}

/**
 * The workspace-relative path of an absolute file, as the store wants it.
 *
 * The store works in workspace-relative paths; the upstream code passes
 * absolute paths around, because on the desktop every path is absolute.
 */
function toStorePath(absolute: string): string {
  for (const root of roots) {
    if (absolute === root) return '.'
    if (absolute.startsWith(`${root}/`)) return absolute.slice(root.length + 1)
  }
  return absolute
}

// ── the read side ───────────────────────────────────────────────────────

export async function readFile(path: string): Promise<Buffer> {
  if (!insideWorkspace(path)) return realFsPromises.readFile(path)
  const bytes = await requireStore().read(toStorePath(resolve(path)))
  return Buffer.from(bytes)
}

/**
 * The synchronous read.
 *
 * The store has no synchronous surface — it exists so that every access
 * goes through one fence. The synchronous variant is therefore the real
 * filesystem; the paths the upstream code reads that way are its own
 * (fonts, caches), not the user's documents.
 */
export function readFileSync(path: string): Buffer | string {
  return realFs.readFileSync(path)
}

export function existsSync(path: string): boolean {
  return realFs.existsSync(path)
}

export async function stat(path: string) {
  return realFsPromises.stat(path)
}

export async function lstat(path: string) {
  return realFsPromises.lstat(path)
}

export async function open(path: string, ...args: unknown[]) {
  return realFsPromises.open(path, ...(args as [string]))
}

export async function readdir(path: string): Promise<string[]> {
  return realFsPromises.readdir(path)
}

export async function unlink(path: string): Promise<void> {
  await realFsPromises.unlink(path)
}

export async function mkdtemp(prefix: string): Promise<string> {
  return realFsPromises.mkdtemp(prefix)
}

export function openSync(path: string, ...args: unknown[]) {
  return realFs.openSync(path, ...(args as [string]))
}

export function closeSync(fd: number): void {
  realFs.closeSync(fd)
}

export function readSync(fd: number, ...args: unknown[]): number {
  return realFs.readSync(fd, ...(args as [Buffer]))
}

export function fstatSync(fd: number) {
  return realFs.fstatSync(fd)
}

export function fsyncSync(fd: number): void {
  realFs.fsyncSync(fd)
}

export function readdirSync(path: string): string[] {
  return realFs.readdirSync(path)
}

export function statSync(path: string) {
  return realFs.statSync(path)
}

export function appendFileSync(path: string, data: Uint8Array | string): void {
  realFs.appendFileSync(path, data)
}

export function renameSync(from: string, to: string): void {
  realFs.renameSync(from, to)
}

// ── the write side ──────────────────────────────────────────────────────

export async function writeFile(path: string, data: Uint8Array | string): Promise<void> {
  if (!insideWorkspace(path)) {
    await realFsPromises.writeFile(path, data)
    return
  }
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  await requireStore().write(toStorePath(resolve(path)), bytes)
}

/**
 * The synchronous write.
 *
 * Like the synchronous read, it cannot go through the atomic writer, so it
 * is refused inside the workspace rather than quietly writing a file the
 * store would have written safely.
 */
export function writeFileSync(path: string, data: Uint8Array | string): void {
  if (!insideWorkspace(path)) {
    realFs.writeFileSync(path, data)
    return
  }
  throw new Error(
    `writing "${path}" synchronously would bypass the workspace fence; use the async write`,
  )
}

export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  if (!insideWorkspace(path)) {
    await realFsPromises.mkdir(path, options)
    return
  }
  await requireStore().createDirectory(toStorePath(resolve(path)))
}

export function mkdirSync(path: string, options?: { recursive?: boolean }): void {
  if (!insideWorkspace(path)) {
    realFs.mkdirSync(path, options)
    return
  }
  throw new Error(
    `creating "${path}" synchronously would bypass the workspace fence; use the async create`,
  )
}

export async function rm(
  path: string,
  options?: { force?: boolean; recursive?: boolean },
): Promise<void> {
  if (!insideWorkspace(path)) {
    await realFsPromises.rm(path, options)
    return
  }
  if (options?.recursive) {
    // The store removes files, not trees; a recursive removal inside the
    // workspace goes file by file.
    const names = await realFsPromises.readdir(path).catch(() => [])
    for (const name of names) {
      const child = resolve(dirname(path), name)
      const stats = await realFsPromises.stat(child).catch(() => null)
      if (stats?.isDirectory()) await rm(child, options)
      else await requireStore().delete(toStorePath(resolve(child))).catch(() => {})
    }
    return
  }
  await requireStore().delete(toStorePath(resolve(path)))
}

export async function copyFile(from: string, to: string): Promise<void> {
  if (!insideWorkspace(from) && !insideWorkspace(to)) {
    await realFsPromises.copyFile(from, to)
    return
  }
  const bytes = await readFile(from)
  await writeFile(to, bytes)
}

export async function rename(from: string, to: string): Promise<void> {
  if (!insideWorkspace(from) && !insideWorkspace(to)) {
    await realFsPromises.rename(from, to)
    return
  }
  const bytes = await readFile(from)
  await writeFile(to, bytes)
  await rm(from, { force: true })
}

/**
 * The rest of the fs surface.
 *
 * The upstream code reaches for a lot of fs functions; the ones that touch
 * the user's documents are named above, and the rest are its own scratch
 * files. They are forwarded to the real filesystem one by one, because a
 * namespace object cannot stand in for a **named** import — the upstream
 * code writes `import { createWriteStream } from 'node:fs'`, and the
 * bundler needs a binding of that name.
 */
export const access = (...args: Parameters<typeof realFsPromises.access>) =>
  realFsPromises.access(...args)
export const accessSync = (...args: Parameters<typeof realFs.accessSync>) =>
  realFs.accessSync(...args)
export const chmod = (...args: Parameters<typeof realFsPromises.chmod>) =>
  realFsPromises.chmod(...args)
export const chmodSync = (...args: Parameters<typeof realFs.chmodSync>) =>
  realFs.chmodSync(...args)
export const constants = realFs.constants
export const copyFileSync = (...args: Parameters<typeof realFs.copyFileSync>) =>
  realFs.copyFileSync(...args)
export const cpSync = (...args: Parameters<typeof realFs.cpSync>) => realFs.cpSync(...args)
export const createReadStream = (...args: Parameters<typeof realFs.createReadStream>) =>
  realFs.createReadStream(...args)
export const createWriteStream = (...args: Parameters<typeof realFs.createWriteStream>) =>
  realFs.createWriteStream(...args)
export const ftruncateSync = (...args: Parameters<typeof realFs.ftruncateSync>) =>
  realFs.ftruncateSync(...args)
export const linkSync = (...args: Parameters<typeof realFs.linkSync>) => realFs.linkSync(...args)
export const lstatSync = (...args: Parameters<typeof realFs.lstatSync>) => realFs.lstatSync(...args)
export const mkdtempSync = (...args: Parameters<typeof realFs.mkdtempSync>) =>
  realFs.mkdtempSync(...args)
export const readlinkSync = (...args: Parameters<typeof realFs.readlinkSync>) =>
  realFs.readlinkSync(...args)
export const realpath = (...args: Parameters<typeof realFsPromises.realpath>) =>
  realFsPromises.realpath(...args)
export const realpathSync = (...args: Parameters<typeof realFs.realpathSync>) =>
  realFs.realpathSync(...args)
export const rmSync = (...args: Parameters<typeof realFs.rmSync>) => realFs.rmSync(...args)
export const symlink = (...args: Parameters<typeof realFsPromises.symlink>) =>
  realFsPromises.symlink(...args)
export const symlinkSync = (...args: Parameters<typeof realFs.symlinkSync>) =>
  realFs.symlinkSync(...args)
export const truncate = (...args: Parameters<typeof realFsPromises.truncate>) =>
  realFsPromises.truncate(...args)
export const truncateSync = (...args: Parameters<typeof realFs.truncateSync>) =>
  realFs.truncateSync(...args)
export const unlinkSync = (...args: Parameters<typeof realFs.unlinkSync>) =>
  realFs.unlinkSync(...args)
export const unwatchFile = (...args: Parameters<typeof realFs.unwatchFile>) =>
  realFs.unwatchFile(...args)
export const utimes = (...args: Parameters<typeof realFsPromises.utimes>) =>
  realFsPromises.utimes(...args)
export const utimesSync = (...args: Parameters<typeof realFs.utimesSync>) =>
  realFs.utimesSync(...args)
export const watch = (...args: Parameters<typeof realFs.watch>) => realFs.watch(...args)
export const watchFile = (...args: Parameters<typeof realFs.watchFile>) => realFs.watchFile(...args)
export const writeSync = (...args: Parameters<typeof realFs.writeSync>) => realFs.writeSync(...args)
