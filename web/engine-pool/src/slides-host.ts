import type { WebContents } from 'electron'

/**
 * The slides engine's browser-facing host.
 *
 * Upstream's slides main process keys every session by `e.sender.id` — the
 * id of the web contents that made the call. A browser has no such id, so
 * the page states which tab it belongs to and the server turns that into a
 * number the upstream code can use as a key.
 *
 * The upstream handlers themselves are **not reimplemented here**: they are
 * the ones `registerSlidesIpc()` registered, and this module only provides
 * the pieces they expect around them — an event with a sender, and a
 * web contents whose `send` reaches the browser.
 */

/** A tab's identity, as the server sees it. */
export interface SlidesCaller {
  /** The tab the call came from; the key the upstream session map uses. */
  senderId: number
  /** The tab's id in the server's own terms (for the browser). */
  tabId: string
}

/**
 * The web contents the upstream code talks back to.
 *
 * Upstream pushes `slides:deck-changed` and `slides:history-changed` at the
 * renderer after an edit; without this the browser would never learn that
 * the deck changed.
 */
/**
 * The web contents the upstream code pushes events at.
 *
 * Electron's `WebContents` is a class with a hundred methods; the server
 * implements the three the upstream code calls, and the cast says so.
 */
export type SlidesWebContents = WebContents

/** How the host reaches the browser. */
export interface SlidesHostTransport {
  /** Push an event to one tab. */
  push(tabId: string, channel: string, args: unknown[]): void
  /** Drop a tab's session (it closed). */
  forget(tabId: string): void
}

/**
 * Maps browser tabs onto the numeric sender ids the upstream code expects.
 *
 * The numbers are allocated per tab and never reused, so a stale event
 * cannot land on a tab that opened later.
 */
export class SenderRegistry {
  private readonly byTab = new Map<string, number>()
  private readonly byId = new Map<number, string>()
  private next = 1

  /** The sender id for a tab, allocating one the first time. */
  senderIdFor(tabId: string): number {
    const existing = this.byTab.get(tabId)
    if (existing !== undefined) return existing
    const id = this.next++
    this.byTab.set(tabId, id)
    this.byId.set(id, tabId)
    return id
  }

  /** The tab behind a sender id. */
  tabFor(senderId: number): string | undefined {
    return this.byId.get(senderId)
  }

  /** Every sender id still open. */
  allIds(): number[] {
    return [...this.byId.keys()]
  }

  /** Forget a tab. */
  forget(tabId: string): void {
    const id = this.byTab.get(tabId)
    if (id === undefined) return
    this.byTab.delete(tabId)
    this.byId.delete(id)
  }
}

/**
 * The web contents upstream's `webContents.fromId` finds.
 *
 * The upstream code looks a web contents up by sender id to push events at
 * it, so the registry hands out one object per sender id that forwards to
 * the browser tab behind it.
 */
export class SlidesContentsRegistry {
  constructor(
    private readonly senders: SenderRegistry,
    private readonly transport: SlidesHostTransport,
  ) {}

  /** The web contents for a sender id, if the tab is still open. */
  fromId(senderId: number): SlidesWebContents | undefined {
    const tabId = this.senders.tabFor(senderId)
    if (tabId === undefined) return undefined
    return {
      id: senderId,
      isDestroyed: () => false,
      send: (channel: string, ...args: unknown[]) => {
        this.transport.push(tabId, channel, args)
      },
    } as unknown as SlidesWebContents
  }

  /** Every open web contents — upstream iterates this to broadcast. */
  all(): SlidesWebContents[] {
    const contents: SlidesWebContents[] = []
    for (const senderId of this.senders.allIds()) {
      const found = this.fromId(senderId)
      if (found) contents.push(found)
    }
    return contents
  }
}

/**
 * The events the upstream code pushed, waiting to go back to the browser.
 *
 * Every application that keeps a document in the main process pushes its
 * events here; the worker collects them after each job.
 */
export const hostEvents: { tabId: string; channel: string; args: unknown[] }[] = []

/**
 * The sender ids every application shares.
 *
 * Upstream keys its sessions by `e.sender.id`, and the browser tab is the
 * same tab whatever application it is showing, so the numbers are handed
 * out once.
 */
export const hostSenders = new SenderRegistry()

/**
 * The web contents the upstream code pushes events at.
 *
 * It is registered once, for all the applications: upstream resolves a web
 * contents for every session it owns, and they all live in the same worker.
 */
export const hostContents = new SlidesContentsRegistry(hostSenders, {
  push: (tabId, channel, args) => {
    hostEvents.push({ tabId, channel, args })
  },
  forget: (tabId) => {
    hostSenders.forget(tabId)
  },
})
