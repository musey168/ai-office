import { BridgeError } from '../../protocol'
import type { ChannelHandler } from '../router'
import type { TabRegistry } from '../tabs'
import type { EngineRunner } from './slides'

/**
 * The document channels — markdown, html and pdf.
 *
 * Upstream keeps the open document in its **main process**: the renderer
 * sends "save this text", "the file changed on disk", and the main process
 * owns the path, the assets and the write itself.
 *
 * So most of these channels are not implemented here — they are the upstream
 * handlers themselves, running in the engine worker. The server shim
 * captured them when the upstream module registered them, and the worker
 * calls them with the tab's sender id.
 *
 * The channels the server implements itself are the ones that name a path:
 * the browser says "open this file", and the server has to know that the
 * file is inside the workspace before the upstream handler reads it.
 */

/** The applications that keep a document in the main process. */
export type DocumentApp = 'markdown' | 'html' | 'pdf'

/** The prefix each application's channels start with. */
const APP_PREFIX: Record<DocumentApp, string> = {
  markdown: 'markdown:',
  html: 'html:',
  pdf: 'pdf:',
}

export interface DocumentChannelsDeps {
  engines: EngineRunner | null
  tabs: TabRegistry
  /**
   * Whether a path is inside the workspace.
   *
   * The upstream handler reads the file itself; the check here is the fence
   * in front of it — a path the workspace does not hold never reaches the
   * disk.
   */
  canReach?: (filePath: string) => boolean
}

export interface DocumentChannels {
  /**
   * The handler for a channel the upstream document applications
   * registered.
   *
   * The upstream list is fetched once, the first time a browser asks for
   * something the server does not implement itself.
   */
  upstreamHandler(channel: string): Promise<ChannelHandler | undefined>
  /**
   * Open a document in the engine, the way the desktop app opens it.
   *
   * The upstream `createXxxView` grants the view the paths it may read and
   * write, so the upstream save handler finds the path by itself.
   */
  openForTab(tabId: string, filePath: string): Promise<void>
  /** The channels the server implements itself. */
  readonly handlers: Record<string, ChannelHandler>
}

export function createDocumentChannels(deps: DocumentChannelsDeps): DocumentChannels {
  const { engines, tabs, canReach } = deps

  /** The engine pool, or a clear error when it is not running. */
  const requireEngines = (): EngineRunner => {
    if (!engines) {
      throw new BridgeError('not_available', 'the engine pool is not running')
    }
    return engines
  }

  /** The application a channel belongs to. */
  const appOf = (channel: string): DocumentApp | undefined =>
    (Object.keys(APP_PREFIX) as DocumentApp[]).find(
      (app) => channel.startsWith(APP_PREFIX[app]),
    )

  /**
   * The upstream channels the browser may call.
   *
   * The upstream main processes register their handlers when the module
   * loads; the worker asks for the list once and answers with it.
   */
  let upstreamChannels: string[] | null = null

  const loadUpstreamChannels = async (): Promise<string[]> => {
    if (upstreamChannels) return upstreamChannels
    const listed = await requireEngines().run<{ channels?: string[] }>('document:channels')
    upstreamChannels = listed?.channels ?? []
    return upstreamChannels
  }

  /** The tabs whose document is already open in the engine. */
  const opened = new Set<string>()

  /**
   * Open a document in the engine.
   *
   * The upstream main process owns the open document: it grants the paths,
   * it watches the file for outside changes, and its save handler writes
   * it. Opening it the upstream way is what makes those work.
   */
  const openForTab = async (tabId: string, filePath: string): Promise<void> => {
    if (opened.has(tabId)) return
    if (canReach && !canReach(filePath)) {
      throw new BridgeError('outside_allowed_roots', 'the file is outside the workspace')
    }
    const app = tabs.get(tabId)?.kind as DocumentApp | undefined
    if (!app || !(app in APP_PREFIX)) {
      throw new BridgeError('invalid_argument', `the tab does not show a document`)
    }
    await requireEngines().run('document:open', [app, filePath, tabId])
    opened.add(tabId)
  }

  /**
   * Forward a channel to the upstream handler.
   *
   * The upstream handlers live in the engine worker; they answer with the
   * same shapes the desktop app's main process returns, so the upstream
   * renderer consumes them unchanged.
   */
  const forward = (channel: string): ChannelHandler => {
    return async (context, ...args) => {
      const tabId = context.caller?.tabId
      if (!tabId) {
        throw new BridgeError('invalid_argument', 'the call has no tab')
      }
      return requireEngines().run('document:invoke', [channel, args, tabId], tabId)
    }
  }

  /**
   * Answer a dialog the upstream code asked the browser to show.
   *
   * The upstream main process opens a native dialog for "save as"; the
   * browser has none, so the request travels to the tab and the answer
   * comes back here.
   */
  const answerDialog = async (_context: unknown, id: string, result: unknown): Promise<unknown> => {
    return requireEngines().run('document:dialog-answer', [id, result])
  }

  return {
    upstreamHandler: async (channel) => {
      const app = appOf(channel)
      if (!app) return undefined
      const channels = await loadUpstreamChannels()
      if (!channels.includes(channel)) return undefined
      return forward(channel)
    },

    openForTab,

    handlers: {
      'document:dialog-answer': answerDialog as ChannelHandler,
    },
  }
}
