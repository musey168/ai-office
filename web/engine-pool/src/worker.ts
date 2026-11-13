import { parentPort, workerData } from 'node:worker_threads'
import { LocalWorkspaceStore } from '@ai-office/workspace-store'
import { createBlankPdf, renderPageImage, renderPagePreview } from './pdf'
import { installWasmLookup } from './pdfium'
import { blankDeck, buildOpenResult, openDeck, saveDeck } from './slides'
import { readSlideMedia } from '../../../apps/slides/src/main/session-state'
import type { OpenedPptx } from '@genoffice/pptx-engine'
import type { EngineRequest, EngineResponse } from './protocol'

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

interface Session {
  path: string
  opened: OpenedPptx
}

// The upstream wasm lookup (PDFium) falls back to the Electron resources
// directory; the worker has no Electron, so it is pointed at the worker's
// own directory before anything renders.
installWasmLookup()

const roots = (workerData as WorkerData | undefined)?.workspaceRoots ?? []
const store = new LocalWorkspaceStore({ roots })
const sessions = new Map<string, Session>()

async function run(job: string, args: unknown[]): Promise<unknown> {
  switch (job) {
    case 'slides:open': {
      const [sessionId, filePath, fitWidthPx] = args as [string, string, number]
      const bytes = await store.read(filePath)
      const opened = await openDeck(bytes)
      sessions.set(sessionId, { path: filePath, opened })
      return buildOpenResult(opened, filePath, fitWidthPx)
    }

    case 'slides:new-blank': {
      const [sessionId, fitWidthPx] = args as [string, number]
      const opened = await blankDeck()
      sessions.set(sessionId, { path: '', opened })
      return buildOpenResult(opened, '', fitWidthPx)
    }

    case 'slides:save': {
      const [sessionId] = args as [string]
      const session = sessions.get(sessionId)
      if (!session) throw new Error('the presentation is not open')
      const bytes = await saveDeck(session.opened)
      await store.write(session.path, bytes)
      return { ok: true, path: session.path }
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
      const [sessionId] = args as [string]
      sessions.delete(sessionId)
      return { ok: true }
    }

    default:
      throw new Error(`unknown engine job "${job}"`)
  }
}

parentPort?.on('message', (request: EngineRequest) => {
  void run(request.job, request.args).then(
    (value) => {
      parentPort?.postMessage({ id: request.id, ok: true, value } satisfies EngineResponse)
    },
    (error: unknown) => {
      parentPort?.postMessage({
        id: request.id,
        ok: false,
        error: { code: 'engine_error', message: (error as Error).message },
      } satisfies EngineResponse)
    },
  )
})
