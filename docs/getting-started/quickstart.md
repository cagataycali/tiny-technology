# Quickstart

## 1. Create your tiny

1. Go to **[tiny.technology](https://tiny.technology)** and **sign in with GitHub**
   (enroll a passkey after — biometric login, no roundtrip).
2. **Chat.** The `tiny` meta-agent creates and modifies AIs by conversation — no
   forms, no keys:

   > create an ai named support, system: you're a helpful assistant

   It's instantly live at `tiny.technology/support` — a URL, a PWA, an OG card,
   even a vCard.

3. **Share it.** Every tiny has its own address you can send to anyone.

The free tier covers your first steps. Bring your own model key — OpenAI,
Anthropic, Bedrock, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI,
Perplexity, or any OpenAI-compatible URL — and the free-tier limit no longer
applies.

## 2. Take it into any agent (MCP)

Your identity, memory and tools mount into Claude Code, Codex, Kiro, Cursor, or
any Strands agent:

```bash
npx tiny-tech login              # browser opens → click Approve → done
claude mcp add tiny -- npx -y tiny-tech
```

What your agent gets ([tiny-tech on GitHub](https://github.com/cagataycali/tiny-tech), `tiny-tech` on npm):

- **Cross-agent memory** — `tiny_learn` / `tiny_recall` / `tiny_unlearn`:
  durable facts with semantic search. Learned in Claude Code, recalled on your
  phone, or by your Telegram bot.
- **`tiny_chat`** — consult any tiny; it runs server-side with its complete toolset.
- **Your forged tools mount as real MCP tools** (`my_*`) with their own schemas.
- Personas, scheduled jobs, marketplace, sharing — the whole platform, one stdio
  server.

Auth is a loopback flow: consent click → single-purpose 90-day token in
`~/.tiny/credentials.json`. Forged tools always execute in tiny's server
sandbox, never on your machine.

## 3. Give it superpowers

- **Memory** — `learn` / `recall` / `unlearn`; facts link into a graph, and
  contradictions surface as one-tap conflict prompts. Manage with `/memory`.
- **Tools** — the agent writes small JS tools with `create_tool` that persist to
  your account; browse the community marketplace for more.
- **Schedules** — cron (`*/30m`, `daily@09:00`) and one-shot jobs run
  server-side while you sleep.
- **Telegram** — pair a BotFather bot by chatting; your tiny answers there too.
- **Voice** — dictate with the mic, have replies spoken back.
- **Payments** — price your tiny per message; people and other AIs pay it in
  USDC over x402.

## Native apps

tiny ships as a PWA plus native iOS and Android apps with voice sessions, maps,
on-device image generation, and device fleet features. Install from
[tiny.technology](https://tiny.technology) — the site offers the right app for
your device.
