import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * The PDF page rasterizer, server side.
 *
 * Upstream rasterizes the pages in the main process with PDFium (the WASM
 * build of PDFium) and hands the renderer a PNG. The browser cannot do that
 * itself — the same work happens here, in the engine worker.
 *
 * **The wasm file**: upstream finds it in `node_modules` during development
 * and in the packaged app's `Resources/wasm` otherwise. The worker is copied
 * to the server as a single directory, so the file travels with it and the
 * lookup has to find it there.
 */

/** Where the worker keeps its wasm assets. */
export const WASM_DIR = join(dirname(new URL(import.meta.url).pathname), 'wasm')

/**
 * Point the upstream's wasm lookup at our copy.
 *
 * `process.resourcesPath` is an Electron global; the worker has none, so
 * the upstream fallback (`<resourcesPath>/wasm/<file>`) would fail. Setting
 * it to the worker's own directory makes that fallback land on the file we
 * copied next to the worker.
 */
export function installWasmLookup(): void {
  const globals = process as NodeJS.Process & { resourcesPath?: string }
  if (!globals.resourcesPath) {
    globals.resourcesPath = dirname(WASM_DIR)
  }
}

/** The PDFium wasm, from the upstream package. */
export function pdfiumWasmSource(): string {
  try {
    return createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm')
  } catch {
    return ''
  }
}

/** Whether the worker has the PDFium wasm beside it. */
export function hasPdfiumWasm(): boolean {
  return existsSync(join(WASM_DIR, 'pdfium.wasm'))
}
