import type { WorkspaceStore } from '@ai-office/workspace-store'
import { BridgeError } from '../../protocol'
import type { TabRegistry } from '../tabs'
import type { ChannelHandler } from '../router'

/**
 * The HTML module's channels.
 *
 * Same shape as the Markdown module: a tab is granted the file it was
 * opened with, and nothing else.
 */

export interface HtmlChannelDeps {
  store: WorkspaceStore
  tabs: TabRegistry
  /**
   * Open the document in the engine.
   *
   * Upstream keeps the open page in its main process — it grants the paths
   * it may read and write, and its save handler writes it.
   */
  openForTab?: (tabId: string, filePath: string) => Promise<void>
}

export function createHtmlChannels(deps: HtmlChannelDeps): Record<string, ChannelHandler> {
  const { store, tabs, openForTab } = deps

  const grantedPath = (tabId?: string): string | undefined => {
    const tab = tabId ? tabs.get(tabId) : undefined
    return tab?.filePath
  }

  return {
    'html:consume-pending': async (ctx) => {
      const tabId = ctx.caller?.tabId
      const path = grantedPath(tabId)
      if (tabId && path && openForTab) {
        await openForTab(tabId, path)
      }
      return path ?? null
    },

    'html:read-file': async (ctx, path) => {
      const granted = grantedPath(ctx.caller?.tabId)
      if (typeof path !== 'string' || !path || path !== granted) {
        throw new BridgeError('invalid_argument', 'html: path not granted to this view')
      }
      const content = await store.read(path)
      return new TextDecoder().decode(content)
    },
  }
}
