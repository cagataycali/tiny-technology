/**
 * Voice sessions — real speech-to-speech for tiny (docs/voice-sessions-design.md).
 *
 * `VoiceSession` is a Durable Object: one instance per live call. It is the
 * server-in-the-middle that makes the durable record possible — it relays the
 * client's mic PCM ⇄ OpenAI's Realtime WebSocket AND journals every byte both
 * ways to R2 (audio segments + events.jsonl) with a D1 index row, so a call
 * can be re-watched later with the transcript and the agent's reasoning in
 * sync.
 *
 *   phone/web  ──WS(PCM)──▶  VoiceSession (DO)  ──WS──▶  OpenAI gpt-realtime
 *              ◀──audio───                       ◀──────
 *                              journals → R2 + D1
 *
 * Transport is WebSocket (not client↔OpenAI WebRTC) precisely so the DO sees
 * every frame. Clients stay dumb: PCM16 24 kHz binary frames up, PCM16 audio
 * binary frames down, JSON control/transcript frames for everything else.
 *
 * Routing (worker routes in index.ts forward here by idFromName(sessionId)):
 *   POST /init     — internal-key; app creates the session, hands us the tiny's
 *                    prompt/voice + the user's OpenAI key (BYO-key only for v1).
 *                    We write the D1 row and mint a single-use connect ticket.
 *   GET  /connect  — client WS upgrade; validates the ticket, dials OpenAI,
 *                    relays + journals until either side closes.
 *
 * The OpenAI key lives ONLY in DO storage for the session's lifetime and is
 * deleted at teardown — it is never written to D1 or R2.
 */

import { OpenAPIRoute, Query, Str } from "@cloudflare/itty-router-openapi";

// https, NOT wss: Workers' outbound-WebSocket idiom is fetch(https://…) with an
// Upgrade header — fetch() throws on a wss:// scheme, which killed EVERY call
// at the dial ("openai connect failed") no matter whose key was used.
const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime";
const DEFAULT_MODEL = "gpt-realtime-2.1-mini";
/** Flush an audio segment to R2 once a direction buffers ~this many bytes.
 *  PCM16 @ 24 kHz mono = 48000 B/s, so ~1.4 MB ≈ 30 s per segment. */
const SEGMENT_BYTES = 1_440_000;
/** Cap a single call so a stuck client can't journal unboundedly (OpenAI caps
 *  the realtime session at 60 min anyway). */
const MAX_SESSION_MS = 60 * 60 * 1000;
// Client-liveness reaper: mic frames flow CONTINUOUSLY on a live call, so a
// client silent this long is dead (app force-killed, network vanished) and
// its WS close never reached us. Reap instead of holding the OpenAI socket +
// BYO key until the hard cap.
const CLIENT_IDLE_MS = 2 * 60 * 1000;
const IDLE_CHECK_MS = 60 * 1000;
/** How long a minted-but-unconnected session may sit before it self-cleans.
 *  The BYO OpenAI key lives in DO storage from /init; if the client never
 *  dials /connect (mic denied, tab/app closed, network drop) the connect-time
 *  teardown never runs, so an init-time alarm is the ONLY thing that deletes
 *  the key. Generous enough that a slow start (permission prompt) still
 *  connects and overwrites this with the MAX_SESSION_MS cap. */
const TICKET_TTL_MS = 5 * 60 * 1000;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function checkInternalKey(request: Request, env: any): boolean {
  const key = request.headers.get("x-internal-key") || "";
  const expected = env.INTERNAL_API_KEY || "";
  if (!expected || key.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= key.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** base64 → Uint8Array (OpenAI sends/receives PCM as base64 in JSON). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Uint8Array → base64 (chunked so a large frame doesn't blow the arg stack). */
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

export const VOICE_INSERT_SQL = `
  INSERT INTO voice_sessions (id, user_id, tiny_name, voice, status, started_at)
  VALUES (?1, ?2, ?3, ?4, 'created', ?5)`;

export const VOICE_CONNECT_SQL = `
  UPDATE voice_sessions SET status = 'live', connected_at = ?2 WHERE id = ?1`;

export const VOICE_END_SQL = `
  UPDATE voice_sessions
  SET status = ?2, ended_at = ?3, duration_ms = ?4, segment_count = ?5,
      event_count = ?6, input_tokens = ?7, output_tokens = ?8, error = ?9
  WHERE id = ?1`;

export class VoiceSession {
  state: any;
  env: any;

  // Live relay state (in-memory for the connected lifetime).
  private client: WebSocket | null = null;
  private upstream: WebSocket | null = null;
  private startedMs = 0;
  /** Wall-clock of the last frame FROM the client — the liveness signal. */
  private lastClientMs = 0;
  private closed = false;
  private sid: string | null = null;

  // Journal buffers.
  /** Cumulative assistant bytes ever journaled — response_started events
   *  carry this offset so the recording stitcher (voiceRecording) can slice
   *  the out-stream per response and place each at its wall-clock ms. */
  private outTotal = 0;
  private inBuf: Uint8Array[] = [];
  private inBytes = 0;
  private inSeq = 0;
  private outBuf: Uint8Array[] = [];
  private outBytes = 0;
  private outSeq = 0;
  private events: string[] = [];
  private eventCount = 0;
  private inTokens = 0;
  private outTokens = 0;

  // Barge-in truncation tracking (WS transport = we truncate ourselves).
  private lastAssistantItemId: string | null = null;
  private assistantAudioMs = 0;
  // Inline-chat integration: pair each spoken/typed user turn with the
  // assistant's transcript and feed the SAME per-tiny turn memory chat feeds
  // (/turns validates owner+private itself; public tinys no-op there).
  private origin = "";      // worker public origin, forwarded by voiceConnect
  private tinyName = "";
  private userId = "";
  private userLast = "";
  private assistantBuf = "";
  // Whether a response is actually in flight. With semantic_vad the user's
  // FIRST word of every turn fires speech_started while NO response is active
  // — sending response.cancel then makes OpenAI emit a "no active response"
  // error, which we'd forward to the client as a spurious error banner. Gate
  // the cancel/truncate on this so it only fires for a genuine barge-in.
  private responseActive = false;
  // Between a barge-in and the next response.created, audio deltas belong to
  // the CANCELLED reply (our cancel races OpenAI's stream) — drop them so the
  // client's flushed queue doesn't replay a blip of the interrupted sentence.
  private suppressAudio = false;

  constructor(state: any, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/init")) return this.handleInit(request);
    if (url.pathname.endsWith("/connect")) return this.handleConnect(request);
    if (url.pathname.endsWith("/reap")) return this.handleReap(request);
    return json({ error: "not found" }, 404);
  }

  /** Internal: force-teardown a stuck session. Exists for two live cases:
   *  zombies created before the liveness reaper shipped, and pre-alarm-era
   *  'created' rows whose DO storage still holds a BYO key with no alarm
   *  armed to ever scrub it. teardown is idempotent (this.closed). */
  private async handleReap(request: Request): Promise<Response> {
    if (!checkInternalKey(request, this.env)) return json({ error: "unauthorized" }, 401);
    await this.teardown("ended");
    return json({ ok: true });
  }

  /** Internal: stash config + mint a single-use ticket + write the D1 row. */
  private async handleInit(request: Request): Promise<Response> {
    if (!checkInternalKey(request, this.env)) return json({ error: "unauthorized" }, 401);
    const body: any = await request.json().catch(() => null);
    if (!body?.id || !body?.userId || !body?.openaiKey) {
      return json({ error: "id, userId, openaiKey required" }, 400);
    }
    const ticket = crypto.randomUUID();
    const cfg = {
      id: String(body.id),
      userId: String(body.userId),
      tinyName: String(body.tinyName || ""),
      voice: String(body.voice || "marin"),
      instructions: String(body.instructions || ""),
      openaiKey: String(body.openaiKey),
      model: String(body.model || DEFAULT_MODEL),
      // The chat agent's tool roster (inline-chat design: the voice agent has
      // the same tools). [{type:"function", name, description, parameters}] —
      // built by the app route from the SAME modules chat mounts. Device/client
      // tools are executed by the phone/browser via the tool_call/tool_result
      // WS bridge; the DO only relays.
      tools: Array.isArray(body.tools) ? body.tools.slice(0, 64) : [],
      ticket,
      ticketUsed: false,
    };
    await this.state.storage.put("cfg", cfg);

    try {
      await this.env.DB.prepare(VOICE_INSERT_SQL)
        .bind(cfg.id, cfg.userId, cfg.tinyName, cfg.voice, Math.floor(Date.now() / 1000))
        .run();
    } catch (err) {
      console.log(err, "voice_sessions insert");
    }
    // Schedule a self-clean in case the client never connects — otherwise the
    // BYO OpenAI key just stored in `cfg` would linger in DO storage forever
    // (teardown only runs on WS close, which requires a connect that may never
    // happen). handleConnect resets this to the full session cap once live.
    try {
      this.state.storage.setAlarm?.(Date.now() + TICKET_TTL_MS);
    } catch { /* alarms optional; a live connect still tears down on close */ }
    return json({ ok: true, ticket });
  }

  /** Client WS upgrade → dial OpenAI → relay + journal. */
  private async handleConnect(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "expected websocket" }, 426);
    }
    const cfg: any = await this.state.storage.get("cfg");
    const ticket = new URL(request.url).searchParams.get("ticket") || "";
    if (!cfg || !ticket || ticket !== cfg.ticket || cfg.ticketUsed) {
      return json({ error: "invalid or used ticket" }, 403);
    }
    // Single-use: burn the ticket before we accept anything.
    cfg.ticketUsed = true;
    await this.state.storage.put("cfg", cfg);

    // Dial OpenAI first — if it fails, fail the upgrade cleanly.
    let upstream: WebSocket;
    try {
      // GA gpt-realtime: no OpenAI-Beta header. Authorization only.
      const upResp = await fetch(`${OPENAI_REALTIME_URL}?model=${encodeURIComponent(cfg.model)}`, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${cfg.openaiKey}`,
        },
      });
      if (!upResp.webSocket) {
        return json({ error: `openai upgrade failed (${upResp.status})` }, 502);
      }
      upstream = upResp.webSocket;
      upstream.accept();
      console.log("voice dial ok", upResp.status, "model", cfg.model, "keylen", (cfg.openaiKey || "").length);
    } catch (err: any) {
      console.log(err, "openai dial");
      // Surface the throw reason — native clients read this body out of the
      // failed upgrade and show it (a bare "connect failed" hid the wss-scheme
      // bug behind three clients' generic "call ended").
      return json({ error: `openai connect failed: ${String(err?.message || err)}` }, 502);
    }

    const pair = new WebSocketPair();
    const clientSide = pair[0];
    const serverSide = pair[1];
    serverSide.accept();

    this.client = serverSide;
    this.upstream = upstream;
    this.startedMs = Date.now();
    this.lastClientMs = Date.now();
    this.sid = cfg.id;
    // Inline-chat plumbing: who this call belongs to (for /turns) and the
    // worker's public origin (voiceConnect forwards it — the stub URL here is
    // the opaque https://do/).
    this.tinyName = cfg.tinyName || "";
    this.userId = cfg.userId || "";
    this.origin = request.headers.get("x-tiny-origin") || "";

    try {
      await this.env.DB.prepare(VOICE_CONNECT_SQL)
        .bind(cfg.id, Math.floor(Date.now() / 1000)).run();
    } catch (err) { console.log(err, "voice connect update"); }

    // Configure the realtime session the moment the socket is live.
    // GA schema (gpt-realtime): audio config is nested under session.audio.
    // {input,output}, NOT the old flat modalities/input_audio_format shape.
    this.sendUpstream({
      type: "session.update",
      session: {
        type: "realtime",
        // Speak + emit text so the replay/transcript has both halves.
        output_modalities: ["audio"],
        instructions: cfg.instructions,
        audio: {
          input: {
            // PCM16 @ 24 kHz — matches the raw frames the clients stream up.
            format: { type: "audio/pcm", rate: 24000 },
            // Semantic VAD: the model decides when the user is done (design pick).
            turn_detection: { type: "semantic_vad" },
            // Transcribe the USER side too so the replay has both halves.
            transcription: { model: "gpt-4o-mini-transcribe" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: cfg.voice,
          },
        },
        // The chat agent's tool roster — executed by the client over the
        // tool_call/tool_result bridge (wireClient/wireUpstream below).
        ...(Array.isArray(cfg.tools) && cfg.tools.length
          ? { tools: cfg.tools, tool_choice: "auto" }
          : {}),
      },
    });
    this.journalEvent({ t: "session.start", voice: cfg.voice, model: cfg.model });

    this.wireUpstream(cfg);
    this.wireClient();

    // Arm the liveness poll (alarm() below): reaps a dead client in
    // ~CLIENT_IDLE_MS and enforces the MAX_SESSION_MS hard cap.
    try {
      this.state.storage.setAlarm?.(Date.now() + IDLE_CHECK_MS);
    } catch { /* alarms optional; teardown also happens on close */ }

    return new Response(null, { status: 101, webSocket: clientSide });
  }

  private sendUpstream(obj: any) {
    try { this.upstream?.send(JSON.stringify(obj)); } catch (err) {
      // TEMP DEBUG (2026-07-25): silent swallowing hid a dead upstream leg.
      if (!this.upSendFailLogged) { this.upSendFailLogged = true; console.log("voice upstream send FAILED", String(err)); }
    }
  }
  private upSendFailLogged = false;
  private sendClient(data: string | ArrayBuffer | Uint8Array) {
    try {
      this.client?.send(data as any);
    } catch { /* closing */ }
  }

  /** Frames FROM the client (phone/web). Binary = mic PCM; text = control. */
  private wireClient() {
    const c = this.client!;
    c.addEventListener("message", (evt: any) => {
      this.lastClientMs = Date.now(); // any frame = the client is alive
      const data = evt.data;
      if (typeof data === "string") {
        // JSON control from the client (e.g. an explicit commit, or a device
        // tool result once tools land). For now: forward known control verbs.
        try {
          const msg = JSON.parse(data);
          if (msg?.type === "input_audio_buffer.commit" || msg?.type === "response.create") {
            this.sendUpstream(msg);
          } else if (msg?.type === "user_text" && typeof msg.text === "string" && msg.text.trim()) {
            // Composer→call bridge (inline-chat design): a message TYPED while
            // the call is live joins the conversation as a user turn — the
            // tiny hears it and answers in voice. The client renders its own
            // copy locally; nothing echoes back down.
            const text = msg.text.trim().slice(0, 4000);
            this.userLast = text;
            this.journalEvent({ t: "user_text", text });
            this.sendUpstream({
              type: "conversation.item.create",
              item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
            });
            this.sendUpstream({ type: "response.create" });
          } else if (msg?.type === "tool_result" && typeof msg.id === "string") {
            // Device/client tool executed on the phone/browser — return the
            // output to the model and let it keep talking.
            const output = typeof msg.output === "string" ? msg.output : JSON.stringify(msg.output ?? {});
            this.journalEvent({ t: "tool_result", id: msg.id, output: output.slice(0, 2000) });
            this.sendUpstream({
              type: "conversation.item.create",
              item: { type: "function_call_output", call_id: msg.id, output: output.slice(0, 32_000) },
            });
            this.sendUpstream({ type: "response.create" });
          }
        } catch { /* ignore malformed client control */ }
        return;
      }
      // Binary mic frame → journal + append to OpenAI's input buffer.
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
      this.journalIn(bytes);
      this.sendUpstream({
        type: "input_audio_buffer.append",
        audio: bytesToB64(bytes),
      });
    });
    c.addEventListener("close", () => this.teardown("ended"));
    c.addEventListener("error", () => this.teardown("error"));
  }

  /** Frames FROM OpenAI. Audio deltas → client binary; everything else → the
   *  event journal (and a slim JSON copy down to the client for live UI). */
  private wireUpstream(cfg: any) {
    const u = this.upstream!;
    u.addEventListener("message", (evt: any) => {
      let msg: any;
      try { msg = JSON.parse(typeof evt.data === "string" ? evt.data : ""); } catch { return; }
      if (!msg?.type) return;

      switch (msg.type) {
        case "response.output_audio.delta":
        case "response.audio.delta": {
          // Residual deltas of a barged-over response — OpenAI keeps pushing
          // for a beat after our cancel crosses its stream on the wire. The
          // client already flushed on barge_in; forwarding these would re-queue
          // a blip of the cancelled reply. Drop them entirely (not journaled
          // either: the user never heard them). response.created re-opens.
          if (this.suppressAudio) break;
          // base64 PCM16 → binary to the client; journal the raw bytes.
          // GA emits response.output_audio.delta; the beta name is kept as a
          // fallback so a model pinned to the old wire still plays.
          if (typeof msg.delta === "string") {
            const bytes = b64ToBytes(msg.delta);
            this.journalOut(bytes);
            // Track playback ms for barge-in truncation (24kHz, 2 bytes/sample).
            this.assistantAudioMs += Math.floor(bytes.length / 48);
            this.sendClient(bytes);
          }
          if (msg.item_id) this.lastAssistantItemId = msg.item_id;
          break;
        }
        case "input_audio_buffer.speech_started": {
          // Barge-in — BUT only a genuine one. With semantic_vad the user's
          // first word of every turn (and any time they speak while the
          // assistant is idle between turns) fires speech_started with NO
          // response in flight; a response.cancel then makes OpenAI answer
          // with a "no active response" error that we'd forward to the client
          // as a spurious error banner on essentially every call. Gate the
          // cancel + truncate on responseActive so they fire only when the
          // assistant is actually talking; always still flush client playback.
          if (this.responseActive) {
            this.sendUpstream({ type: "response.cancel" });
            // Tell OpenAI how much audio actually played so its context matches
            // what the user heard.
            if (this.lastAssistantItemId && this.assistantAudioMs > 0) {
              this.sendUpstream({
                type: "conversation.item.truncate",
                item_id: this.lastAssistantItemId,
                content_index: 0,
                audio_end_ms: this.assistantAudioMs,
              });
            }
            this.responseActive = false;
          }
          // ALWAYS flush client playback, even when no response is in flight:
          // response.done fires when GENERATION finishes, seconds before the
          // phone finishes PLAYING the buffered tail. Speaking over that tail
          // must still flush it, or the next reply queues behind stale audio.
          // Clients treat a no-audio barge_in as a no-op.
          this.sendClient(JSON.stringify({ type: "barge_in" }));
          this.journalEvent({ t: "barge_in" });
          this.assistantAudioMs = 0;
          this.suppressAudio = true; // drop the cancelled reply's residual deltas
          break;
        }
        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta": {
          this.assistantBuf += String(msg.delta || "");
          this.journalEvent({ t: "assistant_transcript", delta: msg.delta });
          this.sendClient(JSON.stringify({ type: "assistant_transcript", delta: msg.delta }));
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          this.userLast = String(msg.transcript || "");
          this.journalEvent({ t: "user_transcript", text: msg.transcript });
          this.sendClient(JSON.stringify({ type: "user_transcript", text: msg.transcript }));
          break;
        }
        case "response.function_call_arguments.done": {
          // The model called a tool. ALL tools ride the client bridge — the
          // phone/browser executes with the same executors chat ships and
          // replies {type:"tool_result", id, output} (wireClient above).
          const id = String(msg.call_id || "");
          const name = String(msg.name || "");
          let args: any = {};
          try { args = JSON.parse(msg.arguments || "{}"); } catch { /* raw string below */ }
          this.journalEvent({ t: "tool_call", id, name, args });
          this.sendClient(JSON.stringify({ type: "tool_call", id, name, args }));
          break;
        }
        case "response.created": {
          // A model turn began — arm barge-in cancel/truncate for it. Also tell
          // clients a fresh assistant turn is starting so they can close the
          // previous one (web keys turns off user_transcript; native clients
          // otherwise concatenate every reply into one run-on string).
          this.responseActive = true;
          this.assistantAudioMs = 0;
          this.suppressAudio = false; // fresh turn — audio flows again
          this.sendClient(JSON.stringify({ type: "response_started" }));
          // `out` = where in the out-stream this response's audio begins —
          // the recording stitcher's per-response slice + placement marker.
          this.journalEvent({ t: "response_started", out: this.outTotal });
          break;
        }
        case "response.done": {
          // Usage lives on response.done for realtime; accumulate for billing.
          const u2 = msg.response?.usage;
          if (u2) {
            this.inTokens += Number(u2.input_tokens || 0);
            this.outTokens += Number(u2.output_tokens || 0);
          }
          this.responseActive = false;
          this.assistantAudioMs = 0;
          // Signal turn completion so clients can finalize the assistant line.
          this.sendClient(JSON.stringify({ type: "response_done" }));
          this.journalEvent({ t: "response_done" });
          // Feed the completed exchange into the SAME per-tiny turn memory
          // chat feeds — the agent can recall this call immediately, even if
          // the client dies before rendering it. (/turns owner+private gates.)
          this.postTurn();
          break;
        }
        case "error": {
          this.journalEvent({ t: "openai_error", error: msg.error });
          // Benign barge-in race, seen on EVERY real call with an interruption:
          // our response.cancel crosses response.done on the wire and OpenAI
          // answers "no active response". Journal it, but never surface a
          // mid-call error banner for it (live-session journals 5d357916/…
          // showed 2 of these per call, one per barge-in).
          if (msg.error?.code === "response_cancel_not_active") break;
          this.sendClient(JSON.stringify({ type: "error", error: msg.error?.message || "openai error" }));
          break;
        }
        default: {
          // Reasoning items, function calls, etc. — journal generically so the
          // replay has the full record; exact shapes verified in the spike.
          this.journalEvent({ t: msg.type, e: msg });
        }
      }
    });
    // Upstream death mid-call: tell the CLIENT why before tearing down —
    // otherwise every OpenAI-side drop reads as a mute "call ended" (cost an
    // hour of debugging during the 2026-07-25 OpenAI incident: dial 101'd,
    // then "Network connection lost", zero events, nothing surfaced anywhere).
    u.addEventListener("close", (e: any) => {
      console.log("voice upstream CLOSE", e?.code, String(e?.reason || "").slice(0, 120));
      this.sendClient(JSON.stringify({ type: "error", error: "the voice service closed the connection — try calling again" }));
      this.teardown("ended");
    });
    u.addEventListener("error", (e: any) => {
      console.log("voice upstream ERROR", String(e?.message || e).slice(0, 120));
      this.sendClient(JSON.stringify({ type: "error", error: "the voice service dropped — try calling again" }));
      this.teardown("error");
    });
  }

  /** Post the just-finished exchange to /turns (fire-and-forget; the route
   *  itself enforces owner+private and no-ops for public tinys). */
  private postTurn() {
    const user = this.userLast.trim();
    const assistant = this.assistantBuf.trim();
    this.userLast = "";
    this.assistantBuf = "";
    if ((!user && !assistant) || !this.origin || !this.tinyName || !this.userId) return;
    fetch(`${this.origin}/turns`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": this.env.INTERNAL_API_KEY || "",
      },
      body: JSON.stringify({ name: this.tinyName, userId: this.userId, user, assistant }),
    }).catch((err: any) => console.log(err, "voice turn post"));
  }

  // ── Journal ────────────────────────────────────────────────────────────
  private now() { return Date.now() - this.startedMs; }

  private journalEvent(obj: any) {
    this.events.push(JSON.stringify({ ms: this.now(), ...obj }));
    this.eventCount++;
  }

  private journalIn(bytes: Uint8Array) {
    this.inBuf.push(bytes);
    this.inBytes += bytes.length;
    if (this.inBytes >= SEGMENT_BYTES) this.flushSegment("in");
  }
  private journalOut(bytes: Uint8Array) {
    this.outBuf.push(bytes);
    this.outBytes += bytes.length;
    this.outTotal += bytes.length;
    if (this.outBytes >= SEGMENT_BYTES) this.flushSegment("out");
  }

  private flushSegment(dir: "in" | "out") {
    const buf = dir === "in" ? this.inBuf : this.outBuf;
    if (!buf.length) return;
    const total = dir === "in" ? this.inBytes : this.outBytes;
    const seq = dir === "in" ? this.inSeq++ : this.outSeq++;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const chunk of buf) { merged.set(chunk, off); off += chunk.length; }
    if (dir === "in") { this.inBuf = []; this.inBytes = 0; } else { this.outBuf = []; this.outBytes = 0; }
    const id = this.sid;
    if (!id) return;
    const key = `voice/${id}/${dir}-${seq}.pcm`;
    // Fire-and-forget; a dropped segment shouldn't stall the live relay.
    this.env.MEDIA?.put(key, merged, { httpMetadata: { contentType: "audio/L16" } })
      .catch((err: any) => console.log(err, "segment flush", key));
  }

  // ── Teardown ─────────────────────────────────────────────────────────────
  private async teardown(status: "ended" | "error") {
    if (this.closed) return;
    this.closed = true;
    const cfg: any = await this.state.storage.get("cfg");
    const id = this.sid || cfg?.id || null;
    this.sid = id;

    try { this.upstream?.close(); } catch { }
    try { this.client?.close(); } catch { }

    // Flush the final audio tails + the event log.
    this.flushSegment("in");
    this.flushSegment("out");
    const segCount = this.inSeq + this.outSeq;
    if (id && this.env.MEDIA) {
      const body = this.events.join("\n");
      await this.env.MEDIA.put(`voice/${id}/events.jsonl`, body, {
        httpMetadata: { contentType: "application/x-ndjson" },
      }).catch((err: any) => console.log(err, "events flush"));
    }

    const durationMs = this.startedMs ? Date.now() - this.startedMs : 0;
    if (id) {
      try {
        await this.env.DB.prepare(VOICE_END_SQL).bind(
          id, status, Math.floor(Date.now() / 1000), durationMs,
          segCount, this.eventCount, this.inTokens, this.outTokens, null
        ).run();
      } catch (err) { console.log(err, "voice end update"); }
    }
    // The OpenAI key never outlives the session.
    try { await this.state.storage.delete("cfg"); } catch { }
  }

  /** Three-duty alarm. Pre-connect (startedMs unset): the ticket-TTL
   *  self-clean handleInit armed. Post-connect: a liveness poll — a client
   *  silent past CLIENT_IDLE_MS is dead and its WS close never reached us
   *  (seen live: session 91b08eb1 sat "live" for an hour after the phone app
   *  was force-killed mid-call by a USB reinstall, holding the OpenAI socket
   *  + BYO key). Also enforces the MAX_SESSION_MS hard cap. A DO eviction
   *  resets startedMs, which lands in the pre-connect arm — teardown, the
   *  right call there too (the sockets died with the old instance). */
  async alarm() {
    if (!this.startedMs) { await this.teardown("ended"); return; }
    const idle = Date.now() - this.lastClientMs;
    if (idle >= CLIENT_IDLE_MS || Date.now() - this.startedMs >= MAX_SESSION_MS) {
      await this.teardown("ended");
      return;
    }
    try { this.state.storage.setAlarm?.(Date.now() + IDLE_CHECK_MS); } catch { /* next close reaps */ }
  }
}

// ── Worker routes (front the DO) ───────────────────────────────────────────
// These are plain itty handlers rather than OpenAPIRoute classes: /connect is
// a raw WebSocket upgrade (no JSON body/params to document) and /session is
// internal-only. Registered in index.ts.

/**
 * POST /voice/session (internal-key) — the app has already resolved the tiny's
 * prompt/voice and the user's BYO OpenAI key; we mint the DO, seed its config,
 * and return the single-use connect ticket. Body:
 *   { id, userId, tinyName, voice, instructions, openaiKey, model? }
 */
export async function voiceSessionCreate(request: Request, env: any): Promise<Response> {
  if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
  if (!env.VOICE) return json({ error: "voice not provisioned" }, 424);
  if (!env.MEDIA) return json({ error: "media store not provisioned" }, 424);
  const body: any = await request.json().catch(() => null);
  if (!body?.userId || !body?.openaiKey) {
    return json({ error: "userId and openaiKey required" }, 400);
  }
  // PROBE (internal-key callers only, deliberate): "__platform_probe__" runs
  // the session on the platform OpenAI key — the only self-serve way to
  // exercise the full relay (mint→WS→OpenAI→events) without a user device
  // key. Used with scripts streaming journal PCM; diagnosed the 2026-07-25
  // "calls go mute" report as OpenAI's outage, not a relay regression.
  if (body.openaiKey === "__platform_probe__") body.openaiKey = env.OPENAI_API_KEY || "";
  const id = String(body.id || crypto.randomUUID());
  const stub = env.VOICE.get(env.VOICE.idFromName(id));
  const initResp = await stub.fetch("https://do/init", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-key": env.INTERNAL_API_KEY || "",
    },
    body: JSON.stringify({ ...body, id }),
  });
  const initData: any = await initResp.json().catch(() => ({}));
  if (!initResp.ok || !initData?.ticket) {
    return json({ error: initData?.error || "init failed" }, initResp.status || 502);
  }
  return json({ ok: true, sessionId: id, ticket: initData.ticket });
}

/**
 * GET /voice/connect/:id?ticket=… — client WebSocket upgrade, forwarded to the
 * DO which validates the single-use ticket and starts relaying. Public route
 * (auth is the unguessable id + single-use ticket, same posture as /media).
 */
export async function voiceConnect(request: Request, env: any): Promise<Response> {
  if (!env.VOICE) return json({ error: "voice not provisioned" }, 424);
  const url = new URL(request.url);
  const id = decodeURIComponent(url.pathname.split("/").pop() || "");
  if (!id) return json({ error: "session id required" }, 400);
  const stub = env.VOICE.get(env.VOICE.idFromName(id));
  // Forward our public origin — inside the DO the request URL is the opaque
  // https://do/, but postTurn needs to call the worker's own /turns route.
  const fwd = new Headers(request.headers);
  fwd.set("x-tiny-origin", url.origin);
  return stub.fetch(`https://do/connect${url.search}`, {
    headers: fwd,
  });
}

/**
 * POST /voice/reap/:id (internal-key) — wake a session's DO and force
 * teardown. Ops escape hatch for zombie/pre-alarm-era sessions; safe on any
 * session (teardown is idempotent and correct at every lifecycle stage).
 */
export async function voiceReap(request: Request, env: any): Promise<Response> {
  if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
  if (!env.VOICE) return json({ error: "voice not provisioned" }, 424);
  const id = decodeURIComponent(new URL(request.url).pathname.split("/").pop() || "");
  if (!id) return json({ error: "session id required" }, 400);
  const stub = env.VOICE.get(env.VOICE.idFromName(id));
  return stub.fetch("https://do/reap", {
    method: "POST",
    headers: { "x-internal-key": env.INTERNAL_API_KEY || "" },
  });
}

/** 44-byte RIFF/WAVE header for 24 kHz mono PCM16 of `dataLen` bytes. */
function wavHeader(dataLen: number): Uint8Array {
  const h = new ArrayBuffer(44);
  const v = new DataView(h);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 24000, true); v.setUint32(28, 24000 * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, dataLen, true);
  return new Uint8Array(h);
}

/**
 * Parse an HTTP Range header against a known total size. Returns the byte
 * window to serve, or null for "serve the whole thing" (no/invalid header —
 * per RFC 7233 an unsatisfiable or malformed Range is ignorable for our
 * purposes except the explicit out-of-bounds case, which returns {unsatisfiable}
 * so the caller can 416).
 *
 * Only the single-range `bytes=a-b` / `bytes=a-` / `bytes=-n` forms are
 * handled — that's everything AVPlayer/ExoPlayer/browsers emit. Multipart
 * ranges fall back to the full body (a 200 is always a legal answer).
 *
 * Exported for tests: iOS AVPlayer is the strictest audio client we serve —
 * it probes `bytes=0-1` and will not play (or cannot seek) without a correct
 * 206/Content-Range/Content-Length contract, which is exactly the "recordings
 * don't play on iOS" failure this closed.
 */
export function parseByteRange(header: string | null, total: number):
  { start: number; end: number } | { unsatisfiable: true } | null {
  if (!header || total <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    // suffix form: last N bytes
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return { unsatisfiable: true };
    const start = Math.max(0, total - n);
    return { start, end: total - 1 };
  }
  const start = Number(a);
  if (!Number.isFinite(start) || start >= total) return { unsatisfiable: true };
  const end = b === "" ? total - 1 : Math.min(Number(b), total - 1);
  if (!Number.isFinite(end) || end < start) return { unsatisfiable: true };
  return { start, end };
}

/** Serve `bytes` honoring an optional Range header — 206 with Content-Range
 *  for a window, 200 with Content-Length for the whole body, 416 when the
 *  requested window is out of bounds. Always advertises Accept-Ranges. */
function rangedWav(bytes: Uint8Array, rangeHeader: string | null, baseHeaders: Record<string, string>): Response {
  const total = bytes.length;
  const headers: Record<string, string> = { ...baseHeaders, "Accept-Ranges": "bytes" };
  const r = parseByteRange(rangeHeader, total);
  if (r && "unsatisfiable" in r) {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${total}` } });
  }
  if (r) {
    const slice = bytes.subarray(r.start, r.end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${r.start}-${r.end}/${total}`,
        "Content-Length": String(slice.length),
      },
    });
  }
  return new Response(bytes, { headers: { ...headers, "Content-Length": String(total) } });
}

/**
 * GET /voice/recording/:id — the call as ONE playable WAV (the "podcast"
 * surface). Stitched on first request, cached to R2, streamed thereafter.
 * Public-but-unguessable (UUID id), the same posture as /voice/replay.
 *
 * Mix model: the mic in-stream is CONTINUOUS 24 kHz realtime (clients stream
 * the tap for the whole call), so it IS the wall clock — the canvas. Each
 * assistant response is sliced out of the out-stream by the `out` byte
 * offsets response_started events journal, and added onto the canvas at that
 * event's ms (clamped mix; hardware AEC means the mic is near-silent under
 * the tiny's speech). Pre-marker sessions (out:undefined) fall back to
 * placing the whole out-stream at the first response's ms — approximate,
 * but those are only the early test calls.
 */
export async function voiceRecording(request: Request, env: any): Promise<Response> {
  if (!env.MEDIA) return json({ error: "media store not provisioned" }, 424);
  const id = decodeURIComponent(new URL(request.url).pathname.split("/").pop() || "").replace(/\.wav$/, "");
  if (!id) return json({ error: "session id required" }, 400);
  const wavHeaders = {
    "Content-Type": "audio/wav",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*",
  };

  // Serve BYTES with Range support, not a naked stream: AVPlayer (iOS) probes
  // with `Range: bytes=0-1` and needs Accept-Ranges + Content-Length + 206 to
  // size/seek the asset — the old `new Response(cached.body)` answered every
  // probe with a chunked 200 (no length at all), so iOS wouldn't play what web
  // <audio> happily streamed. Size is bounded by the 40MB stitch guard below,
  // so buffering the cached object is safe in worker memory.
  const cached = await env.MEDIA.get(`voice/${id}/recording.wav`);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    return rangedWav(bytes, request.headers.get("Range"), wavHeaders);
  }

  // Only stitch a FINISHED call — a live one is still growing its segments
  // and would cache a partial recording forever.
  const row = await env.DB?.prepare("SELECT status FROM voice_sessions WHERE id = ?").bind(id).first().catch(() => null);
  if (row && row.status !== "ended" && row.status !== "error") {
    return json({ error: "call still in progress" }, 409);
  }

  const ev = await env.MEDIA.get(`voice/${id}/events.jsonl`);
  if (!ev) return json({ error: "no replay journaled for this session" }, 404);
  const marks: { ms: number; out: number | null }[] = [];
  for (const line of (await ev.text()).split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.t === "response_started") {
        marks.push({ ms: Number(e.ms) || 0, out: typeof e.out === "number" ? e.out : null });
      }
    } catch { /* skip malformed line */ }
  }

  const readAll = async (dir: "in" | "out") => {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i < 10_000; i++) {
      const seg = await env.MEDIA.get(`voice/${id}/${dir}-${i}.pcm`);
      if (!seg) break;
      const bytes = new Uint8Array(await seg.arrayBuffer());
      parts.push(bytes);
      total += bytes.length;
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { merged.set(p, off); off += p.length; }
    return merged;
  };
  const inPcm = await readAll("in");
  const outPcm = await readAll("out");
  if (!inPcm.length && !outPcm.length) return json({ error: "no audio journaled" }, 404);
  // Worker memory guard (~128MB): decline pathological calls rather than OOM.
  if (inPcm.length + outPcm.length > 40_000_000) return json({ error: "call too long to stitch" }, 413);

  const SAMPLES_PER_MS = 24;
  // Slice list in SAMPLE units (marker `out` offsets are BYTES — halve them).
  const slices: { at: number; from: number; to: number }[] = [];
  for (let k = 0; k < marks.length; k++) {
    const at = marks[k].ms * SAMPLES_PER_MS;
    if (marks[k].out === null) {
      // Pre-marker journal — place the whole out-stream at the first response.
      slices.push({ at, from: 0, to: outPcm.length >> 1 });
      break;
    }
    const from = (marks[k].out as number) >> 1;
    const nextOut = marks[k + 1]?.out;
    const to = typeof nextOut === "number" ? nextOut >> 1 : outPcm.length >> 1;
    slices.push({ at, from, to: Math.max(from, to) });
  }
  const inSamples = inPcm.length >> 1;
  let canvasLen = inSamples;
  for (const s of slices) canvasLen = Math.max(canvasLen, s.at + (s.to - s.from));
  const canvas = new Int16Array(canvasLen);
  canvas.set(new Int16Array(inPcm.buffer, 0, inSamples));
  const outS = new Int16Array(outPcm.buffer, 0, outPcm.length >> 1);
  for (const s of slices) {
    for (let i = s.from, j = s.at; i < s.to && i < outS.length; i++, j++) {
      const mixed = canvas[j] + outS[i];
      canvas[j] = mixed > 32767 ? 32767 : mixed < -32768 ? -32768 : mixed;
    }
  }

  const data = new Uint8Array(canvas.buffer);
  const wav = new Uint8Array(44 + data.length);
  wav.set(wavHeader(data.length), 0);
  wav.set(data, 44);
  await env.MEDIA.put(`voice/${id}/recording.wav`, wav, {
    httpMetadata: { contentType: "audio/wav" },
  }).catch((err: any) => console.log(err, "recording cache"));
  return rangedWav(wav, request.headers.get("Range"), wavHeaders);
}

/** Replay filename allowlist — events log + segmented PCM only; nothing else
 *  the DO journals into voice/{id}/. Blocks traversal + listing probes. */
const VOICE_ASSET_RE = /^(events\.jsonl|(in|out)-\d{1,6}\.pcm)$/;

/**
 * GET /voice/replay/:id/:file — serve a journaled replay asset from R2. Public-
 * but-unguessable (the session id is a UUID, same posture as /media). The app's
 * replay page fetches the manifest from D1 then pulls these by URL.
 */
export async function voiceReplayAsset(request: Request, env: any): Promise<Response> {
  if (!env.MEDIA) return json({ error: "media store not provisioned" }, 424);
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  // …/voice/replay/:id/:file  → last two segments
  const file = decodeURIComponent(parts.pop() || "");
  const id = decodeURIComponent(parts.pop() || "");
  if (!/^[0-9a-f-]{36}$/.test(id) || !VOICE_ASSET_RE.test(file)) {
    return json({ error: "not found" }, 404);
  }
  const obj = await env.MEDIA.get(`voice/${id}/${file}`);
  if (!obj) return json({ error: "not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const VOICE_LIST_SQL = `
  SELECT id, tiny_name, voice, status, started_at, ended_at, duration_ms,
         segment_count, event_count, input_tokens, output_tokens
  FROM voice_sessions
  WHERE user_id = ?1
  ORDER BY started_at DESC LIMIT 50`;

export const VOICE_GET_SQL = `
  SELECT id, user_id, tiny_name, voice, status, started_at, connected_at,
         ended_at, duration_ms, segment_count, event_count, input_tokens,
         output_tokens, error
  FROM voice_sessions WHERE id = ?1`;

export class VoiceSessionsListCall extends OpenAPIRoute {
  static schema = {
    tags: ["Voice"],
    summary: "Internal: list a user's voice sessions (most recent first).",
    parameters: { userId: Query(Str, { required: true }) },
    responses: { "200": { description: "Sessions", schema: { response: "Sessions" } } },
  };
  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const userId = data.userId || new URL(request.url).searchParams.get("userId");
    if (!userId) return json({ error: "userId required" }, 400);
    const rows = await env.DB.prepare(VOICE_LIST_SQL).bind(String(userId)).all();
    return json({ ok: true, sessions: rows?.results || [] });
  }
}

export class VoiceSessionGetCall extends OpenAPIRoute {
  static schema = {
    tags: ["Voice"],
    summary: "Internal: fetch one voice session's replay manifest.",
    parameters: { id: Query(Str, { required: true }) },
    responses: { "200": { description: "Session", schema: { response: "Session" } } },
  };
  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const id = data.id || new URL(request.url).searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const row = await env.DB.prepare(VOICE_GET_SQL).bind(String(id)).first();
    if (!row) return json({ ok: true, session: null });
    // Build the replay asset URLs (events + per-direction PCM segments) so the
    // app doesn't need to know the R2 key layout.
    const origin = new URL(request.url).origin;
    const manifest = {
      events: `${origin}/voice/replay/${row.id}/events.jsonl`,
      // Segments are interleaved in/out; expose both series generously and let
      // the player stop at the first missing index.
      audioBase: `${origin}/voice/replay/${row.id}`,
    };
    return json({ ok: true, session: row, manifest });
  }
}
