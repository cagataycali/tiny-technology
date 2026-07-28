/**
 * Scheduler (issue #10, COMPARISON.md §2.1) — D1-backed jobs fired by a
 * Cloudflare Cron Trigger every minute.
 *
 * Schedule expressions (careless-compatible):
 *   'every Nm/Nh' (written star-slash-Nm) — every N minutes/hours
 *   'daily@09:00'                         — every day at HH:MM (UTC)
 *   one-shot                              — schedule NULL, run_at unix secs
 *
 * Learnings applied (careless race + devduck semantics):
 *   - double-fire guard: compare-and-swap UPDATE on last_fired_at
 *   - catch-up window: fires jobs missed up to 24h ago (once)
 *   - per-run history in job_runs, result events on the user's event bus
 *
 * Endpoints (internal): POST /jobs (create), GET /jobs?userId=,
 * DELETE /jobs, POST /jobs/toggle
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { emitEvent } from "./events";
import { sendPushToUser } from "./push";

const MAX_JOBS_PER_USER = 10;
const RUN_HISTORY_KEEP = 20;

/**
 * Double-fire guard — exported so tests/scheduler-cas.test.ts runs the REAL
 * statement against sqlite. `IS` (null-safe equality), NOT `=`: a job with
 * last_fired_at NULL is judged 'fire' by jobFireDecision (falls back to
 * created), but `last_fired_at = NULL` is never true in SQL, so `=` would
 * make NULL rows unclaimable FOREVER. Only one concurrent runner's UPDATE
 * reports changes=1; the loser sees 0 and skips.
 */
export const CLAIM_SQL =
  "UPDATE jobs SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ? AND last_fired_at IS ?";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Next due time (unix secs) strictly after `after` for a schedule expr. */
export function nextDue(schedule: string | null, runAt: number | null, after: number): number | null {
  if (!schedule) return runAt && runAt > after ? runAt : (runAt || null);
  const every = schedule.match(/^\*\/([1-9]\d*)(m|h)$/);
  if (every) {
    const step = parseInt(every[1], 10) * (every[2] === 'h' ? 3600 : 60);
    if (step <= 0) return null;
    return Math.floor(after / step) * step + step;
  }
  const daily = schedule.match(/^daily@(\d{2}):(\d{2})$/);
  if (daily) {
    const h = parseInt(daily[1], 10), m = parseInt(daily[2], 10);
    const d = new Date(after * 1000);
    const todayAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m, 0) / 1000;
    return todayAt > after ? todayAt : todayAt + 86400;
  }
  return null;
}

export function validSchedule(schedule: string): boolean {
  // [1-9]\d*: "*/0m" would pass \d+ but nextDue() returns null for it →
  // an enabled job that never fires yet holds a quota slot forever.
  if (/^\*\/([1-9]\d*)(m|h)$/.test(schedule)) return true;
  // daily@HH:MM — range-check the clock so "daily@25:70" is rejected, not
  // silently rolled over by Date.UTC into an unintended fire time.
  const daily = /^daily@(\d{2}):(\d{2})$/.exec(schedule);
  if (daily) {
    const h = Number(daily[1]), m = Number(daily[2]);
    return h <= 23 && m <= 59;
  }
  return false;
}

export const CATCH_UP_SECONDS = 24 * 60 * 60;

type FireDecision = 'fire' | 'skip' | 'skip-stale';

/**
 * Decide what to do with one job at time `now` — pure so the fire/skip/
 * catch-up logic is testable without a D1 mock. 'skip-stale' means the
 * job was due but too long ago; the caller advances last_fired_at without
 * running it (avoids a thundering backlog after downtime).
 */
export function jobFireDecision(
  job: { schedule: string | null; run_at: number | null; last_fired_at: number | null; created: number },
  now: number
): FireDecision {
  const due = nextDue(job.schedule, job.run_at, job.last_fired_at || job.created);
  if (!due || due > now) return 'skip';
  if (now - due > CATCH_UP_SECONDS) return 'skip-stale';
  return 'fire';
}

/**
 * 🔔 The sentence a user gets when their one-shot is ABANDONED.
 *
 * Every other outcome of a scheduled job speaks: a success emits `job_result`
 * + a ✅ push, a failure emits `job_error` + a ❌ push. The one outcome that
 * means **this will never happen** was silent — 'skip-stale' just wrote
 * `enabled = 0` and moved on. So the single case where the user has to act
 * (re-schedule it) was the only one they were never told about.
 *
 * And it does not need an outage to happen. `runAt` is validated only as finite
 * (JobsCreateCall below), so an agent that computes a timestamp from a
 * misparsed date creates a one-shot whose fire time is already past. `/jobs`
 * answers `{ok: true}`, the next tick abandons it, and nothing anywhere says so.
 *
 * Kept pure and separate from the tick for the usual reason: this decides what
 * the user is TOLD, which is the part worth pinning in a test, while
 * `runDueJobs` decides what the database does.
 *
 * Three deliberate choices:
 *   • it names the DUE time, not "now" — the user's question is *which* run was
 *     lost, and `last_fired_at` is about to be overwritten with the moment of
 *     abandonment, a time the job provably did not run at.
 *   • it says what to DO. A notification about something that will never happen
 *     is only actionable if it tells you the job is off and yours to restart.
 *   • recurring jobs are NOT announced. An 'every 5m' job (written star-slash-5m,
 *     as the file header spells it — the literal would close this comment) that
 *     skips one stale slot stays enabled and fires again in five minutes, so
 *     nothing was lost; a push per missed slot after an outage would be a flood.
 *     Only `once` jobs, which are disabled forever, are news.
 */
export const JOB_ABANDONED_KIND = 'job_missed';

export function jobAbandonedText(
  job: { name?: string | null; once?: number | boolean | null; run_at?: number | null },
  dueAt: number
): { title: string; body: string; detail: string } | null {
  if (!job.once) return null;   // recurring: it will come round again
  const name = String(job.name || 'a scheduled job').slice(0, 64);
  const when = new Date((Number(dueAt) || 0) * 1000).toISOString().replace('T', ' ').slice(0, 16);
  return {
    title: `⏰ ${name} never ran`,
    // "was due" + "did not run" + what to do. The user cannot recover a one-shot
    // they were not told about.
    body: `It was due ${when} UTC and is more than ${Math.floor(CATCH_UP_SECONDS / 3600)}h overdue, so it has been switched off. Schedule it again if you still need it.`,
    detail: `${name}: never ran — was due ${when} UTC, now switched off`,
  };
}

/** Cron entrypoint: fire everything due. Called from the worker's scheduled() handler. */
export async function runDueJobs(env: any): Promise<{ fired: number }> {
  const now = Math.floor(Date.now() / 1000);
  let fired = 0;
  const { results } = await env.DB.prepare(
    "SELECT * FROM jobs WHERE enabled = 1"
  ).all();

  for (const job of results || []) {
   // One job's transient D1/KV error must not skip the rest of the tick — the
   // bare .run() CAS/skip-stale/once-disable writes below would otherwise
   // throw out of the loop. Isolate each job; it retries next tick regardless.
   try {
    const decision = jobFireDecision(job, now);
    if (decision === 'skip') continue;
    if (decision === 'skip-stale') {
      // Too stale — skip forward without firing (mark so we don't rescan).
      // A one-shot that's already stale will NEVER fire, so disable it too —
      // else it sits enabled forever, re-evaluated every tick and consuming a
      // slot against the user's job quota.
      //
      // The due time has to be read BEFORE the UPDATE: `last_fired_at` is the
      // input to nextDue() and this write overwrites it with the moment of
      // abandonment, so afterwards the job's own row can no longer say which
      // run was lost.
      const staleDue = nextDue(job.schedule, job.run_at, job.last_fired_at || job.created) || 0;
      if (job.once) {
        await env.DB.prepare("UPDATE jobs SET last_fired_at = ?, enabled = 0 WHERE id = ?").bind(now, job.id).run();
      } else {
        await env.DB.prepare("UPDATE jobs SET last_fired_at = ? WHERE id = ?").bind(now, job.id).run();
      }
      // 🔔 Strictly AFTER the write, and never able to prevent it: the
      // bookkeeping is what stops the tick re-scanning this row forever, so a
      // notification rail having a bad day must not keep the job enabled.
      const told = jobAbandonedText(job, staleDue);
      if (told) {
        await emitEvent(env, job.user_id, JOB_ABANDONED_KIND, told.detail);
        await sendPushToUser(env, job.user_id, {
          title: told.title,
          body: told.body,
          url: `/${job.tiny_slug}`,
          tag: `tiny-job-${job.id}`,
        });
      }
      continue;
    }

    // Compare-and-swap: only one runner wins even across regions
    // (CLAIM_SQL above — exported for the sqlite-backed test).
    const claim = await env.DB.prepare(CLAIM_SQL).bind(now, job.id, job.last_fired_at).run();
    if (!claim?.meta?.changes) continue;

    fired += 1;
    let status = 'ok', preview = '';
    try {
      // Run the job's prompt through the app's chat pipeline (server key).
      const res = await fetch('https://tiny.technology/api/job-run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': env.INTERNAL_API_KEY || '',
        },
        body: JSON.stringify({ jobId: job.id, userId: job.user_id, tiny: job.tiny_slug, prompt: job.prompt }),
        signal: AbortSignal.timeout(60_000),
      });
      const data: any = await res.json().catch(() => ({}));
      status = res.ok && data.ok ? 'ok' : 'error';
      preview = String(data.result || data.error || '').slice(0, 300);
    } catch (err: any) {
      status = 'error';
      preview = String(err?.message || err).slice(0, 300);
    }

    try {
      await env.DB.prepare("INSERT INTO job_runs (job_id, status, result_preview) VALUES (?, ?, ?)")
        .bind(job.id, status, preview).run();
      await env.DB.prepare(
        `DELETE FROM job_runs WHERE job_id = ? AND id NOT IN (
           SELECT id FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?)`
      ).bind(job.id, job.id, RUN_HISTORY_KEEP).run();
    } catch (err) { console.log(err, 'job_runs'); }

    await emitEvent(env, job.user_id, status === 'ok' ? 'job_result' : 'job_error',
      `${job.name}: ${preview || status}`);

    // Notify the user's devices with the actual result (encrypted payload;
    // full detail is on the event bus)
    await sendPushToUser(env, job.user_id, {
      title: status === 'ok' ? `✅ ${job.name}` : `❌ ${job.name} failed`,
      body: preview || (status === 'ok' ? 'Job completed' : 'Job failed'),
      url: `/${job.tiny_slug}`,
      tag: `tiny-job-${job.id}`,
    });

    if (job.once) {
      await env.DB.prepare("UPDATE jobs SET enabled = 0 WHERE id = ?").bind(job.id).run();
    }
   } catch (err) { console.log(err, 'runDueJobs job', job?.id); }
  }
  return { fired };
}

export class JobsCreateCall extends OpenAPIRoute {
  static schema = {
    tags: ["Jobs"],
    summary: "Internal: create a scheduled job.",
    requestBody: {
      userId: new Str({ required: true, description: "Owner user id." }),
      tiny: new Str({ required: true, description: "Tiny slug the job runs as." }),
      name: new Str({ required: true, description: "Job name." }),
      prompt: new Str({ required: true, description: "Prompt to run." }),
      schedule: new Str({ required: false, description: "'*/5m' | '*/2h' | 'daily@HH:MM' (UTC)" }),
      runAt: new Str({ required: false, description: "One-shot unix seconds." }),
    },
    responses: { "200": { description: "Created", schema: { response: "Created" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, tiny, name, prompt, schedule, runAt } = data.body;
    if (!userId || !tiny || !name || !prompt) return json({ error: "missing fields" }, 400);
    if (!schedule && !runAt) return json({ error: "schedule or runAt required" }, 400);
    if (schedule && !validSchedule(String(schedule))) {
      return json({ error: "invalid schedule — use */Nm, */Nh or daily@HH:MM" }, 400);
    }
    // A non-finite runAt (e.g. "NaN" from a bad client) would be stored as NaN
    // → nextDue returns null → the one-shot never fires but stays enabled,
    // consuming the user's job quota forever. Reject it.
    if (!schedule && runAt && !Number.isFinite(Number(runAt))) {
      return json({ error: "runAt must be a unix-seconds number" }, 400);
    }
    // 💵 OWNERSHIP GATE: you may NOT schedule a PAID tiny you don't own. The
    // runner (app/api/job-run) executes the target tiny's FULL persona + skills
    // on server model credentials with NO x402 settle — so scheduling someone
    // else's priced public tiny would run their paid agent for free, forever,
    // and its owner would earn nothing (a cross-creator free-compute + revenue
    // leak). `prices.owner_id` is authoritative — only the ownership-verifying
    // PayPriceSetCall writes it. Normalize to the same resource-key shape
    // payments uses (validResource: /^tiny:[a-z0-9-]{1,64}$/), so a priced tiny
    // is always found regardless of the caller's casing. A FREE tiny (no active
    // price row) and the caller's OWN priced tiny both pass — only a
    // someone-else-owned priced tiny is rejected.
    const slug = String(tiny).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
    const priced = await env.DB.prepare(
      "SELECT owner_id FROM prices WHERE resource = ? AND active = 1"
    ).bind(`tiny:${slug}`).first();
    if (priced && String(priced.owner_id) !== String(userId)) {
      return json({ error: "cannot schedule a paid tiny you don't own" }, 403);
    }
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND enabled = 1")
      .bind(String(userId)).all();
    if (Number(results?.[0]?.c || 0) >= MAX_JOBS_PER_USER) {
      return json({ error: `job limit reached (${MAX_JOBS_PER_USER})` }, 429);
    }
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    await env.DB.prepare(
      `INSERT INTO jobs (id, user_id, tiny_slug, name, schedule, run_at, prompt, once)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, String(userId), String(tiny), String(name).slice(0, 64),
           schedule ? String(schedule) : null, runAt ? Number(runAt) : null,
           String(prompt).slice(0, 2000), schedule ? 0 : 1).run();
    return json({ ok: true, id });
  }
}

export class JobsListCall extends OpenAPIRoute {
  static schema = {
    tags: ["Jobs"],
    summary: "Internal: list a user's jobs with recent runs.",
    parameters: { userId: Query(String, { required: true, description: "User id." }) },
    responses: { "200": { description: "Jobs", schema: { response: "Jobs" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const userId = new URL(request.url).searchParams.get('userId') || '';
    if (!userId) return json({ error: "userId required" }, 400);
    const { results: jobs } = await env.DB.prepare(
      "SELECT id, tiny_slug, name, schedule, run_at, enabled, once, last_fired_at, fire_count FROM jobs WHERE user_id = ? ORDER BY created DESC"
    ).bind(userId).all();
    const { results: runs } = await env.DB.prepare(
      `SELECT job_id, started, status, result_preview FROM job_runs
       WHERE job_id IN (SELECT id FROM jobs WHERE user_id = ?)
       ORDER BY id DESC LIMIT 30`
    ).bind(userId).all();
    return json({ jobs: jobs || [], runs: runs || [] });
  }
}

export class JobsDeleteCall extends OpenAPIRoute {
  static schema = {
    tags: ["Jobs"],
    summary: "Internal: delete a job (owner only).",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      id: new Str({ required: true, description: "Job id." }),
    },
    responses: { "200": { description: "Deleted", schema: { response: "Deleted" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, id } = data.body;
    // Owner-scope the run-history delete too (and run it FIRST — the
    // subquery needs the jobs row). Unscoped, user A could wipe user B's
    // job_runs by id while B's job survived.
    await env.DB.prepare(
      "DELETE FROM job_runs WHERE job_id IN (SELECT id FROM jobs WHERE id = ?1 AND user_id = ?2)"
    ).bind(String(id), String(userId)).run();
    await env.DB.prepare("DELETE FROM jobs WHERE id = ? AND user_id = ?").bind(String(id), String(userId)).run();
    return json({ ok: true });
  }
}
