import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { enforceIpDailyLimit } from "@/lib/rate-limit"
import { parseOpenAPI } from '@/lib/utils'
import slugify from 'slugify'
import { http } from '@/tools/http'
import { getSession, getUserWithTinys } from '@/lib/auth'
import { createModel, preflightModelCheck, parseAdditionalFields } from '@/lib/chat/model'
import { friendlyError, resultText, buildMcpClients, isOverflowError, usd } from '@/lib/chat/helpers'
import { buildSoulPrompt, buildDeviceBlock, walletFundsPhrase } from '@/lib/chat/prompt'
import { paymentsNetwork } from '@/lib/x402/tiny-chain'
import { normalizeAgentEvent, isDeliveredOutput } from '@/lib/chat/events'
import { getTinyTool, listTinyTool, makeRetrieveTool } from '@/lib/chat/tools/universe'
import { renderUiTool, renderUiNativeTool, speakTool, suggestFollowupsTool, rememberTool, forgetTool, manageMessagesTool, vibrateTool, flashlightTool, copyToClipboardTool, setBrightnessTool, playSoundTool, scheduleAlertTool, openUrlTool, cancelAlertsTool, addMapMarkerTool, flyToLocationTool, clearMapMarkersTool, removeMapMarkerTool, flyToMarkerTool, tourMarkersTool } from '@/lib/chat/tools/client-side'
import { makeSendMessageTool, makeReadMessagesTool } from '@/lib/chat/tools/messages'
import { makeLearnTool, makeRecallTool, makeUnlearnTool, makeConflictsTool, makeGraphNeighborsTool } from '@/lib/chat/tools/memory'
import { PROTECTED_TOOLS, parseDisabledTools, filterTools, dedupeToolsByName } from '@/lib/chat/tool-filter'
import { ownsTiny } from '@/lib/chat/page-code-trust'
// Shared with /api/job-run so scheduled jobs run with the owner's real
// capability set (forged my_* tools, OpenAPI skills, use_telegram) —
// runToolApi proxies to the Node sandbox (edge forbids new Function).
import { runToolApi, makeForgedTools, buildDynamicTools, makeUseTelegramTool, makeUseDeviceTool, makeGenerateImageTool, makeScreenshotTool, makeMetaTakePhotoTool, makeMetaRecordVideoTool, makeMetaListenTool, makeMetaGlassesStatusTool, makeWalletTool } from '@/lib/chat/tools/platform'
import { batchTicket, runBatchInBackground } from '@/lib/chat/tools/spawn'
import { makeNiclaTakePhotoTool, makeNiclaTakeVideoTool, makeNiclaListenTool, makeNiclaStatusTool } from '@/lib/chat/tools/nicla'
import { makeNiclaVoiceStatusTool, makeNiclaVoiceWakesTool, makeNiclaVoiceRecordTool, makeNiclaVoiceTranscriptsTool, makeNiclaVoiceTranscriptTool } from '@/lib/chat/tools/nicla-voice'
import { makeFlipperStatusTool, makeFlipperListenTool, makeFlipperFilesTool } from '@/lib/chat/tools/flipper'

export const runtime = 'edge'
export const maxDuration = 300

// ============================================================================
// Route handler
// ============================================================================

export async function POST(req: Request) {
  const headers = Object.fromEntries(req.headers.entries())
  const {
    'x-tiny-name': tinyName,
    'x-tiny-system-prompt': tinySystemPrompt,
    'x-tiny-session': tinySession,
    'x-tiny-metadata': tinyMetadata,
    'x-tiny-ip': legacyTinyMetadata, // pre-rename clients
    'x-tiny-key': tinyKey,
    'x-tiny-model-provider': customProvider,
    'x-tiny-model-api-key': customApiKey,
    'x-tiny-model-id': customModelId,
    'x-tiny-model-base-url': customBaseUrl,
    'x-tiny-model-max-tokens': customMaxTokens,
    'x-tiny-model-region': customRegion,
    'x-tiny-model-additional-fields': customAdditionalFields,
    'x-tiny-mcp-servers': customMcpServers,
  } = headers

  // Client environment context (weather/locale on some pages) — renamed from
  // the misleading x-tiny-ip; accept both during transition
  const clientMetadata = tinyMetadata || legacyTinyMetadata || ''

  // 🔐 Session (GitHub/WebAuthn) — required for create/modify tools
  const session = await getSession(req)

  // 🧠 Cross-device model config: settings used to live only on-device, so a
  // second device (no BYO headers) fell back to the free default provider.
  // When a signed-in request arrives WITHOUT model headers, load the user's
  // synced config from the worker (api key decrypted over the internal-key
  // channel) and use it as the effective selection. Header-supplied config
  // always WINS — a device with local settings overrides the synced copy.
  let syncedModel: {
    provider?: string; apiKey?: string; modelId?: string; baseUrl?: string
    maxTokens?: string; region?: string; additionalFields?: string
  } = {}
  const hasHeaderModel = Boolean(customProvider || customApiKey || customModelId)
  if (session && !hasHeaderModel) {
    const synced: any = await fetch(
      `${process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'}/model-config?userId=${encodeURIComponent(session.sub)}`,
      { headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' }, signal: AbortSignal.timeout(8_000) }
    ).then(r => r.json()).catch(() => null)
    const cfg = synced?.config
    if (cfg?.provider) {
      syncedModel = {
        provider: cfg.provider,
        apiKey: cfg.apiKey || undefined,
        modelId: cfg.model_id || undefined,
        baseUrl: cfg.base_url || undefined,
        maxTokens: cfg.max_tokens ? String(cfg.max_tokens) : undefined,
        region: cfg.region || undefined,
        additionalFields: cfg.additional_fields || undefined,
      }
    }
  }
  // Effective selection: header value (BYOK on this device) OR synced fallback.
  const effProvider = customProvider || syncedModel.provider
  const effApiKey = customApiKey || syncedModel.apiKey
  const effModelId = customModelId || syncedModel.modelId
  const effBaseUrl = customBaseUrl || syncedModel.baseUrl
  const effMaxTokens = customMaxTokens || syncedModel.maxTokens
  const effRegion = customRegion || syncedModel.region
  const effAdditionalFields = customAdditionalFields || syncedModel.additionalFields

  // Rate limiting (bypassed when the user brings their own key — header or
  // synced). Signed-in callers pass their user id so the window is keyed to
  // THEM and widened by their reputation, instead of sharing one 50/day bucket
  // with every other caller behind the same IP.
  //
  // json: true because this route's 429 is the one three chat clients render.
  // Both native streams prefer a JSON `error` field over their static
  // status→copy table (Api.swift:341, TinyApi.kt:289) and fall back to it
  // otherwise — so a plain-text 429 reached the user as "daily limit reached —
  // try again tomorrow", discarding the sentence that tells them what standing
  // is worth (lib/limit-message.ts). Web parses either.
  if (!effApiKey) {
    const limited = await enforceIpDailyLimit(req, { userId: session?.sub, json: true })
    if (limited) return limited
  }

  // Malformed bodies get a clean 400, not an unhandled 500
  const parsedBody = await req.json().catch(() => null)
  const rawMessages = parsedBody?.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages[] required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  // Drop non-object elements — a body like {"messages":[null]} passes the
  // array check above, then m.role on null throws an unhandled 500 (this runs
  // before the stream's try/catch). Keep only well-shaped {role} entries.
  const messages = rawMessages.filter((m: any) => m && typeof m === 'object' && typeof m.role === 'string')
  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages[] has no valid entries' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  // Normalize string-form content ({content: "hi"} — the plain API shape the
  // x402 route and external callers send) to the block form the rest of this
  // route expects. A string reaching lastMessageContent.filter() was an
  // unhandled 500; any other non-array shape gets the empty-content treatment.
  for (const m of messages) {
    if (typeof m.content === 'string') m.content = [{ text: m.content }]
    else if (!Array.isArray(m.content)) m.content = []
  }

  // Extract system messages for injection into system prompt
  const systemMessages = messages
    .filter((m: any) => m.role === 'system')
    .map((m: any) => m.content?.[0]?.text || '')
    .join('\n\n')

  // Filter out system messages - only user/assistant go to agent
  const conversationMessages = messages.filter((m: any) => m.role !== 'system')

  // Last message: full content blocks go to the agent (may include
  // image/document attachments); text-only extraction feeds retrieval.
  const lastMessageContent: any[] = conversationMessages[conversationMessages.length - 1]?.content || []
  const lastMessageText = lastMessageContent
    .filter((b: any) => typeof b?.text === 'string')
    .map((b: any) => b.text)
    .join('\n') || ''

  // History seeded into the agent must NOT include the last user message —
  // it is passed to agent.stream() and appended there (avoids duplication).
  const historyMessages = conversationMessages.slice(0, -1)

  // tinyName/tinyKey are CLIENT-CONTROLLED headers landing in internal-key-
  // authenticated worker URLs — encode them so a crafted name like
  // "x&userId=<victim>" can't inject query params on that channel.
  const keyQuery = tinyKey ? `&key=${encodeURIComponent(tinyKey)}` : ''

  // Fetch AI data, retrieval context and the logged-in user's profile in parallel
  const [retrieve, tinyData, userProfile, userMemory, userEvents, userToolRows, disabledToolsRaw, unreadDms, userDevices, tinyPriceMicro] = await Promise.all([
    fetch(`https://plugin.tiny.technology/retrieve?text=${encodeURIComponent(lastMessageText)}${session ? `&userId=${encodeURIComponent(session.sub)}` : ''}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${tinyName}:${tinyKey}`,
        // Session owners reach their private tiny's memory without a key
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
    }).then(res => res.json()).catch(() => []),
    fetch(`https://plugin.tiny.technology/get?name=${encodeURIComponent(tinyName || '')}${keyQuery}${session ? `&userId=${encodeURIComponent(session.sub)}` : ''}&msg=1`, {
      // Internal key → worker returns the FULL mcpServers config (with owner
      // headers/secrets) and authorizes session owners of private tinys.
      // Runs server-side only; never reaches the browser.
      // &msg=1: this is a chat turn — the worker increments tiny:message* on
      // this existing round-trip (the counter's queue-consumer writer was
      // removed in a2348e8, leaving the home-page stat dead at 0).
      headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
    }).then(res => res.json()).catch(() => ({})),
    session ? getUserWithTinys(session.sub).catch(() => null) : Promise.resolve(null),
    // 🧬 Persistent memory (issue #14 v2) — recent entries + semantic recall
    // against the current message, from the user's full (D1+Vectorize) store
    session
      ? fetch(`https://plugin.tiny.technology/learnings?userId=${encodeURIComponent(session.sub)}&limit=30&q=${encodeURIComponent(lastMessageText.slice(0, 500))}`, {
          headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        }).then(r => r.json()).catch(() => ({ learnings: [] }))
      : Promise.resolve({ learnings: [] }),
    // 🔔 Event bus tail (COMPARISON.md §2.6) — what happened across
    // subsystems (scheduled jobs, shares) since the user last looked
    session
      ? fetch(`https://plugin.tiny.technology/events?userId=${encodeURIComponent(session.sub)}&limit=15`, {
          headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        }).then(r => r.json()).then(d => d.events || []).catch(() => [])
      : Promise.resolve([]),
    // 🔧 Runtime user tools (issue #8) — tools this user forged in past chats
    session
      ? fetch(`https://plugin.tiny.technology/tools?userId=${encodeURIComponent(session.sub)}`, {
          headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        }).then(r => r.json()).then(d => d.tools || []).catch(() => [])
      : Promise.resolve([]),
    // 🎚 Disabled tools (manage_tools) — per-user pref, comma-separated names
    session
      ? fetch(`https://plugin.tiny.technology/prefs?userId=${encodeURIComponent(session.sub)}&key=disabled_tools`, {
          headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        }).then(r => r.json()).then(d => String(d.value || '')).catch(() => '')
      : Promise.resolve(''),
    // 💬 Unread DMs (user↔user messaging) — surfaced in the system prompt so
    // any tiny can greet with "you have messages from @x"
    session
      ? fetch(`https://plugin.tiny.technology/message/unread?userId=${encodeURIComponent(session.sub)}`, {
          headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        }).then(r => r.json()).catch(() => ({ unread: 0, from: [] }))
      : Promise.resolve({ unread: 0, from: [] }),
    // 💻 Enrolled devices (tiny-node) — presence in the system prompt so the
    // agent reaches for use_device without a discovery round-trip
    session
      ? fetch(`https://plugin.tiny.technology/device/list?userId=${encodeURIComponent(session.sub)}`, {
          headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        }).then(r => r.json()).then(d => d.devices || []).catch(() => [])
      : Promise.resolve([]),
    // 💸 Price of THIS tiny (payments PR1) — public read; 0 = free.
    // Failure degrades to free (a pricing hiccup must never block chat).
    // Key on the STRICT slug, not a bare lowercase: set_price WRITES prices
    // under `tiny:${slugify(input.tiny,{strict:true})}` (route :1327) and
    // create_tiny stores names AS strict slugs (:402), so the canonical name
    // IS a strict slug. Web sends the already-canonical tiny.name in
    // x-tiny-name, but the native apps send a user-typed Config.tinyName that
    // may be non-canonical ("Cool Bot", "cool_bot") — /get resolves it loosely
    // so the chat still works, but a bare-lowercase key ("cool bot") misses
    // the price row → price 0 → a PAID tiny runs FREE and the owner earns
    // nothing. slugify is idempotent on canonical slugs so this is a no-op for
    // the web/x402 paths. Same fix as the ask_tiny consult path (:556).
    fetch(`https://plugin.tiny.technology/pay/pricing?resource=${encodeURIComponent(`tiny:${slugify(tinyName || '', { lower: true, strict: true })}`)}`,
      { signal: AbortSignal.timeout(8_000) })
      .then(r => r.json()).then(d => Number(d.price_micro || 0)).catch(() => 0),
  ])

  // 👤 User context block — identity from the session JWT (GitHub/WebAuthn)
  // + owned tinys from D1. Injected into the agent's system prompt so the
  // agent can personalize and act on the user's tinys directly.
  const userTinys: { name: string; created?: number }[] = userProfile?.tinys || []
  // 🔒 ONE ownership decision, read by both the customize_page mount and the
  // prompt paragraph that advertises it. Derived from the session's own tiny
  // list — never from a client-supplied header — so an anonymous visitor, a
  // failed profile fetch, and a visited-but-unowned tiny all land on false.
  const callerOwnsThisTiny = ownsTiny(tinyName, userTinys.map((t) => t.name))
  const userContext = session
    ? `# Current User (authenticated)
- User ID: ${session.sub}
- GitHub: @${session.login}
- Name: ${session.name || session.login}
- Avatar: ${session.avatar || 'none'}
${userProfile?.user?.email ? `- Email: ${userProfile.user.email}\n` : ''}- Owned tinys (${userTinys.length}): ${userTinys.length ? userTinys.map(t => `[${t.name}](https://tiny.technology/${t.name})`).join(', ') : 'none yet'}

They can create unlimited free tinys and modify the tinys listed above — no payment, no keys needed. When they say "my AI" or "my tiny", resolve it against this list. Use their avatar URL when rendering profile UI (render_ui) and address them by name.
${Number(unreadDms?.unread) > 0 ? `\n## 💬 Unread messages (${unreadDms.unread})\nThey have unread DMs from: ${(unreadDms.from || []).map((f: any) => `${f.name} (@${f.login}) ×${f.count}`).join(', ')}. Mention this proactively and offer to read them (read_messages tool) or reply (send_message tool).` : ''}
${buildDeviceBlock(userDevices)}`
    : `# Current User
NOT logged in. To create or modify an AI they must sign in with GitHub first (free). Tell them to click the login button or visit https://tiny.technology/api/auth`

  // Stats may be absent when the tiny doesn't exist or /get failed
  const tinyStats = tinyData?.stats || {}

  // 💸 Paywall (payments PR1, settle-before-serve — design doc §6.3):
  // a priced tiny debits the caller's ledger BEFORE the model runs. Owners
  // and free tinys skip entirely. BYOK doesn't bypass — the price is the
  // owner's, not ours. A charged turn that then fails before delivering any
  // output is refunded in the stream error handler below (chargedRef).
  // x402 relay marker: /api/x402/chat settles on-chain BEFORE relaying here.
  // Honored ONLY when the request proves internal origin (internal key) —
  // the header alone is spoofable by any external caller.
  // FAIL CLOSED when INTERNAL_API_KEY is unset: an empty/missing env must never
  // authorize the bypass. The old `|| 'unset-internal-key'` fallback matched a
  // HARDCODED, publicly-known sentinel (this is a public repo), so a deployment
  // that forgot to set the key could be paywall-bypassed on every priced tiny by
  // sending x-tiny-x402-settled:1 + x-internal-key:unset-internal-key. Require a
  // non-empty configured key AND an exact match — the same fail-closed shape the
  // sibling internal-key validators use (run-tool/route.ts:18, job-run/route.ts:28).
  const internalKey = process.env.INTERNAL_API_KEY || ''
  const x402Settled = req.headers.get('x-tiny-x402-settled') === '1'
    && internalKey !== ''
    && req.headers.get('x-internal-key') === internalKey

  // Ref of a debit that landed THIS turn — set only after a successful charge
  // so the stream error handler can refund it (idempotent /pay/refund) if the
  // model then produces nothing. Stays null for free tinys, owners, and x402
  // (already settled on-chain — a stream blip there is not our charge to undo).
  let chargedRef: string | null = null

  if (Number(tinyPriceMicro) > 0 && !x402Settled) {
    if (!session) {
      return new Response(JSON.stringify({
        error: `This tiny charges ${usd(Number(tinyPriceMicro))} per message. Sign in and fund your wallet at /wallet to chat.`,
        payment_required: true,
        price_micro: Number(tinyPriceMicro),
        // Authoritative signed-out marker. Clients otherwise re-derive this three
        // different ways (no balance_micro + "sign in" in the copy) — a fragile
        // contract that breaks the moment this copy changes. Emit it explicitly so
        // the paywall card shows "Sign in" (not a dead-end "Add funds") without
        // string-matching. The insufficient-balance branch below omits it.
        signed_out: true,
      }), { status: 402, headers: { 'Content-Type': 'application/json' } })
    }
    // Invocation id: one charge per user turn. Derived from the session +
    // message count + a hash of the FULL last message so an SSE retry of the
    // same turn is idempotent (identical text → identical ref) while distinct
    // turns get distinct refs.
    //
    // The old key truncated the message to its first 24 ALPHANUMERIC chars —
    // so two DIFFERENT paid prompts sharing that opening prefix at the same
    // messages.length collided onto ONE ref, and the worker's
    // UNIQUE(user,kind,ref) then treated the 2nd as already_settled → it ran
    // FREE. Trivially exploitable: every first message in a fresh conversation
    // has messages.length === 1, and many prompts share a 24-char prefix
    // ("Generate a detailed analysis of X" vs "…of Y" both → "Generateadetailedanalysi"),
    // so a user could get the 2nd priced turn for nothing — a paywall leak.
    // SHA-256 over the full text (crypto.subtle is in the edge runtime) closes
    // that window: a collision now needs the ENTIRE prompt to match, which is
    // legitimately "the same turn" for idempotency. Slugify the name too so the
    // ref matches the resource slug's canonical form (below).
    const msgDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lastMessageText))
    const msgHash = Array.from(new Uint8Array(msgDigest)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
    const invokeRef = `chat:${slugify(tinyName || '', { lower: true, strict: true })}:${session.sub}:${messages.length}:${msgHash}`
    const settle = await fetch('https://plugin.tiny.technology/pay/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      // resource MUST match the pricing-read key above (strict slug), or a
      // non-canonical x-tiny-name settles against a resource with no price.
      body: JSON.stringify({ payerId: session.sub, resource: `tiny:${slugify(tinyName || '', { lower: true, strict: true })}`, ref: invokeRef }),
    }).then(r => r.json()).catch(() => null)

    if (!settle || (settle.ok !== true)) {
      return new Response(JSON.stringify({
        error: settle?.error === 'insufficient_balance'
          ? `Insufficient balance: this tiny charges ${usd(Number(tinyPriceMicro))} per message and your wallet has ${usd(Number(settle?.balance_micro ?? 0))}. Top up at /wallet.`
          : 'Payment settlement failed — try again.',
        payment_required: true,
        price_micro: Number(tinyPriceMicro),
        balance_micro: Number(settle?.balance_micro ?? 0),
      }), { status: 402, headers: { 'Content-Type': 'application/json' } })
    }
    // Remember the ref so a zero-output stream failure below can hand it back
    // (settle-before-serve means we already took the money). ONLY when THIS
    // call actually MOVED money: require charged_micro > 0 AND not an idempotent
    // replay. Two cases the bare `!already_settled` check got wrong, both of
    // which wrote NO ledger row (worker /pay/invoke): (a) a self-invoke by the
    // tiny's OWNER → {ok:true, free:true, self:true, charged_micro:0}, and
    // (b) an unpriced/no-split free settle → {ok:true, free:true, charged_micro:0}.
    // Arming chargedRef there meant an owner's empty self-chat turn fired
    // /pay/refund on a ref with no debit → worker 404 "nothing to refund" → a
    // FALSE `chat-refund-failed` error log, which is the alerting hook for REAL
    // creator-earnings loss. And an `already_settled` replay (charged_micro > 0
    // but a prior attempt paid, possibly delivering a full answer) must still
    // NOT refund — a failed retry stream refunding it would be a wrongful
    // clawback. This now matches the invariant documented above (chargedRef
    // stays null for free tinys, owners, and x402).
    if (Number(settle.charged_micro) > 0 && !settle.already_settled) chargedRef = invokeRef
  }

  // Compact RAG summary for the system prompt — the full schemas are already
  // exposed as tools; dumping them again as JSON wastes thousands of tokens.
  const retrieveSummary = (Array.isArray(retrieve) ? retrieve : [])
    .map((r: any) => ({
      name: r.name,
      url: r.url,
      systemPrompt: typeof r.systemPrompt === 'string' ? r.systemPrompt.slice(0, 300) : undefined,
      data: typeof r.data === 'string' ? r.data.slice(0, 300) : undefined,
      skills: (r.skills || []).map((s: any) => s.name).filter(Boolean),
      ...(r.memory ? { memory: r.memory } : {}),
    }))

  const retrievedFunctions = (Array.isArray(retrieve) ? retrieve : []).flatMap((r: any) =>
    r.skills ? r.skills : parseOpenAPI(r.schema, r.name, r.worker)
  )
  const functions = tinyData?.skills || parseOpenAPI(tinyData?.schema, tinyData?.name, tinyData?.worker)

  // Model — shared by main agent and nested tiny agents. Uses the effective
  // selection (this device's headers, else the user's synced cross-device
  // config). Note "BYOK" gating below keys off effApiKey so a synced key
  // unlocks baseUrl/additionalFields exactly like a header key would.
  const model = createModel({
    provider: effProvider,
    apiKey: effApiKey,
    modelId: effApiKey ? effModelId : effModelId || undefined,
    baseUrl: effApiKey ? effBaseUrl : undefined,
    maxTokens: effMaxTokens ? parseInt(effMaxTokens, 10) || undefined : undefined,
    region: effRegion,
    // Provider-specific request fields (e.g. Bedrock's anthropic_beta for
    // 1M context) — BYOK only; free-tier requests can't steer server keys.
    additionalFields: effApiKey ? parseAdditionalFields(effAdditionalFields) : undefined,
  })
  // Resolved model id (defaults applied) — sent with usage metadata so the
  // client can estimate $ cost without knowing server-side defaults
  const resolvedModelId = (model.getConfig() as any)?.modelId || effModelId || ''

  // Preflight — fail fast with a streamed, client-renderable error
  const preflightError = preflightModelCheck({ provider: effProvider, apiKey: effApiKey })
  if (preflightError) {
    const enc = new TextEncoder()
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'error', error: preflightError })}\n\n`))
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        c.close()
      },
    })
    return new Response(body, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    })
  }

  // MCP clients — from header (BYO) or tiny config (mcpServers / mcp_servers)
  let mcpConfigRaw: unknown = undefined
  if (customMcpServers) {
    try { mcpConfigRaw = JSON.parse(customMcpServers) } catch { /* ignore malformed header */ }
  }
  if (!mcpConfigRaw) {
    mcpConfigRaw = tinyData.mcpServers ?? tinyData.mcp_servers
    if (typeof mcpConfigRaw === 'string') {
      try { mcpConfigRaw = JSON.parse(mcpConfigRaw) } catch { mcpConfigRaw = undefined }
    }
  }
  const mcpClients = buildMcpClients(mcpConfigRaw)

  // Define custom tools using Strands SDK
  const createAiTool = tool({
    name: 'create_ai',
    description: 'Craft a brand new AI entity',
    inputSchema: z.object({
      name: z.string().describe('The name of the AI'),
      systemPrompt: z.string().describe('The system prompt for the AI, required'),
      systemKnowledge: z.string().describe('The system knowledge for the AI'),
      data: z.string().optional().describe('Define the data of the AI, optional'),
      worker: z.string().optional().describe('Tiny Worker - OpenAPI.json remote address like https://plugin.tiny.technology/openapi.json'),
      hook: z.string().optional().describe('Tiny AI webhook, optional, if you want to receive messages from the tiny ai'),
      hero: z.string().optional().describe('Hero/banner image URL (https) shown behind the landing hero — like a Twitter profile banner'),
      theme: z.object({ accent: z.string().optional(), bg: z.string().optional() }).optional().describe("Per-tiny UI colors: accent + bg as #RRGGBB hex. Visitors see these by default."),
      logo: z.string().optional().describe("Logo/avatar media URL (https) shown centered above the tiny's name on its landing hero — svg/gif/png/jpg/webp/mp4/webm all work"),
      intro_vibe: z.string().optional().describe("Haptic greeting played when the tiny opens on mobile — one of: tap, double, success, warning, error, heartbeat, sos, long, escalate, wave"),
      chips: z.array(z.string()).optional().describe('1-4 starter suggestion chips (each ≤60 chars) shown on the landing page instead of the defaults. End a chip with "…" to have it pre-fill the composer instead of sending'),
      tagline: z.string().optional().describe("Custom landing subtitle (≤200 chars) shown under the tiny's name instead of the generic \"A tiny — a living AI at …\" line"),
    }),
    callback: async (input) => {
      if (!session) {
        return {
          loginRequired: true,
          response: 'Login required to create an AI. Ask the user to sign in with GitHub (button in the header, or visit /api/auth) — creating tinys is free once logged in!',
        }
      }
      // strict matches the worker's authoritative slug rule; reject names
      // that reduce to nothing so the model can ask for a usable one
      const slug = slugify(String(input.name), { lower: true, strict: true })
      if (!slug) {
        return { error: 'invalid name', response: `"${input.name}" has no usable slug characters — suggest a name with letters or numbers.` }
      }
      const body: any = {
        ...input,
        name: slug,
        systemPrompt: input.systemPrompt,
        systemKnowledge: input.systemKnowledge,
        // itty declares theme as Str — objects must be stringified or the
        // router silently strips the field (AGENTS.md gotcha #8)
        ...(input.theme !== undefined ? { theme: JSON.stringify(input.theme) } : {}),
        // chips is an itty Str too — the array must ride as a JSON string
        ...(input.chips !== undefined ? { chips: JSON.stringify(input.chips) } : {}),
        userId: session.sub,
      }
      return fetch('https://plugin.tiny.technology/upsert', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
        },
        body: JSON.stringify(body),
      }).then(r => r.json())
        // Worker down/timeout must return a model-readable failure, not
        // reject the tool call (which faults the turn / confuses the model)
        .catch(e => ({ ok: false, error: `Couldn't reach the platform to create the AI: ${String(e?.message || e)}` }))
    },
  })

  const modifyAiTool = tool({
    name: 'modify_ai',
    description: 'Refine the essence of an existing tiny AI',
    inputSchema: z.object({
      name: z.string().describe('The name of the AI'),
      systemPrompt: z.string().describe('The system prompt for the AI'),
      systemKnowledge: z.string().describe('The system knowledge for the AI'),
      data: z.string().optional().describe('The data for the AI'),
      worker: z.string().optional().describe('Tiny Worker - OpenAPI.json remote address'),
      hook: z.string().optional().describe('Tiny AI webhook'),
      hero: z.string().optional().describe("Hero/banner image URL (https). Empty string removes the banner."),
      theme: z.object({ accent: z.string().optional(), bg: z.string().optional() }).optional().describe("Per-tiny UI colors ({accent, bg} #RRGGBB hex). Pass empty strings to clear."),
      logo: z.string().optional().describe("Logo/avatar media URL (https) shown above the tiny's name — svg/gif/png/jpg/webp/mp4/webm. Empty string removes the logo."),
      intro_vibe: z.string().optional().describe("Haptic greeting on mobile open — one of: tap, double, success, warning, error, heartbeat, sos, long, escalate, wave. Empty string clears."),
      chips: z.array(z.string()).optional().describe('1-4 starter suggestion chips (each ≤60 chars) replacing the landing defaults. Empty array restores the defaults. End a chip with "…" to pre-fill the composer instead of sending'),
      tagline: z.string().optional().describe("Custom landing subtitle (≤200 chars) shown under the tiny's name instead of the generic \"A tiny — a living AI at …\" line. Empty string restores the generic line."),
      key: z.string().optional().describe('Legacy owner key (optional if logged in as owner)'),
    }),
    callback: async (input) => {
      const body: any = {
        ...input,
        systemPrompt: input.systemPrompt,
        systemKnowledge: input.systemKnowledge,
        ...(input.theme !== undefined ? { theme: JSON.stringify(input.theme) } : {}),
        // chips is an itty Str — the array must ride as a JSON string
        ...(input.chips !== undefined ? { chips: JSON.stringify(input.chips) } : {}),
        ...(session ? { userId: session.sub } : {}),
      }
      return fetch('https://plugin.tiny.technology/upsert', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
        },
        body: JSON.stringify(body),
      }).then(r => r.json())
        .catch(e => ({ ok: false, error: `Couldn't reach the platform to update the AI: ${String(e?.message || e)}` }))
    },
  })

  // 🔗 Ring attention (agi-diy pattern, server-side): a shared per-
  // conversation ring that every consulted tiny / sub-agent reads and
  // writes — researcher learns something, critic sees it next call.
  const ringHeaders = {
    'Content-Type': 'application/json',
    'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
  }
  const ringRead = async (excludeAgent?: string): Promise<string> => {
    if (!tinySession) return ''
    try {
      const d = await fetch(`https://plugin.tiny.technology/ring?session=${encodeURIComponent(tinySession)}`, { headers: ringHeaders })
        .then(r => r.json())
      const entries = (d.entries || []).filter((e: any) => e.agentId !== excludeAgent).slice(-5)
      if (!entries.length) return ''
      return `\n\n[Ring Context — what other agents in this conversation found:]\n${entries.map((e: any) => `• ${e.agentId}: ${String(e.text).slice(0, 150)}`).join('\n')}`
    } catch { return '' }
  }
  const ringWrite = (agentId: string, text: string) => {
    if (!tinySession || !text?.trim()) return
    // fire-and-forget — never block the tool result on ring persistence
    fetch('https://plugin.tiny.technology/ring', {
      method: 'POST',
      headers: ringHeaders,
      body: JSON.stringify({ session: tinySession, agentId, text: text.slice(0, 500) }),
    }).catch(() => { })
  }

  // ⭐ Agent-as-a-tool: talk to any tiny in the universe via a real nested
  // Strands agent. The nested agent gets the target tiny's identity
  // (system prompt + knowledge + data) and runs on the same model provider.
  const askTinyTool = tool({
    name: 'ask_tiny',
    description: 'Talk with another tiny AI from the Tiny Universe. Spawns a real nested agent with the target tiny\'s personality, knowledge and data, sends it your message, and returns its response. Use this to consult, delegate, or collaborate with other tinys.',
    inputSchema: z.object({
      name: z.string().describe('The name (slug) of the target tiny AI to talk with'),
      message: z.string().describe('The message or question to send to the target tiny AI'),
    }),
    callback: async (input) => {
      // Ref of a consult charge that landed this call — set after a successful
      // debit so a failed nested invoke can hand it back. The consult ref
      // embeds the turn/message (not stable like the tool-install ref), so a
      // retry won't dedupe — an un-refunded throw is a permanent silent charge.
      let consultRef: string | null = null
      // Hand back a consult charge (idempotent /pay/refund by ref) when the
      // nested agent delivered nothing. No-op for free consults (null ref).
      const refundConsult = async () => {
        if (!consultRef) return
        const r = await fetch('https://plugin.tiny.technology/pay/refund', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
          body: JSON.stringify({ ref: consultRef }),
        }).then(res => res.json()).catch(() => null)
        if (!r?.ok) console.error('chat-refund-failed', JSON.stringify({ ref: consultRef, kind: 'consult', err: r?.error || 'unreachable' }))
        consultRef = null
      }
      try {
        // Signed-in callers get the internal-key + userId channel so the
        // worker authorizes the consult when THIS user owns a private target
        // (same ownership path as direct chat). Anonymous callers use the
        // public /get, which masks private personas.
        const consultAuth: Record<string, string> = { 'Content-Type': 'application/json' }
        if (session) consultAuth['X-Internal-Key'] = process.env.INTERNAL_API_KEY || ''
        const consultUserQ = session ? `&userId=${encodeURIComponent(session.sub)}` : ''
        const target = await fetch(`https://plugin.tiny.technology/get?name=${encodeURIComponent(input.name)}${consultUserQ}`, {
          headers: consultAuth,
        }).then(r => r.json())

        if (!target?.name) {
          return { ok: false, error: `Tiny AI '${input.name}' not found in the universe` }
        }

        // Private tinys return masked (empty) prompts unless the caller is the
        // vouched owner (isAuthorized). An owner consulting their OWN private
        // tiny gets the real persona; everyone else is declined cleanly rather
        // than impersonating a blank identity.
        if (target.private && !target.isAuthorized) {
          return { ok: false, error: `Tiny AI '${input.name}' is private and can't be consulted.` }
        }

        // 💸 Agent-to-agent payments (payments PR1): consulting a PRICED
        // tiny debits the CURRENT USER's wallet — same settle-before-serve
        // rule as direct chat. Ref includes the turn's message count so a
        // model retrying the tool call in one turn doesn't double-pay.
        try {
          // Key pricing on the RESOLVED canonical name (target.name), not the
          // raw model-typed input.name. set_price writes under
          // `tiny:${slugify(input.tiny,{strict:true})}` (route :1339), so key the
          // lookup + settle on the SAME strict slug — don't trust that /get echoed
          // a canonical name. A bare `.toLowerCase()` diverges from slugify for any
          // stored name with spaces/punctuation/unicode (`"Cool Bot"`→`cool bot`
          // vs the written `cool-bot`) → misses the price row → price_micro 0 → a
          // PAID tiny gets consulted FREE and the owner earns nothing. Direct chat
          // (:225/:289) already re-slugifies for exactly this reason; mirror it so
          // the key derivation is identical on all four money surfaces regardless
          // of the stored-name shape.
          const pricingKey = `tiny:${slugify(String(target.name), { lower: true, strict: true })}`
          const priced = await fetch(`https://plugin.tiny.technology/pay/pricing?resource=${encodeURIComponent(pricingKey)}`,
            { signal: AbortSignal.timeout(8_000) })
            .then(r => r.json()).catch(() => ({ price_micro: 0 }))
          if (Number(priced?.price_micro) > 0) {
            if (!session) {
              return { ok: false, payment_required: true, error: `'${input.name}' charges ${usd(Number(priced.price_micro))} per consult — the user must be signed in with a funded wallet (/wallet).` }
            }
            // Idempotency ref: session + turn + a hash of the FULL consult
            // message, so a model retrying the SAME tool call in one turn
            // doesn't double-pay (identical args → identical ref) while two
            // DISTINCT consults get distinct refs. The old key truncated to the
            // first 24 chars THEN stripped non-alphanumerics — so a message with
            // early spaces/punctuation kept even fewer discriminating chars
            // ("Hello, world! Please analyze X" → "Helloworld"), and two distinct
            // paid consults sharing that reduced prefix at the same
            // messages.length collided onto ONE ref → the worker's
            // UNIQUE(user,kind,ref) marked the 2nd already_settled → it ran FREE
            // (owner earns nothing). Same prefix-collision paywall leak the direct
            // chat ref carried (fixed C122); mirror the SHA-256 fix here so both
            // paid paths key on the whole message. crypto.subtle is in the edge runtime.
            const consultDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input.message)))
            const consultHash = Array.from(new Uint8Array(consultDigest)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
            const consultChargeRef = `ask:${slugify(String(target.name), { lower: true, strict: true })}:${session.sub}:${messages.length}:${consultHash}`
            const settle = await fetch('https://plugin.tiny.technology/pay/invoke', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
              body: JSON.stringify({
                payerId: session.sub,
                resource: pricingKey,
                ref: consultChargeRef,
              }),
            }).then(r => r.json()).catch(() => null)
            if (!settle || settle.ok !== true) {
              return {
                ok: false, payment_required: true,
                error: settle?.error === 'insufficient_balance'
                  ? `'${input.name}' charges ${usd(Number(priced.price_micro))} per consult and the user's wallet has ${usd(Number(settle?.balance_micro || 0))}. Tell the user to top up at /wallet.`
                  : 'Payment settlement failed for this consult.',
              }
            }
            // Arm the refund only when THIS call actually MOVED money —
            // charged_micro > 0 AND not an idempotent replay. A self-consult
            // (the user consulting their OWN paid tiny) or an unpriced settle
            // returns {ok:true, free:true, charged_micro:0} with NO ledger row,
            // so refunding it would 404 "nothing to refund" and log a FALSE
            // chat-refund-failed (the real-earnings-loss alert). An
            // `already_settled` replay paid on an earlier attempt that may have
            // delivered, so a failure here must not claw it back either.
            if (Number(settle.charged_micro) > 0 && !settle.already_settled) consultRef = consultChargeRef
          }
        } catch { /* pricing outage degrades to free — never block on it */ }

        const ringCtx = await ringRead(target.name)
        const nestedAgent = new Agent({
          model,
          printer: false,
          systemPrompt: `You are ${target.name}, a tiny AI living at tiny.technology/${target.name}.
System Prompt: ${target.systemPrompt || target.system_prompt || ''}
Knowledge Base: ${target.systemKnowledge || target.system_knowledge || ''}
Data Repository: ${target.data || ''}

You are being consulted by another tiny AI (${tinyData.name}). Answer as yourself, in character, concisely.${ringCtx}`,
        })

        const result = await nestedAgent.invoke(input.message)
        const responseText = resultText(result)

        // Paid consult that produced no text = nothing delivered → refund and
        // tell the model, rather than charging the user for an empty answer.
        if (consultRef && !responseText.trim()) {
          await refundConsult()
          return { ok: false, error: `'${input.name}' returned an empty response — the charge was refunded.` }
        }

        ringWrite(target.name, responseText)

        // 🕸️ Social graph (stage 6): consulted edge — tiny → tiny. This is
        // the trust-graph signal (PageRank over consulted). Fire-and-forget.
        if (tinyName && tinyName !== target.name) {
          fetch('https://plugin.tiny.technology/graph/social', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
            },
            body: JSON.stringify({
              rel: 'consulted',
              srcId: `tiny:${tinyName.toLowerCase()}`, srcKind: 'tiny', srcLabel: `/${tinyName}`,
              dstId: `tiny:${target.name.toLowerCase()}`, dstKind: 'tiny', dstLabel: `/${target.name}`,
            }),
          }).catch(() => { })
        }

        return {
          ok: true,
          name: target.name,
          response: responseText,
        }
      } catch (error: any) {
        // The nested consult failed after we charged — settle-before-serve
        // means the user's already paid, so hand it back (idempotent by ref).
        await refundConsult()
        return { ok: false, error: error?.message || String(error) }
      }
    },
  })

  // ⭐ Parallel sub-agents (issue #6) — fan out tasks, each a fresh
  // Strands agent with its own context + the http tool, all sharing the
  // request's model (BYOK billing follows the user). Failures are isolated
  // per-task; the whole batch is bounded by a timeout. No fixed task cap —
  // a concurrency pool runs SPAWN_CONCURRENCY at a time and SPAWN_BACKSTOP
  // is a runaway guard (prompt-injection spending the server key), not a
  // product limit.
  const SPAWN_CONCURRENCY = 8
  const SPAWN_BACKSTOP = 64
  const spawnAgentsTool = tool({
    name: 'spawn_agents',
    description: `Run sub-agent tasks IN PARALLEL, each with a fresh context and web access (http tool). Use for fan-out work: research multiple angles at once, compare options, process independent items. Each task gets its own prompt; results return together. Scale the fan-out to the job — a handful for a comparison, dozens for a sweep (${SPAWN_CONCURRENCY} run concurrently, the rest queue; keep the batch inside the timeout). Sub-agents cannot spawn further agents.`,
    inputSchema: z.object({
      tasks: z.array(z.object({
        prompt: z.string().describe('The task for this sub-agent'),
        system_prompt: z.string().optional().describe('Optional persona/instructions for this sub-agent'),
      })).min(1).max(SPAWN_BACKSTOP).describe('Independent tasks to run in parallel'),
      timeout_seconds: z.number().optional().describe('Per-batch timeout (default 60, max 240)'),
      wait: z.boolean().optional().describe("default true: wait for the batch and return the merged results. false = fire-and-forget (logged-in users only): returns a batch ticket immediately, the batch keeps running in the background, and the user gets ONE notification when it finishes — results redeemable with use_device action:'result' for ~24h. Use false for big sweeps or an explicit 'in the background'."),
    }),
    callback: async (input) => {
      const timeoutMs = Math.min(Math.max((input.timeout_seconds ?? 60), 5), 240) * 1000
      const started = Date.now()

      // Sub-agents see the ring as it existed at batch start (parallel tasks
      // are independent by design; their outputs land on the ring for later
      // ask_tiny/spawn_agents calls in this conversation)
      const batchRingCtx = await ringRead()

      const runTask = async (task: { prompt: string; system_prompt?: string }, i: number) => {
        try {
          const sub = new Agent({
            model,
            printer: false,
            tools: [http],
            systemPrompt: (task.system_prompt ||
              `You are sub-agent #${i + 1} of ${tinyData.name || 'tiny'}, handling one task of a parallel batch. Be direct and complete — your answer is merged with other sub-agents' results. You have the http tool for web/API access.`) + batchRingCtx,
          })
          const result = await Promise.race([
            sub.invoke(task.prompt),
            new Promise((_, rej) => setTimeout(() => { try { sub.cancel() } catch { }; rej(new Error('task timeout')) }, timeoutMs)),
          ])
          const text = resultText(result)
          ringWrite(`sub-agent-${i + 1}`, text)
          return { task: i + 1, ok: true, result: text }
        } catch (error: any) {
          return { task: i + 1, ok: false, error: error?.message || String(error) }
        }
      }

      // Concurrency pool: SPAWN_CONCURRENCY workers pull tasks off a shared
      // cursor — big batches queue instead of stampeding the model provider
      const runBatch = async () => {
        const results: any[] = new Array(input.tasks.length)
        let cursor = 0
        const worker = async () => {
          while (cursor < input.tasks.length) {
            const i = cursor++
            results[i] = await runTask(input.tasks[i], i)
          }
        }
        await Promise.all(Array.from({ length: Math.min(SPAWN_CONCURRENCY, input.tasks.length) }, worker))
        return { results, elapsedMs: Date.now() - started }
      }

      // 🔥 Fire-and-forget (wait:false — spawn-agents-async design S2): the
      // batch continues via after() once this response settles — same model
      // object, same BYOK context — and its aggregate parks on the worker as
      // a batch_* deposit: redeemed by use_device action:'result', announced
      // by ONE push + ring event (lib/chat/tools/spawn.ts). Login required —
      // the deposit, push, and event are all user-scoped.
      if (input.wait === false && session?.sub) {
        const ticket = batchTicket()
        runBatchInBackground({ userId: session.sub, ticket, run: runBatch })
        return {
          ok: true, pending: true, batch_id: ticket, tasks: input.tasks.length,
          note: `Batch launched in the background (${input.tasks.length} task${input.tasks.length === 1 ? '' : 's'}). ` +
            `The user gets a notification when it finishes; results are redeemable with ` +
            `use_device action:'result' envelope_id:'${ticket}' for ~24h. Tell the user it's off and running.`,
        }
      }

      const { results, elapsedMs } = await runBatch()
      return {
        ok: results.some(r => r.ok),
        elapsed_ms: elapsedMs,
        completed: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length,
        results,
      }
    },
  })

  // Convert retrieved and base functions to Strands tools — shared with
  // job-run (lib/chat/tools/platform.ts). Retrieved functions take
  // precedence; names are sanitized/deduped inside (user-controlled
  // operationIds would otherwise throw at mount = DoS).
  const dynamicTools = buildDynamicTools([...retrievedFunctions, ...functions])

  // get_tiny/list_tiny/render_ui/etc. live in lib/chat/tools/ — retrieve
  // needs the caller's identity for private-memory access
  const retrieveTool = makeRetrieveTool(tinyName, tinyKey)

  // ⏰ Scheduler (issue #10) — background jobs fired by the worker cron.
  // Results surface on the event bus (visible in your next chat) — no user
  // needs to be present when they run.
  const scheduleTool = tool({
    name: 'schedule',
    description: `Manage background scheduled jobs that run WITHOUT the user present (results appear as events next visit). Actions: create (recurring 'every Nm/Nh' — pass as */Nm or */Nh — or 'daily@HH:MM' UTC, or one-shot via run_in_minutes), list, delete. Max 10 jobs/user.`,
    inputSchema: z.object({
      action: z.enum(['create', 'list', 'delete']),
      name: z.string().optional().describe('Job name (create/delete)'),
      prompt: z.string().optional().describe('What the job should do each run (create)'),
      schedule: z.string().optional().describe(`Recurring: '*/30m', '*/2h', 'daily@09:00' (UTC)`),
      run_in_minutes: z.number().optional().describe('One-shot: run once N minutes from now'),
      id: z.string().optional().describe('Job id (delete)'),
    }),
    callback: async (input) => {
      if (!session) return { ok: false, note: 'Login required — jobs attach to the user account.' }
      const headers = {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      }
      if (input.action === 'list') {
        return fetch(`https://plugin.tiny.technology/jobs?userId=${encodeURIComponent(session.sub)}`, { headers })
          .then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
      }
      if (input.action === 'delete') {
        if (!input.id) return { ok: false, error: 'id required for delete' }
        return fetch('https://plugin.tiny.technology/jobs', {
          method: 'DELETE', headers,
          body: JSON.stringify({ userId: session.sub, id: input.id }),
        }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
      }
      // create
      if (!input.name || !input.prompt) return { ok: false, error: 'name and prompt required' }
      if (!input.schedule && !input.run_in_minutes) return { ok: false, error: 'schedule or run_in_minutes required' }
      return fetch('https://plugin.tiny.technology/jobs', {
        method: 'POST', headers,
        body: JSON.stringify({
          userId: session.sub,
          tiny: tinyName || 'tiny',
          name: input.name,
          prompt: input.prompt,
          ...(input.schedule ? { schedule: input.schedule } : {}),
          ...(input.run_in_minutes ? { runAt: String(Math.floor(Date.now() / 1000) + Math.round(input.run_in_minutes * 60)) } : {}),
        }),
      }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
    },
  })

  // 🔧 Runtime tool building (issue #8, careless self-modify pattern) —
  // the user's forged tools mount as real agent tools each request.
  // Shared with job-run (lib/chat/tools/platform.ts).
  const forgedTools = makeForgedTools(userToolRows)

  // 📦 Tool marketplace seed (issue #15) — install community tools from
  // GitHub. Allowlisted owners only; same sandbox + persistence as
  // create_tool. Expected file format: a JS file whose body is a single
  // arrow function (args) => result, with optional metadata comments:
  //   // @description ...
  //   // @param name description
  const TOOL_REPO_ALLOWLIST = ['cagataycali', 'strands-agents', 'TinyAI-ID']
  const installToolTool = tool({
    name: 'install_tool',
    description: `Install a community tool from a raw.githubusercontent.com URL the user provides (ask them for the link — do NOT guess repo paths). Allowlisted owners: ${TOOL_REPO_ALLOWLIST.join(', ')}, plus any the user personally trusted via "/tools trust <owner>" (that command is user-only — if an owner is not trusted, tell the user to run it themselves; you cannot). The file must contain a single JS arrow function (args) => result, optionally preceded by // @description and // @param comments. It is sandbox-validated and persists as my_<name>.`,
    inputSchema: z.object({
      url: z.string().describe('Raw GitHub URL of the tool .js file'),
      name: z.string().optional().describe('Override tool name (defaults to filename)'),
    }),
    callback: async (input) => {
      if (!session) return { ok: false, note: 'Login required — tools attach to the user account.' }

      // Allowlist: raw.githubusercontent.com/<owner>/... with trusted owner
      let parsed: URL
      try { parsed = new URL(input.url) } catch { return { ok: false, error: 'invalid URL' } }
      if (parsed.hostname !== 'raw.githubusercontent.com') {
        return { ok: false, error: 'only raw.githubusercontent.com URLs are supported' }
      }
      const owner = parsed.pathname.split('/').filter(Boolean)[0] || ''
      const globallyTrusted = TOOL_REPO_ALLOWLIST.some(a => a.toLowerCase() === owner.toLowerCase())
      if (!globallyTrusted) {
        // Per-user trust (issue #15): grown ONLY via the user-run
        // "/tools trust <owner>" command — never by the model
        const userTrusted: string[] = await fetch(
          `https://plugin.tiny.technology/prefs?userId=${encodeURIComponent(session.sub)}&key=trusted_tool_owners`,
          { headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' } }
        ).then(r => r.json()).then(d => { try { return JSON.parse(d.value || '[]') } catch { return [] } }).catch(() => [])
        if (!userTrusted.some((a) => String(a).toLowerCase() === owner.toLowerCase())) {
          return { ok: false, error: `repo owner '${owner}' is not trusted. Built-in: ${TOOL_REPO_ALLOWLIST.join(', ')}. The user can add more by typing "/tools trust ${owner}" themselves (you cannot do it for them).` }
        }
      }

      // Version pinning (issue #15): resolve branch refs to the commit SHA
      // so the recorded source is immutable even if the branch moves later.
      // Path shape: /<owner>/<repo>/<ref>/<path...>
      const segs = parsed.pathname.split('/').filter(Boolean)
      const [, repo, ref, ...fileParts] = segs
      let pinnedRef = ref || ''
      if (repo && ref && !/^[0-9a-f]{40}$/i.test(ref)) {
        const sha = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`,
          { headers: { 'Accept': 'application/vnd.github.sha', 'User-Agent': 'tinyai' }, signal: AbortSignal.timeout(8_000) }
        ).then(r => r.ok ? r.text() : '').catch(() => '')
        if (/^[0-9a-f]{40}$/i.test(sha.trim())) pinnedRef = sha.trim()
      }
      const pinnedUrl = pinnedRef && fileParts.length
        ? `https://raw.githubusercontent.com/${owner}/${repo}/${pinnedRef}/${fileParts.join('/')}`
        : parsed.toString()

      const raw = await fetch(pinnedUrl, { signal: AbortSignal.timeout(10_000) })
        .then(r => r.ok ? r.text() : Promise.reject(new Error(`fetch ${r.status}`)))
        .catch(e => ({ __err: String(e?.message || e) }))
      if (typeof raw !== 'string') return { ok: false, error: `download failed: ${(raw as any).__err}` }
      if (raw.length > 4096) return { ok: false, error: 'tool file too large (max 4KB)' }

      // Parse metadata comments + strip them to get the function body
      const description = raw.match(/\/\/\s*@description\s+(.+)/)?.[1]?.trim()
        || `Installed from ${owner}'s repo`
      const params: Record<string, string> = {}
      const paramMatches = Array.from(raw.matchAll(/\/\/\s*@param\s+(\w+)\s+(.+)/g))
      for (const m of paramMatches) params[m[1]] = m[2].trim()
      const code = raw.replace(/^\s*\/\/.*$/gm, '').trim()

      const check = await runToolApi('validate', code)
      if (!check.ok) return { ok: false, error: check.error || 'validation failed' }

      const fileName = parsed.pathname.split('/').pop()?.replace(/\.[jt]s$/, '') || 'tool'
      const toolName = (input.name || fileName).toLowerCase().replace(/[^a-z0-9_]/g, '_')

      return fetch('https://plugin.tiny.technology/tools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
        },
        body: JSON.stringify({
          userId: session.sub,
          name: toolName,
          description: `${description} [source: ${owner}/${repo}@${pinnedRef.slice(0, 12) || 'unknown'}/${fileParts.join('/')}]`,
          params: JSON.stringify(params),
          code,
        }),
      }).then(r => r.json()).then(d => d.ok
        ? { ...d, note: `Installed! Call it as my_${d.name} starting NEXT message.` }
        : d
      ).catch(e => ({ ok: false, error: String(e) }))
    },
  })

  const createToolTool = tool({
    name: 'create_tool',
    description: `Forge a new personal tool from JavaScript — it becomes callable as my_<name> from the NEXT message onward (persisted to the user's account). PUBLIC: tool code is visible on the user's builder profile — NEVER embed API keys/secrets in code (pass them as args at call time instead). Code shape: an arrow function (args) => result. Available in scope: args (string params), fetch(url, init?) (https public hosts only, 10s timeout; returns {status, ok, body} where body is ALREADY parsed — r.json()/r.text() also work), JSON, Math, Date, String, Number, Array, Object, RegExp, URL, encodeURIComponent. NO process/require/eval/globalThis. Keep it under 4KB. Example: (args) => args.text.split('').reverse().join('')`,
    inputSchema: z.object({
      name: z.string().describe('snake_case tool name, 3-40 chars'),
      description: z.string().describe('What the tool does (shown in tool list)'),
      params: z.record(z.string(), z.string()).optional().describe('Input params: {argName: description}. All strings.'),
      code: z.string().describe('JS arrow function: (args) => result'),
    }),
    callback: async (input) => {
      if (!session) return { ok: false, note: 'Login required — tools attach to the user account.' }
      const check = await runToolApi('validate', input.code)
      if (!check.ok) return { ok: false, error: check.error || 'validation failed' }
      return fetch('https://plugin.tiny.technology/tools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
        },
        body: JSON.stringify({
          userId: session.sub,
          name: input.name,
          description: input.description,
          params: JSON.stringify(input.params || {}),
          code: input.code,
        }),
      }).then(r => r.json()).then(d => d.ok
        ? { ...d, note: `Forged! Call it as my_${d.name} starting NEXT message (tools mount per request).` }
        : d
      ).catch(e => ({ ok: false, error: String(e) }))
    },
  })

  // 🛍️ Marketplace (issue #15): browse everyone's public forged tools and
  // install by author+name. Code comes from the author's profile server-side
  // (never model-supplied) and re-validates in the sandbox before persisting.
  const marketplaceTool = tool({
    name: 'marketplace',
    description: `Browse the public tool marketplace (everyone's forged tools) and install one for the user. action:"browse" lists tools (optional query filter); action:"install" copies author's tool into the user's account as my_<name> — it re-validates in the sandbox first. Use browse before install to get exact author + name. action:"check_updates" compares the user's GitHub-installed tools (SHA-pinned) against upstream and reports which are outdated — updating is then a normal install_tool call with the new URL it returns (trust + sandbox checks re-apply).`,
    inputSchema: z.object({
      action: z.enum(['browse', 'install', 'check_updates']),
      query: z.string().optional().describe('browse: filter by name/description substring'),
      author: z.string().optional().describe('install: tool author\'s GitHub login (from browse results)'),
      name: z.string().optional().describe('install: exact tool name (from browse results)'),
    }),
    callback: async (input) => {
      if (input.action === 'check_updates') {
        // Auto-update opt-in (issue #15): read-only upstream diff. Tools
        // installed via install_tool carry [source: owner/repo@sha/path];
        // compare that pin against the latest commit touching the path.
        if (!session) return { ok: false, note: 'Login required.' }
        const mine = await fetch(
          `https://plugin.tiny.technology/tools?userId=${encodeURIComponent(session.sub)}`,
          { headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' } }
        ).then(r => r.json()).then(d => d.tools || []).catch(() => [])

        const pinned = mine
          .map((t: any) => {
            const m = String(t.description || '').match(/\[source: ([^/\s]+)\/([^@\s]+)@([0-9a-f]{4,40})\/([^\]]+)\]/)
            return m ? { name: t.name, owner: m[1], repo: m[2], sha: m[3], path: m[4] } : null
          })
          .filter(Boolean) as { name: string; owner: string; repo: string; sha: string; path: string }[]
        if (!pinned.length) return { ok: true, updates: [], note: 'No GitHub-pinned tools installed — nothing to check.' }

        const updates = await Promise.all(pinned.map(async (p) => {
          const latest = await fetch(
            `https://api.github.com/repos/${p.owner}/${p.repo}/commits?path=${encodeURIComponent(p.path)}&per_page=1`,
            { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'tinyai' }, signal: AbortSignal.timeout(8_000) }
          ).then(r => r.ok ? r.json() : []).then(a => a?.[0]?.sha || '').catch(() => '')
          const outdated = !!latest && !latest.startsWith(p.sha) && !p.sha.startsWith(latest)
          return {
            tool: `my_${p.name}`,
            pinned: p.sha.slice(0, 12),
            latest: latest ? latest.slice(0, 12) : 'unknown',
            outdated,
            ...(outdated ? { update_url: `https://raw.githubusercontent.com/${p.owner}/${p.repo}/${latest}/${p.path}` } : {}),
          }
        }))
        const outdatedCount = updates.filter(u => u.outdated).length
        return {
          ok: true,
          updates,
          note: outdatedCount
            ? `${outdatedCount} tool(s) have upstream changes. To update, ASK THE USER first, then call install_tool with the update_url (re-pins + re-validates).`
            : 'All pinned tools are up to date.',
        }
      }
      if (input.action === 'browse') {
        const qs = input.query ? `?q=${encodeURIComponent(input.query)}&limit=20` : '?limit=20'
        return fetch(`https://plugin.tiny.technology/tools/browse${qs}`)
          .then(r => r.json())
          .then(async (d) => {
            const rows = (d.tools || []) as any[]
            // Enrich each listing with its one-time install PRICE so a paid tool
            // is never a surprise charge at install — the model can tell the user
            // "$X to install" up front (matches set_price / paywall / pay_x402 /
            // the install note's own transparency). The worker's /tools/browse
            // doesn't SELECT price, so look it up per tool against the SAME
            // resource key the install path settles on (tool:<author>/<name>,
            // :1035) — enrichment only, the authoritative charge still happens at
            // install. Fails to 0/free on a lookup blip (same fallback the install
            // pricing read uses, :1037); browse price is advisory, install
            // re-checks + charges authoritatively.
            const priced = await Promise.all(rows.map(async (t) => {
              const priceMicro = await fetch(
                `https://plugin.tiny.technology/pay/pricing?resource=${encodeURIComponent(`tool:${t.author}/${t.name}`)}`,
                { signal: AbortSignal.timeout(6_000) }
              ).then(r => r.ok ? r.json() : null).then(p => Number(p?.price_micro || 0)).catch(() => 0)
              return {
                name: t.name, author: t.author, description: t.description,
                params: t.params_json,
                price_micro: priceMicro,
                ...(priceMicro > 0 ? { price: `${usd(priceMicro)} one-time install` } : { price: 'free' }),
              }
            }))
            return {
              ok: true,
              tools: priced,
              note: 'To install: marketplace {action:"install", author, name}. Paid tools charge the shown one-time price on install (state it before installing). Tool code is public on the author\'s /@profile.',
            }
          })
          .catch(e => ({ ok: false, error: String(e) }))
      }
      // install
      if (!session) return { ok: false, note: 'Login required — tools attach to the user account.' }
      if (!input.author || !input.name) return { ok: false, error: 'install needs author + name (browse first)' }
      const profile = await fetch(
        `https://plugin.tiny.technology/profile?login=${encodeURIComponent(input.author)}`,
        { cache: 'no-store', signal: AbortSignal.timeout(10_000) }
      ).then(r => r.json()).catch(() => null)
      const row = (profile?.tools || []).find((t: any) => t.name === input.name)
      if (!row?.code) return { ok: false, error: `tool '${input.name}' not found on @${input.author}'s profile` }

      // Validate BEFORE charging: a tool whose code no longer passes the
      // current sandbox rules can't be installed, so it must cost nothing.
      // (Charging first — the prior order — took the user's money and then
      // handed back a validation error with no tool and no refund: a
      // settle-before-serve gap. The storage write below is safe to charge
      // ahead of: its ref is stable per user+tool, so a retry after a
      // transient write failure is idempotently free AND still delivers.)
      const check = await runToolApi('validate', row.code)
      if (!check.ok) return { ok: false, error: `tool failed current sandbox rules: ${check.error || 'unknown'}` }

      // 💸 Paid tool installs (payments PR1): marketplace copies code at
      // install, so tool monetization = one-time purchase. Settle before
      // the copy; idempotent per user+tool (rebuying the same tool is free).
      const installRef = `install:${session.sub}:${input.author}/${input.name}`
      // Armed only when THIS call actually moved money (charged_micro > 0 &&
      // !already_settled) — so a failed storage write below can hand the charge
      // back. Mirrors the ask_tiny consult refund discipline (route.ts:588).
      let refundInstall = false
      // The one-time price the user actually paid on THIS install (0 = free /
      // self-owned). Surfaced in the success note so a PAID install can't debit
      // the wallet silently — every other money surface states its charge
      // (set_price, the chat paywall, pay_x402's confirm card), but the install
      // note used to just say "Installed!" with no amount. A stable-ref replay
      // (already_settled) was charged on an earlier attempt, so it's shown as
      // "already purchased — no charge" rather than billing language.
      let chargedMicro = 0
      let alreadyOwned = false
      try {
        const toolResource = `tool:${input.author}/${input.name}`
        const priced = await fetch(`https://plugin.tiny.technology/pay/pricing?resource=${encodeURIComponent(toolResource)}`,
          { signal: AbortSignal.timeout(10_000) })
          .then(r => r.json()).catch(() => ({ price_micro: 0 }))
        if (Number(priced?.price_micro) > 0) {
          const settle = await fetch('https://plugin.tiny.technology/pay/invoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
            body: JSON.stringify({
              payerId: session.sub,
              resource: toolResource,
              // Stable ref per user+tool: retries AND re-installs are free
              ref: installRef,
            }),
            signal: AbortSignal.timeout(10_000),
          }).then(r => r.json()).catch(() => null)
          if (!settle || settle.ok !== true) {
            return {
              ok: false, payment_required: true,
              error: settle?.error === 'insufficient_balance'
                ? `This tool costs ${usd(Number(priced.price_micro))} (one-time). The user's wallet has ${usd(Number(settle?.balance_micro || 0))} — top up at /wallet.`
                : 'Payment settlement failed for this install.',
            }
          }
          // Arm the refund ONLY when this call actually MOVED money — a real
          // debit, not an idempotent replay. An `already_settled` retry was
          // paid (and likely delivered) on an earlier attempt, so a failure
          // here must NOT claw it back — that would refund a tool the user may
          // already hold. A stable-ref retry AFTER a prior refund also reports
          // already_settled, so nothing re-arms (no double-refund). Same guard
          // as ask_tiny (route.ts:588).
          if (Number(settle.charged_micro) > 0 && !settle.already_settled) refundInstall = true
          // Record what to tell the user: a fresh debit shows the price, an
          // idempotent replay says "already purchased" (no new charge).
          chargedMicro = Number(settle.charged_micro) || 0
          alreadyOwned = settle.already_settled === true
        }
      } catch { /* pricing outage → free install (never block) */ }
      // Human-legible charge line appended to the success note. A CHARGE (money
      // moved) uses the shared Rule-B usd() — 2 decimals, up to 6 for sub-cent —
      // so "$0.50" not "$0.5", matching the wallet ledger + PayReceipt/paywall
      // confirm copy (the strip-trailing-zeros form is only for the per-message
      // RATE badge). Use the imported helper rather than an inline toLocaleString
      // copy so this can't drift from the canonical formatter (its own doc warns
      // against a bare micro/1e6 interpolation leaking a float artifact).
      const chargedUsd = usd(chargedMicro)
      const chargeNote = chargedMicro > 0
        ? (alreadyOwned
            ? ` You already purchased this tool — no new charge.`
            : ` Charged ${chargedUsd} (one-time) from your wallet — see /wallet.`)
        : ''

      const installed = await fetch('https://plugin.tiny.technology/tools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
        },
        body: JSON.stringify({
          userId: session.sub,
          name: row.name,
          description: `${row.description || row.name} [installed from @${input.author}]`,
          params: row.params_json || '{}',
          code: row.code,
        }),
        signal: AbortSignal.timeout(10_000),
      }).then(r => r.json()).then(d => d.ok
        ? { ...d, note: `Installed @${input.author}'s ${row.name}!${chargeNote} Call it as my_${d.name} starting NEXT message.` }
        : d
      ).catch(e => ({ ok: false, error: String(e) }))

      // Settle-before-serve: if a PAID install's storage write failed (a
      // MAX_TOOLS 429, a durable D1 error, or a transport blip), hand the
      // charge back so the user is never billed for a tool they didn't
      // receive. Idempotent /pay/refund by the stable ref; a no-op when the
      // install was free (refundInstall stays false). Without this, a debit
      // landed while the tool copy never did, with no clawback — the exact
      // gap ask_tiny's refund-on-failure closes for consults.
      if (refundInstall && installed?.ok !== true) {
        const rf = await fetch('https://plugin.tiny.technology/pay/refund', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
          body: JSON.stringify({ ref: installRef }),
          signal: AbortSignal.timeout(10_000),
        }).then(r => r.json()).catch(() => null)
        if (!rf?.ok) console.error('chat-refund-failed', JSON.stringify({ ref: installRef, kind: 'install', err: rf?.error || 'unreachable' }))
      }
      return installed
    },
  })

  const removeToolTool = tool({
    name: 'remove_tool',
    description: 'Delete one of the user\'s forged tools by name (without the my_ prefix).',
    inputSchema: z.object({
      name: z.string().describe('Tool name to delete'),
    }),
    callback: async (input) => {
      if (!session) return { ok: false, note: 'Login required.' }
      return fetch('https://plugin.tiny.technology/tools', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
        },
        body: JSON.stringify({ userId: session.sub, name: input.name.replace(/^my_/, '') }),
      }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
    },
  })

  // 🧬 Server-side persistent memory (issue #14 v2) — unlike remember/forget
  // (browser localStorage), memories live in D1 + a per-user-filtered
  // Vectorize index and follow the user across devices and tinys. Capacity
  // is real (5000 × 2KB); a full store rejects writes instead of silently
  // evicting old memories. Only for logged-in users.
  // 📱 Telegram (COMPARISON.md §2.2) — connect a BotFather bot; the worker
  // cron polls it every minute and this user's tiny answers.
  const telegramTool = tool({
    name: 'telegram',
    description: `Connect/manage the user's Telegram bot so a tiny answers their Telegram messages (polled every minute, works while they're away; replies come from the chosen tiny). Actions: setup (needs bot_token from @BotFather + tiny slug), status, allow_chat (authorize a chat id — the bot tells unknown chats their id), disable, remove. Inbound messages surface on the event bus.`,
    inputSchema: z.object({
      action: z.enum(['setup', 'status', 'allow_chat', 'disable', 'remove']),
      bot_token: z.string().optional().describe('BotFather token (setup only)'),
      tiny: z.string().optional().describe('Tiny slug that answers (setup; defaults to this tiny)'),
      chat_id: z.string().optional().describe('Chat id to authorize (allow_chat)'),
    }),
    callback: async (input) => {
      if (!session) return { ok: false, note: 'Login required — the bot attaches to the user account.' }
      const headers = {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      }
      const base = 'https://plugin.tiny.technology/telegram'
      if (input.action === 'status') {
        return fetch(`${base}?userId=${encodeURIComponent(session.sub)}`, { headers })
          .then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
      }
      if (input.action === 'remove') {
        return fetch(base, { method: 'DELETE', headers, body: JSON.stringify({ userId: session.sub }) })
          .then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
      }
      if (input.action === 'disable') {
        return fetch(base, { method: 'POST', headers, body: JSON.stringify({ userId: session.sub, enabled: 'false' }) })
          .then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))
      }
      if (input.action === 'allow_chat') {
        if (!input.chat_id) return { ok: false, error: 'chat_id required' }
        const current = await fetch(`${base}?userId=${encodeURIComponent(session.sub)}`, { headers })
          .then(r => r.json()).catch(() => ({}))
        const list = String(current?.bot?.allowedChats || '').split(',').map((x: string) => x.trim()).filter(Boolean)
        if (!list.includes(input.chat_id)) list.push(input.chat_id)
        return fetch(base, {
          method: 'POST', headers,
          body: JSON.stringify({ userId: session.sub, allowedChats: list.join(','), enabled: 'true' }),
        }).then(r => r.json()).then(d => d.ok ? { ...d, note: `Chat ${input.chat_id} authorized — the bot now answers there.` } : d)
          .catch(e => ({ ok: false, error: String(e) }))
      }
      // setup
      if (!input.bot_token) return { ok: false, error: 'bot_token required — get one from @BotFather on Telegram' }
      return fetch(base, {
        method: 'POST', headers,
        body: JSON.stringify({
          userId: session.sub,
          token: input.bot_token,
          tiny: input.tiny || tinyName || 'tiny',
          enabled: 'true',
        }),
      }).then(r => r.json()).then(d => d.ok
        ? { ...d, note: 'Bot connected in PAIRING mode: message it on Telegram, it replies with the chat id, then say "allow telegram chat <id>" here.' }
        : d
      ).catch(e => ({ ok: false, error: String(e) }))
    },
  })

  // 📱 use_telegram (use_aws pattern) — shared with job-run
  // (lib/chat/tools/platform.ts); the worker injects the stored token and
  // enforces the chat allowlist server-side.
  const useTelegramTool = makeUseTelegramTool(session?.sub)

  // 💻 use_device (tiny-node PR6) — reach the user's enrolled tiny-tech
  // daemons over the worker relay; the device's LOCAL agent executes.
  const useDeviceTool = makeUseDeviceTool(session?.sub)

  // 💰 wallet — READ-ONLY balance + recent ledger, shared with job-run
  // (lib/chat/tools/platform.ts). Closes the read gap: set_price and pay_x402
  // let the agent price and quote, but the only balance it ever saw was inside
  // a 402 failure string. Money-moving stays user-gated (confirm card, /wallet).
  const walletTool = makeWalletTool(session?.sub)

  // 🖼️ generate_image — on-device generation, ROUND-TRIP client tool (the
  // phone generates + uploads, the callback polls the result back into the
  // loop as a real image block). iOS-only mount for now: mounting it for a
  // surface with no executor would strand every call until the 90s timeout.
  const generateImageTool = makeGenerateImageTool(session?.sub)

  // 📸 screenshot — generate_image's twin (capture instead of generate), same
  // round-trip + ImageBlock return. Mounted for BOTH native apps (below): iOS
  // has the ReplayKit executor (Screenshot.swift), Android has the
  // MediaProjection executor (tools/Screenshot.kt + ScreenshotConsentActivity/
  // Service, commit 7283e57) — both consent-every-capture and post a result on
  // every path (ok/denied/error). The browser has no usable self-capture, so
  // it stays unmounted there (mounting without an executor strands calls to the
  // 90s timeout). See docs/use-device-screenshot-scoping-2026-07-23.md.
  const screenshotTool = makeScreenshotTool(session?.sub)

  // 🕶️ meta_take_photo — one photo through the user's Meta AI glasses,
  // screenshot's round-trip twin (the glasses camera instead of the screen).
  // iOS-only mount until the Android executor lands: the iOS client posts a
  // fast {ok:false} when no glasses are linked, so nothing strands.
  const metaTakePhotoTool = makeMetaTakePhotoTool(session?.sub)

  // 🎥 meta_record_video — toggle-recording through the glasses (start on
  // first call, collect on second). Same iOS-only mount as the photo tool.
  const metaRecordVideoTool = makeMetaRecordVideoTool(session?.sub)

  // 👂 meta_listen — N seconds of the glasses mic as an on-device transcript
  // (audio never uploads). Same iOS-only mount.
  const metaListenTool = makeMetaListenTool(session?.sub)

  // 🕶️ meta_glasses_status — instant hardware poll (link/ready/thermal).
  const metaGlassesStatusTool = makeMetaGlassesStatusTool(session?.sub)

  // 💎 nicla_* — the tiny necklace (Nicla Vision). Server-round-trip via the
  // worker relay (the necklace is a pull device) — no client executor, so
  // these mount on EVERY surface: web, both native apps, and voice.
  const niclaTakePhotoTool = makeNiclaTakePhotoTool(session?.sub)
  const niclaTakeVideoTool = makeNiclaTakeVideoTool(session?.sub)
  const niclaListenTool = makeNiclaListenTool(session?.sub)
  const niclaStatusTool = makeNiclaStatusTool(session?.sub)

  // 🎙️ nicla_voice_* — the OTHER necklace (Nicla Voice). Its own roster, not a
  // widened nicla_* filter: no WiFi, no camera, no relay mailbox, so it can only
  // be READ (wake events its paired phone forwarded), never commanded.
  const niclaVoiceStatusTool = makeNiclaVoiceStatusTool(session?.sub)
  const niclaVoiceWakesTool = makeNiclaVoiceWakesTool(session?.sub)
  // 🎤 The recorder half: commands the paired PHONE (its mic + on-device
  // transcription), never the board — the phone is a pull device with a real
  // relay mailbox, so like nicla_* this works from every surface.
  const niclaVoiceRecordTool = makeNiclaVoiceRecordTool(session?.sub)
  const niclaVoiceTranscriptsTool = makeNiclaVoiceTranscriptsTool(session?.sub)
  const niclaVoiceTranscriptTool = makeNiclaVoiceTranscriptTool(session?.sub)
  // 🐬 The Flipper rides its host laptop's node, so these work from any surface
  // — the same reach the necklace has, for hardware in another room.
  const flipperStatusTool = makeFlipperStatusTool(session?.sub)
  const flipperListenTool = makeFlipperListenTool(session?.sub)
  const flipperFilesTool = makeFlipperFilesTool(session?.sub)

  // learn/recall/unlearn definitions live in lib/chat/tools/memory.ts
  const learnTool = makeLearnTool(session)
  const recallTool = makeRecallTool(session)
  const unlearnTool = makeUnlearnTool(session)
  const conflictsTool = makeConflictsTool(session)
  const graphTool = makeGraphNeighborsTool(session)

  // 💬 User↔user messaging (send_message): D1-stored threads; the worker
  // fans delivery out to the recipient's Telegram bot + web push + event
  // ring. Sender identity comes from the session — never client-supplied.
  // DM tools live in lib/chat/tools/messages.ts so the VOICE bridge can
  // mount the same session-bound objects (/api/voice/tool).
  const sendMessageTool = makeSendMessageTool(session, tinyName || '')
  const readMessagesTool = makeReadMessagesTool(session)

  // 🎚 manage_tools (careless pattern with PROTECTED_TOOLS): the agent can
  // disable noisy tools per user — but never its own recovery tools, so it
  // can't brick itself.
  const manageToolsTool = tool({
    name: 'manage_tools',
    description: `Enable/disable tools for this user (persists across sessions). Actions: list (all tools + status), disable (name), enable (name). Protected tools that can never be disabled: ${PROTECTED_TOOLS.join(', ')}. Disabled tools are not mounted next request.`,
    inputSchema: z.object({
      action: z.enum(['list', 'disable', 'enable']),
      name: z.string().optional().describe('Tool name (disable/enable)'),
    }),
    callback: async (input) => {
      if (!session) return { ok: false, note: 'Login required — tool preferences attach to the user account.' }
      const headers = {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      }
      const current = new Set(disabledToolsRaw.split(',').map((t: string) => t.trim()).filter(Boolean))
      if (input.action === 'list') {
        return {
          ok: true,
          disabled: Array.from(current),
          protected: PROTECTED_TOOLS,
          note: 'Every other built-in/forged/dynamic tool is enabled.',
        }
      }
      if (!input.name) return { ok: false, error: 'name required' }
      const target = input.name.trim()
      if (input.action === 'disable') {
        if (PROTECTED_TOOLS.includes(target)) {
          return { ok: false, error: `'${target}' is protected and cannot be disabled (recovery tool).` }
        }
        current.add(target)
      } else {
        current.delete(target)
      }
      return fetch('https://plugin.tiny.technology/prefs', {
        method: 'POST', headers,
        body: JSON.stringify({ userId: session.sub, key: 'disabled_tools', value: Array.from(current).join(',') }),
      }).then(r => r.json()).then(d => d.ok
        ? { ok: true, disabled: Array.from(current), note: `Takes effect NEXT message (tools mount per request).` }
        : d
      ).catch(e => ({ ok: false, error: String(e) }))
    },
  })

  // 🎨 Theme engine (careless theme-engine pattern) — the client watches
  // for this toolCall and applies CSS vars live; persistence rides the
  // worker /prefs KV so the theme follows the account across devices.
  // 💸 set_price (payments PR1) — owners monetize by talking to their tiny.
  const setPriceTool = tool({
    name: 'set_price',
    description: `Monetize what the user OWNS (session-verified). Price a TINY per message, or a FORGED TOOL as a one-time marketplace purchase. price_usd 0 makes it free again. Buyers pay from their tiny wallet; the owner earns the price minus a flat $0.001 platform fee. Balances/earnings at /wallet.`,
    inputSchema: z.object({
      tiny: z.string().optional().describe('Name of a tiny to price per message (owned by the current user)'),
      tool: z.string().optional().describe('Name of a forged tool to price as a one-time install purchase (owned by the current user)'),
      price_usd: z.number().min(0).max(100).describe('Price in USD (e.g. 0.01). 0 = free.'),
    }),
    callback: async (input) => {
      if (!session) return { error: 'login required', response: 'Ask the user to sign in first — pricing requires an authenticated owner.' }
      let resource: string
      let label: string
      if (input.tool) {
        // Canonicalize to the SAME form the forge stores under (route.ts ~837:
        // `.toLowerCase().replace(/[^a-z0-9_]/g,'_')`) AFTER stripping the `my_`
        // display prefix. Both install-charge read sites — the "Use this tool"
        // button (tools/install/route.ts) and the `marketplace` tool (~984) —
        // key `/pay/pricing` off the canonical stored name. If set_price wrote a
        // raw name (e.g. "My Cool Tool" from natural-language phrasing), the
        // price lands under a key no install ever reads → the tool installs FREE
        // and the owner earns nothing while set_price reports ok. The tiny branch
        // already slugifies; the tool branch must match its own write source.
        const toolName = String(input.tool).replace(/^my_/, '').toLowerCase().replace(/[^a-z0-9_]/g, '_')
        if (!toolName) return { error: 'invalid tool name' }
        resource = `tool:${session.login}/${toolName}`
        label = `tool my_${toolName}`
      } else if (input.tiny) {
        const slug = slugify(String(input.tiny), { lower: true, strict: true })
        if (!slug) return { error: 'invalid name' }
        resource = `tiny:${slug}`
        label = slug
      } else {
        return { error: 'pass tiny OR tool' }
      }
      // Quantize to micro-USDC ONCE and branch on the STORED value, not raw
      // price_usd: a sub-micro price (e.g. 0.0000004) is > 0 so the raw-value
      // branch would claim "now costs …" while Math.round(…*1e6) stores 0 =
      // FREE — a lying confirmation. Also formats via the shared usd() so the
      // echoed figure is Rule-B ("$0.50" not "$0.5") and never leaks a float
      // artifact / scientific notation (matches the C99 paid-install note +
      // every other agent-relayed money string, C101/102/107).
      const priceMicro = Math.round(input.price_usd * 1_000_000)
      const r = await fetch('https://plugin.tiny.technology/pay/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        body: JSON.stringify({ ownerId: session.sub, resource, price_micro: priceMicro }),
      }).then(res => res.json()).catch(e => ({ error: String(e?.message || e) }))
      if (r.error) return { ok: false, error: r.error }
      return {
        ok: true, resource, price_usd: input.price_usd,
        response: priceMicro > 0
          ? `${label} now costs ${usd(priceMicro)}${input.tool ? ' (one-time install)' : ' per message'}. Earnings land in the owner's wallet (/wallet), minus the flat $0.001 fee.`
          : `${label} is free again.`,
      }
    },
  })

  const payX402Tool = tool({
    name: 'pay_x402',
    // The funds phrase follows the deployment's chain (lib/chat/prompt.ts) — on a
    // self-hosted chain "USDC on Base" named a network the balance isn't on, in the
    // one description the agent reads before quoting a price to somebody.
    description: `Request payment to ANOTHER AI agent's paid endpoint over the open x402 protocol, from the signed-in user's tiny wallet (${walletFundsPhrase(paymentsNetwork())}). Use this to consult a priced tiny or paid API on the user's behalf — e.g. its x402 URL like https://tiny.technology/api/x402/chat/<name>. IMPORTANT: this does NOT spend money — it returns a QUOTE, and the USER must explicitly approve the payment (they tap a confirm card in the UI). You cannot approve on their behalf. After calling this, tell the user what it will cost and that you're awaiting their approval; do NOT claim the payment succeeded. Only allowlisted hosts (tiny.technology by default). Requires a signed-in user with a funded wallet (/wallet).`,
    inputSchema: z.object({
      url: z.string().describe('The x402 endpoint URL to pay (https, allowlisted host). e.g. https://tiny.technology/api/x402/chat/<tiny-name>'),
      message: z.string().describe('The message/prompt to send to the paid service'),
      max_spend_micro: z.number().int().positive().optional().describe('Optional cap in micro-USDC (1e6 = $1) for this single payment. Only lowers the platform ceiling.'),
    }),
    callback: async (input) => {
      if (!session) return { ok: false, error: 'login required', response: 'Ask the user to sign in and fund their wallet (/wallet) — paying another agent spends from their balance.' }
      try {
        // Quote-only: /api/x402/pay returns a signed quote and moves NO money.
        // The client renders a confirm card; the user's tap calls the execute
        // route (PUT) with this quote. The agent cannot settle on its own.
        const r = await fetch(`${new URL(req.url).origin}/api/x402/pay`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Forward the caller's auth so /api/x402/pay resolves the SAME
            // session (the quote is bound to, and spendable by, that user only).
            cookie: req.headers.get('cookie') || '',
            authorization: req.headers.get('authorization') || '',
          },
          body: JSON.stringify({ url: input.url, message: input.message, max_spend_micro: input.max_spend_micro }),
        }).then(res => res.json()).catch(e => ({ ok: false, error: String(e?.message || e) }))
        if (!r.ok) {
          return {
            ok: false, payment_required: Boolean(r.payment_required), error: r.error,
            response: r.payment_required
              ? `Couldn't quote payment: ${r.error}`
              : `x402 quote failed: ${r.error || 'unknown error'}`,
          }
        }
        // The target was FREE: /api/x402/pay's probe got a 200 (not a 402), so it
        // relayed the service's answer with paid_micro:0 and NO quote. There's
        // nothing to approve — surface the actual answer, not a "$NaN awaiting
        // approval" prompt (Number(undefined) price). The client's PayReceipt
        // shows "No payment needed" for a quote-less ok result; keep the tool
        // result consistent with that (requires_confirmation:false).
        if (!r.quote) {
          // Unwrap OUR OWN x402/chat envelope. tiny.technology is the default
          // (and usually only) allowlisted host, so the common free case is an
          // agent consulting another tiny that happens to be free — /api/x402/chat
          // answers 200 with { tiny, response, paid_micro }, which the pay route
          // relays verbatim as r.response (an OBJECT). Without unwrapping, the
          // else-branch JSON.stringify handed the model `{"tiny":"x","response":
          // "the answer",…}` — a raw JSON blob it then quotes at the user instead
          // of the clean answer. Pull out the inner `.response` string; a genuine
          // third-party service returning an opaque object still stringifies.
          const relayed = r.response
          const answer = typeof relayed === 'string'
            ? relayed
            : (relayed && typeof relayed === 'object' && typeof relayed.response === 'string'
                ? relayed.response
                : (relayed != null ? JSON.stringify(relayed) : 'This service responded without charging — nothing was paid.'))
          return {
            ok: true, requires_confirmation: false, paid_micro: 0,
            url: input.url,
            response: answer,
          }
        }
        // A quote — NOT a receipt. The structured fields drive the client's
        // approve card (PayReceipt/confirm). The model must not pretend it paid.
        return {
          ok: true, requires_confirmation: true,
          quote: r.quote, price_micro: r.price_micro, network: r.network,
          payee: r.payee, expires_at: r.expires_at,
          message: input.message, url: input.url,
          response: `Payment of ${usd(Number(r.price_micro))} to this service is ready — awaiting the user's approval. It has NOT been paid yet; the user must tap Approve.`,
        }
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
  })

  // 💸 make_payment — P2P sends ("send @alice $2"), pay_x402's sibling. Same
  // confirm-every-payment contract: this mints a QUOTE; the money moves only
  // when the user taps Approve on the card (PUT /api/x402/pay → the worker's
  // atomic /pay/transfer). The agent can never press that button.
  const makePaymentTool = tool({
    name: 'make_payment',
    description: `Send money from the signed-in user's wallet (${walletFundsPhrase(paymentsNetwork())}) to ANOTHER tiny user, by their @login — e.g. "send @alice $2 for lunch". IMPORTANT: this does NOT move money — it returns a QUOTE, and the USER must explicitly approve it (they tap a confirm card in the UI); you cannot approve on their behalf, so never claim the money was sent after calling this. Max ${usd(25_000_000)} per send. Use pay_x402 to pay a priced tiny/x402 endpoint; use this for direct person-to-person sends. The wallet tool shows the balance if you need it first.`,
    inputSchema: z.object({
      to: z.string().describe("Recipient's tiny login, e.g. @alice (with or without the @)"),
      amount_usd: z.number().positive().max(25).describe('Amount to send in USD, e.g. 1.50'),
      note: z.string().max(280).optional().describe('Optional note — shown with the approval and bound into the quote'),
    }),
    callback: async (input) => {
      if (!session) return { ok: false, error: 'login required', response: 'Ask the user to sign in first — sending money spends from their wallet.' }
      // Quantize ONCE and act on the stored value (same rule as set_price):
      // a sub-micro amount_usd rounds to 0 and must be refused, not "sent".
      const amountMicro = Math.round(input.amount_usd * 1_000_000)
      if (amountMicro <= 0) return { ok: false, error: 'amount rounds to $0.00 — nothing to send' }
      try {
        // Quote-only mint; forward the caller's auth so the quote binds to the
        // same session (identical to pay_x402's forwarding).
        const r = await fetch(`${new URL(req.url).origin}/api/x402/pay`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            cookie: req.headers.get('cookie') || '',
            authorization: req.headers.get('authorization') || '',
          },
          body: JSON.stringify({ to: input.to, amount_micro: amountMicro, message: input.note || '' }),
        }).then(res => res.json()).catch(e => ({ ok: false, error: String(e?.message || e) }))
        if (!r.ok || !r.quote) {
          return { ok: false, error: String(r.error || 'could not prepare the send'), response: `Couldn't prepare the payment: ${r.error || 'unknown error'}` }
        }
        // A quote — NOT a receipt. message/url ride the result so the clients'
        // confirm card can execute and re-quote with its existing plumbing
        // (url carries the transfer: sentinel, never fetched as a URL).
        return {
          ok: true, requires_confirmation: true, transfer: true,
          quote: r.quote, price_micro: r.price_micro, network: r.network,
          payee: r.payee, expires_at: r.expires_at,
          message: input.note || '', url: `transfer:${r.to || input.to}`, to: r.to,
          response: `${r.summary || `Sending ${usd(amountMicro)} to ${r.payee}`} — awaiting the user's approval. It has NOT been sent yet; the user must tap Approve.`,
        }
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
  })

  const setThemeTool = tool({
    name: 'set_theme',
    description: `Change the page's visual theme live. Presets: tiny (default green/black), cyberpunk, ocean, forest, sunset, dracula, nord, amber. You may also pass a custom accent and/or background hex to override. Use preset "tiny" or reset:true to restore the default. The change applies instantly and persists to the user's account when signed in.`,
    inputSchema: z.object({
      preset: z.string().optional().describe('Preset name: tiny | cyberpunk | ocean | forest | sunset | dracula | nord | amber'),
      accent: z.string().optional().describe('Custom accent color hex, e.g. #ff6600'),
      background: z.string().optional().describe('Custom page background hex, e.g. #0d1b2a'),
      reset: z.boolean().optional().describe('true restores the default tiny theme'),
    }),
    callback: async (input) => {
      const HEX = /^#[0-9a-fA-F]{6}$/
      const PRESETS: Record<string, { accent: string; bg: string }> = {
        tiny: { accent: '#00FF88', bg: '#000000' },
        cyberpunk: { accent: '#ff00ff', bg: '#0a0a1a' },
        ocean: { accent: '#5da9e9', bg: '#0d1b2a' },
        forest: { accent: '#8fce8f', bg: '#1a2618' },
        sunset: { accent: '#ffa07a', bg: '#1f1418' },
        dracula: { accent: '#bd93f9', bg: '#282a36' },
        nord: { accent: '#88c0d0', bg: '#2e3440' },
        amber: { accent: '#ffb000', bg: '#100c00' },
      }
      const presetName = (input.preset || '').toLowerCase().trim()
      const isReset = input.reset || presetName === 'tiny'
      if (!isReset && !PRESETS[presetName] && !input.accent && !input.background) {
        return { ok: false, error: `unknown preset '${input.preset}' — pick one of ${Object.keys(PRESETS).join(', ')} or pass accent/background hex` }
      }
      if (input.accent && !HEX.test(input.accent)) return { ok: false, error: 'accent must be 6-digit hex like #ff6600' }
      if (input.background && !HEX.test(input.background)) return { ok: false, error: 'background must be 6-digit hex' }

      const base = PRESETS[presetName]
      const theme = isReset ? null : {
        preset: base ? presetName : 'custom',
        accent: input.accent || base?.accent || PRESETS.tiny.accent,
        bg: input.background || base?.bg || PRESETS.tiny.bg,
      }

      // Persist to the account when signed in (client applies live regardless)
      let persisted = false
      if (session) {
        const res = await fetch('https://plugin.tiny.technology/prefs', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
          },
          body: JSON.stringify({ userId: session.sub, key: 'theme', value: theme ? JSON.stringify(theme) : '' }),
        }).then(r => r.json()).catch(() => null)
        persisted = !!res?.ok
      }

      return {
        ok: true,
        theme: theme || { preset: 'tiny', accent: PRESETS.tiny.accent, bg: PRESETS.tiny.bg },
        applied: 'client-side (live)',
        persisted: persisted ? 'account (all devices)' : 'this browser only (sign in to sync)',
      }
    },
  })

  // 🖌️ Page customization beyond theme vars — arbitrary CSS and JS.
  // The client applies both live (render_ui already grants live-JS trust);
  // PERSISTED JS re-runs on every page load, so the client demands a
  // one-time user approval per script before executing stored copies.
  const customizePageTool = tool({
    name: 'customize_page',
    description: `Inject custom CSS and/or JavaScript into the page — restyle anything (fonts, animations, layout) or add behavior (confetti, keyboard shortcuts, ambient effects). CSS/JS each ≤8KB. persist:true saves to the user's account so it re-applies on every visit (stored JS asks the user's approval once before auto-running). Use action:"clear" to remove customizations. Prefer set_theme for simple color changes.`,
    inputSchema: z.object({
      action: z.enum(['apply', 'clear']).default('apply'),
      css: z.string().optional().describe('CSS rules, e.g. "body { font-family: monospace } .message { border-radius: 0 }"'),
      js: z.string().optional().describe('JavaScript to run in the page (full DOM access, like render_ui)'),
      persist: z.boolean().optional().describe('true → save to account (signed-in only); default false = this session only'),
      target: z.enum(['css', 'js', 'both']).optional().describe('For clear: what to remove (default both)'),
    }),
    callback: async (input) => {
      const MAX = 8192
      if (input.action === 'clear') {
        const target = input.target || 'both'
        if (session) {
          const clears: Promise<any>[] = []
          const clearPref = (key: string) => fetch('https://plugin.tiny.technology/prefs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
            body: JSON.stringify({ userId: session.sub, key, value: '' }),
          }).catch(() => null)
          if (target !== 'js') clears.push(clearPref('custom_css'))
          if (target !== 'css') clears.push(clearPref('custom_js'))
          await Promise.all(clears)
        }
        return { ok: true, cleared: input.target || 'both', applied: 'client-side (live)' }
      }

      if (!input.css && !input.js) return { ok: false, error: 'provide css and/or js (or action:"clear")' }
      if (input.css && input.css.length > MAX) return { ok: false, error: `css too large (max ${MAX} chars)` }
      if (input.js && input.js.length > MAX) return { ok: false, error: `js too large (max ${MAX} chars)` }

      let persisted = false
      if (input.persist && session) {
        const saves: Promise<any>[] = []
        const savePref = (key: string, value: string) => fetch('https://plugin.tiny.technology/prefs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
          body: JSON.stringify({ userId: session.sub, key, value }),
        }).then(r => r.json()).catch(() => null)
        if (input.css) saves.push(savePref('custom_css', input.css))
        if (input.js) saves.push(savePref('custom_js', input.js))
        const results = await Promise.all(saves)
        persisted = results.every(r => r?.ok)
      }

      return {
        ok: true,
        applied: 'client-side (live)',
        css: input.css ? `${input.css.length} chars` : undefined,
        js: input.js ? `${input.js.length} chars` : undefined,
        persisted: input.persist
          ? (persisted ? 'account — re-applies on every visit (stored JS needs one-time user approval)' : 'FAILED to persist (not signed in?)')
          : 'session only',
      }
    },
  })

  // 🧬 Memory context block (issue #14 v2) — recent entries + semantic
  // matches for the current message. The full store lives server-side;
  // recall reaches anything not shown here.
  const recentMemories: any[] = Array.isArray(userMemory?.learnings) ? userMemory.learnings : []
  const relevantMemories: any[] = Array.isArray(userMemory?.relevant) ? userMemory.relevant : []
  const recentIds = new Set(recentMemories.map((l: any) => l.id))
  const semanticOnly = relevantMemories.filter((l: any) => !recentIds.has(l.id))
  const memoryTotal = Number(userMemory?.total || 0)
  const memoryBlock = memoryTotal
    ? `# Memory (server-side bitemporal graph — ${memoryTotal} live facts; showing recent + relevant. recall searches everything; closed facts are history, not recall)
${recentMemories.map((l: any) => `- [${l.id}] ${l.content}`).join('\n')}
${semanticOnly.length ? `Relevant to this message (semantic recall):\n${semanticOnly.map((l: any) => `- [${l.id}] ${l.content}`).join('\n')}\n` : ''}The ids above are usable everywhere: learn(content, supersedes: [id]) closes an outdated fact and links its replacement; learn(content, edges: [{rel, dst: id}]) connects related facts (part_of/authored/relates_to/about, scope for context); recall(query, hops: 1) walks edges to connected facts; memory_conflicts finds and resolves contradictions; unlearn(id) closes (never deletes — history survives).
`
    : ''

  // Identity-first "soul" prompt — extracted to lib/chat/prompt.ts so
  // identity edits are reviewable in one pure, testable file.
  const systemPrompt = buildSoulPrompt({
    tinyName,
    tinyData,
    tinyStats,
    retrieveSummary,
    clientMetadata,
    userContext,
    memoryBlock,
    userEvents,
    systemMessages,
    tinySystemPrompt,
    tinySession,
    messageIndex: conversationMessages.length,
    // Which chain this deployment settles on, so the economy paragraph names the
    // real source of credit. The agent is what ANSWERS "how do I get credit?" —
    // reciting "buy USDC on Base" on a chain we own costs the user real money for
    // a token this deployment can't accept (report §1.2 item 8).
    paymentsNetwork: paymentsNetwork(),
    // Keep the prompt honest about the mount below: promising customize_page to
    // a visitor who can't call it produces a confident report of work that
    // never happened.
    canCustomizePage: callerOwnsThisTiny,
  })

  // 🎚 manage_tools filter: drop user-disabled tools at mount time.
  // Protected tools are exempt (the agent must always be able to recover),
  // and MCP clients are unaffected (managed via tiny config, not names).
  const disabledSet = parseDisabledTools(disabledToolsRaw)
  // Native apps render render_ui from props (never executing componentCode) —
  // they announce themselves via x-tiny-session, and get the props-required
  // tool contract so the model can't emit code-only calls that degrade to a
  // "view on web" fallback card on the phone.
  const isNativeApp = tinySession === 'tiny-ios' || tinySession === 'tiny-android'
  const allNamedToolsUnfiltered = [
    createAiTool,
    modifyAiTool,
    getTinyTool,
    listTinyTool,
    retrieveTool,
    isNativeApp ? renderUiNativeTool : renderUiTool,
    ...(tinySession === 'tiny-ios' ? [generateImageTool, metaTakePhotoTool, metaRecordVideoTool, metaListenTool, metaGlassesStatusTool] : []),
    // 🤖 Android now carries the full glasses set (fleet/Wearables{,Recorder,
    // Listener}.kt) — same executors-per-mount rule as iOS.
    ...(tinySession === 'tiny-android' ? [metaTakePhotoTool, metaRecordVideoTool, metaListenTool, metaGlassesStatusTool] : []),
    // screenshot ships on BOTH native apps (iOS ReplayKit + Android
    // MediaProjection executors both verified complete); generate_image is
    // iOS-only (no Android on-device image gen yet).
    ...(isNativeApp ? [screenshotTool] : []),
    // 💎 The necklace answers over the internet — every surface gets it.
    niclaTakePhotoTool, niclaTakeVideoTool, niclaListenTool, niclaStatusTool,
    // 🎙️ Read-only, and cheap: both hit the registry/event ring, not hardware.
    niclaVoiceStatusTool, niclaVoiceWakesTool,
    // 🎤 The recorder rides the phone's relay mailbox; transcripts are D1 reads.
    niclaVoiceRecordTool, niclaVoiceTranscriptsTool, niclaVoiceTranscriptTool,
    flipperStatusTool, flipperListenTool, flipperFilesTool,
    // 🗺️ Agent map controls — web only: the browser hosts the live map
    // bridge (📍 map-mode / the /map page); native map screens are modal
    // and have no bridge yet.
    // Map tools on every client: web executes via __tinyMapBridge,
    // Android via AgentMap.kt, iOS via AgentMap.swift.
    addMapMarkerTool, flyToLocationTool, clearMapMarkersTool, removeMapMarkerTool, flyToMarkerTool, tourMarkersTool,
    speakTool,
    vibrateTool,
    flashlightTool,
    copyToClipboardTool,
    setBrightnessTool,
    playSoundTool,
    scheduleAlertTool,
    openUrlTool,
    cancelAlertsTool,
    setThemeTool,
    // 🔒 customize_page hands the model ARBITRARY JS in the tiny.technology
    // origin — beside the session cookie and the BYO-model API key in
    // localStorage. It was mounted for every turn, including on tinys the
    // caller merely VISITED, whose systemPrompt/systemKnowledge/data are
    // attacker-authored text the model reads as instructions. Mount it only for
    // the tiny's owner: a tool that isn't offered can't be talked into firing,
    // and against prompt injection that is the only layer that holds.
    // (The browser refuses non-owner JS too — the effect fires on
    // beforeToolCallEvent, so no server check can stop the live run.
    // See lib/chat/page-code-trust.ts.)
    ...(callerOwnsThisTiny ? [customizePageTool] : []),
    walletTool,
    setPriceTool,
    payX402Tool,
    makePaymentTool,
    suggestFollowupsTool,
    rememberTool,
    manageMessagesTool,
    manageToolsTool,
    learnTool,
    recallTool,
    unlearnTool,
    conflictsTool,
    graphTool,
    scheduleTool,
    telegramTool,
    useTelegramTool,
    useDeviceTool,
    sendMessageTool,
    readMessagesTool,
    createToolTool,
    removeToolTool,
    installToolTool,
    marketplaceTool,
    ...forgedTools,
    forgetTool,
    askTinyTool,
    spawnAgentsTool,
    http,
    ...dynamicTools,
  ]
  const allNamedTools = filterTools(allNamedToolsUnfiltered, disabledSet)

  const agent = new Agent({
    model,
    systemPrompt,
    messages: historyMessages,
    // Dedupe by name (built-ins first, so they win) — the ToolRegistry
    // THROWS on a duplicate, and dynamic tools carry user-controlled
    // operationIds from retrieved universe tinys. Without this, a public
    // tiny with a skill named after a built-in DoSes every user who
    // retrieves it.
    tools: dedupeToolsByName([
      ...allNamedTools,
      ...mcpClients,
    ]),
    printer: false,
  })

  // ==========================================================================
  // Streaming — SDK 1.10 wraps model deltas in modelStreamUpdateEvent.
  // We unwrap + normalize every event into the wire format the client expects,
  // and forward tool progress, usage metadata and lifecycle events too.
  // ==========================================================================
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      // Did the caller receive anything of value? A paid charge is refunded
      // (below) only when a stream error leaves this false — a partial answer
      // is a delivered answer, so this can't be gamed by streaming-then-killing.
      let deliveredOutput = false
      // Monotonic sequence — lets the client DETECT dropped events
      // (scrambled-streaming report: deltas vanish mid-stream; a seq gap
      // pins the loss to the wire vs. upstream model)
      let seq = 0
      const send = (payload: Record<string, any>) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...payload, seq: seq++ })}\n\n`))
        } catch { closed = true }
      }

      // SSE keepalive — comment frames every 15s so proxies/edge don't kill
      // the connection during long tool calls or slow model turns.
      const keepalive = setInterval(() => {
        if (closed) return
        try { controller.enqueue(encoder.encode(': ping\n\n')) } catch { closed = true }
      }, 15000)

      // Stop work if the client disconnects — agent.cancel() propagates to
      // the model provider (stops upstream inference + billing), not just
      // our event loop (issue #13)
      let activeAgent: Agent = agent
      const onAbort = () => {
        closed = true
        try { activeAgent.cancel() } catch { /* already finished */ }
      }
      req.signal?.addEventListener?.('abort', onAbort)

      // Assistant text accumulated across the turn — fed into per-tiny private
      // turn memory after a clean finish (see the store hook below). Only the
      // visible answer text; reasoning/tool payloads are excluded.
      let assistantText = ''

      // 🏷️ toolUseId → name for THIS turn. An afterToolCallEvent without
      // `toolUse` would otherwise reach the clients unnamed, and every native
      // client keys its result handling on the name (iOS drops the branch
      // outright) — so a pay_x402 quote card, a spawn_agents batch result, or a
      // tool chip's ✓ would silently never render. Declared outside `pump` so
      // the overflow retry below inherits pairings learned before the retry.
      const toolNames = new Map<string, string>()

      // Pump an agent's event stream to the client (used by the normal path
      // and the overflow-retry path below)
      const pump = async (a: Agent) => {
        // Full content blocks (text + image/document attachments) — falls
        // back to plain text when the client sent a bare string message
        const agentInput = lastMessageContent.length ? lastMessageContent : lastMessageText
        for await (const event of a.stream(agentInput)) {
          if (closed) break
          const e = event as any

          const payload = normalizeAgentEvent(e, resolvedModelId, toolNames)
          if (payload) {
            // Real work the caller paid for (text/reasoning/tool call) gates
            // the refund below — see isDeliveredOutput for the exact rule.
            if (isDeliveredOutput(payload)) deliveredOutput = true
            if (typeof payload.textDelta === 'string') assistantText += payload.textDelta
            send(payload)
          }
        }
      }

      // Hand back a settle-before-serve charge (idempotent /pay/refund by ref)
      // when the paid turn delivered NOTHING. Shared by the clean-finish path
      // and the stream-error catch below so an empty answer is never a silent
      // charge — the exact mirror of the x402 relay's `settledRef && !delivered`
      // refund. Nulls chargedRef so the two guarded call sites can't double-fire
      // (and /pay/refund is idempotent by ref regardless).
      const refundIfUndelivered = async () => {
        if (!chargedRef || deliveredOutput) return
        const ref = chargedRef
        chargedRef = null
        const refunded = await fetch('https://plugin.tiny.technology/pay/refund', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
          body: JSON.stringify({ ref }),
        }).then(r => r.json()).catch(() => null)
        if (!refunded?.ok) {
          console.error('chat-refund-failed', JSON.stringify({ ref, err: refunded?.error || 'unreachable' }))
        }
      }

      // Self-healing context overflow (careless useAgent pattern, issue #9):
      // provider rejects context as too large → drop the older half of the
      // seeded history (whole messages, keeping order) and retry ONCE.
      // Overflow errors arrive before any tokens, so a clean retry is safe.
      try {
        try {
          await pump(agent)
        } catch (error) {
          if (!isOverflowError(error) || historyMessages.length < 4 || closed) throw error
          console.warn('Context overflow — dropping older half of history and retrying once')
          send({ type: 'contextCompacted', dropped: Math.floor(historyMessages.length / 2) })
          const retryAgent = new Agent({
            model,
            systemPrompt,
            messages: historyMessages.slice(Math.floor(historyMessages.length / 2)),
            tools: agent.tools,
            printer: false,
          })
          activeAgent = retryAgent
          await pump(retryAgent)
        }

        if (!closed) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          closed = true
        }

        // Paid turn that finished CLEANLY but delivered nothing (empty/filtered
        // completion, zero deltas, no tool call) — refund. Without this a
        // non-throwing empty answer keeps the caller's money, while the SAME
        // empty answer over the x402 relay is refunded (route.ts settledRef &&
        // !delivered): a real charge asymmetry between the two paid paths.
        await refundIfUndelivered()

        // 🔒🧠 Private-tiny turn memory ("store every turn in vector index so
        // it remembers more things"). Only when the signed-in caller is the
        // VOUCHED OWNER of a genuinely PRIVATE tiny (tinyData carries both from
        // /get, which authorized this same session) — a public tiny or a
        // visitor never accumulates a stored transcript. Fire-and-forget: the
        // worker re-verifies ownership/privacy, embeds into the MEMORY index
        // and writes `notes` — the exact shape retrieve.ts already recalls into
        // the next turn's system prompt. Never blocks or fails the response.
        if (session?.sub && tinyData?.private && tinyData?.isAuthorized &&
            (lastMessageText.trim() || assistantText.trim())) {
          fetch(`${process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'}/turns`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
            body: JSON.stringify({
              name: tinyName,
              userId: session.sub,
              user: lastMessageText.slice(0, 4000),
              assistant: assistantText.slice(0, 4000),
            }),
            signal: AbortSignal.timeout(10_000),
          }).catch(() => { /* best-effort; recall degrades, chat doesn't */ })
        }
      } catch (error) {
        console.error('Stream error:', error)
        // Settle-before-serve took the caller's money up front. If the model
        // failed before delivering anything, hand it back — /pay/refund is
        // idempotent by ref (payments.ts), so a retry/duplicate is harmless.
        // A partial answer is not refunded (deliveredOutput gates it). Shared
        // with the clean-finish path so both empty outcomes refund identically.
        await refundIfUndelivered()
        if (!closed) {
          send({ type: 'error', error: friendlyError(error) })
          try {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          } catch { /* already closed */ }
          closed = true
        }
      } finally {
        clearInterval(keepalive)
        req.signal?.removeEventListener?.('abort', onAbort)
      }
    },
    cancel() {
      // Client went away — nothing else to do; `closed` flag stops the loop
      // on next event via the abort listener.
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
