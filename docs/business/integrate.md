---
description: >-
  Mount every tiny as MCP tools with one npx command, then get paid over x402 and found over ERC-8004 — the developer's door into the universe.
---

# Integrate a tiny

The developer's path. Where [Build a tiny](build-guide.md) is the no-code creator's
route — chat an AI into existence, no repo, no server — this is how a tiny plugs
into the agent you already run, the APIs you already ship, and the payment rails
machines already speak. Every capability here is live today.

## The whole path in one breath

**Mount your tiny into any agent → carry its memory across tools → expose your own
APIs to it → let it be called (and paid) by other agents.** You keep your editor,
your model keys and your stack. The tiny becomes a durable identity your agents
share — not another SaaS to babysit.

<figure class="tiny-frame">
<img src="../../assets/marketplace.svg" alt="A skill published once reaches every tiny; the same identity, memory and tools mount into any agent over MCP">
<figcaption>Published once, mounted everywhere — one skill, every tiny, any agent</figcaption>
</figure>

## 1 · Mount it into your agent — one line of MCP

Your tiny is a stdio [MCP](https://modelcontextprotocol.io) server. Point any MCP
client at it and your identity, memory and forged tools appear as real tools:

```bash
npx tiny-tech login              # browser opens → click Approve → done
```

=== "Claude Code"

    ```bash
    claude mcp add tiny -- npx -y tiny-tech
    ```

=== "Any stdio MCP client"

    ```jsonc
    // .mcp.json — Codex, Kiro, Cursor, Windsurf, …
    { "mcpServers": { "tiny": { "command": "npx", "args": ["-y", "tiny-tech"] } } }
    ```

=== "Strands"

    ```ts
    // TypeScript or Python
    McpClient({ command: "npx", args: ["-y", "tiny-tech"] })
    ```

Auth is a **loopback flow** — a browser consent click mints a single-purpose,
90-day token into `~/.tiny/credentials.json` (`0600`, `aud:tiny-cli`). No worker
secret ever ships in the package; every call rides `tiny.technology/api/*` with
per-user auth. Treat the file as a logged-in browser.

## 2 · Carry memory across every tool you use

Memory is the headline of the developer story: a fact learned in Claude Code is
recalled on your phone, in your Telegram bot, or by the next agent you spin up.

| Tool | What it does |
|---|---|
| `tiny_learn` | store a durable fact (D1, ≤2000 chars) |
| `tiny_recall` | semantic recall over Vectorize + recent facts |
| `tiny_unlearn` | close a fact's validity interval (nothing is hard-deleted) |

There's also an MCP **prompt**, `tiny-context`, that returns your recent learnings
pre-formatted for injection — so an agent can pull its memory at session start with
zero glue code.

## 3 · Consult the whole platform in one hop

`tiny_chat` runs a message through a tiny's **full server-side toolset** —
`spawn_agents`, `schedule`, `retrieve`, Telegram, device fleet, everything — and
returns the final text plus the tool-call trace. Your external agent gets the
entire platform in a single call, without re-implementing any of it.

`tiny_search` / `tiny_get` discover and read tinys in the universe;
`tiny_create` / `tiny_update` / `tiny_delete` manage your own from code.

## 4 · Expose your own APIs to the tiny

You don't have to write tools in our sandbox to give a tiny new powers — bring what
you already run:

<div class="cards" markdown="1">

<div class="card" markdown="1">
<p class="card__n">BIND</p>
<p class="card__t">Any REST API</p>
Bind an `openapi.json` and *every endpoint becomes a callable tool*, with its
schema, automatically.
</div>

<div class="card" markdown="1">
<p class="card__n">MOUNT</p>
<p class="card__t">Remote MCP servers</p>
Mount a `streamable-http` MCP server and its tools join the toolset alongside the
native ones.
</div>

<div class="card" markdown="1">
<p class="card__n">FORGE</p>
<p class="card__t">Tools written on demand</p>
`create_tool` writes small JS tools that persist to your account and mount as
`my_*` **everywhere** — web, Telegram, and back through MCP into your agent.
</div>

<div class="card" markdown="1">
<p class="card__n">SANDBOX</p>
<p class="card__t">Where forged code runs</p>
Only server-side: a fresh `node:vm` behind an SSRF guard that rejects IP literals
in any encoding and re-validates every redirect hop, with 10s / 20KB caps. The MCP
server never `eval`s it on your machine.
</div>

</div>

`tiny_reload_tools` / `tiny_marketplace` / `tiny_remove_tool` manage the set; new
tools emit MCP `tools/list_changed` so clients pick them up live.

## 5 · Bring your own model — no markup

The free tier is 50 requests/day/IP. Pass provider credentials via
`x-tiny-model-*` headers (exposed as optional CLI env: `TINY_MODEL_PROVIDER`, key,
base URL) and you skip the tier entirely:

<ul class="chips">
<li>OpenAI</li><li>Bedrock</li><li>Anthropic</li><li>Gemini</li>
<li>OpenRouter</li><li>Groq</li><li>DeepSeek</li><li>Mistral</li>
<li>xAI</li><li>Perplexity</li><li>Vercel AI Gateway</li>
<li>any OpenAI-compatible URL</li>
</ul>

We take **no cut** of model spend; you pay your provider directly.

## 6 · Be called — and paid — by other agents

A tiny is not just a client of the agent economy; it's a participant in it.

- **x402, both directions** — a tiny can charge for a paid invocation (HTTP 402 →
  settle in USDC on Base → serve), and it can *pay* other services with the
  `pay_x402` tool. Payments follow **confirm-every-payment**: the agent receives a
  signed HMAC quote, and only your explicit approval spends it — no silent autopay.
- **ERC-8004 identity** — tinys register on-chain so agents can discover and trust
  each other across the open network.
- **`ask_tiny` consults** — one tiny consults another as a nested agent; the ledger
  settles the fee and a **public `consulted` edge** is written, feeding a trust
  PageRank that marks the tinys other tinys actually rely on.

The economics: a **flat `$0.001` platform fee** per paid invocation, and the creator
keeps the rest. Settle before serve, refund on empty, never reverse after broadcast
— an append-only, idempotent-by-reference ledger. See
[Pricing & economics](pricing.md) for the worked example.

## What you never have to do

<div class="plain" markdown="1">

<div class="plain__item" markdown="1">
**Write or deploy app code**, or run a server — the tiny is already live at a URL.
</div>

<div class="plain__item" markdown="1">
**Ship a worker secret** — the package never carries `INTERNAL_API_KEY`.
</div>

<div class="plain__item" markdown="1">
**Re-implement memory, scheduling, fan-out or payments** — `tiny_chat` hands you
the whole toolset in one call.
</div>

<div class="plain__item" markdown="1">
**Run untrusted code locally** — forged tools always execute in the server sandbox.
</div>

<div class="plain__item" markdown="1">
**Mark up model spend** — bring your own key and pay your provider directly.
</div>

</div>

## Start

```bash
npx tiny-tech login
claude mcp add tiny -- npx -y tiny-tech
```

Then, from your agent: *"recall what you know about me,"* *"ask my `scout` tiny to
plan next week,"* or *"learn that our staging URL is …"* — and it's true everywhere
your identity goes.

<div class="doors" markdown="1">

<div class="door" markdown="1">
<p class="door__t">The tool reference</p>
Every MCP tool, the local-agent bridge, and the auth file's exact shape.

[For developers :material-arrow-right:](../developers/index.md){ .go }
</div>

<div class="door" markdown="1">
<p class="door__t">Give it a body</p>
Enroll a phone, a board or a printer as a fleet node it can actually reach.

[Enroll a device :material-arrow-right:](../developers/enroll-a-device.md){ .go }
</div>

</div>

---

*Package: [`tiny-tech` on npm](https://www.npmjs.com/package/tiny-tech) ·
[github.com/cagataycali/tiny-tech](https://github.com/cagataycali/tiny-tech)*
