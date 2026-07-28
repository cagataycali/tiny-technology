# tiny web — the Next.js app

The web face of [tiny.technology](https://tiny.technology) and the brain of the
platform: the chat UI where you create and talk to your tinys, plus the API
routes that run the agent loop, mint sessions, take x402 payments, and serve
the chain explorer, voice calls, the map, and the universe view.

Built on **Next.js 16** (App Router, Turbopack) with the
[Strands Agents SDK](https://www.npmjs.com/package/@strands-agents/sdk) driving
the model loop — bring **AWS Bedrock**, OpenAI, Gemini, Vercel AI Gateway, or
run fully on-device with WebLLM; users can also bring their own key at runtime
(BYOK). The registry of supported providers lives in
[`lib/model-registry.ts`](lib/model-registry.ts).

## Run it locally

```bash
cd web
npm install
cp .env.example .env.local   # then fill in the minimum below
npm run dev                  # http://localhost:3000
```

Minimum viable `.env.local`:

| Var | What it is |
|---|---|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | a GitHub OAuth app (sign-in) |
| `AUTH_JWT_SECRET` | any long random string — session/CLI JWTs |
| `INTERNAL_API_KEY` | shared secret with your [worker](../worker/) (must match its wrangler secret) |
| one model key | e.g. `AWS_BEARER_TOKEN_BEDROCK` (+ `BEDROCK_REGION`, `BEDROCK_MODEL_ID`) or `OPENAI_API_KEY` — without one, only BYOK requests work |

Everything else in [`.env.example`](.env.example) is optional and documented
inline — rate limiting (fails open without KV), x402 payments (fail closed
without `X402_PAY_TO`), the self-hosted chain, voice, and media generation.

## Deploy to Vercel

1. Import the repo; set **Root Directory = `web/`**.
2. Keep **"Include source files outside of the Root Directory"** enabled (the
   default). App routes import the payment guards from the sibling
   [`chain/`](../chain/) directory — `next.config.js` sets `turbopack.root`
   to the repo root for the same reason.
3. Set the env vars from the table above, plus `NEXT_PUBLIC_APP_URL` (your
   deployment's own URL).
4. Point your [Android](../android/) / [iOS](../ios/) builds and your
   [worker](../worker/) at the deployed URL.

## Layout

```
app/            routes — chat ([slug]), wallet, chain explorer, voice, map,
                universe, devices, vcard/og cards, and all /api/* endpoints
components/     React components (chat surface, panels, cards, sheets)
lib/            the engine room: model-registry, auth, rate-limit, free-tier,
                sse, x402/ (payer, facilitator resolver), chat/, voice/, chain/
tools/          agent tools exposed to the model loop
tests/          vitest — 3,300+ tests, green on a fresh clone: `npm test`
public/         static assets (also the OTA staging area — see android/README)
```

Sibling symlinks (`chain`, `worker`, `ios`, `android`, `docs`, `mkdocs.yml`)
exist so cross-surface parity tests can read those sources with repo-relative
paths; don't remove them.

## Working on it

```bash
(cd ../worker && npm ci)   # once — many suites import the worker's sources
npm test             # full vitest suite
npm run build        # production build (Turbopack)
npm run typecheck    # tsc --noEmit; CI runs this too — vitest strips types and
                     # `next build` only visits route-reachable files, so neither
                     # one typechecks anything under tests/
```

`AGENTS.md` in this directory carries the deeper conventions (state shapes,
streaming protocol, tool-card contracts) if you're changing the chat surface
or the agent loop.

## License

[Apache-2.0](../LICENSE), same as the rest of the repository.
