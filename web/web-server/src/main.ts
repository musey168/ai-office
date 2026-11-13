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
const engines = new EnginePool({ workspaceRoots: [workspaceRoot] })

const office = createOfficeServer({
  port,
  host,
  workspaceRoot,
  rendererRoot,
  bridgeRoot,
  engines,
  log: (message) => console.log(message),
})

office.server.listen(port, host, () => {
  console.log(`[web-server] listening on http://${host}:${port}`)
  console.log(`[web-server] workspace: ${workspaceRoot}`)
  console.log(`[web-server] renderers: ${rendererRoot}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void office.close().then(() => engines.close()).then(() => process.exit(0))
  })
}
