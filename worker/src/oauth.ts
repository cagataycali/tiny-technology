/**
 * Per-service OAuth token store + refresh (migration 0015_oauth_tokens.sql).
 *
 * Ports careless's IntegrationsTab (GitHub / Spotify / Google) to the worker.
 * careless kept tokens client-side under the implicit flow with no refresh;
 * tinyai already runs server sessions and holds provider client secrets in
 * env, so we do the authorization-CODE flow server-side and persist a
 * refresh_token — the token store can mint fresh access tokens without
 * dragging the user back through consent.
 *
 * Trust boundary (AGENTS.md §13, same as telegram.ts): every endpoint is
 * internal-key guarded. The app's /api/auth/<service> callback exchanges the
 * code and POSTs the tokens here; the use_<service> tools read a fresh access
 * token via /oauth/token (refreshing on the fly). The raw token NEVER goes to
 * the browser — GET /oauth?userId= returns only connection metadata.
 *
 *   POST   /oauth        { userId, service, accessToken, refreshToken?,
 *                          expiresIn?, scope?, tokenType? }   → { ok }
 *   GET    /oauth?userId=&service=?  → { connections:[{service,scope,
 *                          expiresAt,expired}], ... }   (NO raw tokens)
 *   GET    /oauth/token?userId=&service=  → { accessToken, tokenType, scope }
 *                          (internal only; refreshes if expired & refresh_token)
 *   DELETE /oauth        { userId, service }             → { ok, removed }
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Refresh this many seconds BEFORE the real expiry (clock skew / call time). */
export const REFRESH_SKEW_S = 60;

export const SUPPORTED_SERVICES = ["github", "spotify", "google"] as const;
export type OAuthService = (typeof SUPPORTED_SERVICES)[number];

export function isSupportedService(s: unknown): s is OAuthService {
  return typeof s === "string" && (SUPPORTED_SERVICES as readonly string[]).includes(s);
}

/**
 * Token endpoints for the refresh grant. github has no refresh (its user
 * tokens don't expire), so it's absent — a github row simply never refreshes.
 */
export const TOKEN_ENDPOINTS: Record<string, string> = {
  spotify: "https://accounts.spotify.com/api/token",
  google: "https://oauth2.googleapis.com/token",
};

// SQL as exported constants (devices.ts / graph.ts pattern) so the parent
// repo's worker-gated tests exercise the exact statements against sqlite.
export const OAUTH_UPSERT_SQL = `
  INSERT INTO oauth_tokens
    (user_id, service, access_token, refresh_token, expires_at, scope, token_type, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
  ON CONFLICT(user_id, service) DO UPDATE SET
    access_token = excluded.access_token,
    -- keep the existing refresh_token when the provider omits one on refresh
    -- (Google only returns refresh_token on the FIRST consent) — never clobber
    -- a good refresh_token with an empty string.
    refresh_token = COALESCE(NULLIF(excluded.refresh_token, ''), oauth_tokens.refresh_token),
    expires_at = excluded.expires_at,
    scope = COALESCE(NULLIF(excluded.scope, ''), oauth_tokens.scope),
    token_type = COALESCE(NULLIF(excluded.token_type, ''), oauth_tokens.token_type),
    updated_at = excluded.updated_at`;

export const OAUTH_GET_SQL = `
  SELECT service, access_token, refresh_token, expires_at, scope, token_type
  FROM oauth_tokens WHERE user_id = ?1 AND service = ?2`;

export const OAUTH_LIST_SQL = `
  SELECT service, expires_at, scope, token_type, updated_at
  FROM oauth_tokens WHERE user_id = ?1
  ORDER BY service`;

export const OAUTH_DELETE_SQL = `
  DELETE FROM oauth_tokens WHERE user_id = ?1 AND service = ?2`;

/** A stored token is stale when it will expire within the skew window. */
export function isExpired(expiresAt: number, nowS: number): boolean {
  // expires_at = 0 means "never / unknown" (e.g. github) — treat as fresh.
  return expiresAt > 0 && nowS >= expiresAt - REFRESH_SKEW_S;
}

/**
 * Exchange a refresh_token for a fresh access token at the provider. Returns
 * the new token fields, or null when refresh is impossible/failed (caller then
 * surfaces a "reconnect" error to the agent, careless-style). Never throws.
 */
export async function refreshAccessToken(
  service: string,
  refreshToken: string,
  env: any,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string; tokenType: string } | null> {
  const endpoint = TOKEN_ENDPOINTS[service];
  if (!endpoint || !refreshToken) return null;

  const clientId = env[`${service.toUpperCase()}_CLIENT_ID`];
  const clientSecret = env[`${service.toUpperCase()}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: String(clientId),
    client_secret: String(clientSecret),
  });

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) return null;
    return {
      accessToken: String(data.access_token),
      // providers may or may not rotate the refresh_token; '' keeps the old one
      refreshToken: data.refresh_token ? String(data.refresh_token) : "",
      expiresIn: Number(data.expires_in) || 0,
      scope: data.scope ? String(data.scope) : "",
      tokenType: data.token_type ? String(data.token_type) : "Bearer",
    };
  } catch {
    return null;
  }
}

export class OAuthUpsertCall extends OpenAPIRoute {
  static schema = {
    tags: ["OAuth"],
    summary: "Internal: store/replace a user's OAuth token for a service.",
    requestBody: {
      userId: new Str({ required: true }),
      service: new Str({ required: true, description: "github | spotify | google" }),
      accessToken: new Str({ required: true }),
      refreshToken: new Str({ required: false }),
      expiresIn: new Str({ required: false, description: "seconds until expiry" }),
      scope: new Str({ required: false }),
      tokenType: new Str({ required: false }),
    },
    responses: { "200": { description: "Stored", schema: { response: "Stored" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, service, accessToken, refreshToken, expiresIn, scope, tokenType } = data.body;
    if (!userId || !accessToken) return json({ error: "userId and accessToken required" }, 400);
    if (!isSupportedService(service)) return json({ error: "unsupported service" }, 400);

    const now = Math.floor(Date.now() / 1000);
    const ttl = Number(expiresIn) || 0;
    await env.DB.prepare(OAUTH_UPSERT_SQL).bind(
      String(userId),
      String(service),
      String(accessToken),
      String(refreshToken || ""),
      ttl > 0 ? now + ttl : 0,
      String(scope || ""),
      String(tokenType || "Bearer"),
      now,
    ).run();

    return json({ ok: true, service });
  }
}

export class OAuthListCall extends OpenAPIRoute {
  static schema = {
    tags: ["OAuth"],
    summary: "Internal: a user's OAuth connections (NO raw tokens).",
    parameters: { userId: Query(String, { required: true }) },
    responses: { "200": { description: "Connections", schema: { response: "Connections" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const userId = new URL(request.url).searchParams.get("userId") || "";
    if (!userId) return json({ error: "userId required" }, 400);

    const { results } = await env.DB.prepare(OAUTH_LIST_SQL).bind(userId).all();
    const now = Math.floor(Date.now() / 1000);
    const connections = (results || []).map((r: any) => ({
      service: r.service,
      scope: r.scope,
      expiresAt: r.expires_at,
      expired: isExpired(Number(r.expires_at) || 0, now),
      updatedAt: r.updated_at,
    }));
    return json({ ok: true, connections });
  }
}

export class OAuthTokenCall extends OpenAPIRoute {
  static schema = {
    tags: ["OAuth"],
    summary: "Internal: a fresh access token for (user, service); refreshes if stale.",
    parameters: {
      userId: Query(String, { required: true }),
      service: Query(String, { required: true }),
    },
    responses: { "200": { description: "Token", schema: { response: "Token" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId") || "";
    const service = url.searchParams.get("service") || "";
    if (!userId || !isSupportedService(service)) return json({ error: "userId and valid service required" }, 400);

    const row: any = await env.DB.prepare(OAUTH_GET_SQL).bind(userId, service).first();
    if (!row) return json({ error: "not_connected", service }, 404);

    const now = Math.floor(Date.now() / 1000);
    if (!isExpired(Number(row.expires_at) || 0, now)) {
      return json({ ok: true, accessToken: row.access_token, tokenType: row.token_type, scope: row.scope });
    }

    // Stale — try a refresh. No refresh_token (or refresh failed) → tell the
    // caller to reconnect (careless surfaces the same "re-auth" signal).
    const refreshed = await refreshAccessToken(service, String(row.refresh_token || ""), env);
    if (!refreshed) return json({ error: "expired_reconnect", service }, 401);

    await env.DB.prepare(OAUTH_UPSERT_SQL).bind(
      userId,
      service,
      refreshed.accessToken,
      refreshed.refreshToken,           // '' keeps the existing one (COALESCE)
      refreshed.expiresIn > 0 ? now + refreshed.expiresIn : 0,
      refreshed.scope,
      refreshed.tokenType,
      now,
    ).run();

    return json({ ok: true, accessToken: refreshed.accessToken, tokenType: refreshed.tokenType, scope: refreshed.scope || row.scope });
  }
}

export class OAuthDeleteCall extends OpenAPIRoute {
  static schema = {
    tags: ["OAuth"],
    summary: "Internal: disconnect a service for a user.",
    requestBody: {
      userId: new Str({ required: true }),
      service: new Str({ required: true }),
    },
    responses: { "200": { description: "Removed", schema: { response: "Removed" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, service } = data.body;
    if (!userId || !service) return json({ error: "userId and service required" }, 400);

    const res = await env.DB.prepare(OAUTH_DELETE_SQL).bind(String(userId), String(service)).run();
    return json({ ok: true, removed: Number(res?.meta?.changes || 0) });
  }
}
