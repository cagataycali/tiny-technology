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
import { sendPushToUser, type PushPayload } from "./push";
import { RELAY_INSERT_SQL } from "./relay-shared";

// Re-export: the INSERT moved to relay-shared.ts (leaf) so relay ⇄ push never
// cycle (push.ts writes notify envelopes with it; this file calls push). Tests
// and older importers keep reading it from here.
export { RELAY_INSERT_SQL };

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const PAYLOAD_MAX = 8192;

/**
 * Two-tier sweep (use_device async, G5): one 1h cutoff for everything used to
 * mean a task longer than 1h could never DELIVER — the reply handler requires
 * the original envelope row (RELAY_ENVELOPE_SQL), the sweep had deleted it,
 * and the daemon swallows the failed PATCH. So:
 *   - UNDELIVERED requests keep the tight bound: a device that wasn't polling
 *     must not come back hours later and execute a stale command.
 *   - DELIVERED requests (a device claimed it and is presumably working) and
 *     REPLIES (the result the user redeems — possibly hours after the push
 *     notification) live a day. That day IS the redemption window.
 */
export const SWEEP_AGE_S = 3600; // undelivered envelopes: dead-letter bound
export const SWEEP_SETTLED_AGE_S = 86400; // delivered requests + replies: redemption window

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

// Replies have to_device = '' and are never marked delivered (recv is a
// repeatable read), so the "settled" tier must be keyed on to_device, not on
// the delivered flag alone — `delivered = 0` alone would sweep every reply at
// the short cutoff and re-open the exact gap this fixes.
export const RELAY_SWEEP_SQL = `
  DELETE FROM relay_messages
  WHERE (to_device != '' AND delivered = 0 AND created_at < ?1)
     OR created_at < ?2`;

// The push needs a human name for its title ("💻 studio-mac finished") — the
// auth query deliberately stays untouched (its exact shape is pinned by tests
// as a security invariant), so the name is its own late-path-only lookup.
export const RELAY_DEVICE_NAME_SQL = `
  SELECT name FROM devices WHERE id = ?1`;

/**
 * The grace the write-path sweep gives an undelivered envelope so the per-minute
 * reporter can speak first.
 *
 * RELAY_SWEEP_SQL's short tier exists to stop a device that was offline for hours
 * from waking up and executing a stale command — a bound worth keeping. But that
 * sweep runs on every relay SEND, i.e. exactly when a healthy, active device is
 * around, so with no grace it destroys the evidence `sweepMissedTasks` reports on
 * *preferentially for busy users* — the rail would appear to work in testing and
 * fire least for the people with the most at stake.
 *
 * So the cron reports at SWEEP_AGE_S and reaps by id (relay-missed.ts); the write
 * path only reaps what the cron missed, five minutes later. Executability stays
 * bounded (~65 min, not the 24h a settled-tier-only sweep would allow) and no
 * report is ever destroyed before it is made.
 */
export const MISSED_SWEEP_GRACE_S = 300;

/**
 * 💻 THE TASK THAT WAS NEVER DELIVERED — the other end of buildLateReplyEvent.
 *
 * `buildLateReplyEvent` below covers a reply that arrives after the waiter gave
 * up. This covers the case where there is no reply because the device never
 * picked the work up at all.
 *
 * `delivered` flips in exactly one place — RELAY_MARK_SQL, inside RelayPollCall,
 * which only the DEVICE calls. So `delivered = 0` past the sweep window means no
 * device ever fetched this envelope, and RELAY_SWEEP_SQL's short tier is about to
 * delete it. Before this rail existed nothing read relay_messages on a cron; the
 * row simply disappeared.
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
 *      seconds. So this shares the sweep's short-tier cutoff (SWEEP_AGE_S)
 *      rather than picking a threshold of its own: the two can never disagree
 *      about what "expired" means. The write-path sweep waits a further
 *      MISSED_SWEEP_GRACE_S before reaping, so "expired" is always REPORTED
 *      before it is deleted — reporting early would call a live task lost.
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
 * replies, nothing anywhere knows. The reply sits in the mailbox for its day
 * (SWEEP_SETTLED_AGE_S) and is only ever seen if someone happens to ask the
 * agent to redeem the ticket — close the tab, ask on the phone, or simply
 * forget, and a completed task is silently discarded.
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

/**
 * The one lateness gate, shared by the ring event AND the push so the two
 * announcement rails can never drift: what events also pushes, what stays
 * silent stays silent on both.
 *   - A non-finite/negative age means clock skew or a missing created_at —
 *     "not provably late", stay silent rather than announce a fresh reply.
 *   - notify envelopes are one-way banners; nobody is waiting on a result.
 */
function parseLateInvoke(requestPayload: unknown, ageSeconds: number): { ask: string; secs: number } | null {
  if (!Number.isFinite(ageSeconds) || ageSeconds <= LATE_REPLY_S) return null;
  let request: any = null;
  try {
    request = typeof requestPayload === "string" ? JSON.parse(requestPayload) : requestPayload;
  } catch { /* unparseable original — fall through to the generic text */ }
  if (request && request.type && request.type !== "invoke") return null;
  const ask = String(request?.prompt || "").replace(/\s+/g, " ").trim();
  return { ask, secs: Math.round(ageSeconds) };
}

export function buildLateReplyEvent(p: {
  envelopeId: string;
  requestPayload: unknown;
  ageSeconds: number;
}): { kind: string; detail: string } | null {
  const late = parseLateInvoke(p.requestPayload, p.ageSeconds);
  if (!late) return null;
  const ask = late.ask.slice(0, 90);
  return {
    kind: LATE_REPLY_KIND,
    detail:
      `💻 device finished after ${late.secs}s${ask ? `: "${ask}"` : ""} — read it with ` +
      `use_device action:'result' envelope_id:'${p.envelopeId}'`,
  };
}

/**
 * 🔔 The push half of a late device completion (use_device async, ask 1).
 *
 * The ring event above only surfaces when a client happens to poll or the
 * user happens to send another message — close the laptop after "run the full
 * build on my Mac" and the finished result told nobody. This payload rides
 * sendPushToUser, which already fans out BOTH ways: web push (OS notification
 * via sw.js) and a {type:'notify'} relay envelope every fresh phone banners.
 *
 * Privacy: the body carries the user's own ask (words they typed, already on
 * the event ring), NEVER the device's reply — a result preview on the lock
 * screen stays out until the user opts in.
 *
 * The url IS the redemption UX (design P3): the web app's ?q= deep link
 * auto-sends a visible turn (lib/chat/deep-link.ts — plain ?q= sends unless
 * the tiny is locked or a share is being viewed), so tapping the notification
 * lands the user on the FETCHED RESULT, not an empty chat with homework. The
 * turn's text names the claim ticket, so it also documents the redeem move.
 */
export function buildDeviceResultPush(p: {
  envelopeId: string;
  deviceName?: unknown;
  requestPayload: unknown;
  ageSeconds: number;
}): PushPayload | null {
  const late = parseLateInvoke(p.requestPayload, p.ageSeconds);
  if (!late) return null;
  const name = String(p.deviceName || "").trim().slice(0, 40) || "your device";
  const ask = late.ask.slice(0, 140);
  const redeem =
    `My device finished a background task — fetch it with use_device ` +
    `action:'result' envelope_id:'${p.envelopeId}' and show me the result.`;
  return {
    title: `💻 ${name} finished`,
    body: ask ? `"${ask}" is done — tap to read the result.` : "A background task finished — tap to read the result.",
    url: `/?q=${encodeURIComponent(redeem)}`,
    tag: `device-result-${p.envelopeId}`,
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
    // ⚠️ The undelivered tier is bound SWEEP_AGE_S + MISSED_SWEEP_GRACE_S back,
    // not SWEEP_AGE_S: this runs on every SEND, and reaping an expired invoke
    // here would destroy the evidence sweepMissedTasks (relay-missed.ts) reports
    // on before the per-minute cron ever sees it. See MISSED_SWEEP_GRACE_S.
    .bind(now - SWEEP_AGE_S - MISSED_SWEEP_GRACE_S, now - SWEEP_SETTLED_AGE_S).run()
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
    // A missing created_at must read as NaN ("not provably late"), NOT as
    // epoch 0 — `|| 0` there would make every reply look 56 years old.
    const ageSeconds = orig.created_at == null ? NaN : now - Number(orig.created_at);
    const late = buildLateReplyEvent({
      envelopeId: String(inReplyTo),
      requestPayload: orig.payload,
      ageSeconds,
    });
    if (late) {
      const p = emitEvent(env, owner, late.kind, late.detail).catch(() => { /* best-effort */ });
      try { ctx?.waitUntil?.(p); } catch { }
      // 🔔 …and tell the user NOW, not next-poll: web push + notify envelopes
      // to their fresh phones (sendPushToUser does both legs). Same lateness
      // gate as the event (shared parseLateInvoke), so an in-window reply —
      // already returned inline as the tool result — never double-reports.
      // Best-effort like the event: the reply row is already committed.
      const q = (async () => {
        const dev = await env.DB.prepare(RELAY_DEVICE_NAME_SQL).bind(String(deviceId)).first();
        const push = buildDeviceResultPush({
          envelopeId: String(inReplyTo),
          deviceName: dev?.name,
          requestPayload: orig.payload,
          ageSeconds,
        });
        if (push) await sendPushToUser(env, owner, push);
      })().catch(() => { /* best-effort */ });
      try { ctx?.waitUntil?.(q); } catch { }
    }
    return json({ ok: true });
  }
}

/**
 * 🤖 Batch deposit (spawn_agents async — web repo
 * docs/spawn-agents-async-design-2026-08-02.md).
 *
 * An app-side background continuation (spawn_agents wait:false runs its
 * fan-out via next/server after(), past the closed stream) parks the
 * aggregated result here under a synthetic ticket. The row is a normal
 * reply row (to_device = '', in_reply_to = ticket), so EVERYTHING built
 * for late device replies just works unchanged: the same recv redeems it,
 * the same 24h settled-sweep tier bounds it, the same self-redeeming ?q=
 * push pattern announces it.
 *
 * The ticket MUST live in its own namespace (batch_*): replies are
 * redeemed oldest-first per (in_reply_to, user_id), so a deposit under a
 * REAL envelope id could shadow a genuine device reply. The namespace
 * check makes that collision structurally impossible.
 */
export function isBatchTicket(raw: unknown): boolean {
  return typeof raw === "string" && /^batch_[A-Za-z0-9-]{8,64}$/.test(raw);
}

export class RelayDepositCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: deposit a background result under a batch_* ticket.",
    requestBody: {
      userId: new Str({ required: true }),
      ticket: new Str({ required: true, description: "batch_* ticket, never a device envelope id" }),
      payload: new Str({ required: true, description: "JSON string, ≤8KB" }),
    },
    responses: { "200": { description: "Deposited", schema: { response: "Deposited" } } },
  };

  async handle(request: Request, env: any, ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, ticket, payload } = data.body;
    if (!userId || !isBatchTicket(ticket)) {
      return json({ error: "userId and a batch_* ticket required" }, 400);
    }
    const clean = sanitizeRelayPayload(payload);
    if (clean === null) return json({ error: "payload must be valid JSON ≤8KB" }, 400);
    await env.DB.prepare(RELAY_INSERT_SQL).bind(
      crypto.randomUUID(), String(userId), "", String(ticket), clean, Math.floor(Date.now() / 1000)
    ).run();
    sweep(env, ctx);
    return json({ ok: true });
  }
}

/**
 * 💻 Daemon task completions (use_device async — the LAST hole in "trigger
 * and forget on the Mac"). A relay invoke that the daemon's agent offloads to
 * its own use_tasks runner replies IN-WINDOW ("Task started…"), so the
 * late-reply push never fires; when the task finishes minutes later, the
 * daemon only showed a DESKTOP notification. This endpoint is the missing
 * rail: the daemon posts the finished task here on its DEVICE TOKEN, and the
 * result gets the full late-reply treatment — a deposit row redeemable via
 * use_device action:'result', a ring event (kind device_task_result: the
 * `device` prefix already renders 💻 on every surface), and ONE push whose
 * url is the same self-redeeming ?q= pattern.
 *
 * Ticket = task_<device-id-8>_<taskId>: the task_ namespace can never collide
 * with envelope uuids or batch_ tickets, and the device-id prefix scopes a
 * device-supplied taskId to the device that authed — one daemon can never
 * shadow another device's (or another user's) tickets.
 */
export function taskTicket(deviceId: string, taskId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(taskId)) return null;
  return `task_${deviceId.replace(/-/g, "").slice(0, 8)}_${taskId}`;
}

export function buildTaskResultPush(p: {
  ticket: string;
  deviceName?: unknown;
  summary?: unknown;
}): PushPayload {
  const name = String(p.deviceName || "").trim().slice(0, 40) || "your device";
  const summary = String(p.summary || "").replace(/\s+/g, " ").trim().slice(0, 140);
  const redeem =
    `My device finished a background task — fetch it with use_device ` +
    `action:'result' envelope_id:'${p.ticket}' and show me the result.`;
  return {
    title: `💻 ${name} finished a background task`,
    body: summary ? `"${summary}" is done — tap to read the result.` : "A background task finished — tap to read the result.",
    url: `/?q=${encodeURIComponent(redeem)}`,
    tag: `task-result-${p.ticket}`,
  };
}

export class RelayTaskResultCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: a daemon's background task finished — deposit + announce (device token auth).",
    requestBody: {
      deviceId: new Str({ required: true }),
      token: new Str({ required: true }),
      taskId: new Str({ required: true, description: "The daemon's task id (use_tasks), [A-Za-z0-9_-]{1,48}" }),
      summary: new Str({ required: false, description: "One-line what-was-asked (≤140 shown on the push)" }),
      result: new Str({ required: true, description: "The finished result text (deposited, ≤7KB)" }),
    },
    responses: { "200": { description: "Announced", schema: { response: "Announced" } } },
  };

  async handle(request: Request, env: any, ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { deviceId, token, taskId, summary, result } = data.body;
    const owner = await authDevice(env, deviceId, token);
    if (!owner) return json({ error: "unauthorized" }, 401);

    const ticket = taskTicket(String(deviceId), String(taskId ?? ""));
    if (!ticket) return json({ error: "taskId must be [A-Za-z0-9_-]{1,48}" }, 400);

    const clean = sanitizeRelayPayload(JSON.stringify({ result: String(result ?? "").slice(0, 7000) }));
    if (clean === null) return json({ error: "result payload must fit 8KB" }, 400);

    // Deposit FIRST (the payload the user redeems), announcements second —
    // the same order the late-reply path pins.
    await env.DB.prepare(RELAY_INSERT_SQL).bind(
      crypto.randomUUID(), owner, "", ticket, clean, Math.floor(Date.now() / 1000)
    ).run();

    const dev = await env.DB.prepare(RELAY_DEVICE_NAME_SQL).bind(String(deviceId)).first();
    const name = String(dev?.name || "device");
    const brief = String(summary || "").replace(/\s+/g, " ").trim().slice(0, 90);
    const p = emitEvent(
      env, owner, "device_task_result",
      `💻 ${name} finished${brief ? `: "${brief}"` : " a background task"} — read it with ` +
      `use_device action:'result' envelope_id:'${ticket}'`,
    ).catch(() => { /* best-effort */ });
    try { ctx?.waitUntil?.(p); } catch { }
    const q = sendPushToUser(env, owner, buildTaskResultPush({ ticket, deviceName: dev?.name, summary }))
      .catch(() => { /* best-effort */ });
    try { ctx?.waitUntil?.(q); } catch { }

    sweep(env, ctx);
    return json({ ok: true, ticket });
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
