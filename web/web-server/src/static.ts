import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { ServerResponse } from 'node:http'

/**
 * Static file serving for the built renderer applications.
 *
 * Upstream has no static file server — it maps a custom scheme
 * (`genoffice-app://`) onto the packaged files. The web version serves the
 * same files over HTTP, under a path prefix, with the bridge script injected
 * into the HTML.
 */

/** Content types for the file kinds the renderers ship. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
}

export function mimeOf(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Resolve a URL path inside a root directory.
 *
 * Upstream's `resolveRendererFile` guards the same thing: the pathname is
 * length-checked, must not contain a null byte, backslashes are normalized,
 * and the result has to stay inside the root.
 */
export function resolveWithinRoot(root: string, pathname: string): string | null {
  if (pathname.length > 4096) return null
  if (pathname.includes('\0')) return null
  const normalized = normalize(pathname.replace(/\\/g, '/'))
  const target = resolve(root, `.${normalized.startsWith('/') ? normalized : `/${normalized}`}`)
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(rootWithSep)) return null
  return target
}

export interface StaticFile {
  path: string
  size: number
  mtimeMs: number
}

/** Look up a file inside the root; directories resolve to their index.html. */
export async function findStaticFile(root: string, pathname: string): Promise<StaticFile | null> {
  const target = resolveWithinRoot(root, pathname)
  if (!target) return null
  try {
    const info = await stat(target)
    if (info.isDirectory()) {
      const index = join(target, 'index.html')
      const indexInfo = await stat(index)
      return { path: index, size: indexInfo.size, mtimeMs: indexInfo.mtimeMs }
    }
    return { path: target, size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

/**
 * Inject the bridge script into an HTML document.
 *
 * The bridge has to run **before** the renderer's own module: module scripts
 * execute in document order, and the renderer reads the globals the bridge
 * installs (`window.desktop`, `window.aiOffice`, …) while it boots.
 */
export function injectBridge(html: string, bridgeUrl: string): string {
  const tag = `<script type="module" src="${bridgeUrl}"></script>`
  if (html.includes(bridgeUrl)) return html
  // Before the first module script if there is one, otherwise at the end of
  // the body.
  const moduleScript = /<script[^>]*type=["']module["'][^>]*><\/script>/i.exec(html)
  if (moduleScript?.index !== undefined) {
    return html.slice(0, moduleScript.index) + tag + '\n    ' + html.slice(moduleScript.index)
  }
  return html.replace('</body>', `  ${tag}\n  </body>`)
}

/** Write a file to the response, with the caching rules the assets need. */
export async function sendFile(res: ServerResponse, file: StaticFile): Promise<void> {
  const isHtml = file.path.endsWith('.html')
  res.statusCode = 200
  res.setHeader('content-type', mimeOf(file.path))
  res.setHeader('content-length', String(file.size))
  if (isHtml) {
    // The document itself must not be cached: it carries the bridge script
    // tag, and the asset names in it are hashed.
    res.setHeader('cache-control', 'no-cache')
  } else {
    // Vite hashes the asset names, so they can be cached for a long time.
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
  }
  await new Promise<void>((done, fail) => {
    const stream = createReadStream(file.path)
    stream.on('error', fail)
    stream.on('end', done)
    stream.pipe(res)
  })
}
