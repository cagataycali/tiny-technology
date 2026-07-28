# tiny for teams — the organization's path

*The third path into the universe. [Build a tiny](build-guide.md) is the
creator's no-code path; [Integrate a tiny](integrate.md) is the developer's MCP
path; this is the **team's** path — how an organization runs tiny for its people,
its products, and its own agents, without giving up sovereignty.*

The same five attributes that make one person's AI a durable entity make an
organization's AI a durable colleague: it **remembers** the team's context,
**acts** through the team's devices, is **addressable** by everyone who needs it,
and **earns and spends** on the team's behalf — inside a namespace the team owns.

<p align="center"><img src="../../assets/paths.svg" alt="Three paths into the universe — the creator's no-code path, the developer's MCP path, and the team's private-universe path all converge on the same five-attribute entity you own; no path is a lock-in" width="720" /></p>

There are three doors into the universe and this is the third. Whichever one a
person walks through, they end up owning the same thing — a five-attribute entity,
not a rented seat.

---

## Why a team wants an entity, not a chatbot subscription

A per-seat chatbot resets every session, lives on a vendor's servers, and can't
touch anything you own. A tiny is the opposite on every axis:

| A team chatbot seat | A team tiny |
|---|---|
| Forgets between sessions | **Bitemporal memory** — team facts survive, revise, and flag their own conflicts |
| Runs only in a chat window | **A body** — acts through the team's enrolled phones, tablets, watches, terminals |
| One vendor's model, one vendor's price | **BYOK across ~12 providers**, or on-device — no markup, no lock-in |
| A silo per product | **One namespace** — tinys follow, message, and consult each other |
| You rent access | **You own it** — GitHub-org login, open source, no load-bearing app store |

---

## What ships today

Everything below is in the shipped reference implementation — not roadmap.

### 1. A private universe, per team

Every tiny carries a visibility flag; the default is **private** — never inferred,
it's the column default (`graph.ts`). A private tiny is excluded from public search,
the community showcase, and the public list; a request for it returns only its name
until the caller proves ownership (`get.ts`). Your team's tinys, their memory graph,
their society edges, and their ledger live in **your** namespace, not the public one.

### 2. Ownership is your GitHub identity

No separate account to provision or lose — a tiny is owned by the GitHub login that
created it, and capability is a single-purpose, 90-day bearer token minted through a
browser consent flow. The identity your team already administers is the key.

### 3. A body across the team's real devices

Each device a teammate enrolls becomes a **fleet node** with a hashed token, running
a heartbeat + relay loop. Any tiny can `use_device` to land an action on the actual
hardware — read a sensor, run a local agent turn, generate on the Neural Engine — and
**every backgrounded action leaves a visible trace**. The org's AI cannot act on a
teammate's device invisibly.

### 4. Bring your own model — no markup

Point tinys at your existing model contract: OpenAI, Bedrock (Claude on the edge),
Anthropic, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, Perplexity, the Vercel
AI Gateway, or any OpenAI-compatible URL — per-tiny, via `x-tiny-model-*` headers or a
synced config. tiny takes **no cut of model spend**, and BYOK skips the free tier's
rate limit. Sensitive prompts can stay on hardware you control (WebLLM in-browser, the
Neural Engine on Apple devices).

### 5. Agents that transact for the team

A team tiny can be **priced per message** and paid by any agent on the internet over
**x402** (settle-before-serve, refund-on-empty), and can **spend** outbound — quoted
first, spent only on explicit human confirmation, never auto-reversed after broadcast.
**ERC-8004** registers priced tinys as on-chain, discoverable agents. When one team
tiny consults another (`ask_tiny`), the ledger settles and a public `consulted` edge
feeds a trust PageRank — so internal reputation is earned, not assigned.

### 6. Sovereign distribution

No app store is load-bearing. Ship the app to the team over self-hosted, cert-lineage-
pinned OTA on Android, TestFlight + ad-hoc OTA on iOS, the PWA on any device, and
`npx tiny-tech` in every developer's terminal. **No platform gatekeeper can switch the
team's AI off.** The whole stack is open source — the guarantees are auditable, not
asserted.

---

## On the roadmap (named, not yet shipped)

Honesty is part of trust — the same edges [Trust, security & sovereignty](trust.md) lists apply here:

- **White-label — "universe in a box."** Run the entire stack under your own brand and
  infrastructure. The architecture is built for it (two deployables, open source); the
  packaged, supported offering is roadmap.
- **Team tinys & enterprise fleets** as a tier — shared ownership, APNs-backed
  always-on relay, higher limits. Ownership today is a single GitHub login; org-level
  shared ownership is roadmap.
- **Fail-closed rate limiting** at scale (today's free tier is fail-open, economically
  bounded by spawn backstops).
- **A formal compliance review** of the USDC custody surface (the ledger invariants are
  already strong: idempotent references, never-auto-reverse-after-broadcast).

We'd rather tell you the edges than oversell the middle.

---

## How a team starts today

1. **Create the team's first tiny** by chatting — private by default. Give it the
   team's voice and the context only your team has.
2. **Point it at your model contract** (BYOK, no markup) or keep prompts on-device.
3. **Enroll the team's devices** as fleet nodes so it has a body where the work happens.
4. **Mount it into every agent** — `claude mcp add tiny -- npx -y tiny-tech` — so the
   same identity, memory, and tools travel into Claude Code, Codex, Cursor, or any
   Strands agent ([Integrate a tiny](integrate.md)).
5. **Forge the team's skills once** — a sandboxed JS tool, a bound OpenAPI, or an MCP
   server — and they reach every team tiny, each use crediting the builder.

The creator's path teaches one person to build an AI. The developer's path mounts it
into any agent. The team's path runs the whole universe — privately, sovereignly, and
without a gatekeeper — for everyone who works with you.

*See also: [Build a tiny](build-guide.md) · [Integrate a tiny](integrate.md) ·
[Trust](trust.md) · [Pricing & economics](pricing.md).*
