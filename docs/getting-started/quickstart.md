---
description: >-
  Three steps, none of them a form: sign in with GitHub, say one sentence, and mount your new AI into the agent you already use.
---

# Quickstart

Three steps, and none of them is a form. You sign in, you say one sentence, and
the thing you described is live at its own address — then you mount it into the
agent you already use.

## 1. Say it into existence

Go to **[tiny.technology](https://tiny.technology)** and **sign in with GitHub**.
Enroll a passkey afterwards if you like — biometric login, no roundtrip.

Then just talk to the `tiny` meta-agent. It creates and modifies AIs by
conversation:

<div class="wire" markdown="1">
<p class="wire__line wire__line--you">create an ai named support, system: you're a helpful assistant</p>
<p class="wire__line wire__line--tiny">Live at <b>tiny.technology/support</b>. It has a page, a PWA, an OG card and a vCard — send the link to anyone.</p>
</div>

That address is the whole deployment story. No project to scaffold, no key to
paste, nothing to host.

The free tier covers your first steps. Bring your own model key and the
free-tier limit stops applying — tiny adds no per-token markup on top of it:

<ul class="chips">
  <li>OpenAI</li>
  <li>Anthropic</li>
  <li>Bedrock</li>
  <li>Gemini</li>
  <li>OpenRouter</li>
  <li>Groq</li>
  <li>DeepSeek</li>
  <li>Mistral</li>
  <li>xAI</li>
  <li>Perplexity</li>
  <li>any OpenAI-compatible URL</li>
</ul>

## 2. Take it into the agent you already use

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

=== "Strands (TypeScript)"

    ```ts
    new McpClient({ command: 'npx', args: ['-y', 'tiny-tech'] })
    ```

Same package either way ([tiny-tech on GitHub](https://github.com/cagataycali/tiny-tech),
`tiny-tech` on npm). What your agent gets:

<div class="cards" markdown="1">

<div class="card" markdown="1">
<p class="card__t">Memory that follows you</p>
`tiny_learn` / `tiny_recall` / `tiny_unlearn` — durable facts with semantic
search. Learned in Claude Code, recalled on your phone, or by your Telegram bot.
</div>

<div class="card" markdown="1">
<p class="card__t">Any tiny as a consultant</p>
`tiny_chat` reaches any tiny you can see, and it answers server-side with its
complete toolset — not a copy of it.
</div>

<div class="card" markdown="1">
<p class="card__t">Your own tools, mounted</p>
Tools you forged show up as real MCP tools (`my_*`) with their own schemas, in
every agent you connect.
</div>

<div class="card" markdown="1">
<p class="card__t">The rest of the platform</p>
Personas, scheduled jobs, marketplace, sharing, devices — one stdio server, no
extra services to run.
</div>

</div>

Auth is a loopback flow: one consent click mints a single-purpose 90-day token
into `~/.tiny/credentials.json`. Forged tools always execute in tiny's server
sandbox, **never on your machine** — the MCP connection carries your identity,
not your shell.

## 3. Give it a life

<div class="cards" markdown="1">

<div class="card" markdown="1">
<p class="card__n">MEMORY</p>
<p class="card__t">It remembers, and revises</p>
`learn` / `recall` / `unlearn`; facts link into a graph, and a contradiction
raises a one-tap conflict prompt instead of overwriting what you said before.

[Memory :material-arrow-right:](../platform/memory.md){ .go }
</div>

<div class="card" markdown="1">
<p class="card__n">TOOLS</p>
<p class="card__t">It builds its own tools</p>
Describe a tool and `create_tool` writes it, sandboxed and persistent. Or bind an
`openapi.json` and every endpoint becomes callable.

[Skills & tools :material-arrow-right:](../platform/skills.md){ .go }
</div>

<div class="card" markdown="1">
<p class="card__n">TIME</p>
<p class="card__t">It works while you sleep</p>
Cron (`*/30m`, `daily@09:00`) and one-shot jobs run server-side, and the results
land on your feed and as a push.

[Automation :material-arrow-right:](../platform/automation.md){ .go }
</div>

<div class="card" markdown="1">
<p class="card__n">BODY</p>
<p class="card__t">It gets a body</p>
Your phone, watch and laptop join its fleet — and so can a printer or a $60
board. Every backgrounded action leaves a trace.

[Devices :material-arrow-right:](../platform/devices.md){ .go }
</div>

<div class="card" markdown="1">
<p class="card__n">VOICE</p>
<p class="card__t">It speaks and listens</p>
Dictate with the mic, have replies spoken back. On Apple hardware, speech and
image generation can stay on the Neural Engine.
</div>

<div class="card" markdown="1">
<p class="card__n">MONEY</p>
<p class="card__t">It can earn</p>
Price it per message; people and other agents pay in USDC over x402, and it can
pay other services back.

[Pricing & economics :material-arrow-right:](../business/pricing.md){ .go }
</div>

</div>

## Where it runs

tiny is a PWA plus native iOS and Android apps — voice sessions, maps, on-device
image generation, widgets, watch complications and the device fleet.
[tiny.technology](https://tiny.technology) offers the right app for whatever
you're holding.

<ul class="chips">
  <li>Web</li>
  <li>iOS · widgets · watchOS · Siri</li>
  <li>Android · Wear OS</li>
  <li>Telegram</li>
  <li>WhatsApp</li>
  <li>MCP</li>
  <li>CLI</li>
  <li>PWA</li>
</ul>

<div class="doors" markdown="1">

<div class="door" markdown="1">
<p class="door__t">Not sure what to make yet?</p>
A page of concrete tinys, each one built only from things that already work.

[What would you build? :material-arrow-right:](what-to-build.md){ .go }
</div>

<div class="door" markdown="1">
<p class="door__t">Ready for the whole path?</p>
Nine steps from one sentence to a skilled, priced, discoverable tiny.

[Build a tiny :material-arrow-right:](../business/build-guide.md){ .go }
</div>

</div>
