import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteFile, rescuePath } from '../src/atomic-write'
import { realizedPath } from '../src/paths'

let dir: string

beforeEach(async () => {
  dir = realizedPath(await mkdtemp(join(tmpdir(), 'aio-atomic-')))
})

afterEach(async () => {
  const { rm, chmod } = await import('node:fs/promises')
  await chmod(dir, 0o755).catch(() => {})
  await rm(dir, { recursive: true, force: true })
})

describe('atomicWriteFile', () => {
  it('writes the file', async () => {
    const target = join(dir, 'a.txt')
    await atomicWriteFile(target, new TextEncoder().encode('hello'))
    expect(await readFile(target, 'utf8')).toBe('hello')
  })

  it('leaves no staging temp behind', async () => {
    const target = join(dir, 'a.txt')
    await atomicWriteFile(target, new Uint8Array([1, 2, 3]))
    const names = await readdir(dir)
    expect(names).toEqual(['a.txt'])
  })

  it('replaces an existing file', async () => {
    const target = join(dir, 'a.txt')
    await writeFile(target, 'old')
    await atomicWriteFile(target, new TextEncoder().encode('new'))
    expect(await readFile(target, 'utf8')).toBe('new')
  })

  it('clears a stale rescue copy after a successful save', async () => {
    const target = join(dir, 'a.txt')
    await writeFile(rescuePath(target), 'stale')
    await atomicWriteFile(target, new TextEncoder().encode('fresh'))
    expect(await readFile(target, 'utf8')).toBe('fresh')
    await expect(stat(rescuePath(target))).rejects.toThrow()
  })

  it('parks the new bytes in a rescue copy when the save cannot land', async () => {
    // A directory in the target's place: the staging write succeeds, but
    // both the rename and the in-place write fail, which is the branch that
    // parks the bytes in a rescue copy.
    const target = join(dir, 'blocked')
    await mkdir(target, { recursive: true })
    await expect(atomicWriteFile(target, new TextEncoder().encode('bytes'))).rejects.toThrow()
    expect(await readFile(rescuePath(target), 'utf8')).toBe('bytes')
  })
})
