import type { BridgeClient } from './client'
import type { RpcContext } from './protocol'

/**
 * Where the calling page is, in the terms the server needs.
 *
 * Electron has `event.sender.id` — the id of the web contents that made the
 * call — and the main process uses it to hand a document to the right
 * window. A browser has no such id, so the page says which upstream app it
 * is (`/app/docs/` → `docs`) and which tab it belongs to (`?tab=…`).
 */
export function pageContext(location: { pathname: string; search: string }): RpcContext {
  const match = /^\/app\/([a-z]+)\//.exec(location.pathname)
  const tab = new URLSearchParams(location.search).get('tab')
  const ctx: RpcContext = {}
  if (match) ctx.app = match[1]
  if (tab) ctx.tabId = tab
  return ctx
}

interface TabSummary {
  id: string
  kind: string
  title: string
  active: boolean
}

/** The height of the shell's tab strip — upstream's `.tab-bar` is 40px tall. */
const TAB_BAR_HEIGHT = 40

/**
 * Hosts the editor applications inside the shell page.
 *
 * Upstream paints the editors as native `WebContentsView`s **above** the
 * shell's DOM — the shell renderer knows nothing about them, it only draws
 * the tab strip and the home screen. A browser cannot do that, so the
 * bridge mounts an iframe over the same area and keeps it in sync with the
 * active tab. The upstream renderer stays untouched.
 */
export class EditorHost {
  private frame: HTMLIFrameElement | null = null
  private currentUrl = ''

  constructor(private readonly client: BridgeClient) {}

  /** Follow the shell's tabs from the start. */
  async start(): Promise<void> {
    try {
      const tabs = (await this.client.invoke('tabs:list')) as TabSummary[]
      this.client.on('tabs:changed', (_event, next) => {
        this.sync(next as TabSummary[])
      })
      this.sync(tabs)
    } catch {
      // The tab list is unavailable — the shell still works, it just shows
      // no editor.
    }
  }

  private sync(tabs: TabSummary[]): void {
    const active = tabs.find((tab) => tab.active)
    if (!active || active.kind === 'home' || active.kind === 'help') {
      this.hide()
      return
    }
    const url = `/app/${active.kind}/?tab=${encodeURIComponent(active.id)}`
    if (url !== this.currentUrl) {
      this.currentUrl = url
      this.ensureFrame().src = url
    }
    this.show()
  }

  private ensureFrame(): HTMLIFrameElement {
    if (this.frame) return this.frame
    const frame = document.createElement('iframe')
    frame.title = 'editor'
    frame.setAttribute('data-ai-office-editor', '')
    frame.style.position = 'fixed'
    frame.style.top = `${TAB_BAR_HEIGHT}px`
    frame.style.left = '0'
    frame.style.right = '0'
    frame.style.bottom = '0'
    // Below the tab strip (upstream gives it z-index 10), above the shell's
    // own content.
    frame.style.zIndex = '5'
    frame.style.border = '0'
    frame.style.display = 'none'
    frame.style.background = 'var(--surface, #fff)'
    document.body.appendChild(frame)
    this.frame = frame
    return frame
  }

  private show(): void {
    const frame = this.frame
    if (frame) frame.style.display = 'block'
  }

  private hide(): void {
    const frame = this.frame
    if (frame) frame.style.display = 'none'
  }
}
