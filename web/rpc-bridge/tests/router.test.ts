import { describe, expect, it, vi } from 'vitest'
import { ChannelRouter } from '../src/server/router'
import { EventHub } from '../src/server/events'
import { BridgeError } from '../src/protocol'

function makeRouter() {
  const events = new EventHub()
  const router = new ChannelRouter({ events })
  return { router, events }
}

describe('ChannelRouter', () => {
  it('routes a channel to its handler', async () => {
    const { router } = makeRouter()
    router.register('docs:open-path', (_ctx, path) => `opened ${String(path)}`)
    expect(await router.invoke('docs:open-path', ['a.docx'])).toBe('opened a.docx')
  })

  it('passes every argument through', async () => {
    const { router } = makeRouter()
    const handler = vi.fn(() => 'ok')
    router.register('x:y', handler)
    await router.invoke('x:y', [1, 'two', { three: true }])
    expect(handler).toHaveBeenCalledWith(expect.anything(), 1, 'two', { three: true })
  })

  it('fails loudly on an unknown channel', async () => {
    const { router } = makeRouter()
    await expect(router.invoke('nope', [])).rejects.toBeInstanceOf(BridgeError)
    await expect(router.invoke('nope', [])).rejects.toMatchObject({ code: 'unknown_channel' })
  })

  it('reports a missing channel instead of throwing on send', async () => {
    const missing: string[] = []
    const router = new ChannelRouter({ onMissing: (channel) => missing.push(channel) })
    await router.send('nope', [])
    expect(missing).toEqual(['nope'])
  })

  it('turns a binary result into a byte token', async () => {
    const { router } = makeRouter()
    router.register('x:bytes', () => new Uint8Array([1, 2, 3]))
    const value = (await router.invoke('x:bytes', [])) as { __bytes: string }
    expect(typeof value.__bytes).toBe('string')
    expect(router.bytes.take(value.__bytes)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('resolves a byte token in the arguments', async () => {
    const { router } = makeRouter()
    let received: unknown
    router.register('x:save', (_ctx, bytes) => {
      received = bytes
      return 'ok'
    })
    const token = router.bytes.put(new Uint8Array([7, 8]))
    await router.invoke('x:save', [{ __bytes: token }])
    expect(received).toEqual(new Uint8Array([7, 8]))
  })

  it('refuses a byte token that was already used', async () => {
    const { router } = makeRouter()
    router.register('x:save', () => 'ok')
    const token = router.bytes.put(new Uint8Array([7]))
    router.bytes.take(token)
    await expect(router.invoke('x:save', [{ __bytes: token }])).rejects.toMatchObject({
      code: 'byte_token_invalid',
    })
  })

  it('encodes binaries nested in objects and arrays', async () => {
    const { router } = makeRouter()
    router.register('x:nested', () => ({ list: [new Uint8Array([1])] }))
    const value = (await router.invoke('x:nested', [])) as { list: { __bytes: string }[] }
    expect(typeof value.list[0]?.__bytes).toBe('string')
  })

  it('publishes events through the hub', async () => {
    const { router, events } = makeRouter()
    const seen: unknown[] = []
    events.subscribe(['x:ping'], (event) => seen.push(event))
    router.register('x:ping', (ctx) => {
      ctx.publish('x:ping', ['hello'])
      return 'done'
    })
    await router.invoke('x:ping', [])
    expect(seen).toEqual([{ channel: 'x:ping', args: ['hello'] }])
  })

  it('lists the registered channels', () => {
    const { router } = makeRouter()
    router.registerAll({ 'b:x': () => 1, 'a:y': () => 2 })
    expect(router.channels).toEqual(['a:y', 'b:x'])
    expect(router.has('a:y')).toBe(true)
    expect(router.has('zzz')).toBe(false)
  })
})

describe('EventHub', () => {
  it('delivers only to subscribers of that channel', () => {
    const events = new EventHub()
    const mine: unknown[] = []
    const other: unknown[] = []
    events.subscribe(['a'], (event) => mine.push(event))
    events.subscribe(['b'], (event) => other.push(event))
    events.publish('a', [1])
    expect(mine).toHaveLength(1)
    expect(other).toHaveLength(0)
  })

  it('stops delivering after unsubscribing', () => {
    const events = new EventHub()
    const seen: unknown[] = []
    const off = events.subscribe(['a'], (event) => seen.push(event))
    events.publish('a', [1])
    off()
    events.publish('a', [2])
    expect(seen).toHaveLength(1)
  })
})
