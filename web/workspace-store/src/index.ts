export { LocalWorkspaceStore, type LocalWorkspaceStoreOptions } from './local-store'
export { Fence } from './fence'
export { WorkspaceError, WORKSPACE_ERROR_CODES, isWorkspaceError, type WorkspaceErrorCode } from './errors'
export {
  extensionOf,
  isInside,
  normalizeForCompare,
  realizedPath,
  toRelativePath,
} from './paths'
export { atomicWriteFile, rescuePath } from './atomic-write'
export type { Entry, FileMeta, FileSnapshot, WorkspaceStore } from './types'
