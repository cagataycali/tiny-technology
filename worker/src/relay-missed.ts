/**
 * 💻 THE TASK THAT NEVER REACHED THE DEVICE — the cron half of relay.ts.
 *
 * relay.ts documents the finding in full above RELAY_UNDELIVERED_SQL. In short:
 * `delivered` flips in exactly one place (RELAY_MARK_SQL, inside RelayPollCall,
 * which only the DEVICE calls), so an `invoke` envelope still at `delivered = 0`
 * once it is older than SWEEP_AGE_S was never picked up by anything. The
 * opportunistic sweep then DELETEs it, and nothing anywhere ever said a word —
 * while `use_device` had already told the model *"The task was delivered"* and
 * the promised ticket answers *"No result yet — the task may still be running"*.
 *
 * ⚠️ WHY THIS MODULE EXISTS SEPARATELY FROM relay.ts:
 * `push.ts` imports RELAY_INSERT_SQL from relay.ts (every push also becomes a
 * `notify` envelope). This rail needs sendPushToUser, so putting it in relay.ts
 * would close an import cycle — the same reason reconcile-alarm.ts is not inside
 * payments.ts.
 *
 * ⚠️ WHY REPORTING AND REAPING ARE ONE OPERATION:
 * There is no `reported` column, and adding one would need a migration to every
 * deployment. The DELETE is therefore the idempotency mechanism: a row is
 * reported exactly once because it does not survive being reported. That makes
 * ordering load-bearing in a way a comment cannot enforce, so the delete is
 * scoped BY ID to the rows this tick actually read (relayDeleteByIdsSql) instead
 * of reusing RELAY_SWEEP_SQL's blind `created_at < ?`. With a blind delete, any
 * row past the scan LIMIT would be destroyed unreported — the original bug,
 * wearing a bound.
 *
 * ⚠️ WHY IT CANNOT LIVE IN relay.ts's `sweep()`:
 * That helper runs on every relay SEND. A send is exactly when a healthy, active
 * device is around, so the write path would keep destroying evidence between
 * ticks and the report would fire only for users whose devices are idle — the
 * opposite of the population it is for. This runs on the per-minute cron, and
 * the write-path sweep no longer has to be the thing that reaps invokes.
 */
import { emitEvent } from "./events";
import { sendPushToUser } from "./push";
import {
  RELAY_UNDELIVERED_SQL,
  UNDELIVERED_SCAN_MAX,
  MISSED_KIND,
  RELAY_SWEEP_AGE_S,
  relayDeleteByIdsSql,
  missedReports,
  missedText,
  type UndeliveredRow,
} from "./relay";

/**
 * Report every expired-undelivered invoke, then delete exactly what was
 * reported. Never throws — a notification rail having a bad day must not take
 * down job dispatch beside it on the same tick (reconcile-alarm's discipline).
 */
export async function sweepMissedTasks(
  env: any,
  nowSec: number,
): Promise<{ users: number; envelopes: number; scanned: number; reaped: number }> {
  const none = { users: 0, envelopes: 0, scanned: 0, reaped: 0 };
  try {
    const cutoff = nowSec - RELAY_SWEEP_AGE_S;
    const { results } = await env.DB.prepare(RELAY_UNDELIVERED_SQL)
      .bind(cutoff, UNDELIVERED_SCAN_MAX)
      .all();
    const rows = (results || []) as UndeliveredRow[];
    if (!rows.length) return none;

    const reports = missedReports(rows);
    let envelopes = 0;
    for (const r of reports) {
      envelopes += r.count;
      const told = missedText(r);
      // Event first, push second. The ring is what every client polls and what
      // the next turn's prompt carries, so it is the delivery that matters most;
      // a failing push must not cost the user the event. Each is isolated so one
      // owner's failure does not skip the next owner's report.
      try {
        await emitEvent(env, r.userId, MISSED_KIND, told.detail);
      } catch (err) { console.log(err, "sweepMissedTasks emit"); }
      try {
        await sendPushToUser(env, r.userId, {
          title: told.title,
          body: told.body,
          url: "/devices",
          // Tagged per TICK, not per user-forever: several lost tasks in one
          // tick collapse into the one report that already counts them, but a
          // later tick's report is genuinely new work the user has since asked
          // for and must not be collapsed into this one.
          tag: `tiny-missed-${nowSec}`,
        });
      } catch (err) { console.log(err, "sweepMissedTasks push"); }
    }

    // Reap ONLY what was read — see the header. Includes the rows that were
    // scanned but were not invokes (notify banners, unparseable payloads): they
    // are past the retention window and the write-path sweep would have removed
    // them anyway, so leaving them would mean re-scanning them every tick
    // forever and starving real invokes out of the LIMIT.
    const ids = rows.map((r) => String((r as any).id || "")).filter(Boolean);
    let reaped = 0;
    if (ids.length) {
      const res = await env.DB.prepare(relayDeleteByIdsSql(ids.length)).bind(...ids).run();
      reaped = Number(res?.meta?.changes ?? 0);
    }
    return { users: reports.length, envelopes, scanned: rows.length, reaped };
  } catch (err) {
    console.log(err, "sweepMissedTasks");
    return none;
  }
}
