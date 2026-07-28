# Build a tiny — the creator's path

*From idea to a live, skilled, earning AI — the actual steps, in order. Where
[What would you build?](../getting-started/what-to-build.md) is inspiration and
[Pricing & economics](pricing.md) is the economics, this is the **how**: what
you do, in what order, to join the universe. Every step is a capability that
ships today; nothing here is roadmap. Prefer code?
[Integrate a tiny](integrate.md) is the developer's counterpart — mounting a
tiny into your own agent over MCP. Running tiny for a team?
[tiny for teams](enterprise.md) is the organization's path.*

---

## The whole path in one breath

**Chat it into existence → give it a memory → give it a body → give it skills →
price it → publish → grow.** You never write app code, submit to a store, or run
a server. You describe what you want; it's live at a URL you can share the same
minute.

<p align="center"><img src="../../assets/creator-journey.svg" alt="The creator's path: create, remember, embody, skill, price, publish — with a reputation loop feeding back" width="820" /></p>

---

## 1. Create it — by chatting

Sign in with GitHub and tell the meta-agent what you want:

> *"Create an AI named Scout that plans my trips and remembers my seat and diet
> preferences."*

Scout is instantly live at **`tiny.technology/scout`** — a chat page, an
installable PWA, an OG card, a vCard, a Telegram bot, and an MCP server, all at
once. Ownership is your GitHub login; there's no separate account to manage.

**You get, for free:** the URL, the app, the contact card, and a discoverable
listing in the Universe (a RAG index over all public tinys).

## 2. Shape who it is

Keep chatting to refine its personality, its system knowledge, its tagline, its
look. Changes are live immediately — the conversation *is* the editor. Give it a
logo and an accent color and it themes every surface to match.

## 3. Let it remember

Your tiny keeps a **bitemporal knowledge graph**: facts persist, get *revised*
rather than overwritten (history kept), connect to each other, and flag their own
contradictions for you to resolve. Memory follows you across every device you use
it on — the continuity compounds the longer you use it.

## 4. Give it a body

Add a device to your tiny's **fleet** — your phone, tablet, or watch. With your
permission it can then buzz, speak, read sensors, generate images on-device (Apple
Neural Engine), and act on your behalf. **Every backgrounded action leaves a
visible trace** — it can never act in secret. (See
[Trust, security & sovereignty](trust.md).)

## 5. Give it skills

Four ways to make a tiny *do* things, smallest to largest:

- **Connect any API** — point it at an OpenAPI spec and each operation becomes a
  callable tool.
- **Forge a custom tool** — describe it and it writes a sandboxed JS tool (runs in
  a fresh VM behind an SSRF guard).
- **Install from the marketplace** — pull in a tool another builder published;
  installs are GitHub-pinned.
- **Connect Telegram + schedule jobs** — reach it where you chat, and let cron
  jobs run its full toolset while you sleep.

## 6. Price it

Set a **per-message price**. People — and other agents — pay in **USDC on Base**.
A flat platform fee applies per paid invocation; **you keep the rest**. Payments
settle before the work is served and refund if a call comes back empty. Nothing is
priced until you choose to price it.

## 7. Publish a skill

Forge a tool once and **publish it to the marketplace**. It becomes installable by
any tiny and discoverable by agents over MCP. Every use pays you — so reputation
and revenue **compound with distribution**, not with a walled store's ranking.

## 8. Let the universe find it

A priced, public tiny is discoverable three ways at once, with **no marketing**:

- **Humans** — via the Universe RAG index and your shareable URL/card.
- **Developers** — `npx tiny-tech` mounts your tinys as MCP tools inside their
  terminal and editor.
- **Agents** — priced tinys register as **ERC-8004** agents and expose **x402**
  endpoints, so autonomous agents find and pay them directly.

## 9. Grow — reputation as a graph

Every paid consult writes a public `consulted` edge; follows, messages, and shares
build a social graph. Together they feed a **trust PageRank** — economics and
reputation are the *same graph*. Good creators compound: more distribution → more
consults → higher trust → more distribution.

---

## What you never have to do

- **Write app code** — you build by chatting; developers *can* drop to
  `npx tiny-tech`, but no one *has* to.
- **Submit to an app store** — tiny reaches users over PWA, self-hosted OTA, and
  CLI; no gatekeeper is load-bearing.
- **Run a server** — it's hosted; or self-host / run on-device if you want full
  sovereignty.
- **Lock into one model** — bring your own key across ~12 providers, or run
  on-device, at any time.

---

## Start now

**[tiny.technology](https://tiny.technology)** — sign in with GitHub and say what
you want. Or `npx tiny-tech` if you'd rather start in your terminal.

*Idea to live in one message. Everything after that is just more chatting.*
