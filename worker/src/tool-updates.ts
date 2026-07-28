/**
 * Weekly marketplace update sweep (issue #15 auto-update, opt-out-free
 * because it's notify-only): compare every GitHub-pinned user tool
 * ([source: owner/repo@sha/path] in its description) against the latest
 * upstream commit touching that path. Outdated → one event on the owner's
 * ring. NO code changes — updating stays an explicit, user-approved
 * install_tool call in chat.
 *
 * Runs from the minutely cron but gates itself to ~weekly via a KV
 * timestamp; caps GitHub API calls per sweep to stay in rate limits.
 */

const SWEEP_INTERVAL_S = 7 * 24 * 3600;
const SWEEP_KV_KEY = "tool-update-sweep:last";
const MAX_CHECKS_PER_SWEEP = 60;

const SOURCE_RE = /\[source: ([^/\s]+)\/([^@\s]+)@([0-9a-f]{4,40})\/([^\]]+)\]/;

export async function sweepToolUpdates(env: any): Promise<{ checked: number; outdated: number } | null> {
  // Weekly gate (KV `tiny` binding is always present)
  let prevStamp = "";
  try {
    prevStamp = (await env.tiny.get(SWEEP_KV_KEY)) || "";
    const last = Number(prevStamp) || 0;
    const now = Math.floor(Date.now() / 1000);
    if (now - last < SWEEP_INTERVAL_S) return null;
    // Claim the slot immediately — concurrent crons see the new stamp
    await env.tiny.put(SWEEP_KV_KEY, String(now));
  } catch {
    return null;
  }

  let checked = 0, outdated = 0;
  try {
    const { results } = await env.DB.prepare(
      `SELECT user_id, name, description FROM user_tools
       WHERE description LIKE '%[source: %' LIMIT ?`
    ).bind(MAX_CHECKS_PER_SWEEP).all();

    // Latest-commit lookups deduped per (owner/repo/path)
    const latestCache = new Map<string, string>();

    for (const row of results || []) {
      const m = String(row.description || "").match(SOURCE_RE);
      if (!m) continue;
      const [, owner, repo, sha, path] = m;
      checked++;

      const cacheKey = `${owner}/${repo}/${path}`;
      let latest: string | undefined = latestCache.get(cacheKey);
      if (latest === undefined) {
        latest = String(await fetch(
          `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`,
          {
            headers: { Accept: "application/vnd.github+json", "User-Agent": "tinyai-worker" },
            // House rule: bound every outbound fetch. This runs in series for up
            // to MAX_CHECKS_PER_SWEEP tools on a weekly cron whose KV slot was
            // ALREADY claimed (line 28); the .catch below only fires on a thrown
            // error, so a GitHub socket that stalls (accepts, never responds)
            // would hang the awaited fetch until Cloudflare's cron wall-clock
            // kills the whole invocation — and since the stamp is advanced and
            // the rollback (line 79) lives in the catch a hang never reaches,
            // the sweep silently skips a FULL week. 10s → fail fast into .catch,
            // continue the loop. (Matches the push.ts / oauth.ts bounds.)
            signal: AbortSignal.timeout(10_000),
          }
        )
          .then((r) => (r.ok ? r.json() : []))
          .then((a: any) => a?.[0]?.sha || "")
          .catch(() => ""));
        latestCache.set(cacheKey, latest);
      }
      if (!latest) continue;

      if (!latest.startsWith(sha) && !sha.startsWith(latest)) {
        outdated++;
        const { emitEvent } = await import("./events");
        await emitEvent(
          env,
          String(row.user_id),
          "tool-update",
          `my_${row.name} has upstream changes (${owner}/${repo} ${String(sha).slice(0, 7)} → ${latest.slice(0, 7)}). Ask your tiny to run marketplace check_updates.`
        );
      }
    }
  } catch (err) {
    console.log(err, "sweepToolUpdates");
    // Total failure before any notification: roll the slot back so the next
    // cron retries instead of silently skipping a full week. (Partial success
    // keeps the new stamp — we don't want to re-notify the ones we did emit.)
    if (checked === 0) {
      try { await env.tiny.put(SWEEP_KV_KEY, prevStamp); } catch { /* best effort */ }
    }
  }
  return { checked, outdated };
}
