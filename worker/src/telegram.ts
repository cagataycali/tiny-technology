/**
 * Telegram integration (COMPARISON.md §2.2, careless telegram-api.ts +
 * devduck's fresh-agent-per-message model).
 *
 * Per-user bot (BotFather token) stored in D1; the worker cron polls
 * getUpdates for every enabled bot each minute, and each inbound message
 * runs the user's chosen tiny via the app's /api/job-run pipeline, replying
 * with sendMessage.
 *
 * Security model:
 *   - allowlist of chat ids; while EMPTY the bot is in "pairing mode":
 *     it replies to any chat with its chat id and instructions, so the
 *     owner sends /start, reads the id, and confirms it in tiny chat.
 *   - offset is compare-and-swapped like the scheduler's last_fired_at,
 *     so overlapping cron runs never double-process a message.
 *   - max 5 messages processed per bot per poll (flood control).
 *
 * Endpoints (internal): POST /telegram (configure), GET /telegram?userId=,
 * DELETE /telegram.
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { emitEvent } from "./events";

const MAX_PER_POLL = 5;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Exported for `reconcile-alarm.ts`: the operator page rides the destination
 *  user's OWN bot and OWN chat allowlist, so it needs no second token and no
 *  second timeout policy. */
export const tg = (token: string, method: string, params: Record<string, any>) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  }).then(r => r.json()).catch(() => null);

/** careless telegram-api.ts helpers, worker-ported */
// Exported for tests (../tests/telegram-authz.test.ts)
export function senderName(msg: any): string {
  const from = msg?.from || {};
  return from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ') || 'unknown';
}
export function chatIsAllowed(allowed: string, chatId: string): boolean {
  const list = String(allowed || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(chatId);
}

/** Cron entrypoint — poll all enabled bots. */
export async function pollTelegramBots(env: any): Promise<{ processed: number }> {
  let processed = 0;
  const { results } = await env.DB.prepare(
    "SELECT * FROM telegram_bots WHERE enabled = 1"
  ).all();

  for (const bot of results || []) {
    try {
      const updates: any = await tg(bot.token, 'getUpdates', {
        offset: bot.last_offset + 1,
        limit: MAX_PER_POLL,
        timeout: 0, // short poll — we're inside a cron tick
        allowed_updates: ['message', 'callback_query'],
      });
      if (!updates?.ok || !Array.isArray(updates.result) || updates.result.length === 0) continue;

      const maxUpdateId = Math.max(...updates.result.map((u: any) => u.update_id));
      // CAS the offset — if another cron run already claimed these, skip
      const claim = await env.DB.prepare(
        "UPDATE telegram_bots SET last_offset = ? WHERE user_id = ? AND last_offset = ?"
      ).bind(maxUpdateId, bot.user_id, bot.last_offset).run();
      if (!claim?.meta?.changes) continue;

      for (const update of updates.result) {
        // Inline-keyboard press (use_telegram confirmation menus): ack the
        // spinner, treat the button data as an inbound message from that chat
        const cb = update.callback_query;
        if (cb) {
          await tg(bot.token, 'answerCallbackQuery', { callback_query_id: cb.id });
          const cbChatId = String(cb.message?.chat?.id || '');
          if (cbChatId && chatIsAllowed(bot.allowed_chats, cbChatId)) {
            await emitEvent(env, bot.user_id, 'telegram_button',
              `${senderName(cb)} pressed: ${String(cb.data || '').slice(0, 80)}`);
            update.message = {
              from: cb.from,
              chat: cb.message.chat,
              text: `[button pressed] ${String(cb.data || '')}`,
            };
          } else {
            continue;
          }
        }

        const msg = update.message;
        const text = msg?.text;
        const chatId = String(msg?.chat?.id || '');
        if (!text || !chatId) continue;

        // Pairing mode: no allowlist yet → reply with the chat id
        if (!bot.allowed_chats) {
          await tg(bot.token, 'sendMessage', {
            chat_id: chatId,
            text: `👋 This bot is linked to tiny.technology/${bot.tiny_slug} but this chat isn't authorized yet.\n\nYour chat id: ${chatId}\n\nThe owner can authorize it by telling their tiny: "allow telegram chat ${chatId}"`,
          });
          continue;
        }
        if (!chatIsAllowed(bot.allowed_chats, chatId)) continue; // silent for non-allowed

        processed += 1;
        // Fresh agent per message (devduck model) via the app's job pipeline
        let reply = '';
        try {
          const res = await fetch('https://tiny.technology/api/job-run', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Key': env.INTERNAL_API_KEY || '',
            },
            body: JSON.stringify({
              userId: bot.user_id,
              tiny: bot.tiny_slug,
              prompt: `[Telegram message from ${senderName(msg)}]: ${text.slice(0, 2000)}`,
            }),
            signal: AbortSignal.timeout(60_000),
          });
          const data: any = await res.json().catch(() => ({}));
          reply = data.ok ? String(data.result || '') : `⚠️ ${data.error || 'agent error'}`;
        } catch (err: any) {
          reply = `⚠️ ${String(err?.message || err).slice(0, 100)}`;
        }

        await tg(bot.token, 'sendMessage', {
          chat_id: chatId,
          text: reply.slice(0, 4000) || '…',
        });

        await emitEvent(env, bot.user_id, 'telegram',
          `${senderName(msg)}: ${text.slice(0, 80)} → ${reply.slice(0, 80)}`);
      }
    } catch (err) { console.log(err, 'telegram poll', bot.user_id); }
  }
  return { processed };
}

export class TelegramConfigCall extends OpenAPIRoute {
  static schema = {
    tags: ["Telegram"],
    summary: "Internal: configure a user's Telegram bot.",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      token: new Str({ required: false, description: "BotFather token (omit to keep existing)." }),
      tiny: new Str({ required: false, description: "Tiny slug that answers." }),
      allowedChats: new Str({ required: false, description: "Comma-separated chat ids ('' = pairing mode)." }),
      enabled: new Str({ required: false, description: "'true' | 'false'." }),
    },
    responses: { "200": { description: "Configured", schema: { response: "Configured" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, token, tiny, allowedChats, enabled } = data.body;
    if (!userId) return json({ error: "userId required" }, 400);

    const existing = await env.DB.prepare("SELECT * FROM telegram_bots WHERE user_id = ?")
      .bind(String(userId)).first();

    if (!existing && (!token || !tiny)) {
      return json({ error: "token and tiny required for first-time setup" }, 400);
    }

    // Validate a newly-provided token with getMe (catches typos early)
    if (token) {
      const me: any = await tg(String(token), 'getMe', {});
      if (!me?.ok) return json({ error: "Telegram rejected that token (getMe failed)" }, 400);
    }

    // Only touch `enabled` when the caller explicitly sent it — otherwise a
    // partial update (e.g. just adding an allowed chat) would resolve
    // `enabled` to 1 and silently RESUME a bot the user had paused. Mirrors
    // the allowed_chats CASE guard. New rows default enabled=1 unless
    // enabled:'false' was passed.
    await env.DB.prepare(
      `INSERT INTO telegram_bots (user_id, token, tiny_slug, allowed_chats, enabled)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         token = COALESCE(NULLIF(excluded.token, ''), telegram_bots.token),
         tiny_slug = COALESCE(NULLIF(excluded.tiny_slug, ''), telegram_bots.tiny_slug),
         allowed_chats = CASE WHEN ? THEN excluded.allowed_chats ELSE telegram_bots.allowed_chats END,
         enabled = CASE WHEN ? THEN excluded.enabled ELSE telegram_bots.enabled END`
    ).bind(
      String(userId),
      String(token || ''),
      String(tiny || ''),
      String(allowedChats ?? ''),
      enabled === 'false' ? 0 : 1,
      allowedChats !== undefined ? 1 : 0,
      enabled !== undefined ? 1 : 0,
    ).run();

    return json({ ok: true, pairing: !(allowedChats || existing?.allowed_chats) });
  }
}

export class TelegramGetCall extends OpenAPIRoute {
  static schema = {
    tags: ["Telegram"],
    summary: "Internal: a user's Telegram bot config (token masked).",
    parameters: { userId: Query(String, { required: true, description: "User id." }) },
    responses: { "200": { description: "Config", schema: { response: "Config" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const userId = new URL(request.url).searchParams.get('userId') || '';
    if (!userId) return json({ error: "userId required" }, 400);
    const bot = await env.DB.prepare("SELECT * FROM telegram_bots WHERE user_id = ?")
      .bind(userId).first();
    if (!bot) return json({ bot: null });
    return json({
      bot: {
        tiny: bot.tiny_slug,
        allowedChats: bot.allowed_chats,
        enabled: !!bot.enabled,
        token: `…${String(bot.token).slice(-6)}`, // masked
      },
    });
  }
}

export class TelegramDeleteCall extends OpenAPIRoute {
  static schema = {
    tags: ["Telegram"],
    summary: "Internal: remove a user's Telegram bot.",
    requestBody: { userId: new Str({ required: true, description: "User id." }) },
    responses: { "200": { description: "Deleted", schema: { response: "Deleted" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    await env.DB.prepare("DELETE FROM telegram_bots WHERE user_id = ?")
      .bind(String(data.body.userId)).run();
    return json({ ok: true });
  }
}
