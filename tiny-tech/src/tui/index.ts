/** TUI bootstrap — kept separate so cli.ts lazy-imports ink only for `tui`. */
import React from 'react'
import { render } from 'ink'
import { TinyApi } from '../api.js'
import { loadCredentials, credentialsValid } from '../auth.js'
import { TinyAgent } from '../agent/agent.js'
import App from './App.js'

export async function runTui(): Promise<void> {
  // Ink needs a real TTY (raw mode). Piped/CI stdin → plain REPL fallback,
  // same agent, no crash.
  if (!process.stdin.isTTY) {
    const { runRepl } = await import('../agent/repl.js')
    process.stderr.write('tiny-tech: stdin is not a TTY — falling back to plain repl\n')
    return runRepl()
  }
  const api = new TinyApi()
  const creds = loadCredentials()
  const { maybeStartMesh } = await import('../agent/repl.js')
  const mesh = await maybeStartMesh()
  // printer OFF — Ink owns the screen; streamTurn feeds the transcript
  const agent = new TinyAgent({ api, printer: false, mesh })
  await agent.init()

  const who = credentialsValid(creds) ? `@${creds!.user.login}` : 'not logged in'
  const { waitUntilExit } = render(React.createElement(App, { agent, who }))
  await waitUntilExit()
  await mesh?.stop()
}
