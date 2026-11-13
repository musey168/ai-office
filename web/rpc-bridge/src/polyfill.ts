/**
 * Polyfills for the browser APIs the upstream renderer expects, which the
 * browsers only expose in a **secure context** (HTTPS, or localhost).
 *
 * The test deployment serves plain HTTP on the LAN, where `crypto.randomUUID`
 * is missing — the upstream document renderer calls it while opening a
 * document, and the page dies with "crypto.randomUUID is not a function".
 *
 * The polyfill runs from the bridge, which the server injects before the
 * renderer's own script, so the application never sees the gap.
 */

interface CryptoWithRandomUuid {
  randomUUID?: () => `${string}-${string}-${string}-${string}-${string}`
  getRandomValues?<T extends ArrayBufferView>(array: T): T
}

/** A version 4 UUID, built the way the platform builds one. */
function randomUuid(): `${string}-${string}-${string}-${string}-${string}` {
  const source = globalThis.crypto as CryptoWithRandomUuid | undefined
  const bytes = new Uint8Array(16)
  if (typeof source?.getRandomValues === 'function') {
    source.getRandomValues(bytes)
  } else {
    // The last resort: the clock is not random, but it is unique enough to
    // keep a document's ids apart.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`
}

export function installSecureContextPolyfills(): void {
  const source = globalThis.crypto as CryptoWithRandomUuid | undefined
  if (source && typeof source.randomUUID !== 'function') {
    try {
      source.randomUUID = randomUuid
    } catch {
      // A frozen crypto object cannot be patched — the caller will report it.
    }
  }

  // The clipboard is secure-context-only too. The fallback is the old
  // command-based copy, which still works on plain HTTP.
  const nav = globalThis.navigator as Navigator & {
    clipboard?: Clipboard
  }
  if (nav && !nav.clipboard && typeof document !== 'undefined') {
    try {
      Object.defineProperty(nav, 'clipboard', {
        configurable: true,
        value: {
          async writeText(text: string): Promise<void> {
            const area = document.createElement('textarea')
            area.value = text
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            area.remove()
          },
          async readText(): Promise<string> {
            return ''
          },
        },
      })
    } catch {
      // Not patchable — the clipboard stays unavailable.
    }
  }
}
