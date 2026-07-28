// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildSoulPrompt, buildDeviceBlock, capabilitySummary, parseCapabilities, economyBlock, walletFundsPhrase, DEVICE_LABELS, type SoulPromptInputs } from '../lib/chat/prompt'
import { EMITTED_KINDS } from '../lib/chat/event-icons'

const base: SoulPromptInputs = {
  tinyName: 'testy',
  tinyData: { name: 'testy', systemPrompt: 'You are a test fixture.', systemKnowledge: 'KB text', data: 'DATA text' },
  tinyStats: { tinyMessageCount: 42, todayMessageCount: 7, viewCount: 999 },
  retrieveSummary: [{ name: 'other-tiny' }],
  clientMetadata: 'locale=en',
  userContext: '# User: @tester',
  memoryBlock: '# Memory block here',
  userEvents: [],
  systemMessages: '',
  tinySystemPrompt: '',
  tinySession: 'sess-1',
  messageIndex: 3,
}

describe('buildSoulPrompt', () => {
  it('carries identity, stats, and context blocks', () => {
    const p = buildSoulPrompt(base)
    expect(p).toContain('# You are testy.')
    expect(p).toContain('You are a test fixture.')
    expect(p).toContain('KB text')
    expect(p).toContain('42 messages to date (7 today), 999 views')
    expect(p).toContain('other-tiny')
    expect(p).toContain('# User: @tester')
    expect(p).toContain('# Memory block here')
    expect(p).toContain('- Message Index: 3')
  })

  it('meta-agent fallback when no system prompt is set', () => {
    const p = buildSoulPrompt({ ...base, tinyData: { name: 'testy' } })
    expect(p).toContain('platform meta-agent')
  })

  /**
   * ⚠️ EVERY EMITTED KIND REACHES THE AGENT AS SEVERITY, NOT AS ℹ.
   *
   * The block's own header tells the model to "mention anything relevant", so
   * this column is how it decides what to raise. `|| 'ℹ'` is correct for a kind a
   * newer worker invented and wrong for one we ship — and both render the same,
   * which is why `pay_alarm` ("🚨 x402 reconciliation needs a human", emitted
   * every minute by reconcile-alarm.ts) sat in the prompt with the icon for
   * "informational", beside a page view. tool-update and all three telegram_*
   * were unmapped too.
   *
   * Imported from event-icons so BOTH surfaces answer to one roster: the HUD and
   * the prompt use different vocabularies on purpose, but they must not disagree
   * about which events exist.
   */
  it('every kind the worker emits reaches the agent with its own icon, not ℹ', () => {
    const p = buildSoulPrompt({
      ...base,
      userEvents: EMITTED_KINDS.map((kind) => ({ kind, detail: 'd', created: 1750000000 })),
    })
    for (const kind of EMITTED_KINDS) {
      expect(p, `${kind} renders as ℹ — add an EVENT_ICONS entry`)
        .not.toContain(`ℹ ${kind}:`)
      // And it must actually appear: a kind dropped from the block entirely
      // would also satisfy the assertion above.
      expect(p, `${kind} is missing from the events block`).toContain(`${kind}: d`)
    }
  })

  it('pay_alarm reads as an emergency in the prompt, distinctly from every other kind', () => {
    const p = buildSoulPrompt({
      ...base,
      userEvents: [
        { kind: 'pay_alarm', detail: 'x402 reconciliation needs a human', created: 1750000000 },
        { kind: 'tiny_visit', detail: 'someone visited', created: 1750000000 },
      ],
    })
    expect(p).toContain('🚨 pay_alarm:')
    // Not the same glyph as an ordinary row — the point is that the agent can
    // tell the page apart from the page view.
    expect(p).not.toContain('🚨 tiny_visit')
  })

  it('an unknown kind still renders ℹ — a newer worker must not be silenced', () => {
    // The fallback is deliberate and stays: dropping an unrecognised kind would
    // hide a brand-new subsystem until the web deploys.
    const p = buildSoulPrompt({
      ...base,
      userEvents: [{ kind: 'quantum_settled', detail: 'd', created: 1750000000 }],
    })
    expect(p).toContain('ℹ quantum_settled: d')
  })

  it('renders events with icons and clamps detail', () => {
    const p = buildSoulPrompt({
      ...base,
      userEvents: [
        { kind: 'job_result', detail: 'x'.repeat(500), created: 1750000000 },
        { kind: 'unknown_kind', detail: 'something', created: 1750000000 },
      ],
    })
    expect(p).toContain('🔔 Recent Events')
    expect(p).toContain('✅ job_result')
    expect(p).toContain('ℹ unknown_kind')
    // detail clamped to 140
    expect(p).not.toContain('x'.repeat(141))
  })

  it('omits empty optional blocks', () => {
    const p = buildSoulPrompt(base)
    expect(p).not.toContain('🔔 Recent Events')
    expect(p).not.toContain('# System Messages from Conversation')
    expect(p).not.toContain('# Custom System Prompt')
  })

  it('always ends with the render_ui guide (JSX prohibition intact)', () => {
    const p = buildSoulPrompt(base)
    expect(p).toContain('You MUST use React.createElement syntax, NOT JSX!')
    expect(p).toContain('DO NOT USE JSX')
  })

  it('soul sections appear in canonical order', () => {
    const p = buildSoulPrompt(base)
    const order = ['## I. Ontology', '## II. The covenant', '## III. Principles', '## IV. What to ignore', '## V. What you are not', '## VI. Ephemerality']
    const idx = order.map((h) => p.indexOf(h))
    expect(idx.every((i) => i > -1)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })
})

describe('soul prompt — mobile apps (pocket presence)', () => {
  it('teaches the Android install page and the iOS Add to Home Screen path', () => {
    const out = buildSoulPrompt(base)
    expect(out).toContain('tiny.technology/android')
    expect(out).toContain('Add to Home Screen')
    expect(out).toMatch(/Pocket presence/)
  })
})

describe('soul prompt — embodiment (tiny-node)', () => {
  it('teaches use_device and the npx tiny-tech enrollment path', () => {
    const out = buildSoulPrompt(base)
    expect(out).toContain('use_device')
    expect(out).toContain('npx tiny-tech')
    expect(out).toContain('/devices')
    expect(out).toMatch(/Embodiment/)
  })
})

/**
 * 💻 THE DEVICE BLOCK CARRIES CAPABILITIES (loop item d-c).
 *
 * The daemon declares what it can actually do (tiny-tech device.ts
 * buildCapabilities: the base mcp/files pair plus one label per tool
 * makeDeviceTools() registered) and the worker has always stored + returned it.
 * The agent's prompt never showed it — so "cagatay-mbp (cli, darwin-arm64, 🟢
 * ONLINE)" was all it had, and it had to GUESS whether that machine could drive
 * a screen, notify its human or reach a mailbox. Guessing wrong fails 45s later,
 * remotely, with nothing explaining why.
 */
describe('buildDeviceBlock — capabilities reach the agent', () => {
  const mac = {
    id: 'dev_1', name: 'cagatay-mbp', kind: 'cli', platform: 'darwin-arm64', online: 1,
    capabilities: JSON.stringify(['mcp', 'files', 'apple', 'computer', 'desktop']),
  }

  it('renders presence, id, and what the device can actually do', () => {
    const b = buildDeviceBlock([mac])
    expect(b).toContain('cagatay-mbp')
    expect(b).toContain('🟢 ONLINE')
    expect(b).toContain('[id: dev_1]')
    expect(b).toContain('sees + drives the screen (use_computer)')
    expect(b).toContain('notifications, clipboard, open (use_desktop)')
    expect(b).toContain('Messages, Notes, Reminders, Calendar, Mail (use_apple)')
  })

  it('the block still teaches invoke and now names the async escape hatch', () => {
    const b = buildDeviceBlock([mac])
    expect(b).toContain("use_device action:'invoke'")
    // A late reply comes back as a device_result event (cycle d-b) — the agent
    // should expect that rather than treat the timeout as a failure.
    expect(b).toContain('device_result')
  })

  it('a device with no capabilities recorded still renders — just without a hint', () => {
    // Devices enrolled before the field existed, or a bare CLI on a headless box.
    const bare = buildDeviceBlock([{ id: 'd2', name: 'vps', platform: 'linux-x64', online: 0, capabilities: null }])
    expect(bare).toContain('vps')
    expect(bare).toContain('⚫ offline')
    expect(bare).not.toContain('can:')
  })

  it('unknown labels pass through VERBATIM — a newer daemon must not be silenced', () => {
    // A daemon shipping a tool this deploy has never heard of should still tell
    // the agent the tool is there; dropping it makes new capabilities invisible
    // until the web deploys.
    const b = buildDeviceBlock([{ id: 'd3', name: 'lab', online: 1, capabilities: ['mcp', 'quantum_rig'] }])
    expect(b).toContain('quantum_rig')
  })

  it('EVERY label a daemon can declare has a real sentence, not a bare word', () => {
    // ⚠️ THE GAP THIS PINS. `capabilitySummary` falls back to the raw label, which
    // is exactly right for a label this deploy has never heard of (the test above)
    // and exactly wrong for one we ship: five of them — browse, windows, voice,
    // see, integrations — reached the agent's system prompt as bare words. A full
    // Mac read "…; browse; windows; voice; …", so a REAL logged-in Chrome and the
    // ability to look at a file were invisible as capabilities while being listed
    // as present. Nothing failed, because a shipped label and an unknown one
    // render identically — which is why the roster has to be asserted, not read.
    for (const label of DEVICE_LABELS) {
      const rendered = capabilitySummary([label])
      if (label === 'mcp') { expect(rendered).toBe(''); continue }   // deliberately blank
      // The fallback prints the label itself. A hint that IS the label is the
      // no-op we're banning, whether it got there by fallback or by being typed.
      expect(rendered, `${label} renders as a bare word — add a CAPABILITY_HINTS sentence`)
        .not.toBe(` — can: ${label}`)
      // A phrase, not a synonym: it must say something the label doesn't. Word
      // count rather than a character threshold, deliberately — `files` earns its
      // place with three words ('shell + files') and any length number I picked
      // here would just get edited by whoever next wrote a short honest hint.
      const words = rendered.replace(' — can: ', '').split(/\s+/).filter(Boolean)
      expect(words.length, `${label}'s hint says no more than the label does`)
        .toBeGreaterThan(1)
    }
  })

  it('the five formerly-bare labels each name the tool the agent must call', () => {
    // Naming the tool is the point: the block tells the model to match a task to a
    // device, and it cannot do that from a capability whose tool it has to guess.
    // (`windows` and `see`/`voice` ride on other tools, which is why the tool name
    // is not derivable from the label.)
    expect(capabilitySummary(['browse'])).toContain('use_browse')
    expect(capabilitySummary(['browse'])).toContain('login')     // the reason to prefer it
    expect(capabilitySummary(['windows'])).toContain('use_computer')
    expect(capabilitySummary(['see'])).toContain('see_image')
    expect(capabilitySummary(['voice'])).toContain('speak')
    expect(capabilitySummary(['voice'])).toContain('listen')     // hearing, not just talking
    expect(capabilitySummary(['integrations'])).toContain('use_integrations')
  })

  it('a full Mac reads as capabilities, with no bare word left in the line', () => {
    // The end-to-end shape: the actual string a fully-capable daemon puts in the
    // system prompt. Every segment must be a phrase, not a label echoed back.
    const line = capabilitySummary(DEVICE_LABELS.filter(l => l !== 'mcp'))
    const segments = line.replace(' — can: ', '').split('; ')
    for (const seg of segments) {
      expect(DEVICE_LABELS as readonly string[], `bare label in the prompt: "${seg}"`)
        .not.toContain(seg)
    }
    expect(segments.length).toBe(DEVICE_LABELS.length - 1)   // all but mcp
  })

  it('mcp is not rendered — every CLI node has it, so it is noise per-line', () => {
    expect(capabilitySummary(['mcp'])).toBe('')
    expect(capabilitySummary(['mcp', 'files'])).toContain('shell + files')
  })

  it('ocr renders as its OWN capability, distinct from driving the screen', () => {
    // The daemon declares `ocr` beside `computer` when Apple Vision is available
    // (tiny-tech device-tools.ts). They are not the same fact: a machine can post
    // CGEvents without being able to READ its screen locally, and knowing it can
    // changes how the remote agent asks — find_text instead of "screenshot and
    // guess where the button is". Rendering only `computer` hid that entirely.
    const s = capabilitySummary(['mcp', 'computer', 'ocr'])
    expect(s).toContain('sees + drives the screen')
    expect(s).toContain('find_text')
    // Distinct entries, not one merged phrase.
    expect(s.split(';').length).toBeGreaterThanOrEqual(2)
  })

  it('ocr on its own still renders — the hint must not depend on computer being present', () => {
    expect(capabilitySummary(['ocr'])).toContain('reads its own screen locally')
  })

  it('no devices → no block at all (not an empty header)', () => {
    expect(buildDeviceBlock([])).toBe('')
    expect(buildDeviceBlock(null)).toBe('')
    expect(buildDeviceBlock(undefined)).toBe('')
    expect(buildDeviceBlock('nonsense')).toBe('')
  })

  it('malformed capabilities never throw — this string is inside the system prompt', () => {
    // A parse error here would take out the whole turn for a cosmetic line.
    for (const raw of ['{not json', '"a string"', '42', null, undefined, {}, ['ok']]) {
      expect(() => capabilitySummary(raw)).not.toThrow()
    }
    expect(parseCapabilities('{not json')).toEqual([])
    expect(parseCapabilities('{"a":1}')).toEqual([])
    expect(parseCapabilities(['Apple', ' Desktop ', '', null])).toEqual(['apple', 'desktop'])
  })
})

/**
 * 💰 THE ECONOMY PARAGRAPH FOLLOWS THE DEPLOYMENT'S CHAIN (report §1.2 item 8).
 *
 * c-g fixed the three wallet UIs. The AGENT is what answers "how do I get
 * credit?", and it was reciting "real USDC on Base … testnet (Base Sepolia) gives
 * $1 trial credits" on every deployment — including one running its own chain,
 * where a user who follows that advice spends real money on a token this
 * deployment cannot accept. A wrong sentence from the agent is worse than a wrong
 * link in a card, because the user asked and was answered.
 *
 * What's asserted is what can't be eyeballed: that the trap sentences are ABSENT
 * per network, not merely that the right ones are present.
 */
describe('economyBlock — the money copy per network', () => {
  const NETWORKS = ['base', 'base-sepolia', 'tiny'] as const

  it('our own chain names the faucet as the only source and forbids buying', () => {
    const e = economyBlock('tiny')
    expect(e).toContain('its own chain')
    expect(e).toContain('trial credit')
    expect(e).toContain('faucet')
    expect(e).toContain('one claim per UTC day')
    // The exact numbers the worker enforces (deposits.ts FAUCET_* constants) —
    // a prompt that promises a different ceiling than trialCapMicro() grants is
    // the agent contradicting the button.
    expect(e).toContain('$1 base + $0.20 per point, up to $25')
    // And the reason the ceiling grows, since p-c made reputation earnable.
    expect(e).toMatch(/reputation/i)
    expect(e).toContain('followed')
  })

  it('our own chain never tells anyone to buy, bridge or exchange', () => {
    const e = economyBlock('tiny')
    // The trap: no exchange sells this chain's token, so "buy USDC" costs the
    // user real money for credit this deployment can't accept.
    expect(e).not.toMatch(/buy or bridge/i)
    expect(e).not.toContain('real USDC on Base')
    expect(e).not.toContain('faucet.circle.com')
    expect(e).not.toContain('Base Sepolia')
    expect(e).toContain('Never tell a user to buy, bridge or exchange USDC')
  })

  /**
   * Report §1.2 item 10, as a sentence rather than a config: an outside agent
   * would need TinyUSDC, which only this deployment mints. The x402 endpoint is
   * real; the audience is local. Promising the open internet would have owners
   * pricing a tiny for callers who cannot arrive.
   */
  it('our own chain does not promise external agents as an audience', () => {
    const e = economyBlock('tiny')
    expect(e).toContain('/api/x402/chat/<slug>')  // the endpoint is still real
    expect(e).not.toMatch(/any external AI agent/i)
    expect(e).toContain("can't hold a token only we mint")
  })

  it('sepolia points at the third-party faucet and refuses real USDC', () => {
    const e = economyBlock('base-sepolia')
    expect(e).toContain('Base Sepolia')
    expect(e).toContain('faucet.circle.com')
    expect(e).toContain('$1 lifetime')
    expect(e).toContain('Do NOT tell a user to buy real USDC')
    expect(e).not.toContain('withdraw self-serve')
  })

  it('mainnet keeps the real-money wording, including withdrawal', () => {
    const e = economyBlock('base')
    expect(e).toContain('real USDC on Base')
    expect(e).toContain('withdraw self-serve')
    expect(e).toContain('any external AI agent')
    expect(e).not.toContain('faucet')
    expect(e).not.toContain('trial')
  })

  it('every network says the balance is trial credit or real money — never neither', () => {
    for (const n of NETWORKS) {
      const e = economyBlock(n)
      const trial = /trial credit/.test(e)
      const real = /real USDC/.test(e)
      expect(trial || real, `${n} said neither`).toBe(true)
      // And a trial network must SAY not-withdrawable, since the refusal comes
      // after the user has already earned on it.
      if (n !== 'base') expect(e, `${n} hid the withdrawal limit`).toMatch(/NOT withdrawable/)
    }
  })

  it('the invariants that hold on all three: the page, the tool, the flat fee', () => {
    for (const n of NETWORKS) {
      const e = economyBlock(n)
      expect(e).toContain('/wallet')
      expect(e).toContain('set_price')
      expect(e).toContain('$0.001')
      expect(e).toContain('never a percentage')
    }
  })
})

describe('buildSoulPrompt — the economy paragraph is wired to the network', () => {
  it('a tiny-chain deployment gets the faucet wording, not the Base wording', () => {
    const p = buildSoulPrompt({ ...base, paymentsNetwork: 'tiny' })
    expect(p).toContain('- **Economy**:')
    expect(p).toContain('faucet')
    expect(p).not.toContain('real USDC on Base')
  })

  /**
   * The default matters: buildSoulPrompt is called from /api/chat and from
   * job-run-shaped callers, and a caller that hasn't passed the network must keep
   * today's mainnet wording rather than lose the paragraph entirely.
   */
  it('an un-updated caller keeps the mainnet paragraph', () => {
    const p = buildSoulPrompt(base)
    expect(p).toContain('real USDC on Base')
    expect(p).toContain('- **Economy**:')
  })

  it('the paragraph still sits inside the Ontology section', () => {
    for (const n of ['base', 'base-sepolia', 'tiny'] as const) {
      const p = buildSoulPrompt({ ...base, paymentsNetwork: n })
      const i = p.indexOf('- **Economy**:')
      expect(i).toBeGreaterThan(p.indexOf('## I. Ontology'))
      expect(i).toBeLessThan(p.indexOf('## II. The covenant'))
    }
  })
})

/**
 * The phrase inside pay_x402's own description — the tool the agent reads before
 * quoting a price to somebody.
 */
describe('walletFundsPhrase', () => {
  it('names the chain the balance is actually on', () => {
    expect(walletFundsPhrase('base')).toBe('real USDC on Base')
    expect(walletFundsPhrase('base-sepolia')).toContain('Base Sepolia')
    expect(walletFundsPhrase('tiny')).toContain('trial credit')
  })

  it('never says Base on a self-hosted deployment', () => {
    expect(walletFundsPhrase('tiny')).not.toMatch(/Base/)
  })
})
