/**
 * Multi-provider BYO-model credentials, synced across devices (internal-key only).
 *
 *   GET  /model-providers?userId=          → { ok, providers:[{provider, model_id,
 *                                            base_url, region, max_tokens,
 *                                            additional_fields, hasKey, is_active}] }
 *   GET  /model-providers?userId=&full=1   → same but each row INCLUDES the
 *                                            decrypted apiKey (device-sync read —
 *                                            the whole point of storing keys
 *                                            server-side; the app bridge gates it
 *                                            behind the owner's session)
 *   POST /model-providers { userId, provider, model_id?, base_url?, region?,
 *                           max_tokens?, additional_fields?, api_key?,
 *                           is_active? } → upsert one provider row.
 *                           api_key: omit=keep, ''=clear, value=replace.
 *                           is_active:true → this row becomes THE active config
 *                           (all other rows deactivate + it's mirrored into
 *                           model_config so /api/chat is untouched).
 *   DELETE /model-providers?userId=&provider=  → remove one provider row.
 *
 * Encryption is shared with model-config.ts (same AES-256-GCM, same secret).
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { encryptKey, decryptKey } from "./model-config";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const MAX_ADDITIONAL = 4096;

/** Mirror the active provider row into model_config so the existing chat
 *  route (which reads model_config) picks it up with zero changes. */
async function mirrorActive(env: any, userId: string): Promise<void> {
  const row: any = await env.DB.prepare(
    "SELECT provider, model_id, base_url, region, max_tokens, additional_fields, api_key_enc FROM model_providers WHERE user_id = ? AND is_active = 1"
  ).bind(userId).first();
  if (!row) {
    await env.DB.prepare("DELETE FROM model_config WHERE user_id = ?").bind(userId).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO model_config (user_id, provider, model_id, base_url, region, max_tokens, additional_fields, api_key_enc, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider, model_id=excluded.model_id,
       base_url=excluded.base_url, region=excluded.region, max_tokens=excluded.max_tokens,
       additional_fields=excluded.additional_fields, api_key_enc=excluded.api_key_enc, updated_at=unixepoch()`
  ).bind(userId, row.provider, row.model_id || "", row.base_url || "", row.region || "",
         Number(row.max_tokens || 0), row.additional_fields || "", row.api_key_enc || "").run();
}

export class ModelProvidersGetCall extends OpenAPIRoute {
  static schema = {
    tags: ["ModelConfig"],
    summary: "Internal: list a user's configured model providers.",
    parameters: {
      userId: Query(String, { required: true }),
      full: Query(String, { required: false, description: "1 → include decrypted apiKey (device sync)." }),
    },
    responses: { "200": { description: "Providers", schema: { response: "Providers" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const q = new URL(request.url).searchParams;
    const userId = q.get("userId") || "";
    const full = q.get("full") === "1";
    if (!userId) return json({ error: "userId required" }, 400);

    const rows: any = await env.DB.prepare(
      "SELECT provider, model_id, base_url, region, max_tokens, additional_fields, api_key_enc, is_active FROM model_providers WHERE user_id = ? ORDER BY is_active DESC, provider"
    ).bind(userId).all();

    const providers = [];
    for (const row of (rows?.results || [])) {
      const base = {
        provider: row.provider,
        model_id: row.model_id || "",
        base_url: row.base_url || "",
        region: row.region || "",
        max_tokens: Number(row.max_tokens || 0),
        additional_fields: row.additional_fields || "",
        is_active: Boolean(row.is_active),
      };
      if (full) {
        providers.push({ ...base, apiKey: await decryptKey(row.api_key_enc || "", env) });
      } else {
        providers.push({ ...base, hasKey: Boolean(row.api_key_enc) });
      }
    }
    return json({ ok: true, providers });
  }
}

export class ModelProvidersSetCall extends OpenAPIRoute {
  static schema = {
    tags: ["ModelConfig"],
    summary: "Internal: upsert one of a user's model providers.",
    requestBody: {
      userId: new Str({ required: true }),
      provider: new Str({ required: true }),
      model_id: new Str({ required: false }),
      base_url: new Str({ required: false }),
      region: new Str({ required: false }),
      max_tokens: new Str({ required: false }),
      additional_fields: new Str({ required: false }),
      api_key: new Str({ required: false, description: "Omit=keep, ''=clear, value=replace." }),
      is_active: new Str({ required: false, description: "'1' → make this the active config." }),
    },
    responses: { "200": { description: "Set", schema: { response: "Set" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const b = data.body || {};
    const userId = String(b.userId || "");
    const provider = String(b.provider || "").toLowerCase().slice(0, 32);
    if (!userId) return json({ error: "userId required" }, 400);
    if (!provider) return json({ error: "provider required" }, 400);

    const modelId = String(b.model_id ?? "").slice(0, 128);
    const baseUrl = String(b.base_url ?? "").slice(0, 256);
    const region = String(b.region ?? "").slice(0, 64);
    const maxTokens = Math.max(0, Math.floor(Number(b.max_tokens) || 0));
    const additional = String(b.additional_fields ?? "").slice(0, MAX_ADDITIONAL);
    const makeActive = String(b.is_active ?? "") === "1" || b.is_active === true;

    // api_key: omitted → keep; '' → clear; value → encrypt + replace.
    let keyClause = "";
    let keyValue: string | null = null;
    if (b.api_key !== undefined) {
      keyValue = await encryptKey(String(b.api_key).slice(0, 512), env);
      keyClause = ", api_key_enc = excluded.api_key_enc";
    }

    if (keyValue !== null) {
      await env.DB.prepare(
        `INSERT INTO model_providers (user_id, provider, model_id, base_url, region, max_tokens, additional_fields, api_key_enc, is_active, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT(user_id, provider) DO UPDATE SET model_id=excluded.model_id,
           base_url=excluded.base_url, region=excluded.region, max_tokens=excluded.max_tokens,
           additional_fields=excluded.additional_fields${keyClause},
           is_active=excluded.is_active, updated_at=unixepoch()`
      ).bind(userId, provider, modelId, baseUrl, region, maxTokens, additional, keyValue, makeActive ? 1 : 0).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO model_providers (user_id, provider, model_id, base_url, region, max_tokens, additional_fields, is_active, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT(user_id, provider) DO UPDATE SET model_id=excluded.model_id,
           base_url=excluded.base_url, region=excluded.region, max_tokens=excluded.max_tokens,
           additional_fields=excluded.additional_fields,
           is_active=excluded.is_active, updated_at=unixepoch()`
      ).bind(userId, provider, modelId, baseUrl, region, maxTokens, additional, makeActive ? 1 : 0).run();
    }

    if (makeActive) {
      // Exactly one active row per user.
      await env.DB.prepare(
        "UPDATE model_providers SET is_active = 0 WHERE user_id = ? AND provider != ?"
      ).bind(userId, provider).run();
      await mirrorActive(env, userId);
    }
    return json({ ok: true });
  }
}

export class ModelProvidersDeleteCall extends OpenAPIRoute {
  static schema = {
    tags: ["ModelConfig"],
    summary: "Internal: delete one of a user's model providers.",
    parameters: {
      userId: Query(String, { required: true }),
      provider: Query(String, { required: true }),
    },
    responses: { "200": { description: "Deleted", schema: { response: "Deleted" } } },
  };

  async handle(request: Request, env: any) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const q = new URL(request.url).searchParams;
    const userId = q.get("userId") || "";
    const provider = (q.get("provider") || "").toLowerCase();
    if (!userId || !provider) return json({ error: "userId and provider required" }, 400);

    const row: any = await env.DB.prepare(
      "SELECT is_active FROM model_providers WHERE user_id = ? AND provider = ?"
    ).bind(userId, provider).first();
    await env.DB.prepare(
      "DELETE FROM model_providers WHERE user_id = ? AND provider = ?"
    ).bind(userId, provider).run();
    // Deleting the active provider reverts the mirrored config to free tier.
    if (row?.is_active) await mirrorActive(env, userId);
    return json({ ok: true });
  }
}
