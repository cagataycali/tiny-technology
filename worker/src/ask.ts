/**
 * 🗣️ Device ask (reTerminal Sticky — the e-ink tiny).
 *
 *   POST /device/ask   { deviceId, token, text? , audioUrl? }
 *                      → { ok, text, card? }
 *
 * The wall device asks its owner's tiny a question and gets back a short
 * answer PLUS an optional render_ui card spec (the Sticky's four-template
 * protocol: text/list/kv/chart + buttons). Auth is the device-API split used
 * by /device/event and /transcript: the WRITE authenticates by device token
 * (DEVICE_EVENT_AUTH_SQL resolves the OWNER — the caller is a wall tablet
 * with nobody logged in), and the route itself is internal-key gated because
 * every call arrives via the app proxy (/api/devices/ask).
 *
 * Two input shapes:
 *   - {text}      — the device (or its phone) already has words
 *   - {audioUrl}  — a WAV/M4A the device uploaded via /media/upload; we
 *                   transcribe it here (gpt-4o-mini-transcribe, the same
 *                   model voice.ts pins for realtime input transcription)
 *                   because an ESP32-S3 has no on-device STT.
 *
 * The agent turn REUSES the scheduled-job machinery verbatim: we call the
 * app's /api/job-run (scheduler.ts pattern — same header, same body shape,
 * same 60s patience) so the answer runs with the owner's full capability
 * set. The card channel rides inside the prompt: the model may end its
 * answer with a fenced ```card {json}``` block, which we lift out of the
 * prose and hand back structurally. A malformed card degrades to text-only —
 * the device always has something to render.
 */
import { OpenAPIRoute, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
import { hashDeviceToken, DEVICE_EVENT_AUTH_SQL } from "./devices";
import { emitEvent } from "./events";
import { recordSocialEdge, userNodeId, tinyNodeId } from "./graph";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Question length clamp — a wall device asks questions, not essays. */
export const ASK_TEXT_MAX = 4000;
/** Audio fetch budget: 90s of 16kHz mono WAV is ~2.8MB; 8MB is generous. */
export const ASK_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
export const ASK_AUDIO_URL_MAX = 300;
/** The answer the device renders — mirrors job-run's own 2000-char clamp. */
export const ASK_ANSWER_MAX = 2000;
/** Card JSON size clamp — an 800×480 e-ink card is small by construction. */
export const ASK_CARD_MAX = 4 * 1024;

/** Card types the Sticky can natively render (ARCHITECTURE.md card spec v1). */
export const CARD_TYPES = ["text", "list", "kv", "chart", "image", "buttons", "composite"] as const;

/** The card-channel instruction appended to every device ask. Kept short —
 *  it rides inside the job prompt, and job-run already carries the tiny's
 *  full persona. */
export const CARD_PROMPT = [
  "You are answering a question asked from a small e-ink wall display (800x480, grayscale).",
  "Answer briefly (1-3 sentences; it is read on a wall at a glance).",
  "Optionally, AFTER your prose answer, emit ONE fenced code block tagged `card` containing JSON for the display:",
  '```card',
  '{"type":"text|list|kv|chart","title":"...","body":"...","items":["..."],"rows":{"k":"v"},"data":[1,2,3]}',
  '```',
  "Use a card only when structure helps (lists, key-values, numbers). No markdown inside card fields.",
].join("\n");

/**
 * Lift a ```card fenced block out of the agent's prose. Returns the cleaned
 * text and the parsed card (or null). Exported for the vitest battery: the
 * parser is the only clever part of this file and MUST degrade to text-only
 * on anything malformed — the device renders whatever comes back.
 */
export function extractCard(raw: string): { text: string; card: any | null } {
  const text = String(raw ?? "");
  const m = text.match(/```card\s*\n([\s\S]*?)```/);
  if (!m) return { text: text.trim(), card: null };
  const cleaned = (text.slice(0, m.index) + text.slice((m.index ?? 0) + m[0].length)).trim();
  if (m[1].length > ASK_CARD_MAX) return { text: cleaned, card: null };
  try {
    const card = JSON.parse(m[1]);
    if (!card || typeof card !== "object" || Array.isArray(card)) return { text: cleaned, card: null };
    if (!CARD_TYPES.includes(String(card.type) as any)) return { text: cleaned, card: null };
    return { text: cleaned, card };
  } catch {
    return { text: cleaned, card: null };
  }
}

/** Transcribe a hosted audio URL with the worker's own OpenAI key.
 *  Exported so the route handler stays a straight line. */
export async function transcribeAudioUrl(env: any, audioUrl: string): Promise<{ text?: string; error?: string }> {
  let url: URL;
  try { url = new URL(audioUrl); } catch { return { error: "bad audioUrl" }; }
  if (url.protocol !== "https:") return { error: "audioUrl must be https" };

  // Our own /media/<key> URLs must be read from R2 directly: a Cloudflare
  // Worker cannot fetch its own hostname (the subrequest loops back and is
  // refused), which surfaced as "audio fetch failed" on every device voice
  // ask (Sticky M5, 2026-08-25). Same-host is detected by path shape + a
  // successful R2 head, so custom domains and *.workers.dev both work.
  let buf: ArrayBuffer | null = null;
  let contentType = "audio/wav";
  const keyMatch = url.pathname.match(/^\/media\/([0-9a-f-]{36}\.[a-z0-9]{2,4})$/);
  if (keyMatch && env.MEDIA) {
    const obj = await env.MEDIA.get(keyMatch[1]).catch(() => null);
    if (obj) {
      buf = await obj.arrayBuffer();
      contentType = obj.httpMetadata?.contentType || contentType;
    }
  }
  if (!buf) {
    const audioRes = await fetch(url.toString()).catch(() => null);
    if (!audioRes || !audioRes.ok) return { error: "audio fetch failed" };
    buf = await audioRes.arrayBuffer();
    contentType = audioRes.headers.get("content-type") || contentType;
  }
  if (buf.byteLength === 0) return { error: "audio empty" };
  if (buf.byteLength > ASK_AUDIO_MAX_BYTES) return { error: "audio too large" };

  const name = url.pathname.split("/").pop() || "audio.wav";
  const form = new FormData();
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("file", new File([buf], name, {
    type: contentType,
  }));

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  }).catch(() => null);
  if (!res || !res.ok) return { error: `transcription failed (${res ? res.status : "network"})` };
  const data: any = await res.json().catch(() => ({}));
  const text = String(data.text || "").trim();
  if (!text) return { error: "nothing transcribed" };
  return { text };
}

/** SSE framing for the device typer (STREAMING_UI.md, M-S3).
 *
 * Phase A honesty note: /api/job-run is a buffered agent turn, so the deltas
 * here are WORD-BATCHED from the finished answer — which on an e-ink panel
 * is not a simulation: the glass physically refreshes at <=2Hz, so this is
 * exactly the rate it can display. What the stream DOES buy today:
 *   1. the caret goes up the moment the question lands (keepalive comments
 *      flow while job-run thinks — no more 75s of blank glass), and
 *   2. the wire shape is final: when job-run learns to stream real model
 *      deltas (phase B), only the source of `t` events changes.
 */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

export function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Split an answer into typer-cadence batches (~4 words each). Whitespace is
 *  preserved on the trailing side so concatenation reproduces the original. */
export function wordBatches(text: string, wordsPer = 4): string[] {
  const parts = text.match(/\S+\s*/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += wordsPer) {
    out.push(parts.slice(i, i + wordsPer).join(""));
  }
  return out;
}

/** Raw `tiny` field clamp — the longest real slug is 15 chars (upsert's
 *  pattern); 64 tolerates decorated input without accepting essays. */
export const ASK_TINY_SLUG_RAW_MAX = 64;
/** ONE sentence for private and unknown alike — the device rail must never
 *  be an oracle about whether a private tiny exists (same no-oracle rule as
 *  the wrong-token 401 above). */
export const ASK_TINY_NOT_FOUND = "No public tiny by that name — check the slug and try again.";

export type AskTarget =
  | { mode: "owner"; slug: string }
  | { mode: "universe"; slug: string; ownerId: string | null }
  | { mode: "error"; status: number; error: string };

/**
 * Resolve the optional `tiny` field of a device ask ("THE UNIVERSE ON THE
 * GLASS", ANSWERS.md 2026-08-26).
 *
 *   absent / "tiny"            → owner mode (today's pipeline, byte-identical)
 *   a slug the owner owns      → owner mode with that persona (their own
 *                                private tiny is theirs to ask, same as a job)
 *   a PUBLIC universe slug     → universe mode: the turn runs as that tiny,
 *                                WITHOUT the owner's userId — a foreign
 *                                persona must never wield the owner's
 *                                capability set (tools, memory, devices).
 *   private / unknown          → 404, one sentence, no oracle
 *   priced                     → 402 with a sentence: a wall device has no
 *                                payment-confirm surface, so paid consults
 *                                stay on the app/web rails (deviation filed
 *                                in ANSWERS.md — deliberate, not a gap)
 *
 * KV is read directly (get.ts's strict-then-loose slug dance) because a
 * Worker cannot fetch its own hostname — the same loop-back rule that moved
 * audio reads to R2 (transcribeAudioUrl above).
 */
export async function resolveAskTarget(env: any, rawTiny: unknown, deviceOwnerId: string): Promise<AskTarget> {
  const raw = String(rawTiny ?? "").trim();
  if (!raw) return { mode: "owner", slug: "tiny" };
  if (raw.length > ASK_TINY_SLUG_RAW_MAX) return { mode: "error", status: 400, error: "tiny name too long" };
  const slugify = (await import("slugify")).default;
  let slug = slugify(raw, { lower: true, strict: true });
  if (!slug) return { mode: "error", status: 404, error: ASK_TINY_NOT_FOUND };
  if (slug === "tiny") return { mode: "owner", slug: "tiny" };

  let db: any = await env.tiny.get(slug, { type: "json" }).catch(() => null);
  if (!db) {
    const loose = slugify(raw, { lower: true });
    if (loose && loose !== slug) {
      const legacy = await env.tiny.get(loose, { type: "json" }).catch(() => null);
      if (legacy) { db = legacy; slug = loose; }
    }
  }
  if (!db) return { mode: "error", status: 404, error: ASK_TINY_NOT_FOUND };

  let targetOwner: string | null = null;
  try {
    const row = await env.DB.prepare("SELECT user_id FROM tinys WHERE name = ?").bind(slug).first();
    targetOwner = row?.user_id ? String(row.user_id) : null;
  } catch { /* legacy tiny without a D1 row — fine, ownership just can't match */ }

  if (targetOwner && targetOwner === deviceOwnerId) return { mode: "owner", slug };
  if (db.private) return { mode: "error", status: 404, error: ASK_TINY_NOT_FOUND };

  try {
    const price = await env.DB.prepare("SELECT price_micro FROM prices WHERE resource = ? AND active = 1")
      .bind(`tiny:${slug}`).first();
    if (price && Number(price.price_micro) > 0) {
      return { mode: "error", status: 402, error: `/${slug} charges per consult — ask it from the tiny app, where payment can be confirmed.` };
    }
  } catch { /* no prices table (tests) → free */ }

  return { mode: "universe", slug, ownerId: targetOwner };
}

/** Universe-ask attribution, the visit.ts idiom: the device owner's ring gets
 *  the ask breadcrumb, the target tiny's owner gets a tiny_visit event, and
 *  the social graph gets a `visited` edge (person → tiny) — same rel ask_tiny
 *  visits ride on. Fire-and-forget by contract: the answer matters more. */
export async function attributeUniverseAsk(env: any, opts: {
  deviceOwnerId: string; deviceName: string; slug: string;
  targetOwnerId: string | null; question: string;
}): Promise<void> {
  const { deviceOwnerId, deviceName, slug, targetOwnerId, question } = opts;
  let login = "";
  try {
    const u = await env.DB.prepare("SELECT github_login FROM users WHERE id = ?").bind(deviceOwnerId).first();
    login = u?.github_login ? String(u.github_login) : "";
  } catch { /* label degrades to 'someone' */ }
  const who = login ? `@${login}` : "Someone";
  try {
    await emitEvent(env, deviceOwnerId, "device_ask", `${deviceName} → /${slug}: ${question.slice(0, 140)}`);
  } catch { /* breadcrumb only */ }
  if (targetOwnerId && targetOwnerId !== deviceOwnerId) {
    try {
      await emitEvent(env, targetOwnerId, "tiny_visit", `${who} asked /${slug} from a device`);
    } catch { /* breadcrumb only */ }
  }
  try {
    await recordSocialEdge(env, {
      rel: "visited",
      srcId: userNodeId(deviceOwnerId), srcKind: "person", srcLabel: who,
      dstId: tinyNodeId(slug), dstKind: "tiny", dstLabel: `/${slug}`,
    });
  } catch { /* graph is best-effort */ }
}

export class DeviceAskCall extends OpenAPIRoute {
  static schema = {
    tags: ["Devices"],
    summary: "Internal: a device asks its owner's tiny — or any PUBLIC tiny in the universe (device token in-body).",
    requestBody: {
      deviceId: new Str({ required: true }),
      token: new Str({ required: true }),
      text: new Str({ required: false, description: `The question (≤${ASK_TEXT_MAX}, clamped).` }),
      audioUrl: new Str({ required: false, description: "Hosted https:// audio from /media/upload — transcribed server-side." }),
      tiny: new Str({ required: false, description: "Optional target tiny slug. Absent/owner's own → owner pipeline (unchanged). A PUBLIC universe slug → the turn runs as that tiny. Private/unknown → 404, one sentence." }),
      stream: new Str({ required: false, description: 'When "1": reply is text/event-stream — data:{"t":delta}… data:{"card":{…}}? data:[DONE]. (STREAMING_UI.md)' }),
    },
    responses: { "200": { description: "Answered", schema: { response: "Answered" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { deviceId, token } = data.body;
    let { text, audioUrl } = data.body;
    const wantStream = String(data.body.stream ?? "") === "1";
    if (!deviceId || !token) return json({ error: "deviceId and token required" }, 400);
    text = String(text ?? "").trim();
    audioUrl = String(audioUrl ?? "").trim();
    if (!text && !audioUrl) return json({ error: "text or audioUrl required" }, 400);
    if (audioUrl.length > ASK_AUDIO_URL_MAX) return json({ error: "audioUrl too long" }, 400);

    // Same no-oracle auth as /device/event: wrong token == revoked == unknown.
    const row = await env.DB.prepare(DEVICE_EVENT_AUTH_SQL)
      .bind(String(deviceId), await hashDeviceToken(String(token))).first();
    if (!row?.user_id) return json({ error: "unknown device" }, 401);
    const userId = String(row.user_id);
    const deviceName = String(row.name || "device").slice(0, 40);

    // Audio in, words out — BEFORE the agent turn burns its budget.
    if (!text && audioUrl) {
      const t = await transcribeAudioUrl(env, audioUrl);
      if (t.error) return json({ ok: false, error: t.error }, 422);
      text = t.text!;
    }
    text = text.slice(0, ASK_TEXT_MAX);

    // Universe switch ("THE UNIVERSE ON THE GLASS"): resolve the optional
    // target BEFORE any stream headers commit — refusals are plain JSON with
    // real status codes on both arms, same as the input validations above.
    const target = await resolveAskTarget(env, data.body.tiny, userId);
    if (target.mode === "error") return json({ ok: false, error: target.error }, target.status);
    const universe = target.mode === "universe" ? target : null;

    // The scheduled-job pipeline, reused verbatim (scheduler.ts shape):
    // owner mode = owner-scoped agent turn with the owner's full capability
    // set (tiny slug 'tiny' = the owner's default persona, same as an
    // untargeted job). Universe mode = the SAME pipeline WITHOUT userId:
    // job-run's /get then resolves the public persona (identity, knowledge,
    // skills) and none of the owner's tools/memory ride along.
    const prompt = `${CARD_PROMPT}\n\nQuestion from the device "${deviceName}":\n${text}`;
    const jobPayload = universe
      ? JSON.stringify({ tiny: universe.slug, prompt })
      : JSON.stringify({ userId, tiny: target.slug, prompt });

    // ── SSE arm (STREAMING_UI.md M-S3) ──────────────────────────────────
    // The device asked for the typer: hold the socket, comment-keepalive
    // while the agent thinks, then drip word batches + optional card + DONE.
    // Errors ride INSIDE the stream (data:{"error"}) — the 200 was already
    // committed when the headers went out, and the firmware renders the
    // error line honestly (tiny_node ask_sse_line).
    if (wantStream) {
      const q = text; // capture for the closure
      const streamBody = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (s: string) => controller.enqueue(enc.encode(s));
          // Caret goes up NOW: the firmware opened its stream card on the
          // 200 + event-stream header; keepalives below keep its 30s read
          // watchdog fed while job-run holds the model for up to 75s.
          const keepalive = setInterval(() => {
            try { send(": thinking\n\n"); } catch { /* closed */ }
          }, 10_000);
          try {
            const res = await fetch("https://tiny.technology/api/job-run", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Internal-Key": env.INTERNAL_API_KEY || "",
              },
              body: jobPayload,
              signal: AbortSignal.timeout(75_000),
            });
            const out: any = await res.json().catch(() => ({}));
            clearInterval(keepalive);
            if (!res.ok || !out.ok) {
              send(sseData({ error: String(out.error || "agent turn failed").slice(0, 300) }));
              send("data: [DONE]\n\n");
              controller.close();
              return;
            }
            const { text: answer, card } = extractCard(String(out.result || ""));
            const clipped = answer.slice(0, ASK_ANSWER_MAX) || "(no answer)";
            // Word batches at the panel's own cadence. No artificial sleep:
            // the firmware's commit floor (>=400ms) is the rate limiter, and
            // TCP backpressure paces the socket — a delay here would only
            // slow a future real-delta phase B down.
            for (const batch of wordBatches(clipped)) send(sseData({ t: batch }));
            if (card) send(sseData({ card }));
            send("data: [DONE]\n\n");
            try {
              if (universe) {
                await attributeUniverseAsk(env, {
                  deviceOwnerId: userId, deviceName, slug: universe.slug,
                  targetOwnerId: universe.ownerId, question: q,
                });
              } else {
                await emitEvent(env, userId, "device_ask", `${deviceName}: ${q.slice(0, 160)}`);
              }
            } catch { /* the answer matters more than the breadcrumb */ }
          } catch (err: any) {
            clearInterval(keepalive);
            send(sseData({ error: String(err?.message || err).slice(0, 300) }));
            send("data: [DONE]\n\n");
          }
          controller.close();
        },
      });
      return new Response(streamBody, { status: 200, headers: SSE_HEADERS });
    }

    let result = "";
    try {
      const res = await fetch("https://tiny.technology/api/job-run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": env.INTERNAL_API_KEY || "",
        },
        body: jobPayload,
        // 75s, not 60: the firmware holds its ask socket open for 80s
        // (tiny_node_do_ask http timeout), and a tool-using turn that reaches
        // another device (use_device invoke alone waits up to 45s) cannot fit
        // 60s. 75s keeps a 5s margin for transcription + card parse + reply.
        signal: AbortSignal.timeout(75_000),
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) return json({ ok: false, error: String(out.error || "agent turn failed").slice(0, 300) }, 424);
      result = String(out.result || "");
    } catch (err: any) {
      return json({ ok: false, error: String(err?.message || err).slice(0, 300) }, 424);
    }

    const { text: answer, card } = extractCard(result);

    // Activity ring: the ask is visible wherever the owner reads events —
    // same pattern as device/event, question preview + device attribution.
    // Universe asks additionally attribute the visit (target owner's ring +
    // the social graph), the way ask_tiny consults do.
    try {
      if (universe) {
        await attributeUniverseAsk(env, {
          deviceOwnerId: userId, deviceName, slug: universe.slug,
          targetOwnerId: universe.ownerId, question: text,
        });
      } else {
        await emitEvent(env, userId, "device_ask", `${deviceName}: ${text.slice(0, 160)}`);
      }
    } catch { /* the answer matters more than the breadcrumb */ }

    return json({
      ok: true,
      text: answer.slice(0, ASK_ANSWER_MAX) || "(no answer)",
      ...(card ? { card } : {}),
    });
  }
}
