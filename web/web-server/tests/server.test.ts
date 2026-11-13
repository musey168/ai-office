import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOfficeServer, type OfficeServer } from '../src/server'

let workspace: string
let renderers: string
let office: OfficeServer
let base: string

beforeEach(async () => {
  // macOS's temp dir sits behind a symlink; realize it so the paths the
  // server reports match what the test expects.
  workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-server-')))
  await mkdir(join(workspace, 'docs'), { recursive: true })
  await writeFile(join(workspace, 'hello.docx'), 'docx bytes')

  renderers = join(workspace, 'renderers')
  await mkdir(join(renderers, 'docs'), { recursive: true })
  await writeFile(
    join(renderers, 'docs', 'index.html'),
    '<!doctype html><html><head><title>docs</title></head><body><div id="root"></div>' +
      '<script type="module" src="/app/docs/assets/index-abc.js"></script></body></html>',
  )

  office = createOfficeServer({
    port: 0,
    host: '127.0.0.1',
    workspaceRoot: workspace,
    rendererRoot: renderers,
    bridgeRoot: join(workspace, 'bridges'),
  })
  await new Promise<void>((done) => office.server.listen(0, '127.0.0.1', done))
  const address = office.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  base = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  await office.close()
})

describe('GET /health', () => {
  it('answers without a token', async () => {
    const response = await fetch(`${base}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
  })
})

describe('POST /rpc/:channel', () => {
  it('runs a channel and returns its value', async () => {
    const response = await fetch(`${base}/rpc/home:get-language`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    })
    const payload = (await response.json()) as { ok: boolean; value: unknown }
    expect(payload.ok).toBe(true)
    expect(payload.value).toBe('zh')
  })

  it('reports an unknown channel as an error', async () => {
    const response = await fetch(`${base}/rpc/nope:nothing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    })
    const payload = (await response.json()) as { ok: boolean; error: { code: string } }
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('unknown_channel')
  })

  it('refuses a body that is not JSON', async () => {
    const response = await fetch(`${base}/rpc/home:get-language`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(response.status).toBe(400)
  })
})

describe('the document bytes', () => {
  it('travels as a one-time URL the renderer can fetch', async () => {
    const opened = (await (
      await fetch(`${base}/rpc/docs:open-path`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [join(workspace, 'hello.docx')] }),
      })
    ).json()) as { ok: boolean; value: { dataUrl: string } }
    expect(opened.ok).toBe(true)

    const media = await fetch(`${base}${opened.value.dataUrl}`)
    expect(media.status).toBe(200)
    expect(await media.text()).toBe('docx bytes')

    // the URL dies with the fetch
    const again = await fetch(`${base}${opened.value.dataUrl}`)
    expect(again.status).toBe(404)
  })
})

describe('POST /bytes and GET /bytes/:token', () => {
  it('round-trips binary without base64', async () => {
    const uploaded = (await (
      await fetch(`${base}/bytes`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3, 4]),
      })
    ).json()) as { token: string }
    const downloaded = await fetch(`${base}/bytes/${uploaded.token}`)
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect((await fetch(`${base}/bytes/${uploaded.token}`)).status).toBe(404)
  })
})

describe('GET /app/:app', () => {
  it('serves the application with the bridge injected before its own script', async () => {
    const response = await fetch(`${base}/app/docs/`)
    const html = await response.text()
    expect(response.status).toBe(200)
    const bridgeAt = html.indexOf('/bridge/docs.js')
    const rendererAt = html.indexOf('/app/docs/assets/index-abc.js')
    expect(bridgeAt).toBeGreaterThan(-1)
    expect(bridgeAt).toBeLessThan(rendererAt)
  })

  it('refuses to serve a file outside the application', async () => {
    const response = await fetch(`${base}/app/docs/../../../../etc/passwd`)
    expect(response.status).toBe(404)
  })

  it('answers an unknown application with 404', async () => {
    expect((await fetch(`${base}/app/nope/`)).status).toBe(404)
  })
})

describe('unknown routes', () => {
  it('answer with the upstream error shape', async () => {
    const response = await fetch(`${base}/whatever`)
    expect(response.status).toBe(404)
    expect(await response.json()).toHaveProperty('error')
  })
})
