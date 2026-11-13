/**
 * The error vocabulary the storage layer reports. The web layer maps these
 * codes to user-facing text; the codes themselves are the contract.
 *
 * The naming follows the upstream CLI's `reason` vocabulary
 * (`packages/cli/src/result.ts`) so the two layers speak one language.
 */
export const WORKSPACE_ERROR_CODES = [
  'outside_allowed_roots',
  'file_not_found',
  'not_a_file',
  'not_a_directory',
  'permission_denied',
  'invalid_argument',
  'output_exists',
  'resource_limit',
  'io_error',
] as const

export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number]

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode
  readonly detail: Record<string, unknown> | undefined

  constructor(code: WorkspaceErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
    this.detail = detail
  }
}

export function isWorkspaceError(error: unknown): error is WorkspaceError {
  return error instanceof WorkspaceError
}
