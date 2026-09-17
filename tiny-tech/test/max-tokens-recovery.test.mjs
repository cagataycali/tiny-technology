/**
 * 🩹 MaxTokensError self-heal — sibling of the context-overflow heal.
 *
 * Context overflow shrinks INPUT (history). MaxTokensError shrinks OUTPUT
 * (the model's own reply cap). Same shape: type-based catch, rollback the
 * failed turn's user message, retry once, report a NOTICE not an error so
 * the turn folds back as a recovered exchange.
 *
 * These tests reach past `private` — compiled JS has no such thing — to
 * inject a stub model that raises MaxTokensError on demand. The point is
 * the heal bookkeeping, not the model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { TinyAgent } = await import('../dist/agent/agent.js')
const { Agent, Message, MaxTokensError, ContextWindowOverflowError } = await import('@strands-agents/sdk')

/** Enough of a Model with updateConfig/getConfig for the heal to reach in. */
function makeFakeModel(initialMaxTokens = 32000) {
  let maxTokens = initialMaxTokens
  return {
    config: { modelId: 'fake', maxTokens: initialMaxTokens },
    async *stream() {},
    updateConfig(patch) {
      // `patch.maxTokens = undefined` should clear the cap, so we accept
      // undefined explicitly. Only 'key not present in patch' is a no-op.
      if (patch && 'maxTokens' in patch) maxTokens = patch.maxTokens
    },
    getConfig() { return { maxTokens } },
    get maxTokens() { return maxTokens },
  }
}

/** Model with NO getConfig/updateConfig — should fail heal honestly. */
function makeMinimalModel() {
  return {
    config: { modelId: 'minimal' },
    async *stream() {},
  }
}

const msg = (role, text) => Message.fromMessageData({ role, content: [{ text }] })

/** A local-mode TinyAgent whose history starts at `seed`. */
function localAgent(seed = [], model) {
  const m = model || makeFakeModel()
  const a = new TinyAgent({ api: { authenticated: false }, printer: false })
  a.agent = new Agent({ model: m, tools: [], messages: seed })
  a.model = m
  a.systemPromptText = 'system'
  a.allTools = []
  a.modelLabel = 'fake:test'
  return a
}

/**
 * MaxTokensError needs a `partialMessage` in its constructor — the assistant
 * turn that was in-flight when the cap slammed. Making one that satisfies
 * the SDK's Message type without a full construction path.
 */
function mkMaxTokensError(msgText = 'hit output cap') {
  const partial = Message.fromMessageData({ role: 'assistant', content: [{ text: 'partial reply cut off' }] })
  return new MaxTokensError(msgText, partial)
}

test('MaxTokensError is recognised by TYPE, sibling of ContextWindowOverflowError', async () => {
  // The two errors live under the same axis of self-heal, but they mean
  // different things — recognising by type keeps them cleanly separate even
  // when providers surface both with similar wording.
  const parent = localAgent([msg('user', 'q0'), msg('assistant', 'a0')])
  const fork = parent.forkSession()
  const model = fork.model

  let call = 0
  fork.agent = {
    messages: fork.agent.messages,
    async invoke(input) {
      this.messages.push(msg('user', String(input)))
      if (++call === 1) throw mkMaxTokensError()
      this.messages.push(msg('assistant', 'healed on smaller cap'))
      return 'healed on smaller cap'
    },
    cancel() {},
  }

  const result = await fork.invoke('what now?')
  assert.equal(call, 2, 'it recognised MaxTokensError and retried')
  assert.equal(result, 'healed on smaller cap')
  assert.ok(model.maxTokens < 32000, `maxTokens got halved (${model.maxTokens})`)
  assert.ok(model.maxTokens >= 4096, `not below the floor (${model.maxTokens})`)
})

test('max-tokens heal halves maxTokens with a 4096 floor', async () => {
  // Bedrock refuses maxTokens below ~4096 on most Claude models; retrying
  // into the same wall is worse than admitting the turn failed.
  const model = makeFakeModel(32000)
  const parent = localAgent([], model)

  let call = 0
  parent.agent = {
    messages: parent.agent.messages,
    async invoke(input) {
      this.messages.push(msg('user', String(input)))
      if (++call === 1) throw mkMaxTokensError()
      return 'ok'
    },
    cancel() {},
  }

  await parent.invoke('q')
  assert.equal(model.maxTokens, 16000, 'halved from 32000 to 16000')
})

test('max-tokens heal refuses to shrink below the floor', async () => {
  // Already at 4096 — halving would yield 2048 which Bedrock refuses.
  // Retrying wastes a call and hits the same wall.
  const model = makeFakeModel(4096)
  const parent = localAgent([], model)

  let call = 0
  parent.agent = {
    messages: parent.agent.messages,
    async invoke(input) {
      this.messages.push(msg('user', String(input)))
      call++
      throw mkMaxTokensError('output cap hit at floor')
    },
    cancel() {},
  }

  await assert.rejects(parent.invoke('q'), /output cap hit at floor/)
  assert.equal(call, 1, 'did not retry into the same wall')
  assert.equal(model.maxTokens, 4096, 'did not push below the floor')
})

test('max-tokens heal picks the floor when no cap is currently set', async () => {
  // Provider default (no maxTokens configured) — halving is undefined,
  // so we set the floor and try that. Better than a fatal exit.
  const model = makeFakeModel(undefined)
  // Force undefined explicitly — makeFakeModel defaults to 32000
  model.updateConfig({ maxTokens: undefined })
  const parent = localAgent([], model)

  let call = 0
  parent.agent = {
    messages: parent.agent.messages,
    async invoke(input) {
      this.messages.push(msg('user', String(input)))
      if (++call === 1) throw mkMaxTokensError()
      return 'ok'
    },
    cancel() {},
  }

  await parent.invoke('q')
  assert.equal(model.maxTokens, 4096, 'no prior cap → retry at the floor')
})

test('max-tokens heal rolls back the failed user message before retrying', async () => {
  // The SDK appends the user message BEFORE the model call and leaves it
  // there when the call throws — a naive retry sends two user turns in a
  // row, which Bedrock rejects for a different reason than the one we were
  // recovering from. This test is the guard against that regression.
  const model = makeFakeModel(32000)
  const parent = localAgent([msg('user', 'q0'), msg('assistant', 'a0')], model)

  let call = 0
  parent.agent = {
    messages: parent.agent.messages,
    async invoke(input) {
      this.messages.push(msg('user', String(input)))
      if (++call === 1) throw mkMaxTokensError()
      this.messages.push(msg('assistant', 'healed'))
      return 'healed'
    },
    cancel() {},
  }

  await parent.invoke('q1')
  // History should be exactly: seed (2) + retry pair (2) = 4, not 5.
  assert.equal(parent.agent.messages.length, 4, `rolled back the failed user turn (${parent.agent.messages.length})`)
  const roles = parent.agent.messages.map((m) => m.role)
  assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant'], 'no double-user in a row')
})

test('streamTurn max-tokens heal reports a NOTICE, not an error', async () => {
  // "Failed" and "recovered" are different states. Reporting the heal as an
  // error made the fold-back call site downgrade a recovered turn to a lossy
  // summary — same shape of bug the overflow test guards against.
  const model = makeFakeModel(32000)
  const parent = localAgent([], model)
  const fork = parent.forkSession()

  let call = 0
  fork.agent = {
    messages: fork.agent.messages,
    async *stream(input) {
      this.messages.push(msg('user', String(input)))
      if (++call === 1) throw mkMaxTokensError()
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

  assert.equal(call, 2, 'retried exactly once')
  assert.ok(events.some((e) => e.kind === 'notice' && /max output tokens/.test(e.message)),
    'the heal was reported as a notice')
  assert.ok(!events.some((e) => e.kind === 'error'), 'a recovered turn is not a failed turn')
  assert.equal(events.at(-1).kind, 'done')
  assert.equal(events.at(-1).text, 'healed answer', 'the retry text lands as the canonical turn output')
})

test('streamTurn max-tokens heal fails honestly when the floor is already hit', async () => {
  // Symmetric with the overflow "nothing left to trim" test — if the retry
  // cannot make progress, saying so beats pretending.
  const model = makeFakeModel(4096)
  const parent = localAgent([], model)
  const fork = parent.forkSession()

  let call = 0
  fork.agent = {
    messages: fork.agent.messages,
    async *stream() {
      call++
      throw mkMaxTokensError('at the floor already')
    },
    cancel() {},
  }

  const events = []
  for await (const ev of fork.streamTurn('q')) events.push(ev)

  assert.equal(call, 1, 'did not retry into the same wall')
  assert.ok(events.some((e) => e.kind === 'error' && /at the floor already/.test(e.message)),
    'reported the failure honestly')
  assert.equal(events.at(-1).kind, 'done')
})

test('a model without updateConfig cannot be healed and fails honestly', async () => {
  // Older or custom Model impls without getConfig/updateConfig — our heal
  // has no lever to pull, so the honest thing is to let the error bubble.
  const model = makeMinimalModel()
  const parent = localAgent([], model)

  let call = 0
  parent.agent = {
    messages: parent.agent.messages,
    async invoke(input) {
      this.messages.push(msg('user', String(input)))
      call++
      throw mkMaxTokensError('no lever')
    },
    cancel() {},
  }

  await assert.rejects(parent.invoke('q'), /no lever/)
  assert.equal(call, 1, 'did not retry into the same wall on a model we cannot shrink')
})

test('MaxTokensError and ContextWindowOverflowError are recognised independently', async () => {
  // Regression guard: an early draft used a shared "is-recoverable" helper
  // that would have double-treated one as the other. Verify each branch is
  // its own path by running one turn of each and checking the axis-specific
  // side-effect: overflow trims history, max-tokens shrinks the model cap.
  const seed = []
  for (let i = 0; i < 40; i++) seed.push(msg('user', `q${i}`), msg('assistant', `a${i}`))
  const model = makeFakeModel(32000)
  const parent = localAgent(seed, model)
  const beforeLen = parent.agent.messages.length
  const beforeCap = model.maxTokens

  // Turn 1: overflow — history should shrink, cap should stay.
  let call = 0
  parent.agent = {
    messages: parent.agent.messages,
    async invoke(input) {
      this.messages.push(msg('user', String(input)))
      if (++call === 1) throw new ContextWindowOverflowError('input is too long')
      this.messages.push(msg('assistant', 'ok'))
      return 'ok'
    },
    cancel() {},
  }
  // Give the trimmer something to work with by pointing at the real agent's msgs.
  // The heal uses SlidingWindowConversationManager which needs a real Agent shape,
  // so instead just verify the call count and that the model cap wasn't touched.
  try { await parent.invoke('q-overflow') } catch { /* trim may fail on stub; call count is the signal */ }
  assert.equal(call, 2, 'overflow branch retried')
  assert.equal(model.maxTokens, beforeCap, 'overflow branch did NOT touch the model cap')

  // Turn 2: max-tokens — cap should shrink, no history trim needed.
  let call2 = 0
  parent.agent = {
    messages: parent.agent.messages,
    async invoke(input) {
      this.messages.push(msg('user', String(input)))
      if (++call2 === 1) throw mkMaxTokensError()
      this.messages.push(msg('assistant', 'ok'))
      return 'ok'
    },
    cancel() {},
  }
  await parent.invoke('q-maxtokens')
  assert.equal(call2, 2, 'max-tokens branch retried')
  assert.ok(model.maxTokens < beforeCap, `max-tokens branch shrank the cap (${model.maxTokens} < ${beforeCap})`)
})
