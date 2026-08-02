/**
 * Web Push (COMPARISON.md §2.3) — subscriptions in D1; sends via the Push
 * Protocol with VAPID (ES256 JWT) + RFC 8291 aes128gcm payload encryption,
 * all WebCrypto (edge-safe, no deps).
 *
 *   GET    /push/key          → { key }  (PUBLIC — the VAPID public key;
 *                               single source of truth so the app and the
 *                               signer can never drift)
 *   POST   /push/subscribe   { userId, endpoint, keys } (internal)
 *   DELETE /push/subscribe   { userId, endpoint }       (internal)
 *   POST   /push/send        { userId, title?, body?, url? } (internal)
 *
 * Payloads are JSON {title, body, data:{url}} — the SW (public/sw.js)
 * parses e.data.json(). If a subscription's keys are unusable we fall back
 * to a payload-less push (SW shows a generic notification).
 *
 * Native devices ride the same call: sendPushToUser also drops a
 * {type:'notify'} envelope on the device relay for every fresh (heartbeating)
 * device, so the Android fleet node banners pushes within its 5s poll.
 */
import { OpenAPIRoute, Str } from "@cloudflare/itty-router-openapi";
import { checkInternalKey } from "./users";
// From the leaf module, NOT relay.ts: relay.ts imports sendPushToUser from
// here (late device replies push), so reading the INSERT from relay.ts would
// close an import cycle.
import { RELAY_INSERT_SQL } from "./relay-shared";

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export function b64urlToBytes(b64url: string): Uint8Array {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
export function bytesToB64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign a VAPID JWT (ES256) for the push service audience. */
async function vapidHeaders(env: any, endpoint: string): Promise<Record<string, string> | null> {
  const pub = env.VAPID_PUBLIC_KEY;   // base64url, uncompressed P-256 point (65 bytes)
  const priv = env.VAPID_PRIVATE_KEY; // base64url, 32-byte private scalar
  // ⚠️ The fallback must be a domain WE still own: `sub` is the contact a push
  // service uses to reach the sender about a misbehaving subscription, and
  // VAPID_SUBJECT is not configured (checked against the deployed secret list),
  // so this literal IS what production signs. tinyai.id lapsed and now resolves
  // to an unrelated site — pointing push operators at somebody else's domain.
  const subject = env.VAPID_SUBJECT || 'mailto:help@tiny.technology';
  if (!pub || !priv) return null;

  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(new TextEncoder().encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));

  const pubBytes = b64urlToBytes(pub); // 65 bytes: 0x04 || x || y
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC', crv: 'P-256',
      x: bytesToB64url(pubBytes.slice(1, 33)),
      y: bytesToB64url(pubBytes.slice(33, 65)),
      d: priv,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  const jwt = `${header}.${payload}.${bytesToB64url(sig)}`;
  return {
    Authorization: `vapid t=${jwt}, k=${pub}`,
    TTL: '86400',
  };
}

// ── RFC 8291 payload encryption (aes128gcm) — pure WebCrypto ────────────────

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    key, length * 8
  );
  return new Uint8Array(bits);
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

/**
 * Encrypt a payload for a push subscription (RFC 8291 / RFC 8188 aes128gcm).
 * keys = {p256dh, auth} from the browser's PushSubscription.
 */
// Exported for tests (tests/push-crypto.test.ts) — decrypt-side verification
export async function encryptPayload(payload: string, keys: { p256dh: string; auth: string }): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(keys.p256dh);  // 65-byte uncompressed point
  const authSecret = b64urlToBytes(keys.auth);  // 16 bytes

  // Ephemeral application-server ECDH key pair
  const asKeys = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  )) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as any, asKeys.privateKey, 256)
  );

  const te = new TextEncoder();
  // IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info"||0x00||ua_public||as_public, 32)
  const ikm = await hkdf(ecdhSecret, authSecret,
    concatBytes(te.encode('WebPush: info\0'), uaPublic, asPublic), 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, te.encode('Content-Encoding: nonce\0'), 12);

  // Single record: plaintext || 0x02 (last-record padding delimiter)
  const plaintext = concatBytes(te.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aesKey, plaintext as BufferSource)
  );

  // aes128gcm body header: salt(16) || rs(4) || idlen(1) || keyid(as_public, 65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concatBytes(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

export interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
}

// ── Relay-notify fan-out (native devices) ───────────────────────────────────
//
// Enrolled devices (Android app fleet node, tiny-node daemons) have no browser
// push service, but they already poll the device relay every ~5s. So every
// push ALSO becomes a {type:'notify'} relay envelope per fresh device — the
// Android app banners it natively; consumers that don't understand the type
// (tiny-node CLI, older app builds) ack-and-ignore it (relay-poller.ts:73).

/** Only target devices whose heartbeat is fresh enough to plausibly be
 * polling (heartbeat is 30s; 2 missed beats + slack). Offline devices would
 * just rot envelopes until the 1h sweep. */
export const NOTIFY_PRESENCE_S = 120;

export const NOTIFY_TARGETS_SQL = `
  SELECT id FROM devices WHERE user_id = ?1 AND revoked = 0 AND last_seen >= ?2`;

/** The relay envelope for a push — same clamps as the web-push message so the
 * two transports can never diverge in what they carry. Pure (testable). */
export function buildNotifyEnvelope(payload: PushPayload): string {
  return JSON.stringify({
    type: "notify",
    title: (payload.title || "tiny").slice(0, 100),
    body: (payload.body || "").slice(0, 400),
    tag: payload.tag || "tiny-notification",
    url: payload.url || "/",
  });
}

async function relayPushToDevices(env: any, userId: string, payload: PushPayload): Promise<number> {
  let relayed = 0;
  try {
    const cutoff = Math.floor(Date.now() / 1000) - NOTIFY_PRESENCE_S;
    const { results } = await env.DB.prepare(NOTIFY_TARGETS_SQL).bind(userId, cutoff).all();
    if (!results?.length) return 0;
    const envelope = buildNotifyEnvelope(payload);
    const now = Math.floor(Date.now() / 1000);
    for (const row of results) {
      try {
        await env.DB.prepare(RELAY_INSERT_SQL).bind(
          crypto.randomUUID(), userId, String(row.id), null, envelope, now
        ).run();
        relayed += 1;
      } catch (err) { console.log(err, "relay notify insert"); }
    }
  } catch (err) { console.log(err, "relayPushToDevices"); }
  return relayed;
}

export async function sendPushToUser(env: any, userId: string, payload?: PushPayload): Promise<{ sent: number; pruned: number; relayed: number }> {
  let sent = 0, pruned = 0;
  // Native-device leg first: it must not be skipped by the web-push loop's
  // early return when VAPID keys are unconfigured (relay needs no keys).
  const relayed = payload ? await relayPushToDevices(env, userId, payload) : 0;
  try {
    const { results } = await env.DB.prepare(
      "SELECT endpoint, keys_json FROM push_subscriptions WHERE user_id = ?"
    ).bind(userId).all();
    const message = payload ? JSON.stringify({
      title: (payload.title || 'tiny').slice(0, 100),
      body: (payload.body || '').slice(0, 400),
      tag: payload.tag || 'tiny-notification',
      data: { url: payload.url || '/' },
    }) : null;

    for (const row of results || []) {
      // Isolate each subscription — a single bad row (e.g. an endpoint that
      // throws in vapidHeaders' new URL(), or any per-send error) must not
      // abort the fan-out to the user's OTHER (valid) devices.
      try {
        const headers = await vapidHeaders(env, row.endpoint);
        if (!headers) return { sent, pruned, relayed }; // VAPID keys not configured (global — stop)

        // Encrypt per-subscription; fall back to payload-less on bad keys
        let body: Uint8Array | undefined;
        if (message) {
          try {
            const keys = JSON.parse(row.keys_json || '{}');
            if (keys.p256dh && keys.auth) body = await encryptPayload(message, keys);
          } catch (err) { console.log(err, 'push encrypt'); }
        }

        // 10s bound: the endpoint is a client-supplied push-service URL. One
        // that accepts the connection but never responds would otherwise hang
        // the awaiting caller (MessageSendCall DM fan-out, VisitCall) or stall
        // the cron tick (runDueJobs) until Cloudflare's wall-clock limit —
        // per subscription, in series. Every other outbound fetch here is
        // already timeout-bounded (house rule); this was the lone gap.
        const res = await fetch(row.endpoint, {
          method: 'POST',
          headers: {
            ...headers,
            Urgency: 'normal',
            ...(body ? { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' } : {}),
          },
          ...(body ? { body: body as BodyInit } : {}),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);

        if (res && (res.status === 404 || res.status === 410)) {
          // Push service says the subscription is dead — prune it
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(row.endpoint).run();
          pruned += 1;
        } else if (res && res.ok) {
          sent += 1;
        } else if (res) {
          console.log('push send failed', res.status, await res.text().catch(() => ''));
        }
      } catch (err) { console.log(err, 'push send (per-subscription)'); }
    }
  } catch (err) { console.log(err, 'sendPushToUser'); }
  return { sent, pruned, relayed };
}

export class PushKeyCall extends OpenAPIRoute {
  static schema = {
    tags: ["Push"],
    summary: "Public: the VAPID public key browsers subscribe with.",
    responses: { "200": { description: "Key", schema: { response: "Key" } } },
  };

  async handle(_request: Request, env: any) {
    return json({ key: env.VAPID_PUBLIC_KEY || null });
  }
}

export class PushSubscribeCall extends OpenAPIRoute {
  static schema = {
    tags: ["Push"],
    summary: "Internal: store a push subscription for a user.",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      endpoint: new Str({ required: true, description: "Push endpoint URL." }),
      keys: new Str({ required: true, description: "JSON {p256dh, auth}." }),
    },
    responses: { "200": { description: "Subscribed", schema: { response: "Subscribed" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, endpoint, keys } = data.body;
    if (!userId || !endpoint || !keys) return json({ error: "missing fields" }, 400);
    // The endpoint is client-supplied and later fetch()ed by sendPushToUser —
    // without this check a crafted subscription turns pushes into blind-POST
    // SSRF. https + real public hostname only (matches app-side rules).
    let epUrl: URL;
    try { epUrl = new URL(String(endpoint)); } catch { return json({ error: "invalid endpoint URL" }, 400); }
    const host = epUrl.hostname.toLowerCase();
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
    if (epUrl.protocol !== "https:" || isIp || host === "localhost" ||
        host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
      return json({ error: "endpoint must be a public https push service URL" }, 400);
    }
    try { JSON.parse(keys); } catch { return json({ error: "keys must be JSON" }, 400); }
    await env.DB.prepare(
      "INSERT OR REPLACE INTO push_subscriptions (endpoint, user_id, keys_json) VALUES (?, ?, ?)"
    ).bind(String(endpoint), String(userId), String(keys)).run();
    return json({ ok: true });
  }
}

export class PushUnsubscribeCall extends OpenAPIRoute {
  static schema = {
    tags: ["Push"],
    summary: "Internal: remove a push subscription.",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      endpoint: new Str({ required: true, description: "Push endpoint URL." }),
    },
    responses: { "200": { description: "Unsubscribed", schema: { response: "Unsubscribed" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, endpoint } = data.body;
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
      .bind(String(endpoint), String(userId)).run();
    return json({ ok: true });
  }
}

export class PushSendCall extends OpenAPIRoute {
  static schema = {
    tags: ["Push"],
    summary: "Internal: send an encrypted notification to all of a user's devices.",
    requestBody: {
      userId: new Str({ required: true, description: "User id." }),
      title: new Str({ required: false, description: "Notification title." }),
      body: new Str({ required: false, description: "Notification body." }),
      url: new Str({ required: false, description: "URL to open on click." }),
      tag: new Str({ required: false, description: "Notification tag (replaces same-tag notes)." }),
    },
    responses: { "200": { description: "Sent", schema: { response: "Sent" } } },
  };

  async handle(request: Request, env: any, _ctx: any, data: Record<string, any>) {
    if (!checkInternalKey(request, env)) return json({ error: "unauthorized" }, 401);
    const { userId, title, body, url, tag } = data.body;
    const payload = (title || body) ? { title, body, url, tag } : undefined;
    const result = await sendPushToUser(env, String(userId), payload);
    return json({ ok: true, ...result });
  }
}
