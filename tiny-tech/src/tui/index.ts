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
  // announce:false — the mesh's stderr peer-join/leave lines are fine under a
  // readline REPL but corrupt an Ink-owned screen (every heartbeat-discovered
  // peer printed a raw line THROUGH the live panels). The TUI shows peers its
  // own way: a live count by the composer and /peers on demand.
  const mesh = await maybeStartMesh(undefined, { announce: false })
  // printer OFF — Ink owns the screen; streamTurn feeds the transcript
  const agent = new TinyAgent({ api, printer: false, mesh })

  // 🌈 Boot splash: the onboarding logo animates WHILE the agent initializes,
  // then clears itself — the App's live header takes over with the SAME logo,
  // still animating, so the handoff is seamless and nothing prints twice.
  // Init errors surface after the splash steps aside.
  const initP = agent.init()
  {
    const { Splash } = await import('./logo.js')
    await new Promise<void>((done) => {
      const splash = render(React.createElement(Splash, { until: initP, onDone: () => {
        // Clear THEN unmount: the header inside App now carries the rainbow
        // wordmark, so the splash erases its frames instead of leaving one —
        // otherwise every boot would print the logo twice back to back.
        splash.clear()
        splash.unmount()
        done()
      } }))
    })
  }
  await initP

  const who = credentialsValid(creds) ? `@${creds!.user.login}` : 'not logged in'
  const { waitUntilExit } = render(React.createElement(App, { agent, who, mesh }))
  await waitUntilExit()
  await mesh?.stop()
}
