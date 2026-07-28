import { OpenAPIRoute, Query } from "@cloudflare/itty-router-openapi";


const OpenAI = require("openai");

// openai client created per-request with env.OPENAI_API_KEY

/**
 * The private-memory read, as a function of how many vector ids came back.
 *
 * Exported so a test can run the REAL statement against sqlite instead of
 * asserting a string. The `user_id` predicate is not defence in depth — it is
 * the only owner check on this read, because the vector filter it follows keys
 * on the tiny's SLUG and slugs are recyclable. See the call site.
 *
 * Params bind positionally: the `n` vector ids first, then the owner's user id.
 */
export function notesReadSql(n: number): string {
  const placeholders = Array.from({ length: n }, () => "?").join(", ");
  return `SELECT * FROM notes WHERE id IN (${placeholders}) AND user_id = ?`;
}

export class RetrieveCall extends OpenAPIRoute {
    static schema = {
        tags: ["Retrieve tiny"],
        summary: "Use this endpoint to query the AI-powered service using tiny.technology.",
        parameters: {
            text: Query(String, {
                description: "input text",
                required: true,
            }),
        },
        responses: {
            "200": {
                description: "Successful response",
                schema: {
                    response: 'Welcome',
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
        try {
            // console.log('data:', JSON.stringify(data));
            // console.log('request.url:', request.url);
            // console.log(request.headers.get('Authorization'), 'AUTH')

            // Retrieve tinyName and tinyKey from the Authorization header
            // To use further in the code to retrieve details from another vector db.
            const authHeader = request?.headers?.get('Authorization') || '';
            const authParts = authHeader.split(' ');
            const credentials = authParts[1] || '';
            // Names are slugs (no colons); split only on the first colon so
            // keys containing ':' survive
            const sep = credentials.indexOf(':');
            const tinyName = sep === -1 ? credentials : credentials.slice(0, sep);
            const tinyKey = sep === -1 ? '' : credentials.slice(sep + 1);

            // Session ownership (internal key + userId) — new-platform tinys
            // have no legacy key, so this is their only path to private memory
            const { checkInternalKey } = await import("./users");
            const internalOk = checkInternalKey(request, env);
            const claimedUserId = internalOk
                ? (new URL(request.url).searchParams.get('userId') || '')
                : '';

            // Extract text from query parameter if not in data
            const text = data.text || data.query?.text || new URL(request.url).searchParams.get('text') || '';
            
            if (!text) {
                return new Response(JSON.stringify({ error: 'text parameter is required' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Cost guard: this public route burns a paid embeddings call per
            // request. The app's server-side callers carry the internal key
            // and skip the cap; keyless (external) callers get a generous
            // per-IP daily budget so an unauthenticated loop can't run up
            // the OpenAI bill. KV failure fails open (house rule).
            if (!internalOk) {
                try {
                    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
                    const day = new Date().toISOString().slice(0, 10);
                    const rlKey = `retrieve_rl:${ip}:${day}`;
                    const used = Number(await env.stats.get(rlKey)) || 0;
                    if (used >= 500) {
                        return new Response(JSON.stringify({ error: 'daily retrieve limit reached — try again tomorrow' }), {
                            status: 429,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                    await env.stats.put(rlKey, String(used + 1), { expirationTtl: 172800 });
                } catch { /* fail open */ }
            }

            const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
            const embedding = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: text,
                encoding_format: "float",
            });
            const vectors = embedding.data[0].embedding

            let notes: any = [];
            // Whether the private-memory branch actually served — credentials
            // alone must not swallow the request: a PUBLIC tiny queried with
            // its own valid key used to fall into this branch, fail the
            // db.private check, and return [] (the universe search below was
            // in an unreachable `else`).
            let servedPrivate = false;

            // Private-memory path: legacy key match OR session ownership
            if (tinyName && (tinyKey || claimedUserId)) {
                const db = await env.tiny.get(tinyName, { type: "json" });
                // Resolve the tiny's CURRENT owner once, unconditionally, and keep
                // it SEPARATE from `authorized`. The two answer different questions
                // and conflating them was a cross-tenant leak:
                //
                //   authorized   → "may this caller talk to this tiny?"   (now)
                //   ownerUserId  → "whose rows may be read back to them?" (then)
                //
                // A slug is a LEASE, not an identity. `delete.ts` frees the name and
                // `upsert.ts`'s ON CONFLICT(name) DO NOTHING lets anyone claim it, so
                // ownership of a NAME is not ownership of the DATA written under it.
                // Every link below was individually correct and the chain still leaked:
                // turns.ts indexes each note with metadata { name } (the SLUG), the
                // query filters on that slug, and the SELECT joined on vector id ALONE
                // — so B claiming A's deleted slug, marking it private and sending one
                // message got A's private transcripts served back as `Memory:` context.
                let ownerUserId = '';
                if (db) {
                    try {
                        const row = await env.DB.prepare("SELECT user_id FROM tinys WHERE name = ?").bind(tinyName).first();
                        ownerUserId = row?.user_id ? String(row.user_id) : '';
                    } catch (err) { console.log(err, 'owner lookup in retrieve'); }
                }
                let authorized = !!db && !!db.key && db.key === tinyKey;
                if (!authorized && db && claimedUserId) {
                    authorized = !!ownerUserId && ownerUserId === claimedUserId;
                }
                if (db && authorized && db.private) {
                    // Retrieve more notes from the MEMORY vector db and return them.
                    // console.log('retrieve more notes from memory', tinyName, tinyKey, 'tinyName, tinyKey');
                    const SIMILARITY_CUTOFF = 0.35;
                    const vectorQuery = await env.MEMORY.query(vectors, { topK: 5, filter: { name: tinyName } });
                    // console.log(vectorQuery, 'MEMORY')
                    const vecIds = vectorQuery.matches
                        .filter((vec: any) => {
                            // console.log(vec, 'VEC')
                            return vec.score > SIMILARITY_CUTOFF
                        })
                        .map((vec: any) => vec.id ?? vec.vectorId);

                    let _notes = []
                    // ⚠️ `AND user_id = ?` IS THE AUTHORIZATION. The vector filter is
                    // { name } — a slug — and slugs are recyclable, so the id set the
                    // index hands back can legitimately contain rows written by a
                    // PREVIOUS holder of this name. `notes` is never deleted from
                    // except by the slug-scoped rolling prune, so its rows outlive the
                    // ownership that created them; a read authorized against "who owns
                    // this name NOW" is the wrong question for a row written by "who
                    // owned it THEN". The predicate answers the right one.
                    //
                    // An empty ownerUserId means no `tinys` row (legacy KV-only tiny).
                    // turns.ts can only write a note for a userId that owns a `tinys`
                    // row, so there is no note this caller could legitimately be
                    // served — skipping is correct, not degraded.
                    if (vecIds.length && ownerUserId) {
                        // Bind vector ids as parameters — never interpolate. The ids
                        // come from stored vectors and could be non-numeric/crafted;
                        // a raw IN(${...}) list is an injection sink into SELECT *.
                        const { results } = await env.DB.prepare(notesReadSql(vecIds.length)).bind(...vecIds, ownerUserId).all()
                        if (results) _notes = results.map((vec: any) => vec.text)
                    }

                    const contextMessage = _notes.length
                        ? `Memory:\n${_notes.map((note: any) => `- ${note}`).join("\n")}`
                        : ""

                    // console.log(contextMessage, 'contextMessage');

                    // add extra notes to the notes array
                    const payload = {
                        name: db.name,
                        systemPrompt: db.systemPrompt,
                        systemKnowledge: db.systemKnowledge,
                        data: db.data,
                        url: 'https://tiny.technology/' + db.name,
                        markdown: `[![${db.name}'s Image](https://tiny.technology/og/${db.name})](https://tiny.technology/${db.name})`,
                        schema: db.schema,
                        worker: db.worker,
                        memory: contextMessage,
                        vcard: `https://tiny.technology/vcard/${db.name}`,
                        skills: db.skills || [],
                    }
                    notes = [payload]
                    servedPrivate = true
                }
            }
            if (!servedPrivate) {
                const SIMILARITY_CUTOFF = 0.33;
                const vectorQuery = await env.VECTOR_INDEX.query(vectors, { topK: 9 });
                // console.log(vectorQuery, 'VECTOR_QUERY')
                const vecIds = vectorQuery.matches
                    .filter((vec: any) => vec.score > SIMILARITY_CUTOFF)
                    .map((vec: any) => vec.id ?? vec.vectorId);


                if (vecIds.length) {
                    // Fetch all notes in parallel using Promise.all
                    const tinyNotesPromises = vecIds.map((id: string) => env.tiny.get(id, { type: "json" }));
                    const tinyNotes = await Promise.all(tinyNotesPromises);

                    // console.log(tinyNotes, 'tinyNotes');

                    // Process each note and push to notes array.
                    // Private tinys must NEVER leak through universe search —
                    // the vector index may still hold their embeddings.
                    tinyNotes.forEach(tiny => {
                        if (tiny && !tiny.private) {
                            notes.push({
                                name: tiny.name,
                                systemPrompt: tiny.systemPrompt,
                                systemKnowledge: tiny.systemKnowledge,
                                data: tiny.data,
                                url: 'https://tiny.technology/' + tiny.name,
                                markdown: `[![${tiny.name}'s Image](https://tiny.technology/og/${tiny.name})](https://tiny.technology/${tiny.name})`,
                                schema: tiny.schema,
                                worker: tiny.worker,
                                skills: tiny.skills || [],
                            });
                        }
                    });
                }
            }

            return notes;
        } catch (error: any) {
            console.error('Error in retrieve handler:', error);
            // No stack traces to public callers
            return new Response(JSON.stringify({ error: 'Internal error' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
}
