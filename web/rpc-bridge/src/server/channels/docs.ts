import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { WorkspaceStore } from '@ai-office/workspace-store'
import type { ByteStore } from '../bytes'
import type { ChannelHandler } from '../router'
import type { PendingOpens } from './home'

/**
 * The document channels: opening a file, saving it back, and the recent
 * list.
 *
 * The shapes follow upstream's `OpenDocxResult` (`apps/docs/src/shared/ipc.ts`).
 * The file bytes travel as a **one-time URL** — upstream parks them behind
 * `genoffice-docx-media://handoff/<uuid>` and the renderer fetches that URL;
 * here the same trick plays out over a same-origin `/media/<token>` endpoint,
 * so the upstream renderer code needs no change at all.
 */

export interface DocsChannelDeps {
  store: WorkspaceStore
  bytes: ByteStore
  /** Where the one-time media URLs point. Same-origin by default. */
  mediaBaseUrl?: string
  /** Recently opened paths, newest first. */
  recents?: string[]
  /** The document the home screen asked to open. */
  pending?: PendingOpens
  /** Pushes an event to the renderers. */
  publish?: (channel: string, args: unknown[]) => void
}

export interface OpenDocxResult {
  path: string
  name: string
  dataUrl: string
  hash: string
  encrypted?: boolean
  recovered?: boolean
}

export interface SaveResult {
  ok: boolean
  path?: string
  error?: string
  reason?: 'external-modified'
  passwordIntentPending?: boolean
  dataUrl?: string
}

export function createDocsChannels(deps: DocsChannelDeps): Record<string, ChannelHandler> {
  const { store, bytes } = deps
  const mediaBase = deps.mediaBaseUrl ?? '/media'

  const openDocx = async (filePath: string): Promise<OpenDocxResult | null> => {
    const content = await store.read(filePath)
    const token = bytes.put(content)
    return {
      path: filePath,
      name: basename(filePath),
      dataUrl: `${mediaBase}/${token}`,
      hash: createHash('sha256').update(content).digest('hex'),
    }
  }

  const saveTo = async (
    filePath: string,
    data: unknown,
    options: { overwrite?: boolean } = {},
  ): Promise<SaveResult> => {
    const bytes = asBytes(data)
    if (!bytes) {
      return { ok: false, error: 'the document bytes are missing' }
    }
    try {
      await store.write(filePath, bytes)
      return { ok: true, path: filePath }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'output_exists') {
        return { ok: false, error: 'the destination already exists' }
      }
      if (code === 'outside_allowed_roots') {
        return { ok: false, error: 'the path is outside the workspace' }
      }
      return { ok: false, error: (error as Error).message }
    }
  }

  const channels: Record<string, ChannelHandler> = {
    /** Open a document by path — the counterpart of the native open dialog. */
    'docs:open-path': async (_ctx, filePath) => {
      if (typeof filePath !== 'string' || !filePath) return null
      return openDocx(filePath)
    },

    /** The shell tab flow: the document opened from the home screen. */
    'docs:consume-pending-open': async () => {
      const filePath = deps.pending?.take()
      if (!filePath) return null
      return openDocx(filePath)
    },

    /** Save back to the file it came from. */
    'docs:save': async (_ctx, filePath, data, auto) => {
      if (typeof filePath !== 'string' || !filePath) {
        return { ok: false, error: 'no path to save to' }
      }
      return saveTo(filePath, data)
    },

    /** Save to an explicit target (used by the MCP bridge). */
    'docs:save-to': async (_ctx, filePath, data, overwrite) => {
      if (typeof filePath !== 'string' || !filePath) {
        return { ok: false, error: 'no path to save to' }
      }
      return saveTo(filePath, data, { overwrite: overwrite === true })
    },

    /** Save a document that has never been on disk. */
    'docs:save-new': async (_ctx, defaultName, data) => {
      if (typeof defaultName !== 'string' || !defaultName) {
        return { ok: false, error: 'no file name' }
      }
      const target = joinInWorkspace(defaultName)
      return saveTo(target, data)
    },

    /** Recently opened documents. */
    'docs:recent': () => deps.recents ?? [],

    /** The font alias table the renderer asks for after parsing a document. */
    'docs:font-aliases': (_ctx, names) => {
      const table: Record<string, readonly string[]> = {}
      if (!Array.isArray(names)) return table
      for (const name of names) {
        if (typeof name === 'string') table[name] = []
      }
      return table
    },

    /** The password intent is per document; there is none to clear here. */
    'docs:password-intent-revision': () => 0,
  }

  return channels
}

/**
 * The upstream preload hands the document over as an `ArrayBuffer`
 * (`saveDocxTo(path, data: ArrayBuffer, overwrite)`); the bridge may also
 * deliver a typed array. Accept both.
 */
function asBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return null
}

/**
 * Resolve a file name into the workspace. The name may carry a relative
 * directory ("reports/q3.docx"); a name that tries to climb out is refused
 * by the store's fence when the write happens.
 */
function joinInWorkspace(name: string): string {
  const cleaned = name.replace(/\\/g, '/').replace(/^\/+/, '')
  return cleaned
}
