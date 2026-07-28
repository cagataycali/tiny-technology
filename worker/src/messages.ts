/**
 * User↔user direct messages ("send_message") — the platform's DM rail.
 *
 * D1 `messages` is the thread store (source of truth). At send time the
 * worker fans out delivery on every rail the recipient has configured:
 *   - Telegram: their telegram_bots token → sendMessage to allowed chats
 *   - Web push: sendPushToUser (encrypted, all devices)
 *   - Event ring: emitEvent 'dm' (surfaces in ActivityHUD + agent prompt)
 *
 * All endpoints are INTERNAL (X-Internal-Key). The app resolves the sender
 * from its session JWT — fromUserId is never client-supplied end-to-end.
 *
 *   POST   /message            { fromUserId, toUserId?, toLogin?, toTiny?, body, viaTiny? }
 *                              → { ok, id, delivered: { telegram, push, stored } }
 *   GET    /messages?userId=&with=<peerUserId>&limit=  → thread (marks the
 *                              peer→user direction read)
 *   GET    /messages?userId=   → inbox: threads w/ unread counts + peer identity
 *   GET    /message/unread?userId= → { unread, from: [{login,name,count}] }
 *   DELETE /message            { userId, id } → delete own sent message
 *
 * Recipient resolution (server-side): toUserId (exact) → toLogin
 * (users.github_login, case-insensitive) → toTiny (tinys.name → user_id).
 *
 * Guardrails: 2000-CODE-POINT body cap (over it is a 400 — a DM cannot be
 * unsent, so it is never truncated), 100 sends/day/sender (D1 count), no
 * self-DM, thread pruned to last 500 messages per pair.
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { sendPushToUser } from "./push";
import { emitEvent } from "./events";
import { recordSocialEdge, userNodeId } from "./graph";

export const MAX_BODY = 2000;
const MAX_PER_DAY = 100;
const THREAD_CAP = 500;

/**
 * "Characters" as a person counts them: code POINTS, not UTF-16 code units.
 *
 * The cap used to be `.slice(0, MAX_BODY)`, which counts units — so the two ends
 * of the DM rail measured different things. `lib/chat/dm-send.ts` approves 2000
 * code points (an emoji = 1), and 2000 emoji are 4000 units, so a message the
 * sender's tool declared legal arrived here and lost half of itself. Measured:
 * `'x' + '👋'×1999` is 2000 code points, and `.slice(0, 2000)` keeps 1001 of
 * them and ends in a LONE HIGH SURROGATE (0xd83d) — mojibake stored in D1, in
 * the Telegram push and in the event ring. And the handler still answered
 * `{ ok: true }`, so the agent said "Delivered".
 *
 * `Array.from` is the TS-safe spread here (no downlevelIteration in this build).
 */
export function bodyLength(text: string): number {
  return Array.from(text).length;
}

/**
 * Truncate on a code-point boundary, never inside a surrogate pair.
 *
 * Used for the PREVIEWS (Telegram 3500, push 300, event ring 200), where cutting
 * is correct — they are lossy summaries beside a stored full copy. It is the
 * BODY that must never be cut, because that is the message itself.
 */
export function clipToCodePoints(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : cps.slice(0, max).join("");
}

export type BodyDecision = { ok: true; body: string } | { ok: false; error: string };

/**
 * The body to store, or a refusal — the worker's own copy of the rule, because
 * this endpoint is reachable from four callers (web route, agent tool, MCP,
 * mobile) and only one of them ran the client-side check.
 *
 * A DM cannot be unsent, so an over-long body is REFUSED rather than trimmed:
 * truncating silently turns "your message was too long" (recoverable, the sender
 * can split it) into "the recipient read half a sentence and nobody knows"
 * (unrecoverable). The refusal names the overrun so a caller can act on it.
 */
export function decideBody(raw: any): BodyDecision {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "fromUserId and body required" };
  const n = bodyLength(text);
  if (n > MAX_BODY) {
    return {
      ok: false,
      error: `message is ${n} characters, ${n - MAX_BODY} over the ${MAX_BODY} limit — ` +
        `nothing was sent. Split it into shorter messages.`,
    };
  }
  return { ok: true, body: text };
}

/**
 * Inbox query — exported so tests/messages-inbox-sql.test.ts runs the REAL
 * statement against sqlite (a copied string would drift silently). One
 * statement, peer identity JOINed: this endpoint is polled (~60s per open
 * page for the badge), and a per-thread users lookup was an N+1.
 */
export const INBOX_SQL = `SELECT g.peer, g.last_at, g.unread,
       (SELECT body FROM messages m2
         WHERE (m2.from_user = ?1 AND m2.to_user = g.peer) OR (m2.from_user = g.peer AND m2.to_user = ?1)
         ORDER BY m2.id DESC LIMIT 1) AS last_body,
       u.github_login AS login, u.name AS name, u.avatar AS avatar
 FROM (
   SELECT CASE WHEN from_user = ?1 THEN to_user ELSE from_user END AS peer,
          MAX(created) AS last_at,
          SUM(CASE WHEN to_user = ?1 AND read = 0 THEN 1 ELSE 0 END) AS unread
   FROM messages WHERE from_user = ?1 OR to_user = ?1
   GROUP BY peer
 ) g LEFT JOIN users u ON u.id = g.peer
 ORDER BY g.last_at DESC LIMIT 50`;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const tg = (token: string, method: string, params: Record<string, any>) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  }).then((r) => r.json()).catch(() => null);

/** Resolve a recipient to a users row. Exported for reuse. */
export async function resolveRecipient(
  env: any,
  opts: { toUserId?: string; toLogin?: string; toTiny?: string }
): Promise<any | null> {
  // Fallback chain: each hint that misses falls through to the next, so a
  // single "to" value can be a userId, a GitHub login, OR a tiny slug.
  if (opts.toUserId) {
    const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(String(opts.toUserId)).first();
    if (u) return u;
  }
  if (opts.toLogin) {
    const raw = String(opts.toLogin).trim().replace(/^@/, "");
    if (/^[a-zA-Z0-9-]{1,39}$/.test(raw)) {
      const u = await env.DB.prepare("SELECT * FROM users WHERE LOWER(github_login) = LOWER(?)")
        .bind(raw).first();
      if (u) return u;
    }
  }
  if (opts.toTiny) {
    const slug = String(opts.toTiny).trim().toLowerCase();
    if (/^[a-z0-9_-]{1,40}$/.test(slug)) {
      const t = await env.DB.prepare("SELECT user_id FROM tinys WHERE name = ?").bind(slug).first();
      if (t?.user_id) {
        return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(t.user_id).first();
      }
    }
  }
  return null;
}

export class MessageSendCall extends OpenAPIRoute {
  static schema = {
    tags: ["Messages"],
    summary: "Internal: send a DM from one user to another (stores + fans out to Telegram/push/events).",
    requestBody: {
      fromUserId: new Str({ required: true, description: "Sender user id (from app session)." }),
      toUserId: new Str({ required: false, description: "Recipient user id (exact)." }),
      toLogin: new Str({ required: false, description: "Recipient GitHub login." }),
      toTiny: new Str({ required: false, description: "A tiny slug — resolves to its owner." }),
      body: new Str({ required: true, description: `Message body (≤${MAX_BODY} characters, counted as code points — longer is REFUSED with a 400, not truncated).` }),
      viaTiny: new Str({ required: false, description: "Which tiny brokered the send." }),
    },
    responses: { "200": { description: "Sent", schema: { response: "Sent" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { fromUserId, toUserId, toLogin, toTiny, body, viaTiny } = data.body;
    if (!fromUserId) return json({ error: "fromUserId and body required" }, 400);
    // Refuse over-length instead of cutting it — see decideBody. The 400 carries
    // the overrun so the caller (agent tool, MCP, mobile composer) can split.
    const decided = decideBody(body);
    if (!decided.ok) return json({ ok: false, error: decided.error }, 400);
    const text = decided.body;

    try {
      const sender = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
        .bind(String(fromUserId)).first();
      if (!sender) return json({ error: "sender not found" }, 404);

      const recipient = await resolveRecipient(env, { toUserId, toLogin, toTiny });
      if (!recipient) return json({ ok: false, error: "recipient not found — try their GitHub login or a tiny slug they own" }, 404);
      if (recipient.id === sender.id) return json({ ok: false, error: "cannot message yourself" }, 400);

      // Rate limit: sends in the last 24h
      const cnt = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM messages WHERE from_user = ? AND created > unixepoch() - 86400"
      ).bind(sender.id).first();
      if (Number(cnt?.c || 0) >= MAX_PER_DAY) {
        return json({ ok: false, error: `daily message limit reached (${MAX_PER_DAY}/day)` }, 429);
      }

      const row = await env.DB.prepare(
        "INSERT INTO messages (from_user, to_user, via_tiny, body) VALUES (?, ?, ?, ?) RETURNING id"
      ).bind(sender.id, recipient.id, String(viaTiny || "").slice(0, 40), text).first();

      // Prune thread beyond cap (both directions of this pair)
      await env.DB.prepare(
        `DELETE FROM messages WHERE id NOT IN (
           SELECT id FROM messages
           WHERE (from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1)
           ORDER BY id DESC LIMIT ?3)
         AND ((from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1))`
      ).bind(sender.id, recipient.id, THREAD_CAP).run().catch(() => {});

      const senderLabel = sender.name || sender.github_login || "someone";
      const senderLogin = sender.github_login || "";

      // ── Fan-out (each rail isolated — one failure must not block others) ──
      const delivered: Record<string, any> = { stored: true, telegram: false, push: 0 };

      // Telegram: recipient's own bot, all allowed chats
      try {
        const bot = await env.DB.prepare(
          "SELECT token, allowed_chats, enabled FROM telegram_bots WHERE user_id = ?"
        ).bind(recipient.id).first();
        if (bot?.enabled && bot.token && bot.allowed_chats) {
          const chats = String(bot.allowed_chats).split(",").map((s: string) => s.trim()).filter(Boolean);
          for (const chatId of chats) {
            const res: any = await tg(bot.token, "sendMessage", {
              chat_id: chatId,
              text: `💬 New message from ${senderLabel}${senderLogin ? ` (@${senderLogin})` : ""}${viaTiny ? ` via tiny/${viaTiny}` : ""}:\n\n${clipToCodePoints(text, 3500)}\n\n↩️ Reply at https://tiny.technology/${viaTiny || "tiny"}`,
            });
            if (res?.ok) delivered.telegram = true;
          }
        }
      } catch (err) { console.log(err, "dm telegram fanout"); }

      // Web push: all recipient devices
      try {
        const push = await sendPushToUser(env, recipient.id, {
          title: `💬 ${senderLabel}${senderLogin ? ` (@${senderLogin})` : ""}`,
          body: clipToCodePoints(text, 300),
          url: `/${viaTiny || "tiny"}?dm=${encodeURIComponent(senderLogin || sender.id)}`,
          tag: `dm-${sender.id}`,
        });
        delivered.push = push.sent;
      } catch (err) { console.log(err, "dm push fanout"); }

      // Event ring — the recipient's next agent turn sees it
      await emitEvent(env, recipient.id, "dm",
        `${senderLabel}${senderLogin ? ` (@${senderLogin})` : ""}: ${clipToCodePoints(text, 200)}`);

      // 🕸️ Social graph: messaged edge — PRIVATE (who DMs whom is not
      // public signal; the guardrail is visibility scoping, stage 6)
      await recordSocialEdge(env, {
        rel: 'messaged',
        srcId: userNodeId(sender.id), srcKind: 'person', srcLabel: `@${sender.github_login || sender.id}`,
        dstId: userNodeId(recipient.id), dstKind: 'person', dstLabel: `@${recipient.github_login || recipient.id}`,
        visibility: 'private',
      });

      return json({
        ok: true,
        id: row?.id,
        to: { login: recipient.github_login, name: recipient.name || recipient.github_login },
        delivered,
      });
    } catch (err) {
      console.log(err, "message send");
      return json({ error: "failed to send message" }, 500);
    }
  }
}

export class MessagesListCall extends OpenAPIRoute {
  static schema = {
    tags: ["Messages"],
    summary: "Internal: inbox (threads) or a specific thread; thread view marks inbound read.",
    parameters: {
      userId: Query(String, { required: true, description: "User id." }),
      with: Query(String, { required: false, description: "Peer: userId, @login, or login." }),
      limit: Query(Number, { required: false, description: "Thread messages (≤200, default 50)." }),
    },
    responses: { "200": { description: "Messages", schema: { response: "Messages" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const q = new URL(request.url).searchParams;
    const userId = q.get("userId") || "";
    const withRaw = (q.get("with") || "").trim();
    const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200);
    if (!userId) return json({ error: "userId required" }, 400);

    try {
      if (withRaw) {
        // Resolve peer: try exact userId first, then login
        let peer = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(withRaw).first();
        if (!peer) peer = await resolveRecipient(env, { toLogin: withRaw });
        if (!peer) return json({ error: "peer not found" }, 404);

        const { results } = await env.DB.prepare(
          `SELECT id, from_user, to_user, via_tiny, body, read, created FROM messages
           WHERE (from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1)
           ORDER BY id DESC LIMIT ?3`
        ).bind(userId, peer.id, limit).all();

        // Mark inbound as read
        await env.DB.prepare(
          "UPDATE messages SET read = 1 WHERE to_user = ? AND from_user = ? AND read = 0"
        ).bind(userId, peer.id).run().catch(() => {});

        return json({
          peer: { userId: peer.id, login: peer.github_login, name: peer.name || peer.github_login, avatar: peer.avatar || "" },
          messages: (results || []).reverse().map((m: any) => ({
            id: m.id,
            direction: m.from_user === userId ? "sent" : "received",
            body: m.body,
            viaTiny: m.via_tiny || undefined,
            read: !!m.read,
            created: m.created,
          })),
        });
      }

      // Inbox: latest message + unread count per peer (INBOX_SQL above —
      // exported for the sqlite-backed test).
      const { results } = await env.DB.prepare(INBOX_SQL).bind(userId).all();

      const threads = (results || []).map((t: any) => ({
        userId: t.peer,
        login: t.login || "",
        name: t.name || t.login || "unknown",
        avatar: t.avatar || "",
        unread: Number(t.unread || 0),
        lastBody: String(t.last_body || "").slice(0, 140),
        lastAt: t.last_at,
      }));
      return json({ threads });
    } catch (err) {
      console.log(err, "messages list");
      // A masked-empty 200 here made every client treat a D1 outage as
      // "inbox is empty": the iOS unread poll would clear the app badge /
      // widgets / watch complication, then re-banner old DMs on recovery.
      // Fail honestly — clients keep state and show their error branches.
      return json({ error: "messages unavailable" }, 500);
    }
  }
}

export class MessagesUnreadCall extends OpenAPIRoute {
  static schema = {
    tags: ["Messages"],
    summary: "Internal: unread DM summary for prompt injection.",
    parameters: { userId: Query(String, { required: true, description: "User id." }) },
    responses: { "200": { description: "Unread", schema: { response: "Unread" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const userId = new URL(request.url).searchParams.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);
    try {
      const { results } = await env.DB.prepare(
        `SELECT m.from_user, COUNT(*) AS c, MAX(m.created) AS last_at,
                u.github_login AS login, u.name AS name
         FROM messages m LEFT JOIN users u ON u.id = m.from_user
         WHERE m.to_user = ? AND m.read = 0
         GROUP BY m.from_user ORDER BY last_at DESC LIMIT 20`
      ).bind(userId).all();
      const from = (results || []).map((r: any) => ({
        login: r.login || "", name: r.name || r.login || "unknown", count: Number(r.c || 0),
      }));
      // The `from` preview is capped at 20 senders, so summing its counts would
      // UNDERCOUNT the badge/prompt total for anyone with unread DMs from >20
      // distinct people (LIMIT-then-reduce — the same anti-pattern already
      // fixed in community.ts totalUsers/totalPublicTinys). Count the true total
      // independently of the capped preview list.
      const totalRow: any = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM messages WHERE to_user = ? AND read = 0`
      ).bind(userId).first();
      return json({ unread: Number(totalRow?.c || 0), from });
    } catch (err) {
      console.log(err, "messages unread");
      // This IS the summary that drives the badge / prompt injection. A
      // masked-empty 200 on a transient D1 read failure is byte-identical to a
      // genuinely empty inbox: the client clears the badge and the prompt
      // reports "no unread" while real DMs sit unread. Fail honestly so clients
      // keep their last-known state (same fix as MessagesListCall above).
      return json({ error: "unread unavailable" }, 500);
    }
  }
}

export class MessageDeleteCall extends OpenAPIRoute {
  static schema = {
    tags: ["Messages"],
    summary: "Internal: delete a message you sent.",
    requestBody: {
      userId: new Str({ required: true, description: "User id (must be sender)." }),
      id: new Str({ required: true, description: "Message id." }),
    },
    responses: { "200": { description: "Deleted", schema: { response: "Deleted" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, id } = data.body;
    if (!userId || !id) return json({ error: "userId and id required" }, 400);
    const res = await env.DB.prepare("DELETE FROM messages WHERE id = ? AND from_user = ?")
      .bind(Number(id), String(userId)).run();
    if (!res?.meta?.changes) return json({ ok: false, error: "not found or not yours" }, 404);
    return json({ ok: true });
  }
}
