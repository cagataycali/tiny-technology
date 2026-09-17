/**
 * Glyphs for tool chips.
 *
 * WHY: a running panel is mostly a list of tool names, and at a glance the
 * shape of the work matters more than the spelling — a screenshot, a shell
 * command and a mesh call should be distinguishable without reading. Prefixes
 * are matched longest-first so `use_computer` wins over a bare `use_`.
 *
 * ⚠️ EVERY GLYPH MUST BE WIDTH-UNAMBIGUOUS, or it breaks panel borders.
 *
 * Ink lays out with string-width; the terminal draws with its own font. Four of
 * these (🖥 🕸 ✉ ✈, all Emoji_Presentation=No) are counted as ONE column but
 * drawn as two, which pushed a bordered panel's right edge one column out — a
 * visibly crooked box whenever a mesh_ or use_ tool appeared. The VS16 suffix
 * (U+FE0F) forces emoji presentation, so string-width says 2 and the terminal
 * draws 2. Narrow glyphs (⌘ ♫ ✎ ↯ •) are unambiguous already and take no
 * selector. tool-icons.test.mjs enforces this for the whole table.
 *
 * An empty string is not a valid entry either: `EXACT[name]` is truthiness-tested,
 * so '' silently falls through to the prefix match. use_apple sat like that until
 * the width test caught it.
 */
const EXACT: Record<string, string> = {
  bash: '⌘',
  use_computer: '🖥️',
  // Not the Apple logo (U+F8FF): it's a private-use codepoint that string-width
  // measures as 1, draws as 1 on macOS and as tofu everywhere else.
  use_apple: '🍎',
  use_spotify: '♫',
  use_google: '✉️',
  use_telegram: '✈️',
  use_whatsapp: '💬',
  use_adb: '📱',
  use_openapi: '🔗',
  use_memory: '🧠',
  use_tools: '🔧',
  use_integrations: '🔌',
  // Not the plug — that's use_integrations, which connects tiny to a service.
  // This one slots someone ELSE's tool ecosystem into this conversation.
  use_mcp: '🧩',
  // devduck's own glyph for it, and Emoji_Presentation=Yes, so no VS16 needed.
  use_github: '🐙',
  fileEditor: '✎',
  httpRequest: '↯',
  // Parallel sub-agents — Emoji_Presentation=Yes, width-unambiguous, no VS16.
  spawn_agents: '🤖',
}

const PREFIX: Array<[string, string]> = [
  ['mesh_', '🕸️'],
  ['tiny_', '🌱'],
  ['my_', '⚡'],
  ['use_', '🖥️'],
]

/** Every glyph the TUI can print — the width test walks this. */
export const ALL_ICONS: string[] = [...Object.values(EXACT), ...PREFIX.map(([, i]) => i), '•']

/** Icon for a tool name — never throws, always returns something printable. */
export function toolIcon(name: string | undefined): string {
  if (!name) return '•'
  if (EXACT[name]) return EXACT[name]
  for (const [p, icon] of PREFIX) if (name.startsWith(p)) return icon
  return '•'
}
