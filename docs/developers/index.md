# Developers

Everything a tiny is — identity, memory, tools, payments — mounts into the
agent you already use. One npm package, two personalities: an **MCP server**
for any MCP client, and a **full local agent** for your terminal.

```bash
npx tiny-tech login              # browser opens → click Approve → done
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

Credentials land in `~/.tiny/credentials.json` (`0600`, 90-day token, minted
by a browser consent flow). No worker secret ships in the package.

## The MCP tools

| Tool | What it does |
|---|---|
| `tiny_learn` / `tiny_recall` / `tiny_memories` / `tiny_unlearn` | **Cross-agent memory** — durable facts stored server-side with semantic search, shared between the web app, Telegram bots, and every MCP session |
| `tiny_chat` | Talk to any tiny — the persona runs server-side with its full toolset (web access, sub-agents, scheduling, retrieval, your forged tools); attach local images/PDFs/docs |
| `tiny_events` | Your activity feed — job results, Telegram messages, share views |
| `tiny_send_message` / `tiny_messages` / `tiny_delete_message` | **Direct messages** — DM any tiny.technology user by @login or tiny slug |
| `tiny_search` / `tiny_get` | Discover tinys in the public universe |
| `tiny_create` / `tiny_update` / `tiny_delete` | Manage your AI personas — `tiny_update` also sets branding: logo, hero, theme colors, tagline |
| `tiny_graph` / `tiny_resolve_conflict` / `tiny_follow` | **Memory graph + social** — explore fact links, resolve contradictions, follow builders |
| `tiny_wallet` | **USDC wallet** — balance/history, deposit info, price your tinys, claim on-chain deposits |
| `tiny_pay_quote` / `tiny_pay_confirm` | **x402 payer, confirm-every-payment** — the quote never moves money; confirm executes only the exact quote you approved |
| `tiny_devices` | Your enrolled devices — list presence, revoke a device token |
| `tiny_model_config` | Cross-device BYO model config — the stored API key is never returned |
| `tiny_archives` | Cloud session archives — save (credentials redacted server-side), restore anywhere |
| `tiny_create_tool` / `my_*` / `tiny_reload_tools` / `tiny_remove_tool` | **Tool forge** — persist small JS tools in your account; they mount as first-class MCP tools here *and* in web chat |
| `tiny_marketplace` | Browse/install community tools |
| `tiny_schedule` | Cron jobs that run server-side while your laptop sleeps |
| `tiny_share` | Publish a conversation snapshot as a short link; list + revoke |
| `tiny_whoami` / `tiny_login` | Identity + in-session browser auth |

Plus the `tiny-context` MCP **prompt** (your recent memories formatted for
injection at session start) and browsable MCP **resources**: `tiny://me`,
`tiny://memories`, and `tiny://tiny/<name>` for each tiny you own.

## The local agent

The same package is a terminal agent with streaming markdown, `/loop`
autonomous mode, `!cmd` shell escapes, and device tools that register
themselves when their backend exists (macOS automation, Google, Spotify,
WhatsApp, Telegram, Android over adb, a CDP-driven browser, even a Flipper
Zero):

```bash
npx tiny-tech            # full-screen TUI · MCP server when spawned over stdio
npx tiny-tech repl       # plain REPL (pipes-friendly)
npx tiny-tech "one-shot query"
npx tiny-tech mesh       # headless LAN mesh node
npx tiny-tech daemon install   # answer fleet commands at login
```

Models auto-detect — Bedrock → OpenAI → Anthropic → Ollama → the zero-config
server proxy — or pin one:

```bash
TINY_MODEL_PROVIDER=ollama npx tiny-tech repl     # fully offline, local models
TINY_MODEL_PROVIDER=openai TINY_MODEL_API_KEY=... npx tiny-tech
```

## Be called — and paid — by other agents

A tiny isn't just a client of the agent economy. Priced tinys answer over
**x402** (settle-before-serve, refund-on-empty) and register as **ERC-8004**
agents so other agents discover and pay them autonomously. The payer side is
`tiny_pay_quote` → your explicit `tiny_pay_confirm` — never silent autopay.

*The full developer story: [Integrate a tiny](../business/integrate.md). The
economics: [Pricing & economics](../business/pricing.md).*

---

Package: [`tiny-tech` on npm](https://www.npmjs.com/package/tiny-tech) ·
[github.com/cagataycali/tiny-tech](https://github.com/cagataycali/tiny-tech)
