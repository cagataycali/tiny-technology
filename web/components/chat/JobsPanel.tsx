"use client";

/**
 * ⏰ Jobs Panel — scheduled background jobs surface.
 *
 * Replaces the old /jobs clipboard-toast. Each job renders as a card with
 * its cadence (cron-ish schedule or one-shot time), enabled state, fire
 * count and last-run status. Expanding a card reveals its recent runs
 * (status + result preview) and the delete action.
 *
 * Same overlay grammar as MemoryPanel/MessagesHUD: portaled (the header's
 * backdrop-filter is a containing block), full-screen sheet on mobile,
 * Escape/backdrop dismiss, remount-per-open for fresh state.
 */
import { IconClock, IconTrash } from "./icons";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useOverlayExit } from "../../lib/chat/use-overlay-exit";
import { useFocusTrap } from "../../lib/chat/use-focus-trap";
import { useConfirm } from "./ConfirmDialog";
import { deadlineFor } from "../../lib/deadlines";
import { jobsHeader, jobsCapNote, runsMissingNote } from "../../lib/chat/capacity";
import { oneShotState, oneShotPrefix, lastFiredNote } from "../../lib/chat/job-cadence";
import { useJobsRefresh } from "../../lib/chat/use-jobs-refresh";

type Job = {
  id: string;
  tiny_slug: string;
  name: string;
  schedule: string | null;
  run_at: number | null;
  enabled: number;
  once: number;
  last_fired_at: number | null;
  fire_count: number;
};

type Run = {
  job_id: string;
  started: number;
  status: string;
  result_preview: string | null;
};

function when(ts?: number | null): string {
  // `!ts` short-circuits undefined/null/0/NaN, but /api/jobs data is taken raw
  // (Array.isArray only), so a non-numeric-string ts (e.g. "soon") passes the
  // falsy check yet makes `ts * 1000` NaN → "Invalid Date" shown to the user.
  // Coerce + validate > 0 (timestamps are seconds-since-1970), mirroring ago().
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** Human phrasing for the worker's schedule DSL: */
/** '*\/Nm' | '*\/Nh' | 'daily@HH:MM' (stored UTC, shown local) — or a one-shot run_at. */
function cadence(job: Job): string {
  if (typeof job.schedule === "string") {
    const m = job.schedule.match(/^\*\/(\d+)([mh])$/);
    if (m) return `every ${m[1]}${m[2] === "m" ? " min" : " hr"}`;
    const d = job.schedule.match(/^daily@(\d{2}:\d{2})$/);
    if (d) {
      // The DSL stores the fire time in UTC, but the one-shot path (`when`)
      // shows local time — so a UTC label here forced non-UTC users to do
      // the math to know when a daily job actually runs. Convert HH:MM (UTC)
      // to the viewer's local clock for consistency. Anchoring on "today" is
      // the right approximation: it reflects the current UTC offset (incl.
      // DST) the job fires under around now.
      const [h, min] = d[1].split(":").map(Number);
      const dt = new Date();
      dt.setUTCHours(h, min, 0, 0);
      const local = dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      return `daily at ${local}`;
    }
    return job.schedule;
  }
  if (job.run_at) {
    // ⚠️ NOT `fire_count > 0 || !job.enabled`. That is what this line used to
    // say, and `!enabled` is not evidence of a run: the scheduler ALSO clears
    // the flag when it gives up on a job it can no longer catch up with
    // (scheduler.ts:117, which leaves fire_count at 0) — so an abandoned
    // one-shot rendered "ran <date> · fired 0×", telling someone their reminder
    // happened. oneShotState reads fire_count as the only record of a run, and
    // distinguishes a job that is genuinely mid-flight ("due") from one that
    // never will be. See lib/chat/job-cadence.ts.
    const prefix = oneShotPrefix(oneShotState(job));
    if (prefix) return `${prefix} ${when(job.run_at)}`;
  }
  return "?";
}

function statusDot(s: string): string {
  if (s === "ok" || s === "success") return "🟢";
  if (s === "running") return "🔵";
  return "🔴";
}

/** SR word for a run status — the colored dot alone reads as "green circle". */
function statusLabel(s: string): string {
  if (s === "ok" || s === "success") return "succeeded";
  if (s === "running") return "running";
  return "failed";
}

export default function JobsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Remount per open (MemoryPanel pattern): fresh state each time
  if (!open) return null;
  return <JobsPanelInner onClose={onClose} />;
}

function JobsPanelInner({ onClose }: { onClose: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A failed jobs fetch toasted but then rested on the EMPTY state ("No
  // scheduled jobs…") — after the toast faded, an outage was indistinguishable
  // from having no jobs. The header refresh doubles as retry, but the resting
  // copy still misled; show a distinct error line. Only when jobs is empty, so
  // a poll blip over a populated list never flips to an error.
  const [loadError, setLoadError] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  // Generation token so an older /api/jobs response can't overwrite a newer one
  // (MemoryPanel's loadReqRef pattern). Without it, a manual refresh overlapping
  // a delete races: the pre-delete GET can resolve AFTER the post-delete reload
  // and repaint the just-deleted job back into the list. Only the latest load()
  // is allowed to commit rows or clear the spinner.
  const loadReqRef = useRef(0);
  // Exit choreography + focus return (shared pass-97 pattern). The panel is
  // prop-controlled, so capture the opener at mount (CommandPalette approach)
  // rather than via a ref the parent would have to thread through.
  const openerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { requestClose, exitClass, onAnimationEnd } = useOverlayExit(onClose, openerRef);
  useEffect(() => { openerRef.current = document.activeElement as HTMLElement | null; }, []);
  // Move focus INTO the dialog on open — it's aria-modal, so a SR must
  // announce it and Tab must start inside (shared overlay grammar: ActivityHUD
  // pass 133 / UniverseDrawer). Focus the container, not a row, so nothing is
  // pre-selected; useOverlayExit returns focus to the opener on close.
  useEffect(() => { panelRef.current?.focus(); }, []);
  // Trap Tab inside (WCAG 2.4.3). Remount-per-open → always active while
  // mounted; aria-modal marks the page behind inert.
  useFocusTrap(panelRef, true);

  /**
   * `background: true` = the poll, not a person.
   *
   * A poll must not borrow the affordances of a user-initiated refresh: flipping
   * `loading` would spin the glyph and DISABLE the refresh button once a minute,
   * and toasting a transient failure would stack error toasts over a panel
   * nobody is touching. It also must not `onClose()` on a 401 — a session that
   * lapses while the panel sits open should leave the last-known rows on screen,
   * not yank the overlay out from under a reader. So a background pass commits
   * fresh rows and otherwise says nothing; the visible retry paths all belong to
   * the explicit refresh.
   */
  const load = (opts?: { background?: boolean }) => {
    const background = opts?.background === true;
    const req = ++loadReqRef.current;
    if (!background) setLoading(true);
    // Deadline it, or a hung route leaves `loading` true forever — the retry
    // lives in the loadError branch, which only the .catch can reach.
    fetch("/api/jobs", { signal: AbortSignal.timeout(deadlineFor("/api/jobs")) })
      .then((r) => {
        // A 401 is a genuine "sign in" (the panel closes below); anything else
        // non-ok is the worker failing, NOT an empty schedule. The proxy answers
        // an outage with a PARSEABLE 503 {jobs:[],runs:[],error} body, so without
        // this throw r.json() succeeds → d.error is truthy → the panel would
        // onClose() on a transient blip instead of offering the retry (the
        // loadError branch below). Throw so the .catch → loadError path fires.
        if (r.status === 401) return { error: "login required" };
        if (!r.ok) throw new Error(`jobs ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (loadReqRef.current !== req) return;
        if (d.error) {
          if (background) return;
          toast(d.error === "login required" ? "Sign in to see your scheduled jobs" : d.error);
          onClose();
          return;
        }
        setLoadError(false);
        setJobs(Array.isArray(d.jobs) ? d.jobs : []);
        setRuns(Array.isArray(d.runs) ? d.runs : []);
      })
      .catch(() => {
        if (loadReqRef.current !== req || background) return;
        setLoadError(true);
        toast.error("Couldn't load jobs — try again");
      })
      // Only the latest request clears the spinner — an older resolver must not
      // flip "loading" off while the newer fetch is still in flight.
      .finally(() => { if (loadReqRef.current === req && !background) setLoading(false); });
  };

  // Keep the rows true while the panel sits open — a one-shot due in two minutes
  // fires on the worker's cron, and nothing on this client would ever hear about
  // it (load() below runs once). Polls ONLY while some job's label can still
  // change, so a schedule of finished jobs holds no timer at all.
  useJobsRefresh(jobs, () => load({ background: true }));

  useEffect(() => {
    load();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (id: string) => {
    if (!(await confirm({
      title: "Delete job?",
      message: "This job and its run history will be permanently deleted.",
      confirmLabel: "Delete",
      danger: true,
    }))) return;
    setDeleting(id);
    fetch("/api/jobs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(deadlineFor("/api/jobs")),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) { toast.error(d.error || "Couldn't delete — try again"); return; }
        toast("⏰ Job deleted");
        setExpanded(null);
        load();
      })
      .catch(() => toast.error("Couldn't delete — try again"))
      .finally(() => setDeleting(null));
  };

  if (typeof document === "undefined") return null;

  const runsByJob = new Map<string, Run[]>();
  for (const r of runs) {
    const list = runsByJob.get(r.job_id) || [];
    if (list.length < 5) list.push(r);
    runsByJob.set(r.job_id, list);
  }
  const capNote = jobsCapNote(jobs);

  return createPortal(
    <>
      <div className="fixed inset-0 z-[90] bg-black/40 sm:bg-transparent" onClick={requestClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Scheduled jobs"
        tabIndex={-1}
        onAnimationEnd={onAnimationEnd}
        className={`fixed z-[95] outline-none ${exitClass} flex flex-col border
                   inset-0 h-[100dvh] w-full rounded-none
                   sm:inset-auto sm:top-[4.5rem] sm:h-auto sm:max-h-[70vh] sm:w-[28rem] sm:rounded-xl
                   sm:right-[max(1rem,calc((100vw-56rem)/2+1rem))]`}
        style={{
          background: "rgba(10,10,10,0.97)",
          borderColor: "rgba(var(--tiny-accent-rgb),0.25)",
          boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
        }}
      >
        <div
          className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-white border-b flex items-center gap-2"
          style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
        >
          {/* The count is the LIST's; the cap counts only enabled rows, and a
              fired one-shot is disabled. jobsHeader keeps the two populations
              apart (a bare "12/10" would be over a limit the user isn't near)
              and only surfaces the cap once it's within reach. */}
          <span className="opacity-60 min-w-0 truncate inline-flex items-center gap-1.5"><IconClock className="w-3.5 h-3.5 shrink-0" /> {jobsHeader(jobs)}</span>
          {/* onClick is wrapped, not `onClick={load}`: React hands a handler the
              MouseEvent, which would arrive as load()'s options bag — and
              `event.background` being undefined makes it a FOREGROUND load by
              luck rather than by intent. */}
          <button
            onClick={() => load()}
            disabled={loading}
            aria-busy={loading}
            className="ml-auto px-2 py-0.5 rounded-md border text-[11px] normal-case tracking-normal transition-colors hover:bg-white/5 disabled:opacity-50 inline-flex items-center gap-1"
            style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.3)", color: "rgba(255,255,255,0.6)" }}
            aria-label="Refresh"
          >
            {/* Spin the glyph while loading so a refresh with jobs already
                listed still shows activity (the body spinner only fires when
                the list is empty). */}
            <span className={loading ? "inline-block animate-spin" : "inline-block"} aria-hidden="true">↻</span>
            {loading ? "refreshing…" : "refresh"}
          </button>
          <button onClick={requestClose} className="inline-flex items-center justify-center min-w-11 min-h-11 -m-1.5 opacity-60 hover:opacity-100 sm:hidden" aria-label="Close">✕</button>
        </div>

        <div className="overflow-y-auto overscroll-contain flex-1 p-3 space-y-2">
          {loading && jobs.length === 0 ? (
            <div role="status" className="text-sm text-gray-400 text-center py-6">Loading…</div>
          ) : loadError && jobs.length === 0 ? (
            /* Fetch failed — DON'T rest on "No scheduled jobs" (an outage would
               read as having none). Offer a retry (the header refresh also
               works, but a body-level affordance is clearer here). */
            <div role="alert" className="text-sm text-gray-400 text-center py-6 space-y-3">
              <div>Couldn&apos;t load your scheduled jobs.</div>
              <button
                onClick={() => load()}
                className="px-3 py-1.5 rounded-lg text-xs border transition-colors hover:bg-[rgba(var(--tiny-accent-rgb),0.1)]"
                style={{ color: "var(--tiny-accent)", borderColor: "rgba(var(--tiny-accent-rgb),0.3)" }}
              >
                Retry
              </button>
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-sm text-gray-400 text-center py-6">
              No scheduled jobs — ask your tiny to schedule one, e.g.{" "}
              <em>&quot;check HN for AI news every morning at 9&quot;</em>
            </div>
          ) : (
            <>
            {/* At the cap, name the way out — and warn when the rows that look
                most disposable (spent one-shots) aren't the ones that count.
                Otherwise a user deletes three finished jobs and is still
                blocked, having learned nothing. role=status, not alert: it's a
                standing condition, not an error that just happened. */}
            {capNote && (
              <div
                role="status"
                className="text-[11px] rounded-lg border px-2.5 py-2 mb-1"
                style={{
                  color: "var(--tiny-warn)",
                  borderColor: "rgba(var(--tiny-warn-rgb),0.35)",
                  background: "rgba(var(--tiny-warn-rgb),0.08)",
                }}
              >
                {capNote}
              </div>
            )}
            {jobs.map((j) => {
              const isOpen = expanded === j.id;
              const jRuns = runsByJob.get(j.id) || [];
              const last = jRuns[0];
              const off = !j.enabled;
              return (
                <div
                  key={j.id}
                  className={`rounded-xl border transition-colors ${off ? "opacity-60" : ""}`}
                  style={{ borderColor: off ? "rgba(255,255,255,0.12)" : "rgba(var(--tiny-accent-rgb),0.25)" }}
                >
                  <button
                    onClick={() => setExpanded(isOpen ? null : j.id)}
                    aria-expanded={isOpen}
                    className="w-full text-left px-3 py-2 hover:bg-white/5 transition-colors rounded-xl"
                  >
                    <div className="flex items-start gap-2">
                      {/* Status glyph is decorative — SR would read "green
                          circle". The meaning lives in an sr-only label (and
                          the title stays as a sighted-hover hint). */}
                      <span className="mt-0.5 text-[10px]" title={off ? "Disabled (one-shots disable after firing)" : "Active"}>
                        <span aria-hidden="true">{off ? "⚪" : "🟢"}</span>
                        <span className="sr-only">{off ? "Disabled: " : "Active: "}</span>
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-white truncate">{j.name}</div>
                        <div className="text-[11px] text-gray-400 mt-0.5">
                          {cadence(j)} · as /{j.tiny_slug} · fired {j.fire_count}×
                          {last && <span> · last <span aria-hidden="true">{statusDot(last.status)}</span><span className="sr-only">{statusLabel(last.status)} </span> {when(last.started)}</span>}
                        </div>
                      </div>
                    </div>
                  </button>

                  {isOpen && (
                    <div className="px-3 pb-2.5 space-y-1.5 border-t pt-2" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                      {/* `last_fired_at` is scheduler bookkeeping, not a run
                          record: skip-stale stamps it with the moment the job was
                          ABANDONED (scheduler.ts:117), so "Last fired <date>" on a
                          job with fire_count 0 named a time nothing happened.
                          lastFiredNote returns the honest sentence for that case
                          and null whenever "Last fired" is true. */}
                      {lastFiredNote(j) ? (
                        <div className="text-[11px] text-gray-400">{lastFiredNote(j)}</div>
                      ) : j.last_fired_at ? (
                        <div className="text-[11px] text-gray-400">Last fired {when(j.last_fired_at)}</div>
                      ) : (
                        <div className="text-[11px] text-gray-400">Hasn&apos;t fired yet</div>
                      )}
                      {/* `runs` is ONE global page of 30 across every job, then
                          bucketed 5-per-job here — so a job that has fired can
                          show an empty history simply because busier jobs filled
                          the page. Say so, instead of leaving "Last fired <date>"
                          above blank space. */}
                      {runsMissingNote(j, jRuns.length, runs.length) && (
                        <div className="text-[11px] text-gray-500">{runsMissingNote(j, jRuns.length, runs.length)}</div>
                      )}
                      {jRuns.length > 0 && (
                        <div className="space-y-1">
                          {jRuns.map((r, i) => (
                            <div key={i} className="text-[11px] text-gray-300 rounded-lg border px-2 py-1" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
                              {/* dot is decorative — the status word beside it
                                  already carries the meaning to SR. Humanize via
                                  statusLabel (as the collapsed summary does) so an
                                  expanded row reads "succeeded", not the raw DSL
                                  token "ok" — same data, one vocabulary. */}
                              <span aria-hidden="true">{statusDot(r.status)}</span> {statusLabel(r.status)} · {when(r.started)}
                              {r.result_preview && (
                                <span className="block text-gray-400 truncate">{r.result_preview}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      <button
                        onClick={() => remove(j.id)}
                        disabled={deleting === j.id}
                        className="text-[11px] text-red-400/80 hover:text-red-300 transition-colors disabled:opacity-50"
                      >
                        <span className="inline-flex items-center gap-1"><IconTrash className="w-3.5 h-3.5" /> Delete job</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            </>
          )}
        </div>
      </div>
      {dialog}
    </>,
    document.body
  );
}
