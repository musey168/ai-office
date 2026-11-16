import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnginePool } from '@ai-office/engine-pool'
import { createOfficeServer } from './server.js'

/**
 * The web port's entry point.
 *
 * Everything is configurable through the environment, because the deployment
 * is a container on a shared server: the workspace directory is a mounted
 * volume, the port comes from the platform.
 */

const here = dirname(fileURLToPath(import.meta.url))

function envPath(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() ? resolve(value) : fallback
}

const port = Number(process.env.PORT ?? process.env.AIOFFICE_PORT ?? 8080)
const host = process.env.HOST ?? process.env.AIOFFICE_HOST ?? '0.0.0.0'
const workspaceRoot = envPath('AIOFFICE_WORKSPACE', resolve(here, '../../workspace'))
const rendererRoot = envPath('AIOFFICE_RENDERERS', resolve(here, '../dist'))
const bridgeRoot = envPath('AIOFFICE_BRIDGES', resolve(here, '../../rpc-bridge/dist'))

// The format engines run in worker threads — a .pptx parse must not block
// the HTTP event loop.
//
// The engines push the upstream main process's events at the browser (the
// deck changed, the undo stack moved). The server is not up yet, so the
// events wait for it.
const queuedEvents: { tabId: string; channel: string; args: unknown[] }[] = []
let deliverEvent: ((event: { tabId: string; channel: string; args: unknown[] }) => void) | null =
  null

// The upstream main processes open native dialogs ("save as"); the browser
// shows them instead, so the request travels to the tab the same way the
// other engine events do.
const queuedDialogs: { id: string; dialogKind: string; options: unknown; tabId: string }[] = []
let deliverDialog:
  | ((dialog: { id: string; dialogKind: string; options: unknown; tabId: string }) => void)
  | null = null

const engines = new EnginePool({
  workspaceRoots: [workspaceRoot],
  workerPath: process.env.AIOFFICE_ENGINE_WORKER
    ? resolve(process.env.AIOFFICE_ENGINE_WORKER)
    : undefined,
  onEvent: (event) => {
    if (deliverEvent) deliverEvent(event)
    else queuedEvents.push(event)
  },
  onDialog: (dialog) => {
    if (deliverDialog) deliverDialog(dialog)
    else queuedDialogs.push(dialog)
  },
})

const office = createOfficeServer({
  port,
  host,
  workspaceRoot,
  rendererRoot,
  bridgeRoot,
  engines,
  log: (message) => console.log(message),
})

// The engine's events go to the tab they belong to: an event about
// somebody's deck is not everybody's business.
deliverEvent = (event) => {
  office.router.events.publishToTab(event.tabId, event.channel, event.args)
}
for (const queued of queuedEvents.splice(0, queuedEvents.length)) {
  deliverEvent(queued)
}

// A dialog the upstream code asked for is an event of its own: the browser
// shows the file picker and answers through the `document:dialog-answer`
// channel.
deliverDialog = (dialog) => {
  office.router.events.publishToTab(dialog.tabId, 'document:dialog', [
    { id: dialog.id, kind: dialog.dialogKind, options: dialog.options },
  ])
}
for (const queued of queuedDialogs.splice(0, queuedDialogs.length)) {
  deliverDialog(queued)
}

office.server.listen(port, host, () => {
  console.log(`[web-server] listening on http://${host}:${port}`)
  console.log(`[web-server] workspace: ${workspaceRoot}`)
  console.log(`[web-server] renderers: ${rendererRoot}`)
  console.log(`[web-server] bridges: ${bridgeRoot}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void office.close().then(() => engines.close()).then(() => process.exit(0))
  })
}
