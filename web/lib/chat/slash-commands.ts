/**
 * ⚡ Slash commands (extracted from Chat.tsx's ~440-line trySlashCommand;
 * bang.ts is the precedent) — the dispatch, parsing, and worker calls live
 * here; everything component-bound (panels, transcript refs, the house
 * confirm, live-call/ambient handles) is injected via SlashDeps.
 *
 * Deadlines for the fetches here come from lib/deadlines.
 *
 * Contract preserved exactly: returns true when the text WAS a command
 * (consumed — the composer must not send it as a chat turn), false when it
 * should flow to the model. Destructive actions confirm through the house
 * dialog inside an async IIFE — the command is still consumed synchronously.
 */

import { EXTERNAL_MS } from '../deadlines'
import { announceAutoResult } from './auto-outcome'

export type SlashMessage = {
  id: string
  role: string
  content: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadInputTokens?: number }
  modelId?: string
} & Record<string, any>

export type SlashDeps = {
  name: string
  /** Live transcript (messagesRef.current — the streaming source of truth). */
  getMessages: () => SlashMessage[]
  /** Replace the transcript (sets BOTH state and messagesRef in Chat). */
  setMessages: (msgs: SlashMessage[]) => void
  /** The seed system message (priv/systemPrompt closure stays in Chat). */
  buildSystemMessage: () => SlashMessage
  /** Resolve tools frozen at 'calling' in a restored archive. */
  reconcileInterruptedTools: (msgs: SlashMessage[]) => SlashMessage[]
  /** Live stream count — /save refuses to snapshot mid-stream. */
  streamingCount: () => number

  toast: {
    show: (msg: string, opts?: { duration?: number }) => void
    error: (msg: string) => void
  }
  confirm: (opts: { message: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>
  openPanel: (panel: 'settings' | 'memory' | 'jobs' | 'palette' | 'wallet') => void
  /** Full-page nav (window.location.href = path in Chat). */
  navigate: (path: string) => void
  /** Browser download (Blob + anchor click stays in Chat — not node-safe). */
  downloadFile: (filename: string, content: string) => void

  clearConversation: () => void
  share: () => void
  startLiveCall: () => void
  /**
   * ambientRef.current?.startAutonomous — undefined when ambient is off, which
   * is the "never even started" outcome announceAutoResult reports. `stopped`
   * separates the user's own interrupt (typing cancels a run) from a run that
   * ended on its own with nothing to show.
   */
  startAutonomous: (
    task: string,
    onIteration: (iter: number) => void,
  ) => Promise<{ text: string; stopped: boolean }> | undefined
  /**
   * The composer's LIVE contents. A getter, not a value: an /auto run resolves
   * minutes after dispatch, and announceAutoResult must not overwrite text the
   * user has typed since (typing is also what stops the run).
   */
  getInput: () => string
  /** Put text back in the composer — the retry path for a failed /auto. */
  setInput: (text: string) => void

  getMemories: (name: string) => { content: string }[]
  /**
   * Both return WHETHER the removal landed (v13 G2). `removeItem` throws
   * SecurityError when site data is fully blocked, and these two used to throw
   * out of the async IIFE below: the first throw skipped the SECOND wipe and
   * the toast, so half of /forgetall silently didn't happen and the user was
   * told nothing at all.
   */
  clearLocalMemories: (name: string) => boolean
  clearTurnLog: (name: string) => boolean

  downloadArchive: (name: string, msgs: SlashMessage[]) => void
  pickAndLoadArchive: () => Promise<{ tiny: string; exported: string; messages: unknown[] }>

  estimateCost: (modelId: string | undefined, usage: NonNullable<SlashMessage['usage']>) => number | null
  formatCost: (usd: number) => string
}

/**
 * The ⌘⇧K palette's command list — derived data, not a second hand-written
 * copy in Chat.tsx (which is how the two drifted before c15). `slash` invokes
 * run through trySlashCommand; `prefill` puts a template in the composer for
 * commands that need arguments. Tests pin that every slash invoke is consumed
 * by the dispatch below WITHOUT hitting the unknown-command fallback, and
 * that every dispatch case is either listed here or deliberately hidden.
 */
export type PaletteInvoke =
  | { kind: 'slash'; command: string }
  | { kind: 'prefill'; text: string }

export type PaletteEntry = {
  name: string
  description: string
  shortcut?: string
  invoke: PaletteInvoke
}

export const PALETTE_COMMANDS: PaletteEntry[] = [
  { name: 'clear', description: 'Clear conversation history', shortcut: '/clear', invoke: { kind: 'slash', command: '/clear' } },
  { name: 'settings', description: 'Model settings — bring your own API key', shortcut: '⌘,', invoke: { kind: 'slash', command: '/settings' } },
  { name: 'model', description: 'Switch model / provider', shortcut: '/model', invoke: { kind: 'slash', command: '/model' } },
  { name: 'archives', description: 'Cloud session archives — list and restore', shortcut: '/archives', invoke: { kind: 'slash', command: '/archives' } },
  { name: 'share', description: 'Share this conversation', invoke: { kind: 'slash', command: '/share' } },
  { name: 'export', description: 'Export conversation as markdown', invoke: { kind: 'slash', command: '/export' } },
  { name: 'save', description: 'Archive session as JSON (full fidelity)', shortcut: '/save', invoke: { kind: 'slash', command: '/save' } },
  { name: 'load', description: 'Restore a saved session archive', shortcut: '/load', invoke: { kind: 'slash', command: '/load' } },
  { name: 'memories', description: 'List stored memories (this browser)', invoke: { kind: 'slash', command: '/memories' } },
  { name: 'memory', description: 'Memory panel — live facts, history, provenance', invoke: { kind: 'slash', command: '/memory' } },
  { name: 'messages', description: 'Direct messages — inbox and threads', invoke: { kind: 'slash', command: '/messages' } },
  { name: 'jobs', description: 'Jobs panel — scheduled background jobs, runs, delete', invoke: { kind: 'slash', command: '/jobs' } },
  { name: 'devices', description: 'Devices — machines enrolled to your tiny identity', invoke: { kind: 'slash', command: '/devices' } },
  { name: 'map', description: "Live map — you, your tiny's pins, tiny users", shortcut: '/map', invoke: { kind: 'slash', command: '/map' } },
  { name: 'voice', description: 'Voice — real speech-to-speech call with this tiny', shortcut: '/voice', invoke: { kind: 'slash', command: '/voice' } },
  { name: 'call recordings', description: 'Past calls, replayable like podcast episodes', shortcut: '/calls', invoke: { kind: 'slash', command: '/calls' } },
  { name: 'wallet', description: 'Wallet — balance, earnings, payment history', invoke: { kind: 'slash', command: '/wallet' } },
  { name: 'auto', description: 'Autonomous mode — /auto <task> works until done', shortcut: '/auto', invoke: { kind: 'prefill', text: '/auto ' } },
  { name: 'loop', description: 'Background loop — /loop [5m] <prompt> runs on a schedule', shortcut: '/loop', invoke: { kind: 'prefill', text: '/loop ' } },
  { name: 'tools browse', description: "Marketplace — everyone's forged tools", shortcut: '/tools', invoke: { kind: 'slash', command: '/tools browse' } },
  { name: 'cost', description: 'Token usage + $ estimate for this conversation', shortcut: '/cost', invoke: { kind: 'slash', command: '/cost' } },
  { name: 'shares', description: 'My share links — list and revoke', shortcut: '/shares', invoke: { kind: 'slash', command: '/shares' } },
  { name: 'forgetall', description: 'Wipe all memories + turn log', invoke: { kind: 'slash', command: '/forgetall' } },
]

export function trySlashCommand(text: string, deps: SlashDeps): boolean {
  const { toast, name } = deps
  const t = text.trim()
  if (!t.startsWith('/')) return false
  const cmd = t.slice(1).split(/\s+/)[0].toLowerCase()
  switch (cmd) {
    case 'clear':
      // Delegate — a stale inline copy lived here (pattern #3): it skipped
      // the knowledge seed, the confirm, the scroll-to-hero, and the ?chat=
      // cleanup that handleClear carries.
      deps.clearConversation()
      return true
    case 'settings':
    case 'model':
      deps.openPanel('settings')
      return true
    case 'share':
      deps.share()
      return true
    case 'export': {
      // Named speakers ("you" / the tiny), titled + dated document, dated
      // filename — an export is a document, not a log dump
      const body = deps.getMessages()
        .filter((m) => m.role !== 'system')
        .map((m) => `**${m.role === 'user' ? 'you' : name}**: ${m.content}`)
        .join('\n\n---\n\n')
      const date = new Date().toISOString().slice(0, 10)
      const doc = `# Conversation with ${name}\n\n> tiny.technology/${name} · exported ${date}\n\n${body}\n`
      deps.downloadFile(`${name}-conversation-${date}.md`, doc)
      toast.show('📄 Exported as markdown!')
      return true
    }
    case 'tools': {
      // Trust model (issue #15): "/tools trust <owner>" is deliberately a
      // USER command — the model can't expand its own install allowlist
      const parts = t.slice(1).split(/\s+/)
      const sub = (parts[1] || '').toLowerCase()
      if (sub === 'trust' && parts[2]) {
        fetch('/api/tools/trust', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner: parts[2] }),
        })
          .then((r) => r.json())
          .then((d) => d.ok
            ? toast.show(`🤝 Trusted ${parts[2]} — install_tool now accepts their repos`)
            : toast.error(d.error || 'Failed'))
          .catch(() => toast.error('Failed'))
        return true
      }
      if (sub === 'untrust' && parts[2]) {
        fetch('/api/tools/trust', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner: parts[2] }),
        })
          .then((r) => r.json())
          .then((d) => d.ok ? toast.show(`Removed ${parts[2]} from trusted owners`) : toast.error(d.error || 'Failed'))
          .catch(() => toast.error('Failed'))
        return true
      }
      if (sub === 'browse') {
        // Marketplace listing — union of everyone's public forged tools
        const q = parts.slice(2).join(' ')
        // Deadlined like every other cross-origin call: "Marketplace
        // unreachable" is already the copy for a failure, and without a signal
        // an unreachable marketplace is the one case that never reaches it.
        fetch(`https://plugin.tiny.technology/tools/browse?limit=15${q ? `&q=${encodeURIComponent(q)}` : ''}`, { signal: AbortSignal.timeout(EXTERNAL_MS) })
          .then((r) => r.json())
          .then((d) => {
            const list: { name: string; author: string; description: string }[] = d.tools || []
            if (!list.length) { toast.show(q ? `🛍️ No tools matching "${q}"` : '🛍️ Marketplace is empty — forge the first tool!'); return }
            const text = list.map((tl) => `${tl.name} by @${tl.author} — ${tl.description}`).join('\n')
            navigator.clipboard?.writeText(text).catch(() => { })
            toast.show(`🛍️ ${list.length} tools (copied) — ask the agent to install one, e.g. "install ${list[0].name} from @${list[0].author}"`)
          })
          .catch(() => toast.error('Marketplace unreachable'))
        return true
      }
      // default: list trusted owners
      fetch('/api/tools/trust')
        .then((r) => r.json())
        .then((d) => {
          if (!d.ok) { toast.error(d.error || 'Login required'); return }
          toast.show(d.owners.length
            ? `🤝 Trusted owners: ${d.owners.join(', ')} — /tools untrust <owner> to remove`
            : 'No extra trusted owners. /tools trust <github-owner> to allow their repos in install_tool')
        })
        .catch(() => toast.error('Failed'))
      return true
    }
    case 'cost': {
      // 📊 Sum usage + $ estimates across the visible conversation
      const withUsage = deps.getMessages().filter((mm) => mm.usage && mm.usage.totalTokens > 0)
      if (!withUsage.length) { toast.show('📊 No usage recorded yet this conversation'); return true }
      let inTok = 0, outTok = 0, usd = 0, priced = 0
      withUsage.forEach((mm) => {
        inTok += mm.usage!.inputTokens
        outTok += mm.usage!.outputTokens
        const c = deps.estimateCost(mm.modelId, mm.usage!)
        if (c !== null) { usd += c; priced++ }
      })
      const total = inTok + outTok
      toast.show(
        `📊 ${withUsage.length} turns · ${total >= 1000 ? `${(total / 1000).toFixed(1)}K` : total} tok (${inTok} in / ${outTok} out)` +
        (priced ? ` · ~${deps.formatCost(usd)}${priced < withUsage.length ? ` (${priced}/${withUsage.length} turns priced)` : ''}` : '')
      )
      return true
    }
    case 'auto': {
      // Autonomous mode (issue #12): "/auto <task>" loops background turns
      // until [AMBIENT_DONE] or 5 iterations; typing interrupts.
      const task = t.slice(1).split(/\s+/).slice(1).join(' ').trim()
      if (!task) {
        toast.show('Usage: /auto <task> — e.g. /auto research edge caching strategies')
        return true
      }
      toast.show('🤖 Autonomous mode: working in the background — type anything to stop')
      // Every ending gets announced (c70). The old `if (last)` said nothing on
      // an empty result — which is exactly what a provider/network failure
      // looks like — while onSubmit had already destroyed the task text, so the
      // user had a dead chip and nothing to retry from. announceAutoResult owns
      // the wording and the restore decision.
      const announce = (result: { text: string; stopped: boolean } | undefined) => {
        const say = announceAutoResult({ command: t, result, currentInput: deps.getInput() })
        if (say.restore !== null) deps.setInput(say.restore)
        if (say.tone === 'error') toast.error(say.message)
        else toast.show(say.message)
      }
      const run = deps.startAutonomous(task, (iter) => toast.show(`🤖 Autonomous: iteration ${iter} done`))
      // A rejection is an ending too: `explore` swallows its own errors, but
      // anything thrown outside it (sessionStorage, a bad onProgress) would
      // otherwise be an unhandled rejection and, again, total silence.
      if (run) run.then(announce, () => announce({ text: '', stopped: false }))
      else announce(undefined)
      return true
    }
    case 'loop': {
      // "/loop [5m|2h] <prompt>" — a recurring background loop on the worker
      // scheduler (Claude Code /loop ergonomics; no interval → every 5m).
      // Unlike /auto (client-side, stops when you type), loops run
      // server-side forever until deleted: results land on the ⚡ activity
      // bus + push, run history in the jobs panel — never this chat.
      const largs = t.slice(1).split(/\s+/).slice(1)
      if (!largs.length) {
        toast.show('Usage: /loop [5m|30m|2h] <prompt> — background loop; watch it in /jobs, results in /activity')
        return true
      }
      const ival = /^(\d{1,4})(m|h)?$/.exec(largs[0].toLowerCase())
      const hasIval = !!ival && largs.length > 1
      const schedule = hasIval
        ? `*/${Math.max(1, parseInt(ival![1], 10))}${ival![2] || 'm'}`
        : '*/5m'
      const loopPrompt = (hasIval ? largs.slice(1) : largs).join(' ').trim()
      fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tiny: name,
          name: `loop: ${loopPrompt.slice(0, 34)}`,
          prompt: loopPrompt.slice(0, 2000),
          schedule,
        }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) {
            toast.show(`🔁 Loop armed — ${schedule} as ${name}. Results land in activity + push.`)
            deps.openPanel('jobs')
          } else toast.show(d.error || "Couldn't create the loop")
        })
        .catch(() => toast.error("Couldn't create the loop"))
      return true
    }
    case 'save': {
      // Session archive (issue #7): full-fidelity JSON — tool calls,
      // results, usage. "/save" downloads; "/save cloud" stores to the
      // account (private, 1y, any device via /load cloud).
      if (deps.streamingCount() > 0) {
        toast.show('⏳ Wait for the streaming replies to finish before saving.')
        return true
      }
      const saveMode = t.slice(1).split(/\s+/)[1]
      const body = deps.getMessages().filter((m) => m.role !== 'system')
      if (saveMode === 'cloud') {
        fetch('/api/archives', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tiny: name, messages: body }),
        })
          .then((r) => r.json())
          .then((d) => d.ok
            ? toast.show(`☁️ Archived to your account (${d.id}) — /load cloud on any device`)
            : toast.error(d.error || 'Cloud save failed'))
          .catch(() => toast.error('Cloud save failed'))
        return true
      }
      deps.downloadArchive(name, body)
      toast.show('💾 Session archived — restore with /load (or /save cloud for cross-device)')
      return true
    }
    case 'load': {
      const restoreMessages = async (msgs: SlashMessage[], label: string) => {
        // /load replaces the live transcript — confirm when there's a real
        // conversation to lose (the LESS destructive /clear already does)
        const liveTurns = deps.getMessages().some((m) => m.role === 'user')
        if (liveTurns && !(await deps.confirm({ message: 'Loading replaces your current conversation.', confirmLabel: 'Load' }))) return
        // Archives saved mid-stream carry tools frozen at 'calling' —
        // resolve them so restored cards don't spin forever
        const restored = deps.reconcileInterruptedTools([deps.buildSystemMessage(), ...msgs])
        deps.setMessages(restored)
        toast.show(`📂 Restored ${msgs.length} messages${label}`)
      }
      const loadParts = t.slice(1).split(/\s+/)
      if (loadParts[1] === 'cloud') {
        // "/load cloud" lists; "/load cloud <id>" restores
        if (loadParts[2]) {
          fetch(`/api/archives?id=${encodeURIComponent(loadParts[2])}`)
            .then((r) => r.json())
            .then((d) => {
              if (d?.tinyai_session && Array.isArray(d.messages)) restoreMessages(d.messages as SlashMessage[], ` from ☁️ ${d.tiny}`)
              else toast.error(d.error || 'Archive not found')
            })
            .catch(() => toast.error('Load failed'))
          return true
        }
        fetch('/api/archives')
          .then((r) => r.json())
          .then((d) => {
            const list: { id: string; tiny_name: string; msg_count: number }[] = d.archives || []
            if (d.error) { toast.error(d.error); return }
            if (!list.length) { toast.show('☁️ No cloud archives yet — /save cloud creates one'); return }
            const text = list.map((a) => `${a.id} — ${a.tiny_name} (${a.msg_count} msgs)`).join('\n')
            navigator.clipboard?.writeText(text).catch(() => { })
            toast.show(`☁️ ${list.length} archives (copied) — /load cloud <id> to restore, /archives delete <id> to remove`)
          })
          .catch(() => toast.error('List failed'))
        return true
      }
      deps.pickAndLoadArchive()
        .then((archive) => restoreMessages(archive.messages as SlashMessage[], ` from ${archive.tiny} (${archive.exported.slice(0, 10)})`))
        .catch((e) => toast.error(e.message || 'Load failed'))
      return true
    }
    case 'archives': {
      // "/archives delete <id>" — remove a cloud archive
      const aParts = t.slice(1).split(/\s+/)
      if (aParts[1] === 'delete' && aParts[2]) {
        fetch('/api/archives', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: aParts[2] }),
        })
          .then((r) => r.json())
          .then((d) => toast.show(d.ok ? '☁️🗑️ Archive deleted' : (d.error || 'Delete failed')))
          .catch(() => toast.error('Delete failed'))
        return true
      }
      return trySlashCommand('/load cloud', deps)
    }
    case 'messages': {
      // DMs live in the 💬 header HUD; the command surfaces a quick summary
      fetch('/api/messages')
        .then((r) => r.json())
        .then((d) => {
          if (d.error === 'login required') { toast.show('Sign in to see your messages'); return }
          const ts: any[] = d.threads || []
          if (ts.length === 0) { toast.show('💬 No conversations yet — ask me to send a message to someone'); return }
          const unreadTotal = ts.reduce((n, th) => n + (th.unread || 0), 0)
          const lines = ts.map((th) => `${th.unread ? `(${th.unread}) ` : ''}@${th.login || th.userId}: ${th.lastBody}`)
          navigator.clipboard?.writeText(lines.join('\n')).catch(() => { })
          toast.show(`💬 ${ts.length} conversation${ts.length === 1 ? '' : 's'}${unreadTotal ? `, ${unreadTotal} unread` : ''} — open the 💬 icon in the header`, { duration: 5000 })
        })
        .catch(() => toast.error('Failed to load messages'))
      return true
    }
    case 'memories': {
      const mems = deps.getMemories(name)
      if (mems.length === 0) {
        toast.show('No memories stored yet')
      } else {
        const summary = mems.map((mm) => `• ${mm.content}`).join('\n')
        navigator.clipboard?.writeText(summary).catch(() => {})
        toast.show(`🧠 ${mems.length} memories (copied to clipboard)`, { duration: 4000 })
      }
      return true
    }
    case 'memory': {
      // Server-side learnings (issue #14): "/memory" lists,
      // "/memory forget <id>" deletes one, "/memory clear" wipes all
      const parts = t.slice(1).split(/\s+/)
      if (parts[1] === 'forget' && parts[2]) {
        fetch('/api/learnings', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: parts[2] }),
        })
          .then((r) => r.json())
          .then((d) => toast.show(d.ok ? '🧬 Learning forgotten' : (d.error || 'Failed')))
          .catch(() => toast.error('Failed'))
        return true
      }
      if (parts[1] === 'clear') {
        // Command is consumed (return true) NOW; the destructive action is
        // gated behind the async house dialog.
        (async () => {
          if (!(await deps.confirm({ message: 'Clear ALL server-side learnings about you?', confirmLabel: 'Clear all', danger: true }))) return
          fetch('/api/learnings', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            // `scope:'all'` and not a bare `{}`: this is the one caller that
            // MEANS erase-everything, so it should say so rather than lean on
            // an absent id — the reading that used to make a blank id from a
            // single-row swipe erase the lot (lib/chat/learnings-delete-scope).
            body: JSON.stringify({ scope: 'all' }),
          })
            .then((r) => r.json())
            .then((d) => toast.show(d.ok ? '🧬 All learnings cleared' : (d.error || 'Failed')))
            .catch(() => toast.error('Failed'))
        })()
        return true
      }
      // Memory Panel: chips with freshness badges + closed-fact history
      deps.openPanel('memory')
      return true
    }
    case 'forgetall':
      // Destructive + irreversible (all browser memories AND the turn log,
      // across sessions) — command consumed now, action gated async
      (async () => {
        if (!(await deps.confirm({ message: "Wipe ALL memories and the turn log for this tiny? This can't be undone.", confirmLabel: 'Wipe all', danger: true }))) return
        // Both attempted before either is judged — a failure on the first must
        // not skip the second, which is what a throw used to do.
        const memsWiped = deps.clearLocalMemories(name)
        const logWiped = deps.clearTurnLog(name)
        if (memsWiped && logWiped) toast.show('🧠 All memories + turn log wiped')
        else toast.error("Couldn't wipe — browser storage is blocked, so some memories are still there")
      })()
      return true
    case 'jobs': {
      // Scheduled background jobs: "/jobs" lists, "/jobs delete <id>" removes
      const jparts = t.slice(1).split(/\s+/)
      if (jparts[1] === 'delete' && jparts[2]) {
        fetch('/api/jobs', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: jparts[2] }),
        })
          .then((r) => r.json())
          .then((d) => toast.show(d.ok ? '⏰ Job deleted' : (d.error || 'Failed')))
          .catch(() => toast.error('Failed'))
        return true
      }
      // Jobs Panel: cards with cadence, run history and delete
      deps.openPanel('jobs')
      return true
    }
    case 'devices':
      // Device registry lives on its own session-gated page (/devices) —
      // enroll/revoke need the one-time token reveal that a toast can't hold
      deps.navigate('/devices')
      return true
    case 'map':
      // Live map page — you, agent pins, opted-in tiny users. The 📍 toggle
      // stays the ambient-background way in; full-page nav because the page
      // owns be-seen + the HUD.
      deps.navigate('/map')
      return true
    case 'voice':
    case 'call':
      // Real speech-to-speech with this tiny — IN this chat: an in-call
      // strip appears over the composer, live transcripts land in the
      // thread, and typing joins the call as a user turn.
      deps.startLiveCall()
      return true
    case 'calls':
    case 'recordings':
      // Past calls as podcast episodes (/calls page; iOS "Call recordings"
      // menu parity). Full-page nav — the page owns its audio players.
      deps.navigate('/calls')
      return true
    case 'wallet':
      // Top up inline — the sheet keeps the conversation instead of a
      // full-page nav to /wallet (which it links to for history/withdraw).
      deps.openPanel('wallet')
      return true
    case 'shares': {
      // List my share links; "/shares revoke <id>" kills one.
      // Local tokens work anonymously; session ownership works cross-device.
      let local: { id: string; name: string; revokeToken: string }[] = []
      try { local = JSON.parse(localStorage.getItem('tiny_my_shares') || '[]') } catch { }
      const parts = t.slice(1).split(/\s+/)
      if (parts[1] === 'revoke' && parts[2]) {
        const target = local.find((s) => s.id === parts[2])
        fetch('/api/share', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          // Token if we have it locally; otherwise session ownership decides
          body: JSON.stringify({ id: parts[2], ...(target ? { revokeToken: target.revokeToken } : {}) }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (d.ok) {
              localStorage.setItem('tiny_my_shares', JSON.stringify(local.filter((s) => s.id !== parts[2])))
              toast.show('🗑️ Share link revoked')
            } else toast.error(d.error || 'Revoke failed')
          })
          .catch(() => toast.error('Revoke failed'))
        return true
      }
      // Merge account shares (logged in, cross-device) with local ones
      fetch('/api/share?mine=1')
        .then((r) => r.json())
        .then((d) => {
          const account: { id: string; tiny_name: string }[] = d.shares || []
          const seen = new Set(account.map((s) => s.id))
          const all = [
            ...account.map((s) => `${s.id} (/${s.tiny_name})`),
            ...local.filter((s) => !seen.has(s.id)).map((s) => `${s.id} (/${s.name})`),
          ]
          if (all.length === 0) { toast.show('No share links yet'); return }
          navigator.clipboard?.writeText(all.join('\n')).catch(() => { })
          toast.show(`🔗 ${all.length} share link${all.length === 1 ? '' : 's'} (ids copied) — revoke with /shares revoke <id>`)
        })
        .catch(() => {
          if (local.length === 0) { toast.show('No share links created from this browser'); return }
          navigator.clipboard?.writeText(local.map((s) => `${s.id} (/${s.name})`).join('\n')).catch(() => { })
          toast.show(`🔗 ${local.length} share link${local.length === 1 ? '' : 's'} (ids copied)`)
        })
      return true
    }
    case 'palette':
      deps.openPanel('palette')
      return true
    case 'help':
      // The palette IS the help — a searchable, clickable command list
      // beats a wall-of-text toast (you can't click a toast).
      deps.openPanel('palette')
      return true
    default:
      // Unknown → open the palette too (browsable recovery beats a
      // dead-end toast), with a quiet note about what didn't match.
      toast.show(`Unknown command: /${cmd}`)
      deps.openPanel('palette')
      return true
  }
}
