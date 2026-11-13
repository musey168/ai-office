/**
 * The engine pool's public surface.
 *
 * The format facades themselves stay inside the package: they import the
 * upstream engine sources, and those must not leak into a consumer's type
 * check (the upstream apps' main modules are Electron-coupled and carry their
 * own build-time assumptions).
 */
export { EnginePool, WORKER_PATH, type EnginePoolOptions } from './pool'
export type { EngineRequest, EngineResponse } from './protocol'
