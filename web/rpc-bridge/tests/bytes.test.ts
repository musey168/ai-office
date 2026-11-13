import { describe, expect, it } from 'vitest'
import { ByteStore } from '../src/server/bytes'
import { BridgeError } from '../src/protocol'

describe('ByteStore', () => {
  it('parks bytes behind a token', () => {
    const store = new ByteStore()
    const token = store.put(new Uint8Array([1, 2, 3]))
    expect(store.peek(token)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('consumes a token once', () => {
    const store = new ByteStore()
    const token = store.put(new Uint8Array([1]))
    expect(store.take(token)).toBeDefined()
    expect(store.take(token)).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('expires a token', () => {
    const store = new ByteStore({ ttlMs: 10 })
    const token = store.put(new Uint8Array([1]))
    store.sweep(Date.now() + 1000)
    expect(store.take(token)).toBeUndefined()
  })

  it('refuses a payload larger than the limit', () => {
    const store = new ByteStore({ maxItemBytes: 4 })
    expect(() => store.put(new Uint8Array(8))).toThrow(/larger than/)
  })

  it('refuses to exceed the total limit', () => {
    const store = new ByteStore({ maxTotalBytes: 8, maxItemBytes: 8 })
    store.put(new Uint8Array(8))
    expect(() => store.put(new Uint8Array(1))).toThrow(/full/)
  })

  it('counts the parked bytes', () => {
    const store = new ByteStore()
    store.put(new Uint8Array(10))
    expect(store.bytes).toBe(10)
  })
})

describe('BridgeError', () => {
  it('carries a code', () => {
    const error = new BridgeError('unknown_channel', 'nope')
    expect(error.code).toBe('unknown_channel')
    expect(error.name).toBe('BridgeError')
  })
})
