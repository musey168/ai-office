import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, copyFile, unlink, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { atomicWriteFile } from './atomic-write'
import { WorkspaceError } from './errors'
import { Fence } from './fence'
import { extensionOf, toRelativePath } from './paths'
import type { Entry, FileMeta, FileSnapshot, WorkspaceStore } from './types'

export interface LocalWorkspaceStoreOptions {
  /**
   * The directories the workspace may touch. The first one is the base for
   * relative paths. At least one root is required — there is no
   * "unrestricted" mode on a server.
   */
  roots: string[]
  /** Largest file the store reads or writes. Defaults to 256 MB. */
  maxBytes?: number
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

/**
 * The local-filesystem implementation of {@link WorkspaceStore}.
 */
export class LocalWorkspaceStore implements WorkspaceStore {
  private readonly fence: Fence
  private readonly maxBytes: number

  constructor(options: LocalWorkspaceStoreOptions) {
    this.fence = new Fence(options.roots)
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  /** The directory relative paths are resolved against. */
  get root(): string {
    return this.fence.primaryRoot
  }

  async list(dirPath: string): Promise<Entry[]> {
    const abs = this.fence.resolvePath(dirPath)
    const dirStats = await stat(abs).catch(() => null)
    if (!dirStats) throw new WorkspaceError('file_not_found', `no such directory: ${dirPath}`)
    if (!dirStats.isDirectory()) {
      throw new WorkspaceError('not_a_directory', `not a directory: ${dirPath}`)
    }
    const names = await readdir(abs)
    const entries: Entry[] = []
    for (const name of names) {
      const childAbs = join(abs, name)
      const childStats = await lstat(childAbs).catch(() => null)
      if (!childStats) continue
      const kind = childStats.isSymbolicLink()
        ? 'symlink'
        : childStats.isDirectory()
          ? 'directory'
          : 'file'
      entries.push({
        name,
        path: this.toRelative(childAbs),
        kind,
        size: kind === 'directory' ? 0 : childStats.size,
        mtimeMs: childStats.mtimeMs,
      })
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return entries
  }

  async read(filePath: string): Promise<Uint8Array> {
    const abs = this.fence.resolvePath(filePath)
    const handle = await open(abs, 'r').catch((error: unknown) => {
      throw this.toWorkspaceError(error, filePath)
    })
    try {
      const stats = await handle.stat()
      this.fence.assertOpenHandle(abs, stats)
      if (stats.isDirectory()) {
        throw new WorkspaceError('not_a_file', `not a file: ${filePath}`)
      }
      if (stats.size > this.maxBytes) {
        throw new WorkspaceError(
          'resource_limit',
          `the file is larger than the ${this.maxBytes} byte limit: ${filePath}`,
        )
      }
      return await handle.readFile()
    } finally {
      await handle.close().catch(() => {})
    }
  }

  async write(filePath: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > this.maxBytes) {
      throw new WorkspaceError(
        'resource_limit',
        `the file is larger than the ${this.maxBytes} byte limit: ${filePath}`,
      )
    }
    const abs = this.fence.resolvePath(filePath)
    await this.ensureParent(abs, filePath)
    try {
      await atomicWriteFile(abs, bytes)
    } catch (error) {
      throw this.toWorkspaceError(error, filePath)
    }
  }

  async move(srcPath: string, destPath: string): Promise<void> {
    const src = this.fence.resolvePath(srcPath)
    const dest = this.fence.resolvePath(destPath)
    if (src === dest) return
    const destStats = await stat(dest).catch(() => null)
    if (destStats) {
      throw new WorkspaceError('output_exists', `the destination already exists: ${destPath}`)
    }
    await this.ensureParent(dest, destPath)
    try {
      await rename(src, dest)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        // Across filesystems: copy, then drop the original.
        await copyFile(src, dest)
        await unlink(src).catch(() => {})
        return
      }
      throw this.toWorkspaceError(error, srcPath)
    }
  }

  async delete(filePath: string): Promise<void> {
    const abs = this.fence.resolvePath(filePath)
    const stats = await lstat(abs).catch(() => null)
    if (!stats) throw new WorkspaceError('file_not_found', `no such file: ${filePath}`)
    if (stats.isDirectory()) {
      throw new WorkspaceError('not_a_file', `refusing to delete a directory: ${filePath}`)
    }
    try {
      await unlink(abs)
    } catch (error) {
      throw this.toWorkspaceError(error, filePath)
    }
  }

  async createDirectory(dirPath: string): Promise<void> {
    const abs = this.fence.resolvePath(dirPath)
    await mkdir(abs, { recursive: true }).catch((error: unknown) => {
      throw this.toWorkspaceError(error, dirPath)
    })
    // Re-check the fence: a parent that was a symlink pointing outside the
    // workspace must not become a way out of it.
    this.fence.assertInside(abs)
  }

  async stat(filePath: string): Promise<FileMeta> {
    const abs = this.fence.resolvePath(filePath)
    const stats = await stat(abs).catch((error: unknown) => {
      throw this.toWorkspaceError(error, filePath)
    })
    return {
      path: this.toRelative(abs),
      name: basename(abs),
      ext: extensionOf(basename(abs)),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
    }
  }

  async snapshot(filePath: string): Promise<FileSnapshot> {
    const abs = this.fence.resolvePath(filePath)
    const stats = await stat(abs).catch((error: unknown) => {
      throw this.toWorkspaceError(error, filePath)
    })
    return {
      path: this.toRelative(abs),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      hash: await hashFile(abs),
    }
  }

  async isExternallyModified(snapshot: FileSnapshot | undefined): Promise<boolean> {
    // No record, or the file is gone: not a conflict — a save recreates it.
    if (!snapshot) return false
    const abs = this.fence.resolvePath(snapshot.path)
    const stats = await stat(abs).catch(() => null)
    if (!stats) return false
    if (stats.mtimeMs === snapshot.mtimeMs && stats.size === snapshot.size) return false
    const hash = await hashFile(abs)
    return hash !== snapshot.hash
  }

  /**
   * Creates the parent directory when it is missing, then re-checks the
   * fence: a parent that was a symlink pointing outside the workspace must
   * not become a way out of it.
   */
  private async ensureParent(abs: string, filePath: string): Promise<void> {
    const parent = dirname(abs)
    await mkdir(parent, { recursive: true }).catch((error: unknown) => {
      throw this.toWorkspaceError(error, filePath)
    })
    this.fence.assertInside(parent)
  }

  private toRelative(abs: string): string {
    for (const root of this.fence.rootPaths) {
      const rel = toRelativePath(root, abs)
      if (rel && !rel.startsWith('../')) return rel
    }
    return toRelativePath(this.fence.primaryRoot, abs)
  }

  private toWorkspaceError(error: unknown, filePath: string): WorkspaceError {
    if (error instanceof WorkspaceError) return error
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    switch (code) {
      case 'ENOENT':
        return new WorkspaceError('file_not_found', `no such file: ${filePath}`)
      case 'EISDIR':
        return new WorkspaceError('not_a_file', `not a file: ${filePath}`)
      case 'ENOTDIR':
        return new WorkspaceError('not_a_directory', `not a directory: ${filePath}`)
      case 'EACCES':
      case 'EPERM':
        return new WorkspaceError('permission_denied', `permission denied: ${filePath}`)
      case 'EEXIST':
        return new WorkspaceError('output_exists', `the destination already exists: ${filePath}`)
      case 'ENOSPC':
      case 'EDQUOT':
        return new WorkspaceError('resource_limit', `no space left for: ${filePath}`)
      default:
        return new WorkspaceError(
          'io_error',
          `could not access ${filePath}: ${(error as Error)?.message ?? String(error)}`,
        )
    }
  }
}

async function hashFile(abs: string): Promise<string> {
  const handle = await open(abs, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close().catch(() => {})
  }
}
