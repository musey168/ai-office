import { BridgeError } from '../../protocol'
import type { ChannelHandler } from '../router'
import type { TabRegistry } from '../tabs'

/**
 * The shell's tab strip.
 *
 * Upstream keeps the tabs in the main process and pushes changes to the
 * renderer (`tabs:changed`). Here the registry lives on the server, and the
 * same push goes out over the event stream.
 */
export interface TabChannelDeps {
  tabs: TabRegistry
  /** Push an event to the pages listening for it. */
  publish: (channel: string, args: unknown[]) => void
}

export function createTabChannels(deps: TabChannelDeps): Record<string, ChannelHandler> {
  const { tabs } = deps

  tabs.onChange((list) => {
    deps.publish('tabs:changed', [list])
  })

  return {
    'tabs:list': () => tabs.list(),

    'tabs:activate': async (_ctx, id) => {
      if (typeof id === 'string') tabs.activate(id)
    },

    'tabs:close': async (_ctx, id) => {
      if (typeof id === 'string') tabs.close(id)
    },

    /** Native context menus — they have no browser equivalent. */
    'tabs:show-menu': async () => {
      throw new BridgeError('not_available', 'the native context menu does not exist in the browser')
    },
    'tabs:show-tab-menu': async () => {
      throw new BridgeError('not_available', 'the native context menu does not exist in the browser')
    },
    'tabs:show-app-menu': async () => {
      throw new BridgeError('not_available', 'the native context menu does not exist in the browser')
    },
    'tabs:show-new-menu': async () => {
      throw new BridgeError('not_available', 'the native context menu does not exist in the browser')
    },
  }
}
