import { stat as statAsync } from './fs-control-impl'
import type { Stats } from 'fs'

/**
 * The `node:fs` surface the upstream code runs against.
 *
 * Upstream's main process reads and writes the user's documents straight
 * through `node:fs`. The server may not: every path that reaches the disk
 * has to pass the workspace fence, or a caller could name a file outside
 * the workspace and have the server write it.
 *
 * So the worker build aliases `node:fs` to this module. The upstream code
 * is unmodified; only the functions it calls are different — the ones that
 * touch the user's documents resolve through the store, which enforces the
 * fence (symbolic links included) and writes atomically.
 *
 * Paths **outside** the workspace are the server's own business — the app
 * data directory, the autosave folder, temp files — and go to the real
 * filesystem. The fence is about the user's documents.
 *
 * The implementation lives in `fs-control-impl.ts`; this file is the
 * synchronous half of Node's `fs` surface, and `fs-control-promises.ts` is
 * the asynchronous one.
 */
export {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpath,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlink,
  symlinkSync,
  truncate,
  truncateSync,
  unlinkSync,
  unwatchFile,
  utimes,
  utimesSync,
  watch,
  watchFile,
  writeFileSync,
  writeSync,
} from './fs-control-impl'

/**
 * The callback-style `stat`.
 *
 * Node's `fs.stat` takes a callback; the store's surface is a promise, so
 * the answer is handed over the way the caller expects.
 */
export function stat(
  path: string,
  callback: (error: NodeJS.ErrnoException | null, stats?: Stats) => void,
): void {
  statAsync(path).then(
    (stats) => callback(null, stats as unknown as Stats),
    (error: unknown) => callback(error as NodeJS.ErrnoException),
  )
}
