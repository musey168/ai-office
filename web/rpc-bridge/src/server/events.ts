import type { RpcEvent } from '../protocol'

export type EventSender = (event: RpcEvent) => void

interface Subscription {
  channels: Set<string>
  /** The tab the subscriber belongs to; absent means "every tab". */
  tabId?: string
  send: EventSender
}

/**
 * The server-side event hub: main-process pushes (`webContents.send`) become
 * events on the stream, filtered per subscriber.
 */
export class EventHub {
  private readonly subscriptions = new Set<Subscription>()

  /**
   * Where the events that carry a tab go.
   *
   * The server publishes them itself; this is for the deployments that want
   * to see them too.
   */
  onPublish: (channel: string, args: unknown[], tabId: string) => void = () => {}

  /**
   * Subscribe to a set of channels; returns the unsubscribe function.
   *
   * The tab id narrows the subscription: the upstream main process pushes at
   * one renderer, so an event about a deck belongs to the tab showing it —
   * not to every browser that happens to be connected.
   */
  subscribe(channels: string[], send: EventSender, tabId?: string): () => void {
    const subscription: Subscription = { channels: new Set(channels), send, tabId }
    this.subscriptions.add(subscription)
    return () => {
      this.subscriptions.delete(subscription)
    }
  }

  /**
   * Push an event to every subscriber listening for that channel.
   *
   * A subscription with **no** channel filter takes everything — that is
   * what a client that filters locally asks for.
   */
  publish(channel: string, args: unknown[]): void {
    this.publishTo(channel, args)
  }

  /**
   * Push an event to one tab.
   *
   * The subscribers that belong to other tabs do not get it: an event about
   * somebody's deck is not everybody's business.
   */
  publishToTab(tabId: string, channel: string, args: unknown[]): void {
    this.onPublish(channel, args, tabId)
    for (const subscription of this.subscriptions) {
      if (subscription.tabId !== undefined && subscription.tabId !== tabId) continue
      if (subscription.channels.size > 0 && !subscription.channels.has(channel)) continue
      subscription.send({ channel, args })
    }
  }

  private publishTo(channel: string, args: unknown[]): void {
    for (const subscription of this.subscriptions) {
      if (subscription.channels.size > 0 && !subscription.channels.has(channel)) continue
      subscription.send({ channel, args })
    }
  }

  get subscriberCount(): number {
    return this.subscriptions.size
  }
}
