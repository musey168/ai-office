import type { WorkspaceStore } from '@ai-office/workspace-store'
import { BridgeError } from '../../protocol'
import type { TabRegistry } from '../tabs'
import type { ChannelHandler } from '../router'

/**
 * The Markdown module's channels.
 *
 * A markdown tab is granted the file it was opened with; upstream refuses
 * every other path ("path not granted to this view"), and so does this.
 */

export interface MarkdownChannelDeps {
  store: WorkspaceStore
  tabs: TabRegistry
}

export function createMarkdownChannels(
  deps: MarkdownChannelDeps,
): Record<string, ChannelHandler> {
  const { store, tabs } = deps

  /** The path this tab was opened with; null for an untitled note. */
  const grantedPath = (tabId?: string): string | undefined => {
    const tab = tabId ? tabs.get(tabId) : undefined
    return tab?.filePath
  }

  return {
    'markdown:consume-pending': (ctx) => grantedPath(ctx.caller?.tabId) ?? null,

    'markdown:read-file': async (ctx, path) => {
      const granted = grantedPath(ctx.caller?.tabId)
      if (typeof path !== 'string' || !path || path !== granted) {
        throw new BridgeError('invalid_argument', 'markdown: path not granted to this view')
      }
      const content = await store.read(path)
      return new TextDecoder().decode(content)
    },
  }
}
