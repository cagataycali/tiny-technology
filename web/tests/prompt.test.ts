// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildSoulPrompt, buildDeviceBlock, capabilitySummary, parseCapabilities, economyBlock, walletFundsPhrase, DEVICE_LABELS, EVENT_ICONS, eventDetail, EVENT_DETAIL_CHARS, selectEvents, EVENT_BLOCK_ROWS, PER_KIND_SOFT_CAP, type SoulPromptInputs } from '../lib/chat/prompt'
import { EMITTED_KINDS } from '../lib/chat/event-icons'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    // ⚠️ Fed in BATCHES that fit the block, not all 22 at once. This pin is about
    // the icon MAPPING, and the block renders at most EVENT_BLOCK_ROWS rows — a
    // bound that has always been real (the fetch was `limit=15`) and is now
    // enforced inside buildSoulPrompt by selectEvents. Passing 22 kinds and
    // requiring all 22 to appear would assert the block is unbounded, which it
    // never was, and the failure would read as "your icon is missing" when the row
    // was simply past the cap.
    for (let i = 0; i < EMITTED_KINDS.length; i += EVENT_BLOCK_ROWS) {
      const batch = EMITTED_KINDS.slice(i, i + EVENT_BLOCK_ROWS)
      const p = buildSoulPrompt({
        ...base,
        userEvents: batch.map((kind) => ({ kind, detail: 'd', created: 1750000000 })),
      })
      for (const kind of batch) {
        expect(p, `${kind} renders as ℹ — add an EVENT_ICONS entry`)
          .not.toContain(`ℹ ${kind}:`)
        // And it must actually appear: a kind dropped from the block entirely
        // would also satisfy the assertion above.
        expect(p, `${kind} is missing from the events block`).toContain(`${kind}: d`)
      }
    }
  })

  /**
   * The same roster, read from the other end — and the reason the check above
   * went red on main for two kinds in a row instead of one.
   *
   * `EVENT_ICONS` is exact-match, so it gets nothing for free: `device` covering
   * `device_result` AND `device_task_result` is a property of the HUD's prefix
   * matcher, not of this table. That asymmetry is invisible when you add a kind —
   * you glance at event-icons.ts, see `batch`/`device` already there, and the
   * agent's own copy stays behind. So both directions are pinned: a kind with no
   * entry (renders ℹ) and an entry for no kind (a glyph that can never render,
   * which is the tiny_visit bug wearing the other hat — dead code that reads as
   * coverage).
   */
  it('the agent icon table IS the roster — no kind unmapped, no glyph unreachable', () => {
    expect([...Object.keys(EVENT_ICONS)].sort()).toEqual([...EMITTED_KINDS].sort())
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
    // Still clamped — the ring's own cap (300), not a second, tighter one. This
    // assertion said 141 while every emitter budgeted its trailing id against
    // 300; see the middle-elision tests below for what that cost.
    expect(p).not.toContain('x'.repeat(EVENT_DETAIL_CHARS + 1))
  })

  /**
   * 🎙️ THE ACTIONABLE PART OF AN EVENT LIVES AT THE END OF IT.
   *
   * The events ring caps detail at 300 (events.ts emitEvent is the only writer),
   * and the two emitters that hand the agent a NEXT STEP both put a uuid last:
   *
   *   transcripts.ts  `<name>: "<200 chars of speech>" (transcript <uuid>)`
   *   relay.ts        `💻 <name> finished: "<90>" — … envelope_id:'<uuid>'`
   *
   * Both land at ~176-194 chars, both with a comment explaining that the id fits
   * inside 300 — and this block then sliced 140 off the HEAD, so the id was
   * always the casualty. A real transcript row reached the agent ending
   * "(transcript 9". The failure is quiet and bad: the model can see that the
   * user said something, cannot call nicla_voice_transcript for the full text,
   * and quotes a truncated preview as the whole utterance.
   *
   * Fixtures below are built the way the emitters build them, so a change to
   * either format is caught here rather than in production context.
   */
  const detailFor = (kind: string) => {
    const p = buildSoulPrompt({ ...base, userEvents: [{ kind, detail: EMITTER_FIXTURES[kind], created: 1750000000 }] })
    return p.slice(p.indexOf(`${kind}: `))
  }
  const UUID = '9f8c1e2a-3b4d-4c5e-8f70-a1b2c3d4e5f6'
  const EMITTER_FIXTURES: Record<string, string> = {
    // worker/src/transcripts.ts — the `(transcript <id>)` emit, at its own
    // documented worst case (40-char device name + the full
    // TRANSCRIPT_PREVIEW_CHARS preview + the id). Named by the symbol, not by a
    // line number: the numbers differ between trees and rot on the next edit.
    nicla_transcript: `${'d'.repeat(40)}: "${'the roof guy comes tuesday '.repeat(8).slice(0, 200)}" (transcript ${UUID})`,
    // worker/src/relay.ts — the `envelope_id:'<id>'` emit, with its 90-char brief.
    device_task_result: `💻 studio-mbp finished: "${'ran the migration and rows changed '.repeat(3).slice(0, 90)}" — read it with use_device action:'result' envelope_id:'${UUID}'`,
  }

  /**
   * ⚠️ What makes the two fixtures above load-bearing, asserted rather than
   * assumed: each must EXCEED the old 140 and fit inside the ring's real 300.
   * A fixture shorter than 140 keeps its id under the defective slice too, so
   * both `toContain(UUID)` tests below would stay green against the bug — they
   * would be pinning nothing while reading as the proof of the whole increment.
   *
   * Not hypothetical: the device name in the relay fixture is scrubbed in this
   * tree (the upstream fixture carries a real hostname), and a rename is exactly
   * the edit that shortens a row without anyone re-measuring it. 294 and 209 as
   * written, so there is room — but the margin is a measurement, not a promise.
   */
  it('both fixtures are in the window where the head-slice destroyed the id', () => {
    for (const [kind, s] of Object.entries(EMITTER_FIXTURES)) {
      expect(s.length, `${kind}: shorter than the old slice, so it cannot detect it`).toBeGreaterThan(140)
      expect(s.length, `${kind}: over the ring's cap, so elision explains the pass`).toBeLessThanOrEqual(EVENT_DETAIL_CHARS)
      expect(s.slice(0, 140), `${kind}: the old 140-slice kept the id — fixture proves nothing`).not.toContain(UUID)
    }
  })

  it('a transcript event reaches the agent with its id, so the full text is fetchable', () => {
    const row = detailFor('nicla_transcript')
    expect(EMITTER_FIXTURES.nicla_transcript.length).toBeLessThanOrEqual(EVENT_DETAIL_CHARS)
    expect(row, 'the transcript id was truncated away — nicla_voice_transcript has nothing to fetch')
      .toContain(UUID)
    expect(row).toContain('the roof guy comes tuesday')
  })

  it("a backgrounded task's envelope_id reaches the agent, so the result is readable", () => {
    const row = detailFor('device_task_result')
    expect(row, "use_device action:'result' needs this id and it was sliced off").toContain(UUID)
  })

  it('over-long detail elides the MIDDLE — the tail is what carries the id', () => {
    const long = 'y'.repeat(400) + ` envelope_id:'${UUID}'`
    const out = eventDetail(long)
    expect(out.length).toBeLessThanOrEqual(EVENT_DETAIL_CHARS)
    expect(out, 'a head-slice keeps the prose and drops the only actionable token').toContain(UUID)
    expect(out).toContain('…')
    expect(out.startsWith('yyy')).toBe(true)   // still recognisably the same event
  })

  it('detail at or under the ring cap is passed through untouched', () => {
    expect(eventDetail('short')).toBe('short')
    const exact = 'z'.repeat(EVENT_DETAIL_CHARS)
    expect(eventDetail(exact)).toBe(exact)
    expect(eventDetail(exact)).not.toContain('…')
  })

  it('a null or missing detail renders as empty, not "null"', () => {
    expect(eventDetail(undefined)).toBe('')
    expect(eventDetail(null)).toBe('')
  })

  /**
   * The production row, verbatim from D1, and the reason the transcript half of
   * this bug was LATENT rather than observed: at 131 chars it fit under the old
   * 140 and its id survived. `device_task_result` (198 chars) did not.
   *
   * Kept as a test because "the one real row happened to fit" is the whole
   * reason nobody noticed — the fixed overhead is 65 chars, so only 75 chars of
   * speech fit under 140 while transcripts.ts allows 200. A test that only used
   * this short row would have been green at 140 too.
   */
  it('even the one real transcript row is a phrase away from losing its id', () => {
    const real = 'tiny vision: "deploy verification: the transcript store is reachable end to end." (transcript 0a5da49e-abae-4fe6-866f-8c0a2a41ebd3)'
    expect(real.length).toBe(131)                       // fit under the old 140 — hence latent
    expect(eventDetail(real)).toBe(real)
    // One ordinary sentence longer, and the old slice took the id.
    const longer = real.replace('end to end.', 'end to end, and the second pass agreed with the live take.')
    expect(longer.length).toBeGreaterThan(140)
    expect(longer.length).toBeLessThanOrEqual(EVENT_DETAIL_CHARS)
    expect(eventDetail(longer)).toContain('0a5da49e-abae-4fe6-866f-8c0a2a41ebd3')
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
 * The agent's prompt never showed it — so "studio-mbp (cli, darwin-arm64, 🟢
 * ONLINE)" was all it had, and it had to GUESS whether that machine could drive
 * a screen, notify its human or reach a mailbox. Guessing wrong fails 45s later,
 * remotely, with nothing explaining why.
 */
describe('buildDeviceBlock — capabilities reach the agent', () => {
  const mac = {
    id: 'dev_1', name: 'studio-mbp', kind: 'cli', platform: 'darwin-arm64', online: 1,
    capabilities: JSON.stringify(['mcp', 'files', 'apple', 'computer', 'desktop']),
  }

  it('renders presence, id, and what the device can actually do', () => {
    const b = buildDeviceBlock([mac])
    expect(b).toContain('studio-mbp')
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

/**
 * 🔔 ONE LOUD PRODUCER TOOK THE WHOLE BLOCK.
 *
 * The Recent Events block is a fixed 15 rows off a ring shared by every
 * subsystem, taken strictly newest-first. So it never summarised what happened —
 * it showed whatever wrote most recently, and one busy producer evicted everything
 * else with no trace of having done so.
 *
 * ⚠️ MEASURED, not reasoned about: of the newest 15 rows on the live account, 13
 * were `job_result`, and the ring's newest 50 held 39. The single
 * `nicla_transcript` — the user's own voice, which prompt.ts's icon table calls
 * "the ones most likely to be worth raising unprompted" — sat 22 rows below the
 * cut and reached the agent not at all. That was WITHOUT a necklace streaming: a
 * live card files one segment every 45s, so twelve minutes of it is 16 rows and
 * fills the window from the other direction.
 *
 * The fixture below is that distribution, because a synthetic even mix cannot
 * reproduce the failure — the bug only appears when one kind outnumbers the block.
 */
describe('selectEvents', () => {
  const ev = (kind: string, created: number) => ({ kind, detail: `${kind} detail`, created })
  /** Oldest-first, like the worker returns it (`ORDER BY id DESC` then reverse). */
  const production = () => {
    const rows: Array<{ kind: string; detail: string; created: number }> = []
    let t = 1_750_000_000
    rows.push(ev('batch_result', t++))
    for (let i = 0; i < 4; i++) rows.push(ev('tiny_visit', t++))
    rows.push(ev('nicla_transcript', t++))          // position 27 of 50 in production
    for (let i = 0; i < 22; i++) rows.push(ev('job_result', t++))
    return rows
  }

  it('the voice row the old window dropped now reaches the agent', () => {
    const rows = production()
    const oldWindow = rows.slice(-EVENT_BLOCK_ROWS)
    expect(oldWindow.some(e => e.kind === 'nicla_transcript'))
      .toBe(false)                                  // the defect, reproduced
    const out = selectEvents(rows)
    expect(out.some(e => e.kind === 'nicla_transcript'), 'the user\'s own voice is still shut out')
      .toBe(true)
  })

  it('still renders exactly the block\'s worth of rows', () => {
    expect(selectEvents(production())).toHaveLength(EVENT_BLOCK_ROWS)
  })

  it('the newest rows are still present — this is not a fairness lottery', () => {
    // The loudest producer is usually also the most RELEVANT one, so the newest
    // few of the flood must survive. A rule that dropped them to make room would
    // trade a silent necklace for a silent scheduler.
    const rows = production()
    const newest = rows[rows.length - 1]
    expect(selectEvents(rows)).toContain(newest)
    expect(selectEvents(rows).filter(e => e.kind === 'job_result').length)
      .toBeGreaterThanOrEqual(PER_KIND_SOFT_CAP)
  })

  it('every kind in the ring gets at least one row', () => {
    const out = selectEvents(production())
    for (const k of ['batch_result', 'tiny_visit', 'nicla_transcript', 'job_result']) {
      expect(out.some(e => e.kind === k), `${k} was shut out of the block`).toBe(true)
    }
  })

  it('a ring of one kind still fills the block', () => {
    // The cap is a RESERVATION, not a quota: with nothing competing for the held
    // slots, the deferred rows go back. Capping hard would shrink a busy user's
    // event block from 15 rows to 4 — strictly less context than before the fix.
    const rows = Array.from({ length: 40 }, (_, i) => ev('job_result', 1_750_000_000 + i))
    const out = selectEvents(rows)
    expect(out).toHaveLength(EVENT_BLOCK_ROWS)
    expect(out.filter(e => e.kind === 'job_result')).toHaveLength(EVENT_BLOCK_ROWS)
  })

  it('a necklace streaming for twelve minutes does not silence the scheduler', () => {
    // The other direction, and the one this project's own feature causes: 16
    // segments at one per 45s, arriving after a job failed.
    const rows = [ev('job_error', 1_750_000_000), ev('dm', 1_750_000_001)]
    for (let i = 0; i < 16; i++) rows.push(ev('nicla_transcript', 1_750_000_100 + i * 45))
    const out = selectEvents(rows)
    expect(out.some(e => e.kind === 'job_error'), 'a failed job vanished behind the necklace')
      .toBe(true)
    expect(out.some(e => e.kind === 'dm')).toBe(true)
  })

  it('the rows keep the order the block has always rendered', () => {
    // ⚠️ OLDEST-FIRST, and that is not a preference — it is what the worker hands
    // over (`ORDER BY id DESC` then `.reverse()`) and what the block mapped
    // unchanged before any of this existed. Selection has to WALK newest-first, so
    // restoring the input order is a required step, not bookkeeping: my first
    // version sorted the other way and would have silently flipped every long
    // ring's chronology while short rings (which return early) looked fine.
    const rows = production()
    const out = selectEvents(rows)
    const positions = out.map(e => rows.indexOf(e))
    expect(positions, 'the block no longer reads oldest-first')
      .toEqual([...positions].sort((a, b) => a - b))
  })

  it('the ring\'s own order wins over `created`, which can disagree with it', () => {
    // ⚠️ THE FIRST VERSION OF THIS TEST DID NOT CATCH ITS MUTANT. It fed four rows
    // sharing one second and asserted they all survived — which a `created`-based
    // sort passes, because JS sort is stable and equal keys keep their order.
    //
    // The rows must actually DISAGREE for the pin to mean anything. They can: the
    // ring is ordered by `id` (worker events.ts `ORDER BY id DESC`) while `created`
    // is `unixepoch()` SECONDS from the schema default, so a row inserted later can
    // carry an equal or lower timestamp — two writes inside one second, or a clock
    // that stepped back. Ring position is the only ordering D1 actually promises.
    const rows = [
      ev('dm', 1_750_000_050),              // oldest by position, newest by clock
      ev('job_result', 1_750_000_000),
      ev('nicla_transcript', 1_750_000_000),
    ]
    // When the block can only hold two, it keeps the two the RING calls newest —
    // not the two with the largest timestamps, which would keep `dm` (three
    // positions older) and drop the transcript. Rendered oldest-first, as always.
    expect(selectEvents(rows, 2).map(e => e.kind))
      .toEqual(['job_result', 'nicla_transcript'])
  })

  it('a short ring is passed through untouched', () => {
    const rows = [ev('dm', 1), ev('job_result', 2)]
    expect(selectEvents(rows)).toEqual(rows)
    expect(selectEvents([])).toEqual([])
  })

  it('the block the agent actually reads shows the voice row', () => {
    // End to end through buildSoulPrompt, because a selector nothing calls is the
    // shipped-inert shape this repo has hit before.
    const p = buildSoulPrompt({ ...base, userEvents: production() })
    expect(p).toContain('🎙️ nicla_transcript')
    expect(p).toContain('✅ job_result')
    // Counted by the row's own shape (`- [HH:MM UTC] …`), which nothing else in
    // the prompt has. Slicing to the next heading and splitting on '- ' picked up
    // the covenant's bullets and reported 18.
    expect(p.match(/^- \[\d\d:\d\d UTC\]/gm) || []).toHaveLength(EVENT_BLOCK_ROWS)
  })

  /**
   * ⚠️⚠️ THE OTHER HALF OF THIS FIX, AND THE ONLY HALF NO OTHER TEST CAN SEE.
   *
   * `selectEvents` returns its input untouched when `events.length <= rows` —
   * correctly, since there is nothing to choose between. So the selector is only
   * ever reached because the FETCH asks for more rows than the block renders. Put
   * the request back to `limit=15` and every test in this file still passes, while
   * the block goes back to being "whatever wrote most recently": the early return
   * fires, nothing is selected, and the voice row is evicted exactly as before.
   *
   * Measured, not reasoned about — `&limit=50` → `&limit=15` survived the whole
   * mutation battery for this increment. Two halves, one pin between them.
   *
   * The load-bearing assertion is the RELATION (`> EVENT_BLOCK_ROWS`), not the
   * number: 50 is the worker's own clamp on `/events` and may move. What must
   * never hold is fetched ≤ rendered.
   */
  it('the fetch asks for more rows than the block renders, or selection is dead code', () => {
    const route = readFileSync(join(__dirname, '..', 'app/api/chat/route.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const call = route.match(/plugin\.tiny\.technology\/events\?[^`]*`/)
    expect(call, 'the events fetch is gone or reshaped — re-point this pin').toBeTruthy()
    const width = call![0].match(/&limit=(\d+)/)
    expect(width, 'the events fetch no longer states a width, so the worker default decides it')
      .toBeTruthy()
    expect(Number(width![1]), 'fetching only what is rendered makes selectEvents a no-op')
      .toBeGreaterThan(EVENT_BLOCK_ROWS)
  })

  it('a ring fetched no wider than the block cannot be selected — why the pin above exists', () => {
    // The early return, stated as behaviour so the source pin above has a reason
    // a reader can check. Fifteen rows of one kind plus nothing else: the flood
    // survives whole and the selector never runs.
    const flood = Array.from({ length: EVENT_BLOCK_ROWS }, (_, i) => ev('job_result', 1_750_000_000 + i))
    flood[0] = ev('nicla_transcript', 1_749_999_999)
    const narrow = flood.slice(-EVENT_BLOCK_ROWS)
    expect(selectEvents(narrow)).toEqual(narrow)
  })

  /**
   * ⚠️ THE CAP IS A NUMBER CHOSEN AGAINST THE BLOCK'S SIZE, so it has to be
   * asserted against it. `n >= CAP` → `n > CAP` — one character, letting a fifth
   * row of each kind through — survives every other fixture here, because the
   * give-back always tops the block up to 15 either way.
   *
   * It only bites when enough kinds are competing that the FIRST pass fills the
   * block on its own: four flooding kinds at a cap of 4 spend 4+4+4+3, so the
   * oldest kind still gets a row; at a cap of 5 the first three take all fifteen
   * and the fourth is shut out completely — the very failure this whole increment
   * is about, reintroduced by the off-by-one in its own guard.
   *
   * So the property is: CAP × (competing kinds) must leave room for every kind.
   */
  it('the cap leaves room for every competing kind, not just for four of them', () => {
    const kinds = ['job_result', 'tiny_visit', 'dm', 'nicla_transcript']
    expect(PER_KIND_SOFT_CAP * (kinds.length - 1)).toBeLessThan(EVENT_BLOCK_ROWS)
    const rows: Array<{ kind: string; detail: string; created: number }> = []
    let t = 1_750_000_000
    for (const k of kinds) for (let i = 0; i < 10; i++) rows.push(ev(k, t++))
    const out = selectEvents(rows)
    expect(out).toHaveLength(EVENT_BLOCK_ROWS)
    for (const k of kinds) {
      expect(out.some(e => e.kind === k), `${k} was shut out — the cap is too large for ${kinds.length} kinds`)
        .toBe(true)
    }
  })
})
