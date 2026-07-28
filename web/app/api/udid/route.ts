/**
 * /api/udid — UDID enrollment (over-the-air device registration).
 *
 * Flow (Apple "Profile Service" mechanism, the pre-TestFlight classic):
 *   1. Visitor on /ios taps "Register my device" → GET /api/udid?profile=1
 *      serves a .mobileconfig (Profile Service payload)
 *   2. iOS Settings prompts install → the DEVICE posts a PKCS7-signed
 *      plist (containing UDID/PRODUCT/VERSION) to POST /api/udid
 *   3. We extract the UDID, store it in KV, and 301 the device's Safari
 *      to /ios/registered.html?udid=… (Apple requires the redirect)
 *   4. Owner registers the UDID in the Apple dev portal, re-signs, and
 *      the visitor installs from /ios like any provisioned device.
 *
 * GET  ?profile=1  → the .mobileconfig
 * GET  ?list=1     → enrolled UDIDs (session-gated, owner review)
 * POST             → device callback (PKCS7 plist → UDID extraction)
 */
import { kv } from '@vercel/kv'
import { getSession } from '@/lib/auth'

export const runtime = 'edge'

/**
 * The enrolled-UDID roster is device-fingerprinting PII (each row is a real
 * device's hardware UDID + product + iOS version). "?list=1" was documented as
 * "owner review" but the guard only checked that SOME session existed — so ANY
 * logged-in user could enumerate every beta tester's device. It must be gated
 * to the site owner. Owner login(s) come from OWNER_LOGIN (comma-separated,
 * case-insensitive) and default to the repo owner used everywhere else
 * (chat/route.ts TOOL_REPO_ALLOWLIST). Pure so the gate is unit-testable.
 */
export function isOwnerLogin(login: unknown, ownerEnv?: string): boolean {
  if (typeof login !== 'string' || login === '') return false
  const owners = (ownerEnv || 'cagataycali')
    .split(',')
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean)
  return owners.includes(login.toLowerCase())
}

const PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<dict>
		<key>URL</key>
		<string>https://tiny.technology/api/udid</string>
		<key>DeviceAttributes</key>
		<array>
			<string>UDID</string>
			<string>PRODUCT</string>
			<string>VERSION</string>
		</array>
	</dict>
	<key>PayloadOrganization</key>
	<string>tiny.technology</string>
	<key>PayloadDisplayName</key>
	<string>tiny — device registration</string>
	<key>PayloadDescription</key>
	<string>One-time registration: sends this device's UDID to tiny.technology so a development build of the tiny app can be signed for it. You can delete this profile immediately after.</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
	<key>PayloadUUID</key>
	<string>7f3a1c2e-tiny-udid-enroll-0001</string>
	<key>PayloadIdentifier</key>
	<string>technology.tiny.udid-enroll</string>
	<key>PayloadType</key>
	<string>Profile Service</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
</dict>
</plist>`

export async function GET(req: Request) {
  const url = new URL(req.url)

  if (url.searchParams.get('profile') === '1') {
    return new Response(PROFILE, {
      headers: {
        // The magic content type — Safari hands it to Settings
        'Content-Type': 'application/x-apple-aspen-config',
        'Content-Disposition': 'attachment; filename="tiny-register.mobileconfig"',
      },
    })
  }

  if (url.searchParams.get('list') === '1') {
    // Owner review — session-gated, OR machine auth for the build bot
    // (x-enroll-key header = ENROLL_SECRET env, same pattern as cron)
    const machineKey = req.headers.get('x-enroll-key')
    const machineOk = !!process.env.ENROLL_SECRET && machineKey === process.env.ENROLL_SECRET
    const session = machineOk ? null : await getSession(req)
    if (!machineOk) {
      // Owner-only: the roster is device-fingerprinting PII, not just
      // login-gated data. A plain authenticated session is NOT enough — any
      // user could otherwise enumerate every enrolled device.
      if (!session) return json({ error: 'login required' }, 401)
      if (!isOwnerLogin(session.login, process.env.OWNER_LOGIN)) {
        return json({ error: 'not found' }, 404)
      }
    }
    const udids = await kv.smembers('ios_udids').catch(() => [] as string[])
    const rows = await Promise.all(
      (udids as string[]).map(async (u) => ({
        udid: u,
        meta: await kv.get(`ios_udid:${u}`).catch(() => null),
      }))
    )
    return json({ ok: true, devices: rows })
  }

  if (url.searchParams.get('count') === '1') {
    // Public: how many of the 100 beta spots are taken (number only)
    const count = (await kv.scard('ios_udids').catch(() => 0)) as number
    return json({ ok: true, enrolled: count, cap: 100 })
  }

  return json({ error: 'use ?profile=1, ?list=1 or ?count=1' }, 400)
}

export async function POST(req: Request) {
  // Device posts PKCS7(DER) with the plist embedded as plaintext — the
  // battle-tested extraction is a byte-string regex, no ASN.1 needed.
  const buf = await req.arrayBuffer().catch(() => null)
  if (!buf || buf.byteLength > 100_000) return json({ error: 'bad body' }, 400)

  let text = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i])

  const udid = matchKey(text, 'UDID')
  const product = matchKey(text, 'PRODUCT')
  const version = matchKey(text, 'VERSION')

  // UDIDs: 40-hex (pre-XS) or 8-16 dashed (iPhone XS / A12 and later — a
  // single dash, e.g. 00008101-001D45EA0168001E, NOT the 8-4-16 UUID shape).
  // Validate — this is an unauthenticated endpoint and the value lands in KV
  // + a redirect.
  if (!udid || !/^([0-9a-f]{40}|[0-9a-f]{8}-[0-9a-f]{16})$/i.test(udid)) {
    return json({ error: 'no valid UDID in payload' }, 400)
  }

  // Cap total enrollments (Apple's yearly device cap is 100 anyway) so
  // the set can't be flooded.
  const count = (await kv.scard('ios_udids').catch(() => 0)) as number
  if (count < 200) {
    await kv.sadd('ios_udids', udid).catch(() => {})
    await kv
      .set(`ios_udid:${udid}`, { product, version, at: Date.now() }, { ex: 60 * 60 * 24 * 90 })
      .catch(() => {})
  }

  // Apple's flow: respond 301 → device opens the URL in Safari
  return new Response(null, {
    status: 301,
    headers: {
      Location: `https://tiny.technology/ios/registered.html?udid=${encodeURIComponent(udid)}`,
    },
  })
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function matchKey(text: string, key: string): string | null {
  const m = text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))
  return m ? m[1] : null
}
