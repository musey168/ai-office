import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalWorkspaceStore } from '@ai-office/workspace-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChannelRouter } from '../src/server/router'
import { createDocsChannels } from '../src/server/channels/docs'
import { createHomeChannels, createPendingOpens } from '../src/server/channels/home'
import { createTabChannels } from '../src/server/channels/tabs'
import { TabRegistry } from '../src/server/tabs'

let root: string
let store: LocalWorkspaceStore
let router: ChannelRouter
let pending: ReturnType<typeof createPendingOpens>
let tabs: TabRegistry

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
  tabs = new TabRegistry()
  router = new ChannelRouter()
  router.registerAll(
    createTabChannels({ tabs, publish: (channel, args) => router.events.publish(channel, args) }),
  )
  router.registerAll(createHomeChannels({ store, tabs, pending }))
  router.registerAll(createDocsChannels({ store, bytes: router.bytes, tabs, pending }))
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
    // upstream's TREE_FILE_EXTENSIONS lists txt and json too
    expect(listing.files.map((file) => file.name).sort()).toEqual(['a.docx', 'notes.txt'])
    expect(listing.files.find((file) => file.name === 'a.docx')?.ext).toBe('docx')
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
  it('opens a tab and hands the document to the page in that tab', async () => {
    await router.invoke('home:open-path', [join(root, 'reports', 'q3.docx')])
    const list = (await router.invoke('tabs:list', [])) as { id: string; kind: string; active: boolean }[]
    const tab = list.find((entry) => entry.active)
    expect(tab?.kind).toBe('docs')
    const result = (await router.invoke('docs:consume-pending-open', [], { tabId: tab?.id })) as {
      name: string
    } | null
    expect(result?.name).toBe('q3.docx')
  })

  it('opens the same file only once', async () => {
    await router.invoke('home:open-path', [join(root, 'a.docx')])
    await router.invoke('home:open-path', [join(root, 'a.docx')])
    const list = (await router.invoke('tabs:list', [])) as unknown[]
    // the home tab plus one document tab
    expect(list).toHaveLength(2)
  })
})

describe('the channels the shell needs to boot', () => {
  it('answers the language — without it the shell never renders', async () => {
    expect(await router.invoke('home:get-language', [])).toBe('zh')
  })

  it('answers the theme and the onboarding state', async () => {
    expect(await router.invoke('home:get-theme', [])).toBe('system')
    expect(await router.invoke('home:onboarding-seen', [])).toBe(true)
  })

  it('reports the account state under upstream\'s field name', async () => {
    const status = (await router.invoke('home:account-status', [])) as { loggedIn?: boolean }
    expect(status.loggedIn).toBe(false)
  })

  it('says the native file dialog does not exist', async () => {
    await expect(router.invoke('home:browse', [])).rejects.toMatchObject({
      code: 'not_available',
    })
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

  it('refuses to overwrite a file that changed behind the editor\'s back', async () => {
    const path = join(root, 'a.docx')
    await router.invoke('docs:open-path', [path])
    // somebody else writes the file
    await writeFile(path, 'changed by someone else')
    const result = (await router.invoke('docs:save', [path, new Uint8Array([9]).buffer, false])) as {
      ok: boolean
      reason?: string
    }
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('external-modified')
  })
})

describe('unknown channels', () => {
  it('fails loudly instead of answering undefined', async () => {
    await expect(router.invoke('docs:not-implemented', [])).rejects.toMatchObject({
      code: 'unknown_channel',
    })
  })
})
