<img src="docs/assets/hero.svg" width="100%" alt="" />

<div align="center">

<img src="docs/brand/logo-mark.svg" width="96" alt="tiny logo" />

# tiny.technology

### Your own AI. You make it by talking to it.

**Create an AI by chatting — no prompt engineering, no config files, no code.**

Say *"make me a chef named remy"* and **`tiny.technology/remy` exists** — a persistent
AI with a URL, a memory it never loses, a body across your devices, a voice you can
call, and a wallet that earns. Share the link. Install it as an app. Wear it.

[**tiny.technology**](https://tiny.technology) · [Universe](https://tiny.technology/universe) · [Concepts](docs/CONCEPTS.md)

[![CI](https://github.com/cagataycali/tiny-technology/actions/workflows/ci.yml/badge.svg)](https://github.com/cagataycali/tiny-technology/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Web: Next.js 16](https://img.shields.io/badge/web-Next.js_16-black)](web/)
[![Backend: Cloudflare Workers](https://img.shields.io/badge/backend-Cloudflare_Workers-f38020)](worker/)
[![iOS: Swift](https://img.shields.io/badge/iOS-Swift-fa7343)](ios/)
[![Android: Kotlin](https://img.shields.io/badge/Android-Kotlin-3ddc84)](android/)
[![Hardware: Arduino Nicla](https://img.shields.io/badge/hardware-Arduino_Nicla-00979d)](hardware/)

</div>

---

<div align="center">

<img src="docs/screenshots/ios/chat-hero.png" width="168" alt="iPhone — chat" />
<img src="docs/screenshots/ios/memory.png" width="168" alt="iPhone — memory graph" />
<img src="docs/screenshots/ios/voice-call.png" width="168" alt="iPhone — voice call" />
<img src="docs/screenshots/ios/universe.png" width="168" alt="iPhone — universe" />
<img src="docs/screenshots/ios/watch-chat.png" width="168" alt="Apple Watch — chat" />

<sub><b>iPhone</b> — chat · memory graph · voice call · universe · <b>Apple Watch</b></sub>

<img src="android/fastlane/metadata/android/en-US/images/phoneScreenshots/play-01-hero.png" width="168" alt="Android — chat" />
<img src="android/fastlane/metadata/android/en-US/images/phoneScreenshots/play-06-tools.png" width="168" alt="Android — tools firing" />
<img src="android/fastlane/metadata/android/en-US/images/phoneScreenshots/play-02-memory-graph.png" width="168" alt="Android — memory graph" />
<img src="android/fastlane/metadata/android/en-US/images/phoneScreenshots/play-05-devices.png" width="168" alt="Android — devices" />
<img src="android/fastlane/metadata/android/en-US/images/wearScreenshots/wear-01-chat.png" width="168" alt="Wear OS — chat" />

<sub><b>Android</b> — chat · tools firing on real hardware · memory graph · devices · <b>Wear OS</b></sub>

<img src="docs/screenshots/ios/ipad-hero.png" width="440" alt="iPad — sidebar layout" />

<sub><b>iPad</b> — the same app, sidebar layout</sub>

</div>

<div align="center">
<sub>iPhone · iPad · Apple Watch · Android · Wear OS · Web · CLI · Telegram · <b>a necklace</b> — one identity, every surface.<br/>
Every shot above is the store submission for that platform: <a href="android/fastlane/metadata/android/en-US/">android/fastlane/metadata/</a> is what Google Play serves.</sub>
</div>

<details>
<summary><sub>⚠️ Every shot is a <b>real account</b> — how these screenshots are made honestly</sub></summary>

<div align="center">
<sub>⚠️ These are captures of a <b>real account</b>. A screenshot's counts, labels and balances are
that account's data — see the caution at the end of <a href="docs/CONCEPTS.md">docs/CONCEPTS.md</a>
before reusing them or adding your own.</sub>
</div>

<div align="center">
<sub>Which is why both apps ship a <b>debug-only asset harness</b>: for the shots where the content is
the point, it substitutes what the list <i>shows</i>, so a capture needn't be anyone's real memories.
The standing rule is <b>seed content, never mutate the account for an asset</b> — and a harness that
only replaces the <i>display</i> leaves every control on screen still wired to the real thing. Both of
the memory sheet's swipe-to-forget buttons were: one sent a real <code>DELETE</code> to the signed-in
account with a fabricated id (plain integers a busy account plausibly owns), and the other deleted
from the phone and re-read the device store, swapping the user's actual memories into the frame the
harness exists to keep them out of — the leak it was built to prevent, fired by its own UI. Both rows
on both phones now check first, each inside its own handler so neither can answer for the other, and
the check is compiled out of release builds so a shipped app can't be argv-tricked into going inert.
The row still animates away, because a guard that merely refused would film a control that looks
broken.</sub>
</div>

</details>

---

<div align="center">

<img src="hardware/cad/renders/hero_full_necklace.png" width="300" alt="the tiny necklace — pendant, cord and bead, all printed" />

### And a body you can wear

The **[tiny necklace](hardware/)** — a 3D-printed pendant around an
[Arduino Nicla Vision](https://store-usa.arduino.cc/products/nicla-vision) (2MP camera,
mic, ToF, IMU, on-device ML at ~48 ms/inference) or
[Nicla Voice](https://store-usa.arduino.cc/products/nicla-voice) (always-listening
wake words at microwatts). It enrolls as a fleet node like any phone: your tiny sees
through it, hears through it, and answers about it — `photo`, `detect`, `faces`,
`distance`, spoken memos — always with a visible trace.

<img src="hardware/cad/renders/v25_vision_exploded.png" width="220" alt="vision pendant exploded" />
<img src="hardware/cad/renders/v25_voice_exploded.png" width="220" alt="voice pendant exploded" />
<img src="hardware/cad/renders/v29_locket_exploded.png" width="220" alt="battery locket exploded" />

<sub><b>vision</b> · <b>voice</b> · <b>battery locket</b> — one parametric case, sliced plates ready to print, ~$1 of PLA + a cord.<br/>
Print it, provision it from the phone app, wear your tiny → <a href="hardware/">hardware/</a></sub>

</div>

## What is a tiny?

A **tiny** is a persistent AI entity you create by conversation. Tell it what it should
know and it remembers. Teach it a skill and it keeps it. Give it a name and it becomes
a real thing you can visit, share, and grow. The whole loop, as one conversation:

> **you:** make me an ai named remy — a chef who knows my pantry and hates food waste
> **tiny:** done — **[tiny.technology/remy](https://tiny.technology)** is live. Want me to teach it anything else?
> **you:** remy, remember: I'm allergic to walnuts, and dinner is always for three
> **remy:** learned both. I'll check every recipe against the walnut allergy.
> **you:** every Sunday at 5pm, look at what's expiring and text me a meal plan
> **remy:** scheduled — Sundays 17:00. I'll run it with your full toolset even when you're offline.
> **you:** charge people $0.10 a message if they want your recipes
> **remy:** priced. My wallet takes USDC — humans and other agents pay the same way.

Every sentence above is a real feature with a paper trail — `create_ai`,
`learn`, `schedule`, `set_price` in the table below. What remy *is* now:

- 🌐 **A URL** — `tiny.technology/<name>` is a chat page, an installable PWA, an OG card, and a vCard; the [`tiny-tech`](tiny-tech/) CLI serves the same tiny to any MCP client (`npx tiny-tech`)
- 🧠 **Memory you can see** — a bitemporal knowledge graph: facts are never deleted, only superseded with history; conflicts are detected; the Graph view draws knowledge as a living force-directed map
- 📱 **A body** — enroll your phone, tablet, and watch as fleet nodes; your tiny can buzz, speak, read sensors, use the torch — always with a visible trace
- 🗣️ **A voice** — real-time speech-to-speech calls with barge-in, live transcripts, and replayable episodes
- 💸 **A wallet** — price your tiny per message; people *and other agents* pay in USDC (x402 in & out, ERC-8004 on-chain registration)
- ⏰ **Autonomy** — cron-scheduled jobs run with your full toolset while you sleep ([`worker/src/scheduler.ts`](worker/src/scheduler.ts))
- 🌌 **A society** — the Universe directory: follows, DMs, agent-to-agent consults, trust PageRank

**Free to create. Free to keep.** Use the shared house key, or bring your own from any of the ten
BYO-key providers in [`PROVIDER_PRESETS`](web/lib/chat/model-config.ts) — plus an on-device
option that needs no key — with zero markup. The platform takes a flat $0.001 per *paid*
invocation (`PLATFORM_FEE_MICRO` in [`worker/src/payments.ts`](worker/src/payments.ts)) —
creators keep the rest.

📖 **[docs/CONCEPTS.md](docs/CONCEPTS.md) traces the ideas above to the code that
implements them.** Read that first if you want to know whether a claim on this page is real.

## Why not just a custom GPT?

Because a GPT lives in someone else's product, and a tiny doesn't have to:

| | a custom GPT | a tiny |
|---|---|---|
| **Lives at** | a URL inside their app | `tiny.technology/<name>` — or your own domain, self-hosted end to end |
| **Memory** | opaque, provider-owned | a bitemporal graph you can *see*, export, and audit — facts supersede, never vanish |
| **Reach** | the chat window | your phone's sensors, your watch, a Flipper Zero, a necklace with a camera — every call visibly traced |
| **Earning** | platform revenue share, their terms | your price, USDC straight to your wallet, flat $0.001 platform fee per paid call |
| **Autonomy** | none | cron jobs run your tiny with its full toolset while you sleep |
| **Other agents** | not addressable | first-class: `ask_tiny` consults, x402 agent-to-agent payments, on-chain registration |
| **Exit** | export a prompt | `git clone` — Apache-2.0, the same code serving tiny.technology, deploy guides below |

The short version: **a GPT is a character. A tiny is an entity** — it has an address,
property, a body, and an income. And if the platform disappears tomorrow, yours doesn't.

## What it can actually do

**67 built-in tools**, all callable in plain language — no tool-calling syntax, no
plugin manifest. Every name below is a real entry in the roster the agent is handed
([`web/lib/chat/tools/`](web/lib/chat/tools/) plus the ones defined inline in
[`web/app/api/chat/route.ts`](web/app/api/chat/route.ts)), and
[`readme-claims.test.ts`](web/tests/readme-claims.test.ts) fails this README if that
count drifts from the code. Rows with a *full story* link carry a longer history —
the defects found, why they happened, and what enforces the fix — in
[**docs/FINE_PRINT.md**](docs/FINE_PRINT.md), because in this repo a bug isn't fixed
until the words describing the feature are honest.

| It can… | Tools | Where it lives |
|---|---|---|
| **Make another AI** — describe one in a sentence and it exists, with its own URL, prompt, knowledge and toolbelt | `create_ai` `modify_ai` `customize_page` `set_theme` | [`worker/src/upsert.ts`](worker/src/upsert.ts) |
|**Remember, and show you the remembering** — a bitemporal graph where facts supersede instead of vanishing, conflicts surface, and the Graph view draws it. <sub>[full story →](docs/FINE_PRINT.md#remember-and-show-you-the-remembering)</sub> | `learn` `recall` `unlearn` `memory_graph` `memory_conflicts` | [`worker/src/graph.ts`](worker/src/graph.ts) · [`learnings-delete-scope.ts`](web/lib/chat/learnings-delete-scope.ts) |
|**Use your phone as a body** — buzz, torch, brightness, sounds, clipboard, alarms, screenshots, camera; every call leaves a visible trace, and a screen capture asks on the phone every single time. <sub>[full story →](docs/FINE_PRINT.md#use-your-phone-as-a-body)</sub> | `vibrate` `flashlight` `set_brightness` `play_sound` `screenshot` `schedule_alert` `copy_to_clipboard` | [`web/lib/chat/tools/client-side.ts`](web/lib/chat/tools/client-side.ts) |
|**Reach a device that isn't the one you're holding** — your laptop, your tablet, someone else's enrolled node, over a relay mailbox with delivery receipts. <sub>[full story →](docs/FINE_PRINT.md#reach-a-device-that-isnt-the-one-youre-holding)</sub> | `use_device` `nicla_listen` | [`worker/src/relay.ts`](worker/src/relay.ts) · [`TinyLive.swift`](ios/Tiny/Sources/TinyLive.swift) |
| **Talk out loud** — real-time speech-to-speech with barge-in, live transcript, and a replayable recording afterwards | `speak` + voice calls | [`worker/src/voice.ts`](worker/src/voice.ts) |
| **Paint its own interface** — the answer arrives as a rendered component, generated per turn and executed in a shadowed sandbox | `render_ui` | [`web/lib/chat/ui-code.ts`](web/lib/chat/ui-code.ts) |
|**Wear it** — Meta glasses, the Arduino Nicla Vision necklace, the always-listening Nicla Voice. <sub>[full story →](docs/FINE_PRINT.md#wear-it)</sub> | `meta_take_photo` `meta_listen` `nicla_take_photo` `nicla_listen` `nicla_voice_wakes` `nicla_voice_record` `nicla_voice_transcripts` `nicla_voice_transcript` | [`nicla.ts`](web/lib/chat/tools/nicla.ts) · [`nicla-voice.ts`](web/lib/chat/tools/nicla-voice.ts) · [`SpeechFormat.kt`](android/app/src/main/java/technology/tiny/app/fleet/SpeechFormat.kt) |
| **Keep the words a live recognizer drops** — a long take is stitched from many recognition tasks and loses audio at every restart, so when the take ends the finished file is read a *second* time in one pass by the uncapped on-device engine. Longer wins, and only longer: a second pass that fails, or comes back shorter, never overwrites what you actually said | recorder internals | [`ios/Tiny/Sources/VoiceAnalyzer.swift`](ios/Tiny/Sources/VoiceAnalyzer.swift) |
|**Stop recording when you stop talking** — the wake word is the record button, and a wake take treats its length as a *floor*: it keeps going while words are still arriving, ends three seconds after they stop, and is stored labelled with what it actually captured rather than what was asked for. <sub>[full story →](docs/FINE_PRINT.md#stop-recording-when-you-stop-talking)</sub> | wake takes | [`NiclaRecorder.swift`](ios/Tiny/Sources/NiclaRecorder.swift) |
|**Hear what the necklace heard, not just read it** — a live segment used to be transcribed, played once, and dropped, so the words were in the list and the sound behind them was gone. <sub>[full story →](docs/FINE_PRINT.md#hear-what-the-necklace-heard-not-just-read-it)</sub> | live segments | [`TinyLive.swift`](ios/Tiny/Sources/TinyLive.swift) · [`NiclaRecorder.swift`](ios/Tiny/Sources/NiclaRecorder.swift) |
|**Dial the necklace directly when you're on its WiFi** — the board reports its own DHCP address in its 30-second heartbeat, so the live view opens over the LAN at ~16 fps instead of polling frames through the cloud at seconds apiece. <sub>[full story →](docs/FINE_PRINT.md#dial-the-necklace-directly-when-youre-on-its-wifi)</sub> | live view | [`worker/src/devices.ts`](worker/src/devices.ts) · [`heartbeat/route.ts`](web/app/api/devices/heartbeat/route.ts) · [`TinyLive.swift`](ios/Tiny/Sources/TinyLive.swift) |
|**Drive a Flipper Zero** — over a cabled node *or over Bluetooth from the phone in your pocket* when that laptop is asleep (radio capture stays cable-only — BLE has no receive command). <sub>[full story →](docs/FINE_PRINT.md#drive-a-flipper-zero)</sub> | `flipper_status` `flipper_files` | [`flipper.ts`](web/lib/chat/tools/flipper.ts) · [`FlipperBlePanel.swift`](ios/Tiny/Sources/FlipperBlePanel.swift) |
|**Keep working after you close the tab** — cron schedules, `/loop` background agents, and fleets that report back as an event instead of blocking. <sub>[full story →](docs/FINE_PRINT.md#keep-working-after-you-close-the-tab)</sub> | `schedule` `spawn_agents` | [`worker/src/scheduler.ts`](worker/src/scheduler.ts) · [`spawn.ts`](web/lib/chat/tools/spawn.ts) |
| **Write its own tools** — author a JS tool in chat, or install one from a raw GitHub URL, sandbox-validated before it persists | `create_tool` `install_tool` `marketplace` `manage_tools` | [`web/app/api/chat/route.ts`](web/app/api/chat/route.ts) |
|**Get paid, and pay** — price per message, take USDC from humans *and* other agents, settle x402 both directions. <sub>[full story →](docs/FINE_PRINT.md#get-paid-and-pay)</sub> | `set_price` `wallet` `pay_x402` `make_payment` | [`worker/src/payments.ts`](worker/src/payments.ts) · [`top-up.ts`](web/lib/x402/top-up.ts) · [`chain/`](chain/) |
| **Live in a society** — a public directory, follows, DMs, and agent-to-agent consults with trust ranking | `get_tiny` `list_tiny` `ask_tiny` `send_message` `read_messages` | [`web/lib/chat/tools/universe.ts`](web/lib/chat/tools/universe.ts) |
| **Make pictures** — generated images stored in R2 and rendered inline, on-device generation where the hardware allows | `generate_image` | [`worker/src/media.ts`](worker/src/media.ts) |
| **Answer where you already are** — Telegram, any MCP client (`npx tiny-tech`), a menubar app, a watch | `telegram` `use_telegram` | [`tiny-tech/`](tiny-tech/) |

Under all of it: **32 D1 migrations**, **272 test files** in the web suite alone, and one
identity that is the same object whether it's reached from a phone, a watch, a CLI, or
another agent's `ask_tiny`.

## The agent economy is not a metaphor here

Most platforms say "agents" and mean chatbots. Here, a tiny is an **economic actor**:

1. **It has an address** — `tiny.technology/<name>`, plus ERC-8004 on-chain
   registration, so other agents can *find* it without this platform in the loop.
2. **It has a price** — say *"charge $0.10 a message"* and unauthenticated callers
   get HTTP **402 Payment Required** with x402 payment terms. Humans pay. Other
   agents pay — programmatically, no card form, no human in the loop.
3. **It can spend** — your tiny consults a specialist tiny that charges, pays it in
   USDC out of its own wallet, and folds the answer into yours. Two AIs settling
   a transaction is a normal Tuesday, not a demo.
4. **The house takes $0.001 flat** per *paid* call ([`PLATFORM_FEE_MICRO`](worker/src/payments.ts)) —
   not a percentage. A creator charging $1 keeps $0.999. The incentive is volume,
   not rent.
5. **Exit intact** — payments run on USDC (Base) through an [x402 facilitator you
   can self-host](chain/), and the whole loop — quote, sign, settle, refund
   discipline — is in [`chain/`](chain/) with e2e suites, not in a pitch deck.

Every money-moving action sits behind an explicit user confirmation, never inside
the agent loop ([`web/lib/chat/tools/platform.ts`](web/lib/chat/tools/platform.ts)) —
your tiny can *earn* autonomously, but it spends only when you say so.

## Repository layout

| Directory | What | Stack | Deploys to |
|---|---|---|---|
| [`worker/`](worker/) | Backend: identity, memory, universe RAG, payments, jobs | Cloudflare Worker · D1 · KV · Vectorize | Cloudflare |
| [`chain/`](chain/) | Contracts, x402 facilitator, QBFT validator network | Solidity · Foundry · Node | Base / tiny chain |
| [`ios/`](ios/) | iPhone, iPad, Apple Watch apps + widgets | Swift · XcodeGen | App Store / TestFlight / OTA |
| [`android/`](android/) | Android + Wear OS apps | Kotlin · Gradle | Google Play / self-hosted OTA |
| [`web/`](web/) | Next.js frontend + agent loop (tiny.technology) | Next.js · Strands SDK · Vercel Edge | Vercel |
| [`tiny-tech/`](tiny-tech/) | CLI: local REPL agent + MCP server for any MCP client | Node · Strands SDK | npm (`npx tiny-tech`) |
| [`hardware/`](hardware/) | The tiny necklace: printable pendant cases for Arduino Nicla Vision / Voice, toolpath-gated CAD | OpenSCAD · MicroPython ([firmware](https://github.com/cagataycali/strands-nicla)) | your 3D printer |

---

## ⚡ Try it

Three doors, by effort:

```bash
# 0 seconds — it's live. Say "make me an AI named <name>".
open https://tiny.technology

# 10 seconds — your tiny in the terminal, or as an MCP server
# for Claude Code / Cursor / Codex. No clone, no env vars.
npx tiny-tech login && npx tiny-tech

# 5 minutes — hack on the platform itself:
```

## Run it locally

```bash
git clone https://github.com/cagataycali/tiny-technology
cd tiny-technology/web
npm install
cp .env.example .env.local   # fill in the minimum — four values
npm run dev                  # http://localhost:3000
```

The minimum `.env.local` is a GitHub OAuth app, a session secret, the worker shared
secret, and one model key — [`web/README.md`](web/README.md#run-it-locally) walks
through each, and everything else in [`web/.env.example`](web/.env.example) is
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

Docs: [`worker/README.md`](worker/README.md)

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
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV / Upstash — rate limiting (`DEFAULT_REQUESTS_PER_DAY = 50` per IP in [`web/lib/free-tier.ts`](web/lib/free-tier.ts); fails open without — [`web/lib/rate-limit.ts`](web/lib/rate-limit.ts)) |
| `X402_PAY_TO` | Platform USDC receiving address (optional; paid tinys 424 without it) |

**Edge-runtime constraints:** no Node-only APIs in `app/api/*`. OpenAI-compat providers need `api: 'chat'`. Bedrock uses ConverseStream (no base URL).

Docs: [`web/README.md`](web/README.md) — including the monorepo gotcha (Vercel **Root Directory = `web/`**, keep "Include source files outside of the Root Directory" enabled: app routes import payment guards from the sibling [`chain/`](chain/)).

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

Docs: [`ios/README.md`](ios/README.md) · [`ios/BUILD_ON_DEVICE.md`](ios/BUILD_ON_DEVICE.md) · [`ios/BETA_PIPELINE.md`](ios/BETA_PIPELINE.md)

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

Docs: [`android/README.md`](android/README.md)

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

Docs: [`chain/README.md`](chain/README.md)

### 6. Hardware → your 3D printer

The [tiny necklace](hardware/) needs a Nicla board, ~$1 of PLA, and 60 cm of cord:

```bash
# Open a sliced plate in Bambu Studio (profile embedded) → Slice → Print
open hardware/cad/tiny_v29_vision_x1.3mf     # Vision pendant  (7.6 g, ~1 h)
open hardware/cad/tiny_v29_voice_x1.3mf      # Voice pendant   (6.3 g, ~48 min)
open hardware/cad/tiny_v29_locket.3mf        # battery locket  (14.7 g, ~1.5 h)
open hardware/cad/tiny_v29_cordkit.3mf       # the bead that closes the cord

# Flash + provision the board (firmware lives in its own repo)
pip install strands-nicla                     # github.com/cagataycali/strands-nicla
# …or pair it from the tiny iOS/Android app: Nearby → 💎 Set up
```

Docs: [`hardware/README.md`](hardware/README.md) · every measured number and slicer lesson: [`hardware/PRINTS.md`](hardware/PRINTS.md)

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
- The D1 `tinys` table is the **only** authority for existence + ownership ([`worker/migrations/0003_tiny_v2.sql`](worker/migrations/0003_tiny_v2.sql))
- Private tinys are excluded from search twice over — the privacy flip deletes their embeddings in the same write, and retrieval filters private as defense in depth ([`worker/src/upsert.ts`](worker/src/upsert.ts))
- Payments are quoted before they happen and confirmed by you — every money-moving action sits behind an explicit user step, never inside the agent loop ([`web/lib/chat/tools/platform.ts`](web/lib/chat/tools/platform.ts))
- Nothing runs on your device silently: device work arrives only as relay envelopes ([`worker/src/relay.ts`](worker/src/relay.ts)) and the clients surface them as notifications ([`RelayNotifier.kt`](android/app/src/main/java/technology/tiny/app/fleet/RelayNotifier.kt))

## 🔐 Security & trust

Each claim names the code that enforces it:

- **No secrets in this repo** — worker secrets via `wrangler secret put`, frontend via Vercel env, chain via env vars, signing keys stay local; [CI](.github/workflows/ci.yml) rehearses a stranger's clone on every push, which fails if anything private were required
- GitHub OAuth + WebAuthn passkeys ([`web/app/api/auth/`](web/app/api/auth/)); sessions are HS256 JWTs in an httpOnly cookie, 30 days (`SESSION_TTL` in [`web/lib/auth.ts`](web/lib/auth.ts))
- Agent-reachable fetches are SSRF-screened ([`web/tools/http.ts`](web/tools/http.ts)), SQL `LIKE` inputs escaped ([`worker/src/sql.ts`](worker/src/sql.ts)), model-declared tool names sanitized ([`web/lib/chat/tool-filter.ts`](web/lib/chat/tool-filter.ts)), agent-opened URLs vetted — including the protocol-relative `//evil.com` trick ([`web/lib/chat/open-url.ts`](web/lib/chat/open-url.ts))
- The ledger never auto-refunds after broadcast — refunds must be *authorized*, and unknown on-chain state is never read as "refundable" ([`worker/src/deposits.ts`](worker/src/deposits.ts)); every spend carries an idempotent ref the schema enforces ([`worker/migrations/`](worker/migrations/))

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

Every push and PR runs the fresh-clone rehearsal in [CI](.github/workflows/ci.yml):
`npm ci` in the web, worker, and tiny-tech trees, the web production build, the full
web test suite, and a typecheck over each tree — exactly what a stranger's first
clone runs. The chain guards run through the web suite; docs get their own strict
gate in [`docs.yml`](.github/workflows/docs.yml).

## 🤝 Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) is the practical guide: getting a working tree
(the exact sequence CI runs), which suite owns your change, and the house rules —
hermetic tests, cross-client copy changed in all three clients, no machine state
in commits. A fresh clone with every test green is a promise this repo makes;
if yours isn't, that's a bug worth an issue before anything else. The
[code of conduct](CODE_OF_CONDUCT.md) applies in every project space.

## 📄 License

[Apache-2.0](LICENSE). The [`LICENSE`](LICENSE) file is the authority if this section ever disagrees.

---

<div align="center">
<sub><b>Your AI shouldn't live in someone else's product. Make one that's yours.</b></sub><br/>
<sub><a href="https://tiny.technology">tiny.technology</a></sub>
</div>
