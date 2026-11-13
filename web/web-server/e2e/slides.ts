import { copyFile, mkdtemp, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type ConsoleMessage } from 'playwright'
import { EnginePool } from '@ai-office/engine-pool'
import { createOfficeServer } from '../src/server'

/**
 * The slides engine, end to end: a .pptx in the workspace, opened from the
 * home screen, parsed **on the server**, drawn by the upstream renderer.
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

async function main(): Promise<void> {
  const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-slides-')))
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
  const page = await browser.newPage()
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })

  try {
    step('打开首页')
    await page.goto(`${base}/app/shell/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.app-frame', { timeout: 30_000 })
    ok('首页渲染出来了')

    step('在文件树里找到 pptx')
    const rootRow = page.locator(`[role="treeitem"][title="${workspace}"]`)
    await rootRow.waitFor({ timeout: 30_000 })
    await rootRow.locator('button.tree-chevron').click()
    await rootRow.click()
    await page.waitForSelector('text=示例演示.pptx >> visible=true', { timeout: 30_000 })
    ok('文件列表列出了 示例演示.pptx')

    step('点开它 —— 解析在服务端')
    const started = Date.now()
    await page.click('text=示例演示.pptx >> visible=true')
    const frameElement = await page.waitForSelector('iframe[data-ai-office-editor]', {
      timeout: 60_000,
    })
    const frame = await frameElement.contentFrame()
    if (!frame) throw new Error('the editor iframe has no frame')
    console.log(`  （编辑器 iframe 用了 ${Date.now() - started}ms）`)

    step('幻灯片画出来了')
    // the slides renderer draws the deck into canvases
    await frame.waitForFunction(
      () => document.querySelectorAll('canvas').length > 0,
      undefined,
      { timeout: 60_000 },
    )
    const canvases = await frame.evaluate(
      () => document.querySelectorAll('canvas').length,
    )
    ok(`渲染器画出了 ${canvases} 个画布`)

    const slides = await frame.evaluate(() => {
      const text = document.body.innerText
      return text.slice(0, 200)
    })
    console.log(`  页面文字：${slides.replace(/\n+/g, ' | ').slice(0, 160)}`)

    if (problems.length) {
      console.log('\n浏览器里报的问题：')
      for (const problem of problems.slice(0, 10)) console.log(`  ! ${problem}`)
    } else {
      console.log('\n浏览器控制台没有报错')
    }
    console.log(`\n原文件未被改动：${(await stat(deck)).size === before.size}`)
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
