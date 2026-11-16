import { existsSync } from 'fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { EngineDialog, EngineEvent, EngineMessage } from './protocol'

/**
 * The engine pool: a small set of worker threads that run the upstream
 * format engines.
 *
 * The engines are CPU-heavy; running them in the HTTP process would block
 * the event loop and make the whole application feel stuck while one
 * document parses.
 */

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Where the built worker lives (`npm run build:worker`).
 *
 * The deployment runs a bundled server, where the module directory is not
 * the package directory — so the environment may point at the worker.
 */
export const WORKER_PATH =
  process.env.AIOFFICE_ENGINE_WORKER ?? resolve(here, '../dist/worker.mjs')

export interface EnginePoolOptions {
  /** The workspace roots the workers may touch. */
  workspaceRoots: string[]
  /** How many workers to keep. Defaults to two. */
  size?: number
  /** The worker bundle; defaults to the built one. */
  workerPath?: string
  /** How long a job may take before it is abandoned. */
  timeoutMs?: number
  /**
   * Where the events the engines push arrive.
   *
   * The upstream main process pushes events at a renderer (`webContents.send`).
   * The worker does the same, so they have to reach the browser; this is
   * where the pool hands them over.
   */
  onEvent?: (event: EngineEvent) => void
  /**
   * Where the dialogs the upstream code opens arrive.
   *
   * The desktop app opens a native dialog; the browser has none, so the
   * worker asks the browser to show it and waits for the answer.
   */
  onDialog?: (dialog: EngineDialog) => void
}

interface PendingJob {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  worker: Worker
}

export class EnginePool {
  private readonly workers: Worker[] = []
  private readonly idle: Worker[] = []
  /** The jobs waiting for a worker — each names the one it needs, if any. */
  private readonly waiting: { worker?: Worker; take(worker: Worker): void }[] = []
  /**
   * The worker each session is bound to.
   *
   * A session lives in the worker's memory (upstream's main process owns
   * the deck), so every job of that session has to run on the same worker —
   * otherwise the second job finds no session.
   */
  private readonly affinity = new Map<string, Worker>()
  private readonly pending = new Map<number, PendingJob>()
  private readonly workerPath: string
  private readonly timeoutMs: number
  private readonly onEvent: ((event: EngineEvent) => void) | undefined
  private readonly onDialog: ((dialog: EngineDialog) => void) | undefined
  private nextId = 0
  private closed = false

  constructor(options: EnginePoolOptions) {
    this.workerPath = options.workerPath ?? WORKER_PATH
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.onEvent = options.onEvent
    this.onDialog = options.onDialog
    if (!options.workspaceRoots.length) {
      throw new Error('the engine pool needs at least one workspace root')
    }
    if (!existsSync(this.workerPath)) {
      throw new Error(
        `the engine worker is not built (${this.workerPath}) — run "npm run build:worker"`,
      )
    }
    const size = options.size ?? 2
    for (let index = 0; index < size; index += 1) {
      const worker = this.spawn(options.workspaceRoots)
      this.workers.push(worker)
      this.idle.push(worker)
    }
  }

  private spawn(workspaceRoots: string[]): Worker {
    const worker = new Worker(this.workerPath, {
      workerData: { workspaceRoots },
      // The worker's own output is the server's log: the upstream code
      // warns about things the browser cannot see.
      stdout: true,
      stderr: true,
      // The upstream slides main process loads the whole editor — the fonts,
      // the translations, every operation module — and keeps the deck's
      // history in snapshots. 256 MB was not enough; the desktop app has no
      // such limit at all.
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    })
    worker.on('message', (message: EngineMessage) => {
      if (message.kind === 'event') {
        this.onEvent?.(message)
        return
      }
      if (message.kind === 'dialog') {
        // The upstream code opened a dialog; the browser shows it.
        this.onDialog?.(message)
        return
      }
      const job = this.pending.get(message.id)
      if (!job) return
      this.pending.delete(message.id)
      clearTimeout(job.timer)
      if (message.ok) job.resolve(message.value)
      else job.reject(new Error(message.error?.message ?? 'the engine job failed'))
      this.release(worker)
    })
    worker.on('error', (error: Error) => {
      // A worker that dies takes its job with it: the job must fail loudly
      // instead of hanging forever.
      this.failJobsOf(worker, error)
      this.replace(worker)
    })
    worker.on('exit', (code: number) => {
      if (code === 0) return
      this.failJobsOf(worker, new Error(`the engine worker stopped (exit ${code})`))
    })
    worker.unref()
    return worker
  }

  /** Fail the jobs that were running on a worker that died. */
  private failJobsOf(worker: Worker, error: Error): void {
    for (const [id, job] of [...this.pending]) {
      if (job.worker !== worker) continue
      this.pending.delete(id)
      clearTimeout(job.timer)
      job.reject(error)
    }
  }

  private replace(worker: Worker): void {
    const index = this.workers.indexOf(worker)
    if (index === -1) return
    this.workers.splice(index, 1)
    void worker.terminate()
    // The sessions that lived on the dead worker are gone with it; their
    // binding moves to the replacement so their next job finds a worker.
    const replacement = this.spawn([])
    if (this.closed) return
    this.workers.push(replacement)
    this.idle.push(replacement)
    for (const [key, bound] of [...this.affinity]) {
      if (bound === worker) this.affinity.set(key, replacement)
    }
  }

  private release(worker: Worker): void {
    // A job waiting for this very worker comes first: it is the one whose
    // session lives here.
    const named = this.waiting.findIndex((waiter) => waiter.worker === worker)
    if (named !== -1) {
      const [waiter] = this.waiting.splice(named, 1)
      waiter!.take(worker)
      return
    }
    const any = this.waiting.findIndex((waiter) => !waiter.worker)
    if (any !== -1) {
      const [waiter] = this.waiting.splice(any, 1)
      waiter!.take(worker)
      return
    }
    this.idle.push(worker)
  }

  /**
   * Run one job and wait for its answer.
   *
   * The affinity key names the session the job belongs to: every job of one
   * session runs on the same worker, because the session lives there.
   */
  run<T = unknown>(job: string, args: unknown[] = [], affinityKey?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the engine pool is closed'))
    const bound = affinityKey ? this.affinity.get(affinityKey) : undefined

    if (bound && !this.idle.includes(bound)) {
      // The session's worker is busy: the job waits for it.
      return new Promise<T>((resolve, reject) => {
        this.waiting.push({
          worker: bound,
          take: (worker) => {
            this.dispatch(worker, job, args, (value) => resolve(value as T), reject)
          },
        })
      })
    }

    const worker = bound ?? this.idle.pop()
    if (!worker) {
      return new Promise<T>((resolve, reject) => {
        this.waiting.push({
          take: (chosen) => {
            if (affinityKey) this.affinity.set(affinityKey, chosen)
            this.dispatch(chosen, job, args, (value) => resolve(value as T), reject)
          },
        })
      })
    }
    if (affinityKey) this.affinity.set(affinityKey, worker)
    return new Promise<T>((resolve, reject) => {
      this.dispatch(worker, job, args, (value) => resolve(value as T), reject)
    })
  }

  /**
   * Ask every worker; the first one that has the answer wins.
   *
   * Some state is per worker and the request does not name the worker that
   * holds it — the slide media bytes are the upstream main process's module
   * state, and the browser asks for them by an opaque id. The request is
   * read-only, so asking every worker is safe.
   */
  runOnAny<T = unknown>(job: string, args: unknown[] = []): Promise<T> {
    const workers = [...this.workers]
    if (!workers.length) return Promise.reject(new Error('the engine pool has no workers'))
    return new Promise<T>((resolve, reject) => {
      const answers: unknown[] = []
      let pending = workers.length
      for (const worker of workers) {
        const id = this.nextId++
        const timer = setTimeout(() => {
          this.pending.delete(id)
          pending -= 1
          if (pending === 0) reject(new Error(`the engine job "${job}" timed out`))
        }, this.timeoutMs)
        this.pending.set(id, {
          resolve: (value) => {
            answers.push(value)
            pending -= 1
            if (pending > 0) return
            const found = answers.find((answer) => answer !== null && answer !== undefined)
            resolve(found as T)
          },
          reject: (error) => {
            pending -= 1
            if (pending === 0) reject(error)
          },
          timer,
          worker,
        })
        worker.postMessage({ id, job, args })
      }
    })
  }

  /**
   * Forget a session's binding.
   *
   * The session is gone (its tab closed), so the worker is free to serve
   * other sessions.
   */
  releaseAffinity(key: string): void {
    this.affinity.delete(key)
  }

  private dispatch(
    worker: Worker,
    job: string,
    args: unknown[],
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
  ): void {
    const id = this.nextId++
    const timer = setTimeout(() => {
      this.pending.delete(id)
      reject(new Error(`the engine job "${job}" timed out`))
      this.replace(worker)
    }, this.timeoutMs)
    this.pending.set(id, { resolve, reject, timer, worker })
    worker.postMessage({ id, job, args })
  }

  async close(): Promise<void> {
    this.closed = true
    for (const job of this.pending.values()) {
      clearTimeout(job.timer)
      job.reject(new Error('the engine pool is closed'))
    }
    this.pending.clear()
    await Promise.all(this.workers.map((worker) => worker.terminate()))
    this.workers.length = 0
    this.idle.length = 0
  }
}
