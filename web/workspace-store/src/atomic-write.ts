import { copyFile, open, rename, unlink, writeFile } from 'fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/**
 * Atomic write with a rescue copy, mirroring the upstream behaviour in
 * `packages/electron-utils/src/atomic-write.ts` (`atomicWriteFile`).
 *
 * The staging temp carries a random suffix — two writers of the same target
 * must not share it — but the rescue copy must not: a save that keeps failing
 * (the document is locked by another program, and an autosave retries every
 * 30s) would otherwise leave a new file beside the document on every attempt.
 */
const tempPathBeside = (filePath: string) =>
  join(dirname(filePath), `${basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`)

/** Where a failed save parks the new bytes: beside the target, one stable name. */
const rescuePathFor = (filePath: string) =>
  join(dirname(filePath), `${basename(filePath)}.unsaved.tmp`)

const RENAME_RETRY_DELAYS_MS = [10, 40, 160, 640]

function isRetryableRename(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EEXIST'
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function syncFileBestEffort(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r+')
    await handle.sync()
  } catch {
    /* fsync is best effort: some filesystems refuse it */
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function renameWithRetry(tmp: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, filePath)
      return
    } catch (error) {
      if (!isRetryableRename(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
      await sleep(RENAME_RETRY_DELAYS_MS[attempt] ?? 0)
    }
  }
}

/**
 * Park the new bytes beside the target, replacing the copy an earlier failed
 * attempt left. `copyFile` rather than `rename`, because the destination may
 * already exist and a rename onto an existing file is refused on Windows. It
 * stays in the kernel, so a multi-hundred-MB file is never read into RAM.
 */
async function keepRescueCopy(filePath: string, tmp: string): Promise<void> {
  const rescue = rescuePathFor(filePath)
  try {
    await copyFile(tmp, rescue)
    await syncFileBestEffort(rescue)
  } catch {
    /* the staging temp still holds the bytes */
    return
  }
  await unlink(tmp).catch(() => {})
}

/** The save landed: an earlier attempt's rescue copy is stale. */
async function clearRescueCopy(filePath: string): Promise<void> {
  await unlink(rescuePathFor(filePath)).catch(() => {})
}

/**
 * Same-dir temp file, best-effort fsync, then rename. Rename-over-existing
 * fails transiently on Windows (a scanner holds the file) and permanently on
 * some network mounts; either way the save falls back to an in-place write
 * rather than failing outright.
 */
export async function atomicWriteFile(filePath: string, data: Uint8Array): Promise<void> {
  const tmp = tempPathBeside(filePath)
  try {
    await writeFile(tmp, data)
    await syncFileBestEffort(tmp)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  try {
    await renameWithRetry(tmp, filePath)
    await clearRescueCopy(filePath)
    return
  } catch {
    /* fall through to the in-place write */
  }
  // Keep the completed temp until the fallback lands: if that write fails or
  // the process dies, the new bytes still exist somewhere on disk.
  try {
    await writeFile(filePath, data)
  } catch (error) {
    await keepRescueCopy(filePath, tmp)
    throw error
  }
  await unlink(tmp).catch(() => {})
  await clearRescueCopy(filePath)
}

/** The path a failed save parks the new bytes at. */
export function rescuePath(filePath: string): string {
  return rescuePathFor(filePath)
}
