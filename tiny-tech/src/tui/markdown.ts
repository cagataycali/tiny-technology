/**
 * Terminal markdown rendering — streaming-safe.
 *
 * marked + marked-terminal render ANSI-styled markdown. For live streaming,
 * partial markdown can break rendering (unclosed code fences, dangling bold),
 * so `renderMarkdown(text, { streaming: true })` patches incomplete syntax
 * before rendering each frame.
 */
import { marked } from 'marked'
// @ts-ignore — marked-terminal ships loose types
import { markedTerminal } from 'marked-terminal'

marked.use(
  markedTerminal({
    reflowText: false,
    tab: 2,
  }) as any,
)

/** Close dangling markdown so partial streams render cleanly. */
function patchPartial(text: string): string {
  let out = text

  // Inside an unclosed fenced code block? Just close it — everything after
  // the fence is code, so no inline patching applies.
  const fences = (out.match(/^```/gm) || []).length
  if (fences % 2 === 1) return out + '\n```'

  // Dangling inline code (odd number of backticks outside fences)
  const stripped = out.replace(/```[\s\S]*?```/g, '')
  const ticks = (stripped.match(/`/g) || []).length
  if (ticks % 2 === 1) out += '`'

  // Dangling bold markers
  const bold = (stripped.match(/\*\*/g) || []).length
  if (bold % 2 === 1) out += '**'

  return out
}

export function renderMarkdown(text: string, opts: { streaming?: boolean } = {}): string {
  if (!text) return ''
  try {
    const src = opts.streaming ? patchPartial(text) : text
    const rendered = marked.parse(src) as string
    // marked-terminal pads with trailing newlines — trim for tight layout
    return rendered.replace(/\s+$/, '')
  } catch {
    return text
  }
}
