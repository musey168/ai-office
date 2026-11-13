import type { RpcEvent } from '../protocol'

export type EventSender = (event: RpcEvent) => void

interface Subscription {
  channels: Set<string>
  send: EventSender
}

/**
 * The server-side event hub: main-process pushes (`webContents.send`) become
 * events on the stream, filtered per subscriber.
 */
export class EventHub {
  private readonly subscriptions = new Set<Subscription>()

  /** Subscribe to a set of channels; returns the unsubscribe function. */
  subscribe(channels: string[], send: EventSender): () => void {
    const subscription: Subscription = { channels: new Set(channels), send }
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
    for (const subscription of this.subscriptions) {
      if (subscription.channels.size > 0 && !subscription.channels.has(channel)) continue
      subscription.send({ channel, args })
    }
  }

  get subscriberCount(): number {
    return this.subscriptions.size
  }
}
