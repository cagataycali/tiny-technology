/**
 * 🧵 forkSession — sibling turns with isolated history.
 *
 * The mechanism behind concurrent conversations in the TUI: one live turn per
 * Agent (the SDK throws ConcurrentInvocationError otherwise, and Bedrock rejects
 * a history where two turns interleaved their toolUse/toolResult blocks), each
 * seeded from the session's history, each folded back on COMPLETION.
 *
 * These tests reach past `private` — compiled JS has no such thing — to inject a
 * stub model and stub agent. That's the point: the fork bookkeeping is what's
 * under test, and standing up a real model would make it a network test of
 * something else.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { TinyAgent } = await import('../dist/agent/agent.js')
const {
  Agent, Message, ContextWindowOverflowError, SlidingWindowConversationManager,
} = await import('@strands-agents/sdk')

/** Enough of a Model for `new Agent()` to accept it; never actually called. */
const fakeModel = {
  config: { modelId: 'fake' },
  async *stream() {},
  updateConfig() {},
  getConfig() { return {} },
}

const msg = (role, text) => Message.fromMessageData({ role, content: [{ text }] })
const texts = (agent) => agent.messages.map((m) => m.content?.[0]?.text)

/** A tool pair, the thing a trim must never cut through. */
const toolUseMsg = (id) => Message.fromMessageData({
  role: 'assistant', content: [{ toolUse: { name: 'bash', toolUseId: id, input: { command: 'ls' } } }],
})
const toolResultMsg = (id) => Message.fromMessageData({
  role: 'user', content: [{ toolResult: { toolUseId: id, status: 'success', content: [{ text: 'ok' }] } }],
})
const hasBlock = (m, type) => m.content.some((b) => b.type === type)

/** One user/toolUse/toolResult/assistant turn — what a real tool-using turn looks like. */
const toolTurn = (n) => [msg('user', `q${n}`), toolUseMsg(`t${n}`), toolResultMsg(`t${n}`), msg('assistant', `a${n}`)]

/** A local-mode TinyAgent whose history starts at `seed`. */
function localAgent(seed = []) {
  const a = new TinyAgent({ api: { authenticated: false }, printer: false })
  a.agent = new Agent({ model: fakeModel, tools: [], messages: seed })
  a.model = fakeModel
  a.systemPromptText = 'system'
  a.allTools = []
  a.modelLabel = 'fake:test'
  return a
}

test('a fork inherits the session history and claims none of it as its own', () => {
  const parent = localAgent([msg('user', 'one'), msg('assistant', 'two')])
  const fork = parent.forkSession()

  assert.equal(fork.messageCount, 2, 'the second question knows what the first was about')
  assert.deepEqual(fork.newMessages(), [], 'inherited messages are not the fork\'s work')
  assert.equal(fork.isLocal, true)
  assert.equal(fork.modelLabel, 'fake:test')
})

test("a running fork is invisible to the session until it's absorbed", () => {
  const parent = localAgent([msg('user', 'history')])
  const fork = parent.forkSession()

  fork.agent.messages.push(msg('user', 'q'), msg('assistant', 'a'))
  assert.equal(fork.newMessages().length, 2)
  assert.equal(parent.messageCount, 1, 'a half-finished turn must not be in the session yet')

  assert.equal(parent.absorb(fork), 2)
  assert.equal(parent.messageCount, 3)
  assert.deepEqual(texts(parent.agent), ['history', 'q', 'a'])
})

test('absorbing twice does not duplicate the exchange', () => {
  const parent = localAgent()
  const fork = parent.forkSession()
  fork.agent.messages.push(msg('user', 'q'), msg('assistant', 'a'))

  assert.equal(parent.absorb(fork), 2)
  assert.equal(parent.absorb(fork), 0, 'the same messages must not be handed over twice')
  assert.equal(parent.messageCount, 2)
})

test('absorbing a fork that never got going is a no-op', () => {
  const parent = localAgent([msg('user', 'x')])
  assert.equal(parent.absorb(parent.forkSession()), 0)
  assert.equal(parent.messageCount, 1)
})

test('two forks run independently and fold back in COMPLETION order', () => {
  // The order the user watched things happen is the order the transcript — and
  // the history behind it — has to read in.
  const parent = localAgent([msg('user', 'base')])
  const slow = parent.forkSession()
  const fast = parent.forkSession()

  slow.agent.messages.push(msg('user', 'slow q'), msg('assistant', 'slow a'))
  fast.agent.messages.push(msg('user', 'fast q'), msg('assistant', 'fast a'))

  // Neither fork can see the other's work — that's what makes the histories valid.
  assert.equal(slow.messageCount, 3)
  assert.equal(fast.messageCount, 3)
  assert.ok(!texts(slow.agent).includes('fast q'))

  parent.absorb(fast)   // finished first
  parent.absorb(slow)
  assert.deepEqual(texts(parent.agent), ['base', 'fast q', 'fast a', 'slow q', 'slow a'])
})

test('a fork created later inherits what has already been absorbed', () => {
  const parent = localAgent()
  const first = parent.forkSession()
  first.agent.messages.push(msg('user', 'q1'), msg('assistant', 'a1'))
  parent.absorb(first)

  const second = parent.forkSession()
  assert.equal(second.messageCount, 2)
  assert.deepEqual(texts(second.agent), ['q1', 'a1'])
})

test('the session owns the loop runner — forks share the slot cap, not a copy', () => {
  // MAX_ACTIVE_LOOPS is a property of the machine, not of one conversation: three
  // forks each holding their own runner could start three times the loops.
  const parent = localAgent()
  const runner = { id: 'the one runner' }
  parent.loops = runner
  const a = parent.forkSession()
  const b = parent.forkSession()
  assert.strictEqual(a.loops, runner)
  assert.strictEqual(b.loops, runner)
})

test('local tool metadata rides along so panels can name the same tools', () => {
  const parent = localAgent()
  parent.localTools = { dir: '/tmp/tools', loaded: [{ name: 'my_thing', description: 'd' }], skipped: [] }
  parent.localToolNames = ['my_thing']
  const fork = parent.forkSession()
  assert.strictEqual(fork.localTools, parent.localTools)
  assert.deepEqual(fork.localToolNames, ['my_thing'])
})

test('server mode forks too — /api/chat is stateless, so a fork is a second caller', () => {
  const server = new TinyAgent({ api: { authenticated: false }, printer: false })
  const fork = server.forkSession()   // never init()'d: no model, no agent
  assert.equal(fork.isLocal, false)
  assert.equal(fork.messageCount, 0)
  assert.deepEqual(fork.newMessages(), [])
  assert.equal(server.absorb(fork), 0, 'nothing local to fold into')
})

test('cancelTurn is safe on an idle agent and on a server-mode one', () => {
  const parent = localAgent()
  parent.cancelTurn()                       // nothing in flight
  parent.forkSession().cancelTurn()
  new TinyAgent({ api: { authenticated: false } }).cancelTurn()
})

test('finished-loop news is delivered ONCE across every concurrent fork', async () => {
  // Three conversations starting together must not each drain the news, or the
  // user reads the same completion three times. The session owns that cursor.
  const parent = localAgent()
  let polls = 0
  let unread = '[loop 7 finished]\n'
  parent.loops = {
    takeNews: () => { polls++; const n = unread; unread = ''; return n },
  }

  const a = parent.forkSession()
  const b = parent.forkSession()
  const first = await a.dynamicContext()
  const second = await b.dynamicContext()

  assert.match(first, /loop 7 finished/)
  assert.equal(second, '', 'the second fork gets nothing — the news was already read')
  assert.equal(polls, 2, 'both forks asked the PARENT rather than polling themselves')
})

// ── The amnesia bug: BUG-fork-history-loss.md ────────────────────────────────
// A long session used to stop remembering anything ~10 turns in, with nothing
// erroring: forks silently absorbed zero messages. Every test below is one of
// the conspiring causes, so the steady state can't come back.

test('the fork boundary survives an in-place trim of the fork\'s own array', () => {
  // The root cause. The boundary was a message INDEX (forkBase = seed.length),
  // and every conversation manager in the SDK reduces history by splicing the
  // array in place FROM THE FRONT — on AfterInvocationEvent, i.e. before absorb()
  // runs. slice(forkBase) then returned the wrong messages, usually none.
  const seed = []
  for (let i = 0; i < 52; i++) seed.push(msg('user', `q${i}`), msg('assistant', `a${i}`))
  const parent = localAgent(seed)
  const fork = parent.forkSession()
  fork.agent.messages.push(msg('user', 'wifi board?'), msg('assistant', 'here is the answer'))

  // Whatever does the trimming — the SDK's default manager used to, right here.
  new SlidingWindowConversationManager({ windowSize: 40 })._applyManagement(fork.agent.messages)
  assert.equal(fork.agent.messages.length, 40, 'the array really was re-indexed under the old boundary')

  assert.deepEqual(fork.newMessages().map((m) => m.content[0].text), ['wifi board?', 'here is the answer'])
  assert.equal(parent.absorb(fork), 2, 'the turn folds back — the session does not go amnesic')
  assert.deepEqual(texts(parent.agent).slice(-2), ['wifi board?', 'here is the answer'])
})

test('a fork never manages its own history — bounding it is the session\'s job', () => {
  // A turn that eats its own output on the way home is never what we want, so
  // the fork's Agent is built with an explicit null manager rather than the
  // sliding window the SDK would otherwise default it to.
  const parent = localAgent([msg('user', 'x')])
  const fork = parent.forkSession()
  assert.equal(fork.agent._conversationManager.name, 'strands:null-conversation-manager')
})

test('a trim of the SESSION mid-turn cannot disturb a running fork', () => {
  // Conspiring bug A had the parent never trimmed at all; now it is, on every
  // absorb — which under a positional boundary would have re-broken every fork
  // still in flight.
  const parent = localAgent()
  for (let i = 0; i < 40; i++) parent.agent.messages.push(...toolTurn(i))
  const fork = parent.forkSession()
  fork.agent.messages.push(msg('user', 'mid-flight q'), msg('assistant', 'mid-flight a'))

  new SlidingWindowConversationManager({ windowSize: 40 })._applyManagement(parent.agent.messages)
  assert.equal(parent.absorb(fork), 2, 'the fork still knows exactly which messages are its own')
})

test('absorb refuses a slice whose first message is an orphan tool result', () => {
  // Case 2 in the report: the folded slice began on a toolResultBlock, which is
  // precisely the invalid sequence forking exists to prevent — and it would make
  // Bedrock reject the WHOLE history on some later, unrelated turn.
  const parent = localAgent([msg('user', 'base')])
  const fork = parent.forkSession()
  fork.agent.messages.push(toolResultMsg('t1'), msg('assistant', 'final'))

  assert.equal(parent.absorb(fork), 0)
  assert.match(parent.lastAbsorbIssue, /starts on a tool result/)
  assert.equal(parent.messageCount, 1, 'the session history was not poisoned')

  assert.equal(parent.absorb(fork), 0, 'and a refused slice is not offered again')
  assert.equal(parent.lastAbsorbIssue, null)
})

test('absorb refuses a turn that ended on a toolUse whose result never came', () => {
  const parent = localAgent([msg('user', 'base')])
  const fork = parent.forkSession()
  fork.agent.messages.push(msg('user', 'q'), toolUseMsg('t9'))

  assert.equal(parent.absorb(fork), 0)
  assert.match(parent.lastAbsorbIssue, /never arrived/)
  assert.equal(parent.messageCount, 1)
})

test('a complete tool pair folds back whole — the seam check is not a blanket veto', () => {
  const parent = localAgent()
  const fork = parent.forkSession()
  fork.agent.messages.push(...toolTurn(1))

  assert.equal(parent.absorb(fork), 4, 'tool calls and results reach the session intact')
  assert.equal(parent.lastAbsorbIssue, null)
})

test('the session history stays bounded across many absorbed turns', () => {
  // Conspiring bug A: in the TUI the parent never invokes — only forks do — so
  // its own AfterInvocationEvent hook never fired and the array grew without
  // bound, which is what GUARANTEED every later fork inherited an oversized seed.
  const parent = localAgent()
  for (let i = 0; i < 60; i++) {
    const fork = parent.forkSession()
    fork.agent.messages.push(...toolTurn(i))
    assert.equal(parent.absorb(fork), 4, `turn ${i} folded back`)
  }

  assert.ok(parent.messageCount <= 124, `bounded, got ${parent.messageCount} of 240 produced`)
  assert.ok(!hasBlock(parent.agent.messages[0], 'toolResultBlock'), 'and never trimmed into a tool pair')
  assert.deepEqual(texts(parent.agent).slice(-1), ['a59'], 'the newest turn is what survived')
})

test('a context overflow is recognised by TYPE, not by the words in it', async () => {
  // Bedrock wraps the provider's message, so the wording is provider-dependent
  // and drifts. This error says nothing a string match would have caught.
  const seed = []
  for (let i = 0; i < 4; i++) seed.push(msg('user', `q${i}`), msg('assistant', `a${i}`))
  const parent = localAgent(seed)
  const fork = parent.forkSession()

  let call = 0
  fork.agent = {
    messages: fork.agent.messages,
    async *stream() {
      if (++call === 1) throw new ContextWindowOverflowError('ValidationException: 400')
      yield {
        type: 'modelStreamUpdateEvent',
        event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'healed' } },
      }
    },
    cancel() {},
  }

  const events = []
  for await (const ev of fork.streamTurn('what now?')) events.push(ev)
  assert.equal(call, 2, 'it recognised the overflow and retried')
  assert.equal(events.at(-1).text, 'healed')
})

test('context overflow TRIMS the oldest history and reports a notice, not an error', async () => {
  // Conspiring bug B: the old heal wiped both histories to zero — throwing away
  // the whole session to survive one turn — and reported itself as an error, so
  // even a fully recovered turn folded back as a lossy text summary.
  const seed = []
  for (let i = 0; i < 80; i++) seed.push(msg('user', `q${i}`), msg('assistant', `a${i}`))
  const parent = localAgent(seed)
  const fork = parent.forkSession()

  let call = 0
  fork.agent = {
    messages: fork.agent.messages,
    async *stream(input) {
      // The SDK appends the user message BEFORE the model call and leaves it
      // there when the call throws — so a naive retry sends two in a row.
      this.messages.push(msg('user', String(input)))
      if (++call === 1) throw new ContextWindowOverflowError('input is too long')
      this.messages.push(msg('assistant', 'healed answer'))
      yield {
        type: 'modelStreamUpdateEvent',
        event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'healed answer' } },
      }
    },
    cancel() {},
  }

  const events = []
  for await (const ev of fork.streamTurn('what now?')) events.push(ev)

  assert.equal(call, 2, 'it retried exactly once')
  assert.ok(events.some((e) => e.kind === 'notice' && /trimmed/.test(e.message)))
  assert.ok(!events.some((e) => e.kind === 'error'), 'a turn that recovered is not a failed turn')
  assert.equal(events.at(-1).kind, 'done')
  assert.equal(events.at(-1).text, 'healed answer')

  assert.ok(fork.messageCount > 0 && fork.messageCount < 160, `fork trimmed, not wiped (${fork.messageCount})`)
  assert.ok(parent.messageCount > 0 && parent.messageCount < 160, `session trimmed, not wiped (${parent.messageCount})`)

  // The failed attempt was rolled back, so the retry exchange is a clean pair —
  // and it folds back as the REAL exchange rather than a summary.
  assert.deepEqual(fork.newMessages().map((m) => m.content[0].text), ['what now?', 'healed answer'])
  assert.equal(parent.absorb(fork), 2)
})

test('an overflow with nothing left to trim fails honestly instead of retrying', async () => {
  const parent = localAgent()
  const fork = parent.forkSession()   // both histories empty: no reduction possible

  let call = 0
  fork.agent = {
    messages: [],
    async *stream() { call++; throw new ContextWindowOverflowError('input is too long') },
    cancel() {},
  }

  const events = []
  for await (const ev of fork.streamTurn('q')) events.push(ev)
  assert.equal(call, 1, 'it did not retry into the same wall')
  assert.ok(events.some((e) => e.kind === 'error' && /too long/.test(e.message)))
  assert.equal(events.at(-1).kind, 'done')
})

test('clearHistory drops the whole session and reports how much it dropped', () => {
  // /clear's model half. The count matters: the UI prints it, so a wrong number
  // is a lie about what the agent still remembers.
  const a = localAgent([msg('user', 'q1'), msg('assistant', 'a1'), msg('user', 'q2'), msg('assistant', 'a2')])

  assert.equal(a.clearHistory(), 4)
  assert.equal(a.messageCount, 0)
  assert.equal(a.clearHistory(), 0, 'clearing an empty session drops nothing')
})

test('clearHistory empties the array the SDK holds, not just our view of it', () => {
  // Assigning a fresh array would leave the Agent pointing at the old one: this
  // side would look clear while the next model call still sent every message.
  const a = localAgent([msg('user', 'remember me')])
  const sdkArray = a.agent.messages

  a.clearHistory()
  assert.equal(sdkArray.length, 0, 'the SDK sees the same empty array')
  assert.equal(a.agent.messages, sdkArray, 'and it is still the same array object')
})

test('a turn already in flight survives /clear and folds back into the empty session', () => {
  // The fork copied history when it started, so cancelling it would be the only
  // way for a clear to lose work. It must not.
  const parent = localAgent([msg('user', 'old'), msg('assistant', 'context')])
  const fork = parent.forkSession()
  fork.agent.messages.push(msg('user', 'in flight'), msg('assistant', 'landed'))

  parent.clearHistory()
  assert.equal(parent.messageCount, 0)

  assert.equal(parent.absorb(fork), 2, 'the running turn still folds back')
  assert.deepEqual(texts(parent.agent), ['in flight', 'landed'], 'as a clean first exchange')
})

test('clearHistory forgets a refused-seam complaint too', () => {
  const a = localAgent()
  a.lastAbsorbIssue = 'refused to fold back something'
  a.clearHistory()
  assert.equal(a.lastAbsorbIssue, null, 'a stale complaint would annotate the next turn')
})
