// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * First-paint budget guard (backlog v3 item 3): the overlay panels render
 * null until opened, so they must reach Chat via next/dynamic — a static
 * import drags ModelSettings(+Control+TelegramSettings)/MemoryPanel(+Graph)/
 * JobsPanel/CommandPalette (~3,500 lines) into the bundle of / and /[slug].
 * UniverseDrawer is EXEMPT: it owns its always-visible header trigger.
 */
const LAZY = ['ModelSettings', 'MemoryPanel', 'JobsPanel', 'CommandPalette']

describe('Chat first-paint budget', () => {
  const chat = readFileSync(join(__dirname, '../components/chat/Chat.tsx'), 'utf8')

  for (const name of LAZY) {
    it(`${name} is dynamically imported, never statically`, () => {
      expect(chat).not.toMatch(new RegExp(`^import .* from "\\./${name}"`, 'm'))
      expect(chat).toContain(`nextDynamic(() => import("./${name}")`)
    })
  }

  it('the pure model config comes from lib/chat, not the settings panel', () => {
    expect(chat).toContain('from "../../lib/chat/model-config"')
    const onboarding = readFileSync(join(__dirname, '../components/chat/Onboarding.tsx'), 'utf8')
    expect(onboarding).not.toMatch(/^import .* from "\.\/ModelSettings"/m)
    expect(onboarding).toContain('from "../../lib/chat/model-config"')
  })
})
