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
