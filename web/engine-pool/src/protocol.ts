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

/** A message from a worker: an answer, a pushed event, or a dialog. */
export type EngineMessage =
  | ({ kind: 'response' } & EngineResponse)
  | ({ kind: 'event' } & EngineEvent)
  | ({ kind: 'dialog' } & EngineDialog)

/**
 * A dialog the upstream code wants the browser to show.
 *
 * The desktop app opens a native dialog; the browser has none, so the
 * worker asks the browser and waits for the answer.
 */
export interface EngineDialog {
  /** The dialog's id; the answer comes back with it. */
  id: string
  /** Which kind of dialog it is. */
  dialogKind: 'save' | 'open' | 'message'
  /** The Electron options the upstream code passed. */
  options: unknown
  /** The tab that triggered it. */
  tabId: string
}
