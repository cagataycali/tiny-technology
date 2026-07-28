/**
 * 🚨 THE PAGER FOR THE THREE MONEY RAILS — the c53 loose end.
 *
 * (Two of them are the x402 reconciliation queues. The third, WITHDRAWALS, was
 * added in c32 of the review loop: it has no sweep at all, so its stuck state is
 * terminal rather than slow, and it is the only rail here where the frozen money
 * has already left a user's own balance. See `alarmConditions`.)
 *
 * c53 shipped `GET /pay/reconcile-status`: queue depth, backlog age, resolution
 * histograms, and the rows that will never resolve on their own. It deliberately
 * shipped the SURFACE and not the pager, because the threshold is a judgement
 * call about what should wake somebody. But an endpoint nobody polls is unread,
 * which is the same failure the endpoint itself exists to fix one level down —
 * migrations 0027 and 0028 each paid a real design cost so that queue depth
 * would be a meaningful alarm, and then nothing looked at the number. This is
 * the thing that looks, on the per-minute cron that already computes both
 * summaries.
 *
 * ⚠️⚠️ THE HARD PART IS NOT DETECTING TROUBLE — IT IS NOT CRYING WOLF. An alarm
 * that fires on a healthy state gets muted, and a muted alarm is worse than no
 * alarm because the mute is invisible. So four rules, each of which is a rule
 * about SILENCE:
 *
 *  (1) NEVER PAGE ON `open > 0`. The healthy, expected, by-design state of
 *      `settle_unknown` is "several rows waiting for a confirmation that is very
 *      likely coming" — the transaction was signed, accepted and broadcast; we
 *      merely failed to see the receipt inside 60s. Depth is not distress.
 *      `alarmConditions` therefore never reads `open`, `oldest_*_age_s`, `total`
 *      or `unpaid_micro`; a test asserts a queue of 500 open rows with nothing
 *      blocked produces no conditions on any tick. What it reads instead is
 *      `blocked_in_next_batch` — the head-of-line metric c53 argued is the one
 *      that matters, because both sweeps take the OLDEST rows and skip the
 *      unresolvable ones IN PLACE, so a few permanently-blocked rows at the head
 *      consume every batch forever and a resolvable payment behind them is never
 *      reached. A queue of 6 with 5 blocked at the head is more broken than a
 *      queue of 400.
 *
 *      ⚠️ The WITHDRAWAL conditions obey the same rule through a different door.
 *      A `pending` withdrawal inside its window is invisible here, because a
 *      payout in flight is the healthy state. What is read is a row past
 *      `WITHDRAWAL_STUCK_S` — which has no mover left anywhere in the platform,
 *      since the only thing that ever advances it is the HTTP request that
 *      created it. Terminal by construction, not merely slow.
 *
 *  (2) TWO CONSECUTIVE TICKS. A condition seen once is recorded, not delivered.
 *      One tick can catch a queue mid-write; two cannot.
 *
 *  (3) BOUNDED RE-NOTIFICATION. The same problem re-pages at most every
 *      ALARM_RENOTIFY_S, and *any* delivery is followed by at least
 *      ALARM_MIN_GAP_S of quiet — even when the problem changes shape. Two
 *      gates, the tighter one always applies, so a flapping blocker cannot turn
 *      this into a per-minute feed.
 *
 *  (4) ZERO RPC. c53's endpoint asks the chain nothing, on purpose. An alarm
 *      that costs an `eth_call` per minute is an alarm someone turns off. This
 *      module makes no chain call, and its test forbids every outbound fetch
 *      except the delivery itself.
 *
 * ⚠️ AND IT MUST NOT BE A SILENT OFF SWITCH. Delivery needs a destination, and
 * this codebase has no operator identity to infer one from — so it takes an env
 * var, which is exactly the shape that fails invisibly (unset var → no pages →
 * looks identical to "nothing is wrong", forever). Two mitigations, both
 * load-bearing: the decision runs and the state advances whether or not a
 * destination exists, and `GET /pay/reconcile-status` reports the alarm's own
 * view (`configured`, the live conditions, the streak, when it last spoke) — so
 * the surface an operator already polls says out loud that the pager is off.
 *
 * ⚠️ THE PAGE GOES OUT ON THE RING FIRST, TELEGRAM SECOND. `emitEvent` is a D1
 * write with no network and no third-party token, and it lands where the
 * operator's own agent will read it on its next turn. Telegram is opportunistic
 * on top, through the destination user's OWN bot and their OWN chat allowlist —
 * no new secret, no new allowlist, and nothing is ever sent to a chat that user
 * has not confirmed.
 */
import { emitEvent } from "./events";
import { tg } from "./telegram";

/** KV key holding the between-ticks state. KV `tiny` binding is always present. */
export const ALARM_KV_KEY = "pay-reconcile-alarm:state";
/** Consecutive ticks a condition must hold before anything is delivered (rule 2). */
export const ALARM_MIN_TICKS = 2;
/** Minimum quiet after ANY delivery, including one about a different problem. */
export const ALARM_MIN_GAP_S = 30 * 60;
/** How often the SAME problem may re-page while it stays unfixed. */
export const ALARM_RENOTIFY_S = 6 * 3600;
/** Env var naming the destination user (their ring, and their bot if enabled). */
export const ALARM_USER_VAR = "RECONCILE_ALARM_USER";
/** Event ring kind. Distinct from 'tool-update' — this one is about money. */
export const ALARM_EVENT_KIND = "pay_alarm";

export type AlarmCondition = { kind: string; detail: string };

export type AlarmState = {
  /** The signature seen on the previous tick. '' = nothing wrong. */
  sig: string;
  /** How many consecutive ticks that signature has held. */
  streak: number;
  /** The signature we last PAGED about; '' when nothing is outstanding. */
  notifiedSig: string;
  /** unixepoch of the last delivery of any kind (page or recovery). */
  notifiedAt: number;
};

export const EMPTY_ALARM_STATE: AlarmState = { sig: "", streak: 0, notifiedSig: "", notifiedAt: 0 };

/**
 * Coerce a reported count LOUDLY.
 *
 * The safe direction here is the opposite of c56's `peakDb`: for a metric a
 * human reads, a coerced garbage value that renders as the calmest possible
 * reading is the bug. For an ALARM, the dangerous direction is silence — a
 * condition that fails to register is a payment nobody is ever told about. So
 * `null`/missing (genuinely "not measured", handled separately by the
 * readability check) are 0, and anything numeric-ish counts.
 */
function count(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * What, if anything, is wrong — read off a `/pay/reconcile-status` body.
 *
 * ⚠️ Every field consulted here is one that CANNOT clear on its own. That is the
 * whole selection rule, and it is why `open` is absent: an open row is a row the
 * next tick may well resolve, while a blocked one is skipped identically every
 * minute forever, because nothing about a stored row changes by itself.
 */
export function alarmConditions(status: any): AlarmCondition[] {
  const out: AlarmCondition[] = [];
  const sent: any = status?.spend_sent || {};
  const unknown: any = status?.settle_unknown || {};

  // "I could not look" is not "nothing is wrong" — the endpoint's own doctrine
  // for `healthy`, inherited rather than re-decided. `!== true` (not `=== false`)
  // so a malformed body reads as unreadable instead of as calm.
  if (sent.present !== true) {
    out.push({ kind: "sent_unreadable", detail: `spend_sent unreadable: ${String(sent.error || "no reason reported")}` });
  }
  if (unknown.present !== true) {
    out.push({ kind: "unknown_unreadable", detail: `settle_unknown unreadable: ${String(unknown.error || "no reason reported")}` });
  }

  // Head-of-line waste, both sides. THE metric (rule 1).
  const sentHead = count(sent.blocked_in_next_batch);
  if (sentHead > 0) {
    out.push({
      kind: "sent_head_blocked",
      detail: `${sentHead} of the next ${count(sent.batch) || "?"} spend_sent rows will be skipped again (unnameable network) — nothing behind them is reached`,
    });
  }
  const unkHead = count(unknown.blocked_in_next_batch);
  if (unkHead > 0) {
    out.push({
      kind: "unknown_head_blocked",
      detail: `${unkHead} of the next ${count(unknown.batch) || "?"} settle_unknown rows will be skipped again — creators behind them are never paid`,
    });
  }

  // 💸 A WITHDRAWAL NOBODY WILL EVER TOUCH AGAIN. This one passes rule 1 more
  // cleanly than anything else here: a `pending` row past the stuck window has NO
  // mover left in the platform (its only one was the HTTP request that created it,
  // long since over), so it is not a row that might drain next tick — it is
  // terminal by construction. And it is the only condition in this file where the
  // frozen money already LEFT a user's balance.
  //
  // Two kinds, two different hands, so two kinds rather than one total: an
  // unbroadcast row is safe to refund, while a broadcast one must be checked
  // on-chain first or refunding it pays twice. A single count would invite the
  // dangerous half.
  const wd: any = status?.withdrawals || {};
  if (wd.present !== true) {
    out.push({ kind: "withdrawals_unreadable", detail: `withdrawals unreadable: ${String(wd.error || "no reason reported")}` });
  }
  const unbroadcast = count(wd.unbroadcast);
  if (unbroadcast > 0) {
    out.push({
      kind: "withdrawal_never_broadcast",
      detail: `${unbroadcast} withdrawal(s) worth $${(count(wd.unbroadcast_micro) / 1e6).toFixed(4)} were DEBITED and never broadcast — nothing left the payout wallet, so these are safe to refund`,
    });
  }
  const unconfirmed = count(wd.broadcast_unconfirmed);
  if (unconfirmed > 0) {
    out.push({
      kind: "withdrawal_unconfirmed",
      detail: `${unconfirmed} withdrawal(s) worth $${(count(wd.broadcast_unconfirmed_micro) / 1e6).toFixed(4)} were broadcast and never confirmed — CHECK THE CHAIN before refunding, or the user is paid twice`,
    });
  }

  // Reservations frozen with nothing on any queue to release them: a mark stored
  // without identity, or a pre-0026 row. Invisible to the sweep BY DESIGN, so
  // this report is the only place they can ever surface.
  const unresolvable = count(sent.unresolvable);
  if (unresolvable > 0) {
    out.push({
      kind: "sent_unresolvable",
      detail: `${unresolvable} spend_sent reservation(s) have no identity to resolve — held forever without a human`,
    });
  }

  // Named blockers get their own kinds, so a NEW kind of blocker appearing is new
  // information and re-pages (rule 3's signature change) instead of hiding inside
  // an unchanged total.
  const reasons: Record<string, any> = unknown.blocked_reasons && typeof unknown.blocked_reasons === "object"
    ? unknown.blocked_reasons : {};
  const named = Object.keys(reasons).filter((r) => count(reasons[r]) > 0).sort();
  for (const reason of named) {
    out.push({ kind: `unknown_blocker:${reason}`, detail: `settle_unknown: ${count(reasons[reason])} × ${reason}` });
  }
  // Fallback: a blocked count with no enumeration must still be a condition, or a
  // status body that reports the total but not the breakdown reads as healthy.
  const unkBlocked = count(unknown.blocked);
  if (unkBlocked > 0 && named.length === 0) {
    out.push({ kind: "unknown_blocked", detail: `${unkBlocked} settle_unknown row(s) can never resolve on their own` });
  }

  return out;
}

/**
 * The identity of a problem, for the two-tick and re-notify rules.
 *
 * KINDS ONLY, never counts. A queue that grows by one row a minute would
 * otherwise present a brand-new signature every tick: the streak would never
 * reach two and it would ALSO defeat the re-notify gate — silence and a flood
 * from the same mistake.
 */
export function alarmSignature(conditions: AlarmCondition[]): string {
  return conditions.map((c) => c.kind).sort().join("|");
}

export type AlarmDecision = {
  /** What to deliver, if anything. */
  fire: "alert" | "recovery" | null;
  /** The state to persist for the next tick. */
  state: AlarmState;
  /** This tick's signature ('' = clear) and how long it has held. */
  sig: string;
  streak: number;
  /** Why nothing was delivered, when nothing was — for the status surface. */
  suppressed: string | null;
};

/**
 * Should this tick speak? Pure: the whole policy, with no clock, KV or network
 * of its own.
 *
 * Recovery is gated symmetrically with the alert (`ALARM_MIN_TICKS` of clear),
 * because a one-tick clear between two blocked ticks is a flap, not a fix, and
 * "resolved" is the message an operator is most likely to believe.
 */
export function alarmDecide(input: {
  conditions: AlarmCondition[];
  prev: AlarmState;
  nowSec: number;
  minTicks?: number;
  minGapS?: number;
  renotifyS?: number;
}): AlarmDecision {
  const minTicks = input.minTicks ?? ALARM_MIN_TICKS;
  const minGapS = input.minGapS ?? ALARM_MIN_GAP_S;
  const renotifyS = input.renotifyS ?? ALARM_RENOTIFY_S;
  const prev = input.prev || EMPTY_ALARM_STATE;
  const nowSec = Math.floor(Number(input.nowSec) || 0);

  const sig = alarmSignature(input.conditions || []);
  const streak = prev.sig === sig ? Math.max(0, Math.floor(Number(prev.streak) || 0)) + 1 : 1;
  const since = nowSec - Math.max(0, Math.floor(Number(prev.notifiedAt) || 0));
  const next: AlarmState = { sig, streak, notifiedSig: prev.notifiedSig || "", notifiedAt: prev.notifiedAt || 0 };

  if (!sig) {
    // Clear. Only worth saying if we said the opposite.
    if (!prev.notifiedSig) return { fire: null, state: next, sig, streak, suppressed: "nothing wrong" };
    if (streak < minTicks) return { fire: null, state: next, sig, streak, suppressed: `clear for ${streak}/${minTicks} ticks` };
    return {
      fire: "recovery",
      state: { ...next, notifiedSig: "", notifiedAt: nowSec },
      sig, streak, suppressed: null,
    };
  }

  if (streak < minTicks) {
    return { fire: null, state: next, sig, streak, suppressed: `held for ${streak}/${minTicks} ticks` };
  }
  // The same problem waits out the long clock; a DIFFERENT one only waits out the
  // short one — but it does wait, so a shape-shifting blocker cannot page every
  // minute by changing its name.
  const wait = sig === prev.notifiedSig ? renotifyS : minGapS;
  if (prev.notifiedAt && since < wait) {
    return { fire: null, state: next, sig, streak, suppressed: `quiet for another ${wait - since}s` };
  }
  return {
    fire: "alert",
    state: { ...next, notifiedSig: sig, notifiedAt: nowSec },
    sig, streak, suppressed: null,
  };
}

/** Parse persisted state, tolerating absence and garbage (a lost state costs one
 *  tick of delay, never a false page). */
export function parseAlarmState(raw: any): AlarmState {
  if (!raw) return { ...EMPTY_ALARM_STATE };
  let obj: any = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return { ...EMPTY_ALARM_STATE }; }
  }
  if (!obj || typeof obj !== "object") return { ...EMPTY_ALARM_STATE };
  return {
    sig: typeof obj.sig === "string" ? obj.sig : "",
    streak: Math.max(0, Math.floor(Number(obj.streak) || 0)),
    notifiedSig: typeof obj.notifiedSig === "string" ? obj.notifiedSig : "",
    notifiedAt: Math.max(0, Math.floor(Number(obj.notifiedAt) || 0)),
  };
}

/**
 * The delivered text. `short` is what the event ring stores (`emitEvent` slices
 * at 300 chars, so the summary line must come FIRST or the truncation eats the
 * actionable part); `full` is what Telegram gets.
 */
export function formatAlarmText(
  fire: "alert" | "recovery",
  conditions: AlarmCondition[],
  status: any,
): { short: string; full: string } {
  // 💸 Money that ARRIVED on-chain and reached no creator, on rows that are now
  // CLOSED (c63). It is deliberately NOT a condition — see `alarmConditions`, and
  // rule 1: this cannot be fixed by the sweep, so paging on it would page forever.
  // But it is the one fact that makes a recovery message TRUE or FALSE, so it
  // belongs in the text of both.
  const stranded = count(status?.settle_unknown?.stranded);
  const strandedMicro = count(status?.settle_unknown?.stranded_micro);
  const strandedLine = stranded > 0
    ? `⚠️ ${stranded} settled payment(s) worth $${(strandedMicro / 1e6).toFixed(4)} reached NO creator (terminal: ${STRANDED_HINT}) — a human decides these`
    : "";

  if (fire === "recovery") {
    // ⚠️ THE RETRACTION THAT WAS FALSE (c63, measured). This used to be one
    // unconditional sentence, and the sequence that produced it is ordinary: the
    // pager alerted on `unknown_blocker:price raised above the credited amount`,
    // the sweep then marked that row `split_underfunded` — correctly; it can never
    // resolve itself — and two ticks later this function said "clear again" while
    // the owner's balance was still 0 and the payer's money sat on-chain at our
    // pay-to address. Every number `alarmConditions` reads had genuinely gone
    // quiet, because all of them describe the OPEN queue and the row had left it.
    //
    // The decision is right and stays untouched: nothing is blocked, so nothing
    // will page again. What was wrong was the CLAIM. "Clear again" invites an
    // operator to close the ticket, so a retraction that omits the money is worse
    // than the silence it replaces — the alert at least left a trail.
    const head = "✅ Money rails are clear again — no blocked rows, no stuck withdrawals.";
    if (!strandedLine) return { short: head, full: head };
    const short = `${head} ${strandedLine}`.slice(0, 280);
    return {
      short,
      full: [head, "", strandedLine, "", "Full picture: GET /pay/reconcile-status (internal key, zero RPC)."].join("\n"),
    };
  }
  const kinds = conditions.map((c) => c.kind);
  const short = `🚨 money rails stuck: ${kinds.join(", ")}. GET /pay/reconcile-status`.slice(0, 280);
  const unpaid = count(status?.settle_unknown?.unpaid_micro);
  const lines = [
    "🚨 a money rail needs a human",
    "",
    ...conditions.map((c) => `• ${c.detail}`),
    "",
    // Context, never a cause (rule 1): depth and money owed explain the page, and
    // by themselves would never have produced one.
    `queues: spend_sent open ${count(status?.spend_sent?.open)}, settle_unknown open ${count(status?.settle_unknown?.open)}`,
    // Context for the withdrawal conditions, on the same never-a-cause footing:
    // the TOTAL frozen debit, so the sentence an operator quotes carries the size
    // of the problem and not just its shape.
    count(status?.withdrawals?.stuck) > 0
      ? `withdrawals frozen: ${count(status?.withdrawals?.stuck)} worth $${(count(status?.withdrawals?.stuck_micro) / 1e6).toFixed(4)}, already debited from user balances`
      : "",
    unpaid > 0 ? `unpaid to creators (resolvable rows): $${(unpaid / 1e6).toFixed(4)}` : "",
    strandedLine,
    "",
    "Full picture: GET /pay/reconcile-status (internal key, zero RPC).",
  ].filter((l) => l !== "");
  return { short, full: lines.join("\n") };
}

/** Named in both messages so the reader knows which verdicts to query for.
 *  A string, not a lookup: this module must not import `payments.ts` (that
 *  import runs the other way, lazily, in `sweepReconcileAlarm`). */
const STRANDED_HINT = "split_underfunded / tx_claimed_elsewhere";

/**
 * Deliver. Ring first (D1, no network, always available), then the destination
 * user's own Telegram bot when they have one enabled with a confirmed chat.
 *
 * Each rail is isolated — the `messages.ts` fan-out rule — because a Telegram
 * outage must not swallow the page that already landed on the ring.
 */
async function deliverAlarm(env: any, userId: string, text: { short: string; full: string }): Promise<{ ring: boolean; telegram: number }> {
  const out = { ring: false, telegram: 0 };
  try {
    await emitEvent(env, userId, ALARM_EVENT_KIND, text.short);
    out.ring = true;
  } catch (err) { console.log(err, "reconcileAlarm ring"); }
  try {
    const bot: any = await env.DB.prepare(
      "SELECT token, allowed_chats, enabled FROM telegram_bots WHERE user_id = ?",
    ).bind(userId).first();
    if (bot?.enabled && bot.token && bot.allowed_chats) {
      const chats = String(bot.allowed_chats).split(",").map((s: string) => s.trim()).filter(Boolean);
      for (const chatId of chats) {
        const res: any = await tg(String(bot.token), "sendMessage", { chat_id: chatId, text: text.full.slice(0, 3500) });
        if (res?.ok) out.telegram += 1;
      }
    }
  } catch (err) { console.log(err, "reconcileAlarm telegram"); }
  return out;
}

/**
 * Cron entrypoint. Never throws — it shares a `scheduled` handler with job
 * dispatch and both reconcilers, and a pager that can take down the sweep it
 * watches is worse than no pager.
 *
 * Reads the SAME summary the endpoint serves (`reconcileStatus`), imported
 * lazily so `payments.ts` never has to import this module back.
 */
export async function sweepReconcileAlarm(env: any, nowSec: number): Promise<{
  fire: "alert" | "recovery" | null; streak: number; sig: string; delivered: boolean; configured: boolean;
} | null> {
  try {
    const { reconcileStatus } = await import("./payments");
    const status = await reconcileStatus(env, nowSec);
    const conditions = alarmConditions(status);

    let prev: AlarmState = { ...EMPTY_ALARM_STATE };
    try { prev = parseAlarmState(await env.tiny.get(ALARM_KV_KEY)); } catch { /* first run / no KV */ }

    const decision = alarmDecide({ conditions, prev, nowSec });

    // Persist BEFORE delivering, the `sweepToolUpdates` rule: two overlapping
    // crons must not each send the same page, and a delivery that half-fails
    // must not re-page every minute afterwards.
    try { await env.tiny.put(ALARM_KV_KEY, JSON.stringify(decision.state)); } catch (err) { console.log(err, "reconcileAlarm state"); }

    const userId = String(env?.[ALARM_USER_VAR] || "").trim();
    if (!decision.fire) return { fire: null, streak: decision.streak, sig: decision.sig, delivered: false, configured: !!userId };

    const text = formatAlarmText(decision.fire, conditions, status);
    if (!userId) {
      // The off switch, said out loud. Also reported by /pay/reconcile-status.
      console.log(`reconcileAlarm: no ${ALARM_USER_VAR} configured — would have sent: ${text.short}`);
      return { fire: decision.fire, streak: decision.streak, sig: decision.sig, delivered: false, configured: false };
    }
    const sent = await deliverAlarm(env, userId, text);
    return { fire: decision.fire, streak: decision.streak, sig: decision.sig, delivered: sent.ring || sent.telegram > 0, configured: true };
  } catch (err) {
    console.log(err, "sweepReconcileAlarm");
    return null;
  }
}

/**
 * The alarm's own state, for `GET /pay/reconcile-status`.
 *
 * This block is the mitigation for the env-var-shaped off switch: it says
 * whether a destination exists, what the pager can currently see, and when it
 * last spoke — on the surface an operator already polls. Read-only, and it
 * reports rather than advances the streak (a monitor curling the endpoint must
 * not satisfy the two-tick rule on the cron's behalf).
 */
export async function alarmView(env: any, status: any, nowSec: number): Promise<any> {
  const conditions = alarmConditions(status);
  let state: AlarmState | null = null;
  let stateError: string | null = null;
  try { state = parseAlarmState(await env.tiny.get(ALARM_KV_KEY)); } catch (err: any) { stateError = String(err?.message || err).slice(0, 120); }
  const configured = !!String(env?.[ALARM_USER_VAR] || "").trim();
  return {
    configured,
    // Named so an operator reading a green `healthy` next to this cannot miss it.
    note: configured ? undefined : `set ${ALARM_USER_VAR} or nothing will ever page`,
    conditions: conditions.map((c) => c.kind),
    details: conditions.map((c) => c.detail),
    streak: state ? state.streak : null,
    outstanding: state ? state.notifiedSig || null : null,
    last_notified_age_s: state?.notifiedAt ? Math.max(0, nowSec - state.notifiedAt) : null,
    min_ticks: ALARM_MIN_TICKS,
    renotify_s: ALARM_RENOTIFY_S,
    state_error: stateError || undefined,
  };
}
