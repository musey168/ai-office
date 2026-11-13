import { blankPdfBuffer } from '../../../apps/pdf/src/main/blank-pdf'
import type { PagePreviewRequest } from '../../../apps/pdf/src/shared/ipc'

/**
 * A blank single-page PDF.
 *
 * Upstream writes one in the shell's main process when the user picks
 * "New PDF" — the PDF module has no in-memory blank mode, so the file has to
 * exist before it opens. The bytes come from the upstream helper, so the
 * document is the same one the desktop app produces.
 */
export async function createBlankPdf(): Promise<Uint8Array> {
  return new Uint8Array(await blankPdfBuffer())
}

/** The rectangle of an image on a page, in PDF user space. */
export type PdfRect = [number, number, number, number]

/** What the upstream's `renderPagePreviewPng` takes, without the path. */
export type PdfPreviewRequest = Omit<PagePreviewRequest, 'path'>

/**
 * Rasterize one region of a page, the way upstream's `pageImagePng` does.
 *
 * Upstream does this in the main process with PDFium; the browser has no
 * way to do it, so the engine worker does it and answers with a base64 PNG.
 */
export async function renderPageImage(
  bytes: Uint8Array,
  pageIndex: number,
  rect: PdfRect,
  scale = 1,
): Promise<string | null> {
  const { renderImagePng } = await import('../../../apps/pdf/src/main/image-edit')
  return renderImagePng(bytes, pageIndex, rect, scale)
}

/** Rasterize a whole page for the preview, upstream's `pagePreviewPng`. */
export async function renderPagePreview(
  bytes: Uint8Array,
  request: PdfPreviewRequest,
): Promise<unknown> {
  const { renderPagePreviewPng } = await import('../../../apps/pdf/src/main/image-edit')
  return renderPagePreviewPng(bytes, request)
}
