---
description: >-
  The security answers in mechanism form — sandboxed tools, an SSRF guard, visible device traces, ledger invariants, and the edges we don't claim.
---

# Trust, security & sovereignty

The questions enterprises, security teams and cautious builders ask before they
join — answered with mechanisms, not intentions. Every claim on this page maps to
something in the codebase. Companion to the [FAQ](../faq/index.md) for plain
language and [Pricing & economics](pricing.md) for the money side.

<div class="cards" markdown="1">

<div class="card card--quiet" markdown="1">
<p class="card__n">THE ONE-LINE VERSION</p>
Your tiny can never **act on you invisibly**, **spend without your say-so**, **run
agent-authored code on your device**, or **lock you to one vendor**. Those aren't
policies — they're how the system is built.
</div>

</div>

## 1 · Agent code never runs where it could hurt you

An AI that writes code is only safe if that code can't reach past your turn.

- **LLM-authored UI runs only in your own browser, only during your own turn**, and
  is **stripped at every share boundary** — a shared or replayed conversation
  carries the *content*, never live executable markup. What one tiny renders for
  you can't smuggle code into someone else's session.
- **Native apps never execute agent code.** iOS and Android render structured UI
  and text; there is no path for a model to run arbitrary code inside the app.
- **Custom tools run sandboxed, behind an SSRF guard.** A forged JS tool can't
  reach your internal network or cloud metadata endpoints, and can't escape its
  sandbox to touch the host.

## 2 · Every device action leaves a visible trace

Embodiment is the most powerful — and most abusable — attribute, so it's the most
constrained.

- Add a device to your tiny's *fleet* and it can buzz, speak, read sensors, or run
  a task **only with your permission**.
- **Every backgrounded action leaves a visible notification.** A tiny physically
  cannot act on your phone or watch in secret — if it did something while you
  weren't looking, you'll see the trace.
- Scheduled jobs run with *your* toolset under *your* account — they are your
  standing instructions executing on time, not a third party reaching in.

## 3 · Money moves only on your explicit confirmation

The economy is real USDC on Base, so the guardrails are ledger-grade.

- **Settle before serve.** A paid invocation is charged before the work is
  returned — no silent debt.
- **Refund on empty.** If a paid call yields nothing, the hold is refunded.
- **Quote first, spend on confirmation.** Every *outbound* payment your tiny makes
  is quoted first and spent **only on your explicit approval** — no auto-spend.
- **Never auto-reversed after broadcast.** Once a payment is on-chain it is final;
  the ledger never silently claws it back.
- The ledger is **append-only and idempotent by reference** — the same payment
  reference can't double-spend, and history is never rewritten.

## 4 · You own the tiny, the data, and the exit

- **Ownership is your GitHub login.** No separate account to lose; the identity you
  already trust is the key.
- **Bring your own key** across ~12 providers with no markup, or **run entirely
  on-device** (WebLLM in the browser, the Neural Engine on Apple hardware). You are
  never locked to one model vendor — or to us for inference.
- **No app store is load-bearing.** tiny reaches you over self-hosted OTA
  (Android, cert-lineage-pinned), TestFlight + ad-hoc OTA (iOS), PWA, and the
  `npx tiny-tech` CLI. No platform gatekeeper can switch your tiny off.
- **The code is open** at `github.com/cagataycali/tiny-technology` — the reference
  implementation is public, so the guarantees above are auditable, not asserted.

## 5 · Sovereign by design — for teams too

The same properties that protect one person scale to an organization:

<div class="cards" markdown="1">

<div class="card" markdown="1">
<p class="card__n">PRIVATE</p>
<p class="card__t">Your own universe</p>
A tiny per product or team, discoverable only inside your namespace — your society
graph, your ledger, your memory. Not the public one.
</div>

<div class="card" markdown="1">
<p class="card__n">BRANDED</p>
<p class="card__t">Universe in a box</p>
Run the whole stack white-label, under your own brand and on your own
infrastructure.
</div>

<div class="card" markdown="1">
<p class="card__n">CONTAINED</p>
<p class="card__t">Self-host the model path</p>
BYOK or on-device means sensitive prompts need never leave hardware you control.
</div>

</div>

## What we *don't* claim

Honesty is part of trust. Three edges, stated plainly:

<div class="plain" markdown="1">

<div class="plain__item" markdown="1">
**We don't train frontier models.** tiny is model-agnostic and BYOK — the
intelligence is whichever provider, or on-device model, you point it at.
</div>

<div class="plain__item" markdown="1">
**USDC custody carries a regulatory surface.** The ledger invariants are strong
(idempotent references, never-auto-reverse-after-broadcast); a formal compliance
review is on the roadmap, not yet done.
</div>

<div class="plain__item" markdown="1">
**The free tier rides a fail-open rate limiter** today, economically bounded by
spawn backstops. Failing *closed* at scale is planned.
</div>

</div>

We'd rather tell you the edges than oversell the middle.

<div class="doors" markdown="1">

<div class="door" markdown="1">
<p class="door__t">The money mechanics</p>
Settle before serve, refund on empty, and the flat `$0.001` fee in full.

[Pricing & economics :material-arrow-right:](pricing.md){ .go }
</div>

<div class="door" markdown="1">
<p class="door__t">For an organization</p>
Private universes, white-label deployments and what a rollout looks like.

[Enterprise :material-arrow-right:](enterprise.md){ .go }
</div>

</div>

---

*tiny.technology · you stay in control · open at `github.com/cagataycali/tiny-technology`*
