import { basename, dirname, extname, join, resolve } from 'node:path'
import type { WorkspaceStore } from '@ai-office/workspace-store'
import { BridgeError } from '../../protocol'
import type { ChannelHandler } from '../router'
import type { TabRegistry } from '../tabs'
import type { EngineRunner } from './slides'

/**
 * The home screen: the file tree, the recents and the starred lists, and
 * opening a document.
 *
 * Every shape here is upstream's (`apps/shell/src/shared/home-api.ts`) and
 * every listing rule is upstream's (`apps/shell/src/main/folder-tree.ts`) —
 * the shell renderer consumes them unchanged, so a field renamed upstream
 * would silently empty a panel here.
 */

/** Document extensions the home screen lists — upstream's `TREE_FILE_EXTENSIONS`. */
const TREE_FILE_EXTENSIONS = new Set([
  'docx', 'doc', 'xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods', 'ots',
  'pptx', 'ppt', 'odt', 'ott', 'hwpx', 'hwp', 'odp', 'otp',
  'pdf', 'md', 'markdown', 'txt', 'json', 'html', 'htm',
])

/** Folders the tree never shows. */
const HIDDEN_DIR_NAMES = new Set(['node_modules', '__macosx'])
/** Files the tree never shows. */
const HIDDEN_FILE_NAMES = new Set(['thumbs.db', 'desktop.ini'])

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

export interface RecentEntry {
  path: string
  name: string
  ext: string
  mtimeMs: number
  sizeBytes: number
  starred: boolean
  group?: string
  missing?: boolean
}

export interface RecentPage {
  entries: RecentEntry[]
  total: number
  totalAll: number
}

export interface AccountStatus {
  loggedIn: boolean
  email?: string
  creditBalance?: number
}

export interface RenameResult {
  ok: boolean
  path?: string
  error?: string
}

/**
 * Dotfiles, Office lock files and OS junk stay out of the tree — upstream's
 * `isHiddenEntry`.
 */
function isHiddenEntry(name: string, isDir: boolean): boolean {
  if (name.startsWith('.') || name.startsWith('~$')) return true
  const lower = name.toLowerCase()
  if (isDir) return HIDDEN_DIR_NAMES.has(lower)
  return HIDDEN_FILE_NAMES.has(lower)
}

function isSupportedTreeFile(name: string): boolean {
  return TREE_FILE_EXTENSIONS.has(extname(name).slice(1).toLowerCase())
}

export interface PendingOpens {
  /** Remember a document the home screen asked to open. */
  put(filePath: string): void
  /** Take the pending document, if any. */
  take(): string | undefined
  peek(): string | undefined
}

/**
 * The fallback handoff for a docs page that is not running inside a tab —
 * upstream keeps the pending path in the main process, keyed by the web
 * contents id.
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

/**
 * The upstream's `NewFileOpts` (`apps/shell/src/shared/home-api.ts`): the
 * folder the new file should land in.
 */
export interface NewFileOpts {
  dir?: string
}

/**
 * Write a file, picking a name that is not taken yet.
 *
 * Upstream's `uniquePathIn` does the same: a second "New PDF" must not
 * overwrite the first one.
 */
async function writeUnique(
  store: WorkspaceStore,
  filePath: string,
  bytes: Uint8Array,
): Promise<string> {
  const dir = dirname(filePath)
  const ext = extname(filePath)
  const stem = basename(filePath, ext)
  let candidate = filePath
  for (let index = 2; ; index += 1) {
    try {
      await store.stat(candidate)
    } catch {
      break
    }
    candidate = join(dir, `${stem} ${index}${ext}`)
  }
  await store.write(candidate, bytes)
  return candidate
}

export interface HomeChannelDeps {
  store: WorkspaceStore
  tabs: TabRegistry
  pending: PendingOpens
  /** The engine pool, for the formats whose blank file the main process writes. */
  engines?: EngineRunner
  /** The UI language the shell renders in. */
  language?: string
  /** The theme the shell renders in. */
  theme?: string
  /** Recently opened documents, newest first. */
  recents?: string[]
}

export function createHomeChannels(deps: HomeChannelDeps): Record<string, ChannelHandler> {
  const { store, tabs, pending } = deps
  const language = deps.language ?? 'zh'
  const theme = deps.theme ?? 'system'

  /**
   * The store speaks workspace-relative paths; the shell's renderer speaks
   * absolute ones — upstream's `FolderEntry.path` is the real path on disk,
   * and the renderer hands it straight back to the server when opening a
   * file.
   */
  const absolute = (relativePath: string): string => resolve(store.root, relativePath)

  const visibleSubfolders = async (dir: string): Promise<boolean> => {
    try {
      const entries = await store.list(dir)
      return entries.some(
        (entry) => entry.kind === 'directory' && !isHiddenEntry(entry.name, true),
      )
    } catch {
      return false
    }
  }

  return {
    /**
     * The language of the shell UI. The shell's renderer awaits this before
     * its first paint and does **not** catch the failure — without this
     * channel the whole page stays blank.
     */
    'home:get-language': () => language,

    'home:get-theme': () => theme,

    /**
     * Whether the first-run walkthrough has been seen. The web version starts
     * with it out of the way: the walkthrough is a desktop-app onboarding,
     * and it would cover the file tree.
     */
    'home:onboarding-seen': () => true,
    'home:set-onboarding-seen': () => true,

    /** The "tell us you like it" invitation — never shown in the web version. */
    'home:star-prompt-should-show': () => ({ show: false, docOpens: 0 }),

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
        if (isHiddenEntry(entry.name, entry.kind === 'directory')) continue
        if (entry.kind === 'directory') {
          folders.push({
            path: absolute(entry.path),
            name: entry.name,
            mtimeMs: entry.mtimeMs,
            hasSubfolders: await visibleSubfolders(entry.path),
          })
          continue
        }
        if (!isSupportedTreeFile(entry.name)) continue
        const ext = extname(entry.name).slice(1).toLowerCase()
        files.push({
          path: absolute(entry.path),
          name: entry.name,
          ext,
          mtimeMs: entry.mtimeMs,
          sizeBytes: entry.size,
          starred: false,
        })
      }
      folders.sort((a, b) => a.name.localeCompare(b.name))
      files.sort((a, b) => b.mtimeMs - a.mtimeMs)
      return { dir: target, folders, files } satisfies FolderListing
    },

    /** Create a folder inside the tree. */
    'home:folder-create': async (_ctx, parent, name) => {
      if (typeof parent !== 'string' || typeof name !== 'string' || !name) {
        return { ok: false, error: 'a folder name is required' } satisfies RenameResult
      }
      const target = join(parent, name)
      try {
        await store.createDirectory(target)
        return { ok: true, path: target } satisfies RenameResult
      } catch (error) {
        return { ok: false, error: (error as Error).message } satisfies RenameResult
      }
    },

    /**
     * Open a document. Upstream's handler opens the document and returns
     * nothing; here it opens a tab, and the shell's page mounts the editor
     * for that tab.
     */
    'home:open-path': async (_ctx, filePath) => {
      if (typeof filePath !== 'string' || !filePath) return
      tabs.open(filePath, basename(filePath))
      pending.put(filePath)
    },

    /**
     * The "new file" cards on the home screen.
     *
     * Upstream opens a view with no file behind it; the file is created
     * when the document is saved. Each app asks its own "consume pending"
     * channel for the path it should open.
     */
    'home:new-doc': () => {
      tabs.openBlank('docs', 'GenOffice Docs')
    },

    'home:new-slide': () => {
      tabs.openBlank('slides', 'AI Slides')
    },

    'home:new-markdown': () => {
      tabs.openBlank('markdown', 'AI Markdown')
    },

    'home:new-html': () => {
      tabs.openBlank('html', 'AI HTML')
    },

    /**
     * A new spreadsheet needs a blank .xlsx on disk before it opens —
     * upstream writes one in the main process, because the save pipeline
     * works on files. The workbook engine is not in the web port yet.
     */
    'home:new-sheet': async () => {
      throw new BridgeError(
        'not_available',
        'the spreadsheet engine is not available in the web port yet',
      )
    },

    /**
     * A new PDF is a blank single-page file created up front — upstream
     * does it in the main process, with the same pdf-lib the PDF module
     * uses.
     */
    'home:new-pdf': async (_ctx, ...args) => {
      if (!deps.engines) {
        throw new BridgeError('not_available', 'the engine pool is not running')
      }
      const opts = args[0] as NewFileOpts | undefined
      const dir = typeof opts?.dir === 'string' && opts.dir ? opts.dir : store.root
      const { bytes } = await deps.engines.run<{ bytes: Uint8Array }>('pdf:blank', [])
      const filePath = await writeUnique(store, join(dir, '未命名 PDF.pdf'), bytes)
      tabs.open(filePath, basename(filePath))
      pending.put(filePath)
    },

    'home:recents': async () => {
      const entries = await recentEntries(store, deps.recents ?? [], absolute)
      return { entries, total: entries.length, totalAll: entries.length } satisfies RecentPage
    },

    'home:starred': async () => ({
      entries: [],
      total: 0,
      totalAll: 0,
    } satisfies RecentPage),

    'home:starred-groups': () => [],

    /** The Genspark account state — the web version has none. */
    'home:account-status': () => ({ loggedIn: false } satisfies AccountStatus),

    /**
     * The native "open a file" dialog. A browser cannot ask the server's
     * disk for a path — the file tree is the way in.
     */
    'home:browse': async () => {
      throw new BridgeError(
        'not_available',
        'the native file dialog does not exist in the browser; use the file tree',
      )
    },

    /** "Show in file manager" — a desktop-only affordance. */
    'home:reveal-path': async () => {
      throw new BridgeError('not_available', 'there is no file manager to reveal a path in')
    },

    /** "Add a folder root" — upstream opens the native folder picker. */
    'home:folder-root-add': async () => {
      throw new BridgeError(
        'not_available',
        'the native folder picker does not exist in the browser',
      )
    },
  }
}

/** The recents list, newest first, with upstream's `RecentEntry` shape. */
async function recentEntries(
  store: WorkspaceStore,
  paths: string[],
  absolute: (relativePath: string) => string,
): Promise<RecentEntry[]> {
  const entries: RecentEntry[] = []
  for (const path of paths) {
    try {
      const meta = await store.stat(path)
      if (!meta.isFile) continue
      entries.push({
        path: absolute(meta.path),
        name: meta.name,
        ext: extname(meta.name).slice(1).toLowerCase(),
        mtimeMs: meta.mtimeMs,
        sizeBytes: meta.size,
        starred: false,
      })
    } catch {
      // A file that vanished since it was opened is still listed upstream,
      // marked `missing`.
      entries.push({
        path: absolute(path),
        name: basename(path),
        ext: extname(path).slice(1).toLowerCase(),
        mtimeMs: 0,
        sizeBytes: 0,
        starred: false,
        missing: true,
      })
    }
  }
  return entries
}
