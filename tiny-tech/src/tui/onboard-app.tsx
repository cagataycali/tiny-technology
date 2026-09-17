/**
 * 🍕 Onboarding TUI — the first-run experience, in Ink.
 *
 * The readline wizard in onboard.ts survives as the piped/CI fallback (its
 * line-queue is what makes heredoc-driven tests possible); THIS is what a
 * human at a real TTY sees: an animated landing, arrow-key provider
 * selection, masked key entry, and a live sync step — the same store,
 * the same PROVIDERS/VOICES lists, one schema, two faces (same rule as
 * render.ts ⇄ components.tsx).
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, render, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { apiHost } from '../config.js'
import { SelectList } from './select.js'
import { LogoFrame } from './logo.js'
import type { TinyApi } from '../api.js'
import {
  PROVIDERS, VOICES,
  loadModelConfig, saveModelConfig, modelConfigPath,
  pushToCloud, pullFromCloud, applyModelEnv,
  type ModelConfigStore,
} from '../onboard.js'

/** ink-spinner's Element type predates React 19's JSX — a 10-line local
 *  spinner (same as App.tsx's) beats a cast. */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
function Spinner({ color = 'yellow' }: { color?: string }) {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % SPIN.length), 80)
    return () => clearInterval(t)
  }, [])
  return <Text color={color}>{SPIN[i]}</Text>
}

// ─── landing animation ───────────────────────────────────────────────────────
// Block letters + rainbow live in logo.tsx — shared with the main TUI's boot
// splash so the two screens cannot drift apart.

const TAGLINE = `${apiHost()} — your identity, on every surface`

function Landing({ onDone }: { onDone: () => void }) {
  const [frame, setFrame] = useState(0)
  const [chars, setChars] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 90)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    const t = setInterval(() => setChars((c) => Math.min(c + 1, TAGLINE.length)), 28)
    return () => clearInterval(t)
  }, [])
  // auto-advance once the typewriter lands (plus a beat), or on any key
  useEffect(() => {
    if (chars >= TAGLINE.length) { const t = setTimeout(onDone, 700); return () => clearTimeout(t) }
  }, [chars, onDone])
  useInput(() => onDone())
  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <LogoFrame frame={frame} />
      <Box marginTop={1}>
        <Text dimColor>{TAGLINE.slice(0, chars)}<Text color="cyan">{chars < TAGLINE.length ? '▌' : ' '}</Text></Text>
      </Box>
    </Box>
  )
}

// ─── provider select ─────────────────────────────────────────────────────────

function ProviderMenu({ store, onPick, onDone }: {
  store: ModelConfigStore
  onPick: (id: string) => void
  onDone: () => void
}) {
  const [cursor, setCursor] = useState(0)
  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => (c + PROVIDERS.length) % (PROVIDERS.length + 1) === 0 ? PROVIDERS.length : (c - 1 + PROVIDERS.length + 1) % (PROVIDERS.length + 1))
    else if (key.downArrow) setCursor((c) => (c + 1) % (PROVIDERS.length + 1))
    else if (key.return) cursor === PROVIDERS.length ? onDone() : onPick(PROVIDERS[cursor].id)
    else if (key.escape) onDone()
  })
  return (
    <Box flexDirection="column">
      <Text bold>🍕 Pick your model providers <Text dimColor>— as many as you like; one is active</Text></Text>
      <Text dimColor>   stored 0600 at {modelConfigPath()}, synced to your tiny account</Text>
      <Box flexDirection="column" marginTop={1}>
        {PROVIDERS.map((p, i) => {
          const have = !!store.providers[p.id]
          const mark = store.active === p.id ? '★' : have ? '✓' : ' '
          const sel = i === cursor
          return (
            <Text key={p.id} color={sel ? 'cyan' : undefined} inverse={sel}>
              {sel ? '❯' : ' '} <Text color={mark === '★' ? 'yellow' : mark === '✓' ? 'green' : undefined}>{mark}</Text> {p.label}
            </Text>
          )
        })}
        <Text color={cursor === PROVIDERS.length ? 'cyan' : 'green'} inverse={cursor === PROVIDERS.length}>
          {cursor === PROVIDERS.length ? '❯' : ' '} ✔ Done{Object.keys(store.providers).length ? ` (${Object.keys(store.providers).length} configured)` : ''}
        </Text>
      </Box>
      <Text dimColor>↑↓ move · Enter select · Esc done</Text>
    </Box>
  )
}

// ─── per-provider form ───────────────────────────────────────────────────────

function ProviderForm({ store, providerId, onSaved }: {
  store: ModelConfigStore
  providerId: string
  onSaved: () => void
}) {
  const def = PROVIDERS.find((p) => p.id === providerId)!
  const existing = store.providers[providerId]
  const fields = useMemo(() => {
    const f: { key: 'apiKey' | 'region' | 'baseUrl' | 'modelId'; label: string; mask?: boolean; def?: string }[] = []
    if (def.id !== 'ollama') f.push({ key: 'apiKey', label: existing?.apiKey ? 'API key (Enter = keep current)' : `API key${def.keyHint ? ` (${def.keyHint})` : ''}`, mask: true })
    if (def.extra === 'region') f.push({ key: 'region', label: 'region', def: existing?.region || 'us-east-1' })
    if (def.extra === 'baseUrl') f.push({ key: 'baseUrl', label: 'base URL (https://host/v1)', def: existing?.baseUrl })
    f.push({ key: 'modelId', label: 'model id (Enter = default)', def: existing?.modelId })
    return f
  }, [def, existing])
  const [step, setStep] = useState(0)
  const [value, setValue] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})

  const submit = (v: string) => {
    const next = { ...answers, [fields[step].key]: v.trim() || fields[step].def || '' }
    setAnswers(next); setValue('')
    if (step + 1 < fields.length) { setStep(step + 1); return }
    store.providers[providerId] = {
      provider: providerId,
      apiKey: next.apiKey || existing?.apiKey || '',
      modelId: next.modelId || '',
      baseUrl: next.baseUrl || '',
      region: next.region || '',
      updatedAt: Math.floor(Date.now() / 1000),
    }
    if (!store.active) store.active = providerId
    saveModelConfig(store)
    onSaved()
  }
  const f = fields[step]
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">{def.label}</Text>
      {fields.slice(0, step).map((d) => (
        <Text key={d.key} dimColor>  ✓ {d.key}: {d.mask ? '••••' : answers[d.key] || d.def || '(default)'}</Text>
      ))}
      <Box>
        <Text>  {f.label}: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask={f.mask ? '*' : undefined} />
      </Box>
    </Box>
  )
}

// ─── simple pickers ──────────────────────────────────────────────────────────

function Picker({ title, items, initial, onPick }: {
  title: string; items: { id: string; label: string }[]; initial: number; onPick: (id: string) => void
}) {
  const [cursor, setCursor] = useState(Math.max(0, initial))
  useInput((_i, key) => {
    if (key.upArrow) setCursor((c) => (c - 1 + items.length) % items.length)
    else if (key.downArrow) setCursor((c) => (c + 1) % items.length)
    else if (key.return || key.escape) onPick(items[cursor].id)
  })
  // The shared control (select.tsx) — the same rows the slash menu draws, so
  // picking a voice here and picking a command in the TUI are one gesture.
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Box marginTop={1}>
        <SelectList
          items={items.map((it) => ({ key: it.id, label: it.label }))}
          cursor={cursor}
          maxRows={12}
          hint="↑↓ move · Enter select"
        />
      </Box>
    </Box>
  )
}

// ─── done / sync ─────────────────────────────────────────────────────────────

function Finish({ api, store }: { api: TinyApi; store: ModelConfigStore }) {
  const { exit } = useApp()
  const [state, setState] = useState<'syncing' | 'done'>('syncing')
  const [syncMsg, setSyncMsg] = useState('')
  useEffect(() => {
    ;(async () => {
      store.onboarded = true
      saveModelConfig(store)
      if (api.authenticated) {
        const r = await pushToCloud(api, store)
        setSyncMsg(r.error ? `⚠ cloud sync failed (${r.error}) — saved locally; \`tiny-tech sync\` later` : `✓ synced to ${apiHost()} — your other devices will pick this up`)
      } else {
        setSyncMsg('· not logged in — `tiny-tech login` then `tiny-tech sync` to sync across devices')
      }
      applyModelEnv()
      setState('done')
      setTimeout(exit, 60)
    })()
  }, [])
  const active = store.active
  const modelId = active ? store.providers[active]?.modelId : ''
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
      <Text bold color="green">✓ saved {modelConfigPath()}</Text>
      {state === 'syncing'
        ? <Text><Spinner /> syncing…</Text>
        : <Text dimColor>{syncMsg}</Text>}
      {active && <Text>Active: <Text bold color="yellow">{active}{modelId ? `:${modelId}` : ''}</Text> — try <Text color="cyan">tiny-tech</Text></Text>}
    </Box>
  )
}

// ─── app ─────────────────────────────────────────────────────────────────────

type Phase = 'landing' | 'pull-offer' | 'menu' | 'form' | 'active' | 'voice' | 'finish'

function OnboardApp({ api, cloudCount }: { api: TinyApi; cloudCount: number }) {
  const store = useMemo(() => loadModelConfig(), [])
  const [phase, setPhase] = useState<Phase>('landing')
  const [editing, setEditing] = useState('')
  const [pulling, setPulling] = useState(false)

  const afterLanding = () => setPhase(cloudCount > 0 && !Object.keys(store.providers).length ? 'pull-offer' : 'menu')

  if (phase === 'landing') return <Landing onDone={afterLanding} />

  if (phase === 'pull-offer') {
    return pulling ? (
      <Text><Spinner /> pulling {cloudCount} provider(s) from {apiHost()}…</Text>
    ) : (
      <Picker
        title={`☁️  Found ${cloudCount} provider(s) on your tiny account — pull them to this machine?`}
        items={[{ id: 'yes', label: 'Yes — pull them' }, { id: 'no', label: 'No — configure fresh' }]}
        initial={0}
        onPick={async (id) => {
          if (id === 'yes') {
            setPulling(true)
            await pullFromCloud(api, store)
            saveModelConfig(store)
          }
          setPhase('menu')
        }}
      />
    )
  }

  if (phase === 'menu') return (
    <ProviderMenu
      store={store}
      onPick={(id) => { setEditing(id); setPhase('form') }}
      onDone={() => {
        const names = Object.keys(store.providers)
        setPhase(names.length > 1 ? 'active' : 'voice')
      }}
    />
  )

  if (phase === 'form') return (
    <ProviderForm store={store} providerId={editing} onSaved={() => setPhase('menu')} />
  )

  if (phase === 'active') {
    const names = Object.keys(store.providers)
    return (
      <Picker
        title="★ Which provider is ACTIVE?"
        items={names.map((n) => ({ id: n, label: `${n}${store.providers[n].modelId ? ` (${store.providers[n].modelId})` : ''}` }))}
        initial={Math.max(0, names.indexOf(store.active))}
        onPick={(id) => { store.active = id; saveModelConfig(store); setPhase('voice') }}
      />
    )
  }

  if (phase === 'voice') return (
    <Picker
      title="🎙️  Voice for live calls"
      items={VOICES.map((v) => ({ id: v, label: v }))}
      initial={Math.max(0, (VOICES as readonly string[]).indexOf(store.voice || 'marin'))}
      onPick={(id) => { store.voice = id; saveModelConfig(store); setPhase('finish') }}
    />
  )

  return <Finish api={api} store={store} />
}

/** TTY entry — cli.ts routes here when stdin is a real terminal; the
 *  readline wizard remains the piped/CI path. */
export async function runOnboardTui(api: TinyApi): Promise<void> {
  let cloudCount = 0
  if (api.authenticated) {
    try {
      const r = await api.get('/api/model-providers')
      if (r?.ok && Array.isArray(r.providers)) cloudCount = r.providers.length
    } catch { /* offline — wizard continues */ }
  }
  const { waitUntilExit } = render(<OnboardApp api={api} cloudCount={cloudCount} />)
  await waitUntilExit()
}
