import {
  BridgeError,
  isBinary,
  isByteToken,
  toBytes,
  type RpcContext,
  type RpcEvent,
} from '../protocol'
import { ByteStore } from './bytes'
import { EventHub } from './events'

export interface ChannelContext {
  /** The channel that was called. */
  channel: string
  /** Which page called — the browser's stand-in for `event.sender.id`. */
  caller?: RpcContext
  /** Push an event back to the caller (and anyone else listening). */
  publish: (channel: string, args: unknown[]) => void
}

export type ChannelHandler = (
  context: ChannelContext,
  ...args: unknown[]
) => unknown | Promise<unknown>

export interface ChannelRouterOptions {
  bytes?: ByteStore
  events?: EventHub
  /** Where a missing channel is reported. */
  onMissing?: (channel: string) => void
  /**
   * A last resort for a channel nobody registered.
   *
   * Some surfaces are not known up front — the upstream slides main process
   * registers its channels when the module loads, so the list arrives with
   * the engine. The router asks this when its own table has no answer, and
   * uses what comes back (or reports the channel as missing).
   */
  fallback?: (channel: string) => Promise<ChannelHandler | undefined>
}

/**
 * Maps upstream channel names to handlers.
 *
 * The channel names come from upstream — the shared `ipc.ts` types and the
 * `CHANNELS` constant tables — and this router never invents one. A channel
 * without a handler fails loudly: the upstream preload's contract says every
 * exposed method works, and a silent `undefined` would show up as a broken
 * editor much later.
 */
export class ChannelRouter {
  readonly bytes: ByteStore
  readonly events: EventHub
  private readonly handlers = new Map<string, ChannelHandler>()
  private readonly onMissing: (channel: string) => void
  private fallback: ((channel: string) => Promise<ChannelHandler | undefined>) | undefined
  /** The channels already reported as missing — one line each is enough. */
  private readonly missing = new Set<string>()

  constructor(options: ChannelRouterOptions = {}) {
    this.bytes = options.bytes ?? new ByteStore()
    this.events = options.events ?? new EventHub()
    this.onMissing = options.onMissing ?? ((channel) => {
      console.warn(`[rpc-bridge] no handler for channel "${channel}"`)
    })
    this.fallback = options.fallback
  }

  register(channel: string, handler: ChannelHandler): this {
    this.handlers.set(channel, handler)
    return this
  }

  registerAll(handlers: Record<string, ChannelHandler>): this {
    for (const [channel, handler] of Object.entries(handlers)) this.register(channel, handler)
    return this
  }

  /**
   * Set the last resort for a channel nobody registered.
   *
   * Some surfaces are not known up front — the upstream slides main process
   * registers its channels when the module loads, so the list arrives with
   * the engine.
   */
  setFallback(fallback: (channel: string) => Promise<ChannelHandler | undefined>): this {
    this.fallback = fallback
    return this
  }

  has(channel: string): boolean {
    return this.handlers.has(channel)
  }

  get channels(): string[] {
    return [...this.handlers.keys()].sort()
  }

  /** Request-应答：the counterpart of `ipcRenderer.invoke`. */
  async invoke(channel: string, args: unknown[], caller?: RpcContext): Promise<unknown> {
    const handler = await this.resolveHandler(channel)
    if (!handler) {
      this.reportMissing(channel)
      throw new BridgeError('unknown_channel', `no handler for channel "${channel}"`)
    }
    const resolved = await this.resolveArgs(args)
    const value = await handler(this.context(channel, caller), ...resolved)
    return this.encodeValue(value)
  }

  /** Fire-and-forget: the counterpart of `ipcRenderer.send`. */
  async send(channel: string, args: unknown[], caller?: RpcContext): Promise<void> {
    const handler = await this.resolveHandler(channel)
    if (!handler) {
      // Electron drops a `send` to an unregistered channel without a sound;
      // the browser does the same, and only the first one is worth a line.
      this.reportMissing(channel)
      return
    }
    const resolved = await this.resolveArgs(args)
    await handler(this.context(channel, caller), ...resolved)
  }

  /**
   * The handler for a channel.
   *
   * The registered table first; then the fallback, which knows about the
   * surfaces that are not known up front.
   */
  private async resolveHandler(channel: string): Promise<ChannelHandler | undefined> {
    const registered = this.handlers.get(channel)
    if (registered) return registered
    if (!this.fallback) return undefined
    const found = await this.fallback(channel)
    if (!found) return undefined
    // Remember it: the next call does not have to ask again.
    this.handlers.set(channel, found)
    return found
  }

  private reportMissing(channel: string): void {
    if (this.missing.has(channel)) return
    this.missing.add(channel)
    this.onMissing(channel)
  }

  private context(channel: string, caller?: RpcContext): ChannelContext {
    return {
      channel,
      caller,
      publish: (target: string, args: unknown[]) => {
        this.events.publish(target, args)
      },
    }
  }

  /** Turn byte tokens in the arguments back into bytes. */
  private async resolveArgs(args: unknown[]): Promise<unknown[]> {
    const resolved: unknown[] = []
    for (const arg of args) {
      resolved.push(await this.resolveValue(arg))
    }
    return resolved
  }

  private async resolveValue(value: unknown): Promise<unknown> {
    // Binary first: a typed array is an object, and the generic branch below
    // would turn it into an index-to-number table.
    if (isBinary(value)) return value
    if (isByteToken(value)) {
      const bytes = this.bytes.take(value.__bytes)
      if (!bytes) {
        throw new BridgeError(
          'byte_token_invalid',
          `the byte token "${value.__bytes}" is unknown or already used`,
        )
      }
      return bytes
    }
    if (Array.isArray(value)) {
      const resolved = await this.resolveArgs(value)
      return resolved
    }
    if (value && typeof value === 'object') {
      const entries = await Promise.all(
        Object.entries(value as Record<string, unknown>).map(async ([key, item]) => [
          key,
          await this.resolveValue(item),
        ]),
      )
      return Object.fromEntries(entries)
    }
    return value
  }

  /** Turn binary results into byte tokens the peer can fetch. */
  private async encodeValue(value: unknown): Promise<unknown> {
    if (isBinary(value)) return { __bytes: this.bytes.put(toBytes(value)) }
    if (Array.isArray(value)) {
      const encoded = await Promise.all(value.map((item) => this.encodeValue(item)))
      return encoded
    }
    if (value && typeof value === 'object') {
      const entries = await Promise.all(
        Object.entries(value as Record<string, unknown>).map(async ([key, item]) => [
          key,
          await this.encodeValue(item),
        ]),
      )
      return Object.fromEntries(entries)
    }
    return value
  }
}

export type { RpcEvent }
