/**
 * The slides render tree's media URLs.
 *
 * The deck itself is upstream's business: the upstream main process owns it
 * and runs in the worker (`slides-upstream.ts`). What is left here is the one
 * thing the browser cannot do — fetch a custom scheme.
 *
 * Upstream hands the renderer `genoffice-slide-media://archive/<uuid>?mime=…`
 * for the pictures in a slide (`apps/slides/src/main/session-state.ts:592`).
 * A browser refuses a custom scheme, so the URL is rewritten to a same-origin
 * path the server answers from the bytes the worker still holds (upstream's
 * `readSlideMedia`, `session-state.ts:606`).
 *
 * **No upstream line is changed** — the rewrite happens on the way out.
 */

/** The custom scheme upstream hands the renderer for slide media. */
const SLIDE_MEDIA_SCHEME = 'genoffice-slide-media://'

/**
 * Rewrite the media URLs in a render tree to same-origin paths.
 *
 * The renderer asks for `<img src>` — the browser refuses a custom scheme,
 * so the URL is rewritten to `/media/slide/<id>` and the server answers it
 * from the engine that still holds the bytes.
 */
export function rewriteMediaUrls(node: unknown): void {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      const item = node[index]
      if (typeof item === 'string' && item.startsWith(SLIDE_MEDIA_SCHEME)) {
        node[index] = item.replace(SLIDE_MEDIA_SCHEME, '/media/slide/')
      } else {
        rewriteMediaUrls(item)
      }
    }
    return
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string' && value.startsWith(SLIDE_MEDIA_SCHEME)) {
        record[key] = value.replace(SLIDE_MEDIA_SCHEME, '/media/slide/')
      } else {
        rewriteMediaUrls(value)
      }
    }
  }
}
