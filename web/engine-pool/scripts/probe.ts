import { mkdtemp, copyFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnginePool } from '../src/pool'

/**
 * A quick check that the server side of the slides engine works: a .pptx
 * goes in, the render tree the browser draws comes out.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-engine-')))
const fixture = join(repoRoot, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx')
const deck = join(workspace, '示例.pptx')
await copyFile(fixture, deck)

const pool = new EnginePool({ workspaceRoots: [workspace], size: 1 })
try {
  const started = Date.now()
  const result = (await pool.run('slides:open', ['session-1', deck, 1280])) as {
    path: string
    slides: { nodes: unknown[]; widthPx: number }[]
    size: { cx: number; cy: number }
    defaultFont?: string
  }
  console.log(`打开用了 ${Date.now() - started}ms`)
  console.log('路径:', result.path)
  console.log('页数:', result.slides.length)
  console.log('页面尺寸:', JSON.stringify(result.size))
  console.log('默认字体:', result.defaultFont)
  console.log('第一页的节点数:', result.slides[0]?.nodes.length, '宽:', result.slides[0]?.widthPx)
  console.log(
    '前 200 字:',
    JSON.stringify(result.slides[0]).slice(0, 200),
  )
} finally {
  await pool.close()
}
