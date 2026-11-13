import {
  createBlankPptx,
  openPptx,
  parseTheme,
  savePptx,
  type OpenedPptx,
} from '@genoffice/pptx-engine'
import { buildAllRenderSlides } from '../../../apps/slides/src/main/session-state'
import type { OpenResult } from '../../../apps/slides/src/shared/ipc'

/**
 * The slides engine, server side.
 *
 * The parsing and the saving are upstream's (`pptx-engine`), and the render
 * tree the browser draws is upstream's too (`buildAllRenderSlides`, which
 * wraps `pptx-render`). Only the plumbing is ours.
 *
 * **Why the app's main code is imported here**: upstream builds the tree in
 * its main process, so the function lives in `apps/slides/src/main`. It is a
 * pure function over the parsed deck; the Electron import in that file is
 * for the broadcast paths we do not use. The server compiles it with
 * `electron` aliased to the server shim.
 */

/** Parse a .pptx into the engine's model. */
export async function openDeck(bytes: Uint8Array): Promise<OpenedPptx> {
  return openPptx(bytes)
}

/** An empty deck, for the "new presentation" path. */
export async function blankDeck(): Promise<OpenedPptx> {
  return openPptx(await createBlankPptx())
}

/** Serialize the deck back to .pptx bytes. */
export function saveDeck(opened: OpenedPptx): Promise<Uint8Array> {
  return savePptx(opened)
}

/** What the renderer receives when a deck opens. */
export function buildOpenResult(
  opened: OpenedPptx,
  path: string,
  fitWidthPx: number,
): OpenResult {
  const slides = buildAllRenderSlides(opened, fitWidthPx)
  // The media URLs upstream builds point at a custom scheme the browser
  // cannot fetch; they become same-origin paths the server answers.
  for (const slide of slides) rewriteMediaUrls(slide)
  return {
    path,
    slides,
    size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
    defaultFont: deckDefaultFont(opened),
  }
}

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

/**
 * The theme's minor font — the fallback the font box shows when the
 * selection has no text element.
 *
 * Upstream keeps this in `slides-main.ts`, whose module graph is the whole
 * main process; the seven lines are reproduced here over upstream's own
 * `parseTheme`, because the value is part of the deck's model, not of the
 * desktop app.
 */
export function deckDefaultFont(opened: OpenedPptx): string | undefined {
  try {
    const slidePath = opened.archive.readPresentation().slidePaths[0]
    if (!slidePath) return undefined
    const themePath = opened.archive.resolveSlideChain(slidePath).themePath
    const xml = themePath ? opened.archive.readText(themePath) : undefined
    return xml ? parseTheme(xml).minorFont : undefined
  } catch {
    return undefined
  }
}
