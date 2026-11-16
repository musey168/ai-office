import { existsSync } from 'node:fs'
import { copyFile, mkdtemp } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EnginePool, WORKER_PATH } from '../src/pool'

/**
 * The engine pool runs the upstream format engines off the HTTP event loop.
 *
 * The worker is a build artifact (`npm run build:worker`), so the tests that
 * need it are skipped when it is not built — the build itself is checked
 * separately.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const FIXTURE = join(repoRoot, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx')

describe('EnginePool', () => {
  it('says what to do when the worker is not built', () => {
    expect(
      () =>
        new EnginePool({
          workspaceRoots: ['/tmp'],
          workerPath: join('/tmp', 'no-such-worker.mjs'),
        }),
    ).toThrow(/build:worker/)
  })

  it('refuses to start without a workspace', () => {
    expect(() => new EnginePool({ workspaceRoots: [] })).toThrow(/workspace/i)
  })
})

const workerBuilt = existsSync(WORKER_PATH)

describe.skipIf(!workerBuilt)('The upstream document applications', () => {
  it('register their handlers in the worker', async () => {
    const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-docs-')))
    const pool = new EnginePool({ workspaceRoots: [workspace], size: 1 })
    try {
      const listed = (await pool.run<{ channels: string[]; errors: string[] }>('document:channels')) ?? {
        channels: [],
        errors: [],
      }
      const channels = listed.channels
      // The upstream main processes register their own surface; the server
      // does not write a second one.
      expect(channels).toContain('markdown:save')
      expect(channels).toContain('html:save')
      expect(channels).toContain('pdf:save')
    } finally {
      await pool.close()
    }
  })
})

describe.skipIf(!workerBuilt)('EnginePool (with the built worker)', () => {
  it('parses a presentation and hands back the render tree', async () => {
    const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-pool-')))
    const deck = join(workspace, 'deck.pptx')
    await copyFile(FIXTURE, deck)

    const pool = new EnginePool({ workspaceRoots: [workspace], size: 1 })
    try {
      // The deck is opened by the upstream handler — the server is the main
      // process, and the upstream main process owns the deck.
      const result = (await pool.run('slides:invoke', [
        'slides:open-path',
        [deck, 1280],
        'tab-1',
      ])) as {
        path: string
        slides: unknown[]
        size: { cx: number; cy: number }
        defaultFont?: string
      }
      expect(result.path).toBe(deck)
      expect(result.slides.length).toBeGreaterThan(0)
      expect(result.size.cx).toBeGreaterThan(0)
      expect(result.defaultFont).toBeTruthy()
    } finally {
      await pool.close()
    }
  })

  it('serves the upstream slides channels', async () => {
    const pool = new EnginePool({ workspaceRoots: ['/tmp'], size: 1 })
    try {
      const channels = (await pool.run('slides:channels')) as string[]
      // The upstream main process registers its editing surface here; the
      // web port serves the same names, so the upstream renderer works
      // unchanged.
      expect(channels).toContain('slides:edit-text')
      expect(channels).toContain('slides:undo')
      expect(channels).toContain('slides:redo')
      expect(channels).toContain('slides:save')
    } finally {
      await pool.close()
    }
  })

  it('fails a job that does not exist instead of hanging', async () => {
    const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-pool-')))
    const pool = new EnginePool({ workspaceRoots: [workspace], size: 1 })
    try {
      await expect(pool.run('nope:nothing')).rejects.toThrow(/unknown engine job/)
    } finally {
      await pool.close()
    }
  })

  it('refuses a path outside the workspace', async () => {
    const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-pool-')))
    const pool = new EnginePool({ workspaceRoots: [workspace], size: 1 })
    try {
      // The controlled filesystem refuses the path: the upstream handler
      // reads through it, so the file never reaches the disk.
      await expect(
        pool.run('slides:invoke', ['slides:open-path', ['/etc/passwd', 1280], 'tab-1']),
      ).rejects.toThrow()
    } finally {
      await pool.close()
    }
  })
})
