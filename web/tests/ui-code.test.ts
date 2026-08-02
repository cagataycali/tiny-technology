// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideUiCode,
  buildUiComponentFunction,
  UI_SHADOW_PARAMS,
  UI_CODE_MISSING_ERROR,
  UI_CODE_INVALID_ERROR_PREFIX,
} from '@/lib/chat/ui-code'

/**
 * 🧩 render_ui's HONESTY CONTRACT (lib/chat/ui-code.ts).
 *
 * The voice bridge's render_ui case returned {ok:true, note:"rendered"}
 * unconditionally — the model narrated a UI that was actually a red
 * "No component code provided" box or a "❌ Component Error" card. Same
 * family as clipboard-write's fabricated success: a tool result is a claim
 * the model will SPEAK, so the executor verifies what is verifiable
 * (presence + compilability) before the claim leaves.
 *
 * The compiler is ONE implementation — buildUiComponentFunction — used by
 * both the verifier and DynamicUI's renderer, so "compiles at the gate" and
 * "compiles at render" cannot drift, and the c31 realm-shadow posture rides
 * along wherever the code is built.
 */

const VALID = '(props) => { return createElement("div", null, "hi") }'

describe('decideUiCode', () => {
  it('refuses a missing / non-string / blank componentCode with the model-facing error', () => {
    for (const bad of [undefined, null, 42, {}, [], '', '   \n\t ']) {
      const d = decideUiCode(bad as unknown)
      expect(d.ok).toBe(false)
      if (!d.ok) expect(d.error).toBe(UI_CODE_MISSING_ERROR)
    }
    // The error names the outcome the model must not claim.
    expect(UI_CODE_MISSING_ERROR).toContain('nothing was rendered')
  })

  it('refuses code the shared compiler cannot parse, quoting the SyntaxError', () => {
    const d = decideUiCode('(props) => { return createElement("div" }')
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.error.startsWith(UI_CODE_INVALID_ERROR_PREFIX)).toBe(true)
      expect(d.error.length).toBeGreaterThan(UI_CODE_INVALID_ERROR_PREFIX.length)
    }
    expect(UI_CODE_INVALID_ERROR_PREFIX).toContain('nothing was rendered')
  })

  it('accepts a valid component and passes the code through UNTOUCHED (no trim)', () => {
    const padded = `\n  ${VALID}  \n`
    const d = decideUiCode(padded)
    expect(d).toEqual({ ok: true, code: padded })
  })

  it('verification is CONSTRUCTION only — code with a runtime throw still passes the gate', () => {
    // If the gate executed the code, this would throw here instead of at
    // render (where the ErrorBoundary owns it). Construction must parse
    // without running a single line.
    const d = decideUiCode('(() => { throw new Error("runtime boom") })()')
    expect(d.ok).toBe(true)
  })
})

describe('buildUiComponentFunction', () => {
  it('builds a callable that yields the component when invoked with React only', () => {
    const ReactStub = {
      createElement: (...a: unknown[]) => ({ el: a }),
      useState: () => {}, useEffect: () => {}, useMemo: () => {},
      useCallback: () => {}, useRef: () => {},
    }
    const fn = buildUiComponentFunction(VALID)
    const Component = fn(ReactStub, {}) as (p: unknown) => unknown
    expect(typeof Component).toBe('function')
    expect(Component({})).toEqual({ el: ['div', null, 'hi'] })
  })

  it('shadows every page global the c31 posture names, and they arrive undefined', () => {
    for (const g of ['localStorage', 'document', 'window', 'globalThis', 'fetch', 'navigator']) {
      expect(UI_SHADOW_PARAMS).toContain(g)
    }
    // A component that reads a shadowed global gets undefined, not the page's.
    const fn = buildUiComponentFunction('(() => typeof window)()')
    const seen = fn({ createElement: () => null }, {})
    expect(seen).toBe('undefined')
  })

  it('strict mode is on — the sloppy-this escape stays closed', () => {
    const fn = buildUiComponentFunction('(function(){ return this })()')
    expect(fn({ createElement: () => null }, {})).toBeUndefined()
  })
})

describe('the two call sites actually use the contract', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

  it('DynamicUI compiles through buildUiComponentFunction — no inline new Function', () => {
    const code = stripComments(src('components/chat/DynamicUI.tsx'))
    expect(code).toMatch(/buildUiComponentFunction\(componentCode\)/)
    expect(code).not.toMatch(/new Function\(/)
  })

  it("Chat's voice render_ui case gates on decideUiCode BEFORE appending the bubble", () => {
    const code = stripComments(src('components/chat/Chat.tsx'))
    // Anchor to the case block: the decision must be consulted and its
    // refusal returned before any UIComponent is constructed from args.
    const caseBlock = code.slice(code.indexOf('case "render_ui"'))
    const gate = caseBlock.indexOf('decideUiCode(args?.componentCode)')
    const refusal = caseBlock.indexOf('if (!u.ok) return u')
    const append = caseBlock.indexOf('componentCode: u.code')
    expect(gate).toBeGreaterThan(-1)
    expect(refusal).toBeGreaterThan(gate)
    expect(append).toBeGreaterThan(refusal)
  })
})
