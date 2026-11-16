import { parentPort, workerData } from 'node:worker_threads'
import { LocalWorkspaceStore } from '@ai-office/workspace-store'
import { createBlankPdf, renderPageImage, renderPagePreview } from './pdf'
import { installWasmLookup } from './pdfium'
import { readSlideMedia } from '../../../apps/slides/src/main/session-state'
import { useWorkspaceStore } from './fs-control'
import {
  forgetTab,
  invokeUpstream,
  takeEvents,
  upstreamChannels,
} from './slides-upstream'
import type { EngineMessage, EngineRequest } from './protocol'

/**
 * The engine worker.
 *
 * The engines are CPU-heavy and must stay off the HTTP event loop, so they
 * run here. The worker also holds the **open documents** — upstream keeps
 * them in the main process, and the editing flow applies operations to the
 * live model rather than re-parsing the file for every change.
 *
 * The worker reads and writes through the workspace store, so the path fence
 * applies here exactly as it does in the HTTP process.
 */

interface WorkerData {
  workspaceRoots: string[]
}

// The upstream wasm lookup (PDFium) falls back to the Electron resources
// directory; the worker has no Electron, so it is pointed at the worker's
// own directory before anything renders.
installWasmLookup()

const roots = (workerData as WorkerData | undefined)?.workspaceRoots ?? []
const store = new LocalWorkspaceStore({ roots })

// The upstream slides code reaches the disk through `node:fs`; the build
// redirects those imports here, where the fence applies.
useWorkspaceStore(store, roots)

async function run(job: string, args: unknown[]): Promise<unknown> {
  switch (job) {
    /**
     * Call an upstream slides handler.
     *
     * The upstream main process owns the deck; the browser talks to it
     * through this channel. The handler is the upstream function itself —
     * the server shim captured it when the upstream module registered it.
     */
    case 'slides:invoke': {
      const [channel, callArgs, tabId] = args as [string, unknown[], string]
      return invokeUpstream(channel, callArgs, tabId)
    }

    /** The channels the upstream slides process registered. */
    case 'slides:channels': {
      return upstreamChannels()
    }

    case 'pdf:blank': {
      return { bytes: await createBlankPdf() }
    }

    case 'pdf:render-page': {
      const [filePath, pageIndex, rect, scale] = args as [
        string,
        number,
        [number, number, number, number],
        number,
      ]
      const bytes = await store.read(filePath)
      return { png: await renderPageImage(bytes, pageIndex, rect, scale) }
    }

    case 'pdf:render-preview': {
      const [filePath, request] = args as [string, Parameters<typeof renderPagePreview>[1]]
      const bytes = await store.read(filePath)
      return { result: await renderPagePreview(bytes, request) }
    }

    case 'slides:media': {
      // The renderer asks for the media by its upstream URL; the server
      // rewrote it to a same-origin path, so the scheme is put back here.
      const [url] = args as [string]
      const media = readSlideMedia(url)
      if (!media) return null
      return { body: media.body, mime: media.mime }
    }

    case 'slides:close': {
      const [, tabId] = args as [string, string | undefined]
      if (tabId) forgetTab(tabId)
      return { ok: true }
    }

    default:
      throw new Error(`unknown engine job "${job}"`)
  }
}

parentPort?.on('message', (request: EngineRequest) => {
  void run(request.job, request.args).then(
    (value) => {
      parentPort?.postMessage({
        kind: 'response',
        id: request.id,
        ok: true,
        value,
      } satisfies EngineMessage)
      // The upstream code pushes events at the renderer (the deck changed, the
      // undo stack moved); they travel back the same way the answers do.
      for (const event of takeEvents()) {
        parentPort?.postMessage({ kind: 'event', ...event } satisfies EngineMessage)
      }
    },
    (error: unknown) => {
      parentPort?.postMessage({
        kind: 'response',
        id: request.id,
        ok: false,
        error: { code: 'engine_error', message: (error as Error).message },
      } satisfies EngineMessage)
    },
  )
})
