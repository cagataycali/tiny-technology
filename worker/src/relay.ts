/**
 * Device relay (tiny-node PR6 — docs/tiny-node-goal.md §5-6).
 *
 * Cross-network device messaging: the web agent (or any session surface)
 * sends an envelope to an enrolled device; the device polls, executes,
 * replies. Everything internal-key guarded — devices reach this only via
 * the app's /api/devices/relay* proxies (AGENTS.md §13).
 *
 *   POST /device/relay/send   { userId, toDevice, payload }        → { id }
 *   POST /device/relay/poll   { deviceId, token, max? }            → { messages }
 *   POST /device/relay/reply  { deviceId, token, inReplyTo, payload } → { ok }
 *   GET  /device/relay/recv?userId=&inReplyTo=                     → { reply? }
 *
 * Security invariants:
 *   - send: target device must belong to userId and not be revoked
 *   - poll/reply: device authenticates by (id, token_hash, revoked=0) —
 *     same no-oracle property as heartbeat
 *   - reply: in_reply_to envelope must exist AND belong to the same user
 *     (a device cannot inject replies into another user's conversation)
 *   - recv: scoped to (in_reply_to, user_id)
 */
import { OpenAPIRoute, Query, Str, Int } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { hashDeviceToken } from "./devices";
import { emitEvent } from "./events";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const PAYLOAD_MAX = 8192;
const SWEEP_AGE_S = 3600; // envelopes older than 1h are garbage

// SQL as exported constants (devices.ts pattern) for worker-gated tests
export const RELAY_INSERT_SQL = `
  INSERT INTO relay_messages (id, user_id, to_device, in_reply_to, payload, created_at, delivered)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)`;

export const RELAY_DEVICE_AUTH_SQL = `
  SELECT user_id FROM devices WHERE id = ?1 AND token_hash = ?2 AND revoked = 0`;

export const RELAY_TARGET_CHECK_SQL = `
  SELECT id FROM devices WHERE id = ?1 AND user_id = ?2 AND revoked = 0`;

export const RELAY_POLL_SQL = `
  SELECT id, user_id, in_reply_to, payload, created_at FROM relay_messages
  WHERE to_device = ?1 AND delivered = 0 ORDER BY created_at ASC LIMIT ?2`;

export const RELAY_MARK_SQL = `
  UPDATE relay_messages SET delivered = 1 WHERE id = ?1 AND delivered = 0`;

// Also carries the ORIGINAL request (payload) and its age (created_at) so a
// reply can be judged late and described in the event it emits — see
// buildLateReplyEvent.
export const RELAY_ENVELOPE_SQL = `
  SELECT user_id, payload, created_at FROM relay_messages WHERE id = ?1`;

export const RELAY_RECV_SQL = `
  SELECT id, payload, created_at FROM relay_messages
  WHERE in_reply_to = ?1 AND user_id = ?2 AND to_device = ''
  ORDER BY created_at ASC LIMIT 1`;

/**
 * Opportunistic hygiene on the write path.
 *
 * ⚠️ It deliberately SPARES rows that are still `delivered = 0` and addressed to
 * a device: those are the evidence `sweepMissedTasks` reports on, and this runs
 * on every relay SEND — which is exactly when a healthy, active device is around.
 * Reaping them here would destroy the record of a lost task between cron ticks,
 * and would do it *preferentially for busy users*, so the rail would appear to
 * work in testing and fire least for the people with the most at stake.
 *
 * The cron reaps them by id within a minute of expiry, once reported. ?2 is a
 * BACKSTOP for the case where that never happens (cron unconfigured, this module
 * deployed ahead of index.ts, a persistently failing tick): unbounded growth is
 * not an acceptable price for a notification, so anything older than
 * RELAY_HARD_AGE_S goes regardless of what has or hasn't been said about it.
 */
export const RELAY_SWEEP_SQL = `
  DELETE FROM relay_messages
   WHERE (created_at < ?1 AND NOT (delivered = 0 AND to_device != ''))
      OR created_at < ?2`;

/**
 * The backstop age for RELAY_SWEEP_SQL — deliberately far above SWEEP_AGE_S so
 * that in a working system the cron always wins the race and gets to speak
 * first. If this ever becomes the thing deleting undelivered invokes, the report
 * is broken, and a day of table growth is the cheaper failure.
 */
export const RELAY_HARD_AGE_S = 86400;

/**
 * 💻 THE TASK THAT WAS NEVER DELIVERED — the other end of buildLateReplyEvent.
 *
 * `buildLateReplyEvent` below covers a reply that arrives after the waiter gave
 * up. This covers the case where there is no reply because the device never
 * picked the work up at all.
 *
 * `delivered` flips in exactly one place — RELAY_MARK_SQL, inside RelayPollCall,
 * which only the DEVICE calls. So `delivered = 0` past the sweep window means no
 * device ever fetched this envelope, and RELAY_SWEEP_SQL is about to delete it.
 * Nothing reads relay_messages on a cron; the row simply disappears.
 *
 * What the user was told meanwhile (lib/chat/tools/platform.ts, the 45s
 * timeout): *"The task was DELIVERED; fetch the outcome with use_device
 * action:'result' … later"*. And when they redeem that ticket after the sweep,
 * `recv` finds nothing and the tool answers *"No result yet — the task may still
 * be running"*. Both sentences describe work in progress. The work was never
 * started, and every trace of it is gone.
 *
 * Send-time cannot catch this: RELAY_TARGET_CHECK_SQL gates on
 * (id, owner, revoked) and deliberately NOT on presence — a device that is
 * asleep now may poll in a minute, and refusing the send would break the whole
 * point of a mailbox. So the honest moment is at EXPIRY, not at send.
 *
 * Two rules about SILENCE, each pinned by a test:
 *
 *  (1) ONLY `invoke` ENVELOPES. `type:'notify'` rows are push fan-out
 *      (push.ts relayPushToDevices) — one-way banners with no waiter and no
 *      promise attached, written to every device that heartbeat in the last
 *      NOTIFY_PRESENCE_S. Reporting those would mean a notification about an
 *      undelivered notification, which is both a lie about lost work and a
 *      feedback loop: the report itself sends a push, which writes more notify
 *      envelopes, which expire on a device that went away mid-window. The
 *      `to_device != ''` clause excludes REPLIES for the same reason — a reply
 *      is addressed to the user and is `delivered = 0` by construction until
 *      recv reads it, so counting those would report every answered task as a
 *      lost one.
 *
 *  (2) NEVER BEFORE THE WINDOW. A `delivered = 0` row inside SWEEP_AGE_S is the
 *      HEALTHY state — it is a laptop that has not polled in the last few
 *      seconds. Only a row the sweep is entitled to delete is provably terminal,
 *      which is why this shares the sweep's own cutoff instead of a threshold of
 *      its own: the two can never disagree about what "expired" means.
 *
 * The `type` test is NOT done in SQL. A `payload LIKE '%"type":"invoke"%'` would
 * let a device PROMPT containing that text decide its own envelope's class, and
 * the whole point of rule (1) is that the class is not the caller's to claim. So
 * SQL does the cheap, unforgeable narrowing (`delivered`, the cutoff, the
 * address) and `undeliveredReports` parses the payload — the same way
 * buildLateReplyEvent decides what an envelope was.
 *
 * Bounded by LIMIT so one bad minute cannot turn a tick into a full table scan.
 * When the cap is hit, `sweepRelay` deletes only the rows it actually read — see
 * there; a cap that let unreported rows be deleted would be a quieter version of
 * the very bug this fixes.
 */
export const RELAY_UNDELIVERED_SQL = `
  SELECT id, user_id, payload, created_at
    FROM relay_messages
   WHERE delivered = 0
     AND created_at < ?1
     AND to_device != ''
   ORDER BY created_at ASC
   LIMIT ?2`;

/** Max undelivered rows examined per tick — see RELAY_UNDELIVERED_SQL. */
export const UNDELIVERED_SCAN_MAX = 500;

/**
 * The event kind for work a device never picked up.
 *
 * ⚠️ Named `device_missed`, and it MUST be keyed IN FULL in the icon tables. The
 * bare `device` prefix key (💻, a late reply that DID arrive) would otherwise
 * swallow it and draw "your laptop finished" for "your laptop never started" —
 * exactly the `job` / `job_missed` collision, in the opposite direction: not a
 * missing glyph, a confidently WRONG one.
 */
export const MISSED_KIND = "device_missed";

/** The retention window, re-exported so the cron rail cannot pick its own. */
export const RELAY_SWEEP_AGE_S = SWEEP_AGE_S;

export type UndeliveredRow = {
  id?: unknown; user_id?: unknown; payload?: unknown; created_at?: unknown;
};

export type MissedReport = {
  userId: string;
  count: number;
  oldestAt: number | null;
  /** First lost prompt, clamped — what the user is most likely to recognise. */
  ask: string;
};

/**
 * Group expired-undelivered rows into one report per owner.
 *
 * Pure, so the decision about what counts as a lost task is testable without a
 * D1 mock — and separate from the tick, which is the c30 split: this decides
 * what the user is TOLD, `sweepMissedTasks` decides what the database does.
 *
 * `oldestAt` is the OLDEST lost envelope, not the newest: it is the one the user
 * is least likely to still have on screen. Rows arrive ordered by created_at, so
 * the first one seen for a user is that user's oldest — and its prompt is the
 * `ask` quoted back, because "one of your tasks" is not something anyone can act
 * on but "deploy the worker to production" is.
 */
export function missedReports(rows: UndeliveredRow[] | null | undefined): MissedReport[] {
  const byUser = new Map<string, MissedReport>();
  for (const row of rows || []) {
    const userId = String(row?.user_id || "");
    if (!userId) continue;
    let request: any = null;
    try {
      request = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    } catch { continue; }   // unparseable: not provably an invoke, so not news
    // Rule (1): only an invoke had a waiter and a promise. A notify banner, or
    // anything else a future envelope type introduces, is not a lost task.
    if (!request || request.type !== "invoke") continue;
    const existing = byUser.get(userId);
    if (existing) {
      existing.count += 1;
      continue;
    }
    // A missing created_at must not read as epoch 0 (buildLateReplyEvent's rule
    // — `|| 0` there would date every row to 1970). Null means "not datable".
    const at = row.created_at == null ? null : Number(row.created_at);
    byUser.set(userId, {
      userId,
      count: 1,
      oldestAt: at != null && Number.isFinite(at) ? at : null,
      ask: String(request.prompt || "").replace(/\s+/g, " ").trim().slice(0, 90),
    });
  }
  return [...byUser.values()];
}

/**
 * The sentence the owner gets. Kept beside missedReports for the same
 * reason buildLateReplyEvent is pure: the words are the product surface.
 *
 * It says the three things a user can act on — that the device never picked the
 * task up, WHICH task, and that asking again is the move. It deliberately does
 * NOT say "failed": the task never ran, so there is nothing to inspect, and
 * "failed" would send someone looking for a result that was never produced.
 */
export function missedText(r: MissedReport): { title: string; body: string; detail: string } {
  const more = r.count > 1 ? ` (+${r.count - 1} more)` : "";
  const quoted = r.ask ? `: "${r.ask}"` : "";
  return {
    title: "💻 A task never reached your device",
    body:
      `Your device never picked it up${quoted}${more}. It was not run, and it has now expired. ` +
      `Ask again once the device is online — use_device action:'list' shows which are.`,
    // 🚫, not 💻: this is the kind's own glyph on every HUD (device_missed vs
    // device_result). A detail line that opens with the OTHER kind's glyph would
    // put the two icons side by side in the same row and undo the distinction
    // the roster exists to make.
    detail: `🚫 never delivered — the device did not pick up${quoted}${more}; not run, now expired`,
  };
}

/**
 * Delete exactly the rows named, by id.
 *
 * ⚠️ This is why the reaping moved out of `RELAY_SWEEP_SQL`'s blind
 * `created_at < ?` for the cron path. Reporting is only idempotent because the
 * evidence is deleted in the same breath — so the delete has to be scoped to
 * what was actually READ, or the LIMIT above would silently drop the overflow
 * unreported, which is this whole cycle's bug wearing a bound.
 */
export const relayDeleteByIdsSql = (n: number) =>
  `DELETE FROM relay_messages WHERE id IN (${Array.from({ length: n }, (_, i) => `?${i + 1}`).join(", ")})`;

/**
 * 💻 LATE DEVICE COMPLETIONS → the event ring (e2e report §3.3, loop item d-b).
 *
 * use_device waits 15×3s ≈ 45s and then hands the model a claim ticket
 * (lib/chat/tools/platform.ts: { pending:true, envelope_id }). That fixed the
 * dead-end error, but it left the OTHER half open: when the device finally
 * replies, nothing anywhere knows. The reply sits in the mailbox for its ~1h
 * (SWEEP_AGE_S) and is only ever seen if someone happens to ask the agent to
 * redeem the ticket in that same conversation — close the tab, ask on the
 * phone, or simply forget, and a completed task is silently discarded.
 *
 * So a reply that lands after the waiter gave up now emits an event. The event
 * ring is the one surface every client already polls (ActivityHUD on web,
 * Activity.swift on iOS, Activity.kt on Android) AND that the next turn's
 * system prompt carries (lib/chat/prompt.ts eventsBlock) — so the finished
 * result surfaces in ANY client, and the agent can mention it unprompted with
 * the exact redeem move in hand.
 *
 * Only LATE replies emit: an in-window reply is already returned inline as the
 * tool result, and eventing it too would double-report every device call.
 */
export const LATE_REPLY_S = 45; // == use_device's 15 × 3s wait budget
export const LATE_REPLY_KIND = "device_result";

export function buildLateReplyEvent(p: {
  envelopeId: string;
  requestPayload: unknown;
  ageSeconds: number;
}): { kind: string; detail: string } | null {
  // A non-finite/negative age means clock skew or a missing created_at — treat
  // as "not provably late" and stay silent rather than event a fresh reply.
  if (!Number.isFinite(p.ageSeconds) || p.ageSeconds <= LATE_REPLY_S) return null;
  let request: any = null;
  try {
    request = typeof p.requestPayload === "string" ? JSON.parse(p.requestPayload) : p.requestPayload;
  } catch { /* unparseable original — fall through to the generic detail */ }
  // notify envelopes are one-way banners; nobody is waiting on a result.
  if (request && request.type && request.type !== "invoke") return null;
  const ask = String(request?.prompt || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const secs = Math.round(p.ageSeconds);
  return {
    kind: LATE_REPLY_KIND,
    detail:
      `💻 device finished after ${secs}s${ask ? `: "${ask}"` : ""} — read it with ` +
      `use_device action:'result' envelope_id:'${p.envelopeId}'`,
  };
}

/** Clamp a payload to bounded, valid JSON text. */
export function sanitizeRelayPayload(raw: unknown): string | null {
  try {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
    if (!text || text.length > PAYLOAD_MAX) return null;
    JSON.parse(text); // must be valid JSON
    return text;
  } catch {
    return null;
  }
}

async function authDevice(env: any, deviceId: string, token: string): Promise<string | null> {
  if (!deviceId || !token) return null;
  const row = await env.DB.prepare(RELAY_DEVICE_AUTH_SQL)
    .bind(String(deviceId), await hashDeviceToken(String(token)))
    .first();
  return row?.user_id ? String(row.user_id) : null;
}

function sweep(env: any, ctx?: any): void {
  // Fire-and-forget hygiene — never blocks the request. The promise must be
  // registered with waitUntil: a floating promise may be cancelled when the
  // response returns (sweep silently never runs → relay_messages grows
  // unbounded), and a sync try/catch can't catch an async .run() rejection.
  const now = Math.floor(Date.now() / 1000);
  const p = env.DB.prepare(RELAY_SWEEP_SQL)
    .bind(now - SWEEP_AGE_S, now - RELAY_HARD_AGE_S).run()
    .catch(() => { /* sweep is best-effort */ });
  try { ctx?.waitUntil?.(p); } catch { }
}

export class RelaySendCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: send an envelope to a device (owner-scoped).",
    requestBody: {
      userId: new Str({ required: true }),
      toDevice: new Str({ required: true }),
      payload: new Str({ required: true, description: "JSON string, ≤8KB" }),
    },
    responses: { "200": { description: "Sent", schema: { response: "Sent" } } },
  };

  async handle(request: Request, env: any, ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, toDevice, payload } = data.body;
    if (!userId || !toDevice) return json({ error: "userId and toDevice required" }, 400);

    const clean = sanitizeRelayPayload(payload);
    if (clean === null) return json({ error: "payload must be valid JSON ≤8KB" }, 400);

    // Owner check: you can only address YOUR devices
    const target = await env.DB.prepare(RELAY_TARGET_CHECK_SQL)
      .bind(String(toDevice), String(userId)).first();
    if (!target) return json({ error: "device not found" }, 404);

    const id = crypto.randomUUID();
    await env.DB.prepare(RELAY_INSERT_SQL).bind(
      id, String(userId), String(toDevice), null, clean, Math.floor(Date.now() / 1000)
    ).run();
    sweep(env, ctx);
    return json({ ok: true, id });
  }
}

export class RelayPollCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: device polls its undelivered envelopes (token auth).",
    requestBody: {
      deviceId: new Str({ required: true }),
      token: new Str({ required: true }),
      max: new Int({ required: false }),
    },
    responses: { "200": { description: "Messages", schema: { response: "Messages" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { deviceId, token, max } = data.body;
    const owner = await authDevice(env, deviceId, token);
    if (!owner) return json({ error: "unauthorized" }, 401);

    const limit = Math.min(Math.max(Number(max) || 10, 1), 50);
    const { results } = await env.DB.prepare(RELAY_POLL_SQL)
      .bind(String(deviceId), limit).all();
    // At-most-once: claim each envelope with a conditional UPDATE (CAS on
    // delivered=0) and ONLY return the ones this poll actually won. Two
    // concurrent polls for the same device can SELECT the same undelivered
    // rows; without the CAS both would deliver them (double-execute on the
    // device). Same compare-and-swap the scheduler/telegram flows use.
    const messages: any[] = [];
    for (const r of (results || []) as any[]) {
      const marked = await env.DB.prepare(RELAY_MARK_SQL).bind(r.id).run();
      if (marked?.meta?.changes === 1) {
        messages.push({ id: r.id, payload: r.payload, created_at: r.created_at });
      }
    }
    return json({ ok: true, messages });
  }
}

export class RelayReplyCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: device replies to an envelope (token auth, same-user).",
    requestBody: {
      deviceId: new Str({ required: true }),
      token: new Str({ required: true }),
      inReplyTo: new Str({ required: true }),
      payload: new Str({ required: true, description: "JSON string, ≤8KB" }),
    },
    responses: { "200": { description: "Replied", schema: { response: "Replied" } } },
  };

  async handle(request: Request, env: any, ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { deviceId, token, inReplyTo, payload } = data.body;
    const owner = await authDevice(env, deviceId, token);
    if (!owner) return json({ error: "unauthorized" }, 401);

    const clean = sanitizeRelayPayload(payload);
    if (clean === null) return json({ error: "payload must be valid JSON ≤8KB" }, 400);

    // The original envelope must belong to the SAME user this device belongs
    // to — a device cannot fabricate replies into other users' flows.
    const orig = await env.DB.prepare(RELAY_ENVELOPE_SQL).bind(String(inReplyTo)).first();
    if (!orig || String(orig.user_id) !== owner) return json({ error: "envelope not found" }, 404);

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(RELAY_INSERT_SQL).bind(
      crypto.randomUUID(), owner, "", String(inReplyTo), clean, now
    ).run();

    // 💻 The waiter is long gone — announce the finished work on the event ring
    // so it reaches the user in any client (see buildLateReplyEvent). Deliver
    // FIRST, event second: the reply row is the payload the user actually
    // needs, so an emit failure must never fail the device's PATCH. waitUntil
    // keeps the write alive past the response like sweep() does.
    const late = buildLateReplyEvent({
      envelopeId: String(inReplyTo),
      requestPayload: orig.payload,
      // A missing created_at must read as NaN ("not provably late"), NOT as
      // epoch 0 — `|| 0` there would make every reply look 56 years old.
      ageSeconds: orig.created_at == null ? NaN : now - Number(orig.created_at),
    });
    if (late) {
      const p = emitEvent(env, owner, late.kind, late.detail).catch(() => { /* best-effort */ });
      try { ctx?.waitUntil?.(p); } catch { }
    }
    return json({ ok: true });
  }
}

export class RelayRecvCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: fetch the reply to an envelope (user-scoped).",
    parameters: {
      userId: Query(Str, { required: true }),
      inReplyTo: Query(Str, { required: true }),
    },
    responses: { "200": { description: "Reply", schema: { response: "Reply" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    const userId = data.userId || url.searchParams.get("userId");
    const inReplyTo = data.inReplyTo || url.searchParams.get("inReplyTo");
    if (!userId || !inReplyTo) return json({ error: "userId and inReplyTo required" }, 400);

    const row = await env.DB.prepare(RELAY_RECV_SQL)
      .bind(String(inReplyTo), String(userId)).first();
    if (!row) return json({ ok: true, reply: null });
    return json({ ok: true, reply: { id: row.id, payload: row.payload, created_at: row.created_at } });
  }
}
