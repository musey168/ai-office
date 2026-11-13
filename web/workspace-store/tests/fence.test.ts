import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceError } from '../src/errors'
import { Fence } from '../src/fence'
import { realizedPath } from '../src/paths'

let base: string
let workspace: string
let outside: string

beforeEach(async () => {
  base = realizedPath(await mkdtemp(join(tmpdir(), 'aio-fence-')))
  workspace = join(base, 'workspace')
  outside = join(base, 'outside')
  await mkdir(workspace, { recursive: true })
  await mkdir(outside, { recursive: true })
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(base, { recursive: true, force: true })
})

describe('Fence construction', () => {
  it('refuses to exist without a root', () => {
    expect(() => new Fence([])).toThrow(WorkspaceError)
    expect(() => new Fence(['   '])).toThrow(/no workspace root is configured/)
  })

  it('exposes the primary root', () => {
    expect(new Fence([workspace]).primaryRoot).toBe(workspace)
  })
})

describe('resolvePath', () => {
  const fence = () => new Fence([workspace])

  it('resolves a relative path against the primary root', () => {
    expect(fence().resolvePath('a/b.txt')).toBe(join(workspace, 'a', 'b.txt'))
  })

  it('treats an empty path as the workspace root', () => {
    expect(fence().resolvePath('')).toBe(workspace)
  })

  it('rejects a NUL byte in the path', () => {
    expect(() => fence().resolvePath('a\0b')).toThrow(/NUL byte/)
  })

  it('rejects a path that climbs out of the workspace', () => {
    expect(() => fence().resolvePath('../outside/secret.txt')).toThrow(WorkspaceError)
    try {
      fence().resolvePath('../outside/secret.txt')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('outside_allowed_roots')
    }
  })

  it('rejects an absolute path outside the workspace', () => {
    expect(() => fence().resolvePath(join(outside, 'secret.txt'))).toThrow(WorkspaceError)
  })

  it('accepts an absolute path inside the workspace', () => {
    const abs = join(workspace, 'ok.txt')
    expect(fence().resolvePath(abs)).toBe(abs)
  })

  it('rejects a symlink that points out of the workspace', async () => {
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, 'top secret')
    await symlink(secret, join(workspace, 'link.txt'))
    expect(() => fence().resolvePath('link.txt')).toThrow(WorkspaceError)
  })

  it('allows a symlink that stays inside the workspace', async () => {
    await writeFile(join(workspace, 'real.txt'), 'ok')
    await symlink(join(workspace, 'real.txt'), join(workspace, 'link.txt'))
    // The path is kept as given (like the upstream fence does); the
    // containment check resolves the link to decide.
    expect(fence().resolvePath('link.txt')).toBe(join(workspace, 'link.txt'))
  })
})

describe('assertInside', () => {
  it('accepts a path under a root', () => {
    expect(() => new Fence([workspace]).assertInside(join(workspace, 'a.txt'))).not.toThrow()
  })

  it('rejects a path outside every root', () => {
    expect(() => new Fence([workspace]).assertInside(join(outside, 'a.txt'))).toThrow(
      /outside the workspace/,
    )
  })

  it('accepts a path under any configured root', () => {
    const fence = new Fence([workspace, outside])
    expect(() => fence.assertInside(join(outside, 'a.txt'))).not.toThrow()
  })
})
