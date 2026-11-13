import { mkdtemp, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceError } from '../src/errors'
import { LocalWorkspaceStore } from '../src/local-store'
import { realizedPath } from '../src/paths'

let base: string
let workspace: string
let outside: string
let store: LocalWorkspaceStore

beforeEach(async () => {
  base = realizedPath(await mkdtemp(join(tmpdir(), 'aio-store-')))
  workspace = join(base, 'workspace')
  outside = join(base, 'outside')
  await mkdir(join(workspace, 'docs'), { recursive: true })
  await mkdir(outside, { recursive: true })
  store = new LocalWorkspaceStore({ roots: [workspace] })
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(base, { recursive: true, force: true })
})

describe('list', () => {
  it('lists a directory sorted by name', async () => {
    await writeFile(join(workspace, 'b.txt'), 'b')
    await writeFile(join(workspace, 'a.txt'), 'a')
    const entries = await store.list('')
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt', 'docs'])
    expect(entries.map((entry) => entry.kind)).toEqual(['file', 'file', 'directory'])
  })

  it('returns workspace-relative paths', async () => {
    await writeFile(join(workspace, 'docs', 'a.txt'), 'a')
    const entries = await store.list('docs')
    expect(entries[0]?.path).toBe('docs/a.txt')
  })

  it('reports a missing directory', async () => {
    await expect(store.list('nope')).rejects.toThrow(WorkspaceError)
    await expect(store.list('nope')).rejects.toMatchObject({ code: 'file_not_found' })
  })

  it('reports a file used as a directory', async () => {
    await writeFile(join(workspace, 'a.txt'), 'a')
    await expect(store.list('a.txt')).rejects.toMatchObject({ code: 'not_a_directory' })
  })
})

describe('read', () => {
  it('reads the bytes of a file', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello')
    const bytes = await store.read('a.txt')
    expect(new TextDecoder().decode(bytes)).toBe('hello')
  })

  it('reports a missing file', async () => {
    await expect(store.read('nope.txt')).rejects.toMatchObject({ code: 'file_not_found' })
  })

  it('refuses a path outside the workspace', async () => {
    await writeFile(join(outside, 'secret.txt'), 'top secret')
    await expect(store.read('../outside/secret.txt')).rejects.toMatchObject({
      code: 'outside_allowed_roots',
    })
  })

  it('refuses a symlink that points out of the workspace', async () => {
    await writeFile(join(outside, 'secret.txt'), 'top secret')
    await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'))
    await expect(store.read('link.txt')).rejects.toMatchObject({
      code: 'outside_allowed_roots',
    })
  })
})

describe('write', () => {
  it('writes a new file', async () => {
    await store.write('a.txt', new TextEncoder().encode('hello'))
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('hello')
  })

  it('creates the parent directory', async () => {
    await store.write('deep/nested/a.txt', new TextEncoder().encode('hello'))
    expect(await readFile(join(workspace, 'deep', 'nested', 'a.txt'), 'utf8')).toBe('hello')
  })

  it('leaves no temp file behind', async () => {
    await store.write('a.txt', new TextEncoder().encode('hello'))
    const names = await readdir(workspace)
    expect(names).toContain('a.txt')
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses to write outside the workspace', async () => {
    await expect(store.write('../outside/a.txt', new Uint8Array([1]))).rejects.toMatchObject({
      code: 'outside_allowed_roots',
    })
  })

  it('refuses a file larger than the limit', async () => {
    const small = new LocalWorkspaceStore({ roots: [workspace], maxBytes: 4 })
    await expect(small.write('a.txt', new Uint8Array(8))).rejects.toMatchObject({
      code: 'resource_limit',
    })
  })
})

describe('move', () => {
  it('renames a file', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello')
    await store.move('a.txt', 'b.txt')
    expect(await readFile(join(workspace, 'b.txt'), 'utf8')).toBe('hello')
    await expect(stat(join(workspace, 'a.txt'))).rejects.toThrow()
  })

  it('refuses to overwrite an existing file', async () => {
    await writeFile(join(workspace, 'a.txt'), 'a')
    await writeFile(join(workspace, 'b.txt'), 'b')
    await expect(store.move('a.txt', 'b.txt')).rejects.toMatchObject({ code: 'output_exists' })
  })

  it('refuses to move a file out of the workspace', async () => {
    await writeFile(join(workspace, 'a.txt'), 'a')
    await expect(store.move('a.txt', '../outside/a.txt')).rejects.toMatchObject({
      code: 'outside_allowed_roots',
    })
  })
})

describe('delete', () => {
  it('removes a file', async () => {
    await writeFile(join(workspace, 'a.txt'), 'a')
    await store.delete('a.txt')
    await expect(stat(join(workspace, 'a.txt'))).rejects.toThrow()
  })

  it('refuses to delete a directory', async () => {
    await expect(store.delete('docs')).rejects.toMatchObject({ code: 'not_a_file' })
  })

  it('reports a missing file', async () => {
    await expect(store.delete('nope.txt')).rejects.toMatchObject({ code: 'file_not_found' })
  })
})

describe('stat', () => {
  it('describes a file', async () => {
    await writeFile(join(workspace, 'Report.DOCX'), 'hello')
    const meta = await store.stat('Report.DOCX')
    expect(meta).toMatchObject({
      path: 'Report.DOCX',
      name: 'Report.DOCX',
      ext: 'docx',
      size: 5,
      isFile: true,
      isDirectory: false,
    })
  })

  it('reports a missing file', async () => {
    await expect(store.stat('nope.txt')).rejects.toMatchObject({ code: 'file_not_found' })
  })
})

describe('snapshot and external modification', () => {
  it('sees no change when nothing touched the file', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello')
    const snapshot = await store.snapshot('a.txt')
    expect(await store.isExternallyModified(snapshot)).toBe(false)
  })

  it('sees a change when another program rewrote the file', async () => {
    const target = join(workspace, 'a.txt')
    await writeFile(target, 'hello')
    const snapshot = await store.snapshot('a.txt')
    await new Promise((done) => setTimeout(done, 10))
    await writeFile(target, 'goodbye, and more bytes')
    expect(await store.isExternallyModified(snapshot)).toBe(true)
  })

  it('sees no conflict when the file was deleted', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello')
    const snapshot = await store.snapshot('a.txt')
    const { rm } = await import('node:fs/promises')
    await rm(join(workspace, 'a.txt'))
    expect(await store.isExternallyModified(snapshot)).toBe(false)
  })

  it('sees no conflict without a record', async () => {
    expect(await store.isExternallyModified(undefined)).toBe(false)
  })
})
