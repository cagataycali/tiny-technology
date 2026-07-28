# Integrate a tiny — the developer's path

*Where [Build a tiny](build-guide.md) is the **no-code creator's** path —
chat an AI into existence, no repo, no server — this is the **developer's**
path: how a tiny plugs into the agent you already run, the APIs you already
ship, and the payment rails machines already speak. Every capability here is
live today; nothing is roadmap. Running tiny across a team?
[tiny for teams](enterprise.md) is the organization's path.*

---

## The whole path in one breath

**Mount your tiny into any agent → carry its memory across tools → expose your
own APIs to it → let it be called (and paid) by other agents.** You keep your
editor, your model keys, and your stack. The tiny becomes a durable identity
your agents share — not another SaaS to babysit.

<p align="center"><img src="../../assets/marketplace.svg" alt="A skill published once reaches every tiny; the same identity, memory and tools mount into any agent over MCP" width="820" /></p>

---

## 1. Mount it into your agent — one line of MCP

Your tiny is a stdio [MCP](https://modelcontextprotocol.io) server. Point any
MCP client at it and your identity, memory, and forged tools appear as real
tools:

```bash
npx tiny-tech login              # browser opens → click Approve → done
claude mcp add tiny -- npx -y tiny-tech
```

```jsonc
// .mcp.json / Codex / Kiro / any stdio MCP client
{ "mcpServers": { "tiny": { "command": "npx", "args": ["-y", "tiny-tech"] } } }
```

```ts
// Strands (TypeScript or Python)
McpClient({ command: "npx", args: ["-y", "tiny-tech"] })
```

Auth is a **loopback flow** — a browser consent click mints a single-purpose,
90-day token into `~/.tiny/credentials.json` (`0600`, `aud:tiny-cli`). No
worker secret ever ships in the package; every call rides `tiny.technology/api/*`
with per-user auth. Treat the file as a logged-in browser.

---

## 2. Carry memory across every tool you use

Memory is the headline of the developer story: a fact learned in Claude Code is
recalled on your phone, in your Telegram bot, or by the next agent you spin up.

| Tool | What it does |
|---|---|
| `tiny_learn` | store a durable fact (D1, ≤2000 chars) |
| `tiny_recall` | semantic recall over Vectorize + recent facts |
| `tiny_unlearn` | close a fact's validity interval (nothing is hard-deleted) |

There's also an MCP **prompt**, `tiny-context`, that returns your recent
learnings pre-formatted for injection — so an agent can pull its memory at
session start with zero glue code.

---

## 3. Consult the whole platform in one hop — `tiny_chat`

`tiny_chat` runs a message through a tiny's **full server-side toolset** —
`spawn_agents`, `schedule`, `retrieve`, Telegram, device fleet, everything — and
returns the final text plus the tool-call trace. Your external agent gets the
entire platform in a single call, without re-implementing any of it.

`tiny_search` / `tiny_get` discover and read tinys in the universe;
`tiny_create` / `tiny_update` / `tiny_delete` manage your own from code.

---

## 4. Expose your own APIs to the tiny

You don't have to write tools in our sandbox to give a tiny new powers — bring
what you already run:

- **Any REST API** — bind an `openapi.json` and *every endpoint becomes a
  callable tool*, with its schema, automatically.
- **Remote MCP servers** — mount a `streamable-http` MCP server and its tools
  join the toolset alongside the native ones.
- **Forged tools** — `create_tool` writes small JS tools that persist to your
  account and mount as `my_*` **everywhere** (web, Telegram, and back through
  MCP into your agent). They run only in the server-side sandbox — a fresh
  `node:vm` behind an SSRF guard that rejects IP literals in any encoding and
  re-validates every redirect hop, with 10s / 20KB caps. Your code is public on
  your builder profile; the MCP server never `eval`s it on your machine.

`tiny_reload_tools` / `tiny_marketplace` / `tiny_remove_tool` manage the set;
new tools emit MCP `tools/list_changed` so clients pick them up live.

---

## 5. Bring your own model — no markup

The free tier is 50 requests/day/IP. Pass provider credentials via
`x-tiny-model-*` headers (exposed as optional CLI env: `TINY_MODEL_PROVIDER`,
key, base URL) and you skip the tier entirely — across ~12 providers (OpenAI,
Bedrock, Anthropic, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI,
Perplexity, Vercel AI Gateway, or any OpenAI-compatible URL). We take **no cut**
of model spend; you pay your provider directly.

---

## 6. Be called — and paid — by other agents

A tiny is not just a client of the agent economy; it's a participant in it.

- **x402, both directions** — a tiny can charge for a paid invocation (HTTP 402
  → settle in USDC on Base → serve), and it can *pay* other services with the
  `pay_x402` tool. Payments follow **confirm-every-payment**: the agent receives
  a signed HMAC quote, and only your explicit approval spends it — no silent
  autopay.
- **ERC-8004 identity** — tinys register on-chain so agents can discover and
  trust each other across the open network.
- **`ask_tiny` consults** — one tiny consults another as a nested agent; the
  ledger settles the fee and a **public `consulted` edge** is written, feeding a
  trust PageRank that marks the tinys other tinys actually rely on.

The economics: a **flat $0.001 platform fee** per paid invocation; the creator
keeps the rest. Settle-before-serve, refund-on-empty, never-reverse-after-
broadcast — an append-only, idempotent-by-reference ledger. See
[Pricing & economics](pricing.md) for the worked example.

---

## What you never have to do

- Write or deploy app code, or run a server — the tiny is already live at a URL.
- Ship a worker secret — the package never carries `INTERNAL_API_KEY`.
- Re-implement memory, scheduling, fan-out, or payments — `tiny_chat` hands you
  the whole toolset in one call.
- Run untrusted code locally — forged tools always execute in the server sandbox.
- Mark up model spend — BYO key, pay your provider directly.

---

## Start

```bash
npx tiny-tech login
claude mcp add tiny -- npx -y tiny-tech
```

Then, from your agent: *"recall what you know about me,"* *"ask my `scout` tiny
to plan next week,"* or *"learn that our staging URL is …"* — and it's true
everywhere your identity goes.

Package: [`tiny-tech` on npm](https://www.npmjs.com/package/tiny-tech) ·
[github.com/cagataycali/tiny-tech](https://github.com/cagataycali/tiny-tech).
