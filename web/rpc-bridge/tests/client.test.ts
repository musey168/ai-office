import { describe, expect, it, vi } from 'vitest'
import { BridgeClient } from '../src/client'

/** A fetch stand-in that answers with whatever the test queued. */
function fakeFetch(responses: {
  rpc?: (url: string, init?: RequestInit) => unknown
  upload?: () => { token: string }
  download?: () => Uint8Array
}) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.includes('/bytes/')) {
      const bytes = responses.download?.() ?? new Uint8Array()
      return new Response(bytes.slice().buffer, { status: 200 })
    }
    if (url.endsWith('/bytes')) {
      const payload = responses.upload?.() ?? { token: 'tok' }
      return new Response(JSON.stringify(payload), { status: 200 })
    }
    const value = responses.rpc?.(url, init)
    return new Response(JSON.stringify(value ?? { ok: true, value: null }), { status: 200 })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

class FakeEventSource {
  static last: FakeEventSource | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.last = this
  }
  close(): void {
    this.closed = true
  }
}

describe('BridgeClient', () => {
  it('posts an invoke as JSON and returns the value', async () => {
    const { impl, calls } = fakeFetch({ rpc: () => ({ ok: true, value: 'hello' }) })
    const client = new BridgeClient({ fetchImpl: impl })
    expect(await client.invoke('docs:open-path', 'a.docx')).toBe('hello')
    expect(calls[0]?.url).toBe('/rpc/docs%3Aopen-path')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ args: ['a.docx'] })
  })

  it('throws the server error with its code', async () => {
    const { impl } = fakeFetch({
      rpc: () => ({ ok: false, error: { code: 'file_not_found', message: 'no such file' } }),
    })
    const client = new BridgeClient({ fetchImpl: impl })
    await expect(client.invoke('docs:open-path', 'x')).rejects.toMatchObject({
      code: 'file_not_found',
      message: 'no such file',
    })
  })

  it('uploads binary arguments and sends the token', async () => {
    const { impl, calls } = fakeFetch({
      rpc: () => ({ ok: true, value: null }),
      upload: () => ({ token: 'tok-1' }),
    })
    const client = new BridgeClient({ fetchImpl: impl })
    await client.invoke('docs:save-to', 'a.docx', new Uint8Array([1, 2, 3]).buffer, true)
    const rpcCall = calls.find((call) => call.url.includes('/rpc/'))
    expect(JSON.parse(String(rpcCall?.init?.body))).toEqual({
      args: ['a.docx', { __bytes: 'tok-1' }, true],
    })
    expect(calls.some((call) => call.url.endsWith('/bytes'))).toBe(true)
  })

  it('downloads a binary result and returns an ArrayBuffer', async () => {
    const { impl } = fakeFetch({
      rpc: () => ({ ok: true, value: { __bytes: 'tok-2' } }),
      download: () => new Uint8Array([9, 9]),
    })
    const client = new BridgeClient({ fetchImpl: impl })
    const value = await client.invoke('docs:open-path', 'a.docx')
    expect(value).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(value as ArrayBuffer)).toEqual(new Uint8Array([9, 9]))
  })

  it('does not wait for the result on send', async () => {
    const { impl, calls } = fakeFetch({ rpc: () => ({ ok: true, value: null }) })
    const client = new BridgeClient({ fetchImpl: impl })
    client.send('docs:close-check-result', 'ok')
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls[0]?.url).toBe('/rpc/docs%3Aclose-check-result')
  })

  it('subscribes to a channel and delivers events', async () => {
    const { impl } = fakeFetch({})
    const client = new BridgeClient({
      fetchImpl: impl,
      eventSourceFactory: (url) => new FakeEventSource(url) as unknown as EventSource,
    })
    const seen: unknown[] = []
    client.on('docs:opened', (_event, payload) => seen.push(payload))
    await vi.waitFor(() => expect(FakeEventSource.last).not.toBeNull())
    expect(FakeEventSource.last?.url).toContain('channels=docs%3Aopened')
    FakeEventSource.last?.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify({ channel: 'docs:opened', args: ['x'] }) }),
    )
    await vi.waitFor(() => expect(seen).toEqual(['x']))
  })

  it('reopens the stream when the channel set changes', async () => {
    const { impl } = fakeFetch({})
    const client = new BridgeClient({
      fetchImpl: impl,
      eventSourceFactory: (url) => new FakeEventSource(url) as unknown as EventSource,
    })
    const off = client.on('a', () => {})
    await vi.waitFor(() => expect(FakeEventSource.last).not.toBeNull())
    const first = FakeEventSource.last
    client.on('b', () => {})
    await vi.waitFor(() => expect(FakeEventSource.last).not.toBe(first))
    expect(first?.closed).toBe(true)
    off()
  })

  it('stops delivering after removeListener', async () => {
    const { impl } = fakeFetch({})
    const client = new BridgeClient({
      fetchImpl: impl,
      eventSourceFactory: (url) => new FakeEventSource(url) as unknown as EventSource,
    })
    const seen: unknown[] = []
    const listener = (_event: unknown, payload: unknown) => seen.push(payload)
    client.on('a', listener)
    client.removeListener('a', listener)
    await vi.waitFor(() => expect(FakeEventSource.last).not.toBeNull())
    FakeEventSource.last?.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify({ channel: 'a', args: ['x'] }) }),
    )
    await new Promise((done) => setTimeout(done, 10))
    expect(seen).toEqual([])
  })
})
