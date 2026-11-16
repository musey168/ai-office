import { copyFile, mkdtemp, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type ConsoleMessage } from 'playwright'
import { EnginePool } from '@ai-office/engine-pool'
import { createOfficeServer } from '../src/server'

/**
 * The slides editing loop, end to end.
 *
 * Upstream keeps the deck in its main process and the renderer drives it
 * over IPC: the browser says "edit this text", the main process applies the
 * operation and hands back the rebuilt render tree. The web port has the
 * same shape — the server is the main process — so the browser's clicks
 * have to reach the upstream handlers and the deck has to come back changed.
 *
 * The check is the same one the docx slice has: change a word, save, and
 * read the bytes back off the disk.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const FIXTURE = join(repoRoot, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx')

function step(message: string): void {
  console.log(`\n▶ ${message}`)
}

function ok(message: string): void {
  console.log(`  ✓ ${message}`)
}

function fail(message: string): void {
  console.log(`  ✗ ${message}`)
  process.exitCode = 1
}

async function main(): Promise<void> {
  const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-slides-edit-')))
  const deck = join(workspace, '示例演示.pptx')
  await copyFile(FIXTURE, deck)
  const before = await stat(deck)

  const engines = new EnginePool({ workspaceRoots: [workspace], size: 1 })
  const office = createOfficeServer({
    port: 0,
    host: '127.0.0.1',
    workspaceRoot: workspace,
    rendererRoot: join(repoRoot, 'web/web-server/dist'),
    bridgeRoot: join(repoRoot, 'web/rpc-bridge/dist'),
    engines,
  })
  await new Promise<void>((done) => office.server.listen(0, '127.0.0.1', done))
  const address = office.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}`
  console.log(`server: ${base}\nworkspace: ${workspace}`)

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })

  try {
    step('打开首页，找到 pptx')
    await page.goto(`${base}/app/shell/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.app-frame', { timeout: 30_000 })
    const rootRow = page.locator(`[role="treeitem"][title="${workspace}"]`)
    await rootRow.waitFor({ timeout: 30_000 })
    await rootRow.locator('button.tree-chevron').click()
    await rootRow.click()
    await page.waitForSelector('text=示例演示.pptx >> visible=true', { timeout: 30_000 })
    ok('文件列表列出了 示例演示.pptx')

    step('点开它 —— 解析在服务端')
    await page.click('text=示例演示.pptx >> visible=true')
    const frameElement = await page.waitForSelector('iframe[data-ai-office-editor]', {
      timeout: 60_000,
    })
    const frame = await frameElement.contentFrame()
    if (!frame) throw new Error('the editor iframe has no frame')
    await frame.waitForFunction(() => document.querySelectorAll('canvas').length > 0, undefined, {
      timeout: 60_000,
    })
    const canvases = await frame.evaluate(() => document.querySelectorAll('canvas').length)
    ok(`渲染器画出了 ${canvases} 个画布`)

    step('deck 在服务端活着 —— 撤销栈是空的')
    // The upstream renderer asks the main process whether undo is possible.
    const undoDisabled = await frame.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((b) =>
        /undo|撤销/i.test(b.getAttribute('aria-label') ?? b.title ?? ''),
      )
      return button ? button.hasAttribute('disabled') : null
    })
    if (undoDisabled === true) ok('撤销按钮是灰的（还没有可撤销的编辑）')
    else console.log(`  撤销按钮状态：${undoDisabled}（界面上没找到这个按钮）`)

    step('改一个字 —— 走上游的 edit-text handler')
    // The upstream renderer is driven by pointer events on the canvas; the
    // simplest faithful way to reach the edit path is the channel itself.
    const edited = await frame.evaluate(async () => {
      const api = (window as unknown as { slidesApi?: Record<string, unknown> }).slidesApi
      if (!api) return { error: 'no slidesApi on the page' }
      const slides = (await api.getRenderSlides()) as {
        nodes?: { type?: string; sourceId?: string }[]
      }[]
      const node = slides[0]?.nodes?.find((n) => n.type === 'text')
      if (!node?.sourceId) return { error: 'no text node on the first slide' }
      const updated = await api.editText({
        slideIndex: 0,
        sourceId: node.sourceId,
        paragraphs: [{ runs: [{ text: '端到端改的字' }] }],
      })
      return { edited: Boolean(updated), sourceId: node.sourceId }
    })
    if ('error' in edited) {
      fail(`改字失败：${edited.error}`)
    } else {
      ok(`edit-text 返回了重建的渲染树（sourceId=${edited.sourceId}）`)
    }

    step('撤销 —— 走上游的 undo handler')
    const undone = await frame.evaluate(async () => {
      const api = (window as unknown as { slidesApi: Record<string, unknown> }).slidesApi
      const slides = (await api.undo()) as unknown[] | null
      return slides?.length ?? 0
    })
    ok(`undo 返回了 ${undone} 页的渲染树`)

    step('重做 —— 走上游的 redo handler')
    const redone = await frame.evaluate(async () => {
      const api = (window as unknown as { slidesApi: Record<string, unknown> }).slidesApi
      const slides = (await api.redo()) as unknown[] | null
      return slides?.length ?? 0
    })
    ok(`redo 返回了 ${redone} 页的渲染树`)

    step('保存 —— 走上游的 save handler')
    const saved = await frame.evaluate(async () => {
      const api = (window as unknown as { slidesApi: Record<string, unknown> }).slidesApi
      const result = (await api.save()) as { ok?: boolean; path?: string; error?: string }
      return result
    })
    if (saved?.ok) ok(`保存成功：${saved.path}`)
    else fail(`保存失败：${saved?.error ?? 'unknown'}`)

    step('磁盘上的文件真的改了吗')
    // The deck is a zip; the slide's XML has to come out of it.
    const xml = execFileSync('unzip', ['-p', deck, 'ppt/slides/slide1.xml'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    if (xml.includes('端到端改的字')) ok('磁盘上的 pptx 里有改动的字')
    else fail('磁盘上的 pptx 里没有改动的字')

    if (problems.length) {
      console.log('\n浏览器里报的问题：')
      for (const problem of problems.slice(0, 10)) console.log(`  ! ${problem}`)
    } else {
      console.log('\n浏览器控制台没有报错')
    }
    console.log(`\n文件大小：${before.size} → ${(await stat(deck)).size} 字节`)
  } finally {
    await browser.close()
    await office.close()
    await engines.close()
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ 端到端失败：${(error as Error).message}`)
  process.exit(1)
})
