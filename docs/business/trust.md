# Trust, security & sovereignty

*How tiny.technology keeps you in control — the questions enterprises, security
teams, and cautious builders ask before they join. Every claim here maps to a real
mechanism in the codebase; nothing is aspirational. Companion to the
[FAQ](../faq/index.md) (plain-language) and [Pricing & economics](pricing.md)
(money mechanics).*

---

## The one-line version

**Your tiny can never act on you invisibly, spend without your say-so, run
agent-authored code on your device, or lock you to one vendor.** Those aren't
policies — they're how the system is built.

---

## 1. Agent code never runs where it could hurt you

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

## 2. Every device action leaves a visible trace

Embodiment is the most powerful — and most abusable — attribute, so it's the most
constrained.

- Add a device to your tiny's *fleet* and it can buzz, speak, read sensors, or run
  a task **only with your permission**.
- **Every backgrounded action leaves a visible notification.** A tiny physically
  cannot act on your phone or watch in secret — if it did something while you
  weren't looking, you'll see the trace.
- Scheduled jobs run with *your* toolset under *your* account — they are your
  standing instructions executing on time, not a third party reaching in.

## 3. Money moves only on your explicit confirmation

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

## 4. You own the tiny, the data, and the exit

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

## 5. Sovereign by design — for teams too

The same properties that protect an individual scale to an organization:

- **A private universe.** A tiny per product or team, discoverable only inside your
  own namespace — your society graph, your ledger, your memory, not the public one.
- **White-label — "universe in a box."** Run the whole stack under your own brand
  and infrastructure.
- **Self-host the model path.** BYOK or on-device means sensitive prompts need
  never leave hardware you control.

## What we *don't* claim

Honesty is part of trust.

- We don't train frontier models — tiny is **model-agnostic and BYOK**; the
  intelligence is whichever provider (or on-device model) you point it at.
- USDC custody and withdrawals carry a **regulatory surface**; the ledger
  invariants are strong (idempotent references, never-auto-reverse-after-broadcast),
  and a formal compliance review is on the roadmap, not yet done.
- The free tier rides a **fail-open** rate limiter today (economically bounded by
  spawn backstops); failing *closed* at scale is planned.

We'd rather tell you the edges than oversell the middle.

---

*tiny.technology · you stay in control · open at `github.com/cagataycali/tiny-technology`*
