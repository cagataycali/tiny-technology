/**
 * Device registry (tiny-node PR2 — docs/tiny-node-goal.md §3).
 *
 * Every endpoint is internal-key guarded: devices NEVER talk to the worker
 * directly — they go through the app's /api/devices proxies (the AGENTS.md
 * §13 rule; userId is vouched by the app's session, the device token is
 * verified here in-body against its stored hash).
 *
 *   POST   /device/enroll     { userId, name, platform, kind, capabilities }
 *                             → { device_id, device_token }  (token ONCE)
 *   POST   /device/heartbeat  { deviceId, token, capabilities? }
 *                             → { ok }                        (updates last_seen)
 *   GET    /device/list?userId= → { devices: [...] }          (presence derived)
 *   DELETE /device            { userId, deviceId }            (revoke)
 *
 * Auth model (mcp-server-design.md CLI-token precedent): device token ≠
 * user JWT. Long-lived, revocable per-device, hashed at rest. The user's
 * session enrolls; the device token operates.
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { emitEvent } from "./events";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Presence window: a device is "online" when it heartbeat within this. */
export const PRESENCE_WINDOW_S = 60;

const MAX_DEVICES_PER_USER = 20;
const NAME_MAX = 64;
const CAPS_MAX = 2048;

export const DEVICE_TOKEN_PREFIX = "tind_";

/** Device kinds that dial IN (hold a `tind_` token, heartbeat, poll the relay). */
export const PULL_KINDS = ["daemon", "browser", "cli"] as const;
/** A device tiny dials OUT to: its own authenticated HTTPS API (a robot, a printer). */
export const ENDPOINT_KIND = "endpoint";
export const DEVICE_KINDS = [...PULL_KINDS, ENDPOINT_KIND] as const;

export const isEndpointKind = (kind: unknown): boolean => String(kind) === ENDPOINT_KIND;

/**
 * SSRF guard for an endpoint device's URL. Mirrors lib/utils.ts
 * validatePublicUrl — duplicated rather than imported because the worker is a
 * separate bundle with no access to the Next app's modules, so the RULES must
 * be kept identical by the shared test in tests/endpoint-device.test.ts.
 *
 * https + public hostname only. Any IP literal (in any encoding), localhost,
 * .local, .internal, or a dotless host is refused: an endpoint device URL is
 * fetched server-side by the worker, so a private address here would turn the
 * registry into an SSRF pivot into Cloudflare's network.
 */
export function validateEndpointUrl(raw: unknown): { url: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "url required for an endpoint device" };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { error: "invalid url" }; }
  if (u.protocol !== "https:") return { error: "url must be https" };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const looksNumericIp = /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/.test(host);
  const isIp = looksNumericIp || host.includes(":");
  if (isIp || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    return { error: "url must be a public hostname" };
  }
  // Normalize to origin: every call this registry makes is `${url}${path}`, so a
  // stored path/query/fragment would silently corrupt every request built from it.
  return { url: u.origin };
}

/** SHA-256 hex — the only form a token ever takes at rest. */
export async function hashDeviceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${DEVICE_TOKEN_PREFIX}${b64}`;
}

/** Normalize a capabilities value to a bounded JSON array string. */
export function sanitizeCapabilities(raw: unknown): string {
  try {
    const arr = Array.isArray(raw) ? raw : JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(arr)) return "[]";
    return JSON.stringify(arr.map((c) => String(c).slice(0, 32)).slice(0, 32)).slice(0, CAPS_MAX);
  } catch {
    return "[]";
  }
}

// SQL as exported constants (graph.ts pattern) so the worker-gated tests
// can exercise the exact statements against a local sqlite.
export const DEVICE_INSERT_SQL = `
  INSERT INTO devices (id, user_id, name, platform, kind, capabilities, token_hash, last_seen, created_at, revoked)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 0)`;

// Endpoint devices carry url+secret and NO inbound token. last_seen is left
// NULL: presence for these comes from an outbound probe, and a fake "seen now"
// at enroll would render an unreachable robot as online until the first probe.
export const ENDPOINT_INSERT_SQL = `
  INSERT INTO devices (id, user_id, name, platform, kind, capabilities, token_hash, last_seen, created_at, revoked, url, secret)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', NULL, ?7, 0, ?8, ?9)`;

export const DEVICE_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM devices WHERE user_id = ?1 AND revoked = 0`;

export const DEVICE_HEARTBEAT_SQL = `
  UPDATE devices SET last_seen = ?2, capabilities = COALESCE(?3, capabilities)
  WHERE id = ?1 AND token_hash = ?4 AND revoked = 0`;

// `url` is listable (the owner needs to see where a body lives); `secret` is
// NOT in the column list — a bearer credential must never leave the worker.
export const DEVICE_LIST_SQL = `
  SELECT id, name, platform, kind, capabilities, last_seen, created_at, url
  FROM devices WHERE user_id = ?1 AND revoked = 0
  ORDER BY last_seen DESC`;

/** Resolve one endpoint device's call target. Owner-scoped: a device id alone
 *  is never enough, so a leaked id can't be used to fetch someone's secret. */
export const ENDPOINT_GET_SQL = `
  SELECT id, name, kind, capabilities, url, secret
  FROM devices WHERE id = ?1 AND user_id = ?2 AND revoked = 0 AND kind = 'endpoint'`;

export const DEVICE_REVOKE_SQL = `
  UPDATE devices SET revoked = 1 WHERE id = ?1 AND user_id = ?2`;

/**
 * Re-key a device the caller already owns: same row, new token.
 *
 * Enroll mints a token exactly once and only ever stores its SHA-256, so a
 * client that loses the plaintext has no way back — and the only workaround was
 * to enroll the hardware AGAIN, which mints a NEW row and leaves the old one
 * permanently offline in the owner's fleet. That is how a Nicla Voice paired
 * from a laptop became unreachable from the phone: the phone had the session and
 * could see the row, but not the credential to speak for it.
 *
 * Owner-scoped like DEVICE_REVOKE_SQL: (id, user_id), so a leaked device id is
 * not enough to steal a device. `revoked = 0` is required too — rotating a
 * revoked device would silently resurrect a credential the owner killed on
 * purpose, which is the one thing revoke is supposed to guarantee.
 *
 * Rotation is implicitly a revoke of the OLD token: the previous hash is
 * overwritten, so anything still holding it fails its next heartbeat. That is
 * the intended behaviour (two clients sharing one device row would fight over a
 * single BLE connection slot anyway), but it means rotate is a mutation to
 * authorize carefully, never a read.
 *
 * `kind != 'endpoint'` is a privilege guard, not tidiness. Endpoint devices are
 * stored with token_hash = '' ON PURPOSE — they dial OUT and are authenticated
 * by the url+secret pair, so nothing inbound may speak as them. Rotating one
 * would hand its caller a working inbound credential for a device that is not
 * supposed to have one, turning a re-key into a privilege escalation.
 */
export const DEVICE_ROTATE_TOKEN_SQL = `
  UPDATE devices SET token_hash = ?3
  WHERE id = ?1 AND user_id = ?2 AND revoked = 0 AND kind != 'endpoint'`;

export class DeviceEnrollCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: enroll a device for a user; returns the token ONCE.",
    requestBody: {
      userId: new Str({ required: true }),
      name: new Str({ required: true }),
      platform: new Str({ required: false }),
      kind: new Str({ required: false, description: "daemon | browser | cli | endpoint" }),
      capabilities: new Str({ required: false, description: "JSON array string" }),
      url: new Str({ required: false, description: "endpoint kind only: https origin tiny dials out to" }),
      secret: new Str({ required: false, description: "endpoint kind only: bearer token for that url" }),
    },
    responses: { "200": { description: "Enrolled", schema: { response: "Enrolled" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, name, platform, kind, capabilities, url, secret } = data.body;
    if (!userId || !String(name || "").trim()) return json({ error: "userId and name required" }, 400);

    const count = await env.DB.prepare(DEVICE_COUNT_SQL).bind(String(userId)).first();
    if (Number(count?.n || 0) >= MAX_DEVICES_PER_USER) {
      return json({ error: `device limit reached (${MAX_DEVICES_PER_USER}) — revoke one first` }, 400);
    }

    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    // 🤖 Endpoint device: tiny dials OUT. No token is minted (nothing
    // authenticates INTO it), so the enroll reply carries no device_token —
    // callers must not read its absence as a failure.
    if (isEndpointKind(kind)) {
      const checked = validateEndpointUrl(url);
      if ("error" in checked) return json({ error: checked.error }, 400);
      const bearer = String(secret || "").trim();
      // Refuse a credential-less endpoint outright rather than storing one that
      // 401s on every call: the whole point is reaching a SEALED dashboard, and
      // a silently-unauthenticated body would read as "enrolled, just broken".
      if (!bearer) return json({ error: "secret required for an endpoint device" }, 400);
      if (bearer.length > 4096) return json({ error: "secret too long" }, 400);
      await env.DB.prepare(ENDPOINT_INSERT_SQL).bind(
        id,
        String(userId),
        String(name).slice(0, NAME_MAX),
        String(platform || "").slice(0, 32),
        ENDPOINT_KIND,
        sanitizeCapabilities(capabilities),
        now,
        checked.url,
        bearer,
      ).run();
      return json({ ok: true, device_id: id, kind: ENDPOINT_KIND, url: checked.url });
    }

    const token = mintToken();
    await env.DB.prepare(DEVICE_INSERT_SQL).bind(
      id,
      String(userId),
      String(name).slice(0, NAME_MAX),
      String(platform || "").slice(0, 32),
      (PULL_KINDS as readonly string[]).includes(String(kind)) ? String(kind) : "cli",
      sanitizeCapabilities(capabilities),
      await hashDeviceToken(token),
      now,
    ).run();

    // The ONLY time the plaintext token leaves this handler
    return json({ ok: true, device_id: id, device_token: token });
  }
}

export class DeviceHeartbeatCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: device presence heartbeat (token verified in-body).",
    requestBody: {
      deviceId: new Str({ required: true }),
      token: new Str({ required: true }),
      capabilities: new Str({ required: false }),
    },
    responses: { "200": { description: "Alive", schema: { response: "Alive" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { deviceId, token, capabilities } = data.body;
    if (!deviceId || !token) return json({ error: "deviceId and token required" }, 400);

    const res = await env.DB.prepare(DEVICE_HEARTBEAT_SQL).bind(
      String(deviceId),
      Math.floor(Date.now() / 1000),
      capabilities != null ? sanitizeCapabilities(capabilities) : null,
      await hashDeviceToken(String(token)),
    ).run();

    // A wrong token and a revoked device look identical from outside —
    // no oracle for probing which device ids exist
    if (!res?.meta?.changes) return json({ error: "unknown device" }, 401);
    return json({ ok: true });
  }
}

export class DevicesListCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: list a user's devices with presence.",
    parameters: { userId: Query(String, { required: true }) },
    responses: { "200": { description: "Devices", schema: { response: "Devices" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const userId = new URL(request.url).searchParams.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);

    const { results } = await env.DB.prepare(DEVICE_LIST_SQL).bind(userId).all();
    const now = Math.floor(Date.now() / 1000);
    const devices = (results || []).map((d: any) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      kind: d.kind,
      capabilities: d.capabilities,
      last_seen: d.last_seen,
      created_at: d.created_at,
      // An endpoint device never heartbeats, so a last_seen-derived `online`
      // would pin it to false forever and the agent would refuse to use a
      // perfectly healthy robot. Its liveness is a probe result, not a
      // timestamp: report `null` (unknown from here) and let the caller probe.
      online: isEndpointKind(d.kind) ? null : (!!d.last_seen && now - d.last_seen < PRESENCE_WINDOW_S),
      ...(isEndpointKind(d.kind) ? { url: d.url } : {}),
    }));
    return json({ ok: true, devices });
  }
}

/**
 * 🤖 Endpoint invoke — the outbound half of the device model.
 *
 * The secret lives here and NEVER leaves: the app proxy asks this route to make
 * the call, rather than fetching the credential and calling from the edge. So a
 * bug in the app can leak at most a robot's ANSWER, never its key.
 *
 * `action` selects which of the dashboard's surfaces to hit. Deliberately a
 * small allowlist rather than a free path: the caller is an LLM tool argument,
 * and these dashboards expose print/drive/laser routes where a
 * model-chosen path is a physical-world action nobody authorized.
 *
 * Most actions answer JSON; `snapshot` answers image bytes, and that difference
 * is handled inside the handler rather than by a second route, so both share the
 * same owner scoping, redirect refusal and credential handling.
 */
export const ENDPOINT_ACTIONS: Record<
  string,
  { method: "GET" | "POST"; path: string; body?: boolean; image?: boolean }
> = {
  chat: { method: "POST", path: "/api/chat", body: true },
  telemetry: { method: "GET", path: "/api/telemetry" },
  // A still frame, NOT the dashboard's /api/camera/stream: that route is an
  // infinite multipart generator (it yields frames until the client leaves), so
  // proxying it would pin a worker invocation open forever and no timeout could
  // ever fire. Snapshot polling gives the same "live" feeling out of bounded
  // requests — the frame cost ~70ms on the printer.
  snapshot: { method: "GET", path: "/api/camera/snapshot", image: true },
};

/**
 * Content types an `image: true` action may return.
 *
 * ⚠️ This allowlist is load-bearing, not hygiene. These bytes get served back
 * from OUR origin, so passing through whatever `Content-Type` the robot claimed
 * would let a compromised (or merely misconfigured) dashboard return
 * `text/html` and have it EXECUTE as a same-origin document on tiny.technology —
 * with access to the session cookie that fetched it. Pin the type to something
 * inert and never echo the device's own header.
 */
export const ENDPOINT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** A robot is not a trusted size: cap what we will buffer from one frame. */
export const ENDPOINT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read at most `max` bytes of a response body, then give up.
 *
 * `arrayBuffer()` on an untrusted body is unbounded — a device that streams
 * forever (or lies in Content-Length) would exhaust the worker's memory. Reading
 * through the stream lets us stop at the cap instead of trusting a header.
 */
export async function readCapped(res: Response, max: number): Promise<Uint8Array | { error: string }> {
  const reader = res.body?.getReader();
  if (!reader) return { error: "device sent an empty response" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      // Stop pulling: the point of the cap is not to receive the rest.
      await reader.cancel().catch(() => {});
      return { error: `image exceeded ${Math.round(max / 1024 / 1024)}MB` };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export class DeviceEndpointCallRoute extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: call an endpoint device's own authenticated API.",
    requestBody: {
      userId: new Str({ required: true }),
      deviceId: new Str({ required: true }),
      action: new Str({ required: false, description: "chat | telemetry | snapshot" }),
      prompt: new Str({ required: false, description: "for action=chat" }),
    },
    responses: { "200": { description: "Called", schema: { response: "Called" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, deviceId, action, prompt } = data.body;
    if (!userId || !deviceId) return json({ error: "userId and deviceId required" }, 400);

    const spec = ENDPOINT_ACTIONS[String(action || "chat")];
    if (!spec) return json({ error: `unknown action — use ${Object.keys(ENDPOINT_ACTIONS).join(" | ")}` }, 400);
    if (spec.body && !String(prompt || "").trim()) return json({ error: "prompt required for action=chat" }, 400);

    const row: any = await env.DB.prepare(ENDPOINT_GET_SQL).bind(String(deviceId), String(userId)).first();
    // Same no-oracle rule as the heartbeat: a device belonging to someone else,
    // a revoked one, a pull-mode one, and a nonexistent id all answer alike.
    if (!row) return json({ error: "unknown endpoint device" }, 404);

    // Re-validate at CALL time, not just at enroll: a row written by an older
    // build (or a future direct DB edit) must not become an SSRF primitive.
    const checked = validateEndpointUrl(row.url);
    if ("error" in checked) return json({ error: `stored url rejected: ${checked.error}` }, 400);

    // A robot's agent is SLOW: the printer's CAD agent (76 tools, a real model
    // call per turn) measured 53s for a one-line status question, so a shared 60s
    // budget sat one bad round-trip from reporting a healthy machine as
    // unreachable. The ceiling isn't ours to pick freely though — use_device also
    // runs inside /api/job-run, whose function budget is 120s, so anything longer
    // is time the caller can never actually wait. 90s is the honest maximum:
    // comfortably past the measured cost, still inside the tightest consumer.
    const timeoutMs = spec.body ? 90_000 : 20_000;
    // A camera frame is a cheap read of an already-decoded buffer (measured
    // 67ms), and it's polled on a timer by an open page — so it gets the
    // TIGHTEST budget of the three. A slow frame should be dropped and retried
    // on the next tick, not held for 20s while ticks queue up behind it.
    const budgetMs = spec.image ? 10_000 : timeoutMs;

    let res: Response;
    try {
      res = await fetch(`${checked.url}${spec.path}`, {
        method: spec.method,
        headers: {
          Authorization: `Bearer ${row.secret}`,
          ...(spec.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(spec.body ? { body: JSON.stringify({ prompt: String(prompt) }) } : {}),
        // A redirect must never be followed: it could bounce our bearer token to
        // another origin. `redirect: "error"` is NOT implemented at the edge —
        // the runtime throws on the option itself, which surfaced as "device
        // unreachable" on every single call. `manual` hands the 3xx back
        // unfollowed, so the check below is what actually enforces the rule.
        redirect: "manual",
        signal: AbortSignal.timeout(budgetMs),
      });
    } catch (e: any) {
      // Two different truths hide behind one throw. "Timed out" means the device
      // ANSWERED the connection and is still thinking — telling the owner it's
      // powered off sends them to check cables on a machine that's working. Only
      // a genuine connect failure is unreachable.
      const msg = String(e?.message || e);
      if (/abort|timeout/i.test(msg)) {
        return json({
          error: `device did not finish within ${Math.round(budgetMs / 1000)}s — its agent may still be working`,
          timeout: true,
        }, 504);
      }
      // Unreachable is the NORMAL failure for a robot: tunnel down, machine
      // asleep. Report it as such (not a 500) so the agent can say "it's offline".
      return json({ error: `device unreachable: ${msg}`, unreachable: true }, 502);
    }

    // Redirect refused, not followed: with `manual` the 3xx arrives here intact,
    // and following it by hand would be exactly the credential-leak we're
    // avoiding. A dashboard that redirects its API is misconfigured, so say so.
    if (res.status >= 300 && res.status < 400) {
      return json({
        error: `device redirected (${res.status}) — refusing to follow, that would send our credential to another origin`,
      }, 502);
    }

    // An image action answers with BYTES, so its failure checks have to happen
    // before anything tries to read the body as text. The auth/redirect rules
    // above already ran — those are about the credential, not the payload.
    if (spec.image) {
      if (res.status === 401 || res.status === 403) {
        return json({ error: "device rejected our credential — re-enroll with a fresh token", unauthorized: true }, 502);
      }
      if (!res.ok) return json({ error: `device returned ${res.status}` }, 502);

      // Trust our allowlist, not the device's claim. An unexpected type means
      // the dashboard is misconfigured (or hostile) — refuse rather than serve
      // it from our origin under a guessed type.
      const claimed = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const type = (ENDPOINT_IMAGE_TYPES as readonly string[]).includes(claimed) ? claimed : null;
      if (!type) return json({ error: `device returned a non-image content-type (${claimed || "none"})` }, 502);

      const bytes = await readCapped(res, ENDPOINT_IMAGE_MAX_BYTES).catch(() => ({ error: "image read failed" }));
      if (!(bytes instanceof Uint8Array)) return json(bytes, 502);
      if (!bytes.byteLength) return json({ error: "device returned an empty image" }, 502);

      return new Response(bytes, {
        status: 200,
        headers: {
          // The pinned type from the allowlist — never the device's own header.
          "Content-Type": type,
          // A frame is a point-in-time observation; caching one would show a
          // stale chamber and make the poll pointless.
          "Cache-Control": "no-store",
          // Defence in depth for bytes we did not author: even if the type
          // check above were ever loosened, these stop it being treated as a
          // document and keep it out of a sniffing browser's HTML path.
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    }

    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      // A distinct signal from unreachable: the body answered, it rejected our
      // credential. Silently reporting "offline" here would send the owner
      // debugging a network problem that is really an expired token.
      return json({ error: "device rejected our credential — re-enroll with a fresh token", unauthorized: true }, 502);
    }
    if (!res.ok) return json({ error: `device returned ${res.status}`, body: text.slice(0, 512) }, 502);

    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON is legal; pass the text */ }
    return json({ ok: true, result: parsed ?? text.slice(0, 8192) });
  }
}

export class DeviceRevokeCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: revoke a device (kills its token instantly).",
    requestBody: {
      userId: new Str({ required: true }),
      deviceId: new Str({ required: true }),
    },
    responses: { "200": { description: "Revoked", schema: { response: "Revoked" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, deviceId } = data.body;
    if (!userId || !deviceId) return json({ error: "userId and deviceId required" }, 400);

    const res = await env.DB.prepare(DEVICE_REVOKE_SQL).bind(String(deviceId), String(userId)).run();
    return json({ ok: true, revoked: Number(res?.meta?.changes || 0) });
  }
}

/**
 * Internal: re-key a device the caller owns, so a second client can adopt it
 * WITHOUT re-enrolling the hardware.
 *
 * The problem this exists for: enroll returns the plaintext token once and keeps
 * only its hash, so "I own this device but don't have its token" had exactly one
 * answer — enroll it again. That mints a new row, and the old row never goes
 * offline gracefully; it just sits in the fleet forever, last_seen frozen. A
 * Nicla Voice paired from a laptop was unreachable from the phone for this
 * reason alone: the phone could SEE the row and even scan the board's beacon,
 * but had no credential to act as it.
 *
 * Deliberately a POST, not a GET: it MUTATES (the old token stops working
 * immediately, see DEVICE_ROTATE_TOKEN_SQL), and a credential-issuing GET is the
 * kind of thing that ends up in a log, a referrer, or a prefetch.
 *
 * 0 rows changed means "not yours, revoked, or an endpoint device" and answers
 * 404 for all three. Distinguishing them would confirm the existence of another
 * user's device id, which is the same oracle DEVICE_HEARTBEAT_SQL avoids.
 */
export class DeviceRotateTokenCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: rotate a device's token; returns the new one ONCE.",
    requestBody: {
      userId: new Str({ required: true }),
      deviceId: new Str({ required: true }),
    },
    responses: { "200": { description: "Rotated", schema: { response: "Rotated" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, deviceId } = data.body;
    if (!userId || !deviceId) return json({ error: "userId and deviceId required" }, 400);

    const token = mintToken();
    const res = await env.DB.prepare(DEVICE_ROTATE_TOKEN_SQL)
      .bind(String(deviceId), String(userId), await hashDeviceToken(token))
      .run();

    // Check BEFORE returning the token. Handing back a freshly minted token on a
    // no-op UPDATE would give the caller a credential that authenticates nothing
    // — every heartbeat would fail with no clue why.
    if (Number(res?.meta?.changes || 0) === 0) {
      return json({ error: "device not found" }, 404);
    }
    return json({ ok: true, device_id: String(deviceId), device_token: token });
  }
}

/**
 * 🎙️ Device → the owner's event ring. The PUSH half of the device model.
 *
 * Every other device surface is pull: the relay hands a device work and waits
 * for its reply. That is the right shape for "take a photo" but the wrong shape
 * for something the device notices on its own — a Nicla Voice wake word fires
 * when it fires, and nothing asked for it.
 *
 * The event ring is the surface every client already polls (ActivityHUD, iOS
 * Activity.swift, Android Activity.kt) AND that the next turn's system prompt
 * carries (lib/chat/prompt.ts eventsBlock), so a wake becomes something the
 * agent can mention unprompted, on any client, from a single write.
 *
 * Auth is the device token, not a session: the Nicla Voice has no WiFi and its
 * events arrive through whichever phone is gatewaying it, which may have nobody
 * logged in on screen. The token resolves the OWNER, so a device can only ever
 * write to its own user's ring — an important property when the caller is a
 * relay rather than the device itself.
 *
 * `kind` is an allowlist, not free text. This route is reachable by anything
 * holding a device token, and the ring is what the agent reads as ground truth
 * about what happened; a device that could emit arbitrary kinds could forge a
 * `device_result` or a scheduler fire.
 */
export const DEVICE_EVENT_KINDS = ["nicla_wake", "nicla_sentry", "nicla_transcript", "device_note"] as const;

export const DEVICE_EVENT_AUTH_SQL = `
  SELECT user_id, name FROM devices WHERE id = ?1 AND token_hash = ?2 AND revoked = 0`;

export class DeviceEventCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: device-authored event onto its owner's ring (token in-body).",
    requestBody: {
      deviceId: new Str({ required: true }),
      token: new Str({ required: true }),
      kind: new Str({ required: true, description: DEVICE_EVENT_KINDS.join(" | ") }),
      detail: new Str({ required: false, description: "Human-readable detail (≤300 chars)." }),
    },
    responses: { "200": { description: "Emitted", schema: { response: "Emitted" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { deviceId, token, kind, detail } = data.body;
    if (!deviceId || !token || !kind) return json({ error: "deviceId, token and kind required" }, 400);
    if (!DEVICE_EVENT_KINDS.includes(String(kind) as any)) {
      return json({ error: "unsupported kind" }, 400);
    }

    const row = await env.DB.prepare(DEVICE_EVENT_AUTH_SQL)
      .bind(String(deviceId), await hashDeviceToken(String(token))).first();
    // Same no-oracle property as heartbeat: a wrong token and a revoked device
    // are indistinguishable from outside.
    if (!row?.user_id) return json({ error: "unknown device" }, 401);

    // Name the device in the detail. The ring is read as prose by the agent, and
    // "heard 'alexa'" with no subject is unattributable once a user owns two.
    const name = String(row.name || "device").slice(0, 40);
    await emitEvent(env, String(row.user_id), String(kind), `${name}: ${String(detail || "").slice(0, 240)}`);
    return json({ ok: true });
  }
}
