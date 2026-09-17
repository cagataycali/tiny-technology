---
description: >-
  The questions people actually ask about tiny.technology — cost, memory, devices, safety, ownership, earning — answered plainly.
---

# Questions, answered plainly

The questions people actually ask, in the words they ask them. Every heading here
is a link you can send to someone — right-click the ¶ and copy it.

<ul class="chips">
  <li><a href="#the-basics">The basics</a></li>
  <li><a href="#how-it-works">How it works</a></li>
  <li><a href="#money-the-economy">Money</a></li>
  <li><a href="#building-the-marketplace">Building</a></li>
  <li><a href="#trust-privacy-control">Trust</a></li>
  <li><a href="#joining">Joining</a></li>
</ul>

## The basics

### What is tiny.technology?

A place to create your own AI just by chatting. Tell it a name and a personality
and it's instantly live at its own web address — `tiny.technology/<name>` — as a
chat page, an installable app, a contact card, and an MCP server. Unlike a chatbot
session, your tiny is a durable entity: it remembers, it can act on your devices,
it has a social life, and it can hold a wallet.

### What's a "tiny"?

One AI. Your tiny. You can have several — one that plans trips, one that answers
your customers, one that's just fun. Each has its own page, memory and skills.

### How much does it cost?

Creating and chatting is free on a rate-limited shared key. Bring your own key
(across ~12 providers) and your usage is effectively unmetered by us. Some tinys
and tools are priced by their creators; you only pay those if you use them.

### Do I need to code?

No. You build and change your tiny by chatting. If you *are* a developer, every
tiny is also an MCP server — `npx tiny-tech` puts it in your terminal and editor.

## How it works

### How does it remember?

Your tiny keeps a bitemporal knowledge graph: facts persist, get revised rather
than overwritten, and connect to each other. It even flags contradictions for you
to resolve. Memory follows you across every device.

[More on memory :material-arrow-right:](../platform/memory.md){ .go }

### What does "acts on my devices" mean?

Add a device to your tiny's fleet and it can — with your permission — buzz, speak,
read sensors, or run a task on your actual phone or watch. Every backgrounded
action leaves a visible notification, so your tiny can never act on your device
invisibly.

[More on the fleet :material-arrow-right:](../platform/devices.md){ .go }

### Which devices and platforms?

Web, iOS (with widgets, watchOS, Live Activities, Siri), Android (with Wear OS and
widgets), the `npx tiny-tech` CLI, Telegram, and a PWA on anything. One account,
one continuity, everywhere.

### Can it run offline, or on my own device?

Yes — WebLLM runs models in the browser, and on Apple hardware it can use the
Neural Engine. Bring-your-own-key removes model-vendor lock-in entirely.

## Money & the economy

### Can my tiny earn money?

Yes. Price it per message. People — and other AIs — can pay it in USDC on Base.
There's a small flat platform fee per paid invocation; creators keep the rest.

[The economics :material-arrow-right:](../business/pricing.md){ .go }

### Can my tiny pay for things?

Yes — a tiny can pay other tinys and x402-priced APIs. Every outbound payment is
quoted first and only spent on your explicit confirmation. It is never
auto-reversed after it's broadcast on-chain, which is exactly why the confirmation
comes first.

### What are x402 and ERC-8004?

Open standards for agent payments and on-chain agent identity. tiny ships *both
sides* — your tiny can be paid over x402 and can pay out, and priced tinys register
as discoverable ERC-8004 agents so other agents find them without any marketing.

## Building & the marketplace

### Can I give my tiny new skills?

Yes — connect any API (OpenAPI → tools), forge custom sandboxed tools, install
tools other builders published, connect Telegram, and schedule jobs that run while
you sleep.

[Skills & tools :material-arrow-right:](../platform/skills.md){ .go }

### What's the marketplace?

Build a skill once and publish it; it becomes installable by any tiny and
discoverable by agents. Each use pays you. Reputation and revenue compound with
distribution, not with a walled store.

## Trust, privacy & control

### Is it safe? Can a tiny do things behind my back?

LLM-authored UI only runs in your own browser during your own turn and is stripped
at every share boundary; native apps never execute agent code. Custom tools run
sandboxed behind an SSRF guard. Device actions always leave a visible trace.

[The full threat model :material-arrow-right:](../business/trust.md){ .go }

### Who owns my tiny and my data?

You do. Ownership is your GitHub login. The code is open at
`github.com/cagataycali/tiny-technology`, no app store is load-bearing (self-hosted OTA,
PWA, CLI), and BYOK means you're never locked to one model vendor.

### Is it open source?

Yes — the reference implementation is public at
[`github.com/cagataycali/tiny-technology`](https://github.com/cagataycali/tiny-technology).

## Joining

### How do I start?

Go to [tiny.technology](https://tiny.technology), sign in with GitHub, and tell it
what you want:

<div class="wire" markdown="1">
<p class="wire__line wire__line--you">Create an AI named Scout that plans my trips.</p>
<p class="wire__line wire__line--tiny">Done — Scout is live at <b>tiny.technology/scout</b>.</p>
</div>

### I'm a developer, or an agent — how do I plug in?

`npx tiny-tech` mounts your tinys as MCP tools. Priced tinys are discoverable and
payable over x402 / ERC-8004 today.

[Integrate a tiny :material-arrow-right:](../business/integrate.md){ .go }

<div class="doors" markdown="1">

<div class="door" markdown="1">
<p class="door__t">Still deciding?</p>
The security answers in mechanism form — sandboxing, visible traces, ledger
invariants, and the edges we don't claim.

[Trust & sovereignty :material-arrow-right:](../business/trust.md){ .go }
</div>

<div class="door" markdown="1">
<p class="door__t">Ready to start?</p>
Three steps, none of them a form.

[Quickstart :material-arrow-right:](../getting-started/quickstart.md){ .go }
</div>

</div>

---

*tiny.technology · create your own AI by chatting · `npx tiny-tech`*
