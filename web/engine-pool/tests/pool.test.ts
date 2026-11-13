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

describe.skipIf(!workerBuilt)('EnginePool (with the built worker)', () => {
  it('parses a presentation and hands back the render tree', async () => {
    const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-pool-')))
    const deck = join(workspace, 'deck.pptx')
    await copyFile(FIXTURE, deck)

    const pool = new EnginePool({ workspaceRoots: [workspace], size: 1 })
    try {
      const result = (await pool.run('slides:open', ['session-1', deck, 1280])) as {
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
      await expect(pool.run('slides:open', ['s', '/etc/passwd', 1280])).rejects.toThrow()
    } finally {
      await pool.close()
    }
  })
})
