import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOfficeServer, type OfficeServer } from '../src/server'

/**
 * The event stream carries the main process' pushes to the pages.
 *
 * Two things went wrong here once, and both are silent: a stream torn down
 * too early (the page then reconnects in a loop and events fall into the
 * gap), and a filter that hid the events the page was waiting for.
 *
 * The stream is read with `node:http` rather than `fetch`: the browser uses
 * `EventSource`, and vitest's `fetch` does not hand out streamed chunks.
 */

let workspace: string
let office: OfficeServer
let base: string

beforeEach(async () => {
  workspace = realpathSync(await mkdtemp(join(tmpdir(), 'aio-sse-')))
  await mkdir(join(workspace, 'docs'), { recursive: true })
  await writeFile(join(workspace, 'a.docx'), 'bytes')
  office = createOfficeServer({
    port: 0,
    host: '127.0.0.1',
    workspaceRoot: workspace,
    rendererRoot: join(workspace, 'renderers'),
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

interface StreamEvent {
  channel: string
  args: unknown[]
}

/** An event stream that collects what arrives. */
function openStream(path = '/events'): {
  events: StreamEvent[]
  waitFor: (channel: string, timeoutMs?: number) => Promise<StreamEvent>
} {
  const events: StreamEvent[] = []
  const url = new URL(base + path)
  const request = get(
    { host: url.hostname, port: url.port, path: url.pathname + url.search },
    (response) => {
      let buffer = ''
      response.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.split('\n').find((entry) => entry.startsWith('data: '))
          if (!line) continue
          events.push(JSON.parse(line.slice(6)) as StreamEvent)
        }
      })
    },
  )
  request.on('error', () => {
    /* the stream ends with the server */
  })

  return {
    events,
    waitFor: async (channel: string, timeoutMs = 5_000): Promise<StreamEvent> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = events.find((event) => event.channel === channel)
        if (found) return found
        await new Promise((done) => setTimeout(done, 20))
      }
      throw new Error(`the "${channel}" event did not arrive in time`)
    },
  }
}

async function openDocument(): Promise<void> {
  const response = await fetch(`${base}/rpc/home:open-path`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: [join(workspace, 'a.docx')] }),
  })
  expect(response.status).toBe(200)
}

describe('GET /events', () => {
  it('delivers a pushed event', async () => {
    const stream = openStream()
    // opening a document opens a tab, and the shell is told about it
    await openDocument()

    const event = await stream.waitFor('tabs:changed')
    const tabs = event.args[0] as { kind: string }[]
    expect(tabs.some((tab) => tab.kind === 'docs')).toBe(true)
  })

  it('stays open for the events that follow', async () => {
    const stream = openStream()
    await openDocument()
    await stream.waitFor('tabs:changed')

    // a second event on the same connection — a stream that tears itself
    // down after the first event would never deliver this one
    await fetch(`${base}/rpc/tabs:activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: ['home'] }),
    })
    await expect(stream.waitFor('tabs:changed')).resolves.toMatchObject({
      channel: 'tabs:changed',
    })
  })

  it('delivers everything to a subscriber without a channel filter', async () => {
    const stream = openStream()
    await openDocument()
    await expect(stream.waitFor('tabs:changed')).resolves.toMatchObject({
      channel: 'tabs:changed',
    })
  })

  it('filters by channel when the subscriber asks for it', async () => {
    const stream = openStream('/events?channels=home:folder-changed')
    await openDocument()
    // the tab change is not in the filter — the subscriber must not see it
    await expect(stream.waitFor('tabs:changed', 800)).rejects.toThrow('did not arrive in time')
  })
})
