# Self-hosting tiny — the full loop

This is the same codebase that serves [tiny.technology](https://tiny.technology).
Self-hosting it end-to-end makes the whole loop yours: identities and memory in
your own D1/KV/Vectorize, models through your own keys, payments on a chain whose
token you control, and app builds you distribute yourself.

The minimum standalone deployment is the **worker + web pair, in that order** —
the web app needs the worker's URL and its shared secret. The chain and the
mobile apps are optional layers on top.

## Run it locally

```bash
git clone https://github.com/cagataycali/tiny-technology
cd tiny-technology/web
npm install
cp .env.example .env.local   # fill in the minimum — four values
npm run dev                  # http://localhost:3000
```

The minimum `.env.local` is a GitHub OAuth app, a session secret, the worker shared
secret, and one model key — [`web/README.md`](../web/README.md#run-it-locally) walks
through each, and everything else in [`web/.env.example`](../web/.env.example) is
optional and documented inline. The full platform (your own worker, chain, apps)
is the section below.

## 🚀 Deployment guides

This is the same codebase that serves [tiny.technology](https://tiny.technology).
Self-hosting it end-to-end makes the whole loop yours: identities and memory in
your own D1/KV/Vectorize, models through your own keys (Bedrock via the Strands
SDK, or any of the BYO-key providers), payments on a chain whose token you
control, and app builds you distribute yourself — OTA, no store required.

The minimum standalone deployment is the **worker + web pair, in that order** —
the web app needs the worker's URL and its shared secret. The chain and the
mobile apps are optional layers on top.

### 1. Worker → Cloudflare

The worker is the source of truth: users, tinys, credentials, shares, memory, payments.

**Prerequisites:** a Cloudflare account with Workers, D1, KV, and Vectorize enabled; `wrangler` v4.

```bash
cd worker
npm ci

# ── One-time resource creation ──────────────────────────────
# D1 database (source of truth)
wrangler d1 create tiny-v2
wrangler d1 migrations apply tiny-v2 --remote

# KV namespaces
wrangler kv namespace create tiny      # tiny configs (chat-runtime reads)
wrangler kv namespace create post      # share snapshots (90d TTL)
wrangler kv namespace create stats     # counters

# Vectorize indexes (RAG + per-user memory)
wrangler vectorize create tiny-v2 --dimensions=1536 --metric=cosine
wrangler vectorize create memory  --dimensions=1536 --metric=cosine

# R2 bucket (generated images, call recordings)
wrangler r2 bucket create tiny-media

# ── Update wrangler.toml with the IDs printed above ─────────

# ── Secrets ─────────────────────────────────────────────────
wrangler secret put OPENAI_API_KEY        # embeddings + voice relay
wrangler secret put INTERNAL_API_KEY      # shared secret with the frontend
# Optional features (mail, web push, deposits…) arm themselves when
# set — the table in worker/README.md lists them all.

# Local dev: put INTERNAL_API_KEY in worker/.dev.vars (gitignored)

# ── Deploy (BOTH environments — same code, two worker names) ─
npm run deploy        # = deploy:default && deploy:production
```

**Verify:** the router self-documents at your worker root (`https://<worker>.workers.dev/`).

> ⚠️ Gotchas (learned the hard way — see `AGENTS.md` history):
> - `itty-router-openapi` silently strips body fields not declared in `requestBody`. Declare every field.
> - Response schemas must not contain empty arrays.
> - Vectorize v1 match objects use `vectorId`, v2 use `id` — handle both.
> - Always deploy **both** envs; CI green ≠ worker validated.

Docs: [`worker/README.md`](../worker/README.md)

### 2. Frontend → Vercel

The Next.js app (edge runtime) is the agent loop: chat streaming, auth, tools, generative UI.

Local dev is the [Run it locally](#run-it-locally) section above. Deploying:

```bash
cd web
npx vercel --prod
```

**Required environment variables** (Vercel → Project → Settings → Environment Variables):

| Variable | Purpose |
|---|---|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth login |
| `AUTH_JWT_SECRET` | HMAC secret for session JWTs (any long random string) |
| `INTERNAL_API_KEY` | **Must match the worker secret** — the trust channel |
| `TINY_WORKER_URL` | Your worker URL (defaults to plugin.tiny.technology) |
| `OPENAI_API_KEY` | Default model key (users can BYOK any of the 10 providers in `PROVIDER_PRESETS`) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV / Upstash — rate limiting (`DEFAULT_REQUESTS_PER_DAY = 50` per IP in [`web/lib/free-tier.ts`](../web/lib/free-tier.ts); fails open without — [`web/lib/rate-limit.ts`](../web/lib/rate-limit.ts)) |
| `X402_PAY_TO` | Platform USDC receiving address (optional; paid tinys 424 without it) |

**Edge-runtime constraints:** no Node-only APIs in `app/api/*`. OpenAI-compat providers need `api: 'chat'`. Bedrock uses ConverseStream (no base URL).

Docs: [`web/README.md`](../web/README.md) — including the monorepo gotcha (Vercel **Root Directory = `web/`**, keep "Include source files outside of the Root Directory" enabled: app routes import payment guards from the sibling [`chain/`](../chain/)).

### 3. iOS → App Store / TestFlight

Targets: `Tiny` (iOS 18+ — 26-only APIs are `@available`-guarded), `TinyWidgets`, `TinyWatch` (watchOS 11+), `TinyWatchWidgets` — all sharing App Group `group.technology.tiny.app`.

```bash
cd ios

# Project is generated from project.yml (Tiny.xcodeproj is committed)
brew install xcodegen
xcodegen

# Open & run
open Tiny.xcodeproj

# Build on a physical device (auto-signing helper)
./scripts/build-on-device.sh

# Beta distribution without an Apple Developer account: a UDID-collection +
# hourly auto-enroll pipeline (launchd + /api/udid) — see BETA_PIPELINE.md

# Ad-hoc OTA distribution (UDID-enrolled devices)
./scripts/resign-with-udids.sh && ./scripts/push-ota.sh
```

Docs: [`ios/README.md`](../ios/README.md) · [`ios/BUILD_ON_DEVICE.md`](../ios/BUILD_ON_DEVICE.md) · [`ios/BETA_PIPELINE.md`](../ios/BETA_PIPELINE.md)

### 4. Android → Google Play / OTA

Modules: `app` (phone/tablet) + `wear` (Wear OS).

```bash
cd android

# local.properties is generated — point it at your SDK
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties

# Debug build
./gradlew assembleDebug

# Release (needs your signing config — keystores are NOT in this repo)
./gradlew assembleRelease bundleRelease

# Install on a connected device
./gradlew installDebug

# Play Store metadata lives in fastlane/metadata/android/
cd fastlane && bundle exec fastlane supply

# Self-hosted OTA — the manifest carries a sha256 and the in-app Updater
# verifies the downloaded bytes against it before install; no store required
./scripts/push-ota.sh
```

Docs: [`android/README.md`](../android/README.md)

### 5. Chain → contracts & facilitator

```bash
# Prerequisite: foundry (curl -L https://foundry.paradigm.xyz | bash && foundryup)
cd chain
npm install

# Prove the loop works first: scratch anvil on :8547 → deploy →
# EIP-3009 round-trip → teardown, fully self-contained
npm run e2e

# ⚠️ READ chain/dev-keys.mjs FIRST. Deploying with the anvil default key
# makes the token's mint authority a keypair the entire internet has.
export TINY_CHAIN_DEPLOYER_KEY=0x...    # your real deployer
export FACILITATOR_RELAYER_KEY=0x...    # gas-only relayer

# Long-running devnet (:8545, 2s blocks), then deploy + smoke
npm run devnet
npm run compile && npm run deploy && npm run smoke

# x402 facilitator (refuses to start without X402_PAY_TO allowlist)
X402_PAY_TO=0xYourAddress npm run facilitator

# Multinode QBFT validator network
cd multinode && ./scripts/gen-network.sh
```

Docs: [`chain/README.md`](../chain/README.md)

### 6. Hardware → your 3D printer

The [tiny necklace](../hardware/) needs a Nicla board, ~$1 of PLA, and 60 cm of cord:

```bash
# Open a sliced plate in Bambu Studio (profile embedded) → Slice → Print
open hardware/prints/vision.3mf     # Vision pendant  (7.6 g, ~1 h)
open hardware/prints/voice.3mf      # Voice pendant   (6.3 g, ~48 min)
open hardware/prints/locket.3mf        # battery locket  (14.7 g, ~1.5 h)
open hardware/prints/cordkit.3mf       # the bead that closes the cord

# Flash + provision the board (firmware lives in its own repo)
pip install strands-nicla                     # github.com/cagataycali/strands-nicla
# …or pair it from the tiny iOS/Android app: Nearby → 💎 Set up
```

Docs: [`hardware/README.md`](../hardware/README.md) · every measured number and slicer lesson: [`hardware/PRINTS.md`](../hardware/PRINTS.md)

---

## 🏗️ Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Surfaces: Web (Next.js/Vercel Edge) · iOS · watchOS ·        │
│    Android · Wear OS · CLI (npx tiny-tech) · Telegram ·       │
│    the necklace (hardware/ — Nicla Vision/Voice fleet node)   │
└──────────────────────────┬────────────────────────────────────┘
                           │ SSE agent loop (/api/chat, Strands SDK)
                           │ multi-provider BYOK: OpenAI/Bedrock/Google/…
┌──────────────────────────▼────────────────────────────────────┐
│  Cloudflare Worker (worker/) — plugin.tiny.technology         │
│  D1 (source of truth) · KV (runtime reads) · Vectorize (RAG)  │
│  identity · memory graph · universe · shares · jobs · ledger  │
└──────────────────────────┬────────────────────────────────────┘
                           │ x402 payments · ERC-8004 registration
┌──────────────────────────▼────────────────────────────────────┐
│  Chain (chain/) — USDC on Base + tiny QBFT network            │
│  contracts · facilitator (payee-allowlisted) · validators     │
└───────────────────────────────────────────────────────────────┘
```

**Key invariants** (each traced to its enforcing code):
- The D1 `tinys` table is the **only** authority for existence + ownership ([`worker/migrations/0003_tiny_v2.sql`](../worker/migrations/0003_tiny_v2.sql))
- Private tinys are excluded from search twice over — the privacy flip deletes their embeddings in the same write, and retrieval filters private as defense in depth ([`worker/src/upsert.ts`](../worker/src/upsert.ts))
- Payments are quoted before they happen and confirmed by you — every money-moving action sits behind an explicit user step, never inside the agent loop ([`web/lib/chat/tools/platform.ts`](../web/lib/chat/tools/platform.ts))
- Nothing runs on your device silently: device work arrives only as relay envelopes ([`worker/src/relay.ts`](../worker/src/relay.ts)) and the clients surface them as notifications ([`RelayNotifier.kt`](../android/app/src/main/java/technology/tiny/app/fleet/RelayNotifier.kt))

## 🔐 Security & trust

Each claim names the code that enforces it:

- **No secrets in this repo** — worker secrets via `wrangler secret put`, frontend via Vercel env, chain via env vars, signing keys stay local; [CI](../.github/workflows/ci.yml) rehearses a stranger's clone on every push, which fails if anything private were required
- GitHub OAuth + WebAuthn passkeys ([`web/app/api/auth/`](../web/app/api/auth/)); sessions are HS256 JWTs in an httpOnly cookie, 30 days (`SESSION_TTL` in [`web/lib/auth.ts`](../web/lib/auth.ts))
- Agent-reachable fetches are SSRF-screened ([`web/tools/http.ts`](../web/tools/http.ts)), SQL `LIKE` inputs escaped ([`worker/src/sql.ts`](../worker/src/sql.ts)), model-declared tool names sanitized ([`web/lib/chat/tool-filter.ts`](../web/lib/chat/tool-filter.ts)), agent-opened URLs vetted — including the protocol-relative `//evil.com` trick ([`web/lib/chat/open-url.ts`](../web/lib/chat/open-url.ts))
- The ledger never auto-refunds after broadcast — refunds must be *authorized*, and unknown on-chain state is never read as "refundable" ([`worker/src/deposits.ts`](../worker/src/deposits.ts)); every spend carries an idempotent ref the schema enforces ([`worker/migrations/`](../worker/migrations/))

## 🧪 Testing

```bash
# Web (vitest — the largest suite in the repo)
cd web && npm test
cd web && npm run typecheck   # vitest strips types; next build skips tests/

# Worker
cd worker && npm run typecheck

# Chain (e2e suites cover deploy, x402, slashing, attendance, issuance)
cd chain && node scripts/smoke.mjs

# iOS
cd ios && xcodebuild test -scheme Tiny

# Android (scope to :app: — the :wear module has no JVM tests)
cd android && ./gradlew :app:testDebugUnitTest

# CLI (npm test = tsc, then node --test)
cd tiny-tech && npm test
```

Every push and PR runs the fresh-clone rehearsal in [CI](../.github/workflows/ci.yml):
`npm ci` in the web, worker, and tiny-tech trees, the web production build, the full
web test suite, and a typecheck over each tree — exactly what a stranger's first
clone runs. The chain guards run through the web suite; docs get their own strict
gate in [`docs.yml`](../.github/workflows/docs.yml).

