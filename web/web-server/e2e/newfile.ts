import { mkdtemp } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type ConsoleMessage } from 'playwright'
import { EnginePool } from '@ai-office/engine-pool'
import { createOfficeServer } from '../src/server'

/**
 * The "new file" cards on the home screen.
 *
 * Upstream opens a view with no file behind it; the file is created when
 * the document is saved. The web port has to do the same, otherwise the
 * cards do nothing at all.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

function step(message: string): void {
  console.log(`\n▶ ${message}`)
}

function ok(message: string): void {
  console.log(`  ✓ ${message}`)
}

async function main(): Promise<void> {
  const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-new-')))
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

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error' && !message.text().includes('no handler for channel')) {
      problems.push(`console: ${message.text()}`)
    }
  })

  try {
    step('打开首页')
    await page.goto(`${base}/app/shell/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.quick-card', { timeout: 30_000 })
    ok('新建卡片都在')

    step('点「AI Docs」')
    await page.click('.quick-card:has-text("AI Docs")')
    const frameElement = await page.waitForSelector('iframe[data-ai-office-editor]', {
      timeout: 60_000,
    })
    const frame = await frameElement.contentFrame()
    await frame?.waitForSelector('.ProseMirror', { timeout: 60_000 })
    ok('空白文档编辑器打开了')
    const text = (await frame?.evaluate(() => document.querySelector('.ProseMirror')?.textContent)) ?? ''
    ok(`编辑器是空白的（内容长度 ${text.length}）`)

    step('点「AI Slides」')
    await page.click('.tab-home')
    await page.click('.quick-card:has-text("AI Slides")')
    const slideFrameElement = await page.waitForSelector('iframe[data-ai-office-editor]', {
      timeout: 60_000,
    })
    const slideFrame = await slideFrameElement.contentFrame()
    await slideFrame?.waitForFunction(
      () => document.querySelectorAll('canvas').length > 0,
      undefined,
      { timeout: 60_000 },
    )
    ok('空白演示文稿的画布出来了')

    step('点「AI Markdown」')
    await page.click('.tab-home')
    await page.click('.quick-card:has-text("AI Markdown")')
    await page.waitForSelector('iframe[data-ai-office-editor]', { timeout: 60_000 })
    ok('Markdown 标签打开了')

    step('点「AI HTML」')
    await page.click('.tab-home')
    await page.click('.quick-card:has-text("AI HTML")')
    await page.waitForSelector('iframe[data-ai-office-editor]', { timeout: 60_000 })
    ok('HTML 标签打开了')

    step('点「AI PDF」')
    await page.click('.tab-home')
    await page.click('.quick-card:has-text("AI PDF")')
    const pdfFrameElement = await page.waitForSelector('iframe[data-ai-office-editor]', {
      timeout: 60_000,
    })
    const pdfFrame = await pdfFrameElement.contentFrame()
    await pdfFrame?.waitForSelector('canvas', { timeout: 60_000 })
    ok('空白 PDF 的页面画出来了')

    if (problems.length) {
      console.log('\n浏览器里报的问题：')
      for (const problem of problems.slice(0, 8)) console.log(`  ! ${problem}`)
    } else {
      console.log('\n浏览器控制台没有报错')
    }
  } catch (error) {
    console.log('\n浏览器里报的问题：')
    for (const problem of problems.slice(0, 10)) console.log(`  ! ${problem}`)
    throw error
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
