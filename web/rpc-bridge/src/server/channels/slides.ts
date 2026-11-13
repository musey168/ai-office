import { BridgeError } from '../../protocol'
import type { ChannelHandler } from '../router'
import type { TabRegistry } from '../tabs'

/**
 * The slides channels.
 *
 * The parsing happens **on the server** (upstream does it in the main
 * process), so these channels hand the work to the engine pool and return
 * the render tree the browser draws.
 */

/** What the engine pool is asked to do. */
export interface EngineRunner {
  run<T = unknown>(job: string, args?: unknown[]): Promise<T>
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
}

export function createSlidesChannels(deps: SlidesChannelDeps): Record<string, ChannelHandler> {
  const { engines, tabs } = deps

  /** The engine pool, or a clear error when it is not running. */
  const requireEngines = (): EngineRunner => {
    if (!engines) {
      throw new BridgeError('not_available', 'the engine pool is not running')
    }
    return engines
  }

  /** The engine session behind a tab — one open presentation per tab. */
  const sessionFor = (tabId: string | undefined): string => `slides:${tabId ?? 'detached'}`

  const openFor = async (
    sessionId: string,
    filePath: string,
    fitWidthPx: number,
  ): Promise<SlidesOpenResult | null> => {
    return (await requireEngines().run<SlidesOpenResult | null>('slides:open', [
      sessionId,
      filePath,
      fitWidthPx,
    ])) ?? null
  }

  return {
    /** The deck the home screen asked to open. */
    'slides:consume-pending-open': async (ctx, fitWidthPx) => {
      const tabId = ctx.caller?.tabId
      const tab = tabId ? tabs.get(tabId) : undefined
      const filePath = tab?.filePath
      if (!filePath) return null
      return openFor(sessionFor(tabId), filePath, Number(fitWidthPx) || 1280)
    },

    /**
     * A new, empty presentation.
     *
     * Upstream builds the blank deck in the main process and hands the
     * render tree over; the deck is only written to disk when it is saved.
     */
    'slides:new-blank': async (ctx, ...args) => {
      const fitWidthPx = Number(args[0]) || 1280
      const sessionId = sessionFor(ctx.caller?.tabId)
      const result = await requireEngines().run<SlidesOpenResult | null>('slides:new-blank', [
        sessionId,
        fitWidthPx,
      ])
      return result
    },

    /** Open a deck by path. */
    'slides:open-path': async (_ctx, filePath, fitWidthPx) => {
      if (typeof filePath !== 'string' || !filePath) return null
      return openFor(sessionFor(undefined), filePath, Number(fitWidthPx) || 1280)
    },

    /** Write the deck back to its file. */
    'slides:save': async (ctx) => {
      const sessionId = sessionFor(ctx.caller?.tabId)
      const result = (await requireEngines().run<{ ok: boolean; path?: string; error?: string }>(
        'slides:save',
        [sessionId],
      )) ?? { ok: false }
      return result
    },
  }
}
