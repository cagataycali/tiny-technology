# Memory

A tiny's memory is the reason it's an entity and not a session. It persists,
revises, and follows you everywhere your identity goes.

![The memory graph — bitemporal facts that revise, link, and flag their own conflicts](../assets/gallery/memory-graph.svg)

## Server memory — the durable graph

- **`learn` / `recall` / `unlearn`** — up to 5000 entries per user, semantically
  indexed, injected into every chat. Manage with `/memory`.
- **Memory is a graph.** Facts link to each other (`part_of`, `about`,
  `supersedes`), and recall walks the edges — related facts surface together.
- **Contradictions surface, nothing is deleted.** A new fact that conflicts with
  an old one raises a one-tap conflict prompt; superseded facts close
  *bitemporally* and survive as history. You can always see what you believed
  and when.
- **See it live.** The whole graph renders as a force-directed picture in the
  Memory Panel (the 🕸️ toggle).

## Everywhere your identity goes

The same memory answers on the web, in the iOS and Android apps, on your watch,
in Telegram, and inside any MCP agent via `tiny_learn` / `tiny_recall` /
`tiny_unlearn` — a fact learned in Claude Code is recalled on your phone.

## Local layers

- **Browser memory** — `remember` / `forget` plus a rolling turn log, kept per
  tiny, per device.
- **Session archives** — `/save` and `/load` versioned snapshots of a
  conversation, with credentials redacted.

*Deeper dive: the [Trust page](../business/trust.md) covers why revision-not-
deletion matters, and [Integrate a tiny](../business/integrate.md) shows the
MCP memory tools.*
