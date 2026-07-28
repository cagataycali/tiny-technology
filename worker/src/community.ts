/**
 * GET /community — PUBLIC endpoint for the tiny.technology home page.
 *
 * Returns registered users (login, name, avatar) with their PUBLIC tinys,
 * so visitors can see who's building what. Private tinys and emails are
 * never exposed.
 */
import { OpenAPIRoute, Query } from "@cloudflare/itty-router-openapi";
import { CONSULTED_EDGES_SQL, trustRank } from "./graph";

export class CommunityCall extends OpenAPIRoute {
  static schema = {
    tags: ["Community"],
    summary: "Public list of registered users and their public tinys.",
    parameters: {
      limit: Query(Number, { required: false, default: 50, description: "Max users to return (1-100)." }),
    },
    responses: {
      "200": { description: "Users with public tinys", schema: { response: 'Users with public tinys' } },
    },
  };

  async handle(
    request: Request,
    env: any,
    _ctx: any,
    data: Record<string, any>
  ) {
    const limit = Math.min(Math.max(Number(data.limit || data.query?.limit) || 50, 1), 100);

    try {
      // Builders only (>=1 public tiny), most prolific first
      const { results } = await env.DB.prepare(
        `SELECT u.id, u.github_login, u.name, u.avatar, u.created,
                t.name AS tiny_name, t.created AS tiny_created,
                c.tiny_count
         FROM users u
         JOIN (
           SELECT user_id, COUNT(*) AS tiny_count
           FROM tinys WHERE private = 0 AND active = 1
           GROUP BY user_id
           HAVING tiny_count > 0
         ) c ON c.user_id = u.id
         JOIN tinys t ON t.user_id = u.id AND t.private = 0 AND t.active = 1
         ORDER BY c.tiny_count DESC, u.created ASC, t.created DESC`
      ).all();

      // The home page shows only the first 8 tiny names per builder (+ an
      // "N more" count from tinyCount), so cap the names we return — a builder
      // with hundreds of public tinys would otherwise dump them all into every
      // (uncached) home-page payload. tinyCount comes from the SQL COUNT, so
      // the total stays accurate even though names are capped.
      const NAMES_PER_USER = 8;
      // Group rows → one entry per user with a (capped) tinys[] array
      const byUser = new Map<string, any>();
      for (const row of results || []) {
        if (!byUser.has(row.id)) {
          if (byUser.size >= limit) continue;
          byUser.set(row.id, {
            login: row.github_login,
            name: row.name || row.github_login,
            avatar: row.avatar || '',
            joined: row.created,
            tinyCount: Number(row.tiny_count) || 0, // true total from SQL COUNT
            tinys: [],
          });
        }
        const u = byUser.get(row.id);
        if (u && row.tiny_name && u.tinys.length < NAMES_PER_USER) {
          u.tinys.push({ name: row.tiny_name, created: row.tiny_created });
        }
      }

      const users = Array.from(byUser.values());

      // 🎨 Per-tiny accents for the /universe constellation: themes live on
      // the KV tiny record (not D1), so batch-read the records behind the
      // names in this payload and attach each valid accent. Parallel gets,
      // capped at 40 — KV ops count against the subrequest budget (free
      // plan: 50 total incl. the D1 queries around this), and the cap
      // covers today's public-tiny count several times over. Failure is
      // cosmetic: the card grid and constellation fall back to the default
      // accent exactly as before.
      try {
        const names: string[] = users
          .flatMap((u: any) => u.tinys.map((t: any) => t.name))
          .slice(0, 40);
        const recs = await Promise.all(
          names.map((n) => env.tiny.get(n, { type: 'json' }).catch(() => null))
        );
        const accents = new Map<string, string>();
        recs.forEach((r: any, i: number) => {
          const a = r?.theme?.accent;
          if (typeof a === 'string' && /^#[0-9a-fA-F]{6}$/.test(a)) accents.set(names[i], a);
        });
        for (const u of users) {
          for (const t of u.tinys) {
            const a = accents.get(t.name);
            if (a) t.accent = a;
          }
        }
      } catch (err) { console.log(err, 'community accents'); }

      // Social proof (design item 5): all-time message counter from the
      // stats KV (incremented per chat message since the platform launched)
      let totalMessages = 0;
      try { totalMessages = Number(await env.stats.get('tiny:message')) || 0; } catch { }

      // True registered-user count — the home hero's headline stat.
      // users.length is capped by ?limit and filtered to public builders;
      // "how many users we have" is neither, so count the table directly.
      // Falls back to the old builders-length semantics if the query fails.
      let totalUsers = 0;
      try {
        const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
        totalUsers = Number(row?.n) || 0;
      } catch { }
      if (!totalUsers) totalUsers = users.length;

      // Same limit-cap problem as totalUsers had: summing tinyCount over the
      // first `limit` builders undercounts once builders exceed the cap.
      let totalPublicTinys = 0;
      try {
        const row = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM tinys WHERE private = 0 AND active = 1"
        ).first();
        totalPublicTinys = Number(row?.n) || 0;
      } catch { }
      if (!totalPublicTinys) totalPublicTinys = users.reduce((n, u) => n + u.tinyCount, 0);

      // 🕸️ Trust (memory graph stage 6): PageRank over PUBLIC consulted
      // edges — a tiny consulted by well-consulted tinys ranks up. Keyed by
      // slug (tiny:<slug> → <slug>); the home page badges its tiny pills.
      let trust: Record<string, number> = {};
      // Raw tiny↔tiny consult edges for the /universe constellation — the
      // PageRank result alone can't draw lines. Same query, already public
      // by construction (visibility = 'public' in CONSULTED_EDGES_SQL);
      // slugs stripped of the tiny: prefix like the trust map. SQL orders
      // weight DESC, so the cap keeps the heaviest edges.
      let consults: { src: string; dst: string; weight: number }[] = [];
      try {
        const { results: consulted } = await env.DB.prepare(CONSULTED_EDGES_SQL).all();
        if (consulted?.length) {
          trust = Object.fromEntries(
            Array.from(trustRank(consulted as any[]).entries())
              .filter(([n]) => n.startsWith('tiny:'))
              .map(([n, s]) => [n.slice(5), Number(s.toFixed(3))])
              .filter(([, s]) => (s as number) > 0.01)
          );
          consults = (consulted as any[])
            .filter((e) =>
              typeof e.src === 'string' && typeof e.dst === 'string' &&
              e.src.startsWith('tiny:') && e.dst.startsWith('tiny:') && e.src !== e.dst)
            .slice(0, 300)
            .map((e) => ({ src: e.src.slice(5), dst: e.dst.slice(5), weight: Number(e.weight) || 1 }));
        }
      } catch (err) { console.log(err, 'community trust'); }

      return new Response(JSON.stringify({
        users,
        totalUsers,
        // Emit the real COUNT computed above, NOT the reduce over the
        // limit-capped `users` — with >limit public builders the sum
        // undercounts (the same cap bug already fixed for totalUsers).
        totalPublicTinys,
        totalMessages,
        trust,
        consults,
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          // No CDN cache: deletes/creates must reflect immediately on the
          // home page (the query is a ~50ms D1 read)
          'Cache-Control': 'no-store',
        },
      });
    } catch (err: any) {
      console.log(err, 'community');
      return new Response(JSON.stringify({ users: [], error: 'community query failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
