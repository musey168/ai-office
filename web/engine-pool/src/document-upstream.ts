import {
  app,
  ipcHandlers,
  ipcListeners,
  ipcRegistrations,
  registerContentsPush,
  setWebContentsSource,
  unregisterContentsPush,
} from './electron-shim'
import { hostContents, hostEvents, hostSenders } from './slides-host'
import type { EngineEvent } from './protocol'

/**
 * The upstream document applications, running in the worker.
 *
 * Upstream keeps every open document in its main process: the renderer
 * sends "save this", "rename that", "the file changed on disk", and the main
 * process owns the path, the assets and the write itself.
 *
 * The web port has the same shape — the browser is the renderer, the server
 * is the main process — so the upstream main process modules are loaded **as
 * is** and their own IPC handlers answer the browser's calls. Nothing about
 * the document semantics is reimplemented here.
 *
 * The three applications register their handlers inside the callback of
 * `app.whenReady()`, which is where the desktop app puts them. The server
 * shim's `whenReady` resolves right away, so importing the module is enough
 * to make the registration happen.
 */

/** The applications that keep a document in the main process. */
export type DocumentApp = 'markdown' | 'html' | 'pdf'

/** The upstream handler for a channel, as the upstream code wrote it. */
type UpstreamHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

let loaded = false

/** The sender ids every application shares. */
const senders = hostSenders

/**
 * Load the upstream document applications.
 *
 * The registration is the upstream code's own: `ipcMain.handle` in the
 * server shim captures what upstream registers, so the browser's calls reach
 * the upstream code rather than a second implementation of it.
 */
export async function loadUpstreamDocuments(): Promise<void> {
  if (loaded) return
  loaded = true

  // The upstream code pushes events at the renderer (`contents.send`); the
  // shared host collects them and the worker sends them to the browser.
  setWebContentsSource(hostContents)

  // Each application has a standalone entry point: it is what the desktop
  // app's own main file calls, and it registers the handlers inside the
  // callback of `app.whenReady()`.
  const markdown = await import('../../../apps/markdown/src/main/markdown-main')
  const html = await import('../../../apps/html/src/main/html-main')
  const pdf = await import('../../../apps/pdf/src/main/pdf-main')

  markdown.startMarkdownStandalone()
  html.startHtmlStandalone()
  pdf.startPdfStandalone()

  // The registration happens in the callback of `app.whenReady()`; the
  // shim's promise has already resolved, so the callback runs on the
  // microtask queue. A macrotask turn lets it finish.
  await app.whenReady()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * The open documents, by tab.
 *
 * Upstream keys a document's session by the id of the web contents that
 * shows it, and the web contents is created when the document is opened.
 * The browser's tab is that web contents as far as the upstream code is
 * concerned.
 */
const views = new Map<string, { id: number; dispose(): void }>()

/**
 * Open a document the way the desktop app does.
 *
 * The upstream `createXxxView` is what the shell calls: it creates the
 * renderer, grants it the paths it may read and write, and starts watching
 * the file for outside changes. Calling it here means the server's session
 * is the upstream one — the save handler finds the path by itself.
 */
export async function openDocument(app: DocumentApp, filePath: string, tabId: string): Promise<number> {
  await loadUpstreamDocuments()

  const view =
    app === 'markdown'
      ? await import('../../../apps/markdown/src/main/markdown-main').then((m) =>
          m.createMarkdownView(filePath),
        )
      : app === 'html'
        ? await import('../../../apps/html/src/main/html-main').then((m) => m.createHtmlView(filePath))
        : await import('../../../apps/pdf/src/main/pdf-main').then((m) => m.createPdfView(filePath))

  const contents = view.webContents
  const id = contents.id
  // The upstream code pushes events at this web contents; they belong to
  // the browser tab that opened the document.
  registerContentsPush(id, (channel, args) => {
    hostEvents.push({ tabId, channel, args })
  })
  views.set(tabId, {
    id,
    dispose: () => {
      unregisterContentsPush(id)
    },
  })
  return id
}

/** Close a document and forget its session. */
export function closeDocument(tabId: string): void {
  const view = views.get(tabId)
  if (!view) return
  views.delete(tabId)
  view.dispose()
}

/**
 * The sender id of a tab's document.
 *
 * The upstream handlers take the event first and read `sender.id` from it;
 * that is the web contents id of the document the tab shows.
 */
export function documentSenderId(tabId: string): number {
  const view = views.get(tabId)
  if (view) return view.id
  // A document that was not opened through the upstream view still needs a
  // sender id, so the upstream code can key its session by it.
  return senders.senderIdFor(tabId)
}

/** The channels the upstream document applications registered. */
export function documentChannels(): string[] {
  return [...ipcHandlers.keys()].sort()
}

/** The errors the upstream registration threw. */
export function documentReadyErrors(): unknown[] {
  return app.readyErrors
}

/**
 * The channels more than one application registered.
 *
 * A shared channel (`app:get-theme` and the like) is registered by several
 * applications; the last one wins, and the list says which ones they were.
 */
export function documentChannelConflicts(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const channel of ipcRegistrations) {
    counts[channel] = (counts[channel] ?? 0) + 1
  }
  const conflicts: Record<string, number> = {}
  for (const [channel, count] of Object.entries(counts)) {
    if (count > 1) conflicts[channel] = count
  }
  return conflicts
}

/**
 * Call an upstream handler on behalf of a browser tab.
 *
 * The upstream handlers take the Electron event first and read `sender.id`
 * from it; the tab's id is turned into the number they expect.
 */
export async function invokeDocumentUpstream(
  channel: string,
  args: unknown[],
  tabId: string,
): Promise<unknown> {
  await loadUpstreamDocuments()
  const handler = ipcHandlers.get(channel) as UpstreamHandler | undefined
  if (!handler) throw new Error(`no handler for channel "${channel}"`)
  const senderId = documentSenderId(tabId)
  const event = { sender: { id: senderId } }
  return handler(event, ...args)
}

/**
 * Send a message to the upstream code the way the renderer does.
 *
 * Upstream uses `ipcMain.on` for the messages the renderer sends without
 * waiting for an answer.
 */
export async function sendDocumentUpstream(
  channel: string,
  args: unknown[],
  tabId: string,
): Promise<unknown> {
  await loadUpstreamDocuments()
  const listeners = [...(ipcListeners.get(channel) ?? [])]
  if (!listeners.length) throw new Error(`no listener for channel "${channel}"`)
  const senderId = documentSenderId(tabId)
  const event = { sender: { id: senderId } } as unknown as Electron.IpcMainEvent
  let last: unknown
  for (const listener of listeners) last = await (listener as (...a: unknown[]) => unknown)(event, ...args)
  return last
}

/** The events the upstream code pushed since the last call. */
export function takeDocumentEvents(): EngineEvent[] {
  return []
}

/** Forget a tab's session. */
export function forgetDocumentTab(tabId: string): void {
  senders.forget(tabId)
}
