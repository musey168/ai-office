/** One entry in a directory listing. */
export interface Entry {
  /** File or directory name, without any path. */
  name: string
  /** Workspace-relative path with forward slashes. */
  path: string
  kind: 'file' | 'directory' | 'symlink'
  /** Size in bytes; 0 for directories. */
  size: number
  /** Last modification time, milliseconds since the epoch. */
  mtimeMs: number
}

/** Metadata of one file or directory. */
export interface FileMeta {
  /** Workspace-relative path with forward slashes. */
  path: string
  name: string
  /** Lowercased extension without the dot; empty when there is none. */
  ext: string
  size: number
  mtimeMs: number
  isFile: boolean
  isDirectory: boolean
}

/**
 * What the disk looked like at a moment in time. `hash` is the content
 * digest, computed only when mtime and size already disagree.
 */
export interface FileSnapshot {
  /** Workspace-relative path with forward slashes. */
  path: string
  mtimeMs: number
  size: number
  hash: string
}

/**
 * The storage layer's whole surface. Every path the web layer receives is
 * resolved through here, so this is the only place that touches the disk.
 */
export interface WorkspaceStore {
  /** Entries of a directory, sorted by name. */
  list(dirPath: string): Promise<Entry[]>
  /** The bytes of a file. */
  read(filePath: string): Promise<Uint8Array>
  /** Writes a file atomically, creating the parent directory when needed. */
  write(filePath: string, bytes: Uint8Array): Promise<void>
  /** Moves or renames a file; the destination must not exist. */
  move(srcPath: string, destPath: string): Promise<void>
  /** Removes a file. Directories are refused. */
  delete(filePath: string): Promise<void>
  /** Metadata of a file or directory. */
  stat(filePath: string): Promise<FileMeta>
  /** The disk state of a file, including its content digest. */
  snapshot(filePath: string): Promise<FileSnapshot>
  /**
   * True when the file on disk no longer matches the recorded state — another
   * program wrote it since we last read or saved it.
   */
  isExternallyModified(snapshot: FileSnapshot | undefined): Promise<boolean>
}
