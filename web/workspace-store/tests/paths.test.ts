import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extensionOf, isInside, normalizeForCompare, realizedPath, toRelativePath } from '../src/paths'

let root: string

beforeEach(async () => {
  // macOS's temp dir sits behind a symlink (/var -> /private/var); realize it
  // so the expected paths match what realizedPath returns.
  root = realizedPath(await mkdtemp(join(tmpdir(), 'aio-paths-')))
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(root, { recursive: true, force: true })
})

describe('realizedPath', () => {
  it('resolves a path that exists', async () => {
    const file = join(root, 'a.txt')
    await writeFile(file, 'x')
    expect(realizedPath(file)).toBe(file)
  })

  it('resolves the nearest existing ancestor for a path that does not exist', async () => {
    const missing = join(root, 'deep', 'nested', 'file.txt')
    expect(realizedPath(missing)).toBe(join(realizedPath(root), 'deep', 'nested', 'file.txt'))
  })

  it('follows a symlink to where it really points', async () => {
    const target = join(root, 'target.txt')
    const link = join(root, 'link.txt')
    await writeFile(target, 'x')
    await symlink(target, link)
    expect(realizedPath(link)).toBe(target)
  })
})

describe('isInside', () => {
  it('accepts the root itself', () => {
    expect(isInside('/srv/work', '/srv/work')).toBe(true)
  })

  it('accepts a path under the root', () => {
    expect(isInside('/srv/work', '/srv/work/a/b.txt')).toBe(true)
  })

  it('accepts a name that merely starts with two dots', () => {
    expect(isInside('/srv/work', '/srv/work/..hidden')).toBe(true)
  })

  it('rejects a sibling with a shared prefix', () => {
    expect(isInside('/srv/work', '/srv/workbench')).toBe(false)
  })

  it('rejects a path above the root', () => {
    expect(isInside('/srv/work', '/srv')).toBe(false)
  })
})

describe('normalizeForCompare', () => {
  it('normalizes to NFC', () => {
    const composed = 'é'.normalize('NFC')
    const decomposed = 'é'.normalize('NFD')
    expect(normalizeForCompare(decomposed)).toBe(normalizeForCompare(composed))
  })
})

describe('toRelativePath', () => {
  it('returns a forward-slash path', () => {
    expect(toRelativePath('/srv/work', '/srv/work/a/b.txt')).toBe('a/b.txt')
  })
})

describe('extensionOf', () => {
  it('lowercases the extension', () => {
    expect(extensionOf('Report.DOCX')).toBe('docx')
  })

  it('returns empty for a dotfile', () => {
    expect(extensionOf('.gitignore')).toBe('')
  })

  it('returns empty when there is no extension', () => {
    expect(extensionOf('README')).toBe('')
  })
})

describe('directory fixtures', () => {
  it('creates a nested directory', async () => {
    await mkdir(join(root, 'a', 'b'), { recursive: true })
    expect(realizedPath(join(root, 'a', 'b'))).toBe(join(root, 'a', 'b'))
  })
})
