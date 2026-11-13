import { BridgeClient } from './client'
import { EditorHost, pageContext } from './host'

/**
 * The browser-side stand-in for the parts of Electron the upstream preload
 * scripts import: `contextBridge`, `ipcRenderer`, `webUtils`, `webFrame`.
 *
 * The upstream preload sources are compiled as-is with `electron` aliased to
 * this module, so the channel contract — every name, every argument shape,
 * every return shape — comes from upstream rather than from a second copy
 * written here.
 */

const client = new BridgeClient({ context: () => pageContext(window.location) })

type Listener = (event: unknown, ...args: unknown[]) => void

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    ;(globalThis as unknown as Record<string, unknown>)[key] = api
  },
}

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return client.invoke(channel, ...args)
  },
  send(channel: string, ...args: unknown[]): void {
    client.send(channel, ...args)
  },
  on(channel: string, listener: Listener): () => void {
    return client.on(channel, listener)
  },
  once(channel: string, listener: Listener): () => void {
    let off = () => {}
    off = client.on(channel, (...args) => {
      off()
      listener(...args)
    })
    return off
  },
  removeListener(channel: string, listener: Listener): void {
    client.removeListener(channel, listener)
  },
}

/**
 * Electron can hand a `File` a path on disk. A browser cannot — the file has
 * to be uploaded instead. This is one of the native-capability gaps the
 * architecture document records; the stub answers honestly instead of
 * pretending it worked.
 */
export const webUtils = {
  getPathForFile(_file: File): string {
    console.warn(
      '[rpc-bridge] webUtils.getPathForFile has no browser equivalent: the file must be uploaded instead',
    )
    return ''
  },
}

/** Spells exist only in the Electron renderer; the browser has none. */
export const webFrame = {
  isWordMisspelled(_text: string): boolean {
    return false
  },
}

/**
 * The shell page hosts the editors. Upstream does that with native
 * `WebContentsView`s painted above the shell's DOM; a browser needs an
 * iframe, and the shell renderer — which knows nothing about the editors —
 * stays untouched.
 */
if (typeof window !== 'undefined' && pageContext(window.location).app === 'shell') {
  void new EditorHost(client).start()
}
