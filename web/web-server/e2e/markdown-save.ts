import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { EnginePool } from '@ai-office/engine-pool'
import { createOfficeServer } from '../src/server'

/**
 * The markdown save loop, end to end.
 *
 * Upstream keeps the open note in its main process: the browser asks the
 * main process to save, and the main process writes the file. This walks
 * the whole way: a real note on disk, the upstream editor in the browser,
 * a save, and the bytes on disk.
 */

const repoRoot = resolve(import.meta.dirname, '../../..')

async function main(): Promise<void> {
  const workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-md-')))
  const note = join(workspace, '笔记.md')
  await writeFile(note, '# 原来的标题\n\n原来的正文\n', 'utf8')

  const engines = new EnginePool({ workspaceRoots: [workspace], size: 1 })
  const office = createOfficeServer({
    port: 0,
    host: '127.0.0.1',
    workspaceRoot: workspace,
    rendererRoot: join(repoRoot, 'web/web-server/dist'),
    bridgeRoot: join(repoRoot, 'web/rpc-bridge/dist'),
    engines,
  })
  await new Promise<void>((resolve) => office.server.listen(0, '127.0.0.1', resolve))
  const address = office.server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))

  console.log('▶ 打开首页')
  await page.goto(`http://127.0.0.1:${port}/app/shell/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-frame', { timeout: 30_000 })

  console.log('▶ 在文件树里找到笔记')
  const root = page.locator('[role="treeitem"]').first()
  await root.waitFor({ timeout: 30_000 })
  await root.locator('button.tree-chevron').click()
  await root.click()
  await page.waitForSelector('text=笔记.md >> visible=true', { timeout: 30_000 })
  await page.click('text=笔记.md >> visible=true')

  console.log('▶ 编辑器加载了笔记')
  const frameElement = await page.waitForSelector('iframe[data-ai-office-editor]', { timeout: 60_000 })
  const frame = await frameElement.contentFrame()
  if (!frame) throw new Error('the editor frame did not open')
  await frame.waitForFunction(
    () => (document.body.innerText ?? '').includes('原来的标题'),
    undefined,
    { timeout: 60_000 },
  )

  console.log('▶ 通过浏览器的保存接口写回')
  // The upstream editor's own key handling is upstream's business; what the
  // web port owns is the path from the browser to the upstream main
  // process and on to the disk.
  const saved = await frame.evaluate(async () => {
    const api = (window as unknown as {
      markdownApi?: { save(request: unknown): Promise<unknown> }
    }).markdownApi
    if (!api) throw new Error('the markdown bridge is not there')
    return (await api.save({
      text: '# 原来的标题\n\n改过的字\n',
      imageSources: [],
      mode: 'save',
    })) as { ok?: boolean; path?: string; error?: string }
  })
  if (!saved.ok) throw new Error(`the save failed: ${saved.error ?? 'unknown'}`)
  console.log(`  ✓ 上游的保存返回 ${saved.path}`)

  console.log('▶ 磁盘上的文件确实变了')
  const written = await readFile(note, 'utf8')
  if (!written.includes('改过的字')) {
    throw new Error(`the file on disk was not updated:\n${written}`)
  }
  console.log('  ✓ 磁盘上的笔记里有改过的字')

  console.log('▶ 上游的保存没有把工作区外的文件碰了')
  const outside = await readFile(join(workspace, '..', 'aio-md-outside.txt'), 'utf8').catch(() => '')
  if (outside) throw new Error('a file outside the workspace was touched')

  await browser.close()
  await office.close()
  await engines.close()

  const noise = problems.filter(
    (message) =>
      !/integrations:status|ai:get-settings|tabs:chrome-pressed/.test(message),
  )
  if (noise.length) {
    throw new Error(`the page reported errors:\n${noise.join('\n')}`)
  }
  console.log('\n✓ markdown 保存闭环通过')
}

void main()
