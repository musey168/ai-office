import {
  isBinary,
  isByteToken,
  toArrayBuffer,
  toBytes,
  type RpcContext,
  type RpcResponse,
} from './protocol'

export interface BridgeClientOptions {
  /** Same-origin by default: the whole point of the single-origin topology. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Factory for the event stream; defaults to the global `EventSource`. */
  eventSourceFactory?: (url: string) => EventSource
  /**
   * Where the calling page is. Electron uses the web contents id for this;
   * the browser states it, so the server can tell the pages of a window
   * apart.
   */
  context?: () => RpcContext | undefined
}

/**
 * The browser half of the bridge: turns Electron's IPC calls into HTTP
 * requests and an event stream.
 *
 * Binary arguments are uploaded to the byte endpoint first and replaced by a
 * token, so the JSON payload never carries raw bytes. Binary results come
 * back the same way and are turned into `ArrayBuffer` again before the
 * renderer sees them.
 */
export class BridgeClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly eventSourceFactory: (url: string) => EventSource
  private readonly contextProvider: (() => RpcContext | undefined) | undefined
  private readonly listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>()
  private source: EventSource | null = null

  constructor(options: BridgeClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? ''
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
    this.eventSourceFactory =
      options.eventSourceFactory ?? ((url) => new EventSource(url))
    this.contextProvider = options.context
  }

  /** Request-应答：对应 `ipcRenderer.invoke`。 */
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const encoded = await this.encodeArgs(args)
    const response = await this.fetchImpl(`${this.baseUrl}/rpc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: encoded, ctx: this.currentContext() }),
    })
    const payload = (await response.json()) as RpcResponse
    if (!payload.ok) {
      const error = new Error(payload.error.message)
      ;(error as Error & { code?: string; detail?: unknown }).code = payload.error.code
      ;(error as Error & { code?: string; detail?: unknown }).detail = payload.error.detail
      throw error
    }
    return this.decodeValue(payload.value)
  }

  /** 单向发送：对应 `ipcRenderer.send`，不取结果。 */
  send(channel: string, ...args: unknown[]): void {
    void this.encodeArgs(args)
      .then((encoded) =>
        this.fetchImpl(`${this.baseUrl}/rpc/${encodeURIComponent(channel)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            args: encoded,
            ctx: this.currentContext(),
            fireAndForget: true,
          }),
        }),
      )
      .catch(() => {
        /* a fire-and-forget call has nobody to report to */
      })
  }

  /** 订阅：对应 `ipcRenderer.on`，返回退订函数。 */
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): () => void {
    let bucket = this.listeners.get(channel)
    if (!bucket) {
      bucket = new Set()
      this.listeners.set(channel, bucket)
    }
    bucket.add(listener)
    this.syncSubscription()
    return () => this.removeListener(channel, listener)
  }

  /** 退订：对应 `ipcRenderer.removeListener`。 */
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void {
    const bucket = this.listeners.get(channel)
    if (!bucket) return
    bucket.delete(listener)
    if (bucket.size === 0) this.listeners.delete(channel)
    this.syncSubscription()
  }

  /** Close the event stream. */
  dispose(): void {
    this.source?.close()
    this.source = null
    this.listeners.clear()
  }

  /**
   * One event stream per page, opened once and kept.
   *
   * The channel set grows and shrinks as the page mounts and unmounts its
   * listeners. Reconnecting on every change looked tidier, but the window
   * between the old stream closing and the new one opening silently loses
   * events — and the page is exactly where the user is looking when it
   * matters. So the stream stays open and the dispatch filters locally.
   */
  private syncSubscription(): void {
    if (this.source) return
    const url = `${this.baseUrl}/events`
    const source = this.eventSourceFactory(url)
    source.onmessage = (event: MessageEvent) => {
      void this.dispatch(event.data)
    }
    this.source = source
  }

  private async dispatch(raw: string): Promise<void> {
    let payload: { channel: string; args: unknown[] }
    try {
      payload = JSON.parse(raw) as { channel: string; args: unknown[] }
    } catch {
      return
    }
    const bucket = this.listeners.get(payload.channel)
    if (!bucket) return
    const args = await this.decodeArgs(payload.args)
    for (const listener of bucket) {
      // Electron hands the listener an event object first; the renderer only
      // ever reads the payload, so a plain object stands in.
      listener({ senderId: 0 }, ...args)
    }
  }

  private currentContext(): RpcContext | undefined {
    return this.contextProvider?.()
  }

  private async encodeArgs(args: unknown[]): Promise<unknown[]> {
    const encoded: unknown[] = []
    for (const arg of args) {
      if (isBinary(arg)) {
        const token = await this.uploadBytes(toBytes(arg))
        encoded.push({ __bytes: token })
      } else {
        encoded.push(arg)
      }
    }
    return encoded
  }

  private async decodeArgs(args: unknown[]): Promise<unknown[]> {
    const decoded: unknown[] = []
    for (const arg of args) {
      decoded.push(await this.decodeValue(arg))
    }
    return decoded
  }

  private async decodeValue(value: unknown): Promise<unknown> {
    if (isByteToken(value)) {
      return toArrayBuffer(await this.downloadBytes(value.__bytes))
    }
    if (Array.isArray(value)) return this.decodeArgs(value)
    if (value && typeof value === 'object') {
      const entries = await Promise.all(
        Object.entries(value as Record<string, unknown>).map(async ([key, item]) => [
          key,
          await this.decodeValue(item),
        ]),
      )
      return Object.fromEntries(entries)
    }
    return value
  }

  private async uploadBytes(bytes: Uint8Array): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/bytes`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes.slice().buffer,
    })
    const payload = (await response.json()) as { token?: string; error?: string }
    if (!payload.token) throw new Error(payload.error ?? 'could not upload bytes')
    return payload.token
  }

  private async downloadBytes(token: string): Promise<Uint8Array> {
    const response = await this.fetchImpl(`${this.baseUrl}/bytes/${encodeURIComponent(token)}`)
    if (!response.ok) throw new Error(`could not download bytes: ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}
