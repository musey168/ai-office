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
  engines: EngineRunner
  tabs: TabRegistry
}

export function createSlidesChannels(deps: SlidesChannelDeps): Record<string, ChannelHandler> {
  const { engines, tabs } = deps

  /** The engine session behind a tab — one open presentation per tab. */
  const sessionFor = (tabId: string | undefined): string => `slides:${tabId ?? 'detached'}`

  const openFor = async (
    sessionId: string,
    filePath: string,
    fitWidthPx: number,
  ): Promise<SlidesOpenResult | null> => {
    return (await engines.run<SlidesOpenResult | null>('slides:open', [
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

    /** Open a deck by path. */
    'slides:open-path': async (_ctx, filePath, fitWidthPx) => {
      if (typeof filePath !== 'string' || !filePath) return null
      return openFor(sessionFor(undefined), filePath, Number(fitWidthPx) || 1280)
    },

    /** Write the deck back to its file. */
    'slides:save': async (ctx) => {
      const sessionId = sessionFor(ctx.caller?.tabId)
      const result = (await engines.run<{ ok: boolean; path?: string; error?: string }>(
        'slides:save',
        [sessionId],
      )) ?? { ok: false }
      return result
    },
  }
}
