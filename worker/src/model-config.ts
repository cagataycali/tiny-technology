/**
 * Per-user BYO-model config, synced across devices (internal-key only).
 *
 *   GET  /model-config?userId=          → full config INCLUDING the decrypted
 *                                         apiKey (server-side chat route only)
 *   GET  /model-config?userId=&safe=1   → non-secret fields + hasKey:bool, NO key
 *   POST /model-config  { userId, provider, model_id, base_url, region,
 *                         max_tokens, additional_fields, api_key? }
 *                       → upsert; api_key encrypted at rest. Omit api_key to
 *                         keep the stored one; pass "" to clear it; pass a value
 *                         to replace it. provider:'' clears the whole row.
 *
 * SECURITY: the api_key is a live provider secret. It is stored AES-256-GCM
 * encrypted (key derived from MODEL_CONFIG_ENC_KEY || INTERNAL_API_KEY) and is
 * returned ONLY on the non-safe internal read. The safe read (what the web/app
 * bridge uses) never sees it — mirrors the oauth_tokens trust boundary.
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// ── AES-256-GCM at rest ──────────────────────────────────────────────────
// The enc key is derived (SHA-256) from a server secret so we get exactly 32
// bytes regardless of the secret's length. MODEL_CONFIG_ENC_KEY is preferred so
// the encryption secret can be rotated independently of the internal API key;
// INTERNAL_API_KEY is the fallback so this works on existing deployments.
async function encKey(env: any): Promise<CryptoKey> {
  const secret = env.MODEL_CONFIG_ENC_KEY || env.INTERNAL_API_KEY || "";
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Exported for unit tests (round-trip verification).
export async function encryptKey(plaintext: string, env: any): Promise<string> {
  if (!plaintext) return "";
  const key = await encKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext))
  );
  // Store iv||ciphertext so decrypt is self-contained.
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64(out);
}

export async function decryptKey(stored: string, env: any): Promise<string> {
  if (!stored) return "";
  try {
    const raw = fromB64(stored);
    const iv = raw.slice(0, 12);
    const ct = raw.slice(12);
    const key = await encKey(env);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    // Wrong key (secret rotated without re-encrypt) or corrupt blob — treat as
    // "no key" rather than throwing, so a chat request degrades to the default
    // provider instead of 500ing.
    return "";
  }
}

const MAX_ADDITIONAL = 4096;

export class ModelConfigGetCall extends OpenAPIRoute {
  static schema = {
    tags: ["ModelConfig"],
    summary: "Internal: read a user's synced model config.",
    parameters: {
      userId: Query(String, { required: true, description: "User id." }),
      safe: Query(String, { required: false, description: "1 → omit the api key, expose hasKey." }),
    },
    responses: { "200": { description: "Config", schema: { response: "Config" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const q = new URL(request.url).searchParams;
    const userId = q.get("userId") || "";
    const safe = q.get("safe") === "1";
    if (!userId) return json({ error: "userId required" }, 400);

    const row: any = await env.DB.prepare(
      "SELECT provider, model_id, base_url, region, max_tokens, additional_fields, api_key_enc FROM model_config WHERE user_id = ?"
    ).bind(userId).first();

    if (!row || !row.provider) return json({ ok: true, config: null });

    const base = {
      provider: row.provider || "",
      model_id: row.model_id || "",
      base_url: row.base_url || "",
      region: row.region || "",
      max_tokens: Number(row.max_tokens || 0),
      additional_fields: row.additional_fields || "",
    };

    if (safe) {
      // What the browser/app bridge is allowed to see — never the raw key.
      return json({ ok: true, config: { ...base, hasKey: Boolean(row.api_key_enc) } });
    }
    // Server-side chat route: needs the real key to build the model.
    return json({ ok: true, config: { ...base, apiKey: await decryptKey(row.api_key_enc || "", env) } });
  }
}

export class ModelConfigSetCall extends OpenAPIRoute {
  static schema = {
    tags: ["ModelConfig"],
    summary: "Internal: set a user's synced model config.",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      provider: new Str({ required: false, description: "Provider id ('' clears the row)." }),
      model_id: new Str({ required: false }),
      base_url: new Str({ required: false }),
      region: new Str({ required: false }),
      max_tokens: new Str({ required: false }),
      additional_fields: new Str({ required: false, description: "JSON string." }),
      api_key: new Str({ required: false, description: "Omit=keep, ''=clear, value=replace." }),
    },
    responses: { "200": { description: "Set", schema: { response: "Set" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const b = data.body || {};
    const userId = String(b.userId || "");
    if (!userId) return json({ error: "userId required" }, 400);

    const provider = String(b.provider ?? "").toLowerCase().slice(0, 32);
    // Empty provider (or the free 'default') clears the whole synced config —
    // the user reverted to the free tier; nothing to sync.
    if (!provider || provider === "default") {
      await env.DB.prepare("DELETE FROM model_config WHERE user_id = ?").bind(userId).run();
      return json({ ok: true, cleared: true });
    }

    const modelId = String(b.model_id ?? "").slice(0, 128);
    const baseUrl = String(b.base_url ?? "").slice(0, 256);
    const region = String(b.region ?? "").slice(0, 64);
    const maxTokens = Math.max(0, Math.floor(Number(b.max_tokens) || 0));
    const additional = String(b.additional_fields ?? "").slice(0, MAX_ADDITIONAL);

    // api_key: omitted (undefined) → keep the existing encrypted key;
    // "" → clear; a value → encrypt + replace.
    let apiKeyEncClause = "";
    let apiKeyEncValue: string | null = null;
    if (b.api_key !== undefined) {
      apiKeyEncValue = await encryptKey(String(b.api_key).slice(0, 512), env);
      apiKeyEncClause = ", api_key_enc = ?";
    }

    // Upsert the non-secret fields always; the key clause is conditional so an
    // "omit api_key" save (settings changed, key untouched) preserves the key.
    if (apiKeyEncValue !== null) {
      await env.DB.prepare(
        `INSERT INTO model_config (user_id, provider, model_id, base_url, region, max_tokens, additional_fields, api_key_enc, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider, model_id=excluded.model_id,
           base_url=excluded.base_url, region=excluded.region, max_tokens=excluded.max_tokens,
           additional_fields=excluded.additional_fields, api_key_enc=excluded.api_key_enc, updated_at=unixepoch()`
      ).bind(userId, provider, modelId, baseUrl, region, maxTokens, additional, apiKeyEncValue).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO model_config (user_id, provider, model_id, base_url, region, max_tokens, additional_fields, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider, model_id=excluded.model_id,
           base_url=excluded.base_url, region=excluded.region, max_tokens=excluded.max_tokens,
           additional_fields=excluded.additional_fields, updated_at=unixepoch()`
      ).bind(userId, provider, modelId, baseUrl, region, maxTokens, additional).run();
    }
    return json({ ok: true });
  }
}
