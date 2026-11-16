/**
 * The wire format between the HTTP process and an engine worker.
 *
 * Kept in its own module so the pool's public surface does not pull the
 * upstream engine sources into a consumer's type check.
 */

export interface EngineRequest {
  id: number
  job: string
  args: unknown[]
}

export interface EngineResponse {
  id: number
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

/**
 * An event the engine pushed at a browser tab.
 *
 * The upstream main process pushes events at a renderer (`webContents.send`).
 * The engine worker does the same, so the events travel back the same way:
 * worker → pool → the HTTP process → the event stream → the browser.
 *
 * The tab id is part of the event because the upstream events are addressed
 * to one renderer, not to everybody listening.
 */
export interface EngineEvent {
  /** The tab the event is for. */
  tabId: string
  /** The channel the upstream code pushed. */
  channel: string
  /** The event's arguments. */
  args: unknown[]
}

/** A message from a worker: either an answer or a pushed event. */
export type EngineMessage =
  | ({ kind: 'response' } & EngineResponse)
  | ({ kind: 'event' } & EngineEvent)
