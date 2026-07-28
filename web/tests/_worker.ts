/**
 * Shared loader for tests that import worker (worker/)
 * source. The worker is a private submodule with no .gitmodules, so it's
 * absent in CI — these tests run locally, skip in CI. The skip is made
 * LOUD (one console.warn) so the coverage gap is never invisible: CI's
 * "N passed | M skipped" plus this line make it obvious the worker's
 * crypto/scheduler/authz tests only gate on a machine with the checkout.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const WORKER_SRC = join(__dirname, '..', 'worker', 'src')

export function workerFile(name: string): string {
  return join(WORKER_SRC, name)
}

/** True when the worker submodule source is checked out (local dev). */
export const workerPresent = existsSync(join(WORKER_SRC, 'index.ts'))

let warned = false
export function warnIfWorkerAbsent(suite: string): void {
  if (!workerPresent && !warned) {
    warned = true
    console.warn(
      `\n⚠️  worker submodule absent — skipping worker-dependent tests ` +
      `(${suite} and others). Run in a checkout with worker/ ` +
      `to exercise scheduler/push-crypto/telegram-authz coverage.\n`
    )
  }
}
