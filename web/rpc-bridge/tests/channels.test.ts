import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalWorkspaceStore } from '@ai-office/workspace-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChannelRouter } from '../src/server/router'
import { createDocsChannels } from '../src/server/channels/docs'
import { createHomeChannels, createPendingOpens } from '../src/server/channels/home'

let root: string
let store: LocalWorkspaceStore
let router: ChannelRouter
let pending: ReturnType<typeof createPendingOpens>

beforeEach(async () => {
  // macOS's temp dir sits behind a symlink; realize it so the paths the store
  // reports match what the test expects.
  const { realpathSync } = await import('node:fs')
  root = realpathSync(await mkdtemp(join(tmpdir(), 'aio-bridge-')))
  await mkdir(join(root, 'reports'), { recursive: true })
  await writeFile(join(root, 'a.docx'), 'docx bytes')
  await writeFile(join(root, 'notes.txt'), 'not a document')
  await writeFile(join(root, 'reports', 'q3.docx'), 'q3 bytes')
  store = new LocalWorkspaceStore({ roots: [root] })
  pending = createPendingOpens()
  router = new ChannelRouter()
  router.registerAll(createHomeChannels({ store, pending }))
  router.registerAll(createDocsChannels({ store, bytes: router.bytes, pending }))
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(root, { recursive: true, force: true })
})

describe('home:folder-roots', () => {
  it('returns the workspace root', async () => {
    const roots = (await router.invoke('home:folder-roots', [])) as { path: string }[]
    expect(roots[0]?.path).toBe(root)
  })
})

describe('home:folder-list', () => {
  it('separates folders from document files', async () => {
    const listing = (await router.invoke('home:folder-list', [root])) as {
      folders: { name: string }[]
      files: { name: string; ext: string; sizeBytes: number }[]
    }
    expect(listing.folders.map((folder) => folder.name)).toEqual(['reports'])
    expect(listing.files.map((file) => file.name)).toEqual(['a.docx'])
    expect(listing.files[0]?.ext).toBe('docx')
  })

  it('marks a missing directory instead of failing', async () => {
    const listing = (await router.invoke('home:folder-list', [join(root, 'nope')])) as {
      missing?: boolean
    }
    expect(listing.missing).toBe(true)
  })
})

describe('home:folder-create', () => {
  it('creates a folder inside the tree', async () => {
    const result = (await router.invoke('home:folder-create', [root, 'fresh'])) as {
      ok: boolean
      path?: string
    }
    expect(result.ok).toBe(true)
    const listing = (await router.invoke('home:folder-list', [root])) as {
      folders: { name: string }[]
    }
    expect(listing.folders.map((folder) => folder.name)).toContain('fresh')
  })

  it('refuses to create a folder outside the workspace', async () => {
    const result = (await router.invoke('home:folder-create', [root, '../escape'])) as {
      ok: boolean
    }
    expect(result.ok).toBe(false)
  })
})

describe('docs:open-path', () => {
  it('returns a one-time media URL instead of the bytes', async () => {
    const result = (await router.invoke('docs:open-path', [join(root, 'a.docx')])) as {
      path: string
      name: string
      dataUrl: string
      hash: string
    }
    expect(result.name).toBe('a.docx')
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.dataUrl).toMatch(/^\/media\//)
  })

  it('serves the bytes behind that URL exactly once', async () => {
    const result = (await router.invoke('docs:open-path', [join(root, 'a.docx')])) as {
      dataUrl: string
    }
    const token = result.dataUrl.split('/').pop()!
    expect(router.bytes.take(token)).toBeDefined()
    expect(router.bytes.take(token)).toBeUndefined()
  })

  it('fails for a file outside the workspace', async () => {
    await expect(router.invoke('docs:open-path', ['/etc/passwd'])).rejects.toMatchObject({
      code: 'outside_allowed_roots',
    })
  })
})

describe('home:open-path and docs:consume-pending-open', () => {
  it('hands the document to the next docs page', async () => {
    await router.invoke('home:open-path', [join(root, 'reports', 'q3.docx')])
    const result = (await router.invoke('docs:consume-pending-open', [])) as { name: string } | null
    expect(result?.name).toBe('q3.docx')
  })

  it('consumes the pending document only once', async () => {
    await router.invoke('home:open-path', [join(root, 'a.docx')])
    await router.invoke('docs:consume-pending-open', [])
    expect(await router.invoke('docs:consume-pending-open', [])).toBeNull()
  })
})

describe('docs:save', () => {
  it('writes the document back to its path', async () => {
    const result = (await router.invoke('docs:save', [
      join(root, 'a.docx'),
      new Uint8Array([1, 2, 3]).buffer,
      false,
    ])) as { ok: boolean; path?: string }
    expect(result.ok).toBe(true)
    const written = await store.read('a.docx')
    expect(new Uint8Array(written)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('refuses to write outside the workspace', async () => {
    const result = (await router.invoke('docs:save', [
      '/tmp/escape.docx',
      new Uint8Array([1]).buffer,
      false,
    ])) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/outside the workspace/)
  })
})

describe('unknown channels', () => {
  it('fails loudly instead of answering undefined', async () => {
    await expect(router.invoke('docs:not-implemented', [])).rejects.toMatchObject({
      code: 'unknown_channel',
    })
  })
})
