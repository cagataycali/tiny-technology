# tiny-tech

**tiny.technology for every surface** — an MCP server *and* a full local agent
(Strands SDK) in one npm package. Your tiny identity, **cross-agent memory**,
DMs, forged tools, scheduled jobs — available to any MCP client (Claude Code,
Codex, Kiro, Cursor) or straight from your terminal as a device-embodied AI.

```bash
npx tiny-tech login    # step 1: opens the browser, click Approve
npx tiny-tech connect  # step 2 (optional): Google, Spotify, Telegram, WhatsApp
npx tiny-tech          # TUI in a terminal · MCP server when spawned over stdio
```

Credentials land in `~/.tiny/credentials.json` (0600, 90-day token).

**Step 2 is entirely optional and skippable.** `connect` walks the four apps,
asks before each, and takes "no" for an answer — tiny is fully functional
without any of them, it just can't reach your mail or your music. Say yes and it
sticks: what you give is stored in `~/.tiny/integrations.json` (0600) and applied
as env vars on every run, so a connection works in the next terminal too. Nothing
is a prerequisite for anything else, and one service failing never blocks the
rest of the tour.

```
$ npx tiny-tech connect
  · Google    not connected
  ◐ Spotify   this Mac's Spotify app only — connect for your whole account
  · Telegram  not connected
  ◐ WhatsApp  wacli installed, device not linked — run `wacli auth`

Connect Google? — Gmail, Calendar, Drive, Sheets, Docs, YouTube (use_google) [y/N]
```

`✓` = the tool is live · `◐` = configured but not authorized yet · `·` = absent.
`npx tiny-tech connect <service>` redoes exactly one. Exporting the env vars
yourself still works and always **wins** over the stored value — an explicit
`export` is an override on purpose. Each service needs an app of your own
(Google Cloud console, Spotify dashboard, @BotFather), so your data and your
quota never route through us.

## Two personalities, one package

1. **MCP server** — spawn over stdio from any MCP client → tiny_* tools
2. **Local agent** — run in a terminal → a streaming TUI/REPL with local shell,
   file editing, device control, and the whole tiny.technology platform

## The local agent (TUI / REPL)

```bash
npx tiny-tech            # full-screen TUI (Ink — streaming markdown, tool chips)
npx tiny-tech repl       # plain REPL (pipes-friendly)
npx tiny-tech "one-shot query"
echo "data" | npx tiny-tech repl
```

### TUI features

| Feature | How |
|---|---|
| **Streaming markdown** | Live ANSI rendering while the agent streams — headings, syntax-highlighted code fences, tables; partial markdown (unclosed fences/bold) auto-patched per frame |
| **`/loop` — autonomous mode** | `/loop <task>` (or `/loop` to reuse last query). Fires the next iteration 3s after you stop typing; typing cancels it. Agent stops with `[LOOP_DONE]`, or `/loop`·^C to stop. 100-iteration cap |
| **`!cmd` — shell escape** | Runs locally, output shown *and* injected into the agent's history as a user/assistant exchange — say "fix it" after `!npm test` and it has the full output |
| **↑/↓ history** | Shell-style input recall, persisted to `~/.tiny_history` across sessions |
| **Tab autocomplete** | Ghost suggestion from slash commands + input history |
| **Concurrent-safe input** | Esc clears, double ^C exits |

### Environment embodiment

The agent doesn't start cold — it knows your machine:

- **History context**: merges `~/.tiny_history` + `~/.zsh_history` +
  `~/.bash_history` (+ devduck history if present) into the system prompt —
  recent shell activity and past conversations survive restarts
- **Device tools** (auto-registered only when the backend exists):

| Tool | Backend | Surface |
|---|---|---|
| `use_apple` | osascript + chat.db (macOS) | iMessage send/list, Notes, Reminders, Calendar, Mail, Contacts |
| `use_spotify` | Web API (`SPOTIFY_*`) and/or the Mac app | search, playback, queue, devices, playlists (create/add/remove), library, top tracks/artists, follow |
| `use_google` | OAuth token, service account, or API key | every Google API from its discovery doc — Gmail, Drive, Calendar, Sheets, Docs, YouTube, Tasks, Photos, … |
| `use_adb` | `adb` in PATH | Android: screenshot, tap/swipe/type, launch apps, shell, notifications |
| `use_whatsapp` | `wacli` in PATH | send text/files, chats, messages, search, context, media download, contacts, groups, sync, doctor |
| `use_telegram` | `TELEGRAM_BOT_TOKEN` | send, updates, me |
| `use_computer` | CoreGraphics + `screencapture` (macOS) | screenshot (as a real image), click/drag/scroll, type, hotkeys, open_app |
| `use_browse` | Chrome/Edge/Brave/Chromium over CDP (any OS) | open, text, html, links, click, type, key, scroll, screenshot, eval, back/forward |
| `use_flipper` | Flipper Zero on USB serial | info, storage ls/tree/read/write/send/receive, led, vibro, speaker, ir_tx, subghz_tx, apps, raw cli |

Plus SDK vended tools: `bash`, `fileEditor`, `http_request`.

**`use_computer`** closes the see→act loop: a screenshot comes back as a Strands
`ImageBlock`, not a file path, so the model actually looks at the screen. Shots
are resampled to logical points and mouse actions convert image coordinates to
screen coordinates themselves — the model reads a button off the picture, passes
those numbers, and the click lands there (no Retina math, no region-offset math).
Needs Accessibility + Screen Recording rights for your terminal.

**`use_browse`** is the web as a browser sees it, not as `curl` sees it — a real
Chrome (or Edge/Brave/Chromium, whichever you have) rendering JavaScript, holding
your logins, clicking things. Zero dependencies: Chrome speaks CDP, CDP is JSON,
so it's ~600 lines over a pipe rather than a browser-automation framework that
downloads its own browsers — `npx tiny-tech` stays install-free.

Two decisions worth knowing about. It attaches over `--remote-debugging-pipe`,
never `--remote-debugging-port`: a debugging port is an unauthenticated
full-control channel on localhost, so *any* process on the machine could attach
and read every cookie you have. The pipe rides file descriptors of our own child
process, which makes the parent-child relationship the access control. And it
runs a profile of its own at `~/.tiny/browser`, never your everyday one (Chrome
refuses remote debugging on the default data dir anyway) — but that profile is
*persistent*, so `visible:true` once to log into a site by hand and every later
headless call is still signed in. Rendered text, dialogs auto-dismissed (headless
there's no one to click OK, and one `alert()` wedges a page forever), elements
scrolled into view before a click, and the browser reaped after 5 idle minutes.

**`use_flipper`** speaks the Flipper's text CLI over USB CDC serial with zero
native modules (`stty` + a non-blocking fd), so `npx tiny-tech` stays
install-free. File transfer is chunked with MD5 verification. It only transmits
IR/SubGHz when you ask it to.

**`use_google`** is one tool for all of Google, built from the **discovery
documents**: `service` + `version` + `resource` + `method` + `parameters`, and the
doc itself says where each parameter belongs and what the URL is. Nothing per-API
is hand-written, so nothing goes stale — `action='discover'` lists the resources
and methods of any of the 200+ APIs, then you call them. Credentials, in order:
`~/.tiny/google-token.json` (from `action='login'`, a loopback + PKCE flow) →
`GOOGLE_OAUTH_CREDENTIALS` → `GOOGLE_APPLICATION_CREDENTIALS` (service account,
RS256 JWT signed with `node:crypto` — no `google-auth` needed) → `GOOGLE_API_KEY`
for public APIs. Anything that writes (`send`, `delete`, `insert`, `patch`, …)
needs `confirm=true`, so an outgoing mail gets quoted to you before it leaves.

**`use_spotify`** has two backends and prefers whichever can do the job: the Web
API (`SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`, `action='login'` for the
refresh token) reaches your whole account and any device you own, while the Mac
app via AppleScript needs no credentials at all and covers a Web API call that
fails for want of an active device. Spotify closed `recommendations`,
`audio-features` and the browse endpoints to new apps in Nov 2024 — those report
that, instead of looking like an auth problem.

**`use_whatsapp`** wraps [`wacli`](https://github.com/steipete/wacli), which
speaks the WhatsApp Web protocol against a local SQLite store: reads are instant
and offline, only sends touch the network. Auth stays yours (`wacli auth` needs a
terminal for the QR code). DevDuck's unattended auto-reply listener is
deliberately not ported — an agent answering your contacts on its own is
something you should have to ask for.

### Models — BYO, offline, or zero-config

Auto-detect order: **Bedrock** (AWS creds) → **OpenAI** → **Anthropic** →
**Ollama** (local server running) → **server proxy** (zero-config —
tiny.technology runs the agent for you).

```bash
# Offline local models (the CLI's WebLLM analog — no cloud key needed)
TINY_MODEL_PROVIDER=ollama npx tiny-tech repl          # defaults to qwen3:1.7b
TINY_MODEL_PROVIDER=local TINY_MODEL_ID=qwen3:0.6b ... # 'local'/'webllm' alias

# BYO cloud
TINY_MODEL_PROVIDER=openai|anthropic|bedrock|google|openrouter|groq|deepseek|mistral|xai
TINY_MODEL_API_KEY=... TINY_MODEL_ID=...
```

Ollama rides the OpenAI-compat `/v1` endpoint — qwen3:1.7b handles tool calls
(devices, shell, tiny_* platform) fully offline.

## Zenoh mesh (ON by default)

Every tiny-tech process joins a **devduck-compatible zenoh mesh** on your LAN
(multicast auto-discovery, no config). DevDuck instances and tiny-tech nodes
see each other, exchange presence heartbeats (model, tools, cwd), and can send
each other work — each incoming command runs through a fresh agent and streams
back.

```bash
npx tiny-tech mesh              # headless node — answers peer commands
npx tiny-tech devices           # list enrolled devices w/ presence
npx tiny-tech --no-mesh ...     # opt out (or TINY_MESH=false)

# remote peers across networks
ZENOH_CONNECT=tcp/host:7447 npx tiny-tech mesh
```

Agent-side mesh tools: `mesh_peers`, `mesh_broadcast` (fan-out to the fleet),
`mesh_send` (direct to one peer).

### Persistence (daemon)

```bash
npx tiny-tech daemon install    # launchd (macOS) / systemd --user (Linux)
npx tiny-tech daemon status|logs|restart|uninstall
```

Runs the headless mesh node at login — your machine answers fleet commands
even with no terminal open.

### Talking to a running daemon (`tray`)

Headless means invisible, so the daemon opens a control socket at
`~/.tiny/tray.sock` (mode 0600, override with `TINY_TRAY_SOCK`):

```bash
npx tiny-tech tray status      # device, peers, relay, tasks, tools, senses, log path
npx tiny-tech tray tasks       # background tasks + their state
npx tiny-tech tray ask what happened overnight   # queues a background task, returns its id
npx tiny-tech tray result <id> # that task's answer
npx tiny-tech tray logs 200    # tail the daemon log
npx tiny-tech tray reload      # re-scan ~/.tiny/tools without a restart
```

Newline-delimited JSON, one reply per request line, `protocol` in every reply —
so a menu-bar helper is a small client rather than a second implementation.
The socket lives in `~/.tiny` (0700) and **not** in `/tmp`: `ask` runs a full
agent turn with your account and your integration keys, and file permissions are
the only authentication a Unix socket gives you.

### The menu bar (macOS)

`menubar/` is that small client: a SwiftPM package, no dependencies, that shows
the daemon in the macOS menu bar and speaks the same protocol as `tray` above.

```bash
cd menubar
swift build -c release
./.build/release/tiny-menubar &        # ◐ 2  — glyph + a badge of running tasks
```

The icon states the daemon's condition (`◍` idle, `◐` working, `○` unreachable,
`⊘` version mismatch); the menu carries peers, relay, tools and senses, the
background tasks with their answers, and Ask, Reload tools, Open log, Copy status.

Everything that decides what a user reads lives in `TinyMenuKit`, which imports
no AppKit — so `swift test` covers all of it with no window server, no status
item and no daemon. `menubar/xlang/check.sh` is the other half of that: it runs
the **real** tray server from `dist/` against the **real** Swift client, because
each language's own suite otherwise only ever answers itself.

It runs as an accessory app (no Dock icon), so a plain `swift build` binary is
enough — no bundle, no Info.plist. Not shipped in the npm package: it's macOS
only, and `files` keeps the tarball to `dist`.

## MCP server (the original personality)

```bash
# Claude Code
claude mcp add tiny -- npx -y tiny-tech
```

```jsonc
// .mcp.json (Codex, Kiro, Cursor, any stdio MCP client)
{ "mcpServers": { "tiny": { "command": "npx", "args": ["-y", "tiny-tech"] } } }
```

```ts
// Strands (TypeScript)
new McpClient({ command: 'npx', args: ['-y', 'tiny-tech'] })
```

### What your MCP client gets

| Tool | What it does |
|---|---|
| `tiny_learn` / `tiny_recall` / `tiny_memories` / `tiny_unlearn` | **Cross-agent memory** — durable facts stored server-side (D1 + semantic search), shared between the tiny web app, telegram bots, and every MCP session |
| `tiny_chat` | Talk to any tiny — the persona runs server-side with its full toolset (web access, sub-agents, scheduling, retrieval, your forged tools). Attach local images/PDFs/docs via `files` |
| `tiny_events` | Your activity feed — job results, telegram messages, share views |
| `tiny_send_message` / `tiny_messages` / `tiny_delete_message` | **Direct messages** — DM any tiny.technology user by @login or tiny slug; delivered to their 💬 inbox, push, and Telegram |
| `tiny_search` / `tiny_get` | Discover tinys in the public universe |
| `tiny_create` / `tiny_update` / `tiny_delete` | Manage your AI personas — `tiny_update` also sets branding: logo, hero, theme colors, tagline, intro haptic, starter chips |
| `tiny_graph` / `tiny_resolve_conflict` / `tiny_follow` | **Memory graph + social** — explore fact links, resolve contradictions, follow builders (their public facts land in your feed) |
| `tiny_wallet` | **USDC wallet** — balance/history, deposit info, price your tinys, claim on-chain deposits (withdrawals stay web-only) |
| `tiny_pay_quote` / `tiny_pay_confirm` | **x402 payer, confirm-every-payment** — quote never moves money; confirm executes only the exact quote you approved (session/message/expiry/nonce-bound) |
| `tiny_devices` | Your enrolled devices — list presence, revoke a device token |
| `tiny_model_config` | Cross-device BYO model config — the stored API key is never returned |
| `tiny_archives` | Cloud session archives — save (server-side credential redaction), restore anywhere, delete |
| `tiny_create_tool` / `my_*` / `tiny_reload_tools` / `tiny_remove_tool` | **Tool forge** — persist small JS tools in your account; they mount as first-class MCP tools here AND in web chat |
| `tiny_marketplace` | Browse/install community tools |
| `tiny_schedule` | Cron jobs that run server-side while your laptop sleeps |
| `tiny_share` | Publish a conversation snapshot as a short link; list + revoke your links |
| `tiny_whoami` / `tiny_login` | Identity + in-session browser auth |

Plus the `tiny-context` MCP prompt: your recent memories formatted for
injection at session start.

And **MCP resources** — browsable context your client can attach without a
tool call (Claude Desktop's paperclip, Claude Code `@`-mentions):

- `tiny://me` — your identity + owned tinys
- `tiny://memories` — your recent cross-agent memory, as a readable doc
- `tiny://tiny/<name>` — the full record of each tiny you own (auto-listed)

The local agent mounts all of the above too — same identity, same memory,
every surface.

## CLI

```
npx tiny-tech            # TUI in a terminal; MCP server when spawned over stdio
npx tiny-tech serve      # force the MCP server on stdio
npx tiny-tech tui        # full-screen agent UI (Ink)
npx tiny-tech repl       # plain interactive agent session
npx tiny-tech mesh       # headless zenoh mesh node
npx tiny-tech daemon …   # install|status|logs|restart|uninstall|show
npx tiny-tech tray …     # status|tasks|ask|result|cancel|logs|reload|ping
tiny-menubar             # the same, in the macOS menu bar (see menubar/)
npx tiny-tech "query"    # one-shot agent query
npx tiny-tech login      # browser auth
npx tiny-tech connect    # connect apps (optional) — or connect <google|spotify|telegram|whatsapp>
npx tiny-tech logout     # remove credentials + device identity
npx tiny-tech whoami     # identity + your tinys
npx tiny-tech devices    # enrolled devices w/ presence
```

## Env

`npx tiny-tech connect` writes the app-connection vars for you; setting them
here by hand is the alternative, and it overrides the stored value.

| Var | Purpose |
|---|---|
| `TINY_TOKEN` | Bearer token — skips the credentials file (CI/headless) |
| `TINY_API_URL` | Override `https://tiny.technology` |
| `TINY_HOME` | Credentials + connections dir (default `~/.tiny`) |
| `TINY_TRAY_SOCK` | Daemon control socket (default `~/.tiny/tray.sock`, mode 0600) — read by `tray`, the daemon and `tiny-menubar` alike |
| `TINY_BROWSER_BIN` | Which browser `use_browse` drives — exclusive, no fallback (else Chrome/Chromium/Edge/Brave, in that order) |
| `TINY_BROWSER_PROFILE` | `use_browse` profile dir (default `~/.tiny/browser`) — never your everyday Chrome profile |
| `TINY_MODEL_PROVIDER` / `TINY_MODEL_API_KEY` / `TINY_MODEL_ID` / `TINY_MODEL_BASE_URL` | BYO model — `openai`, `anthropic`, `bedrock`, `google`, `ollama`/`local`, `openrouter`, `groq`, `deepseek`, `mistral`, `xai`, or any OpenAI-compatible base URL |
| `OLLAMA_HOST` / `OLLAMA_MODEL_ID` | Local model server override (default `http://localhost:11434`, `qwen3:1.7b`) |
| `TINY_MESH` | `false` = disable the zenoh mesh (default: enabled) |
| `ZENOH_CONNECT` / `ZENOH_LISTEN` | Remote mesh endpoints, e.g. `tcp/host:7447` |
| `TELEGRAM_BOT_TOKEN` | Enables the `use_telegram` device tool |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Spotify Web API app — enables the account-wide `use_spotify` backend |
| `SPOTIFY_REDIRECT_URI` | Must match your Spotify dashboard entry exactly (default `http://127.0.0.1:8888/callback`) |
| `GOOGLE_OAUTH_CLIENT` | Desktop-app `client_secret_*.json` — needed for `use_google action='login'` |
| `GOOGLE_OAUTH_CREDENTIALS` | Path to an existing OAuth token JSON to reuse instead of running `action='login'` |
| `GOOGLE_API_SCOPES` | Comma-separated scope override for a fresh Google login |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service-account key JSON — `use_google` without a browser (`GOOGLE_IMPERSONATE_SUBJECT` for domain-wide delegation) |
| `GOOGLE_API_KEY` | Public Google APIs only (no user data) |
| `WACLI_BINARY` / `WACLI_STORE` | `wacli` path and store dir for `use_whatsapp` |
| `TINY_NO_BROWSER` | Don't auto-open the login URL (print it instead) |

## Security notes

- The token is a user-scoped JWT accepted by tiny.technology's session-gated
  API — treat `~/.tiny/credentials.json` like a logged-in browser.
- Forged tools always execute in tiny's server-side sandbox (SSRF-guarded
  fetch, 10s/20KB limits) — never locally.
- The **local agent** is different: it intentionally has local power (bash,
  file editing, device control). `!cmd` and agent tool calls run on YOUR
  machine with YOUR permissions — that's the point of embodiment.
- The mesh answers peer commands with a full agent. It's LAN-multicast by
  default; anyone on your network segment (or `ZENOH_CONNECT` remote) can send
  work to your node. Use `--no-mesh` on untrusted networks.
- Authorization requires an explicit Approve click on tiny.technology; codes
  are single-use, 5-minute, loopback-only.
