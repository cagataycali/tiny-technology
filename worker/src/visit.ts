/**
 * Visit beacon — "someone is on your tiny's page right now."
 *
 *   POST /visit { name, visitorId? }  (internal-key, proxied by the app)
 *
 * Deliberately NOT wired into /get (that fires for OG images, vCards and
 * every chat message — pure noise). The app's chat page beacons once per
 * real browser pageview. We resolve the owner from tiny-v2, skip
 * owner-viewing-their-own-tiny, emit a tiny_visit event, and push —
 * throttled via KV so at most one push per tiny per window.
 */
import { OpenAPIRoute, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { emitEvent } from "./events";
import { sendPushToUser } from "./push";
import { recordSocialEdge, userNodeId, tinyNodeId } from "./graph";

const PUSH_THROTTLE_SECONDS = 5 * 60;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export class VisitCall extends OpenAPIRoute {
  static schema = {
    tags: ["Visit"],
    summary: "Internal: record a live visit to a tiny; notify the owner (throttled).",
    requestBody: {
      name: new Str({ required: true, description: "Tiny slug being visited." }),
      visitorId: new Str({ required: false, description: "Logged-in visitor's user id (to skip self-visits)." }),
      visitorLogin: new Str({ required: false, description: "Logged-in visitor's GitHub login (for the notification text)." }),
    },
    responses: { "200": { description: "Recorded", schema: { response: "Recorded" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { name, visitorId } = data.body;
    const slug = String(name || '').toLowerCase().trim();
    if (!slug) return json({ error: "name required" }, 400);

    // visitorLogin lands in the push URL (/@login) opened by the SW's
    // notificationclick — only accept a real GitHub login shape so a
    // malformed value can't craft an odd same-origin path. Anything else
    // → treated as an anonymous visit.
    const rawLogin = String(data.body.visitorLogin || '');
    const visitorLogin = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(rawLogin) ? rawLogin : '';

    let owner: string | null = null;
    try {
      const row = await env.DB.prepare("SELECT user_id FROM tinys WHERE name = ?").bind(slug).first();
      owner = row?.user_id || null;
    } catch (err) {
      // Don't swallow a D1 read error as "unclaimed tiny" — that shape (200,
      // notified:false) is indistinguishable from a real legacy tiny, so a
      // transient blip silently drops every owner's visit notification with no
      // signal. Fail honestly; the app's beacon is fire-and-forget and ignores
      // the body, but the error is now visible instead of masked.
      console.log(err, 'visit owner lookup');
      return json({ error: "visit lookup failed" }, 500);
    }
    if (!owner) return json({ ok: true, notified: false }); // unclaimed/legacy tiny

    // Own visits are not news
    if (visitorId && String(visitorId) === owner) return json({ ok: true, notified: false, self: true });

    const who = visitorLogin ? `@${visitorLogin}` : 'Someone';
    await emitEvent(env, owner, 'tiny_visit', `${who} visited /${slug}`);

    // 🕸️ Social graph: visited edge (known visitors only — anonymous visits
    // are events, not graph signal). The event was always thrown away;
    // now it's an edge (idea.md stage 6: "the social layer already exists").
    if (visitorId && visitorLogin) {
      await recordSocialEdge(env, {
        rel: 'visited',
        srcId: userNodeId(String(visitorId)), srcKind: 'person', srcLabel: `@${visitorLogin}`,
        dstId: tinyNodeId(slug), dstKind: 'tiny', dstLabel: `/${slug}`,
      });
    }

    // Throttle pushes per tiny — events capture every visit; pushes don't
    const throttleKey = `visit:push:${slug}`;
    const throttled = await env.stats.get(throttleKey);
    if (throttled) return json({ ok: true, notified: false, throttled: true });
    await env.stats.put(throttleKey, '1', { expirationTtl: PUSH_THROTTLE_SECONDS });

    // Known visitor → tapping the notification opens THEIR profile page
    // (/@login); anonymous → opens the visited tiny.
    const result = await sendPushToUser(env, owner, {
      title: `👀 ${who} is on /${slug}`,
      body: visitorLogin
        ? `${who} just opened your tiny — tap to see their profile.`
        : `A visitor just opened your tiny. More visits within 5 minutes won't re-ping.`,
      url: visitorLogin ? `/@${visitorLogin}` : `/${slug}`,
      tag: `tiny-visit-${slug}`,
    });
    return json({ ok: true, notified: result.sent > 0, ...result });
  }
}
