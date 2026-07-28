# AGENTS.md — Tiny AI (tinyai-id) Architecture

> **Tiny AI** — "Create your own AI by chatting." A **free** platform where anyone can create, modify, and share AI agents ("tinys") through natural conversation. Live at **tiny.technology**. Auth = GitHub OAuth + WebAuthn passkeys. No payments.

---

## 🗺️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER (Browser)                            │
│              tiny.technology  /  tiny.technology/<slug>          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│              NEXT.JS APP (this repo root) — Vercel Edge          │
│                                                                  │
│  app/page.tsx ──────── Home = Chat with "tiny" + <Community/>    │
│  app/[slug]/page.tsx ─ Per-AI chat page (SSR metadata + Chat)    │
│  app/api/chat ──────── ⭐ THE AGENT LOOP (Strands SDK, multi-    │
│                          provider: OpenAI/Bedrock/Google/compat) │
│  app/api/auth ──────── GitHub OAuth login + callback (JWT cookie)│
│  app/api/auth/webauthn/{register,login} — passkey enroll/login   │
│  app/api/me ────────── session user + owned tinys                │
│  app/api/logout ────── clear session                             │
│  app/api/tiny ──────── Proxy: get tiny config                    │
│  app/api/control ───── Create/update tiny (session-gated)        │
│  app/api/worker ────── Fetch + parse OpenAPI → skills (SSRF-    │
│                        guarded: https, public hosts, 2MB cap)   │
│  app/api/share ─────── create/fetch/revoke shared conversations  │
│  app/api/delete ────── delete your tiny (session-authorized)     │
│  app/api/login ─────── unlock private tinys (session OR key)     │
│  app/og/[slug] ─────── Dynamic OG images                         │
│  app/vcard/[slug] ──── vCard export per tiny                     │
│                                                                  │
│  State: Vercel KV rate limiting (50 req/day/IP, bypassed with    │
│         BYO API key)                                             │
└──────────────────────────┬──────────────────────────────────────┘
                           │  HTTPS (X-Internal-Key for /user/*)
┌──────────────────────────▼──────────────────────────────────────┐
│     CLOUDFLARE WORKER (chatgpt-plugin-tinyai/) — "the backend"   │
│     plugin.tiny.technology                                       │
│                                                                  │
│  Router: @cloudflare/itty-router-openapi (self-docs at /)        │
│    POST   /upsert    create/update a tiny (tiny-v2 authorized)   │
│    DELETE /tiny      permanent delete: KV + D1 + vector (owner)  │
│    GET    /get       tiny config (hook masked + MCP redacted     │
│                      unless owner/internal; userId auth)         │
│    GET    /retrieve  universe RAG (private excluded; owner       │
│                      memory via key OR session)                  │
│    GET    /list      public+active tinys from tiny-v2 (KV-shape) │
│    GET    /community PUBLIC: users + public tinys (60s cache)    │
│    POST/GET/DELETE /share (+/share/list) — stored conversations, │
│                      revoke by token or account ownership        │
│    GET    /legal     ToS                                         │
│    POST /user/upsert, GET /user/get           (internal-key)     │
│    POST /credential/{add,signcount}, GET /credential/list (int.) │
│                                                                  │
│  Storage bindings (wrangler.toml):                               │
│    D1 "tiny-v2" (binding DB) ⭐ SOURCE OF TRUTH:                 │
│       users, credentials (WebAuthn), tinys (ownership+meta),     │
│       shares (account-owned share links)                         │
│    D1 "tiny" (binding DB_OLD) — legacy, kept for reference,      │
│       NOT in any hot path                                        │
│    KV: tiny (configs, chat-runtime reads), post (share snapshots,│
│        90d TTL), applause, stats                                 │
│    Vectorize: VECTOR_INDEX "tiny" (RAG; private tinys DELETED    │
│        from index on privacy flip), MEMORY "memory"              │
│                                                                  │
│  Secrets (wrangler secret put): OPENAI_API_KEY, INTERNAL_API_KEY,│
│    RESEND_API_KEY, CLOUDFLARE_API_TOKEN                          │
│  External: OpenAI (embeddings), Resend (email fwd via email())   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 🔐 Identity & Ownership (free platform)

- **GitHub OAuth** (`/api/auth`) → user row in D1 tiny-v2 → HS256 JWT session in httpOnly cookie (30d). `lib/auth.ts`.
- **WebAuthn passkeys**: enroll requires session; login is usernameless (discoverable credentials) → same JWT session.
- **tiny-v2 `tinys` table is the ONLY authority** for existence + ownership:
  - No row → name is free to claim (even if it existed on the old platform).
  - Row exists → update/delete allowed only when `userId` (via `X-Internal-Key`-guarded request) matches `tinys.user_id`.
  - **Legacy 8-char keys authorize NOTHING for writes.** They (and `x-tiny-key`) only unlock *viewing private tiny content* — and session owners get that automatically (auto-unlock on the private tiny's page, `userId` pass-through on /get and /retrieve).
- Session identity (id, login, name, avatar, email) + owned tinys are injected into the agent's system prompt every request (`userContext` block in the chat route).
- **Privacy enforcement**: private tinys are excluded from /list and /retrieve, their vector embedding is deleted on privacy flip, /get masks their content for non-owners, vCard/OG show placeholders. `hook` is masked for non-owners even on public tinys (webhook URLs embed tokens); MCP headers likewise redacted.

## 🔗 Sharing

- Chat "Share" → POST `/api/share` → snapshot (sanitized: no tool payloads/reasoning/failure state) stored in KV `post` (90d TTL) → short URL `?share=<12-char id>`.
- Viewing a share is read-only (banner + "Continue here" adoption).
- Revocation: creation-time token (localStorage `tiny_my_shares`) OR account ownership (`shares` table) — `/shares` and `/shares revoke <id>` slash commands.

## ⭐ Core: The Agent Loop (`app/api/chat/route.ts`)

Edge runtime, 300s max. Built on **`@strands-agents/sdk`**. Split into modules under `lib/chat/` (all pure + unit-tested):
- `model.ts` — `createModel`/`preflightModelCheck` provider factory (BYOK routing table below)
- `prompt.ts` — `buildSoulPrompt(inputs)`: the identity-first system prompt + render_ui guide
- `events.ts` — `normalizeAgentEvent`: Strands event → client wire payload (the SSE protocol)
- `helpers.ts` — `friendlyError` (nested provider-error unwrapping), `resultText`, `serializeToolContent`, `buildMcpClients`
- `tools/universe.ts` — get_tiny, list_tiny, `makeRetrieveTool(name, key)`
- `tools/client-side.ts` — render_ui, suggest_followups, remember, forget, manage_messages (no-op callbacks; browser executes)
- `tools/memory.ts` — `makeLearn/Recall/UnlearnTool(session)` (definitions only; memory-v2 owns semantics)
- `tools/platform.ts` — userId-keyed factories shared with `/api/job-run`: `runToolApi` (Node-sandbox proxy), `makeForgedTools(rows)`, `buildDynamicTools(fns)` (sanitize+dedupe+SSRF), `makeUseTelegramTool(userId)` — scheduled jobs mount the owner's real toolset through these
- `tool-filter.ts` — `PROTECTED_TOOLS`, `parseDisabledTools`, `filterTools` (manage_tools mount filter; protected tools can never be stripped)
The route itself keeps: request parsing, parallel context fetches, the request-coupled tools (create_ai/ask_tiny/spawn_agents/schedule/telegram/forge/marketplace/theme — they close over model, tinyData, ring helpers), agent assembly, SSE pump (seq stamping, keepalive, abort→cancel, overflow self-heal).

### Model providers (BYOK via `x-tiny-model-*` headers)
| Provider header | Server model | Notes |
|---|---|---|
| `openai` (default) | `OpenAIModel` (Responses API) | `OPENAI_API_KEY` fallback |
| `bedrock` | `BedrockEdgeModel` (`lib/bedrock-edge.ts`) | hand-rolled ConverseStream + eventstream parser, bearer token, `x-tiny-model-region`. NO base URL — Claude is not on Bedrock's /openai/v1 |
| `gemini` → `google` | `GoogleModel` | |
| `vercel` | `VercelModel` + AI Gateway | |
| anthropic/openrouter/groq/deepseek/mistral/xai/perplexity/custom | `OpenAIModel` with preset base URL + **`api: 'chat'`** (compat endpoints don't serve /v1/responses) | |

BYO API key bypasses the 50/day rate limit. Model listing per provider: `lib/model-registry.ts` (1h localStorage cache, fallback lists).

### Request flow per message
1. Headers: `x-tiny-name/-session/-key/-ip` + `x-tiny-model-*` + `x-tiny-mcp-servers`
2. Rate limit (skipped for BYOK), session check
3. Messages trimmed to last 31; system messages folded into system prompt
4. **Parallel fetch**: `/retrieve` (universe RAG) + `/get` (tiny config) + `getUserWithTinys` (profile)
5. Retrieved + own `worker` OpenAPI schemas → dynamic Strands tools (`lib/utils.ts:parseOpenAPI()`, dedup by name)
6. Agent streams; custom SSE bridge unwraps SDK 1.10 `modelStreamUpdateEvent`s, 15s keepalive pings

### Built-in tools
| Tool | Purpose |
|---|---|
| `create_ai` / `modify_ai` | Session-gated upsert (login required; ownership enforced by worker) |
| `get_tiny` / `list_tiny` / `retrieve` | Discovery across the universe |
| `ask_tiny` | ⭐ Agent-as-a-tool: nested Strands agent with the target tiny's identity (declines private tinys) |
| `spawn_agents` | ⭐ Parallel fan-out: unbounded task list (64 backstop, 8 concurrent via worker pool), fresh context + http each, batch timeout, failure isolation |
| `learn` / `recall` / `unlearn` | Server-side per-user memory: D1 (source of truth, 5000×2KB, rejects when full — no silent eviction) + Vectorize `MEMORY` index (`learning:<id>`, metadata `{userId}`) for semantic recall; `/memory` UI |
| `render_ui` | ⭐ Generative UI — React.createElement code, executed client-side (`DynamicUI.tsx` via `new Function()`, Recharts injected) |
| `remember` / `forget` | Client-side persistent memory (localStorage, `continuity.ts`) |
| `suggest_followups` | Clickable chips under the response |
| `http` (`tools/http.ts`) | Universal HTTP client tool |
| `create_tool` / `remove_tool` | Forge personal JS tools → Node sandbox (`/api/run-tool`) validation, D1-persisted, mounted as `my_<name>` next request (20/user, 4KB, code public on profile) |
| `install_tool` | Install from raw.githubusercontent.com — global allowlist + per-user `/tools trust <owner>`, branch refs pinned to commit SHA |
| `marketplace` | Browse everyone's public forged tools (worker `/tools/browse`) + install by author/name (code fetched server-side, re-validated) |
| `manage_tools` | Enable/disable tools per user (user_prefs); PROTECTED_TOOLS can't be disabled |
| `manage_messages` | Client-executed context surgery: stats/drop/compact |
| `schedule` | Cron + one-time background jobs (D1 jobs, CF cron fires `/api/job-run`, results via push). Jobs run with the owner's capability set — forged `my_*` tools, the tiny's OpenAPI skills + MCP servers, learn/recall/unlearn, `use_telegram` (owner userId keyed) — via the shared factories in `lib/chat/tools/platform.ts` |
| `telegram` | Pair a bot; CF cron polls getUpdates, replies as the tiny |
| `use_telegram` | ⭐ Full Bot API proxy (use_aws pattern): any method (sendPhoto/Poll/inline keyboards…), token stays in worker, allowlisted chats only, polling/webhook methods blocked; button presses → event bus + agent reply |
| *dynamic* | Every endpoint of a tiny's bound `worker` OpenAPI spec |
| *MCP* | Remote streamable-http MCP servers from header or tiny config |

---

## 🖥️ Frontend

- **`components/chat/Chat.tsx`** — chat client: streaming, **concurrent sends** (unbounded parallel turns via `lib/chat/stream-registry.ts` — each turn's history snapshot includes sibling in-flight replies as annotated partials; per-bubble stop; docs/concurrent-sends-implementation.md), markdown (GFM+KaTeX+syntax), tool viz, DynamicUI, follow-up chips, edit/delete/copy/stop (stop cancels upstream billing), attachments (photos/docs → Converse content blocks), server-stored share links (read-only view + adopt), retry banner on failures, ?q= auto-send deep links, rAF-batched streaming, token usage tags, slash commands (`/clear /settings /share /shares /jobs /export /save /load /auto /tools /memory /memories /forgetall /palette /help`), `!expr` bang eval, ⌘⇧K palette (fuzzy, 4 sections: Commands/Conversations/Tinys/Ask), localStorage persistence per tiny
- **`components/chat/ambient.ts`** — 🌙 idle ambient (45s → one background exploration) + `/auto` autonomous loop (≤5 iterations, `[AMBIENT_DONE]` signal); findings injected into the next turn
- **`components/chat/platform.ts`** — SW registration, push subscribe, TabMesh (BroadcastChannel cross-tab ring)
- **`components/chat/kg.ts`** — 🕸️ KG memory (§2.12): entity co-occurrence graph over localStorage memories+turn log, 1-hop spreading-activation recall injected per turn ("Associated memories")
- **`components/chat/voice.ts`** — 🎙️ Web Speech dictation (mic in composer) + per-message speechSynthesis TTS; zero deps
- **`components/chat/ActivityHUD.tsx`** — ⚡ header event feed (jobs/telegram/visits) with unread badge; polls `/api/events` only while open
- **`components/chat/TaskTree.tsx`** — 🌳 spawn_agents fan-out tree (live per-task status, expandable results)
- **`components/chat/ReplayBar.tsx`** — 🎬 share-view scrubber (play/pause, 1×/2×/4×, step); pure view-state slice
- **`lib/session-archive.ts`** — `/save` `/load`: versioned JSON session archives, credential redaction, cross-device restore; `/save cloud` + `/load cloud` → `/api/archives` (worker KV+D1, 20/user, 1y)
- **`lib/model-pricing.ts`** — 💵 USD/Mtok table → per-message `~$` tag + `/cost` summary
- **`lib/sse.ts`** — chunk-boundary-safe SSE decoder (shared: chat + ambient); server stamps `seq` for gap detection
- **Header**: logged out → login buttons only; logged in → 2 buttons (settings gear + avatar menu). Share/clear live in the avatar dropdown, shown only when the conversation has user messages
- **`ModelSettings.tsx`** — tabbed Settings modal: *Model* (provider/key/live model list) | *Your AI* (`Control` in compact mode)
- **`Control.tsx`** — tiny config panel; ownership card (session-based, no API key field)
- **`AuthButton.tsx`** — GitHub/passkey login, avatar menu (my tinys, share/clear, passkey enroll, logout)
- **`components/Community.tsx`** — home page showcase from `/community` (server component, 60s revalidate)
- **`continuity.ts`** — turn log (200 max, last 20 injected) + memories (100 max) as system message
- **`app/[slug]`** — SSR `generateMetadata` (OG/Twitter player cards); private tinys masked

---

## 🔄 Key End-to-End Flows

### Create an AI (via chat or Control panel)
```
Logged-in user: 'create an ai named support ...'
 → create_ai tool (session.sub attached) → POST /upsert (X-Internal-Key)
 → no tiny-v2 row → INSERT tinys + KV write + embed → active immediately
 → live at tiny.technology/support, listed in avatar menu + agent context
```

### Chat with a tiny
```
Visit /support → SSR /get → <Chat> hydrates
 → POST /api/chat (x-tiny-* + optional x-tiny-model-* headers)
 → parallel: /retrieve + /get + user profile
 → dynamic tools from worker OpenAPI + retrieved skills + MCP
 → Strands agent streams: text | tools | render_ui | followups
```

---

## 📁 Directory Map

| Path | What |
|---|---|
| `app/api/chat/route.ts` | ⭐ Strands agent loop, providers, all tool defs |
| `app/api/auth/**`, `app/api/me`, `app/api/logout` | GitHub OAuth + WebAuthn + session |
| `lib/auth.ts` | JWT sessions, worker D1 helpers (internal-key) |
| `lib/bedrock-edge.ts` | Edge-safe Bedrock ConverseStream model |
| `lib/model-registry.ts` | Live per-provider model listing (+fallbacks) |
| `lib/utils.ts` | `parseOpenAPI()`, `cn()`, weather (WEATHER_API_KEY) |
| `components/chat/` | Chat, Control, ModelSettings, AuthButton, DynamicUI, continuity |
| `components/Community.tsx` | Home page community showcase |
| `app/api/share`, `app/api/delete` | Share + delete proxies (session-authorized) |
| `app/sitemap.ts` | Dynamic sitemap from /community |
| `tools/http.ts` | Universal HTTP tool |
| `chatgpt-plugin-tinyai/` | Cloudflare Worker backend (own package, wrangler) |
| `chatgpt-plugin-tinyai/src/{upsert,delete,get,retrieve,list,community,share,users,legal}.ts` | One class per endpoint |
| `chatgpt-plugin-tinyai/migrations/0003_tiny_v2.sql` | tiny-v2 schema (users/credentials/tinys) |

---

## ⚠️ Gotchas for Agents Working Here

1. **Two deployables**: repo root (Vercel/Next, edge runtime) vs `chatgpt-plugin-tinyai/` (Cloudflare/wrangler, deploy BOTH default + `--env production` — same code, two worker names). From the worker dir, `npm run deploy` does both envs; `npm run typecheck` = `tsc --noEmit`. (wrangler is v4 — `wrangler deploy`, not the removed `publish`.)
2. **tiny-v2 is authoritative**; KV `tiny` namespace is just the chat-runtime read path. Old D1 (`DB_OLD`) and legacy KV records are reference-only.
3. **Legacy keys are dead** for authz. Don't add key checks back.
4. **Edge runtime**: no Node-only APIs in `app/api/*`. `next.config.js` stubs `@aws-sdk/*`, `node:fs`, `node:path`, `bufferutil`, `utf-8-validate`.
5. **OpenAI-compat providers need `api: 'chat'`** — Strands defaults to the Responses API which only api.openai.com serves.
6. **Bedrock BYOK** uses ConverseStream (no base URL). The `/openai/v1` compat endpoint does NOT serve Claude models.
7. **DynamicUI executes LLM code** via `new Function()` client-side — powerful but XSS-adjacent.
8. **`itty-router-openapi` quirks (BURNED US TWICE)**:
   - Response schemas must not contain empty arrays (`schema: { users: [] }` crashes deploy with "Arr must have a type").
   - **Body fields NOT declared in `requestBody` are SILENTLY STRIPPED** — `private`, `schema`, `skills` were dropped for weeks (privacy toggles no-oped, skills wiped on save). Declare every field; send objects as JSON strings (`Str`) and parse in the handler.
   - Query params may not populate `data.<name>` on all paths — read `new URL(request.url).searchParams` as fallback (see get/list/retrieve).
   - **CREATE and UPDATE paths must handle the same field identically.** `upsert.ts` once hardcoded `private:false` on CREATE while UPDATE honored the flag — a user choosing PRIVATE at *creation* got a public, universe-indexed tiny (prompt/knowledge leaked to search). When a write path branches new-vs-existing, every privacy/visibility field needs the same treatment (and the same `embedTiny` skip) in both branches.
9. **Vectorize**: index "tiny" is v1 — match objects use `id` in v2 SDKs and `vectorId` in v1; handle both (`vec.id ?? vec.vectorId`). Embeddings persist until explicitly deleted — privacy flips and deletes must call `deleteByIds`.
10. **Secrets live in env/wrangler secrets** — never hardcode. Historical leaks were rotated; don't reintroduce.
11. **Rate limiting** is per-IP (50/day) via Vercel KV — disabled in dev, bypassed for BYOK. Shares have their own 20/day limit.
12. **Verify with the deployed worker, not assumptions** — deploys propagate in seconds but not instantly; retry before diagnosing. **CI green ≠ worker validated:** the worker is a private submodule not checked out in CI, so ~43 worker-gated tests (scheduler/upsert/sql-escape/push-crypto/telegram-authz) SKIP there. Run `npm test` in a worker checkout before shipping worker changes; deploy BOTH envs (`npm run deploy` from the worker dir) and smoke-check live.
13. **Trust-boundary hygiene (the recurring bug class — see SECURITY.md).** Every place external data crosses into a fetch/render/redirect must be guarded, and there are established conventions to match rather than reinvent:
    - **Worker URLs**: `encodeURIComponent` every client/model value in `plugin.tiny.technology/...?name=${x}` — raw `&` injects params on the internal-key channel (impersonation via `userId`). All `get?name=` sites are already encoded; keep it that way.
    - **Request bodies**: `await req.json().catch(() => ({}))` then validate — never a bare `await req.json()` (malformed body → unhandled 500). Every write route does this.
    - **Upstream responses into render**: normalize, don't trust — `sanitizeMessages` (share/localStorage), `normalizeCommunity`/`normalizeProfile` (home/profile). A non-array where `.map()` runs white-screens the page.
    - **Redirects**: `safeReturnPath` (same-origin only; `//host` is protocol-relative → external). Same for any value that reaches `clients.openWindow` / `Location`.
    - **SQL LIKE**: escape `\ % _` + `ESCAPE '\'` when a user string becomes a `LIKE` pattern (else `%` = match-all).
    - **Tool names**: dynamic/forged tool names hit `sanitizeToolName` + `dedupeToolsByName` — the Strands registry THROWS on a bad/duplicate name (retrieved-tiny operationIds are a cross-tenant DoS vector).
    - **SSRF**: `validatePublicUrl` + `redirect:'error'` (or per-hop re-validation) on any fetch of a user/model URL.
    These are pure, unit-tested (`tests/`); when you add a new external-input path, add the guard and a test rather than assuming the input is clean.
14. **Cross-service timeouts must nest, inner < outer.** The worker cron fetches `/api/job-run` with a 60s `AbortSignal.timeout` (`scheduler.ts`); the app's own agent timeout MUST be shorter (currently 50s in `app/api/job-run/route.ts`) so the app always returns a result/timeout the worker can record. If the inner timeout exceeds the outer, the worker aborts first, marks the job FAILED + pushes a "❌ failed" notification even on success, and discards the real result (the CAS already advanced `last_fired_at`, so no re-run). Bumping either side alone silently reintroduces this.
