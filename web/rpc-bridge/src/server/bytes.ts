import { randomUUID } from 'node:crypto'

export interface ByteStoreOptions {
  /** How long a parked byte payload stays readable. Defaults to 5 minutes. */
  ttlMs?: number
  /** Largest single payload. Defaults to 256 MB. */
  maxItemBytes?: number
  /** Largest total of all parked payloads. Defaults to 1 GB. */
  maxTotalBytes?: number
}

interface Entry {
  bytes: Uint8Array
  expiresAt: number
}

/**
 * Holds byte payloads that are too large to travel inside JSON.
 *
 * A token is handed to the JSON payload instead of the bytes; the peer then
 * fetches (or has already uploaded) them at the byte endpoint. Tokens are
 * single-use — once consumed, the bytes are gone — and expire on their own.
 */
export class ByteStore {
  private readonly entries = new Map<string, Entry>()
  private readonly ttlMs: number
  private readonly maxItemBytes: number
  private readonly maxTotalBytes: number
  private totalBytes = 0

  constructor(options: ByteStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000
    this.maxItemBytes = options.maxItemBytes ?? 256 * 1024 * 1024
    this.maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024
  }

  /** Park bytes and return the token that stands for them. */
  put(bytes: Uint8Array): string {
    this.sweep()
    if (bytes.byteLength > this.maxItemBytes) {
      throw new Error(`the payload is larger than the ${this.maxItemBytes} byte limit`)
    }
    if (this.totalBytes + bytes.byteLength > this.maxTotalBytes) {
      throw new Error('the byte store is full')
    }
    const token = randomUUID()
    this.entries.set(token, { bytes, expiresAt: Date.now() + this.ttlMs })
    this.totalBytes += bytes.byteLength
    return token
  }

  /** Read without consuming. */
  peek(token: string): Uint8Array | undefined {
    this.sweep()
    return this.entries.get(token)?.bytes
  }

  /** Read and consume — the token dies with it. */
  take(token: string): Uint8Array | undefined {
    this.sweep()
    const entry = this.entries.get(token)
    if (!entry) return undefined
    this.entries.delete(token)
    this.totalBytes -= entry.bytes.byteLength
    return entry.bytes
  }

  /** Drop expired payloads. */
  sweep(now = Date.now()): void {
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(token)
        this.totalBytes -= entry.bytes.byteLength
      }
    }
  }

  get size(): number {
    return this.entries.size
  }

  get bytes(): number {
    return this.totalBytes
  }
}
