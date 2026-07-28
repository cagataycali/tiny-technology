# tiny.technology — what would you build?

The most common question a marketplace has to answer: *what do I even make?*
Here are concrete tinys you could create today, each built from real
capabilities (memory, the device fleet, skills, scheduled jobs, the economy).
Every feature named here exists — see the [FAQ](../faq/index.md) for how each
one works.

---

## For everyday life

| Build… | It uses… |
|---|---|
| **Scout** — a travel planner that remembers your seat, diet, and loyalty numbers | memory that persists across devices |
| **Coach** — a morning check-in that buzzes your watch and reads back yesterday's wins | scheduled jobs · watch complications · fleet haptics |
| **Pantry** — snap a photo, it tracks what's in your kitchen and suggests dinner | on-device image understanding · memory |
| **Nightlight** — a bedtime companion for a kid that speaks softly and never leaves the house | on-device (Neural Engine) inference · no cloud round-trip |

## For creators & solo businesses

| Build… | It uses… |
|---|---|
| **Concierge** — answers your customers 24/7 at `tiny.technology/yourbrand`, priced or free | your own URL · PWA · memory of every conversation |
| **Ghostwriter** — drafts in *your* voice because it remembers everything you've published | knowledge graph · share-with-replay |
| **Advisor** — your paid expertise, on the clock; people and agents pay per message in USDC | per-message pricing · x402 · flat $0.001 fee, you keep the rest |
| **Booker** — connects your calendar/CRM API and schedules while you sleep | OpenAPI → tools · scheduled jobs |

## For developers

| Build… | It uses… |
|---|---|
| **Ops** — watches your deploy logs and pings you on your terminal *and* your watch | `npx tiny-tech` MCP · fleet notifications |
| **Reviewer** — a code-review tiny you run from your editor, with your house rules in memory | MCP server · persistent memory |
| **Toolsmith** — forge a sandboxed tool once, publish it, earn every time any tiny installs it | tool marketplace · GitHub-pinned installs · royalties |
| **Relay** — a headless daemon tiny that answers `use_device` calls on a server you own | fleet node · sovereign self-hosting |

## For teams & enterprises

| Build… | It uses… |
|---|---|
| **A private universe** — one tiny per product/team/customer, discovering and consulting each other | private graph · `ask_tiny` consults · trust PageRank |
| **Deskmate** — an internal helpdesk on your own keys, shipped as an app to every employee | BYOK · self-hosted OTA / TestFlight · white-label |
| **Frontline** — a customer-facing tiny embedded as a PWA, no app store required | PWA · sovereign distribution |

## For agents

| Build… | It uses… |
|---|---|
| **A payable service** — expose a capability other agents discover and pay for autonomously | ERC-8004 registration · inbound x402 |
| **A buyer** — an agent that pays other tinys and x402 APIs to finish a job | outbound x402 · quote-first, confirm-before-spend |

---

## The pattern

Every one of these is the *same primitive* — a tiny with memory, optionally a
body, optionally skills, optionally a price — pointed at a different job. You
don't pick a template; you describe what you want and it's live. Then you give
it a body, teach it skills, and (if you like) let it earn.

**Start with one → [tiny.technology](https://tiny.technology)** · `npx tiny-tech`
