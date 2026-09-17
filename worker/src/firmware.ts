/**
 * Firmware channels — the one stable name a deployed tiny can poll.
 *
 *   POST /firmware/publish  { userId, channel, version, url, sha256 } → { ok }
 *   GET  /firmware/current?userId=&channel=                          → { bundle? }
 *   POST /firmware/device-current { deviceId, token, channel }       → { bundle? }
 *
 * Everything internal-key guarded; devices reach this only via the app's
 * /api/firmware/manifest proxy, exactly as they reach the relay (AGENTS.md §13).
 *
 * **This stores a POINTER, not a manifest.** The bundle's bytes and its manifest
 * JSON live in R2 behind /api/media under unguessable keys — which is precisely
 * why a pollable name is needed, and equally why the manifest itself must not be
 * copied in here. The device fetches the manifest by url and checks it against
 * sha256 (firmware/tiny_ota.py), so a second copy of that JSON would be one edit
 * from disagreeing with the artifact being verified. Three fields that cannot
 * drift is the whole design.
 *
 * Security invariants:
 *   - publish/current are owner-scoped; the proxy stamps userId from the session
 *   - device-current authenticates by (id, token_hash, revoked=0) — the same
 *     no-oracle property as heartbeat and the relay poll
 *   - a device is only ever told about ITS OWNER's channel, never another's
 *   - `url` must be https and on a host the FIRMWARE will fetch from. The device
 *     pins hosts itself and that is the defence that matters; this check exists
 *     so an unusable pointer is refused while the person who typed it is still
 *     watching, rather than becoming one line in a relay reply from a necklace.
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { hashDeviceToken } from "./devices";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Mirrors MEDIA_HOSTS in firmware/tiny_ota.py — where our artifacts are served. */
export const FIRMWARE_HOSTS = ["plugin.tiny.technology", "tiny.technology"] as const;

/** Channel names are config keys on a device, not prose. */
export const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const VERSION_MAX = 128;
export const URL_MAX = 512;

export const FIRMWARE_UPSERT_SQL = `
  INSERT INTO firmware_channels (user_id, channel, version, url, sha256, updated_at, force_flag)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  ON CONFLICT(user_id, channel) DO UPDATE SET
    version = excluded.version, url = excluded.url,
    sha256 = excluded.sha256, updated_at = excluded.updated_at,
    force_flag = excluded.force_flag`;

export const FIRMWARE_GET_SQL = `
  SELECT version, url, sha256, updated_at, force_flag FROM firmware_channels
  WHERE user_id = ?1 AND channel = ?2`;

export const FIRMWARE_DEVICE_AUTH_SQL = `
  SELECT user_id FROM devices WHERE id = ?1 AND token_hash = ?2 AND revoked = 0`;

/**
 * Validate a bundle pointer, returning the cleaned fields or one reason.
 *
 * Every rejection here is a bundle a device could not have installed anyway. The
 * sha256 is required and must be 64 hex: an optional integrity field is not an
 * integrity field, and a pointer with no hash would send a wearable to fetch
 * whatever currently answers at that URL.
 */
export function validateBundle(raw: any): { bundle: {
  channel: string; version: string; url: string; sha256: string;
} } | { error: string } {
  const channel = String(raw?.channel ?? "").trim();
  if (!CHANNEL_RE.test(channel)) return { error: "channel must be [a-z0-9][a-z0-9_-]{0,31}" };

  const version = String(raw?.version ?? "").trim();
  if (!version || version.length > VERSION_MAX) {
    return { error: `version required, at most ${VERSION_MAX} chars` };
  }

  const sha256 = String(raw?.sha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) return { error: "sha256 must be 64 hex chars" };

  const url = String(raw?.url ?? "").trim();
  if (!url || url.length > URL_MAX) return { error: `url required, at most ${URL_MAX} chars` };
  let host = "";
  try {
    const u = new URL(url);
    // http:// is refused, not upgraded: this URL names executable code, and a
    // plaintext hop lets anyone on the path pick what the necklace runs next.
    if (u.protocol !== "https:") return { error: "url must be https" };
    host = u.hostname;
  } catch {
    return { error: "url is not a URL" };
  }
  if (!(FIRMWARE_HOSTS as readonly string[]).includes(host)) {
    return { error: `${host} is not a host the firmware takes code from` };
  }

  return { bundle: { channel, version, url, sha256 } };
}

/**
 * Order two version strings by their integer runs: "0.14.7-m12" → [0,14,7,12],
 * compared elementwise (missing = 0). Returns <0 | 0 | >0, or null when either
 * side has no digits at all — an exotic scheme is not evidence of a downgrade,
 * so the caller treats null as "cannot tell, allow".
 *
 * This exists because the device's OTA trigger is direction-blind (strcmp in
 * tiny_ota_check_and_stage): a channel pointer that moves backwards WILL be
 * installed. Tonight's 0.14.5 near-miss was caught by a human process rule
 * (ancestry-before-publish); this is the machine's half of that rule.
 */
export function versionOrder(a: string, b: string): number | null {
  const runs = (s: string) => (s.match(/\d+/g) || []).map(Number);
  const A = runs(a), B = runs(b);
  if (!A.length || !B.length) return null;
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] ?? 0) - (B[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const bundleOf = (row: any) => row ? {
  version: String(row.version), url: String(row.url),
  sha256: String(row.sha256), updated_at: Number(row.updated_at),
  // Served to the DEVICE: its OTA guard (0.14.9) refuses non-newer versions
  // unless the bundle itself says force. "1" is the platform's string idiom
  // the firmware parses; omitted entirely on a normal forward publish.
  ...(Number(row.force_flag) ? { force: "1" } : {}),
} : null;

export class FirmwarePublishCall extends OpenAPIRoute {
  static schema = {
    tags: ["Firmware"],
    summary: "Internal: point a channel at a published bundle (owner-scoped).",
    requestBody: {
      userId: new Str({ required: true }),
      channel: new Str({ required: true }),
      version: new Str({ required: true }),
      url: new Str({ required: true, description: "https, on a firmware host" }),
      sha256: new Str({ required: true, description: "64 hex, of the manifest" }),
      force: new Str({ required: false, description: "truthy → allow pointing the channel at an OLDER version (intentional rollback)" }),
    },
    responses: { "200": { description: "Published", schema: { response: "Published" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, force } = data.body;
    if (!userId) return json({ error: "userId required" }, 400);

    const checked = validateBundle(data.body);
    if ("error" in checked) return json({ error: checked.error }, 400);
    const b = checked.bundle;

    // Downgrade refusal — the publish-side backstop for the device's
    // direction-blind OTA trigger. Same-version re-publish stays allowed
    // (re-pointing a rebuilt artifact); only strictly-older is refused, and
    // `force` is the operator's escape hatch for an intentional rollback.
    // 409, not 400: the bundle itself is valid — the CHANNEL STATE is what
    // objects, and the edge passes this code + sentence through untouched.
    if (!force) {
      const cur = await env.DB.prepare(FIRMWARE_GET_SQL)
        .bind(String(userId), b.channel).first();
      if (cur?.version) {
        const ord = versionOrder(b.version, String(cur.version));
        if (ord !== null && ord < 0) {
          return json({
            error: `refusing downgrade: channel '${b.channel}' is at ${cur.version}, ` +
                   `${b.version} is older — pass force:true for an intentional rollback`,
          }, 409);
        }
      }
    }

    // force is persisted as channel state so the DEVICE guard honors the
    // rollback too — and self-clears on the next normal publish (a forward
    // pointer must never inherit a stale override).
    await env.DB.prepare(FIRMWARE_UPSERT_SQL).bind(
      String(userId), b.channel, b.version, b.url, b.sha256,
      Math.floor(Date.now() / 1000), force ? 1 : 0,
    ).run();
    return json({ ok: true, channel: b.channel, version: b.version });
  }
}

export class FirmwareCurrentCall extends OpenAPIRoute {
  static schema = {
    tags: ["Firmware"],
    summary: "Internal: read a channel's current bundle (owner-scoped).",
    parameters: {
      userId: Query(String, { required: true }),
      channel: Query(String, { required: true }),
    },
    responses: { "200": { description: "Bundle", schema: { response: "Bundle" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, channel } = data.query;
    if (!userId || !channel) return json({ error: "userId and channel required" }, 400);

    const row = await env.DB.prepare(FIRMWARE_GET_SQL)
      .bind(String(userId), String(channel)).first();
    // An empty channel is a legitimate answer — "nothing published here" — and
    // must not be an error, or a first-run poll reads as an outage.
    return json({ ok: true, bundle: bundleOf(row) });
  }
}

export class FirmwareDeviceCurrentCall extends OpenAPIRoute {
  static schema = {
    tags: ["Firmware"],
    summary: "Internal: a device asks its own channel what to run (token auth).",
    requestBody: {
      deviceId: new Str({ required: true }),
      token: new Str({ required: true }),
      channel: new Str({ required: true }),
    },
    responses: { "200": { description: "Bundle", schema: { response: "Bundle" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { deviceId, token, channel } = data.body;
    if (!deviceId || !token || !channel) {
      return json({ error: "deviceId, token and channel required" }, 400);
    }

    const row = await env.DB.prepare(FIRMWARE_DEVICE_AUTH_SQL)
      .bind(String(deviceId), await hashDeviceToken(String(token))).first();
    // Same shape as the relay poll: no distinction between "no such device" and
    // "wrong token", so this is not an oracle for enumerating device ids.
    if (!row?.user_id) return json({ error: "unauthorized" }, 401);

    // The OWNER resolved from the token, never a userId the caller supplied. A
    // device that could name the account would be able to install another
    // owner's bundle on itself.
    const found = await env.DB.prepare(FIRMWARE_GET_SQL)
      .bind(String(row.user_id), String(channel)).first();
    return json({ ok: true, bundle: bundleOf(found) });
  }
}
