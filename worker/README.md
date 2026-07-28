# tiny worker — the Cloudflare data plane

Every tiny's durable life lives here: the persona store, the social graph and
message ledger, vector memory, media, live voice calls, payments accounting,
and the every-minute cron that runs schedules, background loops, and payment
reconciliation. The [web app](../web/) is the brain; this worker is the spine.
The mobile apps and third-party agents talk to it through the web app's API
and the relay.

| Piece | Binding | Backed by |
|---|---|---|
| Personas (prompt, knowledge, tools) | `tiny` | Workers KV |
| Published posts / counters | `post`, `stats` | Workers KV |
| Users, messages, wallet ledger, events, devices, voice sessions | `DB` | D1 (SQLite) — 30 migrations in [`migrations/`](migrations/) |
| Semantic search + per-tiny memory | `VECTOR_INDEX`, `MEMORY` | Vectorize (1536-dim, cosine) |
| Generated images & call recordings | `MEDIA` | R2 |
| Live voice calls (mic ⇄ realtime API relay) | `VOICE` | Durable Object `VoiceSession` |
| Schedules, loops, x402 reconciliation | — | cron `* * * * *` (both envs) |
| `*@your-domain` inbound mail → the tiny it names | — | Email Routing (`ADMIN_FORWARD_EMAIL` gets the apex) |

## Provision & deploy

```bash
cd worker
npm ci

# 1. Create the resources — each command prints the id to paste into wrangler.toml
wrangler kv namespace create tiny
wrangler kv namespace create post
wrangler kv namespace create stats
wrangler d1 create tiny-v2
wrangler vectorize create tiny-v2 --dimensions=1536 --metric=cosine
wrangler vectorize create memory  --dimensions=1536 --metric=cosine
wrangler r2 bucket create tiny-media

# 2. Apply the schema
wrangler d1 migrations apply tiny-v2 --remote

# 3. Secrets (repeat with --env production if you keep both envs)
wrangler secret put INTERNAL_API_KEY      # shared with the web app — must match its env
wrangler secret put OPENAI_API_KEY        # embeddings + voice relay

# 4. Ship it
npm run deploy:default                    # or npm run deploy for both envs
wrangler tail                             # watch it live
```

`wrangler.toml` ships with `replace-with-your-*` placeholder ids on purpose —
deploying an unprovisioned clone fails loudly instead of writing into someone
else's namespaces.

### Optional secrets/vars — features arm themselves when set

| Name | Enables |
|---|---|
| `ADMIN_FORWARD_EMAIL` | forwards mail addressed to the bare domain; unset → rejected |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | web push notifications |
| `MODEL_CONFIG_ENC_KEY` | encrypted cross-device BYO-model-key sync |
| `DEPOSIT_ADDRESS` | on-chain deposit crediting |
| `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL` | deposit watching on public Base chains |
| `RECONCILE_ALARM_USER` | who gets paged when a payment row stays blocked (see the note in `wrangler.toml`) |
| `CLOUDFLARE_API_TOKEN` | Vectorize index housekeeping |
| `TINY_CHAIN_*`, `PAYMENTS_NETWORK` (vars) | which chain payments settle on — see [chain/README.md](../chain/README.md) |

## Wire it to the rest

- The **web app** authenticates to this worker with `INTERNAL_API_KEY` and
  finds it via `TINY_WORKER_URL` — set both in the web deployment's env.
- **Email Routing**: point your zone's catch-all at this worker to give every
  tiny an inbox (`<name>@your-domain`).
- The **cron does real work every minute** (schedules, `/loop` agents, payment
  reconciliation). It's on in both envs by design, and tests in
  `web/tests/x402-*` assert the trigger exists in both — don't remove one.

## Develop

```bash
npm start              # wrangler dev (local)
npm run typecheck      # tsc --noEmit
```

The worker's behavioral spec lives in the web suite — `web/tests/` reads this
source directly (routes, ledger invariants, reconciliation) and runs green on
a fresh clone: `cd ../web && npm test`.

## License

[Apache-2.0](../LICENSE), same as the rest of the repository.
