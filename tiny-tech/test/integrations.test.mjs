/**
 * google.ts + spotify.ts + whatsapp.ts — the parts that decide what gets sent.
 *
 * All three tools are thin shells around one decision: which URL / which argv.
 * That decision is pure here, so CI can cover it with no Google account, no
 * Spotify subscription, no linked WhatsApp device and no network — the same
 * reason test/hardware.test.mjs skips the serial port.
 *
 * The failures these catch are the quiet ones: a path parameter sent as a query
 * parameter 404s on a URL that looks right, a phone number passed where a JID
 * belongs returns an empty list that reads like "no messages", and a wacli
 * failure exits 0 with the error hidden in its JSON envelope.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'

const {
  isMutative, MUTATIVE_METHODS, discoveryUrl, resolveMethod, buildRequest,
  buildServiceAccountAssertion, encodeRawEmail,
} = await import('../dist/agent/google.js')
const {
  toUri, toId, formatTrack, formatArtist, formatAlbum, formatPlayback,
  isDeprecatedArtistPath, DEPRECATED_PATHS,
} = await import('../dist/agent/spotify.js')
const {
  toJid, buildArgs, missingArgs, extractError, explainFailure, formatOutput,
} = await import('../dist/agent/whatsapp.js')

// ── google: discovery walking ───────────────────────────────────────────────

/** A miniature discovery doc with the shapes that matter: nested resources,
 *  a path template, a reserved-expansion template, mixed param locations. */
const DOC = {
  baseUrl: 'https://gmail.googleapis.com/gmail/v1/',
  resources: {
    users: {
      methods: {
        getProfile: { path: 'users/{userId}/profile', httpMethod: 'GET' },
      },
      resources: {
        messages: {
          methods: {
            list: {
              path: 'users/{userId}/messages',
              httpMethod: 'GET',
              parameters: {
                userId: { location: 'path', required: true },
                q: { location: 'query' },
                maxResults: { location: 'query' },
              },
            },
            send: { path: 'users/{userId}/messages/send', httpMethod: 'POST', request: {} },
          },
        },
      },
    },
    files: {
      methods: {
        get: { path: 'files/{+fileId}', httpMethod: 'GET' },
      },
    },
  },
}

test('resolveMethod walks a dotted resource path', () => {
  const spec = resolveMethod(DOC, 'users.messages', 'list')
  assert.equal(spec.path, 'users/{userId}/messages')
  assert.equal(spec.httpMethod, 'GET')
})

test('resolveMethod finds a method on a top-level resource', () => {
  assert.equal(resolveMethod(DOC, 'users', 'getProfile').httpMethod, 'GET')
})

test('resolveMethod names the real siblings when a resource is wrong', () => {
  // The point of the error: one round trip instead of the model guessing.
  assert.throws(() => resolveMethod(DOC, 'users.mesages', 'list'), (e) => {
    assert.match(e.message, /no resource 'mesages' on 'users'/)
    assert.match(e.message, /Available: messages/)
    return true
  })
})

test('resolveMethod says "this API" at the top level, not an empty path', () => {
  assert.throws(() => resolveMethod(DOC, 'nope', 'list'), /no resource 'nope' on this API/)
})

test('resolveMethod names the real methods when a method is wrong', () => {
  assert.throws(
    () => resolveMethod(DOC, 'users.messages', 'listAll'),
    /no method 'listAll' on 'users.messages'\. Available: list, send/,
  )
})

// ── google: request building ────────────────────────────────────────────────

test('buildRequest puts path params in the path and the rest in the query', () => {
  const req = buildRequest(DOC, resolveMethod(DOC, 'users.messages', 'list'), {
    userId: 'me', q: 'is:unread', maxResults: 5,
  })
  const url = new URL(req.url)
  assert.equal(url.origin + url.pathname, 'https://gmail.googleapis.com/gmail/v1/users/me/messages')
  assert.equal(url.searchParams.get('q'), 'is:unread')
  assert.equal(url.searchParams.get('maxResults'), '5')
  assert.equal(req.httpMethod, 'GET')
})

test('buildRequest percent-encodes a path param, slashes included', () => {
  const spec = { path: 'users/{userId}/messages', httpMethod: 'GET' }
  const req = buildRequest(DOC, spec, { userId: 'a/b c' })
  assert.match(req.url, /users\/a%2Fb%20c\/messages/)
})

test('buildRequest keeps slashes in a {+reserved} template', () => {
  // Drive/GCS ids are paths; encoding the separator would 404.
  const req = buildRequest(DOC, resolveMethod(DOC, 'files', 'get'), { fileId: 'folder/child id' })
  assert.match(req.url, /files\/folder\/child%20id/)
})

test('buildRequest reports every missing path param at once', () => {
  const spec = { path: '{a}/x/{b}', httpMethod: 'GET' }
  assert.throws(
    () => buildRequest(DOC, spec, {}),
    /missing required path parameter\(s\): a, b/,
  )
})

test('buildRequest lifts `body` out of the params, never into the query', () => {
  const req = buildRequest(DOC, resolveMethod(DOC, 'users.messages', 'send'), {
    userId: 'me', body: { raw: 'abc' },
  })
  assert.deepEqual(req.body, { raw: 'abc' })
  assert.equal(new URL(req.url).search, '')
  assert.equal(req.httpMethod, 'POST')
})

test('buildRequest repeats an array param instead of stringifying it', () => {
  const spec = { path: 'users/{userId}/messages', httpMethod: 'GET' }
  const req = buildRequest(DOC, spec, { userId: 'me', labelIds: ['INBOX', 'UNREAD'] })
  assert.deepEqual(new URL(req.url).searchParams.getAll('labelIds'), ['INBOX', 'UNREAD'])
})

test('buildRequest drops undefined/null params rather than sending "undefined"', () => {
  const spec = { path: 'users/{userId}/messages', httpMethod: 'GET' }
  const req = buildRequest(DOC, spec, { userId: 'me', q: undefined, pageToken: null })
  assert.equal(new URL(req.url).search, '')
})

test('buildRequest falls back to rootUrl + servicePath when baseUrl is absent', () => {
  const doc = { rootUrl: 'https://sheets.googleapis.com/', servicePath: 'v4/' }
  const req = buildRequest(doc, { path: 'spreadsheets/{id}', httpMethod: 'GET' }, { id: 'X' })
  assert.equal(req.url, 'https://sheets.googleapis.com/v4/spreadsheets/X')
})

// ── google: the confirm gate ────────────────────────────────────────────────

test('isMutative catches the write verbs on the leaf name only', () => {
  for (const m of ['send', 'delete', 'insert', 'batchDelete', 'users.messages.trash']) {
    assert.equal(isMutative(m), true, m)
  }
})

test('isMutative leaves reads alone, including ones spelled like writes', () => {
  // 'list'/'get' are reads; 'created' is not 'create'.
  for (const m of ['list', 'get', 'users.messages.list', 'created', 'settings.getImap']) {
    assert.equal(isMutative(m), false, m)
  }
})

test('MUTATIVE_METHODS is lowercase, since isMutative lowercases before matching', () => {
  for (const m of MUTATIVE_METHODS) assert.equal(m, m.toLowerCase())
})

test('discoveryUrl encodes the service and version', () => {
  assert.equal(
    discoveryUrl('gmail', 'v1'),
    'https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest',
  )
})

// ── google: service-account assertion ───────────────────────────────────────

test('buildServiceAccountAssertion signs the documented JWT claims', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const jwt = buildServiceAccountAssertion(
    { client_email: 'svc@p.iam.gserviceaccount.com', private_key: privateKey },
    ['https://www.googleapis.com/auth/drive'],
    1_700_000_000,
  )
  const [header, claims, signature] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), {
    iss: 'svc@p.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: 1_700_000_000,
    exp: 1_700_003_600, // Google rejects anything over an hour
  })
  assert.ok(signature.length > 300)
})

test('buildServiceAccountAssertion adds sub only for domain-wide delegation', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const sa = { client_email: 'svc@p.iam.gserviceaccount.com', private_key: privateKey }
  const withSub = JSON.parse(Buffer.from(
    buildServiceAccountAssertion(sa, [], 1, 'user@example.com').split('.')[1], 'base64url'))
  const without = JSON.parse(Buffer.from(
    buildServiceAccountAssertion(sa, [], 1).split('.')[1], 'base64url'))
  assert.equal(withSub.sub, 'user@example.com')
  assert.equal('sub' in without, false)
})

// ── google: gmail raw encoding ──────────────────────────────────────────────

test('encodeRawEmail produces a base64url RFC-2822 message', () => {
  const raw = encodeRawEmail('a@b.com', 'Hello', 'Body text')
  assert.doesNotMatch(raw, /[+/=]/) // base64url, not base64 — Gmail rejects the latter
  const decoded = Buffer.from(raw, 'base64url').toString('utf-8')
  assert.match(decoded, /^To: a@b\.com\r\n/)
  assert.match(decoded, /Content-Transfer-Encoding: base64/)
  const [headers, body] = decoded.split('\r\n\r\n')
  assert.equal(Buffer.from(body, 'base64').toString('utf-8'), 'Body text')
  assert.doesNotMatch(headers, /^From:/m)
})

test('encodeRawEmail encoded-word wraps a non-ASCII subject', () => {
  const decoded = Buffer.from(encodeRawEmail('a@b.com', 'Günaydın ☕', 'hi', 'me@x.com'), 'base64url')
    .toString('utf-8')
  const subject = decoded.split('\r\n').find((l) => l.startsWith('Subject:'))
  assert.match(subject, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
  const b64 = subject.match(/\?B\?(.*)\?=$/)[1]
  assert.equal(Buffer.from(b64, 'base64').toString('utf-8'), 'Günaydın ☕')
  assert.match(decoded, /^From: me@x\.com$/m)
})

// ── spotify: identifiers ────────────────────────────────────────────────────

test('toUri passes a URI through untouched', () => {
  assert.equal(toUri('spotify:track:4cOdK2wGLETKBW3PvgPWqT'), 'spotify:track:4cOdK2wGLETKBW3PvgPWqT')
})

test('toUri converts an open.spotify.com link, locale prefix and query included', () => {
  assert.equal(
    toUri('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc'),
    'spotify:track:4cOdK2wGLETKBW3PvgPWqT',
  )
  assert.equal(
    toUri('https://open.spotify.com/intl-tr/album/1ATL5GLyefJaxhQzSPVrLX'),
    'spotify:album:1ATL5GLyefJaxhQzSPVrLX',
  )
})

test('toUri promotes a bare 22-char id using the caller kind', () => {
  assert.equal(toUri('4cOdK2wGLETKBW3PvgPWqT', 'artist'), 'spotify:artist:4cOdK2wGLETKBW3PvgPWqT')
})

test('toUri leaves a search phrase alone — it is not an identifier', () => {
  // Guessing here would turn "play radiohead" into a 400 on a bogus URI.
  assert.equal(toUri('radiohead'), 'radiohead')
})

test('toId strips down to the bare id whatever the caller passed', () => {
  const id = '4cOdK2wGLETKBW3PvgPWqT'
  assert.equal(toId(`spotify:track:${id}`), id)
  assert.equal(toId(`https://open.spotify.com/track/${id}`), id)
  assert.equal(toId(id), id)
})

// ── spotify: formatting ─────────────────────────────────────────────────────

test('formatTrack renders name, artists, album, duration and uri', () => {
  const line = formatTrack({
    name: 'Idioteque',
    artists: [{ name: 'Radiohead' }],
    album: { name: 'Kid A' },
    duration_ms: 129_000,
    uri: 'spotify:track:x',
  }, 3)
  assert.equal(line, '3. Idioteque — Radiohead [Kid A] (2:09)  spotify:track:x')
})

test('formatTrack pads seconds so 3:05 never reads as 3:5', () => {
  assert.match(formatTrack({ name: 'x', duration_ms: 185_000 }), /\(3:05\)/)
})

test('formatTrack survives a null item instead of throwing mid-list', () => {
  assert.equal(formatTrack(null), '(unavailable)')
})

test('formatArtist and formatAlbum stay quiet about fields Spotify omitted', () => {
  assert.equal(formatArtist({ name: 'Aphex Twin' }), '• Aphex Twin')
  assert.equal(formatAlbum({ name: 'SAW II' }), '• SAW II')
  assert.match(formatArtist({ name: 'A', followers: { total: 1234567 } }), /1,234,567 followers/)
})

test('formatPlayback says "nothing playing" for the 204 the API returns when idle', () => {
  assert.equal(formatPlayback(null), 'nothing playing')
  assert.equal(formatPlayback({ device: { name: 'Mac' } }), 'nothing playing')
})

test('formatPlayback reports state, position, device and flags', () => {
  const out = formatPlayback({
    is_playing: true,
    progress_ms: 60_000,
    shuffle_state: true,
    repeat_state: 'off',
    device: { name: 'Kitchen', volume_percent: 40 },
    item: { name: 'Everything In Its Right Place', artists: [{ name: 'Radiohead' }], album: { name: 'Kid A' }, duration_ms: 251_000, uri: 'spotify:track:y' },
  })
  assert.match(out, /^▶ Everything In Its Right Place — Radiohead \[Kid A\] 1:00\/4:11 on Kitchen \(vol 40%\) · shuffle/)
  assert.match(out, /\nspotify:track:y$/)
})

test('formatPlayback marks a paused player and drops repeat:off', () => {
  const out = formatPlayback({ is_playing: false, repeat_state: 'off', item: { name: 'x', duration_ms: 1000 } })
  assert.match(out, /^⏸ /)
  assert.doesNotMatch(out, /repeat/)
})

// ── spotify: the endpoints Spotify closed in Nov 2024 ───────────────────────

test('isDeprecatedArtistPath matches only the two closed artist sub-paths', () => {
  assert.equal(isDeprecatedArtistPath('artists/abc/top-tracks'), true)
  assert.equal(isDeprecatedArtistPath('artists/abc/related-artists'), true)
  assert.equal(isDeprecatedArtistPath('artists/abc'), false)
  assert.equal(isDeprecatedArtistPath('artists/abc/albums'), false)
})

test('DEPRECATED_PATHS covers the recommendation and audio-analysis families', () => {
  for (const p of ['recommendations', 'audio-features', 'audio-analysis']) {
    assert.ok(DEPRECATED_PATHS.includes(p), p)
  }
})

// ── whatsapp: JIDs ──────────────────────────────────────────────────────────

test('toJid turns a phone number into a user JID', () => {
  assert.equal(toJid('+90 555 111 22 33'), '905551112233@s.whatsapp.net')
})

test('toJid uses the group domain when asked', () => {
  assert.equal(toJid('123456789', 'group'), '123456789@g.us')
})

test('toJid leaves an existing JID untouched', () => {
  assert.equal(toJid('905551112233@s.whatsapp.net'), '905551112233@s.whatsapp.net')
  assert.equal(toJid('1234-5678@g.us'), '1234-5678@g.us')
})

test('toJid returns non-numeric input unchanged rather than an empty domain', () => {
  assert.equal(toJid('mom'), 'mom')
})

// ── whatsapp: argv building ─────────────────────────────────────────────────

test('buildArgs sends text through --message, never a shell string', () => {
  const args = buildArgs('send_text', { to: '+15551234567', text: '`rm -rf /` & $(whoami)' })
  // The dangerous text is one argv element; execFileSync runs no shell.
  assert.deepEqual(args, ['send', 'text', '--to', '+15551234567', '--message', '`rm -rf /` & $(whoami)'])
})

test('buildArgs passes the search query positionally — wacli has no --query there', () => {
  assert.deepEqual(
    buildArgs('messages_search', { query: 'invoice', limit: 10 }),
    ['messages', 'search', 'invoice', '--limit', '10'],
  )
})

test('buildArgs uses --query for chats/groups list, where the flag does exist', () => {
  assert.deepEqual(buildArgs('chats_list', { query: 'mom' }), ['chats', 'list', '--limit', '50', '--query', 'mom'])
  assert.deepEqual(buildArgs('groups_list', { query: 'fam' }), ['groups', 'list', '--limit', '50', '--query', 'fam'])
})

test('buildArgs JID-ifies a phone number given as --chat', () => {
  // A bare number in --chat matches nothing and reads as "no messages".
  assert.deepEqual(
    buildArgs('messages_list', { chat: '905551112233', limit: 5 }),
    ['messages', 'list', '--limit', '5', '--chat', '905551112233@s.whatsapp.net'],
  )
})

test('buildArgs uses the group domain for group commands', () => {
  assert.deepEqual(
    buildArgs('groups_info', { jid: '123456789' }),
    ['groups', 'info', '--jid', '123456789@g.us'],
  )
})

test('buildArgs omits optional flags the caller left out', () => {
  assert.deepEqual(buildArgs('messages_list', {}), ['messages', 'list', '--limit', '50'])
  assert.deepEqual(
    buildArgs('send_file', { to: '1', file_path: '/tmp/a.png' }),
    ['send', 'file', '--to', '1', '--file', '/tmp/a.png'],
  )
})

test('buildArgs carries every send_file option through when given', () => {
  assert.deepEqual(
    buildArgs('send_file', { to: '1', file_path: '/tmp/a.png', caption: 'hi', filename: 'b.png', mime: 'image/png' }),
    ['send', 'file', '--to', '1', '--file', '/tmp/a.png', '--caption', 'hi', '--filename', 'b.png', '--mime', 'image/png'],
  )
})

test('buildArgs defaults the message-context window', () => {
  assert.deepEqual(
    buildArgs('messages_context', { chat: 'x@g.us', message_id: 'M1' }),
    ['messages', 'context', '--chat', 'x@g.us', '--id', 'M1', '--before', '5', '--after', '5'],
  )
})

test('buildArgs rejects an unknown action instead of spawning wacli', () => {
  assert.throws(() => buildArgs('delete_everything', {}), /unknown action: delete_everything/)
})

test('missingArgs names all the missing required args for that action', () => {
  assert.deepEqual(missingArgs('send_text', {}), ['to', 'text'])
  assert.deepEqual(missingArgs('send_text', { to: '1' }), ['text'])
  assert.deepEqual(missingArgs('send_text', { to: '1', text: 'hi' }), [])
  // An empty string is missing too — wacli would send a blank message.
  assert.deepEqual(missingArgs('send_text', { to: '1', text: '' }), ['text'])
})

test('missingArgs asks nothing of the actions that take nothing', () => {
  assert.deepEqual(missingArgs('doctor', {}), [])
  assert.deepEqual(missingArgs('sync', {}), [])
})

// ── whatsapp: wacli's exit-0 failures ───────────────────────────────────────

test('extractError finds the error inside a success:false envelope', () => {
  assert.equal(
    extractError('{"success":false,"error":"websocket disconnected"}'),
    'websocket disconnected',
  )
})

test('extractError returns null for a successful envelope or plain text', () => {
  assert.equal(extractError('{"success":true,"data":[]}'), null)
  assert.equal(extractError('not json at all'), null)
  assert.equal(extractError(''), null)
})

test('extractError does not mistake the word "error" in data for a failure', () => {
  // A message whose text mentions an error is not a failed call.
  assert.equal(extractError('{"success":true,"data":[{"text":"error: build failed"}]}'), null)
})

test('explainFailure turns an expired linked device into an instruction', () => {
  const out = explainFailure('not authenticated', 'send_text', 30_000)
  assert.match(out, /wacli auth/)
  assert.match(out, /cannot do it/) // the QR scan needs a TTY
})

test('explainFailure says a dropped send did NOT go through', () => {
  const out = explainFailure('websocket disconnected', 'send_text', 30_000)
  assert.match(out, /NOT sent/)
  assert.match(out, /doctor/)
})

test('explainFailure points at the other wacli process when the store is locked', () => {
  assert.match(explainFailure('database is locked', 'sync', 90_000), /locked by another wacli process/)
})

test('explainFailure falls back to naming the action and the message', () => {
  assert.equal(explainFailure('weird thing', 'groups_info', 60_000), 'wacli groups_info failed: weird thing')
})

// ── whatsapp: output shaping ────────────────────────────────────────────────

test('formatOutput unwraps the envelope so the model reads data, not plumbing', () => {
  const out = formatOutput('{"success":true,"data":[{"jid":"1@s.whatsapp.net","name":"Mom"}]}')
  assert.deepEqual(JSON.parse(out), [{ jid: '1@s.whatsapp.net', name: 'Mom' }])
})

test('formatOutput says "(no results)" instead of a wall of nulls', () => {
  assert.equal(formatOutput('{"success":true,"data":null}'), '(no results)')
  assert.equal(formatOutput('{"success":true,"data":[]}'), '(no results)')
  assert.equal(formatOutput('[]'), '(no results)')
})

test('formatOutput distinguishes an empty message list', () => {
  assert.equal(formatOutput('{"success":true,"data":{"messages":null}}'), '(no messages)')
})

test('formatOutput hands back non-JSON and empty output as-is', () => {
  assert.equal(formatOutput('wacli version 1.2.3'), 'wacli version 1.2.3')
  assert.equal(formatOutput('   '), '(no output)')
})
