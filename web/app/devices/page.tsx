"use client";

/**
 * /devices — your tiny-node device registry (tiny-node PR2, docs/tiny-node-goal.md).
 *
 * Lists the daemons / CLIs / browsers enrolled to your tiny identity with
 * live presence (online = heartbeat within the last minute), lets you enroll
 * a new device (the token is shown EXACTLY ONCE — the worker keeps only its
 * hash), and revoke one instantly.
 *
 * Session-gated end to end: logged-out visitors bounce through GitHub OAuth.
 * When the worker registry isn't deployed yet the page degrades to a calm
 * "not available yet" state rather than an error.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConfirm } from "../../components/chat/ConfirmDialog";
import { IconCpu, IconGlobe, IconDevice } from "../../components/chat/icons";
import { relativeAgo } from "../../lib/relative-time";
import { deadlineFor } from "../../lib/deadlines";

type Device = {
  id: string;
  name: string;
  platform?: string;
  kind?: string;
  capabilities?: string;
  last_seen?: number;
  created_at?: number;
  // `null` is a THIRD state, not a falsy boolean: an endpoint device (a robot at
  // its own API) never heartbeats, so its liveness is unknown until something
  // calls it. Rendering that as "offline" libels a working machine.
  online?: boolean | null;
  url?: string;
};

// Chrome speaks icons, not emoji (icons.tsx house rule): the device-kind glyph
// is a registry-row anchor, so it uses Icon* components that inherit
// currentColor (flow the tiny's accent) + render identically cross-platform,
// unlike the old ⚙️/🌐/⌨️ emoji. cli is the generic-device fallback.
const KIND_ICON: Record<string, (p: { className?: string }) => React.ReactNode> = {
  daemon: IconCpu,
  browser: IconGlobe,
  cli: IconDevice,
  // An endpoint device isn't a machine of the user's that dialled in — it's a
  // body out on the network that tiny dials out to, so it takes the globe.
  endpoint: IconGlobe,
};

// A device with a malformed/absent `last_seen` reads "never" (fallback).
const relativeSeen = (sec?: number) => relativeAgo(sec, "never");

// Presence has three states, and only one of them is a boolean question.
// `null` = an endpoint device: no heartbeat exists to read, so neither "online"
// nor "offline" is a true statement about it — say "reachable" and leave it.
const presenceOf = (d: Device): "online" | "offline" | "unknown" =>
  d.online === null || (d.online === undefined && d.kind === "endpoint")
    ? "unknown"
    : d.online ? "online" : "offline";

/** Does this device claim a capability? `capabilities` arrives as a JSON string. */
const hasCap = (d: Device, cap: string): boolean => {
  try {
    const arr = JSON.parse(String(d.capabilities ?? "[]"));
    return Array.isArray(arr) && arr.includes(cap);
  } catch {
    return false;
  }
};

// Telemetry fields worth a glance, in reading order. A robot answers whatever it
// answers, so this is a projection over an untrusted shape: anything absent is
// simply skipped rather than rendered as "undefined".
const TELEMETRY_ROWS: Array<{ label: string; read: (t: any) => string | null }> = [
  { label: "state", read: (t) => (t.gcode_state ? String(t.gcode_state).toLowerCase() : null) },
  {
    label: "job",
    read: (t) => {
      const name = String(t.subtask_name || "").trim();
      if (!name) return null;
      const pct = Number(t.progress);
      return Number.isFinite(pct) && pct > 0 ? `${name} · ${pct}%` : name;
    },
  },
  {
    label: "nozzle",
    read: (t) => {
      const n = t?.temps?.nozzle;
      if (!Number.isFinite(Number(n))) return null;
      const target = Number(t?.temps?.nozzle_target);
      return target > 0 ? `${Math.round(Number(n))}° → ${Math.round(target)}°` : `${Math.round(Number(n))}°`;
    },
  },
  {
    label: "bed",
    read: (t) => {
      const b = t?.temps?.bed;
      if (!Number.isFinite(Number(b))) return null;
      const target = Number(t?.temps?.bed_target);
      return target > 0 ? `${Math.round(Number(b))}° → ${Math.round(target)}°` : `${Math.round(Number(b))}°`;
    },
  },
  {
    label: "layer",
    read: (t) => {
      const l = Number(t.layer);
      const total = Number(t.total_layers);
      if (!Number.isFinite(l) || total <= 0) return null;
      return `${l} / ${total}`;
    },
  },
  {
    label: "remaining",
    read: (t) => {
      const m = Number(t.remaining_min);
      return Number.isFinite(m) && m > 0 ? `${m} min` : null;
    },
  },
];

/**
 * 🤖 Live panel for an endpoint device: its camera frame + telemetry.
 *
 * Both are POLLED, and that's a deliberate design constraint rather than a
 * shortcut. The printer dashboard's own camera route is an infinite multipart
 * MJPEG generator — proxying it would hold a worker invocation open for as long
 * as the tab stayed open, and no timeout could ever fire on a response that is
 * defined never to end. Repeated bounded snapshot requests give the same feeling
 * of live video out of requests that can actually fail and be retried.
 *
 * Polling only ever runs while the tab is VISIBLE. A backgrounded page must not
 * keep calling someone's printer, and `document.hidden` is the same gate the
 * presence poll on this page already uses.
 */
function EndpointPanel({ device, accent }: { device: Device; accent: string }) {
  const [telemetry, setTelemetry] = useState<any | null>(null);
  const [note, setNote] = useState("");
  const [frameSrc, setFrameSrc] = useState("");
  const [camState, setCamState] = useState<"idle" | "live" | "failed">("idle");
  const hasCamera = hasCap(device, "camera") || hasCap(device, "print");

  // Poll telemetry. `alive` guards the async gap: a device revoked (or the
  // component unmounted) mid-request must not write state afterwards.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(
          `/api/devices/endpoint?deviceId=${encodeURIComponent(device.id)}&action=telemetry`,
          { cache: "no-store", signal: AbortSignal.timeout(deadlineFor("/api/devices/endpoint")) },
        );
        const data = await res.json();
        if (!alive) return;
        if (data.ok && data.result) {
          setTelemetry(data.result);
          setNote("");
          return;
        }
        // Keep the LAST good reading on screen and explain the gap. Blanking the
        // panel on one failed tick makes a working machine look broken, and
        // these three failures need different words: a thinking robot is not an
        // absent one, and a rejected credential is not a network problem.
        setNote(
          data.unauthorized ? "Credential rejected — re-enroll this device."
          : data.timeout ? "Still working — no answer yet."
          : data.unreachable ? "Not answering right now."
          : "Telemetry unavailable.",
        );
      } catch {
        if (alive) setNote("Not answering right now.");
      }
    };
    tick();
    const t = setInterval(tick, 10_000);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [device.id]);

  // Poll the camera by re-pointing an <img> at a cache-busted URL. The browser
  // does the fetching and decoding, so a frame never passes through JS and a
  // failed one leaves the previous frame on screen untouched.
  useEffect(() => {
    if (!hasCamera) return;
    let alive = true;
    let n = 0;
    const tick = () => {
      if (document.hidden || !alive) return;
      // `t` is what forces the refetch: without it the URL is identical and the
      // browser serves the same frame forever, no-store notwithstanding.
      setFrameSrc(`/api/devices/endpoint?deviceId=${encodeURIComponent(device.id)}&action=snapshot&t=${Date.now()}_${n++}`);
    };
    tick();
    const t = setInterval(tick, 2_000);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [device.id, hasCamera]);

  const rows = telemetry
    ? TELEMETRY_ROWS.map((r) => {
        let value: string | null = null;
        // A robot's payload is untrusted shape — one malformed field must not
        // blank the whole panel.
        try { value = r.read(telemetry); } catch { value = null; }
        return value ? { label: r.label, value } : null;
      }).filter(Boolean) as Array<{ label: string; value: string }>
    : [];

  const running = String(telemetry?.gcode_state || "").toUpperCase() === "RUNNING";

  return (
    <div className="mt-3 pt-3 border-t space-y-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
      {hasCamera && (
        <div
          className="relative overflow-hidden rounded-lg"
          style={{ borderColor: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.03)" }}
        >
          {/* 16:9 box so the row height never jumps between frames or while the
              first one is still loading. */}
          <div style={{ aspectRatio: "16 / 9" }}>
            {frameSrc && (
              // eslint-disable-next-line @next/next/no-img-element -- a polled
              // camera frame, not a static asset: next/image would try to
              // optimize/cache a URL whose whole purpose is to change every 2s.
              <img
                src={frameSrc}
                alt={`Live camera view from ${device.name}`}
                className="w-full h-full object-cover"
                // The <img> is the only place that knows whether the bytes were
                // really an image: a JSON error body fails to decode and fires
                // onError, which is what flips the overlay to "unavailable".
                onLoad={() => setCamState("live")}
                onError={() => setCamState((s) => (s === "live" ? "live" : "failed"))}
              />
            )}
          </div>
          {camState !== "live" && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500">
              {camState === "failed" ? "Camera unavailable" : "Connecting to camera…"}
            </div>
          )}
          {camState === "live" && (
            <span
              className="absolute top-2 left-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium"
              style={{ background: "rgba(0,0,0,0.6)", color: running ? accent : "#d0d0d0" }}
            >
              <span
                aria-hidden
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: running ? accent : "#8a8a8a" }}
              />
              live
            </span>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
          {rows.map((r) => (
            <div key={r.label} className="min-w-0">
              <dt className="text-gray-500 truncate">{r.label}</dt>
              <dd className="font-mono truncate" style={{ color: r.label === "state" && running ? accent : "#e0e0e0" }}>
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* One line, and only when there's something true to say. `note` is set on
          a failed tick but the last good reading stays visible above it. */}
      {note && <p className="text-xs text-gray-500">{note}</p>}
      {!note && !telemetry && <p className="text-xs text-gray-500">Reading telemetry…</p>}
    </div>
  );
}

export default function DevicesPage() {
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [enrolling, setEnrolling] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("cli");
  const [freshToken, setFreshToken] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const { confirm, dialog } = useConfirm();
  const nameRef = useRef<HTMLInputElement>(null);
  const copyBtnRef = useRef<HTMLButtonElement>(null);

  // When the one-time token reveals, move focus to Copy — it's the urgent,
  // shown-once action (the plaintext exists nowhere else) but the panel mounts
  // far down the DOM, so a keyboard/AT user would otherwise have to hunt for it.
  useEffect(() => {
    if (freshToken) copyBtnRef.current?.focus();
  }, [freshToken]);

  const load = useCallback(async () => {
    try {
      // Deadline it: without one the initial load never leaves status
      // "loading" (the skeleton has no retry), and the 30s presence poll would
      // pile up overlapping never-settling requests on a flaky connection.
      const res = await fetch("/api/devices", {
        cache: "no-store",
        signal: AbortSignal.timeout(deadlineFor("/api/devices")),
      });
      if (res.status === 401) {
        window.location.href = `/api/auth?return_to=${encodeURIComponent("/devices")}`;
        return;
      }
      const data = await res.json();
      // 503 = the proxy couldn't REACH the worker (transient) — distinct from
      // 424 "registry not deployed yet". Route it to the retryable error state,
      // NOT the permanent "tiny-node is rolling out" dead-end, so a worker blip
      // doesn't falsely tell the user the whole feature is absent forever.
      if (res.status === 503 || data.retryable) {
        setError("Couldn't reach the device registry.");
        setStatus((prev) => (prev === "loading" ? "error" : prev));
        return;
      }
      if (res.status === 424 || data.error) {
        // Worker registry not deployed yet — calm, not an error scream
        setStatus("unavailable");
        return;
      }
      setDevices(Array.isArray(data.devices) ? data.devices : []);
      setError("");
      setStatus("ready");
    } catch {
      // A transient failure of the 30s background poll must not tear down a
      // page that's already showing devices. Escalate to the full-screen
      // error state only on the INITIAL load (status still "loading");
      // once resolved, keep the current view and surface the message as the
      // inline banner the ready branch already renders at :220.
      setError("Couldn't reach the device registry.");
      setStatus((prev) => (prev === "loading" ? "error" : prev));
    }
  }, []);

  useEffect(() => {
    load();
    // Live presence: refresh every 30s so the online dots stay honest — but
    // skip ticks while the tab is hidden (a backgrounded page doesn't need
    // fresh presence and shouldn't keep hitting the worker), and reload
    // immediately on return so the dots are current when the user looks again.
    // Mirrors the MessagesHUD/ActivityHUD polling pattern.
    const t = setInterval(() => {
      if (document.hidden) return;
      load();
    }, 30_000);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const enroll = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name || enrolling) return;
    setEnrolling(true);
    setError("");
    try {
      const res = await fetch("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, kind: newKind }),
        signal: AbortSignal.timeout(deadlineFor("/api/devices")),
      });
      const data = await res.json();
      if (!data.ok || !data.device_token) {
        setError(data.error || "Enrollment failed.");
        return;
      }
      setFreshToken({ name, token: data.device_token });
      setNewName("");
      await load();
    } catch {
      setError("Enrollment failed — try again.");
    } finally {
      setEnrolling(false);
    }
  };

  const revoke = async (d: Device) => {
    if (!(await confirm({
      title: "Revoke device?",
      message: `"${d.name}" — its token stops working immediately.`,
      confirmLabel: "Revoke",
      danger: true,
    }))) return;
    if (revoking) return;
    setRevoking(d.id);
    try {
      const res = await fetch("/api/devices", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: d.id }),
        signal: AbortSignal.timeout(deadlineFor("/api/devices")),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Revoke failed.");
        return;
      }
      setDevices((prev) => prev.filter((x) => x.id !== d.id));
    } catch {
      setError("Revoke failed — try again.");
    } finally {
      setRevoking(null);
    }
  };

  const copyToken = async () => {
    if (!freshToken) return;
    try {
      await navigator.clipboard.writeText(freshToken.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the token is on screen to copy by hand */
    }
  };

  const accent = "var(--tiny-accent, #00FF88)";
  const accentBorder = "rgba(var(--tiny-accent-rgb, 0,255,136),0.25)";

  return (
    <main className="min-h-screen bg-black text-white px-4 py-10 sm:py-16">
      <div className="max-w-2xl mx-auto space-y-8">
        <header className="space-y-2">
          {/* Link, not <a>: the "tiny" wordmark navigates home — a raw anchor
              forces a full document reload (black flash, re-fetch, lost state)
              where next/link hands off client-side and paints instantly. */}
          <Link
            href="/"
            className="inline-block text-2xl font-bold transition-transform hover:scale-105 active:scale-100 rounded"
            style={{ color: accent, textShadow: "0 0 10px rgba(var(--tiny-accent-rgb, 0,255,136),0.5)" }}
          >
            tiny
          </Link>
          <h1 className="text-lg font-semibold">Your devices</h1>
          <p className="text-sm text-gray-400">
            Daemons, CLIs, browsers and robots enrolled to your tiny identity. Each one heartbeats
            to show it&apos;s online; endpoint devices also show their camera and telemetry live here.
            Revoke any of them to kill its access instantly.
          </p>
        </header>

        {status === "loading" && (
          // Skeleton shell (same perceived-perf pattern as app/[slug] +
          // app/universe loading.tsx): mirror the ready layout — the enroll
          // bar + a few device rows — so the real content swaps IN calm rather
          // than popping over a bare text line. Visual bones are aria-hidden;
          // a single sr-only status carries the "loading" meaning. animate-pulse
          // is auto-neutralized by the reduced-motion global reset in globals.css.
          <div className="space-y-8">
            <span role="status" className="sr-only">Loading your devices…</span>
            <div className="flex flex-col sm:flex-row gap-2" aria-hidden="true">
              <div className="flex-1 h-11 rounded-xl border animate-pulse" style={{ borderColor: "rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)" }} />
              <div className="h-11 w-full sm:w-28 rounded-xl border animate-pulse" style={{ borderColor: "rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)" }} />
              <div className="h-11 w-full sm:w-24 rounded-xl animate-pulse" style={{ background: "rgba(var(--tiny-accent-rgb, 0,255,136),0.15)" }} />
            </div>
            <ul className="space-y-2" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <li
                  key={i}
                  className="flex items-center gap-3 rounded-xl border px-4 py-3 animate-pulse"
                  style={{ borderColor: "rgba(255,255,255,0.12)" }}
                >
                  <div className="w-6 h-6 rounded-full flex-shrink-0" style={{ background: "rgba(255,255,255,0.08)" }} />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="h-3.5 rounded" style={{ width: `${45 - i * 8}%`, background: "rgba(255,255,255,0.1)" }} />
                    <div className="h-2.5 w-20 rounded" style={{ background: "rgba(255,255,255,0.06)" }} />
                  </div>
                  <div className="h-7 w-16 rounded-lg border" style={{ borderColor: "rgba(255,255,255,0.12)" }} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {status === "error" && (
          // Honest error + in-body Retry — the shared grammar every overlay
          // panel follows (ActivityHUD/MemoryPanel/JobsPanel/MessagesHUD/
          // TelegramSettings). This full-page surface is the one place a worker
          // blip would otherwise strand the user with no recovery but a reload.
          <div role="alert" className="rounded-2xl border p-6 space-y-3 text-center" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={() => { setStatus("loading"); load(); }}
              className="px-3 py-1.5 rounded-lg text-xs border transition-colors hover:bg-[rgba(var(--tiny-accent-rgb,0,255,136),0.1)]"
              style={{ color: accent, borderColor: "rgba(var(--tiny-accent-rgb, 0,255,136),0.3)" }}
            >
              Retry
            </button>
          </div>
        )}

        {status === "unavailable" && (
          <div className="rounded-2xl border p-6 space-y-2" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
            <p className="text-sm text-gray-300">The device registry isn&apos;t available yet.</p>
            <p className="text-xs text-gray-400">
              tiny-node is rolling out. Once the registry is live you&apos;ll be able to enroll and
              manage your devices here.
            </p>
          </div>
        )}

        {/* One-time token reveal — the ONLY time the plaintext exists, so it
            lives OUTSIDE the status gate: enroll() calls setFreshToken() then
            await load(), and if that reload hits a 424/error/network blip the
            status flips off "ready". Gating the reveal on "ready" would then
            unmount it before the user ever copied the token — and the plaintext
            exists nowhere else (worker keeps only the hash), bricking the
            device. Persist until explicitly dismissed. */}
        {freshToken && (
          <div
            className="rounded-2xl border p-5 space-y-3"
            style={{ background: "rgba(0,0,0,0.5)", borderColor: accentBorder }}
            role="status"
          >
            <div className="text-sm font-semibold" style={{ color: accent }}>
              ✓ {freshToken.name} enrolled
            </div>
            <p className="text-xs text-gray-400">
              Copy this token now — it&apos;s shown <span className="text-gray-200">once</span> and stored only
              as a hash. Put it in <span className="font-mono">~/.tiny/device.json</span> (chmod 600).
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded-lg px-3 py-2 text-xs font-mono text-gray-200" style={{ background: "rgba(255,255,255,0.06)" }}>
                {freshToken.token}
              </code>
              <button
                ref={copyBtnRef}
                onClick={copyToken}
                className="px-3 py-2 rounded-lg text-xs font-semibold transition-all hover:scale-105 active:scale-100"
                style={{ background: accent, color: "#000" }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            {/* A screen reader doesn't reliably re-announce a label change on
                the already-focused Copy button — and this is the ONE screen
                where "did the copy work?" matters (the plaintext token exists
                nowhere else). A dedicated polite region confirms it out loud. */}
            <span aria-live="polite" className="sr-only">
              {copied ? "Token copied to clipboard" : ""}
            </span>
            <button
              onClick={() => setFreshToken(null)}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              I&apos;ve saved it — dismiss
            </button>
          </div>
        )}

        {status === "ready" && (
          <>
            {error && <p role="alert" className="text-red-400 text-sm">{error}</p>}

            {/* Enroll a new device */}
            <form onSubmit={enroll} className="flex flex-col sm:flex-row gap-2">
              <input
                ref={nameRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Device name (e.g. cagatay-macbook)"
                maxLength={64}
                // Identifier, not prose: iOS would autocapitalize/correct
                // "cagatay-macbook" → "Cagatay-MacBook", mismatching the name
                // in ~/.tiny/device.json and shell muscle memory. Same attrs
                // as the wallet address / claim-tx / onboarding key inputs.
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="flex-1 rounded-xl border px-3 py-2.5 text-sm bg-transparent text-white placeholder-gray-600 focus:outline-none transition-colors"
                style={{ borderColor: "rgba(255,255,255,0.18)" }}
                aria-label="New device name"
              />
              <select
                value={newKind}
                onChange={(e) => setNewKind(e.target.value)}
                className="rounded-xl border px-3 py-2.5 text-sm bg-black text-white focus:outline-none"
                style={{ borderColor: "rgba(255,255,255,0.18)" }}
                aria-label="Device kind"
              >
                <option value="cli">CLI</option>
                <option value="daemon">Daemon</option>
                <option value="browser">Browser</option>
              </select>
              <button
                type="submit"
                disabled={!newName.trim() || enrolling}
                className="px-4 py-2.5 rounded-xl text-sm font-semibold transition-all hover:scale-105 active:scale-100 disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed"
                style={{ background: accent, color: "#000", boxShadow: "0 0 20px rgba(var(--tiny-accent-rgb, 0,255,136),0.25)" }}
              >
                {enrolling ? "Enrolling…" : "Enroll"}
              </button>
            </form>

            {/* Device list */}
            {devices.length === 0 ? (
              <p className="text-sm text-gray-400 py-4">
                No devices yet. Enroll one above, or run <span className="font-mono text-gray-300">npx tiny-tech</span> on
                a machine to add it.
              </p>
            ) : (
              <ul className="space-y-2">
                {devices.map((d) => (
                  <li
                    key={d.id}
                    className="rounded-xl border px-4 py-3 transition-colors hover:border-white/30"
                    style={{ borderColor: "rgba(255,255,255,0.12)" }}
                  >
                   <div className="flex items-center gap-3">
                    {(() => {
                      const Glyph = KIND_ICON[d.kind || "cli"] || IconDevice;
                      // Muted anchor (online rows tint toward the accent) — the
                      // dot + name carry the emphasis, the glyph just types the row.
                      return (
                        <span className="flex-shrink-0" style={{ color: presenceOf(d) === "online" ? accent : "#8a8a8a" }}>
                          <Glyph className="w-5 h-5" />
                        </span>
                      );
                    })()}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold truncate">{d.name}</span>
                        {(() => {
                          // Three states, three renderings. "unknown" gets a hollow
                          // dot: a filled grey one reads as offline, which is the
                          // exact wrong claim for a robot nobody has called yet.
                          const p = presenceOf(d);
                          return (
                            <span
                              className="inline-flex items-center gap-1 text-[11px]"
                              style={{ color: p === "online" ? accent : "#8a8a8a" }}
                              title={p === "unknown" ? "This device answers when called — it has no heartbeat to report." : undefined}
                            >
                              <span
                                aria-hidden
                                className="inline-block w-2 h-2 rounded-full"
                                style={{
                                  background: p === "online" ? accent : p === "unknown" ? "transparent" : "#555",
                                  border: p === "unknown" ? "1px solid #8a8a8a" : undefined,
                                  boxShadow: p === "online" ? "0 0 6px rgba(var(--tiny-accent-rgb, 0,255,136),0.8)" : "none",
                                }}
                              />
                              {p === "online" ? "online" : p === "unknown" ? "reachable when called" : relativeSeen(d.last_seen)}
                            </span>
                          );
                        })()}
                      </div>
                      <div className="text-xs text-gray-400 truncate">
                        {/* An endpoint device's address is the useful subtitle —
                            it's WHERE the body is, and it has no platform string
                            worth reading on its own. */}
                        {d.kind === "endpoint" && d.url
                          ? d.url.replace(/^https:\/\//, "")
                          : d.platform || d.kind || "device"}
                      </div>
                    </div>
                    <button
                      onClick={() => revoke(d)}
                      disabled={revoking === d.id}
                      className="px-3 py-1.5 rounded-lg text-xs border text-gray-400 transition-colors hover:text-red-400 hover:border-red-400/40 disabled:opacity-50 disabled:hover:text-gray-400 disabled:hover:border-white/20"
                      style={{ borderColor: "rgba(255,255,255,0.18)" }}
                      aria-label={`Revoke ${d.name}`}
                    >
                      {revoking === d.id ? "Revoking…" : "Revoke"}
                    </button>
                   </div>
                    {/* 🤖 An endpoint device has a body out in the world, so the
                        row can show what it's actually doing — camera + live
                        telemetry — instead of just where it lives. Only endpoint
                        kinds have anything to poll; every other row is untouched
                        and makes no extra requests. */}
                    {d.kind === "endpoint" && <EndpointPanel device={d} accent={accent} />}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {dialog}
    </main>
  );
}
