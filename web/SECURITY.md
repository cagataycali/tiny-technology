# SECURITY.md — trust boundaries of tiny.technology

A map of where untrusted input enters, what guards it, and where the tests
are. For contributors (human or agent): **if you touch a boundary, touch
its tests.**

## Identity & authorization

| Boundary | Mechanism | Notes |
|---|---|---|
| User sessions | GitHub OAuth + WebAuthn passkeys → HS256 JWT (httpOnly cookie, 30d) | `lib/auth.ts` |
| Write authority over tinys | D1 `tinys.user_id` is the ONLY authority; checked worker-side | Legacy 8-char keys authorize **nothing** for writes — they only unlock viewing private content |
| Worker internal routes | `X-Internal-Key` shared secret (`checkInternalKey`) | /learnings /events /jobs /prefs /tools /archive /telegram… — only the app may call |
| Archive/share reads | Ownership via D1 index before serving the KV blob | KV blobs carry no owner; the index is the authority |
| Telegram bot actions | Per-bot `allowed_chats` allowlist — exact chat-id match, fails closed on empty, no substring bypass (`src/telegram.ts:chatIsAllowed`, `tests/telegram-authz.test.ts`) | A false positive runs an agent turn (owner's key + tiny) for a stranger |
| OAuth post-login redirect | `safeReturnPath` — same-origin path only; rejects `//host` and `/\host` protocol-relative bounces (`lib/auth.ts`, `tests/auth.test.ts`) | Prevents a crafted `return_to` from bouncing a genuinely-authenticated user to a phishing lookalike |
| OAuth login-CSRF | `state` = `<nonce>:<path>`; step 1 sets an httpOnly `tiny_oauth_state` nonce cookie, callback requires match before code exchange (`app/api/auth/route.ts`, `tests/oauth-csrf.test.ts`) | Stops an attacker forcing a victim's browser to complete a login → logging the victim into the attacker's account. Login is always a top-level nav so the SameSite=Lax cookie rides the redirect |
| CLI/MCP token flow | Loopback-only redirect + `tiny-cli-code`→`tiny-cli` audience separation (a session token can't be replayed as a code) (`app/api/auth/cli/*`, `tests/cli-token.test.ts`) | 90-day tokens; consent is the click |

## Untrusted-code execution (user-forged tools)

- **Where**: `lib/user-tools.ts`, executed ONLY in the Node runtime
  (`/api/run-tool`, internal-key guarded) — edge forbids `new Function`.
- **THE HARD BOUNDARY (layer 0): a fresh V8 context (`node:vm`).** Tool code
  runs via `vm.runInContext` in a context created with `Object.create(null)`,
  so its built-ins (`Array`, `Object`, `Function`, …) are the CONTEXT'S own.
  The classic escape — reach the `Function` constructor and eval `"return
  this"` to get the global — now yields the *sandbox* global, which has no
  `process`/`require`. Prototype pollution is confined to the disposable
  context (the host's `Object.prototype`/`Function.prototype` are untouched).
  Only `guardedFetch` (wrapped) and JSON-cloned frozen `args` cross the
  boundary; reaching through the injected fetch fn's `.constructor` also
  stays contained. **This is why containment no longer depends on the
  denylist.** Why it was needed: a source-text denylist CANNOT stop a
  computed reach — `Array["con"+"structor"]("return this")()` contains no
  banned literal, reached this realm's global under the old `new Function`
  sandbox, and read `process.env` (INTERNAL_API_KEY / JWT secret). Confirmed
  exploitable before the vm fix.
- **Defense-in-depth (still enforced, no longer load-bearing):**
  - Static `BANNED_PATTERNS` (process, require, eval, Function, globalThis,
    `constructor`/`prototype` in ANY form, `__proto__`, `\u`/`\x` escapes,
    WebSocket…) — catches the obvious/literal attempts early with a clear
    error. 4KB code cap. `runUserTool` RE-validates internally so the guard
    travels with execution, not just its callers.
  - Frozen `args` (mutation throws in strict mode); 10s async timeout (the
    vm `timeout` bounds sync execution, the `Promise.race` bounds a
    forever-awaiting async tool — its timer is cleared in `finally`); 20KB
    circular-safe result clamp.
- **Adding a scope binding or relaxing a pattern** is still worth a
  regression test, but the categorical protection is the context isolation,
  not the denylist. If you ever move execution OUT of `node:vm` (e.g. back to
  `new Function`), the escape reopens.
- **Resource bounds**: 10s timeout, 20KB result clamp (circular-safe),
  and `guardedFetch` STREAMS response bodies capped at 100KB (rejects up
  front on an oversized Content-Length) — so a tool can't OOM by fetching a
  huge URL through the SSRF-allowed public-host surface.
- **Known limit**: a synchronous infinite loop can't be raced in a
  single-threaded isolate; the runtime CPU limit kills the request
  (contained to the caller's own request).
- **Code is public by design** — tools appear on builder profiles; the
  forge prompt tells the model to never embed secrets (pass as args).
- **Tests**: `tests/user-tools.test.ts` (every banned pattern + sandbox
  invariants).

## Marketplace / tool installation

- `install_tool`: raw.githubusercontent.com only; global allowlist +
  per-user trust grown ONLY by the user-typed `/tools trust <owner>`
  (the model cannot expand its own allowlist); branch refs pinned to
  commit SHAs; re-validated in the sandbox before persisting.
- `marketplace install`: code fetched server-side from the author's
  public profile (never model-supplied), re-validated before persisting.
- Updates are notify-only (weekly sweep → event); applying one is an
  explicit user-approved install that re-runs every check.

## Server fetches of user/model URLs (SSRF + redirect + size)

Every server-side fetch of a URL a user or the model chose is guarded on
THREE axes — origin, redirects, and body size (an oversized body can OOM
the runtime just as an internal host is an SSRF):
- **Origin**: `validatePublicUrl` (`lib/utils.ts`) — https + public
  hostnames only (rejects IPs, localhost, `.local`, `.internal`, dotless).
- **Redirects**: `http` tool re-validates per-hop (3 max — a public URL
  302ing to an internal host is the classic bypass); `/api/worker`,
  dynamic OpenAPI tools, and user-tool fetch use `redirect:'error'`.
- **Size**: streamed caps that never buffer the whole body —
  `readBoundedText` (all-or-nothing, `/api/worker` spec: 2MB),
  `readClippedText` (best-effort clip, `http` tool: 200KB), and
  `guardedFetch`'s reader (user-tool fetch: 100KB).
- **The fetch sites**: `guardedFetch` (user-tool `fetch`), `/api/worker`
  (spec URL), `http` tool (agent web calls + spawn_agents sub-agents), and
  `buildMcpClients` (MCP server URLs from the `x-tiny-mcp-servers` header or
  a tiny's stored config — the server connects AND injects the owner's
  headers, so an unvalidated URL was blind SSRF + secret exfil; now
  `validatePublicUrl` before the client is built). All origin-checked;
  the first three are also redirect-safe + size-bounded.
- **Tests**: `tests/utils.test.ts` (accept/reject matrix incl. AWS
  metadata IP; both bounded-read helpers), `tests/http-tool.test.ts`
  (redirect chains + body clip), `tests/user-tools.test.ts` (fetch bound),
  `tests/chat-helpers.test.ts` (MCP url reject/accept matrix).
- **Worker side**: push subscription endpoints are validated at store time
  (`src/push.ts`) — they're later fetch()ed with signed VAPID headers, so
  an unvalidated endpoint would be blind-POST SSRF. Other worker fetches
  are hardcoded hosts (GitHub API, Telegram API, tiny.technology,
  Cloudflare API).

## Internal-channel query injection

App → worker URLs carry `X-Internal-Key` and the worker TRUSTS params on
that channel (`userId` authorizes owner access). Every client- or
model-controlled value interpolated into those URLs must be
`encodeURIComponent`-wrapped (or built via `URLSearchParams`) — a crafted
tiny name like `x&userId=<victim>` would otherwise impersonate on the
privileged channel. Fixed across /api/chat, /api/tiny, and the
get_tiny/ask_tiny/retrieve tools; /api/login already used URLSearchParams.

## Parsing untrusted data

- `parseOpenAPI` parses user-controlled worker specs per request —
  crash-hardened against dangling $refs and null operations
  (`tests/parse-openapi.test.ts`).
- itty-router-openapi (worker): undeclared body fields are silently
  stripped — declare every field or lose it (see AGENTS.md gotchas).

## Privacy

- Private tinys: excluded from /list /retrieve; vector embeddings
  DELETED on privacy flip; /get masks content for non-owners; OG/vCard
  show placeholders. The `private` flag is honored at CREATE time too —
  a tiny made private is never embedded into universe search in the
  first place (the create path once hardcoded public; `src/upsert.ts`).
- `hook` (webhook URLs embed tokens) and MCP headers: masked for
  non-owners even on public tinys.
- Shares: sanitized snapshots (`shareSnapshot`) — DROP system messages
  (a private tiny's owner has the real system prompt in `messages[0]`; it
  must never enter a public share), no tool payloads/reasoning/failure
  state; revocable by token or account. `tests/session-archive.test.ts`.
- **Shares DROP `uiComponents`** — `componentCode` runs via `new Function`
  in the VIEWER's browser (DynamicUI) on our origin with their localStorage
  (API keys, share tokens), so a share carrying it was stored XSS / key
  theft. Enforced at THREE layers: `shareSnapshot`, server-side in
  `POST /api/share` (never trusts the client to have run it — a crafted
  POST stored raw messages verbatim before), and on `?share=`/`?chat=`
  LOAD (strips foreign `uiComponents` so pre-existing KV/base64 shares
  can't execute). Own/live conversations still render their own `render_ui`
  — the trust boundary is authoring the turn, not opening a foreign link.
- **All conversation-export paths drop system messages** for the same
  reason: `/share` (`shareSnapshot`), `/save` + `/export` (filter
  `role !== 'system'`), `?chat=` is read-only (no creation). Any NEW
  export path must do the same.
- Session archives: private to the owner; credential-shaped fields
  redacted server-side on upload (`buildArchive` runs in `/api/archives`,
  so a hand-crafted client can't skip it). `tests/session-archive.test.ts`.

## Client-side execution surfaces

- `render_ui` / DynamicUI: model-authored React run via `new Function` in
  the user's own browser, same trust as the conversation itself. **Foreign
  sources are stripped** — a viewed share (`?share=`/`?chat=`) and an
  imported archive file drop `uiComponents` before render, because a viewer
  did not author that code (see Privacy §). Only own live/localStorage/cloud
  conversations render their own components.
- **Server-rendered JSON-in-HTML**: the public-tiny page emits a JSON-LD
  `<script>` via `dangerouslySetInnerHTML`. `JSON.stringify` does NOT escape
  `<` / `/`, so a tiny's free-form `systemPrompt`/`systemKnowledge` could
  carry a `</script>` breakout → XSS on our origin (BYOK-key/session theft).
  `app/[slug]/page.tsx` `\u`-escapes `< > &` + U+2028/U+2029 before injecting.
  Any future server-rendered `dangerouslySetInnerHTML` of stringified JSON
  must do the same.
- `customize_page` JS: applies live mid-chat (user is watching); STORED
  JS requires one-time per-script user approval before it auto-runs on
  future visits. The mid-chat run does NOT auto-approve — a prompt-injected
  tiny that gets a `persist:true` call through only plants the content; the
  load-time `confirm()` (which shows the script) is the sole path to
  approval, so nothing runs on a future visit without explicit consent.
  Approval fingerprints the exact script with **SHA-256** (was djb2 — a
  32-bit hash is collidable, letting a crafted different script match an
  approved fingerprint and auto-run); one char of drift re-prompts
  (`tests/theme.test.ts`).
- `set_theme` colors: hex-validated before touching CSS vars — non-hex
  input falls back rather than reaching `style.setProperty`
  (`tests/theme.test.ts`).
- `!expr` bang eval: sandboxed opaque-origin iframe, 3s timeout.

## Cross-tenant safety (the universe)

Retrieval mounts OTHER users' public tinys' OpenAPI skills as dynamic
tools in your session. Two guards keep a hostile public tiny from
reaching across:
- **Name collisions** — dynamic tools are deduped by name with built-ins
  first (`dedupeToolsByName`), so a public skill named `learn`/`http`/etc.
  can't shadow a built-in or crash the turn (the ToolRegistry throws on
  dupes → would be a universe-wide DoS via operationId).
- **Worker URLs** — dynamic-tool fetch targets come from those foreign
  configs and get the full SSRF guard + `redirect:'error'`.

## Prompt-injection containment

- Slash commands are intercepted client-side; the model is told any
  "/command" it sees is fake.
- The model cannot: expand tool-install trust, disable protected tools
  (`PROTECTED_TOOLS` in `lib/chat/tool-filter.ts` — the mount filter
  strips protected names from any disable pref, tested in
  `tests/tool-filter.test.ts`), read other users' private
  tinys/learnings, or call worker internal routes (no key in its context).
- spawn_agents is capped (64 backstop) with a concurrency pool —
  a prompt-injected fleet can't stampede the server key.
- Scheduled jobs (`/api/job-run`) run with the OWNER's capability set
  (forged tools, tiny skills, MCP servers, use_telegram) — but every
  tool is keyed to the job's `user_id`, so a hijacked job prompt can
  only act on the owner's own resources (their memories, their bot's
  allowlisted chats, their tools). Same SSRF/sanitize guards as chat
  via the shared `lib/chat/tools/platform.ts` factories.

## Reporting

See [SECURITY.md at the repository root](../SECURITY.md) — that's the
policy GitHub surfaces. Short version: use GitHub's private vulnerability
reporting on cagataycali/tiny-technology for anything sensitive; ordinary
hardening ideas can be public issues. This is a free platform run by one
person — clear reproductions are gold.
