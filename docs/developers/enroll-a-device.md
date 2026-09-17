---
description: >-
  Put a laptop, a phone, a $60 microcontroller or a 3D printer into your tiny's fleet — live presence, reachable from any chat, in a few calls.
---

# Enroll a device

A device is anything that can hold a credential and answer a question: a laptop,
a phone, a $60 microcontroller on a necklace, a 3D printer. Enrolling one puts it
in your fleet with live presence, makes it reachable from any chat surface
(`use_device`), and makes it revocable in one click.

There is one registry and one revoke button for all of them. What differs is
**which way the connection is dialed**.

| | **Pull device** | **Endpoint device** |
|---|---|---|
| `kind` | `cli` · `daemon` · `browser` | `endpoint` |
| Who dials | the device dials **in** and polls | tiny dials **out** to the device |
| Credential | a `tind_` device token we mint | a bearer **you** mint, that its own API accepts |
| Presence | heartbeat every 30s; online = seen in the last 60s | `online: null` — unknown until something calls it |
| Invoke | envelope into a mailbox, device picks it up | direct HTTPS request, synchronous answer |
| Needs a public address | no — it works from behind any NAT | **yes** — https, public hostname |
| Typical | a Mac running `tiny-tech`, a phone, a Nicla Vision | a printer or robot with its own dashboard |

Both kinds count against the same limit: **20 devices per account**. Past that,
enroll returns `device limit reached` and you revoke one first.

## The one rule about the token

`POST /api/devices` returns `device_token` **exactly once**. Only its SHA-256 is
stored, so nobody — including us — can show it to you again.

!!! danger "Lost the token? Adopt the device. Never re-enroll it."

    Re-enrolling the same hardware mints a *second* row, and the first one never
    goes offline gracefully: it sits in your fleet forever with a frozen
    `last_seen`, and you can't tell the ghost from the machine.

    ```bash
    curl -X POST https://tiny.technology/api/devices/adopt \
      -H "Authorization: Bearer $TINY_TOKEN" \
      -H 'Content-Type: application/json' \
      -d '{"deviceId":"<device id>"}'
    ```

    That keeps the row, its id, its history and its transcripts, and issues a
    fresh token to whoever asked. The old token stops working **immediately** —
    that's the point, not a side effect. Adoption is a handover, so the loser has
    to be told (its next heartbeat 401s) rather than left half-connected.

Endpoint devices have no token at all, and `adopt` refuses them: nothing
authenticates *into* an endpoint device, so there is nothing to rotate.

## The easy path: a laptop

```bash
npx tiny-tech login          # browser opens → Approve → the machine enrolls itself
npx tiny-tech devices        # your fleet, with presence
npx tiny-tech daemon install # answer fleet commands at login
```

Enrollment is a side effect of login, the token lands in `~/.tiny/device.json`
(`0600`), and the identity is reused on the next run — verified by a heartbeat
first, so a device you revoked from the web enrolls again instead of failing
silently.

Everything below is what that command does, for the cases it can't cover.

## Any device: the four calls

The examples authenticate with `Authorization: Bearer $TINY_TOKEN`, where
`TINY_TOKEN` is your own account token from `~/.tiny/credentials.json` (or a
browser session cookie — either works). **Enrollment authority is the human**: a
device cannot enroll itself.

### 1. Enroll (session-authenticated, once)

```bash
curl -X POST https://tiny.technology/api/devices \
  -H "Authorization: Bearer $TINY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "shop-pi",
    "platform": "linux-arm64",
    "kind": "daemon",
    "capabilities": ["shell", "camera", "gpio"]
  }'
# → { "ok": true, "device_id": "…", "device_token": "tind_…" }   ← shown ONCE
```

- `name` is required, ≤64 chars, and is what you'll see in every UI. If the
  device also announces itself locally (a BLE beacon, an AP SSID), **use that
  same name** — otherwise the row in the cloud and the thing in the room look
  like two different devices.
- `kind` outside `cli|daemon|browser|endpoint` is silently stored as `cli`, so a
  typo doesn't fail — it just isn't the kind you meant.
- `capabilities` is clamped to 32 entries of 32 chars. Declaring past that isn't
  an error; it's silent truncation of the tail, which is exactly the interesting
  end of the list. Clamp it yourself.
- `platform` is free-form, truncated to 32 chars.

!!! tip "Enroll and provision in the same operation"

    Since the plaintext token exists for the length of one HTTP response, a
    script that flashes a board should enroll it *and* write
    `{device_id, token}` to the board in one run. Two scripts means a token
    living in your shell history, or a device that can never authenticate.

### 2. Heartbeat — every 30s

```bash
curl -X POST https://tiny.technology/api/devices/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"…","token":"tind_…","capabilities":["shell","camera"],
       "lanUrl":"http://192.168.1.170:8080"}'
```

No session: the device token in the body *is* the credential, and this route is
off the per-IP limiter because a daemon beats continuously. A wrong token 401s
without revealing whether the device id exists — and a 401 means **revoked**, so
stop beating and say so, rather than retrying forever.

`online` is derived from a 60s window, so a 30s interval survives one lost beat.

`lanUrl` is optional and is the exact inverse of an endpoint URL: **http, and a
private IPv4 literal only** (`10.x`, `172.16–31.x`, `192.168.x`, `169.254.x`). A
hostname is refused — the whole point of the field is to let your phone skip
discovery, and a name it would have to resolve is the discovery step you're
skipping. Loopback is refused too: a phone dialing `127.0.0.1` dials itself.
Omit the field and the stored value is kept; sending `""` would erase it 2880
times a day.

### 3. Poll for work — every 5s

```bash
curl -X PUT https://tiny.technology/api/devices/relay \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"…","token":"tind_…","max":10}'
# → { "ok": true, "messages": [ { "id": "…", "payload": "{\"type\":\"invoke\",\"prompt\":\"…\"}" } ] }
```

`max` is clamped to 1–50 (default 10). Delivery is **at-most-once**: an envelope
is claimed by a conditional update *before* your device runs it, so two
concurrent polls can't both execute the same command. The corollary is the honest
one — if your device dies mid-task, that envelope is gone, not retried.

Undelivered envelopes are swept after 1 hour. Replies stay redeemable for ~24h.

### 4. Reply

```bash
curl -X PATCH https://tiny.technology/api/devices/relay \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"…","token":"tind_…","inReplyTo":"<envelope id>",
       "payload":"{\"result\":\"done — 3 files changed\"}"}'
```

The payload must be **valid JSON, ≤8KB serialized** — measure the serialized
form, not the text: escaping grows a string, and a rejected PATCH means the asker
never learns the work finished at all. Images ride back as hosted URLs
(`{"result":"…","images":[{"url":"…"}]}`); the envelope itself can't carry bytes.

That's the whole contract. A device that does those four things is a
first-class member of the fleet.

### Two optional extras

- **`POST /api/devices/event`** — the *push* half, for something the device
  noticed that nobody asked for (a wake word, motion). `{deviceId, token, kind,
  detail}`, where `kind` is allowlisted (`nicla_wake`, `nicla_sentry`,
  `nicla_transcript`, `device_note`) and `detail` is truncated at 300 chars.
- **`POST /api/devices/task-result`** — a background task finished after its
  envelope already answered "started". `{deviceId, token, taskId, summary,
  result}`; `summary` ≤140 chars, `result` ≤7000. It deposits a redeemable
  ticket and fires one push notification.

## Worked example: a Nicla Vision (microcontroller)

An Arduino Nicla Vision has no OS, 512KB of usable flash, and a MicroPython
runtime — and it's a full pull device, because the contract above is four HTTP
calls.

1. **Ask the board its own name** before enrolling, and use that name. Ours call
   themselves `tiny-XXXX` (derived from the MCU's unique id) and advertise the
   same string over BLE.
2. **Refuse to enroll a duplicate.** `GET /api/devices` first; a row already
   holding that name means this board was enrolled before — adopt it instead.
   Enrollment is not idempotent, and an orphan row is permanent.
3. **Write `{device_id, token, name}` plus the WiFi list to flash in the same
   run**, then hard-reset the board. It joins WiFi, heartbeats with its
   `lanUrl`, and polls the relay from the run loop.
4. **Verify through the path the app uses**, not over USB: send a real envelope
   and read the reply. A board can be perfectly reachable on a serial cable and
   `OFFLINE` in the cloud — that's what "parked at the REPL" looks like.

!!! warning "A tick in the device's run loop is not free"

    The loop that heartbeats and polls runs ~17,000 times a day on a board like
    this. Anything you add to it — a probe, a log write, a capture — is paid at
    that rate. Ours took a board *offline* for a 96KB allocation on the wrong
    line.

## Worked example: a Bambu Lab printer (endpoint device)

The printer itself is not an endpoint device and can't be: it speaks MQTT on
your LAN, has no public HTTPS API, and is not something to expose. What you
enroll is the **authenticated dashboard in front of it** — the thing that already
holds the printer's credentials and knows how to drive it.

So the shape is:

```
tiny  ──https──▶  your dashboard (public hostname, bearer auth)  ──MQTT/LAN──▶  printer
```

**1. Serve the dashboard over HTTPS on a public hostname.** A tunnel is fine. It
must be a real name, not an IP — enrollment refuses IP literals in any encoding,
`localhost`, `.local`, `.internal`, and any dotless host, because we fetch that
URL server-side and a private address there would make the registry an SSRF
pivot. (WebAuthn also rejects raw IPs, so a passkey-protected dashboard needs a
hostname anyway.)

**2. Implement the three routes we call**, all behind
`Authorization: Bearer <secret>`:

| Action | Request | Budget | Returns |
|---|---|---|---|
| `chat` | `POST /api/chat` `{"prompt":"…"}` | 90s | `{"result"\|"reply"\|"text": "…"}` |
| `telemetry` | `GET /api/telemetry` | 20s | any JSON |
| `snapshot` | `GET /api/camera/snapshot` | 10s | one `image/jpeg`, `png` or `webp`, ≤8MB |

Only `chat` is needed for the persona to have full agency — the dashboard's chat
route is already wired to an agent holding the machine's real tools. `telemetry`
and `snapshot` are what make the device panel live.

!!! warning "Three things that will bite here"

    - **Never redirect your API.** We use `redirect: manual` and refuse a 3xx
      outright: following it would forward our bearer to another origin.
    - **Serve a real image type on the snapshot route.** Those bytes are proxied
      from our origin; anything outside the allowlist is refused rather than
      guessed at.
    - **Don't point us at a streaming endpoint.** A multipart MJPEG route yields
      frames until the client leaves, so no timeout can ever fire. Polling a
      bounded single-frame route gives the same live feeling.

**3. Mint a long-lived machine token** on the dashboard — a token whose subject
is a service, not a person, so it rides the same signed-JWT check the middleware
already enforces without an interactive passkey ceremony. Keep it in the
dashboard's own auth store so it survives restarts.

**4. Enroll it.**

```bash
curl -X POST https://tiny.technology/api/devices \
  -H "Authorization: Bearer $TINY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "workshop-printer",
    "kind": "endpoint",
    "platform": "bambu-x1c",
    "url": "https://printer.example.com",
    "secret": "<the machine token from step 3>",
    "capabilities": ["chat", "telemetry", "camera", "print"]
  }'
# → { "ok": true, "device_id": "…", "kind": "endpoint", "url": "https://printer.example.com" }
```

Note there is **no `device_token` in that reply, and its absence is not a
failure**. The `url` is normalized to an origin (a stored path would corrupt
every request built from it), and `secret` is required, ≤4096 chars, and is
write-only from every client's perspective — it is never echoed back by any
route, including your own device list. To change it, revoke and re-enroll.

!!! note "The /devices form only offers the pull kinds"

    The **Enroll** form on the web page covers `cli`, `daemon` and `browser`,
    because those need nothing but a name. An endpoint device needs a URL and a
    credential, so today it's enrolled through the API call above.

Once enrolled, the device page shows its chamber camera and telemetry live, and
`use_device` reaches it synchronously — no mailbox, no claim ticket.

### What "offline" means for an endpoint device

Nothing. It never heartbeats, so its presence is `null` — *unknown*, not
offline — until something calls it. When a call fails, three outcomes are kept
apart deliberately, because they need three different actions:

| Outcome | Meaning |
|---|---|
| `unreachable` | the connection failed — powered off, tunnel down |
| `timeout` | it answered and is **still thinking**. A robot's agent can take minutes; "check your cables" would be the wrong advice |
| `unauthorized` | it's up and rejected our credential — mint a fresh token and re-enroll |

## Revoke

```bash
curl -X DELETE https://tiny.technology/api/devices \
  -H "Authorization: Bearer $TINY_TOKEN" \
  -H 'Content-Type: application/json' -d '{"deviceId":"…"}'
```

For a pull device this is a hard kill: the stored hash stops matching, so the
next heartbeat, poll and reply all 401.

**For an endpoint device it is a hard kill on our side only.** Every lookup that
could use the stored secret requires an unrevoked row, so we stop calling it
immediately — but that bearer is still cryptographically valid at *your*
dashboard, and it is still sitting in our registry on a revoked row. If the token
leaked, revoking here is not enough: rotate the signing secret on the device.

## Status codes worth handling

| Code | Meaning |
|---|---|
| 401 | not signed in (session routes), or the device token is revoked/wrong (device routes) |
| 400 | a field is missing or refused — the body says which |
| 404 | that device isn't yours, is revoked, or doesn't exist (all three answer alike, on purpose) |
| 413 | payload over 8KB |
| 424 | the registry answered and declined, or the relay itself let us down |
| 503 | we couldn't reach the registry — **retryable** |
| 502 / 504 | endpoint device only: unreachable, or still working |

A missing device id in a "success" reply is a failure, whatever the status says:
a client that stores `undefined` as a credential installs something that
authenticates nothing, and the symptom arrives days later as an unexplained
offline device.

<div class="doors" markdown="1">

<div class="door" markdown="1">
<p class="door__t">The fleet from the user's side</p>
What a body actually buys you: senses, presence, and a visible trace on every
backgrounded action.

[Devices & senses :material-arrow-right:](../platform/devices.md){ .go }
</div>

<div class="door" markdown="1">
<p class="door__t">The tools that reach it</p>
`use_device`, the local-agent bridge, and the rest of the MCP surface.

[For developers :material-arrow-right:](index.md){ .go }
</div>

</div>
