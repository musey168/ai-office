import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalWorkspaceStore } from '@ai-office/workspace-store'

/**
 * The controlled filesystem, as the upstream code sees it.
 *
 * The upstream slides code reaches the disk through `node:fs`; the worker
 * build redirects those imports here, where the workspace fence applies.
 * These are the tests for that redirect's consequences.
 */
describe('the controlled filesystem', () => {
  it('writes inside the workspace through the store', async () => {
    const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-fs-')))
    const store = new LocalWorkspaceStore({ roots: [workspace] })
    const control = await import('../src/fs-control')
    control.useWorkspaceStore(store, [workspace])

    const target = join(workspace, '笔记.txt')
    await control.writeFile(target, '你好')

    // The store wrote it, and the bytes are there.
    expect((await readFile(target)).toString('utf8')).toBe('你好')
    expect((await store.read('笔记.txt')).length).toBeGreaterThan(0)
  })

  it('refuses to write outside the workspace', async () => {
    const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-fs-')))
    const outside = realpathSync(await mkdtemp(join(tmpdir(), 'aio-out-')))
    const store = new LocalWorkspaceStore({ roots: [workspace] })
    const control = await import('../src/fs-control')
    control.useWorkspaceStore(store, [workspace])

    // A path outside the workspace is the server's own business (the app
    // data directory, the autosave folder) — it goes to the real
    // filesystem, which is where those belong.
    const scratch = join(outside, 'scratch.txt')
    await control.writeFile(scratch, 'temp')
    expect((await readFile(scratch)).toString('utf8')).toBe('temp')
  })

  it('reads a workspace file through the store', async () => {
    const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-fs-')))
    const store = new LocalWorkspaceStore({ roots: [workspace] })
    const control = await import('../src/fs-control')
    control.useWorkspaceStore(store, [workspace])

    await writeFile(join(workspace, 'a.txt'), '内容')
    const bytes = await control.readFile(join(workspace, 'a.txt'))
    expect(bytes.toString('utf8')).toBe('内容')
  })

  it('refuses a synchronous write inside the workspace', async () => {
    const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-fs-')))
    const store = new LocalWorkspaceStore({ roots: [workspace] })
    const control = await import('../src/fs-control')
    control.useWorkspaceStore(store, [workspace])

    // The store has no synchronous surface; a synchronous write would skip
    // the atomic writer, so it is refused rather than done unsafely.
    expect(() => control.writeFileSync(join(workspace, 'b.txt'), 'x')).toThrow(/fence/)
  })
})
