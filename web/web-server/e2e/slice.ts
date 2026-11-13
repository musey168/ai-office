import { copyFile, mkdtemp, readFile, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type ConsoleMessage, type Page } from 'playwright'
import { createOfficeServer } from '../src/server'

/**
 * The first slice, end to end, in a real browser:
 *
 *   the home screen shows the file tree → clicking a .docx opens it in the
 *   editor → typing in the editor changes the document → saving writes it
 *   back to the original file.
 *
 * Everything runs against the **upstream** renderer bundles — the shell and
 * the docs editor are the upstream applications, compiled for the browser and
 * served with our bridge script injected.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

const FIXTURE = join(repoRoot, 'apps/docs/tests/pagination-corpus/docx/simple.docx')
const MARKER = '端到端改的字'

function step(message: string): void {
  console.log(`\n▶ ${message}`)
}

function ok(message: string): void {
  console.log(`  ✓ ${message}`)
}

async function main(): Promise<void> {
  const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-e2e-')))
  const document = join(workspace, '简单文档.docx')
  await copyFile(FIXTURE, document)
  const before = await stat(document)

  const office = createOfficeServer({
    port: 0,
    host: '127.0.0.1',
    workspaceRoot: workspace,
    rendererRoot: join(repoRoot, 'web/web-server/dist'),
    bridgeRoot: join(repoRoot, 'web/rpc-bridge/dist'),
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
    ok('首页渲染出来了（不是白屏）')

    step('文件树里能看到工作区的文档')
    // Upstream's tree starts collapsed, and the file list shows the files of
    // the *selected* folder — so the root row is opened and then selected.
    const rootRow = page.locator(`[role="treeitem"][title="${workspace}"]`)
    await rootRow.waitFor({ timeout: 30_000 })
    await rootRow.locator('button.tree-chevron').click()
    await rootRow.click()
    await page.waitForSelector('text=简单文档.docx', { timeout: 30_000 })
    ok('文件列表列出了 简单文档.docx')

    step('点开文档')
    await page.click('text=简单文档.docx')
    const frameElement = await page.waitForSelector('iframe[data-ai-office-editor]', {
      timeout: 30_000,
    })
    const frame = await frameElement.contentFrame()
    if (!frame) throw new Error('the editor iframe has no frame')
    await frame.waitForSelector('.ProseMirror', { timeout: 60_000 })
    ok('编辑器 iframe 打开了，ProseMirror 就绪')

    const text = await frame.textContent('.ProseMirror')
    if (!text?.includes('第一段')) throw new Error(`the document text is missing: ${text?.slice(0, 80)}`)
    ok(`文档内容读出来了：${text?.slice(0, 40)}…`)

    step('在编辑器里改字')
    await frame.click('.ProseMirror')
    await page.keyboard.press('Control+Home')
    await page.keyboard.type(MARKER)
    await page.waitForTimeout(500)
    const edited = await frame.textContent('.ProseMirror')
    if (!edited?.includes(MARKER)) throw new Error('the typed text did not land in the editor')
    ok(`编辑器里有改动的字：${MARKER}`)

    step('保存（Ctrl+S）')
    await page.keyboard.press('Control+s')
    const changed = await waitForFileChange(document, before.mtimeMs, before.size, 30_000)
    ok(`文件被重写了：${changed.size} 字节（原来 ${before.size}）`)

    step('重新读一遍磁盘上的文件，确认改动真的落盘')
    const written = await readFile(document)
    if (written.byteLength === before.size && written.equals(await readFile(FIXTURE))) {
      throw new Error('the file on disk is unchanged')
    }
    ok('磁盘上的文件确实变了')

    if (problems.length) {
      console.log('\n浏览器里报的问题：')
      for (const problem of problems.slice(0, 12)) console.log(`  ! ${problem}`)
    } else {
      console.log('\n浏览器控制台没有报错')
    }
  } finally {
    await browser.close()
    await office.close()
  }
}

/** Wait until the file on disk is rewritten. */
async function waitForFileChange(
  path: string,
  mtimeMs: number,
  size: number,
  timeoutMs: number,
): Promise<{ size: number }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = await stat(path)
    if (info.mtimeMs > mtimeMs || info.size !== size) return { size: info.size }
    await new Promise((done) => setTimeout(done, 200))
  }
  throw new Error('the document was not written back within the timeout')
}

main().catch((error: unknown) => {
  console.error(`\n✗ 端到端失败：${(error as Error).message}`)
  process.exit(1)
})
