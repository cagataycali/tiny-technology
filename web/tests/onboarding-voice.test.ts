// @vitest-environment node
/**
 * Onboarding narration — language-set drift guard.
 *
 * The 14-language set lives in FOUR places that must agree:
 *   1. scripts/gen-onboarding-voice.mjs SCRIPTS (the source of truth)
 *   2. public/onboarding-voice/{lang}/p{0..4}.mp3 (the generated assets)
 *   3. ios/Tiny/Sources/Onboarding.swift OnboardingNarrator.langs
 *   4. android/…/ui/Onboarding.kt NARRATION_LANGS
 * A language added to the script but not regenerated (or not taught to a
 * client) ships a tour that silently falls back to English on that device —
 * no error anywhere. This test makes the drift loud in CI instead.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs module, no type surface needed for a key check
import { SCRIPTS } from '../scripts/gen-onboarding-voice.mjs'

const ROOT = path.join(__dirname, '..')
const PAGES = 5
const langs = Object.keys(SCRIPTS as Record<string, string[]>).sort()

/** Scrape a client source file's language list literal. */
function scrapeLangs(file: string, anchor: string): string[] {
  const src = readFileSync(path.join(ROOT, file), 'utf8')
  const at = src.indexOf(anchor)
  expect(at, `${anchor} not found in ${file}`).toBeGreaterThan(-1)
  // Quoted 2-letter codes between the anchor and the closing bracket/paren.
  const tail = src.slice(at, src.indexOf(')', at) + 1 || undefined)
  // Array.from, not spread: repo tsc targets pre-es2015 iteration (vitest's
  // transform masks it; bare `tsc --noEmit` doesn't).
  const codes = Array.from(tail.matchAll(/"([a-z]{2})"/g)).map((m) => m[1])
  return Array.from(new Set(codes)).sort()
}

describe('onboarding narration language set', () => {
  it('has 5 non-empty page scripts per language', () => {
    for (const lang of langs) {
      const pages = (SCRIPTS as Record<string, string[]>)[lang]
      expect(pages, lang).toHaveLength(PAGES)
      for (const p of pages) expect(p.trim().length, `${lang} page`).toBeGreaterThan(20)
    }
  })

  it('generated an mp3 for every language × page', () => {
    for (const lang of langs) {
      for (let p = 0; p < PAGES; p++) {
        const f = path.join(ROOT, 'public', 'onboarding-voice', lang, `p${p}.mp3`)
        expect(existsSync(f), `${lang}/p${p}.mp3 missing — run scripts/gen-onboarding-voice.mjs ${lang}`).toBe(true)
      }
    }
  })

  it('iOS OnboardingNarrator.langs matches the script', () => {
    expect(scrapeLangs('ios/Tiny/Sources/Onboarding.swift', 'private static let langs')).toEqual(langs)
  })

  it('Android NARRATION_LANGS matches the script', () => {
    expect(scrapeLangs('android/app/src/main/java/technology/tiny/app/ui/Onboarding.kt', 'NARRATION_LANGS = setOf')).toEqual(langs)
  })
})
