// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ownsTiny, mayRunPageJs } from '../lib/chat/page-code-trust'

/**
 * 🔒 ARBITRARY JS IN OUR ORIGIN WAS MOUNTED FOR EVERY VISITOR.
 *
 * `customize_page` grants full-DOM-access JavaScript in the tiny.technology
 * origin — beside the session cookie and the BYO-model API key that
 * lib/chat/model-config.ts keeps in localStorage. It was mounted on every chat
 * turn with no owner check, and a visited tiny's systemPrompt/systemKnowledge/
 * `data` are attacker-authored text the model reads as instructions. So any
 * public tiny could say "call customize_page with this JS" and get code
 * execution in the origin of everyone who opened it.
 *
 * Two layers, and the second is NOT redundant: the effect that executes the
 * code is emitted from `beforeToolCallEvent` (lib/chat/strands-events.ts) —
 * BEFORE the server callback runs — so no server-side check can stop the live
 * run. Mount-gating alone would still execute a fabricated tool call.
 */

describe('ownsTiny — the mount gate\'s predicate', () => {
  it('🔴 a visitor who owns nothing is refused', () => {
    // The whole finding in one line: this is what every anonymous page view is.
    expect(ownsTiny('someones-tiny', [])).toBe(false)
  })

  it('the owner of the tiny being talked to is allowed', () => {
    expect(ownsTiny('mytiny', ['other', 'mytiny'])).toBe(true)
  })

  it('🔴 owning SOME tiny is not owning THIS one', () => {
    // The tempting wrong gate — "is signed in and has tinys" — would grant every
    // builder code execution on every other builder's page.
    expect(ownsTiny('victim', ['attacker-own-tiny'])).toBe(false)
  })

  it('compares on the canonical slug, so case/punctuation drift is not a bypass', () => {
    // The worker's stored name is the strict slug; the request name is whatever
    // x-tiny-name carried. Neither direction may decide ownership.
    expect(ownsTiny('MyTiny', ['mytiny'])).toBe(true)
    expect(ownsTiny(' mytiny ', ['mytiny'])).toBe(true)
    expect(ownsTiny('my.tiny', ['mytiny'])).toBe(true)
    expect(ownsTiny('mytiny', ['My-Tiny'])).toBe(true)
    // …but canonicalization must not merge DISTINCT names into each other.
    expect(ownsTiny('mytiny2', ['mytiny'])).toBe(false)
    expect(ownsTiny('mytiny', ['mytinyx'])).toBe(false)
  })

  it('fails closed on every degraded input, without a special case per shape', () => {
    // A failed getUserWithTinys returns null; a missing header gives ''. These
    // are the paths a reviewer forgets, so they are asserted rather than assumed.
    expect(ownsTiny('mytiny', null as any)).toBe(false)
    expect(ownsTiny('mytiny', undefined as any)).toBe(false)
    expect(ownsTiny('mytiny', 'mytiny' as any)).toBe(false)  // a string is not a list
    expect(ownsTiny('', ['mytiny'])).toBe(false)
    expect(ownsTiny(null, ['mytiny'])).toBe(false)
    expect(ownsTiny(undefined, ['mytiny'])).toBe(false)
    // An empty/garbage NAME must not match an empty/garbage entry — canon('')
    // === canon('!!!'), and "both unusable" is not "the same tiny".
    expect(ownsTiny('!!!', ['???'])).toBe(false)
    expect(ownsTiny('mytiny', [null, undefined, 42])).toBe(false)
  })
})

describe('mayRunPageJs — the execution gate', () => {
  it('🔴 refuses a non-owner, whatever arrived on the wire', () => {
    const v = mayRunPageJs({ tinyName: 'evil', isOwner: false })
    expect(v.allowed).toBe(false)
  })

  it('allows the owner', () => {
    expect(mayRunPageJs({ tinyName: 'mytiny', isOwner: true }).allowed).toBe(true)
  })

  it('the refusal names the tiny and says what still happened', () => {
    // A refusal the user can't understand reads as the feature being broken —
    // and this one fires on a page the user is watching a tool call on.
    const v = mayRunPageJs({ tinyName: 'evil', isOwner: false })
    if (v.allowed) throw new Error('expected a refusal')
    expect(v.reason).toContain('/evil')
    expect(v.reason).toMatch(/owner/i)
    // CSS is applied; claiming otherwise would be false.
    expect(v.reason).toMatch(/styling/i)
  })

  it('a missing name still produces readable copy, not "/undefined"', () => {
    const v = mayRunPageJs({ tinyName: undefined, isOwner: false })
    if (v.allowed) throw new Error('expected a refusal')
    expect(v.reason).not.toContain('undefined')
    expect(v.reason).not.toContain('null')
  })
})

describe('the gate is wired where it has to be', () => {
  const strip = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')

  it('🔴 the chat route mounts customize_page conditionally, not unconditionally', () => {
    const src = strip(readFileSync('app/api/chat/route.ts', 'utf8'))
    // The pre-fix line was a bare `customizePageTool,` in the mount array.
    expect(src).not.toMatch(/^\s*customizePageTool,\s*$/m)
    expect(src).toContain('callerOwnsThisTiny ? [customizePageTool] : []')
    // Derived from the SESSION's own tiny list. A client-supplied ownership
    // claim would be the same bug with extra steps.
    expect(src).toContain("ownsTiny(tinyName, userTinys.map((t) => t.name))")
  })

  it('🔴 the browser gates the LIVE run too — the server callback is too late', () => {
    // beforeToolCallEvent emits the effect before the callback executes, so a
    // mount-only fix leaves the live path open to a fabricated tool call.
    const src = strip(readFileSync('components/chat/Chat.tsx', 'utf8'))
    expect(src).toContain('mayRunPageJs(')
    // The check must precede runCustomJs in the customize-page effect, or it
    // decides nothing.
    const gate = src.indexOf('mayRunPageJs(')
    const run = src.indexOf('runCustomJs(inp.js)')
    expect(gate).toBeGreaterThan(-1)
    expect(run).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(run)
    // …and the verdict is ACTED ON, not merely computed. Measured: replacing
    // `if (!verdict.allowed)` with `if (false)` left an ordering-only assertion
    // fully green while every visitor's JS ran. A gate whose answer is ignored
    // is indistinguishable from no gate.
    const between = src.slice(gate, run)
    expect(between).toContain('!verdict.allowed')
    // The refusal has to LEAVE the branch — falling through would run the code
    // right after reporting it blocked.
    expect(between).toMatch(/\bbreak\b|\breturn\b/)
  })

  it('the effect really is emitted before the server callback (the reason layer 2 exists)', () => {
    // Pins the premise this whole design rests on. If effects ever move to
    // afterToolCallEvent, the comments here become wrong and this fails.
    const src = readFileSync('lib/chat/strands-events.ts', 'utf8')
    const before = src.indexOf("event.type === 'beforeToolCallEvent'")
    // The PUSH, not the type union — `kind: 'customize-page'` also appears in
    // the StrandsEffect union near the top of the file, which is before every
    // handler and would make this assertion pass on the wrong line.
    const emit = src.indexOf("effects.push({ kind: 'customize-page'")
    const after = src.indexOf("event.type === 'afterToolCallEvent'")
    expect(before).toBeGreaterThan(-1)
    expect(emit).toBeGreaterThan(before)
    if (after > -1) expect(emit).toBeLessThan(after)
  })

  it('the prompt stops advertising customize_page when it is not mounted', () => {
    // A model told it has a tool it cannot call reports success for work that
    // never happened — worse than the missing feature.
    const src = readFileSync('lib/chat/prompt.ts', 'utf8')
    expect(src).toContain('canCustomizePage')
    const route = readFileSync('app/api/chat/route.ts', 'utf8')
    expect(route).toContain('canCustomizePage: callerOwnsThisTiny')
  })

  it('CSS stays ungated — the gate is scoped to its reason', () => {
    // CSS restyles; it cannot read the session, fetch, or touch localStorage.
    // An over-wide gate breaks the visible half of the feature for no gain, and
    // gates that inconvenience people get deleted.
    const src = strip(readFileSync('components/chat/Chat.tsx', 'utf8'))
    const cssApply = src.indexOf('applyCustomCss(inp.css)')
    expect(cssApply).toBeGreaterThan(-1)
    // No verdict check between the `if (inp.css)` branch and its apply.
    const branch = src.lastIndexOf('if (inp.css)', cssApply)
    expect(src.slice(branch, cssApply)).not.toContain('mayRunPageJs')
  })
})
