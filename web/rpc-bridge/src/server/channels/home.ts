import { basename, dirname, extname, join } from 'node:path'
import type { WorkspaceStore } from '@ai-office/workspace-store'
import type { ChannelHandler } from '../router'

/**
 * The home screen's file tree: roots, listings, folder creation, and opening
 * a document.
 *
 * The shapes follow upstream's `home-api.ts` (`FolderRoot`, `FolderListing`,
 * `FolderEntry`, `FileEntry`) — the renderers consume them unchanged.
 */

/** Document extensions the home screen lists. */
const DOCUMENT_EXTENSIONS = new Set([
  'docx', 'doc', 'dotx', 'docm',
  'xlsx', 'xlsm', 'xlsb', 'csv',
  'pptx', 'pptm',
  'pdf', 'md', 'markdown', 'html', 'htm',
])

export interface FolderRoot {
  path: string
  name: string
  usable: boolean
  readable: boolean
  removable: boolean
}

export interface FolderEntry {
  path: string
  name: string
  mtimeMs: number
  hasSubfolders: boolean
}

export interface FileEntry {
  path: string
  name: string
  ext: string
  mtimeMs: number
  sizeBytes: number
  starred: boolean
  missing?: boolean
}

export interface FolderListing {
  dir: string
  folders: FolderEntry[]
  files: FileEntry[]
  missing?: boolean
}

export interface PendingOpens {
  /** Remember a document the home screen asked to open. */
  put(filePath: string): void
  /** Take the pending document, if any. */
  take(): string | undefined
  peek(): string | undefined
}

/**
 * The web version has no tab manager: the shell's "open this document" is a
 * slot the next docs page consumes, exactly like upstream's pending-window
 * handoff.
 */
export function createPendingOpens(): PendingOpens {
  let pending: string | undefined
  return {
    put: (filePath) => {
      pending = filePath
    },
    take: () => {
      const value = pending
      pending = undefined
      return value
    },
    peek: () => pending,
  }
}

export interface HomeChannelDeps {
  store: WorkspaceStore
  pending: PendingOpens
  /** Recently opened documents, newest first. */
  recents?: string[]
  /** File search, wired up by the file-index module when it exists. */
  search?: (query: unknown) => unknown
}

export function createHomeChannels(deps: HomeChannelDeps): Record<string, ChannelHandler> {
  const { store, pending } = deps

  const hasSubfolders = async (dir: string): Promise<boolean> => {
    try {
      const entries = await store.list(dir)
      return entries.some((entry) => entry.kind === 'directory')
    } catch {
      return false
    }
  }

  return {
    /** The folders the home screen shows at the top. */
    'home:folder-roots': async () => {
      const root = store.root
      return [
        {
          path: root,
          name: basename(root) || root,
          usable: true,
          readable: true,
          removable: false,
        } satisfies FolderRoot,
      ]
    },

    /** The contents of one folder. */
    'home:folder-list': async (_ctx, dir) => {
      const target = typeof dir === 'string' && dir ? dir : store.root
      let entries
      try {
        entries = await store.list(target)
      } catch {
        // Upstream marks a directory that vanished or moved as `missing`
        // rather than failing the whole listing.
        return { dir: target, folders: [], files: [], missing: true } satisfies FolderListing
      }
      const folders: FolderEntry[] = []
      const files: FileEntry[] = []
      for (const entry of entries) {
        if (entry.kind === 'directory') {
          folders.push({
            path: entry.path,
            name: entry.name,
            mtimeMs: entry.mtimeMs,
            hasSubfolders: await hasSubfolders(entry.path),
          })
          continue
        }
        const ext = extname(entry.name).replace(/^\./, '').toLowerCase()
        if (!DOCUMENT_EXTENSIONS.has(ext)) continue
        files.push({
          path: entry.path,
          name: entry.name,
          ext,
          mtimeMs: entry.mtimeMs,
          sizeBytes: entry.size,
          starred: false,
        })
      }
      folders.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      files.sort((a, b) => b.mtimeMs - a.mtimeMs)
      return { dir: target, folders, files } satisfies FolderListing
    },

    /** Create a folder inside the tree. */
    'home:folder-create': async (_ctx, parent, name) => {
      if (typeof parent !== 'string' || typeof name !== 'string' || !name) {
        return { ok: false, error: 'a folder name is required' }
      }
      const target = join(parent, name)
      try {
        await store.createDirectory(target)
        return { ok: true, path: target }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    },

    /** Open a document — the shell hands it to the next docs page. */
    'home:open-path': async (_ctx, filePath) => {
      if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'no path' }
      pending.put(filePath)
      return { ok: true }
    },

    'home:recents': () => ({ entries: [], total: 0, totalAll: 0 }),
    'home:starred': () => ({ entries: [], total: 0, totalAll: 0 }),
    'home:starred-groups': () => [],
    'home:account-status': () => ({ signedIn: false }),
  }
}
