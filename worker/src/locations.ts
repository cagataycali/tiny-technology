/**
 * 🗺️ Live map presence (maps-location loop c5).
 *
 * One row per user, written ONLY while their "be seen by other tinys"
 * toggle is on: the heartbeat IS the opt-in, DELETE is the opt-out, and the
 * MAP_PRESENCE_WINDOW_S staleness cut makes a dead client disappear from
 * the map on its own. Coordinates arrive pre-coarsened (4dp ≈ 11m) from
 * clients and are re-coarsened here — the table never holds anything finer.
 *
 * Internal-key guarded like devices: browsers reach these only through the
 * app's session-vouched /api/location proxy, so user_id is never claimable.
 *
 *   POST   /location/heartbeat { userId, lat, lng, speedKmh?, heading?, accuracyM? }
 *   GET    /location/list      → { pins: [...] }  (fresh rows only, users joined)
 *   DELETE /location           { userId }         (vanish immediately)
 */
import { Num, OpenAPIRoute, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Map pins go stale after this — laxer than device presence (60s): a phone
 *  in a pocket beats every ~60s, and a pin flickering off between beats
 *  would read as people leaving. */
export const MAP_PRESENCE_WINDOW_S = 300;

const CARDINALS = new Set(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);

/** 4-decimal coarsening — the only precision the table ever sees. */
export function coarsen(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

export function sanitizeLat(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < -90 || n > 90) return null;
  return coarsen(n);
}

export function sanitizeLng(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < -180 || n > 180) return null;
  return coarsen(n);
}

/** km/h, clamped to [0, 1200] (— anything faster than a jet is junk), 1dp. */
export function sanitizeSpeed(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(Math.min(n, 1200) * 10) / 10;
}

/** Heading is stored as a cardinal (what clients derive for the agent
 *  context) — an allowlist, not a parse, so junk can't land in the table. */
export function sanitizeHeading(raw: unknown): string | null {
  const s = String(raw ?? "").toUpperCase();
  return CARDINALS.has(s) ? s : null;
}

export function sanitizeAccuracy(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), 100_000);
}

// SQL as exported constants (devices.ts pattern) so the worker-gated tests
// run the exact statements against a local sqlite.
export const LOCATION_UPSERT_SQL = `
  INSERT INTO locations (user_id, lat, lng, speed_kmh, heading, accuracy_m, updated)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  ON CONFLICT(user_id) DO UPDATE SET
    lat = excluded.lat, lng = excluded.lng, speed_kmh = excluded.speed_kmh,
    heading = excluded.heading, accuracy_m = excluded.accuracy_m,
    updated = excluded.updated`;

export const LOCATION_LIST_SQL = `
  SELECT l.user_id, l.lat, l.lng, l.speed_kmh, l.heading, l.updated,
         u.github_login AS login, u.name, u.avatar
  FROM locations l JOIN users u ON u.id = l.user_id
  WHERE l.updated > ?1
  ORDER BY l.updated DESC
  LIMIT 200`;

export const LOCATION_DELETE_SQL = `DELETE FROM locations WHERE user_id = ?1`;

/** Cron hygiene: rows older than a day serve no one — the window already
 *  hides them; this keeps last-known coordinates from resting in the table
 *  after a client died without its opt-out DELETE. */
export const LOCATION_SWEEP_SQL = `DELETE FROM locations WHERE updated < ?1`;
export const LOCATION_SWEEP_AGE_S = 86_400;

export class LocationBeatCall extends OpenAPIRoute {
  static schema = {
    tags: ["Locations"],
    summary: "Internal: opt-in map presence heartbeat (userId vouched by app session).",
    requestBody: {
      userId: new Str({ required: true }),
      // Num, not Str: the router VALIDATES the body against these — every
      // client sends JSON numbers, and Str-typed fields 400 them (caught by
      // the first live E2E heartbeat). The sanitizers Number() anyway.
      lat: new Num({ required: true }),
      lng: new Num({ required: true }),
      speedKmh: new Num({ required: false }),
      heading: new Str({ required: false, description: "cardinal: N/NE/E/SE/S/SW/W/NW" }),
      accuracyM: new Num({ required: false }),
    },
    responses: { "200": { description: "Beating", schema: { response: "Beating" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, lat, lng, speedKmh, heading, accuracyM } = data.body;
    if (!userId) return json({ error: "userId required" }, 400);
    const cleanLat = sanitizeLat(lat);
    const cleanLng = sanitizeLng(lng);
    if (cleanLat == null || cleanLng == null) return json({ error: "valid lat/lng required" }, 400);

    await env.DB.prepare(LOCATION_UPSERT_SQL).bind(
      String(userId),
      cleanLat,
      cleanLng,
      sanitizeSpeed(speedKmh),
      sanitizeHeading(heading),
      sanitizeAccuracy(accuracyM),
      Math.floor(Date.now() / 1000),
    ).run();
    return json({ ok: true });
  }
}

export class LocationsListCall extends OpenAPIRoute {
  static schema = {
    tags: ["Locations"],
    summary: "Internal: everyone currently visible on the map.",
    responses: { "200": { description: "Pins", schema: { response: "Pins" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const cutoff = Math.floor(Date.now() / 1000) - MAP_PRESENCE_WINDOW_S;
    const { results } = await env.DB.prepare(LOCATION_LIST_SQL).bind(cutoff).all();
    const pins = (results || []).map((r: any) => ({
      userId: r.user_id,
      login: r.login,
      name: r.name,
      avatar: r.avatar,
      lat: r.lat,
      lng: r.lng,
      speedKmh: r.speed_kmh,
      heading: r.heading,
      updated: r.updated,
    }));
    return json({ ok: true, pins });
  }
}

export class LocationDeleteCall extends OpenAPIRoute {
  static schema = {
    tags: ["Locations"],
    summary: "Internal: opt out — remove the user's pin immediately.",
    requestBody: { userId: new Str({ required: true }) },
    responses: { "200": { description: "Gone", schema: { response: "Gone" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId } = data.body;
    if (!userId) return json({ error: "userId required" }, 400);
    await env.DB.prepare(LOCATION_DELETE_SQL).bind(String(userId)).run();
    return json({ ok: true });
  }
}
