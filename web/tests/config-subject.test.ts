// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalSubject, isCurrentSubject, gateSubjectMutation } from '../lib/chat/config-subject'

/**
 * 🎯 Backlog v12 — "a value scoped to one SUBJECT still on screen after the
 * subject changed", applied to the config editor, where the subject is an
 * EDITABLE FIELD rather than a route.
 *
 * The load-bearing tests are the two that pull in opposite directions:
 *  - save with nothing loaded must PASS (that is the create flow, and every
 *    first click, because the click blurs the name input and starts the load)
 *  - price with nothing loaded must REFUSE (an unattributed price field is not
 *    a blank one — empty posts price_micro: 0 and makes a paid tiny free)
 * A single "is it loaded?" branch gets one of them wrong.
 */

describe('canonicalSubject', () => {
  it('treats a case-only difference as the SAME tiny — the save path lowercases before posting', () => {
    // Control.tsx: fetch body is `nameForm.toLowerCase()`, and ownsThisTiny
    // matches me.tinys on the same value. Calling "MyTiny" a different subject
    // from "mytiny" would block a user from saving their own tiny.
    expect(canonicalSubject('MyTiny')).toBe(canonicalSubject('mytiny'))
  })

  it('trims — a name field with a stray space addresses the same record', () => {
    expect(canonicalSubject('  weather ')).toBe('weather')
  })

  it('does NOT slugify: "cool.ai" and "cool-ai" are different subjects here', () => {
    // The worker canonicalizes strictly on its side. A stricter rule HERE would
    // call two records the same subject and let one tiny's load apply to another
    // — the exact bug this module exists to stop.
    expect(canonicalSubject('cool.ai')).not.toBe(canonicalSubject('cool-ai'))
  })

  it('coerces null/undefined to the empty subject rather than the string "null"', () => {
    expect(canonicalSubject(null)).toBe('')
    expect(canonicalSubject(undefined)).toBe('')
  })
})

describe('isCurrentSubject — latest-wins for the two subject-keyed loads', () => {
  it('applies a response for the name that is still requested', () => {
    expect(isCurrentSubject('weather', 'weather')).toBe(true)
  })

  it('🔴 DROPS the out-of-order response: blur b, blur a, b resolves last', () => {
    // The whole defect. Without this, b's systemPrompt/worker/theme/MCP config
    // repaint the form while the name field says "a", and Save then writes them
    // to a.
    expect(isCurrentSubject('b', 'a')).toBe(false)
  })

  it('applies a SLOW response for the name currently requested — b → a → b', () => {
    // Keyed on the name, not a counter, on purpose: the response is a pure
    // function of the name, so the first b's data is still the right answer for
    // the third state. A generation counter would discard it and refetch.
    expect(isCurrentSubject('b', 'b')).toBe(true)
  })

  it('is case/whitespace-insensitive, matching the load call sites', () => {
    expect(isCurrentSubject('Weather', ' weather')).toBe(true)
  })

  it('refuses an unsolicited apply when nothing is in flight', () => {
    expect(isCurrentSubject('weather', null)).toBe(false)
    expect(isCurrentSubject('weather', '')).toBe(false)
  })
})

describe('gateSubjectMutation — save', () => {
  it('fires when the form holds the settings for the name being saved', () => {
    const g = gateSubjectMutation('save', { loaded: 'weather', form: 'weather' })
    expect(g.ok).toBe(true)
  })

  it('🔴 REFUSES when the form holds ANOTHER tiny\'s settings, and names both', () => {
    // ⚠️ Multi-character, non-substring names on purpose. A mutant that
    // replaced the whole message with generic copy ("The form is stale — wait
    // before saving.") SURVIVED single-letter fixtures, because 'a' matched
    // "st_a_le" and 'b' matched "_b_efore". A message assertion is only as
    // strong as the improbability of its needle.
    const g = gateSubjectMutation('save', { loaded: 'zqx-loaded', form: 'vwy-target' })
    expect(g.ok).toBe(false)
    if (g.ok) throw new Error('unreachable')
    expect(g.reason).toBe('mismatch')
    // /api/control REPLACES field by field ('' overwrites), so this would not
    // merge — it would overwrite the target with the loaded tiny's prompt,
    // worker, theme and MCP config.
    expect(g.message).toContain('zqx-loaded')
    expect(g.message).toContain('vwy-target')
  })

  it('✅ ALLOWS a save with nothing loaded — that is the create flow', () => {
    // And every first click on an existing tiny too: the click blurs the name
    // input, which starts the load, so `loaded` is legitimately empty at click
    // time. Refusing here would make "Create AI" fail once, always.
    const g = gateSubjectMutation('save', { loaded: null, form: 'brand-new' })
    expect(g.ok).toBe(true)
    if (!g.ok) throw new Error('unreachable')
    expect(g.reason).toBe('nothing-loaded')
  })

  it('allows a case-only difference — you can save "MyTiny" over a load of "mytiny"', () => {
    expect(gateSubjectMutation('save', { loaded: 'mytiny', form: 'MyTiny' }).ok).toBe(true)
  })

  it('refuses when the name field was cleared but a load is still attributed', () => {
    // Posting now would address '' with another tiny's whole document.
    const g = gateSubjectMutation('save', { loaded: 'weather', form: '' })
    expect(g.ok).toBe(false)
  })
})

describe('gateSubjectMutation — price', () => {
  it('fires when the price shown was loaded for the tiny being priced', () => {
    expect(gateSubjectMutation('price', { loaded: 'weather', form: 'weather' }).ok).toBe(true)
  })

  it('🔴 REFUSES an unattributed price — an empty field posts price_micro 0 and makes a paid tiny FREE', () => {
    // loadPrice() clears priceLoadedFor but leaves priceForm, so after a failed
    // or in-flight read the field shows the PREVIOUS tiny's price (or nothing).
    // This is the case that must diverge from 'save'.
    const g = gateSubjectMutation('price', { loaded: null, form: 'weather' })
    expect(g.ok).toBe(false)
    if (g.ok) throw new Error('unreachable')
    expect(g.reason).toBe('unattributed')
    expect(g.message).toContain('weather')
  })

  it('🔴 refuses a price loaded for a DIFFERENT tiny, and names it', () => {
    const g = gateSubjectMutation('price', { loaded: 'cheap-bot', form: 'zqx-weather' })
    expect(g.ok).toBe(false)
    if (g.ok) throw new Error('unreachable')
    expect(g.reason).toBe('mismatch')
    expect(g.message).toContain('cheap-bot')
    expect(g.message).toContain('zqx-weather')
  })

  it('save and price DISAGREE on the nothing-loaded case — that asymmetry is the design', () => {
    const state = { loaded: null, form: 'weather' }
    expect(gateSubjectMutation('save', state).ok).toBe(true)
    expect(gateSubjectMutation('price', state).ok).toBe(false)
  })
})

describe('gateSubjectMutation — delete is deliberately ungated', () => {
  it('fires even when the form holds another tiny\'s settings', () => {
    // /api/delete sends the NAME and nothing else; its confirm dialog quotes
    // that same value and makes the user type it back, and purgeTinyKeys uses
    // it too. A mismatched form cannot misdirect it. Asserted so a later cycle
    // doesn't "harden" it into a dialog the user has already answered.
    const g = gateSubjectMutation('delete', { loaded: 'b', form: 'a' })
    expect(g.ok).toBe(true)
    if (!g.ok) throw new Error('unreachable')
    expect(g.reason).toBe('subject-only')
  })

  it('fires with nothing loaded at all', () => {
    expect(gateSubjectMutation('delete', { loaded: null, form: 'a' }).ok).toBe(true)
  })
})

describe('the guards are wired into Control.tsx at the sites that can misdirect', () => {
  const src = readFileSync(join(process.cwd(), 'components/chat/Control.tsx'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('gates the save button on the loaded-config name', () => {
    // Anchor to the CALL with its argument, not the bare identifier — a
    // file-wide match would pass on the import line alone.
    expect(code).toMatch(/gateSubjectMutation\(\s*'save'\s*,\s*\{\s*loaded:\s*loadedNameRef\.current/)
  })

  it('gates set_price on priceLoadedFor, NOT on loadedNameRef', () => {
    // The price is a second fetch that can fail while the config applied, so
    // reusing loadedNameRef here would call an unattributed price current.
    expect(code).toMatch(/gateSubjectMutation\(\s*'price'\s*,\s*\{\s*loaded:\s*priceLoadedFor/)
  })

  // ⚠️ BOTH of the position-only versions of these assertions SURVIVED a mutant
  // that DELETED the guard: `apply > guard` is trivially true when the other
  // guard (the price one) sits earlier in the file, and a `lastIndexOf` window
  // found that same earlier guard. So count the guards AND bracket each write.
  const GUARD = 'isCurrentSubject(target, requestedNameRef.current)'

  it('carries a latest-wins guard on BOTH subject-keyed loads', () => {
    // Two loads (config + price) → exactly two guards. Asserting the count is
    // what makes deleting either one a failure; a boolean "is it present" is
    // satisfied by the survivor.
    expect(code.split(GUARD).length - 1).toBe(2)
  })

  it('drops a stale config response before applyTinyData paints the form', () => {
    const apply = code.indexOf('applyTinyData(target, data)')
    expect(apply).toBeGreaterThan(-1)
    // The guard must be in the SAME .then, immediately above the write — not
    // merely somewhere earlier in the file.
    const guard = code.lastIndexOf(GUARD, apply)
    expect(guard).toBeGreaterThan(-1)
    expect(apply - guard).toBeLessThan(400)
  })

  it('drops a stale price response before it writes priceForm', () => {
    const priceWrite = code.indexOf('setPriceForm(micro > 0')
    expect(priceWrite).toBeGreaterThan(-1)
    const guardBefore = code.lastIndexOf(GUARD, priceWrite)
    expect(guardBefore).toBeGreaterThan(-1)
    expect(priceWrite - guardBefore).toBeLessThan(400)
  })

  it('records the in-flight name at every load start', () => {
    expect(code).toMatch(/requestedNameRef\.current\s*=\s*target/)
  })

  it('attributes the loaded price to the tiny it was loaded for', () => {
    // Without this write, priceLoadedFor stays null forever and the price gate
    // refuses EVERY legitimate set_price — a guard that only ever says no.
    // (A mutant deleting it passed every other test in this file.)
    expect(code).toMatch(/setPriceLoadedFor\(target\)/)
    // And it must be cleared when a new load starts, or a failed read leaves
    // the previous tiny's price looking attributed to this one.
    expect(code).toMatch(/setPriceLoadedFor\(null\)/)
  })

  it('leaves the delete button ungated (no gateSubjectMutation on the delete path)', () => {
    expect(code).not.toMatch(/gateSubjectMutation\(\s*'delete'/)
  })
})
