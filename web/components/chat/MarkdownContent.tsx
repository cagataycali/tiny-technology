"use client";

/**
 * Memoized message markdown (extracted from Chat.tsx's inline ReactMarkdown).
 *
 * Why this exists: during streaming, every rAF flush re-renders the whole
 * transcript, and the renderer map used to be recreated inline PER MESSAGE
 * PER RENDER — so every delta re-parsed every message's markdown. The map is
 * now a module-scope constant (created once per JS session) and the component
 * is React.memo'd on its `content` string: unchanged messages skip the parse
 * entirely. This is the payoff of c10's reducer keeping untouched messages
 * reference-identical.
 */
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-async-light";
import codeTheme from "react-syntax-highlighter/dist/esm/styles/prism/a11y-dark";

const REMARK_PLUGINS = [remarkMath, remarkGfm];
// remark-math only PARSES $…$ into math nodes — without rehype-katex they
// fell through to code-styled raw text, so an agent's $E=mc^2$ never typeset
// even though Chat has shipped katex's CSS all along (the c18 finding).
// ⚠️ Versions are LOAD-BEARING: react-markdown v8 is the unified-10
// generation, so remark-math is pinned to v5 and rehype-katex to v6 —
// remark-math v6 (unified 11) made a display-math block ($$ on its own
// lines) CRASH the whole message render in mdast-util-math's exit handler.
// The tests pin both the typesetting and that crash staying fixed.
const REHYPE_PLUGINS = [rehypeKatex];

export const MARKDOWN_RENDERERS = {
  code(props: any) {
    // `inline` is react-markdown metadata, not a DOM attribute — riding the
    // spread it reaches <code>/SyntaxHighlighter's DOM and React logs a
    // non-boolean-attribute error on every markdown message (c12 console QA).
    const { children, className, inline: _inline, ...rest } = props as any;
    const match = /language-(\w+)/.exec(className || "");
    return match ? (
      <SyntaxHighlighter
        {...rest}
        PreTag="div"
        children={String(children).replace(/\n$/, "")}
        language={match[1]}
        style={codeTheme}
        customStyle={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(var(--tiny-accent-rgb),0.15)' }}
        className="rounded-lg my-2"
      />
    ) : (
      <code {...rest} className={`${className} px-1 py-0.5 rounded bg-black/30 text-sm`}>
        {children}
      </code>
    );
  },
  a(props: any) {
    // EXTERNAL links open in a NEW tab — a same-tab nav would abandon the
    // conversation mid-read; rel guards reverse-tabnabbing + SEO leakage
    // from generated URLs. Internal links (/name, #anchor) navigate in
    // place — jumping tabs to visit a sibling tiny would be disorienting.
    // No window during SSR/tests: treat absolute http(s) links as external
    // there (the pre-extraction code would have thrown instead).
    const { node, href, ...rest } = props as any;
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const external = typeof href === "string" && /^https?:\/\//i.test(href) && (!origin || !href.startsWith(origin));
    return (
      <a
        href={href}
        {...rest}
        {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}
        className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
        style={{ color: 'var(--tiny-accent)' }}
      />
    );
  },
  p(props: any) {
    // dir=auto: a tiny replying in Arabic/Hebrew gets right-aligned text +
    // correct punctuation placement, per paragraph — Latin unaffected
    return <p dir="auto" className="mb-2 last:mb-0 text-base leading-relaxed" {...props} />;
  },
  img(props: any) {
    // Inline media (incl. on-device generate_image results the agent embeds
    // by hosted URL) — constrained inside the bubble, click opens full-size.
    const { node, src, alt, ...rest } = props as any;
    // Scheme-guard the src: react-markdown v8 runs its uriTransformer on <a>
    // href but NOT on image src (transformImageUri isn't set), so a hostile
    // tiny — including a stranger's public tiny you're chatting with — could
    // emit ![x](javascript:…) and we'd wrap the (inert) img in a LIVE
    // clickable <a href="javascript:…">, bypassing the link sanitizer and
    // running script in this origin (where the session/BYOK keys live).
    // Allow only image-safe schemes: http(s), protocol-/root-relative, and
    // data:image. Anything else → render inert.
    const raw = typeof src === "string" ? src.trim() : "";
    const safe = /^(https?:\/\/|\/\/|\/|data:image\/)/i.test(raw) ? raw : undefined;
    if (!safe) return <span className="text-gray-500 italic">[image]</span>;
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer nofollow">
        <img src={safe} alt={alt || "image"} loading="lazy" className="rounded-xl my-2 max-h-80 max-w-full object-contain" {...rest} />
      </a>
    );
  },
  // Headings/quotes: the old prose/prose-invert classes were phantoms
  // (@tailwindcss/typography was never installed) — browser defaults gave
  // headings giant page-title margins inside bubbles. Chat-scaled renderers.
  h1(props: any) { return <h3 dir="auto" className="text-xl font-bold mt-3 mb-2" {...props} />; },
  h2(props: any) { return <h3 dir="auto" className="text-lg font-bold mt-3 mb-1.5" {...props} />; },
  h3(props: any) { return <h4 dir="auto" className="text-base font-semibold mt-2 mb-1" {...props} />; },
  blockquote(props: any) {
    // Logical border-s/ps, not physical left: dir=auto right-aligns an
    // Arabic/Hebrew quote, and the bar must sit on the READING side (start),
    // with its gap — physical -l put the bar on the wrong side for RTL.
    return <blockquote dir="auto" className="border-s-2 ps-3 my-2 text-gray-400 italic" style={{ borderColor: 'rgba(var(--tiny-accent-rgb),0.4)' }} {...props} />;
  },
  hr() {
    return <hr className="my-3 border-0 h-px" style={{ background: 'rgba(var(--tiny-accent-rgb),0.2)' }} />;
  },
  // GFM tables: agent-authored column counts are unbounded — scroll wide
  // tables inside the bubble instead of blowing out the column (same
  // containment as tool payloads/render_ui)
  table(props: any) {
    return (
      <div className="overflow-x-auto my-2">
        <table className="text-sm" {...props} />
      </div>
    );
  },
  ul(props: any) {
    const { ordered, ...rest } = props as any;
    return <ul dir="auto" className="list-disc list-inside space-y-1 text-base" {...rest} />;
  },
  ol(props: any) {
    const { ordered, ...rest } = props as any;
    return <ol dir="auto" className="list-decimal list-inside space-y-1 text-base" {...rest} />;
  },
};

function MarkdownContentImpl({ content }: { content: string }) {
  return (
    <ReactMarkdown components={MARKDOWN_RENDERERS} remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} className="max-w-none">
      {content}
    </ReactMarkdown>
  );
}

/** memo on the content STRING — the render-skip contract item 11 exists for. */
const MarkdownContent = memo(MarkdownContentImpl);
export default MarkdownContent;
