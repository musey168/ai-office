import { ipcHandlers, setWebContentsSource } from './electron-shim'
import { hostContents, hostEvents, hostSenders } from './slides-host'
import { rewriteMediaUrls } from './slides'
import { registerSlidesIpc } from '../../../apps/slides/src/main/slides-main'
import type { EngineEvent } from './protocol'

/**
 * The upstream slides main process, running in the worker.
 *
 * Upstream keeps the deck in its main process and lets the renderer drive
 * it over IPC: the renderer says "edit this text", the main process applies
 * the operation to the live model and hands back the rebuilt render tree.
 *
 * The web port has the same shape — the browser is the renderer, the server
 * is the main process — so the upstream main process is loaded **as is** and
 * its own IPC handlers answer the browser's calls. Nothing about the deck
 * semantics is reimplemented here; this module only provides what those
 * handlers expect around them:
 *
 * - an event with a `sender` (upstream keys its sessions by sender id);
 * - a `webContents` the upstream code can push events at.
 */

/** Upstream's slides handlers, by channel name. */
type UpstreamHandler = (
  event: { sender: { id: number } },
  ...args: unknown[]
) => unknown

let registered = false

/** The sender ids every application shares. */
const senders = hostSenders

/** The events the upstream code pushed, waiting to go back to the browser. */
const pending: EngineEvent[] = []

/**
 * Load the upstream slides main process and register its handlers.
 *
 * The registration is the upstream function itself: `ipcMain.handle` in the
 * server shim captures what upstream registers, so the browser's calls reach
 * the upstream code rather than a second implementation of it.
 */
export function loadUpstreamSlides(): void {
  if (registered) return
  registered = true

  // The events travel to the browser from the worker's shared queue, so the
  // documents and the slides report through the same path.
  setWebContentsSource(hostContents)

  registerSlidesIpc()
}

/** The upstream handler for a channel, if it has one. */
export function upstreamHandler(channel: string): UpstreamHandler | undefined {
  loadUpstreamSlides()
  return ipcHandlers.get(channel) as UpstreamHandler | undefined
}

/** The channels the upstream slides process registered. */
export function upstreamChannels(): string[] {
  loadUpstreamSlides()
  return [...ipcHandlers.keys()].sort()
}

/**
 * Call an upstream handler on behalf of a browser tab.
 *
 * The upstream handlers take the Electron event first and read `sender.id`
 * from it; the tab's id is turned into the number they expect.
 */
export async function invokeUpstream(
  channel: string,
  args: unknown[],
  tabId: string,
): Promise<unknown> {
  const handler = upstreamHandler(channel)
  if (!handler) throw new Error(`no handler for channel "${channel}"`)
  const senderId = senders.senderIdFor(tabId)
  const event = { sender: { id: senderId } }
  const result = await handler(event, ...args)
  // The upstream handlers hand back the render tree, and the tree carries
  // the media URLs in the upstream custom scheme. A browser cannot fetch a
  // custom scheme, so they become same-origin paths the server answers.
  rewriteMediaUrls(result)
  return result
}

/** The events the upstream code pushed since the last call. */
export function takeEvents(): EngineEvent[] {
  const events = pending.splice(0, pending.length)
  events.push(...hostEvents.splice(0, hostEvents.length))
  return events
}

/** Forget a tab's session. */
export function forgetTab(tabId: string): void {
  senders.forget(tabId)
}
