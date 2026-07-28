// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MarkdownContent, { MARKDOWN_RENDERERS } from '../components/chat/MarkdownContent'

const render = (content: string) => renderToStaticMarkup(createElement(MarkdownContent, { content }))

describe('MarkdownContent', () => {
  it('is memoized on the content string — the render-skip contract', () => {
    expect((MarkdownContent as any).$$typeof).toBe(Symbol.for('react.memo'))
  })

  it('exposes ONE module-scope renderer map (was: recreated per message per render)', () => {
    expect(MARKDOWN_RENDERERS).toBe(MARKDOWN_RENDERERS)
    expect(Object.keys(MARKDOWN_RENDERERS)).toEqual(
      expect.arrayContaining(['code', 'a', 'p', 'img', 'h1', 'blockquote', 'table', 'ul', 'ol']))
  })

  it('renders paragraphs with dir=auto (RTL replies align correctly)', () => {
    expect(render('hello')).toContain('<p dir="auto"')
  })

  it('opens absolute links in a new tab with tabnabbing guards', () => {
    const html = render('[x](https://example.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
  })

  it('keeps relative/internal links same-tab', () => {
    const html = render('[scout](/scout)')
    expect(html).toContain('href="/scout"')
    expect(html).not.toContain('target="_blank"')
  })

  it('renders javascript: image sources inert — the uriTransformer gap', () => {
    const html = render('![x](javascript:alert(1))')
    expect(html).toContain('[image]')
    expect(html).not.toContain('javascript:')
  })

  it('wraps safe images in a full-size link', () => {
    const html = render('![cat](https://example.com/cat.png)')
    expect(html).toContain('<img src="https://example.com/cat.png"')
    expect(html).toContain('loading="lazy"')
  })

  it('demotes h1 to a chat-scaled h3 inside bubbles', () => {
    expect(render('# Title')).toContain('<h3 dir="auto"')
  })

  it('wraps GFM tables in a horizontal scroller', () => {
    const html = render('|a|b|\n|-|-|\n|1|2|')
    expect(html).toContain('overflow-x-auto')
    expect(html).toContain('<table')
  })

  it('blockquotes use LOGICAL border/padding — the bar follows the reading side in RTL', () => {
    const html = render('> quoted')
    expect(html).toContain('border-s-2')
    expect(html).toContain('ps-3')
    expect(html).not.toMatch(/border-l-2|pl-3/)
  })

  it('typesets $…$ math through KaTeX (remark-math parses, rehype-katex renders)', () => {
    // Before c18 the rehype half was missing: math fell through as raw
    // code-styled text while katex's CSS shipped on every chat page anyway.
    const html = render('Energy: $E=mc^2$')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('$E=mc^2$')
  })

  it('typesets $$…$$ display math as a block (fences on their own lines)', () => {
    expect(render('$$\n\\int_0^1 x\\,dx\n$$')).toContain('katex-display')
  })

  it('renders fenced code without leaking the `inline` metadata attribute', () => {
    const html = render('```js\nconst x = 1\n```')
    expect(html).toContain('const')
    expect(html).not.toContain('inline=')
  })
})
