/**
 * The `node:fs/promises` surface the upstream code runs against.
 *
 * The same fence as `fs-control.ts`, for the asynchronous half of Node's
 * filesystem API.
 */
export {
  readFile,
  stat,
  lstat,
  open,
  readdir,
  realpath,
  unlink,
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  copyFile,
  rename,
  access,
  chmod,
} from './fs-control-impl'
