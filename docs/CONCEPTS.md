# Concepts — what a tiny actually is

This is the explainer the README's feature list points at: the seven ideas the product is
built on, each one traced to the code in this repository that implements it. It exists
because "an AI you create by chatting" is a *claim*, and a claim in a public repo should be
checkable by whoever reads it.

Every ⟶ line is a file path in this tree. If a path and a paragraph disagree, the path wins.
Nothing here describes a roadmap item; if a concept isn't shipped, it isn't in this file.

---

## 1. You create it by talking, not by configuring

There is no prompt file, no YAML, no settings screen you have to master first. You say
"create an AI that knows my product roadmap" and that is the whole setup step. Anything you
would normally put in a config, you say out loud instead.

This is the load-bearing idea and everything else follows from it. Once creation is a
conversation, *teaching* is a conversation, *pricing* is a conversation, and *giving it a
job* is a conversation.

⟶ `web/lib/chat/prompt.ts` — the system prompt is the product surface, not a hidden detail
⟶ `web/lib/chat/tools/` — the agent's own tools create, update, price, and teach tinys
⟶ `worker/src/index.ts` — the tiny record is created through the same API the agent calls

## 2. Memory you can read, and argue with

Most products that say "memory" mean a vector store stuffed into a context window. A tiny's
memory is a **bitemporal knowledge graph**: every fact carries both the time it was *true*
and the time it was *recorded*.

Nothing is ever hard-deleted. When you change your mind, the old fact is **closed**
(`valid_to = now`) and the new one records a `supersedes` edge pointing at it. So the graph
can answer a question no flat store can: *what did you used to believe about me, and when
did that change?* Because facts are held rather than blended, two incompatible things you
taught it can be **detected as a conflict** instead of silently averaged into mush.

And it is legible. The Graph view draws the facts as a force-directed map — that is your
AI's mind, drawn, and you can read every node in it.

⟶ `worker/src/graph.ts` — "Close (never delete) — unlearn and supersede both land here"
⟶ `worker/src/learnings.ts` — the fact store behind the Memory panel
⟶ `web/lib/chat/tools/memory.ts` · `web/lib/chat/unlearn-scope.ts` — the agent's own
  `remember` / `learn` / `unlearn` path

> Why this is a design position and not a feature: deleting knowledge is lossy, superseding
> it is honest. A store that overwrites can never explain itself.

## 3. An address, so it's a thing and not a session

Your AI has no address anywhere else. You cannot link to one, follow one, or message one.

A tiny is a **URL** — `tiny.technology/<name>` — and that one address is simultaneously a
chat page, an installable PWA, an OG card for when someone shares it, and a contact card you
can add to your phone. The same AI, several doorways, one identity.

⟶ `web/app/[slug]/page.tsx` — the chat page at the tiny's own address
⟶ `web/app/og/[slug]/route.tsx` — the share card
⟶ `web/app/vcard/[slug]/route.tsx` — the contact card
⟶ `web/app/api/manifest/[slug]/` — the per-tiny PWA manifest

## 4. Your devices are nodes of it, not clients to it

An assistant that can't touch anything you own is disembodied. Your phone, tablet, watch and
computer **enrol** into the same tiny identity: they report presence, they can be asked to
act, and a live map shows which of them are online right now.

The rule that makes this safe is the visible trace: no agent-initiated action runs on a
device of yours without leaving a record you can see.

⟶ `web/app/api/devices/` — the device registry
⟶ `web/app/api/location/` · `web/lib/geo.ts` — presence and the location context block
⟶ `ios/` (iPhone · iPad · Apple Watch · widgets) · `android/` (phone · Wear OS)

## 5. You can call it

Not push-to-talk, not a beep-and-wait turn. Real-time **speech to speech**, with
**barge-in** — interrupt it mid-sentence like you would a person and it stops and listens.
Live transcripts land in the chat thread as ordinary messages, so tomorrow you can search a
call the same way you search a conversation.

⟶ `web/lib/voice/realtime.ts` — the session
⟶ `web/lib/voice/vad.ts` — voice-activity detection (what makes barge-in possible)
⟶ `web/lib/voice/tools.ts` — tool calls *during* a call
⟶ `web/lib/voice/live.ts` — the live transcript path

## 6. It can transact — in both directions

This is the part with the least precedent. A tiny has a wallet. You can price it per
message, and **people and other agents** can pay to use it, in USDC. It implements **both
sides** of the agent-payment standards: payer and payee, x402 in and out, with ERC-8004
on-chain registration so agent crawlers can discover and hire it.

The money rules are deliberately boring:

- **Settle before serve** — the charge clears before inference runs, so there's no billing debt
- **Refund on empty** — a paid turn that produced no output refunds
- **Never reverse after broadcast** — the ledger is append-only and idempotent by reference
- **A human keeps the veto** — spends are quoted first and execute only on explicit confirmation

The platform fee is a **flat $0.001 per paid invocation** — not a percentage. Price a tiny at
$0.50 a message and you keep $0.499; price it at $5 and you keep $4.999. The fee does not
grow when you succeed.

⟶ `worker/src/payments.ts` — `PLATFORM_FEE_MICRO = 1000` and `splitInvoke()`; the fee is one
  constant, so this document cannot drift from the code without the constant changing
⟶ `web/lib/x402/payer.ts` · `web/lib/x402/facilitator.ts` — both sides
⟶ `web/app/api/erc8004/` — on-chain registration
⟶ `chain/` — contracts, the payee-allowlisted facilitator, the validator network

## 7. Free to create, free to keep, and your key if you want it

Creating a tiny is free and keeping it alive is free. There is no subscription to simply
exist. Use the shared house model key, or bring your own from any of the providers in the
registry and pay only your provider's cost — no per-token markup on top.

The provider picker offers **thirteen entries**, of which **ten are providers you bring a key
to**:

`openai` · `anthropic` · `bedrock` · `openrouter` · `groq` · `deepseek` · `mistral` · `xai` ·
`perplexity` · `gemini`

The other three are not third-party providers and should not be counted as though they were:
`default` is the shared house key (no key of yours), `webllm` runs a small model **in your
browser** via WebGPU with no key at all, and `custom` is a blank slot for any
OpenAI-compatible endpoint.

⟶ `web/lib/chat/model-config.ts` — `PROVIDER_PRESETS`, the list the settings UI renders; this
  is the object the count above is measured against
⟶ `web/lib/model-registry.ts` — `FALLBACKS`, the model-ID list per provider (same keys, a
  different question: *which models*, not *which providers*)
⟶ `web/lib/webllm.ts` — the on-device path
⟶ `web/lib/free-tier.ts` — what "free" means mechanically

> ⚠️ **A count claim has to name what it counts.** "Thirteen entries" is true of
> `PROVIDER_PRESETS`; "thirteen providers you can bring a key to" is false, and it reads as a
> bigger menu than the app has. An earlier draft of this file made exactly that mistake by
> deriving the number from the object's key count without asking whether every key is a
> provider. If you add a preset, re-derive **both** numbers — or drop the digits and write
> "the providers in `PROVIDER_PRESETS`" so the code is the list.

---

## A society, not a directory listing

The **Universe** is the public catalogue of tinys their makers chose to share — with follows,
DMs, agent-to-agent consults, and trust scoring. It's the part that makes a tiny something
other people can meet rather than a private tool.

Privacy is enforced at the source, not in the UI: a private tiny is excluded from search and
its embeddings are deleted when the privacy flag flips. "Not shown" and "not indexed" are
different promises, and this repo makes the second one.

⟶ `web/lib/community.ts` · `web/app/api/follow/` · `web/app/api/messages/`
⟶ `web/lib/reputation.ts` — trust scoring
⟶ `worker/src/` — the private-tiny exclusion path

## Invariants worth knowing before you fork this

These are the four rules the codebase treats as non-negotiable. If you change one, you are
building a different product, not configuring this one.

1. **The D1 `tinys` table is the only authority** for existence and ownership. Nothing else
   gets a vote.
2. **A private tiny is excluded from search**, and its embeddings are deleted on the privacy
   flip — not merely hidden from a list.
3. **Payments are quoted before they happen and confirmed by you.** Nothing auto-spends.
4. **No agent code runs on your device without a visible notification trace.**

## Where the marketing copy lives

The store listings and social copy for the published apps are **not** in this repository —
they're drafts in the private working tree, along with the screenshot/video safety gates that
decide which captures are publishable. What's here is the concept material: this file, the
README, and `docs/brand/`.

If you're writing about tiny (a post, a talk, a README of your own), the section order above
is the order that has read best: **make it by talking → it remembers and you can see the
memory → it has an address → your devices are part of it → you can call it → it can
transact → it's free to keep.** The memory graph is the idea people react to; the payments
are the idea people argue about.

⚠️ One caution if you reuse the screenshots in `docs/screenshots/`: a screenshot of a real
account is a publication of that account's data. Counts, balances, addresses and fact labels
are all content. Use a demo dataset or your own account — and read the pixels at full size
before you publish, because a caption is not a substitute for looking.
