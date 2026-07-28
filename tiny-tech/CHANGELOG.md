# Changelog

## 0.8.0

### Added
- **`npx tiny-tech connect` — a second, skippable onboarding step.** Step 1 (`login`) is identity; step 2 is reach: Google, Spotify, Telegram, WhatsApp. Until now those tools were reachable only by exporting env vars in your shell, which meant they silently didn't exist for anyone who never read the README. `connect` walks the services that aren't ready, asks before each, and takes "no" for an answer — nothing here is a prerequisite, one service failing never abandons the rest of the tour, and a blank answer at any prompt leaves the store untouched rather than half-written. Answers persist to `~/.tiny/integrations.json` (0600, same posture as `credentials.json`) and are applied as env vars at startup, so a connection survives the terminal it was made in. A real `export` always wins over the stored value — someone setting `SPOTIFY_CLIENT_ID` for one run is overriding on purpose. `connect <service>` redoes exactly one, and every service's status prints as `✓` live / `◐` configured-but-not-authorized / `·` absent, alongside what connecting unlocks. `login` now ends with a one-line, ignorable hint naming what's still unconnected. Telegram tokens are verified against `getMe` before being stored, so a typo fails at the prompt rather than much later inside a tool call looking like a Telegram outage; WhatsApp hands the terminal to `wacli auth` since the QR needs a real TTY.
- **`use_google`** — every Google API, from the discovery documents. `service` + `version` + `resource` + `method` + `parameters`, and Google's own discovery doc supplies the URL, the HTTP verb, and where each parameter belongs, so Gmail/Drive/Calendar/Sheets/Docs/YouTube/Tasks/Photos and the other ~200 APIs work with nothing per-API hand-written and nothing to keep in sync. `action='discover'` lists the resources and methods an API actually has, which is what lets a model find `users.messages.list` instead of guessing at it — a wrong resource or method name comes back with the real siblings named. Ports `strands_google`'s `use_google.py` without its pip dependencies: `googleapiclient` becomes `fetch` + discovery, and `google-auth`'s service-account flow becomes an RS256 JWT assertion signed with `node:crypto`, so `npx tiny-tech` stays install-free. Credentials in precedence order: `~/.tiny/google-token.json` (from `action='login'` — loopback + PKCE, any ephemeral port) → `GOOGLE_OAUTH_CREDENTIALS` → `GOOGLE_APPLICATION_CREDENTIALS` (service account, `GOOGLE_IMPERSONATE_SUBJECT` for domain-wide delegation) → `GOOGLE_API_KEY` for public APIs. Mutative methods (`send`, `delete`, `insert`, `patch`, `trash`, …) refuse to run without `confirm=true` and say what they would do, so the user sees an outgoing mail before it leaves. `action='send_email'` skips hand-rolled base64url MIME, and `action='auth'` reports which credential actually answered.
- **`use_spotify` grows from 7 actions to the real API** — search (all types), full playback control (play/pause/next/previous/seek/volume/shuffle/repeat), queue add+list, device list and transfer, playlists (list/tracks/create/add/remove), library (saved tracks/albums, save/unsave), top tracks and artists over three time ranges, recently played, follow/unfollow, and album/artist/track lookup. Two backends: the Web API (`SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`, `action='login'` for a refresh token) reaches the whole account and any device the user owns, and the Mac app over AppleScript still works with no credentials at all. Ports `spotipy`'s refresh-token grant over plain `fetch`, and reads spotipy's own token cache when it's there.
- **`use_whatsapp` grows from 5 actions to the whole `wacli` surface** — send text and files, chats list/show, messages list/search/show/context, media download, contacts search/show/refresh, groups list/info/rename/refresh, one-shot `sync`, `history_backfill`, and `doctor`. Everything runs through `--json`, so the model gets JIDs, message ids and timestamps rather than a rendered table it has to re-parse, and argv arrays go to `execFileSync` with no shell — message text is arbitrary user content, and a quoted string in a shell command line is one backtick from being executed. DevDuck's auto-reply listener is deliberately **not** ported: an agent answering the user's real contacts unattended should be an explicit request, not a side effect of the tool existing.
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` join `GOOGLE_OAUTH_CLIENT` — the pair works on its own, for people who paste the two strings rather than the downloaded JSON.
- 76 tests covering the parts that decide what gets sent — path-vs-query parameter placement, `{+reserved}` expansion, the confirm gate, JWT claims, Gmail encoded-word subjects, Spotify id/URI coercion and formatters, WhatsApp JID coercion and every `wacli` argv. Network- and hardware-free, so CI covers them with no Google account, no Spotify subscription and no linked device.

### Fixed (found by testing against the live APIs, not by reading the Python originals)
- **A dead Google refresh token stranded a machine that also had a working service account.** The OAuth failure was terminal instead of falling through, so a valid service-account key sat unused. Now it falls through, and `action='auth'` names the credential that actually produced the token rather than the preferred one — otherwise it reports `oauth` while a service-account identity is doing the work.
- **`use_google` errors surfaced as unhandled rejections.** `return callGoogle(...)` inside a `try` returns the promise before it can reject, so the surrounding `catch` never saw the failure; now `return await`.
- **Spotify playlists all rendered "? tracks".** `/me/playlists` puts the count at `items.total`, not the `tracks.total` the docs imply. Reads both.
- **`recommendations`, `audio-features`, `audio-analysis`, the browse endpoints and artist top-tracks/related-artists all failed like an auth problem.** Spotify closed them to standard-quota apps in Nov 2024; 403/404 arrives regardless of scope. They now say exactly that, and `artist` degrades to the parts that still work instead of failing whole.
- **`wacli` reports failures in its JSON envelope on stdout and still exits 0**, so a dropped send read as a success. The envelope is now checked on success too, and a websocket drop says the message was *not* sent.

## 0.7.0

### Added
- **`use_computer`** — this Mac's screen, mouse and keyboard, so the agent can look at the screen and act on what it sees. Screenshots return a real Strands `ImageBlock` (actual image content, not a file path the model has to trust), which is what makes the look → click → verify loop work. Screenshots are resampled to logical points and mouse actions convert screenshot coordinates to screen coordinates themselves, so a model reads a button off the picture, passes those numbers back, and the click lands there — no Retina math, no region-offset math, for full-screen and region shots alike. Actions: `screenshot`, `screen_size`, `mouse_position`, `click`/`double_click`/`right_click`/`middle_click`, `move_mouse`, `drag`, `scroll`, `type`, `key`, `hotkey`, `open_app`, `front_app`. Needs Accessibility + Screen Recording rights for the host terminal; a denial is reported as the actionable System Settings path instead of a silent no-op.
- **`use_flipper`** — a Flipper Zero over USB serial, with **zero native modules** (`stty` to condition the line, then a non-blocking `fs` fd), so `npx tiny-tech` stays install-free. Actions: device/power/uptime info, `storage` ls/tree/read/write/send/receive/mkdir/rm/stat/md5/df, `led`, `vibro`, `speaker`, `alert`, `ir_tx`, `subghz_tx`, `nfc_detect`, app list/start, `bt_info`, and raw `cli` passthrough. File transfer is chunked with MD5 verification; IR/SubGHz only transmit when explicitly asked.

Both self-register only when the backend exists, like the other device tools — `use_flipper` appears exactly when a Flipper is on a serial port.

### Fixed (found by testing against real hardware, not by reading the Python original)
- **Every click and mouse move landed at 0,0.** JXA's `ObjC.bindFunction` accepts the bare `{CGPoint=dd}` struct encoding without error and then marshals every coordinate as zero. Field names are mandatory (`{CGPoint="x"d"y"d}`), for arguments *and* returns — the same fix makes `mouse_position` return real coordinates instead of `NaN` (verified against an independent reader).
- **Typing did nothing.** JXA rejects `Ref('uint16[1]')` for `CGEventKeyboardSetUnicodeString`; the buffer has to come from `NSString → dataUsingEncoding(10)` (UTF16-LE) → `.bytes`. Now types the whole string in one event, with accents and emoji intact, and length in UTF-16 code units so surrogate pairs work.
- **A modified keystroke left its modifier latched**, so the next plain `tab` arrived as Cmd+Tab and silently switched apps mid-sequence — the rest of a form got typed into another application. Modified keystrokes now press and release the real modifier keys, and `type` clears modifiers first.
- **`scroll` used pixel units**, making `amount: 10` scroll ten pixels and read as "scroll silently did nothing". Now uses line units, so `amount` is wheel clicks.
- Flipper protocol bugs the Python original doesn't have to handle: an async boot banner desynced every command from its response (fixed with a quiet-period drain); an 8 KB chunk write hit `EAGAIN` on a non-blocking tty and wedged the device CLI (fixed with a backpressure-aware write loop); and `storage write_chunk` **appends** rather than truncates, so re-sending a file doubled it (fixed by removing first). A 20 KB round-trip is now byte-identical and idempotent, with the Flipper's MD5 matching the local one.

## 0.6.6

### Added
- **MCP resources** — the server now exposes browsable context alongside its tools, so MCP hosts (Claude Desktop's attach picker, Claude Code `@`-mentions) can pull tiny context in without the model first guessing to call a tool:
  - `tiny://me` — your identity + owned tinys (JSON).
  - `tiny://memories` — your recent cross-agent memory as a readable Markdown doc.
  - `tiny://tiny/{name}` — a dynamic template; the list callback enumerates every tiny you own, each readable as its full record. Same authed data path as `tiny_whoami` / `tiny_memories` / `tiny_get`; logged-out reads return a login hint instead of crashing the client's resource pane.

## 0.6.5

### Added
- Local REPL agent gains read-only `tiny_wallet` + quote-only `tiny_pay_quote`; a posture test asserts `tiny_pay_confirm` is never mounted locally.

### Changed
- Docs catch-up: README tool table + CHANGELOG.

## 0.6.4

### Added
- **`tiny_devices`** — list enrolled devices (presence, last-seen), revoke a device token.
- **`tiny_model_config`** — cross-device BYO model config; `get` never returns the stored API key (`hasKey` only), `set` preserves it unless `apiKey` is explicitly included.
- **`tiny_archives`** — cloud session archives: list/get/save/delete (server redacts credentials on save).

### Fixed (platform, found by this release's live E2E)
- Cloud-archive saves 500d in production: `"use client"` on the shared archive module turned `buildArchive` into a client-reference stub inside the edge route. Fixed backend-side.

## 0.6.3

### Added
- **`tiny_wallet`** — balance/history, deposit info, resource pricing, `set_price`, on-chain deposit claims. Withdrawals + payout-address changes deliberately stay web-only.
- **`tiny_pay_quote` / `tiny_pay_confirm`** — x402 payer with the confirm-every-payment split: quoting never moves money; confirm executes only a valid, session/message/expiry/nonce-bound quote after the user's explicit approval.

### Changed
- Local REPL agent's `tiny_recall` aligned to the MCP query contract (semantic `relevant` matches + `hops`).
- Honest labels: undated shell-history entries no longer claim to be "recent"; `tiny_chat` lists its real attachment format support.

## 0.6.2

### Added
- **Branding in `tiny_update`** — `logo`, `hero`, `theme`, `tagline`, `intro_vibe`, `chips` (omitted = preserved, `''`/`[]` clears).

### Fixed
- MCP handshake reported a hardcoded `0.2.0` — now reads the real package version.
- Every MCP host on every machine shared ONE server-side ring context: the session id now carries a per-install suffix (device id, or per-process nonce).
- Local REPL agent's `tiny_learn` sent `supersedes` as a scalar the backend silently dropped — now wrapped in the required array.
- `tiny_delete` gained the soft-failure check every other destructive tool had.

## 0.1.3

Overnight hardening pass — every change verified live against production.

### Fixed
- **`tiny_login` recovery dead-end**: a server-rejected token (revoked,
  secret rotation) passed the local expiry check, so login claimed
  "already logged in" while every other tool 401'd. Now verified against
  `/api/me` with fall-through to a fresh browser login.
- **`tiny_create` slug echo**: creating "My Cool AI" echoed the raw name
  while the platform stored `my-cool-ai` — callers couldn't address the
  tiny they just created. The API now echoes the stored slug.
- **`tiny_remove_tool` phantom success**: deleting a nonexistent tool
  returned ok. Now a 404 with the tool name (platform-side fix).
- **`tiny_marketplace` browse without query**: empty `q=` param was
  rejected by the platform validator; now omitted.
- **Binary attachment leak**: extensionless binaries (e.g. `/bin/ls`)
  were shipped to the model as "text". Null-byte sniff rejects them.
- **`tiny_get` on missing/private tinys**: returned a confusing blank
  record; now an actionable error suggesting `tiny_search`.
- **`TINY_API_URL` precedence**: the env override lost to the stored
  credentials' apiUrl.
- **Node 18 compatibility** in the test harness.

### Hardened
- Login callback server: malformed requests can't crash the MCP process,
  timers cleaned up, timeout errors include the auth URL for
  headless/SSH users to finish manually.
- `tiny_chat` mid-stream timeout returns partial text + a clear warning
  instead of a raw AbortError.
- HTML gateway error pages render as "transient gateway error — retry"
  instead of markup dumps.

### Added
- **MCP annotations on all tools** (readOnly/destructive/idempotent/
  openWorld hints) so clients can gate confirmations correctly.
- **`tiny_create_tool` name validation client-side** (snake_case,
  3-40 chars via zod) — instant, precise rejection instead of a proxied
  server error. (Platform fix landed too: worker-proxy errors no longer
  use 502, whose bodies Cloudflare replaces with its own error page.)
- **24-case test suite** (`npm test`, node:test, zero deps): attachment
  classification, credential store (0600 perms), callback-server abuse,
  full stdio protocol smoke. Gates `npm publish` via prepublishOnly.
- **Live e2e suite** (`npm run test:live`): 21 opt-in, self-cleaning
  production checks — memory/tiny/forge lifecycles, validation
  precision, attachment fidelity, feeds.
- **CI**: GitHub Actions on Node 18/20/22.

## 0.1.2

- `tiny_unlearn` surfaces 404s for bogus ids (paired platform fix:
  learnings DELETE reports the true deleted count).

## 0.1.1

- **`tiny_update` no longer wipes config**: the platform's update
  overwrites the whole record, so untouched fields (data, skills,
  webhooks, MCP servers) are now re-sent from the current record.
- `tiny_events`: activity feed (job results, telegram, share views)
  with `since_id` incremental polling.
- `tiny_share`: list + revoke actions alongside create.
- `tiny_chat` local file attachments (images/PDFs/docs/text) via
  `files[]` — 3MB/file, 3.5MB combined.
- `tiny_create_tool` forges directly through the sandbox-validated API
  instead of chat-agent indirection.

## 0.1.0

Initial release: browser loopback auth, cross-agent memory
(learn/recall/unlearn), tiny_chat with the full server-side toolset,
persona management, dynamic `my_*` forged tools, marketplace, scheduled
jobs, sharing, `tiny-context` prompt.
