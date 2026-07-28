/**
 * Generic Telegram Bot API proxy (use_telegram tool, use_aws pattern) —
 * the agent calls ANY Bot API method by name; the worker injects the
 * user's stored bot token so it never reaches the model or the client.
 *
 *   POST /telegram/api { userId, method, params? } → Telegram's response
 *
 * Guardrails:
 *   - method must be a bare method name (no slashes/dots — the token and
 *     URL shape stay under our control)
 *   - polling + webhook methods are BLOCKED: getUpdates would steal
 *     updates from the cron poller (offset CAS), set/deleteWebhook would
 *     disable polling entirely
 *   - any chat_id-bearing param must target an ALLOWLISTED chat (same
 *     allowlist the poller enforces) — a prompt-injected agent can't
 *     message strangers. While pairing (empty allowlist) sends are blocked.
 *   - params ≤ 64KB; JSON-only (sendPhoto/sendVideo etc. via public URLs
 *     or file_id — Telegram fetches URLs itself; no multipart needed)
 */
import { OpenAPIRoute, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { emitEvent } from "./events";

const BLOCKED_METHODS = new Set([
  'getupdates',        // steals updates from the cron poller
  'setwebhook',        // kills polling
  'deletewebhook',
  'logout',            // invalidates the token's cloud session
  'close',
]);

const MAX_PARAMS_BYTES = 64 * 1024;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Collect every chat id a params object targets (chat_id, from_chat_id…). */
function targetChatIds(params: Record<string, any>): string[] {
  const ids: string[] = [];
  for (const key of ['chat_id', 'from_chat_id']) {
    const v = params?.[key];
    if (v !== undefined && v !== null && v !== '') ids.push(String(v));
  }
  return ids;
}

export class TelegramApiCall extends OpenAPIRoute {
  static schema = {
    tags: ["Telegram"],
    summary: "Internal: proxy any Bot API method with the user's stored token.",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      method: new Str({ required: true, description: "Bot API method, e.g. sendPhoto." }),
      params: new Str({ required: false, description: "JSON params object for the method." }),
    },
    responses: { "200": { description: "Telegram response", schema: { response: "Proxied" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, method, params } = data.body;
    if (!userId || !method) return json({ error: "userId and method required" }, 400);

    const m = String(method).trim();
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(m)) {
      return json({ error: "invalid method name" }, 400);
    }
    if (BLOCKED_METHODS.has(m.toLowerCase())) {
      return json({
        error: `method '${m}' is blocked: polling/webhook/session methods would break the bot's message loop`,
      }, 400);
    }

    let p: Record<string, any> = {};
    if (params) {
      if (String(params).length > MAX_PARAMS_BYTES) return json({ error: "params too large (64KB max)" }, 400);
      try { p = JSON.parse(String(params)); } catch { return json({ error: "params must be valid JSON" }, 400); }
      if (!p || typeof p !== 'object' || Array.isArray(p)) return json({ error: "params must be a JSON object" }, 400);
    }

    const bot = await env.DB.prepare("SELECT * FROM telegram_bots WHERE user_id = ?")
      .bind(String(userId)).first();
    if (!bot) return json({ error: "no Telegram bot connected — set one up first (Settings → Connect or the telegram tool)" }, 404);
    if (!bot.enabled) return json({ error: "bot is paused — resume it first" }, 400);

    // Chat allowlist: the same boundary the poller enforces on inbound
    const targets = targetChatIds(p);
    if (targets.length) {
      const allowed = String(bot.allowed_chats || '').split(',').map((s: string) => s.trim()).filter(Boolean);
      if (!allowed.length) {
        return json({
          error: "no chats authorized yet (pairing mode) — message the bot on Telegram to get your chat id, then allow it",
        }, 400);
      }
      const denied = targets.filter(id => !allowed.includes(id));
      if (denied.length) {
        return json({
          error: `chat ${denied.join(', ')} is not in the allowlist — only authorized chats can be messaged`,
          allowedChats: allowed,
        }, 403);
      }
    }

    try {
      const res = await fetch(`https://api.telegram.org/bot${bot.token}/${m}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
        signal: AbortSignal.timeout(30_000),
      });
      const out: any = await res.json().catch(() => ({ ok: false, description: 'non-JSON response' }));

      // Telegram errors pass through verbatim (description tells the agent
      // exactly what to fix) — but never our URL/token
      if (out?.ok && /^send|^edit|^delete|^pin|^unpin|^forward|^copy/i.test(m)) {
        await emitEvent(env, String(userId), 'telegram_out', `${m} → chat ${targets.join(',') || '?'}`);
      }
      return json(out, res.ok ? 200 : res.status);
    } catch (err: any) {
      return json({ ok: false, error: String(err?.message || err).slice(0, 200) }, 502);
    }
  }
}
