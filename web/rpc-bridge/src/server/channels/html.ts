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
}

export function createHtmlChannels(deps: HtmlChannelDeps): Record<string, ChannelHandler> {
  const { store, tabs } = deps

  const grantedPath = (tabId?: string): string | undefined => {
    const tab = tabId ? tabs.get(tabId) : undefined
    return tab?.filePath
  }

  return {
    'html:consume-pending': (ctx) => grantedPath(ctx.caller?.tabId) ?? null,

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
