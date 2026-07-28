/**
 * User + WebAuthn credential + tiny ownership endpoints (D1-backed).
 *
 * These are INTERNAL endpoints called by the Next.js app (tiny.technology).
 * Guarded by X-Internal-Key header — set INTERNAL_API_KEY via wrangler secret.
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";

export function checkInternalKey(request: Request, env: any): boolean {
  const key = request.headers.get("x-internal-key") || "";
  const expected = env.INTERNAL_API_KEY || "";
  // Constant-time compare on the shared secret. A bare `key === expected`
  // short-circuits on the first differing byte, so response timing leaks a
  // per-byte oracle on THE gate every internal route trusts — accumulate the
  // XOR of every byte instead so the comparison time is independent of where
  // (or whether) the strings first differ. Kept synchronous on purpose: a
  // digest-based compare would force this function async and ripple `await`
  // through every call site across the worker. The length check up front is
  // the standard, accepted length-leak (an unset secret still fails closed).
  if (!expected || key.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= key.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** POST /user/upsert  { githubId, login, email, name, avatar } → { user } */
export class UserUpsertCall extends OpenAPIRoute {
  static schema = { tags: ["users"], summary: "Internal: upsert user by GitHub identity" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { githubId, login, email, name, avatar } = body;
    if (!githubId) return json({ error: "githubId required" }, 400);

    const existing = await env.DB.prepare("SELECT * FROM users WHERE github_id = ?")
      .bind(String(githubId)).first();

    if (existing) {
      await env.DB.prepare(
        "UPDATE users SET github_login = ?, email = ?, name = ?, avatar = ? WHERE id = ?"
      ).bind(login || existing.github_login, email || existing.email,
             name || existing.name, avatar || existing.avatar, existing.id).run();
      // Echo what the UPDATE actually wrote — spreading only `existing`
      // returned stale email/name/avatar to the session bootstrap.
      return json({ user: {
        ...existing,
        github_login: login || existing.github_login,
        email: email || existing.email,
        name: name || existing.name,
        avatar: avatar || existing.avatar,
      } });
    }

    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, github_id, github_login, email, name, avatar) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, String(githubId), login || "", email || "", name || "", avatar || "").run();
    return json({ user: { id, github_id: String(githubId), github_login: login, email, name, avatar } });
  }
}

/** GET /user/get?id= or ?github_id= → { user, tinys } */
export class UserGetCall extends OpenAPIRoute {
  static schema = { tags: ["users"], summary: "Internal: get user + owned tinys", parameters: { id: Query(Str, { required: false }), github_id: Query(Str, { required: false }) } };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const githubId = url.searchParams.get("github_id");
    if (!id && !githubId) return json({ error: "id or github_id required" }, 400);

    const user = id
      ? await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first()
      : await env.DB.prepare("SELECT * FROM users WHERE github_id = ?").bind(githubId).first();
    if (!user) return json({ error: "not found" }, 404);

    const { results: tinys } = await env.DB.prepare(
      "SELECT name, private, active, created FROM tinys WHERE user_id = ? ORDER BY created DESC"
    ).bind(user.id).all();

    return json({ user, tinys: tinys || [] });
  }
}

/** POST /credential/add  { userId, credentialId, publicKey, signCount, transports, label } */
export class CredentialAddCall extends OpenAPIRoute {
  static schema = { tags: ["users"], summary: "Internal: store WebAuthn credential" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    const { userId, credentialId, publicKey, signCount, transports, label } = body;
    if (!userId || !credentialId || !publicKey) return json({ error: "missing fields" }, 400);
    // 🔐 CREDENTIAL-BINDING INTEGRITY: `id` is the PRIMARY KEY and it comes from
    // the AUTHENTICATOR's attestation, not the server. The old
    // `INSERT OR REPLACE` overwrote the WHOLE row on an id collision — so a
    // crafted/malicious authenticator that presents a credentialId already
    // owned by ANOTHER user would silently REASSIGN that row's user_id +
    // public_key, stealing/destroying the victim's passkey (login looks the
    // credential up by id to find its user). WebAuthn credential IDs are meant
    // to be globally unique, so a collision under a different user is never
    // legitimate. Do it atomically: only UPDATE when the existing row is the
    // SAME user (idempotent re-register of one's own passkey — sign_count/label
    // refresh); a different-user conflict makes the DO UPDATE's WHERE false, so
    // 0 rows change and we reject. Single statement → no TOCTOU window.
    const res = await env.DB.prepare(
      `INSERT INTO credentials (id, user_id, public_key, sign_count, transports, label)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(id) DO UPDATE SET
         public_key = excluded.public_key,
         sign_count = excluded.sign_count,
         transports = excluded.transports,
         label = excluded.label
       WHERE credentials.user_id = excluded.user_id`
    ).bind(credentialId, userId, publicKey, signCount || 0,
           JSON.stringify(transports || []), label || "passkey").run();
    if (!res?.meta?.changes) {
      return json({ error: "credential already registered to another account" }, 409);
    }
    return json({ ok: true });
  }
}

/** GET /credential/list?user_id= OR ?credential_id= → { credentials } */
export class CredentialListCall extends OpenAPIRoute {
  static schema = { tags: ["users"], summary: "Internal: list WebAuthn credentials", parameters: { user_id: Query(Str, { required: false }), credential_id: Query(Str, { required: false }) } };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const url = new URL(request.url);
    const userId = url.searchParams.get("user_id");
    const credId = url.searchParams.get("credential_id");
    if (credId) {
      const cred = await env.DB.prepare("SELECT * FROM credentials WHERE id = ?").bind(credId).first();
      return json({ credentials: cred ? [cred] : [] });
    }
    if (!userId) return json({ error: "user_id or credential_id required" }, 400);
    const { results } = await env.DB.prepare("SELECT * FROM credentials WHERE user_id = ?")
      .bind(userId).all();
    return json({ credentials: results || [] });
  }
}

/** POST /credential/signcount  { credentialId, signCount } */
export class CredentialSignCountCall extends OpenAPIRoute {
  static schema = { tags: ["users"], summary: "Internal: update credential sign count" };
  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return unauthorized();
    const body: any = await request.json().catch(() => ({}));
    // credentialId is required — without it the UPDATE matches nothing and we
    // would falsely report ok. sign_count only ever moves FORWARD (a lower
    // value signals a cloned authenticator; ignore it rather than roll back).
    if (!body.credentialId) return json({ error: "credentialId required" }, 400);
    await env.DB.prepare(
      "UPDATE credentials SET sign_count = ? WHERE id = ? AND ? > sign_count"
    ).bind(Number(body.signCount) || 0, body.credentialId, Number(body.signCount) || 0).run();
    return json({ ok: true });
  }
}
