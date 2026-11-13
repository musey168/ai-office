/**
 * The wire format between the browser-side bridge and the server.
 *
 * Electron's IPC uses the structured clone algorithm, which can carry
 * `ArrayBuffer` and typed arrays. JSON cannot. So binary arguments and
 * results travel as a **byte token**: the bytes are uploaded (or parked) on
 * the byte endpoint, and the JSON payload carries only the token.
 */

/** A binary value in a JSON payload. */
export interface ByteToken {
  __bytes: string
}

export function isByteToken(value: unknown): value is ByteToken {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { __bytes?: unknown }).__bytes === 'string'
  )
}

/** Request body of `POST /rpc/:channel`. */
export interface RpcRequest {
  args: unknown[]
  /**
   * Which page the call came from.
   *
   * Electron has `event.sender.id` — the id of the web contents that made
   * the call — and the main process uses it to hand a document to the right
   * window. The browser has no such id, so the page states which upstream
   * app it is and which tab it belongs to.
   */
  ctx?: RpcContext
  /** `ipcRenderer.send` semantics: the caller does not wait for a result. */
  fireAndForget?: boolean
}

/** Where a call came from. */
export interface RpcContext {
  /** The upstream app the calling page is: `shell`, `docs`, `sheets`, … */
  app?: string
  /** The tab the calling page belongs to (the shell's tab id). */
  tabId?: string
}

/** Response body of `POST /rpc/:channel`. */
export type RpcResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; detail?: unknown } }

/** Event payload pushed over `GET /events`. */
export interface RpcEvent {
  channel: string
  args: unknown[]
  id?: number
}

/** Server-side error codes the bridge itself produces. */
export const BRIDGE_ERROR_CODES = [
  'unknown_channel',
  'invalid_request',
  'invalid_arguments',
  'byte_token_invalid',
  'byte_token_expired',
  'too_many_arguments',
] as const

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number]

export class BridgeError extends Error {
  readonly code: string
  readonly detail: unknown

  constructor(code: string, message: string, detail?: unknown) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.detail = detail
  }
}

/** True for the binary types Electron's IPC can carry and JSON cannot. */
export function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

/** Normalize any binary value to a standalone `Uint8Array`. */
export function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

/**
 * Normalize binary to an `ArrayBuffer` — what the upstream preload promises
 * its renderer callers (for example `saveDocxTo(path, data: ArrayBuffer)`).
 */
export function toArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  const bytes = toBytes(value)
  return bytes.slice().buffer
}
