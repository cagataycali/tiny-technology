/**
 * tiny TUI — Ink (React for terminals; the Claude Code / Gemini CLI stack).
 *
 * Clean agent surface:
 *   header    identity · model · mode
 *   transcript scrolling turn history (user / assistant / tool chips)
 *   status    spinner + active tool while streaming
 *   composer  bordered input, Esc = clear, double ^C = exit
 *
 * /loop — autonomous mode (devduck ambient/auto style):
 *   toggle with `/loop` (or `/loop <task>` to set the goal + start)
 *   after every turn, once the user is idle for 3s, tiny keeps working
 *   on the last task by itself. Typing cancels the pending iteration.
 *   The agent stops the loop by including [LOOP_DONE] in a response.
 */
import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Text, useApp, useInput, Static } from 'ink'
import TextInput from 'ink-text-input'
import InkSpinner from 'ink-spinner'

// ink-spinner ships React-18-era types — cast keeps strict JSX happy on React 19
const Spinner = InkSpinner as unknown as React.FC<{ type?: string }>
import type { TinyAgent, TurnEvent } from '../agent/agent.js'
import { renderMarkdown } from './markdown.js'
import { appendHistory, loadInputHistory } from '../agent/history.js'

const LOOP_IDLE_MS = 3000
const LOOP_MAX_ITERATIONS = 100
const LOOP_DONE_SIGNALS = ['[LOOP_DONE]', '[AMBIENT_DONE]', '[TASK_COMPLETE]']
const SLASH_COMMANDS = ['/loop', '/help']

interface ToolChip { name: string; done: boolean; error?: string }
interface Turn {
  id: number
  role: 'user' | 'assistant'
  text: string
  tools: ToolChip[]
  error?: string
  loop?: boolean          // auto-generated loop iteration
  shell?: boolean         // !cmd shell escape output
}

export interface AppProps {
  agent: TinyAgent
  who: string
}

export default function App({ agent, who }: AppProps) {
  const { exit } = useApp()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<Turn[]>([])       // completed turns (Static)
  const [live, setLive] = useState<Turn | null>(null)       // streaming turn
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [loopMode, setLoopMode] = useState(false)
  const [loopCountdown, setLoopCountdown] = useState(false) // idle timer armed
  const idRef = useRef(0)
  const lastCtrlC = useRef(0)
  // ↑/↓ input recall — seeded from ~/.tiny_history, session inputs appended
  const inputHistory = useRef<string[]>(loadInputHistory())
  const histIdx = useRef(-1)              // -1 = live input (not browsing)
  const draft = useRef('')                // stashed live input while browsing
  const [suggestion, setSuggestion] = useState('')
  const loopTask = useRef<string | null>(null)               // goal the loop works on
  const loopIter = useRef(0)
  const loopTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busyRef = useRef(false)
  const loopModeRef = useRef(false)

  busyRef.current = busy
  loopModeRef.current = loopMode

  const clearLoopTimer = useCallback(() => {
    if (loopTimer.current) { clearTimeout(loopTimer.current); loopTimer.current = null }
    setLoopCountdown(false)
  }, [])

  const stopLoop = useCallback((note?: string) => {
    clearLoopTimer()
    setLoopMode(false)
    loopModeRef.current = false
    loopTask.current = null
    loopIter.current = 0
    if (note) {
      setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: note, tools: [] }])
    }
  }, [clearLoopTimer])

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      const now = Date.now()
      if (now - lastCtrlC.current < 2000) exit()
      lastCtrlC.current = now
      if (loopModeRef.current) stopLoop('↻ loop stopped (^C)')
    }
    if (key.escape) {
      setInput('')
      setSuggestion('')
      histIdx.current = -1
      if (loopModeRef.current) clearLoopTimer() // typing intent — hold the loop
    }
    // ↑/↓ — recall past inputs (shell-style)
    if (key.upArrow && !busyRef.current) {
      const h = inputHistory.current
      if (!h.length) return
      if (histIdx.current === -1) { draft.current = input; histIdx.current = h.length }
      if (histIdx.current > 0) {
        histIdx.current -= 1
        setInput(h[histIdx.current])
        setSuggestion('')
      }
    }
    if (key.downArrow && !busyRef.current) {
      const h = inputHistory.current
      if (histIdx.current === -1) return
      histIdx.current += 1
      if (histIdx.current >= h.length) {
        histIdx.current = -1
        setInput(draft.current)
      } else {
        setInput(h[histIdx.current])
      }
      setSuggestion('')
    }
    // Tab — accept autocomplete suggestion
    if (key.tab && suggestion && !busyRef.current) {
      setInput(suggestion)
      setSuggestion('')
    }
  })

  /** Run one agent turn (shared by user submits and loop iterations). */
  const runTurn = useCallback(async (q: string, isLoop: boolean) => {
    const userTurn: Turn = { id: ++idRef.current, role: 'user', text: q, tools: [], loop: isLoop }
    setHistory((h) => [...h, userTurn])

    const turn: Turn = { id: ++idRef.current, role: 'assistant', text: '', tools: [], loop: isLoop }
    setBusy(true)
    busyRef.current = true
    setLive({ ...turn })

    try {
      for await (const ev of agent.streamTurn(q)) {
        applyEvent(turn, ev)
        if (ev.kind === 'tool_start') setActiveTool(ev.name || 'tool')
        if (ev.kind === 'tool_end') setActiveTool(null)
        setLive({ ...turn, tools: [...turn.tools] })
      }
    } catch (e: any) {
      turn.error = String(e?.message || e)
    }

    setHistory((h) => [...h, { ...turn, tools: [...turn.tools] }])
    setLive(null)
    setActiveTool(null)
    setBusy(false)
    busyRef.current = false

    if (!isLoop) appendHistory(q, turn.text || turn.error)

    // Loop completion signal?
    if (loopModeRef.current && LOOP_DONE_SIGNALS.some((s) => turn.text.includes(s))) {
      stopLoop(`↻ loop complete after ${loopIter.current} iteration${loopIter.current === 1 ? '' : 's'}`)
    }
  }, [agent, stopLoop])

  const submit = useCallback(async (value: string) => {
    const q = value.trim()
    if (!q || busy) return
    setInput('')
    setSuggestion('')
    histIdx.current = -1
    if (inputHistory.current[inputHistory.current.length - 1] !== q) inputHistory.current.push(q)
    clearLoopTimer()

    if (['exit', 'quit', 'q'].includes(q.toLowerCase())) { exit(); return }

    // !cmd — shell escape: run locally, show output, inject exchange into
    // agent history so the agent has the context on subsequent turns.
    if (q.startsWith('!') && q.length > 1) {
      const cmd = q.slice(1).trim()
      setHistory((h) => [...h, { id: ++idRef.current, role: 'user', text: q, tools: [] }])
      setBusy(true)
      busyRef.current = true
      let out = ''
      let failed = false
      try {
        const { execSync } = await import('node:child_process')
        out = execSync(cmd, { encoding: 'utf-8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e: any) {
        failed = true
        out = String(e?.stdout || '') + String(e?.stderr || e?.message || e)
      }
      const shown = out.length > 8000 ? out.slice(0, 8000) + `\n… (${out.length - 8000} more chars truncated)` : out
      setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: shown || '(no output)', tools: [], shell: true, error: failed ? 'command failed' : undefined }])
      // Inject into agent conversation so it sees what happened
      agent.injectExchange(
        `I ran this shell command myself: \`${cmd}\``,
        'Command ' + (failed ? 'FAILED' : 'succeeded') + '. Output:\n```\n' + (shown || '(no output)') + '\n```',
      )
      setBusy(false)
      busyRef.current = false
      return
    }

    // /loop — toggle autonomous mode; optional inline task: /loop refactor the parser
    if (q === '/loop' || q.startsWith('/loop ')) {
      const arg = q.slice(5).trim()
      if (loopMode && !arg) { stopLoop('↻ loop stopped'); return }
      const task = arg || loopTask.current || lastUserTask(history)
      if (!task) {
        setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: '↻ nothing to loop on — give me a task first (`/loop <task>` or ask something, then `/loop`)', tools: [] }])
        return
      }
      loopTask.current = task
      loopIter.current = 0
      setLoopMode(true)
      loopModeRef.current = true
      setHistory((h) => [...h, { id: ++idRef.current, role: 'assistant', text: `↻ loop ON — working on: "${task.slice(0, 120)}"\n  fires ${LOOP_IDLE_MS / 1000}s after you stop typing · \`/loop\` again or ^C to stop · agent says [LOOP_DONE] when finished`, tools: [] }])
      return
    }

    loopTask.current = q // any new query becomes the loop's task
    await runTurn(q, false)
  }, [busy, history, loopMode, clearLoopTimer, stopLoop, runTurn, exit])

  // Typing resets the idle timer — loop only fires after 3s of silence.
  const onInputChange = useCallback((v: string) => {
    setInput(v)
    histIdx.current = -1
    if (loopModeRef.current) clearLoopTimer()
    // autocomplete: slash commands first, then history prefix match
    if (v.length >= 1) {
      const slash = SLASH_COMMANDS.find((c) => c.startsWith(v) && c !== v)
      if (slash) { setSuggestion(slash); return }
      if (v.length >= 2) {
        const h = inputHistory.current
        for (let i = h.length - 1; i >= 0; i--) {
          if (h[i].startsWith(v) && h[i] !== v) { setSuggestion(h[i]); return }
        }
      }
    }
    setSuggestion('')
  }, [clearLoopTimer])

  // Arm the loop timer whenever: loop on, not busy, input empty.
  useEffect(() => {
    if (!loopMode || busy || input.length > 0 || !loopTask.current) return
    if (loopIter.current >= LOOP_MAX_ITERATIONS) {
      stopLoop(`↻ loop hit max iterations (${LOOP_MAX_ITERATIONS})`)
      return
    }
    setLoopCountdown(true)
    loopTimer.current = setTimeout(() => {
      loopTimer.current = null
      setLoopCountdown(false)
      if (!loopModeRef.current || busyRef.current) return
      loopIter.current += 1
      const prompt =
        `You're in autonomous /loop mode (iteration ${loopIter.current}). ` +
        `Keep making concrete progress on: "${loopTask.current}". ` +
        `Take the next step now. When the task is truly complete, include [LOOP_DONE] in your response.`
      void runTurn(prompt, true)
    }, LOOP_IDLE_MS)
    return () => { if (loopTimer.current) { clearTimeout(loopTimer.current); loopTimer.current = null } }
  }, [loopMode, busy, input, runTurn, stopLoop])

  return (
    <Box flexDirection="column">
      {/* Completed turns — Static renders once, scrolls naturally */}
      <Static items={[{ id: -1 } as any, ...history]}>
        {(item: any) =>
          item.id === -1 ? (
            <Box key="header" flexDirection="column" marginBottom={1}>
              <Box>
                <Text color="green" bold>🌱 tiny</Text>
                <Text dimColor> · {who} · {agent.modelLabel}{agent.isLocal ? '' : ' (server proxy)'}</Text>
              </Box>
              {/* The user's own tools. A file that failed to load is theirs to
                  fix, and the TUI is the default surface — without this line the
                  only symptom is a tool that quietly isn't there. */}
              {agent.localTools && agent.localTools.loaded.length > 0 && (
                <Text dimColor>  🔧 {agent.localTools.loaded.map((t) => t.name).join(' ')}</Text>
              )}
              {agent.localTools?.skipped.map((s) => (
                <Text key={s.file} color="yellow">  ⚠️  {s.file}: {s.reason}</Text>
              ))}
              <Text dimColor>  Esc clears · double ^C or 'exit' quits · /loop = autonomous · !cmd = shell</Text>
            </Box>
          ) : (
            <TurnView key={item.id} turn={item} />
          )
        }
      </Static>

      {/* Live streaming turn */}
      {live && <TurnView turn={live} streaming />}

      {/* Status line */}
      {busy && (
        <Box marginTop={0}>
          <Text color="yellow"><Spinner type="dots" /></Text>
          <Text dimColor> {activeTool ? `running ${activeTool}…` : 'thinking…'}</Text>
          {loopMode && <Text color="magenta"> ↻ loop #{loopIter.current}</Text>}
        </Box>
      )}
      {!busy && loopMode && (
        <Box marginTop={0}>
          <Text color="magenta">↻ </Text>
          <Text dimColor>
            {loopCountdown ? `loop armed — continuing in ${LOOP_IDLE_MS / 1000}s unless you type…` : 'loop on — waiting for idle'}
            {` (iter ${loopIter.current})`}
          </Text>
        </Box>
      )}

      {/* Composer */}
      <Box borderStyle="round" borderColor={busy ? 'gray' : loopMode ? 'magenta' : 'green'} paddingX={1} marginTop={1}>
        <Text color={loopMode ? 'magenta' : 'green'}>{loopMode ? '↻ ' : '> '}</Text>
        <TextInput
          value={input}
          onChange={onInputChange}
          onSubmit={submit}
          placeholder={busy ? 'streaming… (input queued after)' : loopMode ? 'type to interrupt loop · /loop to stop' : 'ask tiny anything · /loop = autonomous'}
          focus={!busy}
        />
        {suggestion && input && suggestion.startsWith(input) ? (
          <Text dimColor>{suggestion.slice(input.length)} ⇥</Text>
        ) : null}
      </Box>
    </Box>
  )
}

/** Most recent real user query (for `/loop` with no explicit task). */
function lastUserTask(history: Turn[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]
    if (t.role === 'user' && !t.loop && !t.text.startsWith('/')) return t.text
  }
  return null
}

function applyEvent(turn: Turn, ev: TurnEvent) {
  switch (ev.kind) {
    case 'text': turn.text += ev.text; break
    case 'tool_start': turn.tools.push({ name: ev.name || 'tool', done: false }); break
    case 'tool_end': {
      const t = [...turn.tools].reverse().find((x) => x.name === (ev.name || 'tool') && !x.done)
        || turn.tools.find((x) => !x.done)
      if (t) { t.done = true; t.error = ev.error }
      break
    }
    case 'error': turn.error = ev.message; break
    case 'done': if (ev.text && !turn.text) turn.text = ev.text; break
  }
}

function TurnView({ turn, streaming = false }: { turn: Turn; streaming?: boolean }) {
  if (turn.role === 'user') {
    if (turn.loop) {
      return (
        <Box marginTop={1}>
          <Text color="magenta" bold>{'↻ '}</Text>
          <Text dimColor>loop iteration continues…</Text>
        </Box>
      )
    }
    return (
      <Box marginTop={1}>
        <Text color="cyan" bold>{'❯ '}</Text>
        <Text color="cyan">{turn.text}</Text>
      </Box>
    )
  }
  if (turn.shell) {
    return (
      <Box flexDirection="column" marginTop={0} paddingLeft={2}>
        <Text dimColor>{turn.text}</Text>
        {turn.error ? <Text color="red">✗ {turn.error}</Text> : null}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {turn.tools.length > 0 && (
        <Box flexDirection="column">
          {turn.tools.map((t, i) => (
            <Box key={i}>
              <Text color={t.error ? 'red' : t.done ? 'green' : 'yellow'}>
                {t.error ? '✗' : t.done ? '✓' : '⚙'}
              </Text>
              <Text dimColor> {t.name}{t.error ? ` — ${t.error.slice(0, 80)}` : ''}</Text>
            </Box>
          ))}
        </Box>
      )}
      {turn.text ? <Text>{renderMarkdown(turn.text, { streaming })}</Text> : null}
      {turn.error && !turn.text ? <Text color="red">error: {turn.error}</Text> : null}
    </Box>
  )
}
