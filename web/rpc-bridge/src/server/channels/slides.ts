import { BridgeError } from '../../protocol'
import type { ChannelHandler } from '../router'
import type { TabRegistry } from '../tabs'

/**
 * The slides channels.
 *
 * The deck lives **on the server**, where upstream keeps it: upstream's main
 * process owns the parsed deck, applies the operations the renderer asks
 * for, and hands back the rebuilt render tree.
 *
 * So most of these channels are not implemented here — they are the upstream
 * handlers themselves, running in the engine worker. The server shim
 * captured them when the upstream module registered them, and the worker
 * calls them with the tab's sender id.
 *
 * The two channels the server implements itself are the ones that name a
 * path: the browser says "open this file", and the server has to know that
 * the file is inside the workspace before the upstream handler reads it.
 */

/**
 * What the engine pool is asked to do.
 *
 * The affinity key names the session the job belongs to: a session lives in
 * one worker's memory, so its jobs must all run on that worker.
 */
export interface EngineRunner {
  run<T = unknown>(job: string, args?: unknown[], affinityKey?: string): Promise<T>
  /**
   * Ask every worker; the first one that has the answer wins.
   *
   * Some state is per worker and the request does not name the worker that
   * holds it — the slide media bytes are the upstream main process's module
   * state, and the browser asks for them by an opaque id.
   */
  runOnAny<T = unknown>(job: string, args?: unknown[]): Promise<T>
}

export interface SlidesOpenResult {
  path: string
  slides: unknown[]
  size: { cx: number; cy: number }
  defaultFont?: string
}

export interface SlidesChannelDeps {
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

export interface SlidesChannels {
  /**
   * The handler for a channel the upstream slides process registered.
   *
   * The upstream list is fetched once, the first time a browser asks for
   * something the server does not implement itself. Until then the cheap
   * handlers answer immediately.
   */
  upstreamHandler(channel: string): Promise<ChannelHandler | undefined>
  /** The channels the server implements itself. */
  readonly handlers: Record<string, ChannelHandler>
}

export function createSlidesChannels(deps: SlidesChannelDeps): SlidesChannels {
  const { engines, tabs, canReach } = deps

  /** The engine pool, or a clear error when it is not running. */
  const requireEngines = (): EngineRunner => {
    if (!engines) {
      throw new BridgeError('not_available', 'the engine pool is not running')
    }
    return engines
  }

  /** The engine session behind a tab — one open presentation per tab. */
  const sessionFor = (tabId: string | undefined): string => `slides:${tabId ?? 'detached'}`

  /**
   * The upstream channels the browser may call.
   *
   * The upstream main process registers its handlers when the module loads;
   * the worker asks for the list once and answers with the ones that are
   * safe to expose. A channel that needs a native capability the server
   * does not have is refused explicitly — it is never silently dropped.
   */
  let upstreamChannels: string[] | null = null

  const loadUpstreamChannels = async (): Promise<string[]> => {
    if (upstreamChannels) return upstreamChannels
    upstreamChannels = await requireEngines().run<string[]>('slides:channels')
    return upstreamChannels
  }

  /**
   * The upstream channels the server cannot serve.
   *
   * These two need something the server does not have and cannot pretend
   * to: a window to render the PDF in, and a printer to print on. They are
   * refused with a clear message rather than left to fail in an obscure
   * way; the gap is recorded in the architecture document's capability
   * table.
   *
   * The other native channels — the file dialogs, the system clipboard, the
   * printers, the screen — **do** go to the upstream handler: the server's
   * stand-in answers them honestly (a cancelled dialog, an empty
   * clipboard, no printers), so the upstream renderer takes its normal
   * branches instead of failing.
   */
  const NATIVE_CHANNELS = new Set([
    // A window to render the PDF in.
    'slides:export-pdf',
    // A printer to print on.
    'slides:print',
  ])

  /** The channels the server serves itself rather than the upstream handler. */
  const OWN_CHANNELS = new Set([
    'slides:consume-pending-open',
    'slides:new-blank',
    'slides:open-path',
    'slides:save',
    'slides:media',
    'slides:close',
  ])

  /**
   * Forward a channel to the upstream handler.
   *
   * The upstream handlers live in the engine worker; they answer with the
   * same shapes the desktop app's main process returns, so the upstream
   * renderer consumes them unchanged.
   */
  const forwardToUpstream = (channel: string): ChannelHandler => {
    return async (ctx, ...args) => {
      const tabId = ctx.caller?.tabId
      if (!tabId) {
        throw new BridgeError('invalid_argument', `the "${channel}" channel needs a tab`)
      }
      return requireEngines().run('slides:invoke', [channel, args, tabId], tabId)
    }
  }

  /**
   * Open a deck through the upstream handler.
   *
   * The upstream handler owns the session — the undo stack, the fit width,
   * the deck model — so the deck has to be opened by it, not by the server.
   * The path is checked here first: a file the workspace does not hold never
   * reaches the disk.
   */
  const openDeck = async (
    tabId: string,
    filePath: string,
    fitWidthPx: number,
  ): Promise<SlidesOpenResult | null> => {
    if (canReach && !canReach(filePath)) {
      throw new BridgeError(
        'outside_allowed_roots',
        `refusing to open a file outside the workspace: ${filePath}`,
      )
    }
    const result = await requireEngines().run<SlidesOpenResult | null>(
      'slides:invoke',
      ['slides:open-path', [filePath, fitWidthPx], tabId],
      tabId,
    )
    return result ?? null
  }

  const handlers: Record<string, ChannelHandler> = {
    /** The deck the home screen asked to open. */
    'slides:consume-pending-open': async (ctx, fitWidthPx) => {
      const tabId = ctx.caller?.tabId
      const tab = tabId ? tabs.get(tabId) : undefined
      const filePath = tab?.filePath
      if (!filePath || !tabId) return null
      return openDeck(tabId, filePath, Number(fitWidthPx) || 1280)
    },

    /**
     * A new, empty presentation.
     *
     * Upstream builds the blank deck in the main process and hands the
     * render tree over; the deck is only written to disk when it is saved.
     */
    'slides:new-blank': async (ctx, ...args) => {
      const tabId = ctx.caller?.tabId
      if (!tabId) {
        throw new BridgeError('invalid_argument', 'the "slides:new-blank" channel needs a tab')
      }
      const fitWidthPx = Number(args[0]) || 1280
      const result = await requireEngines().run<SlidesOpenResult | null>(
        'slides:invoke',
        ['slides:new-blank', [fitWidthPx], tabId],
        tabId,
      )
      return result
    },

    /** Open a deck by path. */
    'slides:open-path': async (ctx, filePath, fitWidthPx) => {
      if (typeof filePath !== 'string' || !filePath) return null
      const tabId = ctx.caller?.tabId ?? 'detached'
      return openDeck(tabId, filePath, Number(fitWidthPx) || 1280)
    },

    /**
     * Write the deck back to its file.
     *
     * The upstream handler owns the deck, so the save happens there — and
     * the path it writes to is the one the deck was opened with, which the
     * workspace fence already accepted.
     */
    'slides:save': async (ctx) => {
      const tabId = ctx.caller?.tabId
      if (!tabId) {
        throw new BridgeError('invalid_argument', 'the "slides:save" channel needs a tab')
      }
      const result = await requireEngines().run<{ ok: boolean; path?: string; error?: string }>(
        'slides:invoke',
        ['slides:save', [], tabId],
        tabId,
      )
      return result ?? { ok: false }
    },

    /**
     * The bytes of a slide's media.
     *
     * They live in the worker that holds the deck; the browser asks for
     * them by an opaque id, so every worker is asked.
     */
    'slides:media': async (_ctx, url) => {
      return (
        (await requireEngines().runOnAny<{ body: Uint8Array; mime: string } | null>(
          'slides:media',
          [url],
        )) ?? null
      )
    },

    /** A tab closed: the engine drops its session. */
    'slides:close': async (ctx) => {
      const tabId = ctx.caller?.tabId
      const result = await requireEngines().run<{ ok: boolean }>(
        'slides:close',
        [sessionFor(tabId), tabId],
        tabId,
      )
      return result
    },
  }

  /**
   * Register the upstream channels.
   *
   * The list comes from the upstream module itself, so a channel that exists
   * upstream is served here without anyone writing its name down twice.
   */
  const registerUpstreamChannels = async (): Promise<void> => {
    const channels = await loadUpstreamChannels()
    for (const channel of channels) {
      if (OWN_CHANNELS.has(channel)) continue
      if (handlers[channel]) continue
      if (NATIVE_CHANNELS.has(channel)) {
        handlers[channel] = () => {
          throw new BridgeError(
            'not_available',
            `the "${channel}" channel needs a native capability the server does not have`,
          )
        }
        continue
      }
      handlers[channel] = forwardToUpstream(channel)
    }
  }

  /**
   * The handler for a channel the upstream process registered.
   *
   * The upstream list is fetched once, the first time a browser asks for
   * something the server does not implement itself. Until then the cheap
   * handlers answer immediately.
   *
   * A channel the upstream process does not have is **not** a handler: the
   * router reports it as unknown, which is the truth — the server never
   * pretended to have it.
   */
  const upstreamHandler = async (channel: string): Promise<ChannelHandler | undefined> => {
    if (handlers[channel]) return handlers[channel]
    if (!engines) return undefined
    await registerUpstreamChannels()

    return handlers[channel]
  }

  return { handlers, upstreamHandler }
}
