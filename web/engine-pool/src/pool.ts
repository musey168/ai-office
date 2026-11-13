import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

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
  private readonly waiting: ((worker: Worker) => void)[] = []
  private readonly pending = new Map<number, PendingJob>()
  private readonly workerPath: string
  private readonly timeoutMs: number
  private nextId = 0
  private closed = false

  constructor(options: EnginePoolOptions) {
    this.workerPath = options.workerPath ?? WORKER_PATH
    this.timeoutMs = options.timeoutMs ?? 120_000
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
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    })
    worker.on('message', (response: { id: number; ok: boolean; value?: unknown; error?: { message: string } }) => {
      const job = this.pending.get(response.id)
      if (!job) return
      this.pending.delete(response.id)
      clearTimeout(job.timer)
      if (response.ok) job.resolve(response.value)
      else job.reject(new Error(response.error?.message ?? 'the engine job failed'))
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
    if (this.closed) return
    const replacement = this.spawn([])
    this.workers.push(replacement)
    this.idle.push(replacement)
  }

  private release(worker: Worker): void {
    const waiter = this.waiting.shift()
    if (waiter) waiter(worker)
    else this.idle.push(worker)
  }

  /** Run one job and wait for its answer. */
  run<T = unknown>(job: string, args: unknown[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the engine pool is closed'))
    const worker = this.idle.pop()
    if (!worker) {
      return new Promise<T>((resolve, reject) => {
        this.waiting.push((chosen) => {
          this.dispatch(chosen, job, args, (value) => resolve(value as T), reject)
        })
      })
    }
    return new Promise<T>((resolve, reject) => {
      this.dispatch(worker, job, args, (value) => resolve(value as T), reject)
    })
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
