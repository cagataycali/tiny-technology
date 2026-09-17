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
 *   POST   /message            { fromUserId, toUserId?, toLogin?, toTiny?, body,
 *                                attachments?, viaTiny? }
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
 *
 * 📷🎥🎤 ATTACHMENTS (migration 0031): a message may carry ≤4 photos / short
 * video clips / voice notes as a JSON array in `attachments`. The bytes live in
 * the R2 media store (src/media.ts) and the row carries only URLs, so a DM
 * costs the same to read whether or not it has a photo. Rules, all enforced
 * HERE and not merely at the app (see decideAttachments): the URL must be one of
 * this worker's own `/media/<uuid>.<ext>` (the recipient's AGENT fetches these
 * bytes and hands them to a model — an arbitrary URL is SSRF), `kind` is derived
 * from the allowlisted contentType rather than believed, a transcript rides only
 * on audio, and an empty BODY becomes legal the moment media is attached (a
 * caption-less photo is a real message). Every media-less surface — Telegram,
 * web push, the event ring, the inbox row — previews through `messagePreview`,
 * so a photo never renders as an empty line.
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

/** 📷🎥🎤 Attachment contentType → kind (migration 0031). This is the same
 *  table as `lib/chat/dm-attachments.ts` DM_ATTACHMENT_TYPES and a subset of the
 *  media store's own `EXT` (src/media.ts) — a type absent here is refused. The
 *  kind is DERIVED from it and never read off the caller's object: a client that
 *  could label an mp4 "image" would decide which bytes the agent's read path
 *  later tries to hand the model as a picture. */
const ATTACHMENT_TYPES: Record<string, "image" | "video" | "audio"> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "image",
  "video/mp4": "video",
  "audio/mp4": "audio",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/ogg": "audio",
};

const MAX_ATTACHMENTS = 4;

export type DmAttachment = {
  kind: "image" | "video" | "audio";
  url: string;
  contentType: string;
  bytes?: number;
  transcript?: string;
  durationMs?: number;
  width?: number;
  height?: number;
};

export type AttachmentsDecision =
  | { ok: true; attachments: DmAttachment[] }
  | { ok: false; error: string };

/**
 * The worker's OWN copy of the attachment rule — deliberately not shared code.
 *
 * `/message` has four doors (web route, agent tool, MCP, mobile) and the 2000-char
 * truncation bug shipped precisely because only one of them ran the check. The
 * app validates too (better errors, sooner); this is the one that actually
 * guards D1.
 *
 * `origin` is THIS worker's origin (`new URL(request.url).origin`) — the same
 * value MediaUploadCall stamps into the URLs it hands out. Pinning attachment
 * URLs to it is the load-bearing check: the agent's read path fetches these
 * bytes and feeds them to the model as trusted image content, so an arbitrary
 * URL stored here is an SSRF primitive with a credulous reader on the end.
 *
 * Refuses rather than filters, for the same reason the body is refused rather
 * than trimmed: a DM cannot be unsent, so a silently-dropped photo is a loss the
 * sender is told nothing about.
 */
export function decideAttachments(raw: any, origin: string): AttachmentsDecision {
  if (raw === undefined || raw === null || raw === "") return { ok: true, attachments: [] };
  let list = raw;
  // Mobile clients post JSON bodies through several relays; accept a
  // JSON-encoded array as well as a real one rather than silently reading a
  // string as "no attachments".
  if (typeof list === "string") {
    try { list = JSON.parse(list); } catch { return { ok: false, error: "attachments must be an array" }; }
  }
  if (!Array.isArray(list)) return { ok: false, error: "attachments must be an array" };
  if (list.length > MAX_ATTACHMENTS) {
    return { ok: false, error: `${list.length} attachments is over the ${MAX_ATTACHMENTS} limit — nothing was sent` };
  }

  let base: string;
  try { base = new URL(origin).origin; } catch { return { ok: false, error: "attachments unavailable" }; }

  const out: DmAttachment[] = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a || typeof a !== "object") return { ok: false, error: `attachment ${i + 1} is not an object` };

    const contentType = String(a.contentType || "").toLowerCase().trim();
    const kind = ATTACHMENT_TYPES[contentType];
    if (!kind) {
      return {
        ok: false,
        error: `attachment ${i + 1} contentType "${contentType || "(missing)"}" not supported — allowed: ${Object.keys(ATTACHMENT_TYPES).join(", ")}`,
      };
    }

    const url = String(a.url || "");
    let ok = false;
    try {
      const u = new URL(url);
      // https, our own origin, and the media store's UUID key shape (which also
      // rules out traversal and listing probes).
      ok = u.protocol === "https:" && u.origin === base &&
        /^\/media\/[0-9a-f-]{36}\.[a-z0-9]{2,4}$/.test(u.pathname);
    } catch { ok = false; }
    if (!ok) return { ok: false, error: `attachment ${i + 1} must be a ${base}/media/... URL` };

    const num = (v: any): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
    };
    const bytes = num(a.bytes), durationMs = num(a.durationMs), width = num(a.width), height = num(a.height);
    // A transcript is meaningful only on audio. Accepting one on an image would
    // let a sender attach arbitrary text that the recipient's agent reads back as
    // if their own device had heard it spoken.
    const transcript = kind === "audio" && typeof a.transcript === "string" && a.transcript.trim()
      ? clipToCodePoints(a.transcript.trim(), MAX_BODY)
      : undefined;

    // Built field-by-field: anything the caller invented (an `owner`, an
    // `isTrusted`) is dropped rather than stored in D1 and echoed to every
    // client as though the server had vouched for it.
    out.push({
      kind, url, contentType,
      ...(bytes !== undefined ? { bytes } : {}),
      ...(transcript ? { transcript } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    });
  }
  return { ok: true, attachments: out };
}

/** Parse a stored `attachments` cell back to a list. Corrupt or legacy-NULL
 *  cells read as `[]` — a thread must render even if one row's JSON is bad. */
export function parseAttachments(raw: any): DmAttachment[] {
  if (!raw) return [];
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/**
 * The one-line summary for a surface that renders no media: the inbox row, the
 * push body, the Telegram fan-out, the agent's event ring.
 *
 * Mirrors `dmPreview` in lib/chat/dm-attachments.ts. The rule that matters: a
 * caption-less photo must NEVER preview as an empty string, which is exactly
 * what these four surfaces produced before attachments had a label — an inbox
 * row and a push notification that look like nothing happened.
 */
export function messagePreview(body: string, attachments: DmAttachment[]): string {
  const text = String(body || "").trim();
  if (!attachments.length) return text;

  const kinds = new Set(attachments.map((a) => a.kind));
  const n = attachments.length;
  let label: string;
  if (kinds.size > 1) label = `📎 ${n} attachments`;
  else if (attachments[0].kind === "image") label = n === 1 ? "📷 Photo" : `📷 ${n} photos`;
  else if (attachments[0].kind === "video") label = n === 1 ? "🎥 Video" : `🎥 ${n} videos`;
  else label = n === 1 ? "🎤 Voice note" : `🎤 ${n} voice notes`;

  if (!text) {
    const spoken = n === 1 && attachments[0].kind === "audio" ? String(attachments[0].transcript || "").trim() : "";
    return spoken ? `🎤 ${spoken}` : label;
  }
  return `${label} ${text}`;
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
       (SELECT attachments FROM messages m3
         WHERE (m3.from_user = ?1 AND m3.to_user = g.peer) OR (m3.from_user = g.peer AND m3.to_user = ?1)
         ORDER BY m3.id DESC LIMIT 1) AS last_attachments,
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
      body: new Str({ required: true, description: `Message body (≤${MAX_BODY} characters, counted as code points — longer is REFUSED with a 400, not truncated). May be empty when attachments are present.` }),
      attachments: new Str({ required: false, description: `JSON array (≤${MAX_ATTACHMENTS}) of { kind, url, contentType, bytes?, transcript?, durationMs?, width?, height? }. url must be one of this worker's /media/<uuid>.<ext> URLs (upload via /media/upload first); kind is derived from contentType.` }),
      viaTiny: new Str({ required: false, description: "Which tiny brokered the send." }),
    },
    responses: { "200": { description: "Sent", schema: { response: "Sent" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { fromUserId, toUserId, toLogin, toTiny, body, attachments, viaTiny } = data.body;
    if (!fromUserId) return json({ error: "fromUserId and body required" }, 400);

    // 📷 Attachments are decided FIRST: bad media must stop the whole send, not
    // let the text go out with the photo quietly missing. Pinned to THIS
    // worker's origin — see decideAttachments for why that check is load-bearing.
    const media = decideAttachments(attachments, new URL(request.url).origin);
    if (!media.ok) return json({ ok: false, error: media.error }, 400);

    // Refuse over-length instead of cutting it — see decideBody. The 400 carries
    // the overrun so the caller (agent tool, MCP, mobile composer) can split.
    //
    // The one exception is BLANKNESS, and only with media attached: a
    // caption-less photo is the commonest message anyone sends from a phone, so
    // an empty body stops being a misfire the moment there is something else to
    // deliver. Over-length is still refused whole, photo or not — a DM must
    // never arrive half-said.
    let text: string;
    if (!String(body ?? "").trim() && media.attachments.length) {
      text = "";
    } else {
      const decided = decideBody(body);
      if (!decided.ok) return json({ ok: false, error: decided.error }, 400);
      text = decided.body;
    }
    // What a media-less surface (Telegram, push, the event ring, the inbox row)
    // shows for this message. Never "" for a caption-less photo.
    const preview = messagePreview(text, media.attachments);

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
        "INSERT INTO messages (from_user, to_user, via_tiny, body, attachments) VALUES (?, ?, ?, ?, ?) RETURNING id"
      ).bind(
        sender.id, recipient.id, String(viaTiny || "").slice(0, 40), text,
        // Always a JSON array, never NULL (migration 0031) — so no reader has to
        // remember a second empty case.
        JSON.stringify(media.attachments),
      ).first();

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
              text: `💬 New message from ${senderLabel}${senderLogin ? ` (@${senderLogin})` : ""}${viaTiny ? ` via tiny/${viaTiny}` : ""}:\n\n${clipToCodePoints(preview, 3500)}\n\n↩️ Reply at https://tiny.technology/${viaTiny || "tiny"}`,
            });
            if (res?.ok) delivered.telegram = true;

            // 📷 Then the media ITSELF. Telegram fetches public URLs, and
            // /media/<uuid> is exactly that — so a photo arrives as a photo
            // rather than as the word "Photo" beside a link the recipient has to
            // tap out of the app to see. Best-effort per file and per chat: the
            // text above has already landed, so a failure here costs a preview,
            // never the message. Voice notes send their transcript as the caption
            // so the text is readable without playing anything.
            for (const a of media.attachments) {
              const caption = a.kind === "audio" && a.transcript
                ? clipToCodePoints(`🎤 ${a.transcript}`, 1000)
                : undefined;
              const method = a.kind === "image" ? "sendPhoto"
                : a.kind === "video" ? "sendVideo"
                  // sendVoice demands OGG/OPUS; anything else (m4a from the
                  // phones, mp3) is an audio document to Telegram.
                  : a.contentType === "audio/ogg" ? "sendVoice" : "sendAudio";
              const field = a.kind === "image" ? "photo" : a.kind === "video" ? "video"
                : method === "sendVoice" ? "voice" : "audio";
              await tg(bot.token, method, {
                chat_id: chatId,
                [field]: a.url,
                ...(caption ? { caption } : {}),
              });
            }
          }
        }
      } catch (err) { console.log(err, "dm telegram fanout"); }

      // Web push: all recipient devices
      try {
        const push = await sendPushToUser(env, recipient.id, {
          title: `💬 ${senderLabel}${senderLogin ? ` (@${senderLogin})` : ""}`,
          body: clipToCodePoints(preview, 300),
          url: `/${viaTiny || "tiny"}?dm=${encodeURIComponent(senderLogin || sender.id)}`,
          tag: `dm-${sender.id}`,
        });
        delivered.push = push.sent;
      } catch (err) { console.log(err, "dm push fanout"); }

      // Event ring — the recipient's next agent turn sees it
      await emitEvent(env, recipient.id, "dm",
        `${senderLabel}${senderLogin ? ` (@${senderLogin})` : ""}: ${clipToCodePoints(preview, 200)}`);

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
          `SELECT id, from_user, to_user, via_tiny, body, attachments, read, created FROM messages
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
            // 📷 Always an array — the clients render off `.length`, so a NULL
            // here (a row written before migration 0031) would crash a `forEach`
            // rather than render as "no attachments".
            attachments: parseAttachments(m.attachments),
            viaTiny: m.via_tiny || undefined,
            read: !!m.read,
            created: m.created,
          })),
        });
      }

      // Inbox: latest message + unread count per peer (INBOX_SQL above —
      // exported for the sqlite-backed test).
      const { results } = await env.DB.prepare(INBOX_SQL).bind(userId).all();

      const threads = (results || []).map((t: any) => {
        const lastAttachments = parseAttachments(t.last_attachments);
        return {
          userId: t.peer,
          login: t.login || "",
          name: t.name || t.login || "unknown",
          avatar: t.avatar || "",
          unread: Number(t.unread || 0),
          // 📷 The row preview is media-aware, so a caption-less photo reads
          // "📷 Photo" instead of the empty string this used to produce — an
          // inbox row that looked like nothing had happened. Clipped on a code
          // POINT boundary like the other previews: `.slice(0, 140)` counts
          // UTF-16 units and could end on a lone surrogate.
          lastBody: clipToCodePoints(messagePreview(String(t.last_body || ""), lastAttachments), 140),
          // The kinds themselves, so a client can put a thumbnail on the row
          // without fetching the thread.
          lastAttachments,
          lastAt: t.last_at,
        };
      });
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
    // The R2 objects behind this message's attachments are deliberately NOT
    // deleted. A media key can be referenced by more than one row — the
    // recipient forwarding a photo on attaches the same `/media/<uuid>` URL —
    // so deleting the bytes with the row would reach into a message that
    // belongs to somebody else, and the sender of THIS message has no authority
    // over that copy. Orphaned media is a storage cost (unguessable key, no
    // listing endpoint); breaking a third party's thread is a correctness bug.
    // A sweep keyed on "no message row references this key" is the right home
    // for reclaiming them, and does not exist yet.
    const res = await env.DB.prepare("DELETE FROM messages WHERE id = ? AND from_user = ?")
      .bind(Number(id), String(userId)).run();
    if (!res?.meta?.changes) return json({ ok: false, error: "not found or not yours" }, 404);
    return json({ ok: true });
  }
}

/**
 * 📟 Device-token DM access — the branch the DM rail never had.
 *
 * Everything above resolves identity from a session (via the edge) or the
 * internal key (via a sibling worker route). But an enrolled device — the
 * reTerminal Sticky composing on its e-ink keyboard — holds only its own
 * revocable `tind_` token, exactly like /media/upload and /device/event.
 * This route gives it the DM rail WITHOUT a second implementation: the
 * device token resolves the OWNER (DEVICE_EVENT_AUTH_SQL — same query, same
 * no-oracle property: wrong token and revoked device are indistinguishable),
 * then the op dispatches to the EXISTING handler classes in-process with a
 * synthesized internal request. Send therefore inherits every guardrail —
 * the 2000-code-point refusal, 100/day rate limit, attachment origin pinning,
 * fan-out isolation — because it IS the same code path, with
 * `fromUserId = resolved owner` and never anything client-supplied.
 *
 *   POST /device/messages { deviceId, token, op, ... }
 *     op="send"   + to (@login | login | tiny slug), body, attachments?
 *     op="inbox"                          → threads + unread counts
 *     op="thread" + with (login|userId), limit? → thread (marks inbound read)
 *     op="unread"                         → { unread, from: [...] }
 *
 * viaTiny is stamped with the device NAME (sliced to 40 like every other
 * caller) so a recipient sees "via sticky" — provenance for a message a
 * wall display sent on the owner's behalf.
 */
export class DeviceMessagesCall extends OpenAPIRoute {
  static schema = {
    tags: ["Messages"],
    summary: "Internal: device-token DM access (send/inbox/thread/unread) — owner resolved from the device token.",
    requestBody: {
      deviceId: new Str({ required: true }),
      token: new Str({ required: true, description: "That device's token (verified by hash)." }),
      op: new Str({ required: true, description: "send | inbox | thread | unread" }),
      to: new Str({ required: false, description: "send: recipient login or tiny slug." }),
      body: new Str({ required: false, description: "send: message body (same code-point cap as /message)." }),
      attachments: new Str({ required: false, description: "send: same contract as /message." }),
      with: new Str({ required: false, description: "thread: peer userId or login." }),
      limit: new Str({ required: false, description: "thread: messages (≤200, default 50)." }),
    },
    responses: { "200": { description: "Result", schema: { response: "Result" } } },
  };

  async handle(request: Request, env: any, ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { deviceId, token, op, to, body, attachments, limit } = data.body;
    const withPeer = data.body["with"];
    if (!deviceId || !token || !op) return json({ error: "deviceId, token and op required" }, 400);

    const { hashDeviceToken, DEVICE_EVENT_AUTH_SQL } = await import("./devices");
    const dev = await env.DB.prepare(DEVICE_EVENT_AUTH_SQL)
      .bind(String(deviceId), await hashDeviceToken(String(token))).first();
    if (!dev?.user_id) return json({ error: "unknown device" }, 401);
    const owner = String(dev.user_id);

    // Synthesized INTERNAL request: same origin as the incoming call (so the
    // attachment origin pin still points at this worker), key from env — the
    // downstream checkInternalKey passes because we ARE downstream of the gate.
    const internal = (url: string) =>
      new Request(url, { headers: { "x-internal-key": env.INTERNAL_API_KEY || "" } });
    const origin = new URL(request.url).origin;

    switch (String(op)) {
      case "send": {
        const target = String(to || "").trim();
        if (!target) return json({ error: "to required for send" }, 400);
        return new MessageSendCall({} as any).handle(internal(`${origin}/message`), env, ctx, {
          body: {
            fromUserId: owner,
            toLogin: target,
            toTiny: target,          // resolveRecipient tries login first, then tiny
            body: body ?? "",
            attachments,
            viaTiny: String(dev.name || "device"),
          },
        });
      }
      case "inbox":
        return new MessagesListCall({} as any).handle(
          internal(`${origin}/messages?userId=${encodeURIComponent(owner)}`), env);
      case "thread": {
        const peer = String(withPeer || "").trim();
        if (!peer) return json({ error: "with required for thread" }, 400);
        const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
        return new MessagesListCall({} as any).handle(
          internal(`${origin}/messages?userId=${encodeURIComponent(owner)}&with=${encodeURIComponent(peer)}&limit=${lim}`), env);
      }
      case "unread":
        return new MessagesUnreadCall({} as any).handle(
          internal(`${origin}/message/unread?userId=${encodeURIComponent(owner)}`), env);
      default:
        return json({ error: "op must be send | inbox | thread | unread" }, 400);
    }
  }
}
