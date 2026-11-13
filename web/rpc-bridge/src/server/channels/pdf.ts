import type { WorkspaceStore } from '@ai-office/workspace-store'
import { BridgeError } from '../../protocol'
import type { ByteStore } from '../bytes'
import type { TabRegistry } from '../tabs'
import type { ChannelHandler } from '../router'
import type { EngineRunner } from './slides'

/**
 * The PDF module's channels.
 *
 * The PDF app reads the file through the main process; upstream hands out
 * the bytes in chunks of at most 8 MB, and only for the file the view was
 * granted.
 */

/** The upstream chunk limit (`PDF_READ_CHUNK_BYTES`). */
const CHUNK_BYTES = 8 * 1024 * 1024

export interface PdfChannelDeps {
  store: WorkspaceStore
  tabs: TabRegistry
  bytes: ByteStore
  /** The engine pool, which rasterizes the pages with PDFium. */
  engines: EngineRunner | null
}

export function createPdfChannels(deps: PdfChannelDeps): Record<string, ChannelHandler> {
  const { store, tabs, bytes } = deps

  const requireEngines = (): EngineRunner => {
    if (!deps.engines) {
      throw new BridgeError('not_available', 'the engine pool is not running')
    }
    return deps.engines
  }

  const grantedPath = (tabId?: string): string | undefined => {
    const tab = tabId ? tabs.get(tabId) : undefined
    return tab?.filePath
  }

  const requireGranted = (tabId: string | undefined, path: unknown): string => {
    const granted = grantedPath(tabId)
    if (typeof path !== 'string' || !path || path !== granted) {
      throw new BridgeError('invalid_argument', 'pdf: path not granted to this view')
    }
    return path
  }

  return {
    'pdf:consume-pending': (ctx) => grantedPath(ctx.caller?.tabId) ?? null,

    /** The whole file as bytes. */
    'pdf:read-file': async (ctx, path) => {
      const granted = requireGranted(ctx.caller?.tabId, path)
      const content = await store.read(granted)
      return bytes.put(content)
    },

    /**
     * Rasterize one region of a page.
     *
     * Upstream does this in the main process with PDFium and answers with a
     * base64 PNG; the engine worker does it here.
     */
    'pdf:page-image-png': async (ctx, ...args) => {
      const request = args[0] as
        | { path: string; pageIndex: number; rect: [number, number, number, number]; scale?: number }
        | undefined
      const granted = requireGranted(ctx.caller?.tabId, request?.path)
      if (typeof request?.pageIndex !== 'number' || !Array.isArray(request.rect)) {
        throw new BridgeError('invalid_argument', 'pdf: path not granted to this view')
      }
      const result = await requireEngines().run<{ png: string | null }>('pdf:render-page', [
        granted,
        request.pageIndex,
        request.rect,
        typeof request.scale === 'number' && Number.isFinite(request.scale) ? request.scale : 1,
      ])
      return result?.png ?? null
    },

    /** Rasterize a whole page for the preview. */
    'pdf:page-preview-png': async (ctx, ...args) => {
      const request = args[0] as
        | {
            path: string
            pageIndex: number
            excludeRects: [number, number, number, number][]
            excludeAnnots?: boolean
            excludeText?: boolean
            clip?: { x: number; y: number; width: number; height: number }
            pxWidth: number
            rotate: number
          }
        | undefined
      const granted = requireGranted(ctx.caller?.tabId, request?.path)
      if (typeof request?.pageIndex !== 'number' || !Array.isArray(request.excludeRects)) {
        throw new BridgeError('invalid_argument', 'pdf: path not granted to this view')
      }
      const { path: _path, ...rest } = request
      const result = await requireEngines().run<{ result: unknown }>('pdf:render-preview', [
        granted,
        rest,
      ])
      return result?.result ?? null
    },

    /** A slice of the file, for the files too big to hand over at once. */
    'pdf:read-file-chunk': async (ctx, path, start, end) => {
      const granted = requireGranted(ctx.caller?.tabId, path)
      const from = typeof start === 'number' && Number.isInteger(start) && start >= 0 ? start : -1
      const to = typeof end === 'number' && Number.isInteger(end) && end >= from ? end : -1
      if (from < 0 || to < 0 || to - from > CHUNK_BYTES) {
        throw new BridgeError('invalid_argument', 'pdf: invalid chunk range')
      }
      const content = await store.read(granted)
      // Upstream answers with the slice **and** the size of the whole file:
      // the renderer allocates once and copies every slice into it.
      // The upstream renderer copies the slice into a buffer it allocated
      // from the reported size — it needs a typed array, not an
      // ArrayBuffer.
      return {
        data: { __bytes: bytes.put(content.subarray(from, to)), __as: 'u8' },
        fileSize: content.byteLength,
      }
    },
  }
}
