/**
 * GET /profile?login=<github_login> — PUBLIC endpoint for
 * tiny.technology/@<login> profile pages.
 *
 * Returns one builder's public face: login, name, avatar, joined date,
 * their PUBLIC tinys, and their forged tools — INCLUDING each tool's code
 * and params (public by design: tools are shareable artifacts that run in
 * the caller's own sandbox, never with the author's creds; same as the
 * public marketplace browse). Private tinys, emails, and github ids stay out.
 */
import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";
import { SOCIAL_OWNER, userNodeId } from "./graph";
import { reputationScore } from "./reputation";

export class ProfileCall extends OpenAPIRoute {
  static schema = {
    tags: ["Community"],
    summary: "Public profile of a builder: public tinys + forged tools.",
    parameters: {
      login: Query(Str, { required: true, description: "GitHub login (with or without leading @)." }),
    },
    responses: {
      "200": { description: "Profile", schema: { response: "Profile" } },
    },
  };

  async handle(
    request: Request,
    env: any,
    _ctx: any,
    data: Record<string, any>
  ) {
    const json = (body: any, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          // Same policy as /community: profile edits must show immediately
          "Cache-Control": "no-store",
        },
      });

    const raw = String(data.login || data.query?.login || "").trim().replace(/^@/, "");
    // GitHub usernames: alphanumeric + hyphens, max 39 chars
    if (!raw || !/^[a-zA-Z0-9-]{1,39}$/.test(raw)) {
      return json({ error: "invalid login" }, 400);
    }

    try {
      const user = await env.DB.prepare(
        "SELECT id, github_login, name, avatar, created FROM users WHERE LOWER(github_login) = LOWER(?)"
      ).bind(raw).first();
      if (!user) return json({ error: "not found" }, 404);

      const { results: tinys } = await env.DB.prepare(
        "SELECT name, created FROM tinys WHERE user_id = ? AND private = 0 AND active = 1 ORDER BY created DESC"
      ).bind(user.id).all();

      // 🎨 Per-tiny accents (same pattern as /community): themes live on the
      // KV tiny record, not D1 — batch-read behind the names (capped 40,
      // subrequest-budget-safe) and attach validated 6-hex accents so the
      // profile's tiny cards render in true color. Failure is cosmetic.
      const accents = new Map<string, string>();
      try {
        const names = (tinys || []).map((t: any) => String(t.name)).slice(0, 40);
        const recs = await Promise.all(
          names.map((n: string) => env.tiny.get(n, { type: 'json' }).catch(() => null))
        );
        recs.forEach((r: any, i: number) => {
          const a = r?.theme?.accent;
          if (typeof a === 'string' && /^#[0-9a-fA-F]{6}$/.test(a)) accents.set(names[i], a);
        });
      } catch (err) { console.log(err, 'profile accents'); }

      // Code + params are public by design: tools are shareable artifacts
      // (they run in the caller's own sandbox, never with the author's creds).
      // LEFT JOIN the active price for this tool's resource key
      // (tool:<login>/<name>) so clients can show a one-time purchase price
      // up front — installing a priced tool settles that charge (see
      // app/api/tools/install). price_micro is 0/absent for free tools.
      const toolResourcePrefix = `tool:${user.github_login}/`;
      const { results: tools } = await env.DB.prepare(
        `SELECT t.name, t.description, t.params_json, t.code, t.created,
                p.price_micro AS price_micro
           FROM user_tools t
           LEFT JOIN prices p
             ON p.resource = ? || t.name AND p.active = 1
          WHERE t.user_id = ? ORDER BY t.created ASC`
      ).bind(toolResourcePrefix, user.id).all();

      // 🕸️ Followers (graph stage 6): live public follows edges pointing at
      // this builder. Count only — the follower LIST stays unexposed (who
      // follows whom is observable in aggregate, enumerable by nobody).
      let followers = 0;
      try {
        const row = await env.DB.prepare(
          `SELECT COUNT(*) AS c FROM edge
           WHERE owner = ? AND rel = 'follows' AND dst = ?
             AND visibility = 'public' AND valid_to IS NULL`
        ).bind(SOCIAL_OWNER, userNodeId(String(user.id))).first();
        followers = Number(row?.c || 0);
      } catch (err) { console.log(err, 'profile followers'); }

      // 🏅 Reputation: the score the network gave them (reputation.ts). Public
      // like the follower count — it's the standing that relaxes login walls,
      // so it has to be legible. Its own read path, its own failure: a missing
      // reputation table (pre-migration) reports 0, never a broken profile.
      const reputation = await reputationScore(env, String(user.id));

      return json({
        followers,
        reputation,
        login: user.github_login,
        name: user.name || user.github_login,
        avatar: user.avatar || "",
        joined: user.created,
        tinys: (tinys || []).map((t: any) => ({ name: t.name, created: t.created, accent: accents.get(t.name) })),
        tools: (tools || []).map((t: any) => {
          let params: Record<string, string> = {};
          try { params = JSON.parse(t.params_json || "{}"); } catch { }
          return {
            name: t.name,
            description: t.description || "",
            params,
            code: t.code || "",
            created: t.created,
            price_micro: Number(t.price_micro || 0),
          };
        }),
      });
    } catch (err: any) {
      console.log(err, "profile");
      return json({ error: "profile query failed" }, 500);
    }
  }
}
