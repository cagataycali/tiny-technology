---
description: >-
  A bitemporal knowledge graph, not a context window: facts persist, get revised instead of overwritten, and follow your tiny onto every device.
---

# Memory

A tiny's memory is the reason it's an entity and not a session. It persists,
revises, and follows you everywhere your identity goes — so the thing you told
it in your editor last month is the thing it knows on your watch today.

![The memory graph — bitemporal facts that revise, link, and flag their own conflicts](../assets/gallery/memory-graph.svg)

## The durable graph

<div class="cards" markdown="1">

<div class="card" markdown="1">
<p class="card__n">01 · WRITE</p>
<p class="card__t">learn / recall / unlearn</p>
Up to 5000 entries per user, semantically indexed and injected into every chat.
Manage the whole set with `/memory`.
</div>

<div class="card" markdown="1">
<p class="card__n">02 · SHAPE</p>
<p class="card__t">It's a graph, not a list</p>
Facts link to each other — `part_of`, `about`, `supersedes` — and recall walks
the edges, so related facts surface together instead of one at a time.
</div>

<div class="card" markdown="1">
<p class="card__n">03 · REVISE</p>
<p class="card__t">Contradictions surface; nothing is deleted</p>
A new fact that conflicts with an old one raises a one-tap conflict prompt.
Superseded facts close *bitemporally* and survive as history — you can always
see what you believed, and when.
</div>

<div class="card" markdown="1">
<p class="card__n">04 · SEE</p>
<p class="card__t">You can look at it</p>
The whole graph renders as a force-directed picture in the Memory Panel — the
🕸️ toggle. Memory you can inspect is memory you can trust.
</div>

</div>

## Everywhere your identity goes

One memory, many doors. The same graph answers on the web, in the iOS and
Android apps, on your watch, in Telegram, and inside any MCP agent through
`tiny_learn` / `tiny_recall` / `tiny_unlearn`. A fact learned in Claude Code is
recalled on your phone — no export, no sync step, no second copy to keep honest.

<ul class="chips">
  <li>Web</li>
  <li>iOS · watchOS</li>
  <li>Android · Wear OS</li>
  <li>Telegram</li>
  <li>MCP</li>
  <li>CLI</li>
</ul>

## Local layers

Two lighter tiers sit in front of the graph, for the things that shouldn't
outlive the moment:

- **Browser memory** — `remember` / `forget` plus a rolling turn log, kept per
  tiny and per device.
- **Session archives** — `/save` and `/load` write versioned snapshots of a
  conversation, with credentials redacted.

<div class="doors" markdown="1">

<div class="door" markdown="1">
<p class="door__t">Why revision, not deletion</p>
The argument for bitemporal memory, and what it means for your data.

[Trust, security & sovereignty :material-arrow-right:](../business/trust.md){ .go }
</div>

<div class="door" markdown="1">
<p class="door__t">Memory from your own agent</p>
The MCP memory tools, and how to mount them into an editor.

[Integrate a tiny :material-arrow-right:](../business/integrate.md){ .go }
</div>

</div>
