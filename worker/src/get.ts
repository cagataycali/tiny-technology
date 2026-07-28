import { OpenAPIRoute, Query } from "@cloudflare/itty-router-openapi";
import slugify from "slugify";
import { checkInternalKey } from "./users";

// MCP privacy: headers (API keys/env) are owner secrets. Only our own app
// (internal key) gets the full config — public callers see names + urls only.
function redactMcp(mcp: any): any {
  if (!mcp || typeof mcp !== 'object') return undefined;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(mcp as Record<string, any>)) {
    if (!v || typeof v !== 'object') continue;
    out[k] = { url: (v as any).url, ...((v as any).headers ? { headers: '[REDACTED]' } : {}) };
  }
  return out;
}

export class GetCall extends OpenAPIRoute {
    static schema = {
        tags: ["get tiny"],
        summary: "Use this endpoint to query the AI-powered service using tiny.technology.",
        parameters: {
            name: Query(String, {
                description: "A short, unique name for the service. This will be used as an internal identifier and should not contain spaces.",
                default: "todomaster",
                required: true,
                pattern: "^[a-z0-9_-]{3,15}$"
            }),
            key: Query(String, { required: false, description: "The unique key provided at the time of service registration. This is required for authorization purposes to ensure only authorized users can modify the service." }),
        },
        responses: {
            "200": {
                description: "Successful response",
                schema: {
                    response: 'Welcome to tiny.technology!',
                    description: 'Description of the AI-powered service',
                    name: 'taskmaster',
                    systemPrompt: `⚡ "TaskMaster" ⚡
Do More, Forget Less!
Hello there! Get ready to be organized like never before with our smart To-Do List Application. Here, you can set goals, and we'll be there for you every step of the way until you achieve them. 🚀

Here's a quick tour of what you can do:

Add a Dash of Productivity ('add_task'): Got something on your mind? Quickly jot it down as a task with a specific name ('taskName'), decide its urgency level ('priority'), and set a deadline ('dueDate'). We'll keep a watchful eye so that deadlines never sneak up on you! 📝

Take a Peek at Your Tasks ('view_tasks'): Use the handy 'File' parameter to glance through your tasks sorted by priority, due date, or status. Whether they're completed, ongoing, or upcoming, we've got them neatly organized for you. 👀

Change of Plans? No Problem ('update_task'): Life happens, plans change. With the 'taskID' and 'updates', tweak task details, alter its status, or reschedule it at your convenience. 🔄

Say Goodbye to Old Tasks ('remove_task'): Out with the old, in with the new! Using the 'taskID', sweep away tasks that have served their purpose and clear the path for exciting new ones. 🧹

Ready to jump in? Just type your command or pick from the menu.

Stuck at any point? Type 'Help', and we'll be right there to assist you.

Remember, every checkmark on your list is a step forward on your journey. Let's march on to achievement! 🌟`
                },
            },
        },
    };

    async handle(
        request: Request,
        env: any,
        _ctx: any,
        data: Record<string, any>
    ) {
        // Check if name exists and is valid
        let name = data.name || data.query?.name || new URL(request.url).searchParams.get('name') || '';
        const key = data.key || data.query?.key || new URL(request.url).searchParams.get('key') || '';

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return {
                response: "Name parameter is required and cannot be empty!",
            }
        }
        
        // Stored keys are a mix: new tinys use upsert's strict slug ("my!tiny"
        // → "mytiny"), but pre-strict legacy tinys were stored loosely
        // ("hello_world"). Try strict first (also resolves manually-typed
        // non-canonical names), fall back to loose so legacy tinys still load.
        const rawName = name;
        name = slugify(rawName, { lower: true, strict: true });
        // A name that slugifies to nothing (CJK, emoji, punctuation-only) would
        // otherwise hit env.tiny.get("") — KV rejects an empty key and throws,
        // surfacing as a 500. No such tiny can exist, so short-circuit.
        if (!name) {
            return { response: "tiny.technology is not exists" };
        }
        let db = await env.tiny.get(name, { type: "json" });
        if (!db) {
            const loose = slugify(rawName, { lower: true });
            if (loose !== name) {
                const legacy = await env.tiny.get(loose, { type: "json" });
                if (legacy) { db = legacy; name = loose; }
            }
        }

        // HSTP already exists
        if (!db) {
            return {
                response: "tiny.technology is not exists",
            }
        }

        let isAuthorized = false;
        // Legacy key match (old records only — new tinys have no key)
        if (db.key && key === db.key) {
            isAuthorized = true;
        }

        const internalOk = checkInternalKey(request, env);

        // Session ownership: our app passes the logged-in userId (internal
        // key guarded) — the tiny-v2 owner is always authorized.
        const claimedUserId = internalOk
            ? (data.userId || data.query?.userId || new URL(request.url).searchParams.get('userId') || '')
            : '';
        if (claimedUserId) {
            try {
                const row = await env.DB.prepare("SELECT user_id FROM tinys WHERE name = ?").bind(name).first();
                if (row && row.user_id === claimedUserId) isAuthorized = true;
            } catch (err) { console.log(err, 'owner lookup in get'); }
        }

        const mcpOut = internalOk ? db.mcpServers : redactMcp(db.mcpServers);

        // Check is the AI is private
        if (db.private && !isAuthorized) {
            return {
                aiCount: 0,
                stats: {
                    today: 0,
                    viewCount: 0,
                    allMessageCount: 0,
                    tinyMessageCount: 0,
                    todayMessageCount: 0,
                },
                response: db.name,
                name: db.name,
                data: '',
                hook: '',
                isAuthorized: isAuthorized,
                private: true,
                systemPrompt: '',
                systemKnowledge: '',
                // Branding is cosmetic, not secret — the lock hero stays branded
                hero: db.hero || '',
                theme: db.theme || undefined,
                logo: db.logo || '',
                intro_vibe: db.intro_vibe || '',
                chips: Array.isArray(db.chips) ? db.chips : [],
                tagline: db.tagline || '',
                voice: db.voice || '',
                active: db.active === undefined ? true : db.active,
                worker: '',
                schema: {},
                skills: [],
                // TODO: @cagatay vcard should be priv.
                vcard: `https://tiny.technology/vcard/${db.name}`,
                qr: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(`https://tiny.technology/${db.name}`)}`
            };
        }

        let aiCount = 0;
        let viewCount = 0;
        let allMessageCount = 0;
        let tinyMessageCount = 0;
        let todayMessageCount = 0;
        const today = new Date()
        const dateString = today.toISOString().split('T')[0]

        // Message counting: the chat route calls /get with &msg=1 (+ internal
        // key) once per user turn. The old counter lived in a queue consumer
        // fed by the removed /log endpoint (worker a2348e8), so tiny:message*
        // had readers but NO writer — totalMessages/allMessageCount were stuck
        // at 0 since 2026-07-19. Piggy-back the increment on this existing
        // per-turn round-trip (no new request, off the hot streaming path).
        // Internal-key gated so public /get callers can't inflate the counter.
        const countMessage = internalOk &&
            (data.msg === '1' || data.query?.msg === '1' || new URL(request.url).searchParams.get('msg') === '1');

        try {
            // Stats for tiny
            const prefix = `tiny:view:${db.name}`;
            viewCount = Number(await env.stats.get(prefix) || 0);

            if (!viewCount) {
                await env.stats.put(prefix, 1);
            } else {
                await env.stats.put(prefix, Number(viewCount) + 1);
            }
            // Live platform count (tiny-v2), not the all-time creations counter
            try {
                const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM tinys WHERE active = 1").first();
                aiCount = Number(row?.c || 0);
            } catch { aiCount = 0; }
            allMessageCount = Number(await env.stats.get('tiny:message')) || 0;
            tinyMessageCount = Number(await env.stats.get(`tiny:message:${db.name}`) || 0) || 0;
            todayMessageCount = Number(await env.stats.get(`tiny:message:${db.name}:${dateString}`) || 0) || 0;

            if (countMessage) {
                // KV coerces numbers at runtime (verified live) — same as the
                // viewCount puts above. Increment all-time + per-tiny + per-day.
                await env.stats.put('tiny:message', allMessageCount + 1);
                await env.stats.put(`tiny:message:${db.name}`, tinyMessageCount + 1);
                await env.stats.put(`tiny:message:${db.name}:${dateString}`, todayMessageCount + 1);
                allMessageCount += 1; tinyMessageCount += 1; todayMessageCount += 1;
            }
        } catch (err) {
            console.log(err);
        }

        // Owner-only fields: the webhook URL often embeds secret tokens.
        // Visible only to the owner (key/session) or our own app (internal key).
        const canSeeSecrets = isAuthorized || internalOk;

        return {
            aiCount: aiCount,
            stats: {
                today: dateString,
                viewCount: viewCount,
                allMessageCount: allMessageCount,
                tinyMessageCount: tinyMessageCount,
                todayMessageCount: todayMessageCount,
            },
            response: db.name,
            name: db.name,
            data: db.data,
            hook: canSeeSecrets ? db.hook : (db.hook ? '[configured]' : ''),
            private: db.private,
            systemPrompt: db.systemPrompt,
            systemKnowledge: db.systemKnowledge,
            isAuthorized: isAuthorized,
            active: db.active === undefined ? true : db.active,
            vcard: `https://tiny.technology/vcard/${db.name}`,
            qr: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(`https://tiny.technology/${db.name}`)}`,
            worker: db.worker,
            schema: db.schema,
            skills: db.skills,
            hero: db.hero || '',
            theme: db.theme || undefined,
            logo: db.logo || '',
            intro_vibe: db.intro_vibe || '',
            chips: Array.isArray(db.chips) ? db.chips : [],
            tagline: db.tagline || '',
            voice: db.voice || '',
            ...(mcpOut ? { mcpServers: mcpOut } : {}),
        };
    }
}
