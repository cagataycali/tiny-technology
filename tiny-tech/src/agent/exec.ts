/**
 * ⏱️ One async child-process seam, for every tool that shells out.
 *
 * ── why this file exists at all ────────────────────────────────────────────
 * Every long tool in this tree used `execFileSync`, and for a single-turn agent
 * that was fine: nothing else was happening. Concurrent conversations changed
 * the arithmetic. `execFileSync` doesn't just block the caller — it stops the
 * Node event loop dead for the child's whole lifetime, and the loop is what
 * paints the Ink TUI, reads the composer's keys, streams every OTHER
 * conversation's tokens, and answers the mesh relay. So `use_npm install`
 * (up to 180s), `use_pypi install` (300s), a venv build (120s) or `listen`
 * holding the microphone (30s) didn't slow tiny down; they froze it, and the
 * user's only symptom was a dead terminal with a spinner that stopped spinning.
 *
 * This is also the thing devduck cannot hit and tiny must not: Python threads
 * with a blocking `subprocess.run` per conversation are independent, so devduck
 * gets concurrency for free where tiny has to earn it. One shared seam is how it
 * gets earned once instead of six times.
 *
 * ── what execFileSync gave us, kept ────────────────────────────────────────
 * Three guarantees the sync API provided implicitly, restated here because
 * losing any of them silently would be worse than the blocking was:
 *
 *  1. THE TIMEOUT REALLY KILLS. `timeout` on an async execFile still SIGTERMs
 *     the child, so a wedged install is still bounded — the property npm.ts's
 *     docblock relies on when it says "an in-process await cannot be killed".
 *     The error carries `killed`/`signal`, which callers already match on.
 *  2. FAILURES CARRY THEIR OUTPUT. execFileSync throws an error with `.stdout`
 *     and `.stderr` on it; the async callback hands them back separately
 *     instead, so they are reattached. Callers read `e.stderr` to turn
 *     ERR_MODULE_NOT_FOUND into "install it first" — that must keep working.
 *  3. STDIN IS CLOSED. Sync exec with no `input` still gave the child EOF.
 *     Async leaves the pipe OPEN, so a child that reads stdin (`say -f -`,
 *     `python3 -`) waits for an EOF that never arrives and hits the timeout
 *     instead — a hang that looks exactly like a slow package.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'

/** 8 MB, matching what every call site here already asked for. */
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024

export interface RunOpts {
  /** Hard leash. Required — an unbounded child is how a daemon wedges. */
  timeoutMs: number
  cwd?: string
  /** Written to the child's stdin, which is then closed either way. */
  input?: string
  env?: NodeJS.ProcessEnv
  maxBuffer?: number
}

/** What a failed run carries — the shape callers already destructure. */
export interface RunError extends Error {
  stdout: string
  stderr: string
  code?: number | string
  signal?: string
  killed?: boolean
}

/**
 * Run `bin args` to completion and resolve its stdout.
 *
 * Rejects on non-zero exit, on the timeout, and on a missing binary — with
 * stdout/stderr attached (guarantee 2). Never a shell: args are an array, so
 * nothing here interpolates user text into a command line.
 */
export function run(bin: string, args: string[], opts: RunOpts): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      encoding: 'utf-8',
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err as RunError, {
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        }))
        return
      }
      resolve(String(stdout ?? ''))
    })
    // Guarantee 3 — always closed, with or without input.
    //
    // The listener is not decoration. A child that exits BEFORE this line runs
    // leaves us closing a pipe with no reader, and the resulting EPIPE arrives
    // asynchronously as an 'error' EVENT on the stream — where the try/catch
    // below cannot see it and Node promotes it to an uncaught exception. That
    // kills the process: the test runner, or the daemon, over a child that
    // merely answered quickly. Measured with `xattr -px` on a file that has no
    // such attribute (it exits in ~1ms), which crashed one full-suite run in
    // three. The execFile callback already reports the child's real outcome, so
    // a broken stdin pipe is not news.
    child.stdin?.on('error', () => { /* the child is gone; its exit is the answer */ })
    try { child.stdin?.end(opts.input ?? '') } catch { /* child already gone */ }
  })
}

/**
 * The OTHER kind of child: one that never finishes on its own.
 *
 * `run()` above is for children with an answer — they print it, exit, and their
 * stdout IS the result. A microphone has no answer and no end: it produces
 * frames for as long as the call lasts (an hour, on the realtime API's cap), and
 * buffering that into a string would be both a memory leak and useless, since
 * every frame must reach the model WHILE the person is still talking.
 *
 * So this seam hands back the live process instead of a promise, and drops the
 * two things a stream cannot have: no `timeout` (the lifetime is the caller's —
 * hanging up is what ends it) and no `maxBuffer` (nothing is accumulated). What
 * it KEEPS is the property that made run() safe: argv array, never a shell, so
 * a device name out of `TINY_VOICE_INPUT` is data and not a command line.
 *
 * stderr is piped rather than inherited on purpose — ffmpeg narrates to stderr,
 * and inheriting it would scribble over the Ink TUI mid-render.
 */
export function stream(bin: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(bin, args, {
    env: opts?.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * Did this run time out, as opposed to failing on its own terms?
 *
 * Worth a named helper: `signal === 'SIGTERM'` alone is also what a child killed
 * by anything else reports, and "timed out after 180s" sent to the model for a
 * package that actually threw is a wrong diagnosis it will act on.
 */
export function timedOut(e: any): boolean {
  return !!(e?.killed && (e?.signal === 'SIGTERM' || e?.signal === 'SIGKILL'))
}
