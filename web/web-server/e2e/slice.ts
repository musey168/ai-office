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
/** A document with a picture in it — the images have to render in the browser. */
const PICTURE_FIXTURE = join(
  repoRoot,
  'apps/docs/tests/pagination-corpus/geometry/geo-anchored-pictures.docx',
)
const MARKER = '端到端改的字'

function step(message: string): void {
  console.log(`\n▶ ${message}`)
}

function ok(message: string): void {
  console.log(`  ✓ ${message}`)
}

async function main(): Promise<void> {
  // A deployment can be checked the same way: point the run at a running
  // server instead of starting one here.
  const remoteBase = process.env.AIOFFICE_E2E_BASE?.trim()
  const remoteWorkspace = process.env.AIOFFICE_E2E_WORKSPACE?.trim()

  const workspace = remoteWorkspace
    ? remoteWorkspace
    : realpathSync(await mkdtemp(join(tmpdir(), 'aio-e2e-')))
  const document = join(workspace, '简单文档.docx')
  const withPicture = join(workspace, '带图片的文档.docx')
  if (!remoteWorkspace) {
    await copyFile(FIXTURE, document)
    await copyFile(PICTURE_FIXTURE, withPicture)
  }
  // A remote workspace is not on this disk — the file checks are skipped
  // there and the deployment checks them over ssh instead.
  const before = remoteWorkspace ? null : await stat(document)

  let office: ReturnType<typeof createOfficeServer> | null = null
  let base = remoteBase ?? ''
  if (!remoteBase) {
    office = createOfficeServer({
      port: 0,
      host: '127.0.0.1',
      workspaceRoot: workspace,
      rendererRoot: join(repoRoot, 'web/web-server/dist'),
      bridgeRoot: join(repoRoot, 'web/rpc-bridge/dist'),
    })
    await new Promise<void>((done) => office!.server.listen(0, '127.0.0.1', done))
    const address = office.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    base = `http://127.0.0.1:${port}`
  }
  console.log(`server: ${base}\nworkspace: ${workspace}`)

  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('request', (request) => {
    if (request.url().includes('/rpc/tabs')) {
      console.log('  → RPC', decodeURIComponent(request.url().split('/rpc/')[1] ?? ''))
    }
  })
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
    if (message.text().includes('bridge-debug')) console.log('  ', message.text())
  })

  try {
    step('打开首页')
    await page.goto(`${base}/app/shell/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.app-frame', { timeout: 30_000 })
    ok('首页渲染出来了（不是白屏）')

    // A document tab left open by an earlier run hides the home content —
    // the tab bar is the way back.
    const homeTab = page.locator('.tab-home')
    if (await homeTab.count()) {
      await homeTab.first().click()
      await page.waitForTimeout(500)
    }

    step('文件树里能看到工作区的文档')
    // Upstream's tree starts collapsed, and the file list shows the files of
    // the *selected* folder — so the root row is opened and then selected.
    const rootRow = page.locator(`[role="treeitem"][title="${workspace}"]`)
    await rootRow.waitFor({ timeout: 30_000 })
    await rootRow.locator('button.tree-chevron').click()
    await rootRow.click()
    await page.waitForSelector('text=简单文档.docx >> visible=true', { timeout: 30_000 })
    ok('文件列表列出了 简单文档.docx')

    step('点开文档')
    await page.click('text=简单文档.docx >> visible=true')
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
    if (before) {
      const changed = await waitForFileChange(document, before.mtimeMs, before.size, 30_000)
      ok(`文件被重写了：${changed.size} 字节（原来 ${before.size}）`)
    } else {
      ok('保存请求成功（远端模式，落盘由部署侧用 ssh 确认）')
    }

    if (before) {
      step('重新读一遍磁盘上的文件，确认改动真的落盘')
      const written = await readFile(document)
      if (written.byteLength === before.size && written.equals(await readFile(FIXTURE))) {
        throw new Error('the file on disk is unchanged')
      }
      ok('磁盘上的文件确实变了')
    } else {
      step('远端模式：落盘由部署侧用 ssh 确认')
    }

    step('文档里的图片能显示')
    // Upstream hides the home content while a document tab is active — the
    // user goes back to the home tab to pick the next file.
    await page.click('.tab-home')
    try {
      await page.waitForSelector('text=带图片的文档.docx >> visible=true', { timeout: 10_000 })
    } catch (error) {
      const state = await page.evaluate(`(() => {
        const content = document.querySelector('.app-frame-content')
        const tabs = [...document.querySelectorAll('.tab-item')].map((el) => ({
          text: (el.textContent || '').trim().slice(0, 16), active: el.className.includes('active'),
        }))
        const names = [...document.querySelectorAll('.recent-name, .file-name, td, .name-cell')]
          .map((el) => (el.textContent || '').trim().slice(0, 20))
        return JSON.stringify({
          homeVisibility: content ? getComputedStyle(content).visibility : 'none',
          tabs, names: names.slice(0, 20),
        })
      })()`)
      const serverTabs = await page.evaluate(`(async () => {
        const res = await fetch('/rpc/tabs:list', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ args: [] }),
        })
        return JSON.stringify((await res.json()).value)
      })()`)
      throw new Error(`${(error as Error).message}\n页面状态：${state}\n服务端标签：${serverTabs}`)
    }
    await page.click('text=带图片的文档.docx >> visible=true')
    await page.waitForFunction(
      () => {
        const frame = document.querySelector('iframe[data-ai-office-editor]') as HTMLIFrameElement | null
        const inner = frame?.contentDocument
        return (inner?.querySelectorAll('.ProseMirror img').length ?? 0) > 0
      },
      undefined,
      { timeout: 60_000 },
    )
    const pictures = await page.evaluate(() => {
      const frame = document.querySelector('iframe[data-ai-office-editor]') as HTMLIFrameElement
      const images = [...frame.contentDocument!.querySelectorAll('.ProseMirror img')]
      return images.map((image) => ({
        src: (image as HTMLImageElement).src.slice(0, 40),
        width: (image as HTMLImageElement).naturalWidth,
      }))
    })
    const rendered = pictures.filter((picture) => picture.width > 0)
    if (rendered.length === 0) {
      throw new Error(`the pictures did not render: ${JSON.stringify(pictures)}`)
    }
    ok(`${rendered.length} 张图片渲染出来了（${pictures[0]?.src}…）`)

    if (problems.length) {
      console.log('\n浏览器里报的问题：')
      for (const problem of problems.slice(0, 12)) console.log(`  ! ${problem}`)
    } else {
      console.log('\n浏览器控制台没有报错')
    }
  } finally {
    await browser.close()
    await office?.close()
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
