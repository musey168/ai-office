import { parentPort, workerData } from 'node:worker_threads'
import { LocalWorkspaceStore } from '@ai-office/workspace-store'
import { createBlankPdf, renderPageImage, renderPagePreview } from './pdf'
import { installWasmLookup } from './pdfium'
import { readSlideMedia } from '../../../apps/slides/src/main/session-state'
import { useWorkspaceStore } from './fs-control-impl'
import {
  forgetTab,
  invokeUpstream,
  takeEvents,
  upstreamChannels,
} from './slides-upstream'
import {
  closeDocument,
  documentChannelConflicts,
  documentChannels,
  documentReadyErrors,
  invokeDocumentUpstream,
  loadUpstreamDocuments,
  openDocument,
  sendDocumentUpstream,
} from './document-upstream'
import { resolveDialog, setDialogPresenter } from './electron-shim'
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

/**
 * The tab the worker is working for.
 *
 * A worker runs one job at a time, so the upstream code's dialog belongs to
 * the tab whose job is running.
 */
let currentTabId = ''

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

    /**
     * Call an upstream document handler.
     *
     * The upstream main process owns the open document; the browser talks
     * to it through this channel. The handler is the upstream function
     * itself — the server shim captured it when the upstream module
     * registered it.
     */
    case 'document:invoke': {
      const [channel, callArgs, tabId] = args as [string, unknown[], string]
      currentTabId = tabId
      return invokeDocumentUpstream(channel, callArgs, tabId)
    }

    /** Send a message the way the renderer does, without an answer. */
    case 'document:send': {
      const [channel, callArgs, tabId] = args as [string, unknown[], string]
      currentTabId = tabId
      return sendDocumentUpstream(channel, callArgs, tabId)
    }

    /**
     * Open a document the way the desktop app does.
     *
     * The upstream `createXxxView` grants the view the paths it may read
     * and write, so the upstream save handler finds the path by itself.
     */
    case 'document:open': {
      const [app, filePath, tabId] = args as ['markdown' | 'html' | 'pdf', string, string]
      currentTabId = tabId
      const senderId = await openDocument(app, filePath, tabId)
      return { senderId }
    }

    /** Close a document and forget its session. */
    case 'document:close': {
      const [tabId] = args as [string]
      closeDocument(tabId)
      return { ok: true }
    }

    /** The channels the upstream document applications registered. */
    case 'document:channels': {
      await loadUpstreamDocuments()
      return {
        channels: documentChannels(),
        errors: documentReadyErrors().map((error) => String(error)),
        conflicts: documentChannelConflicts(),
      }
    }

    /** Answer a dialog the upstream code asked the browser to show. */
    case 'document:dialog-answer': {
      const [id, result] = args as [string, unknown]
      return { ok: resolveDialog(id, result) }
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

// The upstream code opens native dialogs; the browser shows them instead.
// The request goes back to the tab that triggered it, and the answer comes
// back as a job.
setDialogPresenter((request) => {
  parentPort?.postMessage({
    kind: 'dialog',
    id: request.id,
    dialogKind: request.kind,
    options: request.options,
    tabId: currentTabId,
  } satisfies EngineMessage)
})

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
