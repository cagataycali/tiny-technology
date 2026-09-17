---
description: >-
  Four ways to give a tiny new powers — forge a tool, bind an OpenAPI spec, install one from the marketplace, connect an MCP server. None of them a build step.
---

# Skills & tools

A tiny does things. There are four ways to give it new powers — smallest to
largest, none of them a build step — and one marketplace to share what you make.

## 1. Bring your own model

Every provider, one dropdown, live model lists per provider. Your key skips the
free tier's daily limit, and tiny adds **no per-token markup** on top of it:

<ul class="chips">
  <li>OpenAI</li>
  <li>Anthropic</li>
  <li>Bedrock · Claude on the edge</li>
  <li>Gemini</li>
  <li>OpenRouter</li>
  <li>Groq</li>
  <li>DeepSeek</li>
  <li>Mistral</li>
  <li>xAI</li>
  <li>Perplexity</li>
  <li>Vercel AI Gateway</li>
  <li>any OpenAI-compatible URL</li>
</ul>

## 2. Connect what already exists

<div class="cards" markdown="1">

<div class="card" markdown="1">
<p class="card__n">OPENAPI</p>
<p class="card__t">Any REST API</p>
Bind an `openapi.json` and every endpoint becomes a callable tool — schema,
parameters and all. Nothing to write.
</div>

<div class="card" markdown="1">
<p class="card__n">MCP</p>
<p class="card__t">Remote MCP servers</p>
Mount a `streamable-http` MCP server and its tools simply join the toolset,
alongside the built-ins.
</div>

<div class="card" markdown="1">
<p class="card__n">ALWAYS ON</p>
<p class="card__t">http</p>
A universal HTTP client tool, present in every tiny. For the API that never got
a spec written for it.
</div>

</div>

## 3. Forge your own

**`create_tool`** — describe a tool and the agent writes it. What comes out is a
small JS tool that persists to your account and mounts as `my_*` *everywhere*:
web, Telegram, and back through MCP into your editor's agent.

Forged tools are **sandboxed**. They run server-side in a fresh VM behind an SSRF
guard, with 10-second and 20KB caps — they never execute on your machine. The
code is public on your builder profile; wear it proudly.

## 4. The marketplace

![A skill published once reaches every tiny](../assets/marketplace.svg)

Browse and install the community's tools. GitHub installs are allowlisted and
SHA-pinned with a per-user trust list, and `manage_tools` enables or disables any
tool per user. Publish a skill once and every tiny can install it — each use
credits the builder.

<div class="doors" markdown="1">

<div class="door" markdown="1">
<p class="door__t">What a published skill earns</p>
Royalties, per-message pricing, and how the ledger settles.

[Pricing & economics :material-arrow-right:](../business/pricing.md){ .go }
</div>

<div class="door" markdown="1">
<p class="door__t">Make it act on a schedule</p>
Tools are only half of it — jobs are what run them while you're away.

[Automation :material-arrow-right:](automation.md){ .go }
</div>

</div>
