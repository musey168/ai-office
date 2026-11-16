import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Fence, LocalWorkspaceStore, type WorkspaceStore } from '@ai-office/workspace-store'
import type { EngineRunner } from '@ai-office/rpc-bridge'
import {
  findStaticFile,
  injectBridge,
  injectPolyfill,
  resolveWithinRoot,
  sendFile,
} from './static.js'
import {
  ChannelRouter,
  createAppChannels,
  createDocsChannels,
  createHomeChannels,
  createHtmlChannels,
  createMarkdownChannels,
  createPdfChannels,
  createPendingOpens,
  createSlidesChannels,
  createTabChannels,
  TabRegistry,
} from '@ai-office/rpc-bridge'

/**
 * The web port's only HTTP entry point.
 *
 * Upstream's shape, kept: a single `node:http` server, one `route()` with a
 * table of paths, the same error body (`{ error }`), the same request size
 * limits, and the same habit of not trusting `X-Forwarded-*` unless the
 * operator says so. No web framework — upstream has none, and adding one
 * would widen the conflict surface every time upstream is merged.
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

/** Where the built renderer applications live. */
const RENDERER_ROOT = join(packageRoot, 'dist')
/** Where the bridge bundles live (the rpc-bridge package's build output). */
const BRIDGE_ROOT = join(packageRoot, '../rpc-bridge/dist')

/** Upstream's JSON body limit (`packages/cli/src/mcp/http.ts:45`). */
const MAX_JSON_BYTES = 32 * 1024 * 1024
/** Upstream's transfer limit (`packages/cli/src/mcp/files.ts:22`). */
const MAX_TRANSFER_BYTES = 256 * 1024 * 1024

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/** Upstream's error body (`packages/cli/src/mcp/http.ts:65`). */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

export interface ServerOptions {
  port?: number
  host?: string
  /** The engine pool that runs the server-side format engines. */
  engines?: EngineRunner
  /**
   * Where the events the engines push arrive.
   *
   * The upstream main process pushes at a renderer (`webContents.send`) —
   * the deck changed, the undo stack moved. The engine worker does the
   * same, so the events have to reach the browser tab they belong to.
   *
   * The server publishes them itself; this hook is for the deployments
   * that want to see them too.
   */
  onEngineEvent?: (event: { tabId: string; channel: string; args: unknown[] }) => void
  /** The workspace directory the file tree shows and the documents live in. */
  workspaceRoot: string
  /** Where the built renderer applications are. */
  rendererRoot?: string
  /** Where the bridge bundles are. */
  bridgeRoot?: string
  /** The store the channels use. Defaults to a local store on the root. */
  store?: WorkspaceStore
  log?: (message: string) => void
}

export interface OfficeServer {
  server: Server
  router: ChannelRouter
  tabs: TabRegistry
  store: WorkspaceStore
  close(): Promise<void>
}

export function createOfficeServer(options: ServerOptions): OfficeServer {
  const { workspaceRoot } = options
  const rendererRoot = options.rendererRoot ?? RENDERER_ROOT
  const bridgeRoot = options.bridgeRoot ?? BRIDGE_ROOT
  const log = options.log ?? ((message: string) => console.log(message))
  const store = options.store ?? new LocalWorkspaceStore({ roots: [workspaceRoot] })
  const fence = new Fence([workspaceRoot])

  const router = new ChannelRouter()
  const tabs = new TabRegistry()
  const pending = createPendingOpens()

  router.registerAll(
    createTabChannels({
      tabs,
      publish: (channel, args) => router.events.publish(channel, args),
    }),
  )
  router.registerAll(createAppChannels({}))
  // The slides channels are always there: without an engine pool they fail
  // with a clear message instead of vanishing (a missing channel breaks the
  // app's startup path).
  const slides = createSlidesChannels({
    engines: options.engines ?? null,
    tabs,
    // The fence in front of the upstream handler: a path the workspace does
    // not hold never reaches the disk.
    canReach: (filePath) => {
      try {
        fence.assertInside(resolve(filePath))
        return true
      } catch {
        return false
      }
    },
  })
  router.registerAll(slides.handlers)
  // The upstream slides main process registers its channels when the module
  // loads, so the list is not known here. The router asks the slides
  // channels when its own table has no answer.
  router.setFallback(async (channel) => slides.upstreamHandler(channel))
  // The engines push the upstream main process's events at the browser.
  if (options.onEngineEvent) {
    // The deployments that want to see the engine's events get them here;
    // the server publishes them to the browser itself.
    const onEngineEvent = options.onEngineEvent
    router.events.onPublish = (channel, args, tabId) => {
      onEngineEvent({ tabId, channel, args })
    }
  }
  router.registerAll(
    createHomeChannels({ store, tabs, pending, engines: options.engines }),
  )
  router.registerAll(createDocsChannels({ store, bytes: router.bytes, tabs, pending }))
  router.registerAll(createMarkdownChannels({ store, tabs }))
  router.registerAll(createHtmlChannels({ store, tabs }))
  router.registerAll(
    createPdfChannels({ store, tabs, bytes: router.bytes, engines: options.engines ?? null }),
  )

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      log(`[web-server] ${(error as Error).message}`)
      if (!res.headersSent) json(res, 500, { error: (error as Error).message })
      else res.end()
    })
  })

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    const pathname = decodeURIComponent(url.pathname)

    if (pathname === '/health' && req.method === 'GET') {
      json(res, 200, { status: 'ok', server: 'ai-office' })
      return
    }

    // The root is the application: the shell is the home screen.
    if (pathname === '/' && req.method === 'GET') {
      res.statusCode = 302
      res.setHeader('location', '/app/shell/')
      res.end()
      return
    }

    // A loopback bind without a token must not answer a rebound DNS name.
    const host = options.host ?? '0.0.0.0'
    if (LOOPBACK_HOSTS.has(host)) {
      const hostname = (req.headers.host ?? '').split(':')[0]
      if (hostname && !LOOPBACK_HOSTS.has(hostname)) {
        json(res, 403, { error: 'host not allowed' })
        return
      }
    }

    // ── the bridge bundle ────────────────────────────────────────────────
    if (pathname.startsWith('/bridge/') && req.method === 'GET') {
      await serveBridge(res, bridgeRoot, pathname.slice('/bridge/'.length))
      return
    }

    // ── the renderer applications ────────────────────────────────────────
    if (pathname.startsWith('/app/') && req.method === 'GET') {
      await serveApp(res, rendererRoot, pathname)
      return
    }

    // ── the channel bridge ───────────────────────────────────────────────
    if (pathname.startsWith('/rpc/') && req.method === 'POST') {
      const channel = pathname.slice('/rpc/'.length)
      await serveRpc(req, res, router, channel)
      return
    }

    // ── the event stream ─────────────────────────────────────────────────
    if (pathname === '/events' && req.method === 'GET') {
      serveEvents(req, res, router)
      return
    }

    // ── bytes ────────────────────────────────────────────────────────────
    if (pathname === '/bytes' && req.method === 'POST') {
      const body = await readBody(req, MAX_TRANSFER_BYTES)
      const token = router.bytes.put(new Uint8Array(body))
      json(res, 200, { token })
      return
    }
    if (pathname.startsWith('/bytes/') && req.method === 'GET') {
      const token = pathname.slice('/bytes/'.length)
      const bytes = router.bytes.take(token)
      if (!bytes) {
        json(res, 404, { error: 'unknown or expired byte token' })
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-length', String(bytes.byteLength))
      res.end(bytes)
      return
    }

    // ── the media of a slide (the upstream custom scheme, same-origin) ───
    if (pathname.startsWith('/media/slide/') && req.method === 'GET') {
      if (!options.engines) {
        json(res, 404, { error: 'the engine pool is not running' })
        return
      }
      const id = pathname.slice('/media/slide/'.length)
      const mime = url.searchParams.get('mime') ?? 'application/octet-stream'
      // The bytes live in the worker that holds the deck; the request does
      // not name it, so every worker is asked.
      const media = (await options.engines.runOnAny<{ body: Uint8Array; mime: string } | null>(
        'slides:media',
        // the upstream URL is the key the engine keeps the bytes under —
        // the query is part of it
        [`genoffice-slide-media://${id}?mime=${encodeURIComponent(mime)}`],
      )) ?? null
      if (!media) {
        json(res, 404, { error: 'no such slide media' })
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', media.mime || mime)
      res.setHeader('content-length', String(media.body.byteLength))
      res.setHeader('cache-control', 'no-store')
      res.end(Buffer.from(media.body))
      return
    }

    // ── the one-time media URL the renderer fetches a document from ──────
    if (pathname.startsWith('/media/') && req.method === 'GET') {
      const token = pathname.slice('/media/'.length)
      const bytes = router.bytes.take(token)
      if (!bytes) {
        json(res, 404, { error: 'unknown or expired media token' })
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-length', String(bytes.byteLength))
      res.end(bytes)
      return
    }

    json(res, 404, { error: `no route for ${req.method} ${pathname}` })
  }

  return {
    server,
    router,
    tabs,
    store,
    close: () =>
      new Promise<void>((done) => {
        // The event streams are long-lived; without this the server would
        // wait for them before shutting down.
        server.closeAllConnections?.()
        server.close(() => done())
      }),
  }
}

/**
 * Serve one of the bridge bundles (the compiled upstream preload).
 *
 * The build may split shared code into chunks under `assets/`, and the
 * browser fetches those relative to the bundle — so they are served from the
 * same place.
 */
async function serveBridge(res: ServerResponse, bridgeRoot: string, name: string): Promise<void> {
  const target = resolveWithinRoot(bridgeRoot, `/${name}`)
  if (!target || !target.endsWith('.js')) {
    json(res, 404, { error: 'no such bridge' })
    return
  }
  try {
    const body = await readFile(target)
    res.statusCode = 200
    res.setHeader('content-type', 'text/javascript; charset=utf-8')
    res.setHeader('content-length', String(body.byteLength))
    // The bridge bundles have fixed names — they are not hashed — so a
    // redeploy has to reach the browsers that already have them.
    res.setHeader('cache-control', 'no-cache')
    res.end(body)
  } catch {
    json(res, 404, { error: 'no such bridge' })
  }
}

/** Serve a built renderer application, injecting the bridge into its HTML. */
async function serveApp(res: ServerResponse, rendererRoot: string, pathname: string): Promise<void> {
  const rest = pathname.slice('/app/'.length)
  const slash = rest.indexOf('/')
  const app = slash === -1 ? rest : rest.slice(0, slash)
  const within = slash === -1 ? '/' : rest.slice(slash)
  if (!/^[a-z0-9-]+$/.test(app)) {
    json(res, 404, { error: 'no such application' })
    return
  }
  const appRoot = join(rendererRoot, app)
  const file = await findStaticFile(appRoot, within === '' ? '/' : within)
  if (!file) {
    json(res, 404, { error: `not found: ${pathname}` })
    return
  }
  if (file.path.endsWith('.html')) {
    const html = await readFile(file.path, 'utf8')
    const injected = injectPolyfill(
      injectBridge(html, `/bridge/${app}.js`),
      '/bridge/polyfill.js',
    )
    res.statusCode = 200
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-cache')
    res.end(injected)
    return
  }
  await sendFile(res, file)
}

/** Run one channel call and answer with its result or its error. */
async function serveRpc(
  req: IncomingMessage,
  res: ServerResponse,
  router: ChannelRouter,
  channel: string,
): Promise<void> {
  const body = await readBody(req, MAX_JSON_BYTES)
  let payload: { args?: unknown[]; ctx?: { app?: string; tabId?: string } }
  try {
    payload = JSON.parse(body.toString('utf8')) as typeof payload
  } catch {
    json(res, 400, { ok: false, error: { code: 'invalid_request', message: 'the body is not JSON' } })
    return
  }
  const args = Array.isArray(payload.args) ? payload.args : []
  try {
    const value = payload.ctx
      ? await router.invoke(channel, args, payload.ctx)
      : await router.invoke(channel, args)
    json(res, 200, { ok: true, value })
  } catch (error) {
    // The request was understood; the channel failed. The failure travels in
    // the envelope — a rejected channel is a normal answer, not a broken
    // request, and the browser console should not fill up with red lines for
    // the features that are not built yet.
    const code = (error as { code?: string }).code ?? 'invalid_request'
    const message = (error as Error).message
    json(res, 200, { ok: false, error: { code, message } })
  }
}

/** The event stream: main-process pushes, filtered by channel. */
function serveEvents(req: IncomingMessage, res: ServerResponse, router: ChannelRouter): void {
  const url = new URL(req.url ?? '/', 'http://placeholder')
  const channels = (url.searchParams.get('channels') ?? '')
    .split(',')
    .map((channel) => channel.trim())
    .filter(Boolean)
  // The tab the stream belongs to; the events of a deck go to that tab.
  const tabId = url.searchParams.get('tab') ?? undefined

  res.statusCode = 200
  res.setHeader('content-type', 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-cache')
  // Proxies that buffer would hold the events back — this is the one header
  // that makes a stream stream.
  res.setHeader('x-accel-buffering', 'no')
  res.setHeader('connection', 'keep-alive')
  res.flushHeaders?.()

  const send = (event: { channel: string; args: unknown[]; id?: number }): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  const unsubscribe = router.events.subscribe(channels, send, tabId)
  // Upstream's renderer watches for a silent connection too.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 30_000)
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    res.end()
  }
  // The **response** closing is the disconnect signal. `req` emits 'close' as
  // soon as the request body is read — for a GET with no body that is
  // immediately — and tearing the stream down on it would kill every
  // subscription before it could deliver anything.
  res.on('close', close)
  req.on('error', close)
}

/** Read a request body, refusing anything over the limit. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = []
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.byteLength
      if (received > limit) {
        fail(new Error(`the request body is larger than ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks)))
    req.on('error', fail)
  })
}
