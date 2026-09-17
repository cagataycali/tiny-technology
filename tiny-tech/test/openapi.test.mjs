/**
 * use_openapi — the parts that decide where a request goes and what it carries.
 *
 * The tool's whole value is that it refuses to guess: the request builder and
 * the credential rules are pure functions, tested here without a network, and
 * the end-to-end half runs against a local node:http echo server so a "the
 * header was attached" claim is a real header on a real request.
 *
 * Four of these tests exist because devduck's version does the opposite:
 *   - `load` must not print 450 operations into the context window
 *   - an unknown parameter must be refused, not silently appended as a query
 *   - a $ref'd request body must come back as fields, not as {"$ref": …}
 *   - a stored token must not follow the spec to a host it wasn't issued for
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const oa = await import('../dist/agent/openapi.js')
const {
  specUrlToRaw, baseUrlFor, resolveRef, extractOperations, securityFor, securitySchemes,
  searchOperations, tagGroups, closest, buildCall, bodyContentType, applyAuth,
  summarizeSchema, describeOperation, formatOperationLine, clampBody, redact, isExpired,
  aliasFor, saveCred, loadCred, forgetCred, listCreds, buildAuthorizeUrl, credFromTokenResponse,
  makeOpenapiTool, hasOpenapi, resetSpecs, openapiDir,
} = oa

// Every credential and spec cache written by this file lands in a temp dir.
const HOME = mkdtempSync(join(tmpdir(), 'tiny-openapi-'))
process.env.TINY_OPENAPI_DIR = HOME
process.on('exit', () => rmSync(HOME, { recursive: true, force: true }))

// ── a small spec, used by the pure tests ────────────────────────────────────

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Tiny API', version: '1.0.0' },
  servers: [{ url: 'https://api.tiny.example/v2' }],
  paths: {
    '/things': {
      get: {
        operationId: 'listThings', summary: 'List things', tags: ['things'],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'tag', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
          { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
          { name: 'session', in: 'cookie', schema: { type: 'string' } },
        ],
      },
      post: {
        operationId: 'createThing', tags: ['things'],
        parameters: [{ name: 'dry_run', in: 'query', schema: { type: 'boolean' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } },
        security: [{ ApiKeyAuth: [] }],
      },
    },
    '/things/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'getThing', tags: ['things'] },
      delete: { operationId: 'deleteThing', deprecated: true, tags: ['things'] },
    },
    '/search': {
      get: {
        operationId: 'searchThings', summary: 'Search everything', tags: ['search'],
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
      },
    },
    '/form': {
      post: {
        operationId: 'submitForm',
        requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { To: { type: 'string' } } } } } },
      },
    },
    '/health': { get: { security: [], tags: [] } },
  },
  components: {
    securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    schemas: {
      Thing: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'what it is called' },
          kind: { type: 'string', enum: ['big', 'small'], default: 'small' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      Loop: { type: 'object', properties: { self: { $ref: '#/components/schemas/Loop' } } },
      SelfRef: { $ref: '#/components/schemas/SelfRef' },
    },
  },
}
const OPS = extractOperations(SPEC)
const op = (id) => {
  const o = OPS.get(id)
  assert.ok(o, `fixture has no operation ${id}`)
  return o
}

// ── locating the spec ───────────────────────────────────────────────────────

test('a GitHub blob URL is converted to raw — everyone pastes the HTML page', () => {
  assert.equal(
    specUrlToRaw('https://github.com/stripe/openapi/blob/master/openapi/spec3.json'),
    'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
  )
  assert.equal(specUrlToRaw('https://api.example.com/openapi.json'), 'https://api.example.com/openapi.json')
})

test('base URL: servers, server variables, relative, and Swagger 2.0', () => {
  assert.equal(baseUrlFor(SPEC), 'https://api.tiny.example/v2')
  // devduck sends the literal `{region}` to DNS. The default is right there.
  assert.equal(
    baseUrlFor({ servers: [{ url: 'https://{region}.api.example.com/{ver}', variables: { region: { default: 'eu' }, ver: { enum: ['v1'] } } }] }),
    'https://eu.api.example.com/v1',
  )
  assert.equal(baseUrlFor({ servers: [{ url: '/v3' }] }, 'https://petstore.example/openapi.yaml'), 'https://petstore.example/v3')
  assert.equal(baseUrlFor({ swagger: '2.0', host: 'api.example.com', basePath: '/v1', schemes: ['https'] }), 'https://api.example.com/v1')
  assert.equal(baseUrlFor({ swagger: '2.0', host: 'api.example.com' }), 'https://api.example.com', 'https when the spec forgot schemes')
  assert.equal(baseUrlFor({}, 'https://api.example.com/spec.json'), 'https://api.example.com', 'fall back to where the spec came from')
  assert.equal(baseUrlFor({}), '')
  assert.equal(baseUrlFor({ servers: [{ url: 'https://api.tiny.example/v2/' }] }), 'https://api.tiny.example/v2', 'no double slash later')
})

test('$ref resolution follows JSON Pointer rules and survives cycles', () => {
  assert.equal(resolveRef(SPEC, '#/components/schemas/Thing').required[0], 'name')
  assert.equal(resolveRef(SPEC, '#/paths/~1things/get/operationId'), 'listThings', '~1 is a slash')
  assert.equal(resolveRef(SPEC, '#/paths/%2Fthings/get/operationId'), 'listThings', 'percent-encoded too')
  assert.equal(resolveRef(SPEC, '#/components/schemas/Nope'), null, 'missing is null, not a crash')
  assert.equal(resolveRef(SPEC, 'other.yaml#/Thing'), null, 'an external document is out of reach')
  const seen = new Set(['#/components/schemas/SelfRef'])
  assert.equal(resolveRef(SPEC, '#/components/schemas/SelfRef', seen), null, 'a cycle stops')
})

// ── reading operations ──────────────────────────────────────────────────────

test('every operation is found, with method and path', () => {
  assert.deepEqual([...OPS.keys()].sort(), ['createThing', 'deleteThing', 'getThing', 'get_health', 'listThings', 'searchThings', 'submitForm'])
  assert.equal(op('getThing').method, 'GET')
  assert.equal(op('createThing').path, '/things')
})

test('an operation with no operationId gets a usable one', () => {
  assert.ok(OPS.has('get_health'), 'braces and slashes become a name, not a crash')
})

test('path-level parameters are inherited by every method under it', () => {
  // The commonest real shape: `id` is declared once for the whole path item.
  for (const id of ['getThing', 'deleteThing']) {
    assert.deepEqual(op(id).parameters.map((p) => p.name), ['id'], id)
    assert.equal(op(id).parameters[0].required, true)
  }
})

test('operation-level security overrides the root, and [] means none', () => {
  const rooted = { ...SPEC, security: [{ ApiKeyAuth: [] }] }
  assert.deepEqual(securityFor(rooted, extractOperations(rooted).get('listThings')), [{ ApiKeyAuth: [] }], 'inherits the root')
  assert.deepEqual(securityFor(rooted, extractOperations(rooted).get('get_health')), [], 'an explicit [] opts out')
  assert.deepEqual(securityFor(SPEC, op('createThing')), [{ ApiKeyAuth: [] }])
  assert.deepEqual(securityFor(SPEC, op('listThings')), [], 'no root security, none declared')
})

test('securitySchemes reads OpenAPI 3 and Swagger 2 alike', () => {
  assert.equal(securitySchemes(SPEC).ApiKeyAuth.name, 'X-API-Key')
  assert.equal(securitySchemes({ securityDefinitions: { k: { type: 'apiKey' } } }).k.type, 'apiKey')
})

// ── search: the fix for "load printed 900 operations" ───────────────────────

test('search finds operations by intent, not by operationId', () => {
  assert.equal(searchOperations(OPS, 'search everything')[0].id, 'searchThings')
  assert.equal(searchOperations(OPS, 'listThings')[0].id, 'listThings')
  assert.equal(searchOperations(OPS, '/things/{id}')[0].path, '/things/{id}')
  assert.deepEqual(searchOperations(OPS, 'zzzzz'), [], 'no pretend matches')
})

test('a method in the query filters, and deprecated operations sink', () => {
  const hits = searchOperations(OPS, 'things')
  const ids = hits.map((h) => h.id)
  assert.ok(ids.length >= 4)
  assert.equal(ids[ids.length - 1], 'deleteThing', 'the deprecated one ranks last of the matches')
  assert.equal(searchOperations(OPS, 'DELETE things')[0].id, 'deleteThing', 'asked for explicitly, it wins')
})

test('search honours a limit — a spec with 900 matches must not answer with 900', () => {
  assert.equal(searchOperations(OPS, '', 3).length, 3)
})

test('tag groups are the cheap map of an API', () => {
  // submitForm and /health carry no tags — an untagged group is honest about
  // them rather than dropping them out of the map.
  assert.deepEqual(tagGroups(OPS), [['things', 4], ['(untagged)', 2], ['search', 1]])
})

// ── building a call ─────────────────────────────────────────────────────────

const B = 'https://api.tiny.example/v2'

test('parameters land where the spec says they go', () => {
  const call = buildCall(SPEC, B, op('listThings'), { limit: 5, 'X-Trace': 'abc', session: 's1' })
  assert.equal(call.method, 'GET')
  assert.equal(call.url, `${B}/things?limit=5`)
  assert.equal(call.headers['X-Trace'], 'abc')
  assert.equal(call.headers.cookie, 'session=s1')
  assert.deepEqual(call.missing, [])
  assert.deepEqual(call.unknown, [])
})

test('a path parameter is substituted and URL-encoded', () => {
  assert.equal(buildCall(SPEC, B, op('getThing'), { id: 'a/b c' }).url, `${B}/things/a%2Fb%20c`)
})

test('an array query parameter repeats, as its default style says', () => {
  assert.equal(buildCall(SPEC, B, op('listThings'), { tag: ['x', 'y'] }).url, `${B}/things?tag=x&tag=y`)
})

test('a missing required parameter is refused before the request — in any location', () => {
  // devduck only checked path parameters, so a missing required query param
  // became a 400 the model had to reverse-engineer from the response body.
  assert.deepEqual(buildCall(SPEC, B, op('searchThings'), {}).missing, ['q (query)'])
  assert.deepEqual(buildCall(SPEC, B, op('getThing'), {}).missing, ['id (path)'])
  assert.equal(buildCall(SPEC, B, op('getThing'), {}).url.includes('{id}'), true,
    'the URL is never requested, so a leftover template is only a marker')
})

test('an unknown parameter on a GET is refused, with the closest real name', () => {
  const call = buildCall(SPEC, B, op('listThings'), { limt: 5 })
  assert.deepEqual(call.unknown, [{ name: 'limt', didYouMean: 'limit' }])
  assert.equal(call.url.includes('limt'), false, 'and it is NOT appended as a query parameter')
})

test('did-you-mean stays quiet when nothing is close', () => {
  assert.equal(buildCall(SPEC, B, op('listThings'), { wildly_unrelated: 1 }).unknown[0].didYouMean, null)
  assert.equal(closest('limit', ['limit']), 'limit')
  assert.equal(closest('xyz', ['limit', 'offset']), null)
})

test('a path template the spec never declared is refused, not requested literally', () => {
  const spec = { paths: { '/a/{missing}': { get: { operationId: 'x' } } } }
  const ops = extractOperations(spec)
  assert.deepEqual(buildCall(spec, B, ops.get('x'), {}).missing, ['missing (path, undeclared in spec)'])
  assert.equal(buildCall(spec, B, ops.get('x'), { missing: 'ok' }).url, `${B}/a/ok`, 'supplied anyway, it works')
})

test('leftover parameters become the body of a POST, and query params still work', () => {
  const call = buildCall(SPEC, B, op('createThing'), { name: 'thing', dry_run: true })
  assert.equal(call.url, `${B}/things?dry_run=true`, 'the declared query parameter did not fall into the body')
  assert.deepEqual(JSON.parse(call.body), { name: 'thing' })
  assert.equal(call.contentType, 'application/json')
  assert.deepEqual(call.unknown, [], 'body fields are not unknown parameters')
})

test('an explicit body wins over params, which stay parameters', () => {
  const call = buildCall(SPEC, B, op('createThing'), { dry_run: true }, { name: 'explicit' })
  assert.deepEqual(JSON.parse(call.body), { name: 'explicit' })
  assert.equal(call.url, `${B}/things?dry_run=true`)
})

test('a form-encoded body is form-encoded — this is Twilio', () => {
  assert.equal(bodyContentType(op('submitForm').requestBody), 'application/x-www-form-urlencoded')
  const call = buildCall(SPEC, B, op('submitForm'), { To: '+1 555', Tags: ['a', 'b'] })
  assert.equal(call.body, 'To=%2B1+555&Tags=a&Tags=b')
  assert.equal(call.contentType, 'application/x-www-form-urlencoded')
})

test('JSON is preferred when the body offers several media types', () => {
  assert.equal(bodyContentType({ content: { 'text/plain': {}, 'application/json': {} } }), 'application/json')
  assert.equal(bodyContentType({ content: { 'text/csv': {} } }), 'text/csv')
  assert.equal(bodyContentType(undefined), 'application/json')
})

// ── credentials: the refusals ───────────────────────────────────────────────

const cred = (over = {}) => ({ type: 'api_key', hosts: ['api.tiny.example'], api_key: 'sk_test_123', ...over })

test('an apiKey goes exactly where the scheme says', () => {
  const h = applyAuth(SPEC, op('createThing'), `${B}/things`, {}, cred())
  assert.equal(h.headers['X-API-Key'], 'sk_test_123')
  assert.equal(h.applied, 'apiKey X-API-Key (header)')

  const qSpec = { ...SPEC, components: { securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'query', name: 'api_key' } } } }
  const q = applyAuth(qSpec, extractOperations(qSpec).get('createThing'), `${B}/things`, {}, cred())
  assert.ok(q.url.endsWith('?api_key=sk_test_123'), q.url)
  assert.equal(q.headers['X-API-Key'], undefined, 'not both')

  const cSpec = { ...SPEC, components: { securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'cookie', name: 'sid' } } } }
  const c = applyAuth(cSpec, extractOperations(cSpec).get('createThing'), `${B}/things`, {}, cred())
  assert.equal(c.headers.cookie, 'sid=sk_test_123')
})

test('http bearer, basic, and oauth2 schemes each get the right header', () => {
  const withScheme = (scheme) => ({ ...SPEC, components: { securitySchemes: { ApiKeyAuth: scheme } } })
  const bearerSpec = withScheme({ type: 'http', scheme: 'bearer' })
  assert.equal(
    applyAuth(bearerSpec, extractOperations(bearerSpec).get('createThing'), `${B}/x`, {}, cred({ type: 'bearer', api_key: undefined, access_token: 'tok' })).headers.authorization,
    'Bearer tok',
  )
  const basicSpec = withScheme({ type: 'http', scheme: 'basic' })
  assert.equal(
    applyAuth(basicSpec, extractOperations(basicSpec).get('createThing'), `${B}/x`, {}, cred({ type: 'basic', api_key: undefined, username: 'u', password: 'p' })).headers.authorization,
    `Basic ${Buffer.from('u:p').toString('base64')}`,
  )
  const oauthSpec = withScheme({ type: 'oauth2', flows: {} })
  assert.equal(
    applyAuth(oauthSpec, extractOperations(oauthSpec).get('createThing'), `${B}/x`, {}, cred({ type: 'oauth2', api_key: undefined, access_token: 'at' })).headers.authorization,
    'Bearer at',
  )
})

test('a spec that declares no scheme still gets the credential the user stored', () => {
  const bare = { paths: { '/x': { get: { operationId: 'g' } } } }
  const out = applyAuth(bare, extractOperations(bare).get('g'), `${B}/x`, {}, cred({ type: 'bearer', api_key: 'k' }))
  assert.equal(out.headers.authorization, 'Bearer k')
  assert.match(out.applied, /spec declared none/)
})

test('a credential is NOT sent to a host it was not issued for', () => {
  // The attack devduck is open to: the spec is untrusted input, and
  // `servers[0].url` in it decides where the stored token goes.
  const out = applyAuth(SPEC, op('createThing'), 'https://evil.example/things', {}, cred())
  assert.equal(out.headers['X-API-Key'], undefined, 'nothing was attached')
  assert.match(out.refusal, /authorised for api\.tiny\.example/)
  assert.match(out.refusal, /evil\.example/)
  assert.match(out.refusal, /allow_host/, 'and says how to allow it deliberately')
})

test('a credential never crosses plaintext http, except to loopback', () => {
  assert.match(applyAuth(SPEC, op('createThing'), 'http://api.tiny.example/things', {}, cred()).refusal, /plaintext http/)
  const local = applyAuth(SPEC, op('createThing'), 'http://127.0.0.1:8080/things', {}, cred({ hosts: ['127.0.0.1:8080'] }))
  assert.equal(local.refusal, undefined, 'a dev server on loopback is fine')
  assert.equal(local.headers['X-API-Key'], 'sk_test_123')
})

test('an operation declaring security: [] gets no credential', () => {
  // A login or token endpoint can reject a request that arrives already
  // authenticated, and `security: []` is how a spec says "not here".
  const out = applyAuth(SPEC, op('get_health'), `${B}/health`, {}, cred())
  assert.equal(out.headers['X-API-Key'], undefined)
  assert.match(out.applied, /operation declares no auth/)
})

test('when nothing is required, the spec\'s own scheme still beats a blind bearer', () => {
  // The `raw` path, and specs that declare schemes without attaching them: an
  // Authorization header on an X-API-Key API is a 401 with no explanation.
  const out = applyAuth(SPEC, null, `${B}/anything`, {}, cred())
  assert.equal(out.headers['X-API-Key'], 'sk_test_123')
  assert.equal(out.headers.authorization, undefined)
})

test('no credential means no auth and no complaint', () => {
  const out = applyAuth(SPEC, op('listThings'), `${B}/things`, {}, null)
  assert.equal(out.applied, 'none')
  assert.equal(out.refusal, undefined)
})

test('credentials round-trip to disk, redacted when shown, and delete', () => {
  saveCred('roundtrip', cred({ access_token: 'a'.repeat(40) }))
  assert.equal(loadCred('roundtrip').api_key, 'sk_test_123')
  assert.ok(listCreds().some((c) => c.alias === 'roundtrip'))
  assert.equal(redact('a'.repeat(40)), `aaaaaa…aaaa (40 chars)`)
  assert.equal(redact('short'), '***', 'a short secret gives away nothing')
  assert.equal(redact(undefined), '(none)')
  assert.equal(forgetCred('roundtrip'), true)
  assert.equal(loadCred('roundtrip'), null)
  assert.equal(forgetCred('roundtrip'), false, 'deleting what is not there is not a success')
})

test('expiry has slack, because a token that dies mid-flight is a 401', () => {
  assert.equal(isExpired({ hosts: [] }), false, 'no expiry means it does not expire')
  assert.equal(isExpired({ hosts: [], expires_at: 5_000_000 }, 4_000_000), false)
  assert.equal(isExpired({ hosts: [], expires_at: 5_000_000 }, 4_990_000), true, 'expiring in 10s counts as expired')
})

test('an OAuth authorize URL carries state and PKCE', () => {
  const u = new URL(buildAuthorizeUrl('https://id.example/authorize', {
    clientId: 'cid', redirectUri: 'http://127.0.0.1:1234/callback', scopes: ['a', 'b'], state: 'st', challenge: 'ch',
  }))
  assert.equal(u.searchParams.get('response_type'), 'code')
  assert.equal(u.searchParams.get('scope'), 'a b')
  assert.equal(u.searchParams.get('state'), 'st')
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
})

test('a token response becomes a host-bound credential with an absolute expiry', () => {
  const c = credFromTokenResponse({ access_token: 'at', expires_in: 3600, token_type: 'Bearer' }, ['api.tiny.example'])
  assert.deepEqual(c.hosts, ['api.tiny.example'])
  assert.ok(c.expires_at > Date.now() + 3_500_000, 'expires_in became a clock time')
})

// ── describing an operation ─────────────────────────────────────────────────

test('describe resolves the body $ref into the fields a caller must send', () => {
  // devduck resolved refs for parameters only, so a POST body came back as
  // {"$ref": "#/components/schemas/Thing"} and the model guessed field names.
  const text = describeOperation(SPEC, { alias: 'tiny', base: B }, op('createThing'))
  assert.match(text, /POST https:\/\/api\.tiny\.example\/v2\/things/)
  assert.doesNotMatch(text, /\$ref/, 'no unresolved reference reaches the model')
  assert.match(text, /name: string {2}\(required; what it is called\)/)
  assert.match(text, /kind: string.*one of big \| small; default "small"/)
  assert.match(text, /auth: ApiKeyAuth \(apiKey\)/)
  assert.match(text, /dry_run: query, boolean/)
  assert.match(text, /action='call'.*operation='createThing'/, 'ends with the call it just described')
})

test('describe says "none" rather than leaving parameters unmentioned', () => {
  assert.match(describeOperation(SPEC, { alias: 'tiny', base: B }, op('get_health')), /parameters: none/)
})

test('a recursive schema is summarised, not chased forever', () => {
  const lines = summarizeSchema(SPEC, { $ref: '#/components/schemas/Loop' }).join('\n')
  assert.match(lines, /self: object/)
  const bad = summarizeSchema(SPEC, { $ref: '#/components/schemas/Missing' }).join('\n')
  assert.match(bad, /unresolved \$ref/, 'and an unreachable one is admitted, not silently empty')
})

test('allOf is flattened and oneOf is named', () => {
  const spec = { components: { schemas: {} } }
  const all = summarizeSchema(spec, { allOf: [{ properties: { a: { type: 'string' } } }, { properties: { b: { type: 'integer' } } }] }).join('\n')
  assert.match(all, /a: string/)
  assert.match(all, /b: integer/)
  assert.match(summarizeSchema(spec, { oneOf: [{ type: 'string' }, { type: 'integer' }] }).join('\n'), /one of 2 variants/)
})

test('an operation line is one line, with the summary trimmed', () => {
  const line = formatOperationLine(op('deleteThing'))
  assert.equal(line.includes('\n'), false)
  assert.match(line, /DELETE.*\/things\/\{id\}.*deleteThing.*deprecated/)
})

test('output is clamped with an honest tail, not silently cut', () => {
  const out = clampBody('x'.repeat(100), 10)
  assert.match(out, /^x{10}\n…\[truncated 90 of 100 characters\]$/)
  assert.equal(clampBody('short', 10), 'short')
})

test('an alias is derived from the spec, or the URL, and is always usable', () => {
  assert.equal(aliasFor({ info: { title: 'Stripe API' } }), 'stripe_api')
  assert.equal(aliasFor({}, undefined, 'https://api.github.com/openapi.json'), 'api_github_com')
  assert.equal(aliasFor({ info: { title: '!!!' } }), 'api', 'never an empty alias')
  assert.equal(aliasFor({ info: { title: 'Stripe' } }, 'mine'), 'mine')
})

// ── end to end, against a real HTTP server ─────────────────────────────────

const requests = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body })
    if (req.url.startsWith('/missing')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"no such thing"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ echo: { method: req.method, url: req.url, auth: req.headers['x-api-key'] || null, body } }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const HOST = `127.0.0.1:${PORT}`
test.after(() => server.close())

// The fixture is YAML on purpose: it proves the zero-dependency reader feeds
// the tool, which is the case devduck can't handle without `pip install pyyaml`.
const SPEC_FILE = join(HOME, 'tiny.yaml')
writeFileSync(SPEC_FILE, `openapi: 3.0.3
info:
  title: Echo API
  version: 1.0.0
servers:
  - url: http://${HOST}
paths:
  /things:
    get:
      operationId: listThings
      summary: List every thing
      tags: [things]
      parameters:
        - name: limit
          in: query
          schema: {type: integer}
    post:
      operationId: createThing
      summary: Create a thing
      tags: [things]
      security: [{ApiKeyAuth: []}]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Thing"
  /search:
    get:
      operationId: searchThings
      summary: Search
      tags: [search]
      parameters:
        - name: q
          in: query
          required: true
          schema: {type: string}
  /missing:
    get:
      operationId: missingThing
      tags: [errors]
components:
  securitySchemes:
    ApiKeyAuth: {type: apiKey, in: header, name: X-API-Key}
  schemas:
    Thing:
      type: object
      required: [name]
      properties:
        name: {type: string}
`)

const T = makeOpenapiTool()
const run = (args) => T._callback(args)

test('the tool is available without any binary to install', () => {
  assert.equal(hasOpenapi(), true)
  assert.equal(T.name, 'use_openapi')
  assert.ok(openapiDir().startsWith(HOME) || openapiDir() === HOME)
})

test('load reads a YAML spec and answers with the API\'s SHAPE, not every operation', async () => {
  resetSpecs()
  const out = await run({ action: 'load', spec_url: SPEC_FILE, alias: 'echo' })
  assert.match(out, /Echo API v1\.0\.0 loaded as 'echo'/)
  assert.match(out, /4 operations across 3 tag group/)
  assert.match(out, /base URL: http:\/\/127\.0\.0\.1:/)
  assert.match(out, /auth: ApiKeyAuth \(apiKey\)/)
  assert.match(out, /things\s+2/, 'tag groups are the map')
  // The devduck behaviour this replaces: one line per operation, ~450 of them
  // for Stripe, on every load AND every list.
  assert.doesNotMatch(out, /listThings|createThing/, 'no operation dump')
  assert.match(out, /action='search'/, 'points at how to find one')
})

test('a document that is not a spec says so instead of loading empty', async () => {
  const notASpec = join(HOME, 'not-a-spec.yaml')
  writeFileSync(notASpec, 'name: my-project\nversion: 1\n')
  const out = await run({ action: 'load', spec_url: notASpec })
  assert.match(out, /no operations/)
  assert.match(out, /no openapi\/swagger version field/)
  assert.match(out, /name, version/, 'shows what it actually found')
})

test('a spec that cannot be read names the file and the line', async () => {
  const broken = join(HOME, 'broken.yaml')
  writeFileSync(broken, 'paths:\n\t/x: {}\n')
  const out = await run({ action: 'load', spec_url: broken })
  assert.match(out, /could not parse/)
  assert.match(out, /line 2: tab/)
  assert.match(out, /broken\.yaml/)
})

test('a spec file that is not there is an error, not a stack trace', async () => {
  assert.match(await run({ action: 'load', spec_url: '/nope/nothing.json' }), /no such spec file/)
})

test('search finds the operation, then describe explains it', async () => {
  const hits = await run({ action: 'search', query: 'create a thing', alias: 'echo' })
  assert.match(hits, /createThing/)
  const desc = await run({ action: 'describe', operation: 'createThing', alias: 'echo' })
  assert.match(desc, /name: string {2}\(required\)/)
  assert.doesNotMatch(desc, /\$ref/)
})

test('describe on a typo suggests the real operations', async () => {
  const out = await run({ action: 'describe', operation: 'createThingz' })
  assert.match(out, /no operation 'createThingz'/)
  assert.match(out, /createThing/, 'the near miss is offered')
})

test('a call happens for real, with the parameters where the spec put them', async () => {
  requests.length = 0
  const out = await run({ action: 'call', operation: 'listThings', params: '{"limit": 3}' })
  assert.match(out, /GET \/things → 200 OK/)
  assert.match(out, /"url": "\/things\?limit=3"/)
  assert.equal(requests[0].url, '/things?limit=3')
  assert.equal(requests[0].method, 'GET')
})

test('a call that the spec says cannot work never reaches the network', async () => {
  requests.length = 0
  const missing = await run({ action: 'call', operation: 'searchThings', params: '{}' })
  assert.match(missing, /not sending this call/)
  assert.match(missing, /missing required: q \(query\)/)
  const typo = await run({ action: 'call', operation: 'listThings', params: '{"limt": 3}' })
  assert.match(typo, /unknown parameter 'limt' — did you mean 'limit'\?/)
  assert.equal(requests.length, 0, 'neither call was sent')
})

test('params that are not a JSON object are rejected before anything else', async () => {
  assert.match(await run({ action: 'call', operation: 'listThings', params: '{oops' }), /not valid JSON/)
  assert.match(await run({ action: 'call', operation: 'listThings', params: '[1,2]' }), /must be a JSON object/)
})

test('an operation needing auth with nothing stored says how to store it', async () => {
  forgetCred('echo')
  const out = await run({ action: 'call', operation: 'createThing', params: '{"name":"x"}' })
  assert.match(out, /needs auth \(ApiKeyAuth\)/)
  assert.match(out, /action='auth'.*api_key=/)
})

test('a stored key is attached on the next call, and shown redacted', async () => {
  requests.length = 0
  const stored = await run({ action: 'auth', alias: 'echo', api_key: 'sk_live_abcdefghijkl' })
  assert.match(stored, new RegExp(`usable on ${HOST.replace('.', '\\.')}`), 'bound to the spec\'s host')

  const out = await run({ action: 'call', operation: 'createThing', params: '{"name":"widget"}' })
  assert.match(out, /200 OK.*auth: apiKey X-API-Key \(header\)/)
  assert.equal(requests[0].headers['x-api-key'], 'sk_live_abcdefghijkl', 'a real header on a real request')
  assert.deepEqual(JSON.parse(requests[0].body), { name: 'widget' }, 'and the body the model asked for')
  assert.equal(requests[0].headers['content-type'], 'application/json')

  const tokens = await run({ action: 'tokens' })
  assert.match(tokens, /echo: api_key/)
  assert.match(tokens, /hosts: 127\.0\.0\.1:/)
  assert.doesNotMatch(tokens, /sk_live_abcdefghijkl/, 'the secret is never echoed back')
  assert.match(tokens, /sk_liv…ijkl/)
})

test('a 4xx body comes back verbatim — it is the most useful text in the tool', async () => {
  const out = await run({ action: 'call', operation: 'missingThing' })
  assert.match(out, /404 Not Found/)
  assert.match(out, /no such thing/)
})

test('raw reaches an endpoint the spec never described', async () => {
  requests.length = 0
  const out = await run({ action: 'raw', method: 'get', path: '/undocumented', params: '{"a": 1}' })
  assert.match(out, /200 OK/)
  assert.equal(requests[0].url, '/undocumented?a=1')
  assert.match(out, /auth: apiKey X-API-Key \(header\)/, 'a loaded spec still lends its credential')
})

test('list shows every spec on this machine, one line each', async () => {
  resetSpecs()   // as if a new session started: the disk cache must still be seen
  const out = await run({ action: 'list' })
  assert.match(out, /echo\s+4 ops\s+http:\/\/127\.0\.0\.1:\d+\s+🔑 api_key/)
  assert.doesNotMatch(out, /listThings/, 'still no operation dump')
})

test('schemas lists models and then explains one', async () => {
  assert.match(await run({ action: 'schemas', alias: 'echo' }), /1 schemas in 'echo':\n {2}Thing/)
  assert.match(await run({ action: 'schemas', alias: 'echo', name: 'Thing' }), /name: string {2}\(required\)/)
  assert.match(await run({ action: 'schemas', alias: 'echo', name: 'Thingz' }), /no schema 'Thingz'.*Close: Thing/)
})

test('an unloaded alias is named as such, with what IS loaded', async () => {
  assert.match(await run({ action: 'call', operation: 'listThings', alias: 'nope' }), /no operation 'listThings'/)
  assert.match(await run({ action: 'search', query: 'x', alias: 'nope' }), /no spec loaded as 'nope'/)
})

test('forget deletes the credential and the next secured call asks again', async () => {
  assert.match(await run({ action: 'forget', alias: 'echo' }), /deleted the credential/)
  assert.match(await run({ action: 'call', operation: 'createThing', params: '{"name":"x"}' }), /needs auth/)
})

test('help is the tool describing itself, so a model never has to guess', async () => {
  const out = await run({ action: 'help' })
  for (const a of ['load', 'search', 'describe', 'call', 'raw', 'auth']) assert.ok(out.includes(`- ${a}`), a)
})
