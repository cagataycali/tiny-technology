/**
 * use_mcp — tiny-tech as an MCP client.
 *
 * Three halves, and the middle one is where the value is. Config parsing is
 * pure and gets fixture directories rather than this Mac's real files, because
 * the interesting cases (a project server outranking a global one of the same
 * name, a disabled entry, a typo'd transport) are not all present here at once.
 * Then the real ~/.claude.json, to keep the parser honest against a file nobody
 * wrote for it. Then the whole thing end to end: tiny-tech's own MCP server
 * spawned as a child, listed and called THROUGH use_mcp, which is the only way
 * to prove the transport, the cache and the formatters agree.
 *
 * Measured on this Mac while writing it: 10 servers discovered in 1ms from a
 * 29 KB ~/.claude.json; connecting to tiny-tech-as-a-server ~1.3s (its own
 * device-tool build dominates), a listTools through the client 2ms after that.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const {
  parseServerDef, serverMapsFrom, collectServers, projectChain, configSources, discover,
  parseArgs, pickServer, serverKey, readStderr, closeAll, liveCount, connect,
  formatServers, formatTools, formatCall, formatResources, formatRead,
  makeMcpTool, CONNECT_TIMEOUT_MS, CALL_TIMEOUT_MS, IDLE_MS, connectTimeout, callTimeout,
} = await import('../dist/agent/mcp.js')

// ── one definition ──────────────────────────────────────────────────────────

const def = (raw, name = 's') => {
  const r = parseServerDef(name, raw, 'fixture')
  assert.ok(!('error' in r), `unexpected error: ${r.error}`)
  return r.def
}
const err = (raw, name = 's') => {
  const r = parseServerDef(name, raw, 'fixture')
  assert.ok('error' in r, `expected an error, got ${JSON.stringify(r.def)}`)
  return r.error
}

test('the real shape on this Mac parses — command, args, and an empty env', () => {
  const d = def({ type: 'stdio', command: 'uvx', args: ['strands-radio'], env: {} })
  assert.equal(d.transport, 'stdio')
  assert.equal(d.command, 'uvx')
  assert.deepEqual(d.args, ['strands-radio'])
  // Kept, not dropped: both SDKs merge it over the safe inherited set, so an
  // empty object is a no-op rather than a PATH-stripping footgun.
  assert.deepEqual(d.env, {})
  assert.equal(d.source, 'fixture')
})

test('the config\'s own type wins over devduck\'s "/sse in the url" guess', () => {
  // An SSE endpoint mounted anywhere but /sse is exactly what the heuristic
  // gets wrong, and the failure looks like a protocol bug, not a config one.
  assert.equal(def({ type: 'sse', url: 'https://x.dev/events' }).transport, 'sse')
  assert.equal(def({ type: 'http', url: 'https://x.dev/sse' }).transport, 'http')
})

test('every spelling of streamable HTTP seen in the wild means http', () => {
  for (const t of ['http', 'streamable-http', 'streamableHttp', 'STREAMABLE_HTTP']) {
    assert.equal(def({ type: t, url: 'https://x.dev/mcp' }).transport, 'http', t)
  }
})

test('transport is also read from `transport`, which some configs use', () => {
  assert.equal(def({ transport: 'sse', url: 'https://x.dev/events' }).transport, 'sse')
})

test('with no type at all, a command means stdio and a url is guessed', () => {
  assert.equal(def({ command: 'node', args: ['x.js'] }).transport, 'stdio')
  assert.equal(def({ url: 'https://x.dev/sse' }).transport, 'sse')
  assert.equal(def({ url: 'https://x.dev/mcp' }).transport, 'http')
})

test('both ways a client writes "switched off" are honoured', () => {
  assert.equal(def({ command: 'x', disabled: true }).disabled, true)
  assert.equal(def({ command: 'x', enabled: false }).disabled, true)
  assert.equal(def({ command: 'x' }).disabled, undefined)
  assert.equal(def({ command: 'x', enabled: true }).disabled, undefined)
})

test('headers survive, because a remote server without its token is useless', () => {
  const d = def({ type: 'http', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer t' } })
  assert.deepEqual(d.headers, { Authorization: 'Bearer t' })
})

test('non-string env and header values are stringified, not dropped', () => {
  // A person writes "PORT": 8080 in JSON without thinking; spawn() needs a string.
  assert.deepEqual(def({ command: 'x', env: { PORT: 8080, DEBUG: true } }).env, { PORT: '8080', DEBUG: 'true' })
})

test('a broken entry comes back as a reason — a server you cannot see is worse', () => {
  assert.match(err(null), /not an object/)
  assert.match(err([1, 2]), /not an object/)
  assert.match(err({}), /no command and no url/)
  assert.match(err({ type: 'stdio' }), /stdio needs a command/)
  assert.match(err({ type: 'sse' }), /sse needs a url/)
  assert.match(err({ type: 'grpc', url: 'https://x' }), /unknown type "grpc".*stdio, sse, http/)
})

test('the name is in every error, because the map key is all the user knows', () => {
  assert.match(err({}, 'radio'), /^radio: /)
  assert.match(err(null, 'radio'), /^radio: not an object/)
  assert.match(err({ type: 'grpc' }, 'radio'), /^radio: unknown type/)
})

// ── one config file ─────────────────────────────────────────────────────────

const maps = (text, dirs) => serverMapsFrom('f', text, dirs)

test('an absent or empty file is not a problem, it is the normal case', () => {
  for (const t of [undefined, '', '   ']) {
    assert.deepEqual(maps(t), { maps: [] }, JSON.stringify(t))
  }
})

test('unreadable JSON is reported with the parser\'s own complaint', () => {
  const r = maps('{ "mcpServers": ')
  assert.deepEqual(r.maps, [])
  assert.match(r.problem, /^f: unreadable JSON \(.+\)$/)
  assert.ok(!r.problem.includes('\n'), 'a multi-line parse error would wreck the listing')
})

test('a project map ranks above the global one, nearest directory first', () => {
  const text = JSON.stringify({
    mcpServers: { a: { command: 'global' } },
    projects: {
      '/repo': { mcpServers: { a: { command: 'outer' } } },
      '/repo/pkg': { mcpServers: { a: { command: 'inner' } } },
    },
  })
  const r = maps(text, ['/repo/pkg', '/repo', '/'])
  assert.deepEqual(r.maps.map((m) => m.source), ['f (project /repo/pkg)', 'f (project /repo)', 'f'])
  // First mention wins downstream, so order here IS the precedence.
  assert.equal(collectServers(r.maps).servers[0].command, 'inner')
})

test('the project a tool is NOT in contributes nothing', () => {
  const text = JSON.stringify({ mcpServers: { a: { command: 'g' } }, projects: { '/other': { mcpServers: { b: { command: 'x' } } } } })
  assert.deepEqual(maps(text, ['/repo']).maps.map((m) => m.source), ['f'])
})

test('an empty per-project map is skipped rather than listed as a source', () => {
  // ~/.claude.json has a `projects` entry for every directory tiny has ever run
  // in, and almost all of them have `mcpServers: {}`.
  const text = JSON.stringify({ projects: { '/repo': { mcpServers: {} } }, mcpServers: { a: { command: 'g' } } })
  assert.deepEqual(maps(text, ['/repo']).maps.map((m) => m.source), ['f'])
})

test('a hand-written bare map is accepted — the wrapper key is a client convention', () => {
  const r = maps(JSON.stringify({ radio: { command: 'uvx', args: ['strands-radio'] } }))
  assert.equal(r.problem, undefined)
  assert.deepEqual(Object.keys(r.maps[0].servers), ['radio'])
})

test('a file that is not a server map is rejected, not read as one broken server', () => {
  // Without the looks-like-servers check, ~/.tiny/config.json would report
  // "theme: no command and no url" and the user would have no idea why.
  const r = maps(JSON.stringify({ theme: 'dark', voice: { rate: 1 } }))
  assert.deepEqual(r.maps, [])
  assert.match(r.problem, /no "mcpServers" object/)
  assert.match(maps('[1,2,3]').problem, /no "mcpServers" object/)
  assert.match(maps('"hello"').problem, /not a JSON object/)
})

test('an empty config file is a problem, not a machine with zero servers', () => {
  // `{}` passing .every() vacuously would report "no servers" for a file the
  // user has plainly filled in wrong.
  assert.match(maps('{}').problem, /no "mcpServers" object/)
})

test('one bare entry missing a command sinks the whole bare-map guess', () => {
  const r = maps(JSON.stringify({ radio: { command: 'uvx' }, notes: 'yes' }))
  assert.match(r.problem, /no "mcpServers" object/)
})

// ── merging every source ────────────────────────────────────────────────────

test('first mention wins and the loser is named, not silently dropped', () => {
  const r = collectServers([
    { source: 'MCP_SERVERS', servers: { a: { command: 'first' }, b: { command: 'b' } } },
    { source: '~/.claude.json', servers: { a: { command: 'second' } } },
  ])
  assert.deepEqual(r.servers.map((s) => [s.name, s.command]), [['a', 'first'], ['b', 'b']])
  assert.deepEqual(r.shadowed, [{ name: 'a', source: '~/.claude.json' }])
  assert.deepEqual(r.problems, [])
})

test('a broken entry costs that entry and says where it lives', () => {
  const r = collectServers([{ source: '~/.cursor/mcp.json', servers: { good: { command: 'x' }, bad: {} } }])
  assert.deepEqual(r.servers.map((s) => s.name), ['good'])
  assert.deepEqual(r.problems, ['~/.cursor/mcp.json → bad: no command and no url'])
})

test('a broken definition does not claim the name — a later good one still lands', () => {
  const r = collectServers([
    { source: 'A', servers: { a: {} } },
    { source: 'B', servers: { a: { command: 'works' } } },
  ])
  assert.deepEqual(r.servers.map((s) => s.command), ['works'])
  assert.deepEqual(r.shadowed, [])
})

test('a disabled server is kept in the list so `servers` can say it is off', () => {
  const r = collectServers([{ source: 'A', servers: { a: { command: 'x', disabled: true } } }])
  assert.equal(r.servers.length, 1)
  assert.equal(r.servers[0].disabled, true)
})

// ── where to look ───────────────────────────────────────────────────────────

test('the directory chain is nearest-first and terminates at the root', () => {
  const c = projectChain('/a/b/c')
  assert.deepEqual(c, ['/a/b/c', '/a/b', '/a', '/'])
  assert.deepEqual(projectChain('/'), ['/'])
  assert.ok(projectChain(process.cwd()).length < 64, 'the loop bound was hit for a real path')
})

test('the chain is why the one project server on this Mac is found at all', () => {
  // Claude Code keys projects by exact root. This repo is a subdirectory of the
  // project that owns the `tiny` server; cwd alone would miss it.
  assert.ok(projectChain('/Users/cagatay/tinyai-id/tiny-tech').includes('/Users/cagatay/tinyai-id'))
})

test('the search order puts the most explicit source first', () => {
  const s = configSources({}, '/home/u', '/repo')
  assert.deepEqual(s.map((x) => x.source), [
    'MCP_SERVERS',
    '~/.tiny/mcp.json',
    './.mcp.json',
    '~/.claude.json',
    'Claude Desktop',
    'Claude Desktop',
    '~/.cursor/mcp.json',
    '~/.codeium/windsurf/mcp_config.json',
  ])
  assert.equal(s[0].path, null, 'the env var must not be statted')
  assert.equal(s[1].path, '/home/u/.tiny/mcp.json')
  assert.equal(s[2].path, '/repo/.mcp.json')
  // Both Claude Desktop locations, so this works on Linux without a platform branch.
  assert.deepEqual(s.filter((x) => x.source === 'Claude Desktop').map((x) => x.path), [
    '/home/u/Library/Application Support/Claude/claude_desktop_config.json',
    '/home/u/.config/Claude/claude_desktop_config.json',
  ])
})

test('only ~/.claude.json is asked about projects — the others have no such notion', () => {
  const s = configSources({}, '/home/u', '/repo')
  assert.deepEqual(s.filter((x) => x.projectDirs).map((x) => x.source), ['~/.claude.json'])
})

test('TINY_HOME moves tiny\'s own config file with it', () => {
  const s = configSources({ TINY_HOME: '/tmp/t' }, '/home/u', '/repo')
  assert.equal(s[1].path, '/tmp/t/mcp.json')
})

// ── discovery against real files ────────────────────────────────────────────

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'tiny-mcp-'))
  const cwd = join(home, 'work', 'pkg')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, '.tiny'))
  mkdirSync(join(home, '.cursor'))
  writeFileSync(join(home, '.tiny', 'mcp.json'), JSON.stringify({ tinyown: { command: 'uvx', args: ['a'] } }))
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { proj: { command: 'node' } } }))
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { shared: { type: 'stdio', command: 'global' }, off: { command: 'x', disabled: true } },
    projects: { [join(home, 'work')]: { mcpServers: { shared: { type: 'stdio', command: 'per-project' } } } },
  }))
  writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { broken: { type: 'nope' } } }))
  return { home, cwd }
}

test('all six places are read in one pass, with sources kept', () => {
  const { home, cwd } = fixtureHome()
  const d = discover({ env: { MCP_SERVERS: JSON.stringify({ mcpServers: { fromenv: { command: 'e' } } }) }, home, cwd })
  assert.deepEqual(d.servers.map((s) => s.name), ['fromenv', 'tinyown', 'proj', 'shared', 'off'])
  assert.equal(d.servers.find((s) => s.name === 'shared').command, 'per-project',
    'the parent project\'s definition lost to the global one')
  assert.match(d.servers.find((s) => s.name === 'shared').source, /project /)
  assert.deepEqual(d.shadowed, [{ name: 'shared', source: '~/.claude.json' }])
  assert.deepEqual(d.problems, ['~/.cursor/mcp.json → broken: unknown type "nope" (stdio, sse, http)'])
})

test('a devduck MCP_SERVERS value keeps working verbatim', () => {
  // devduck's only channel is this env var, holding the bare map.
  const { home, cwd } = fixtureHome()
  const d = discover({ env: { MCP_SERVERS: '{"duck":{"command":"uvx","args":["duck-mcp"]}}' }, home, cwd })
  assert.equal(d.servers[0].name, 'duck')
  assert.equal(d.servers[0].transport, 'stdio')
})

test('a machine with nothing configured reports nothing, not an error', () => {
  const home = mkdtempSync(join(tmpdir(), 'tiny-bare-'))
  const d = discover({ env: {}, home, cwd: home })
  assert.deepEqual(d.servers, [])
  assert.deepEqual(d.problems, [])
})

test('this Mac\'s real config parses, including the project-scoped server', () => {
  const d = discover({ env: {}, home: homedir(), cwd: ROOT })
  if (!d.servers.length) return // a machine with no MCP client configured
  assert.deepEqual(d.problems, [], 'a real config produced a parse problem')
  for (const s of d.servers) {
    assert.ok(s.transport === 'stdio' ? s.command : s.url, `${s.name} has neither command nor url`)
    assert.ok(s.source, `${s.name} lost its source`)
  }
})

test('discovery is cheap enough to run at every boot', () => {
  const t0 = process.hrtime.bigint()
  discover({ env: {}, home: homedir(), cwd: ROOT })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  // 1ms measured on a 29 KB ~/.claude.json; the gate is the registration cost.
  assert.ok(ms < 100, `discovery took ${ms.toFixed(1)}ms`)
})

// ── arguments ───────────────────────────────────────────────────────────────

test('a JSON string of arguments becomes the object the server wants', () => {
  assert.deepEqual(parseArgs('{"path":"/tmp","n":3}').args, { path: '/tmp', n: 3 })
  assert.deepEqual(parseArgs('{"nested":{"a":[1,2]}}').args, { nested: { a: [1, 2] } })
})

test('no arguments means no arguments, for the many tools that take none', () => {
  for (const raw of [undefined, null, '', '   ']) assert.deepEqual(parseArgs(raw).args, {})
})

test('an object passed straight through is accepted', () => {
  const o = { a: 1 }
  assert.equal(parseArgs(o).args, o)
})

test('unparseable args fail loudly — calling a tool with {} lies convincingly', () => {
  assert.match(parseArgs('path=/tmp').error, /args is not JSON.*JSON object like/)
  assert.match(parseArgs('[1,2]').error, /must be a JSON object, got an array/)
  assert.match(parseArgs('42').error, /got number/)
  assert.match(parseArgs('"x"').error, /got string/)
  assert.ok(!parseArgs('{').error.includes('\n'))
})

// ── choosing a server ───────────────────────────────────────────────────────

const SERVERS = [
  { name: 'radio', transport: 'stdio', command: 'uvx', args: ['strands-radio'], source: 'A' },
  { name: 'Notes', transport: 'stdio', command: 'notes', source: 'B' },
  { name: 'sleepy', transport: 'stdio', command: 'x', source: 'C', disabled: true },
]

test('one server needs no naming', () => {
  assert.equal(pickServer([SERVERS[0]], '').def.name, 'radio')
})

test('several servers and no name lists them instead of guessing', () => {
  assert.match(pickServer(SERVERS, '').error, /which server\? radio, Notes/)
})

test('the name matches exactly first, then case-insensitively', () => {
  assert.equal(pickServer(SERVERS, 'Notes').def.name, 'Notes')
  assert.equal(pickServer(SERVERS, 'notes').def.name, 'Notes')
  assert.equal(pickServer(SERVERS, ' radio ').def.name, 'radio')
})

test('a disabled server says it is disabled and where — not "no such server"', () => {
  assert.match(pickServer(SERVERS, 'sleepy').error, /sleepy is disabled in C/)
})

test('an unknown name lists the real ones', () => {
  assert.match(pickServer(SERVERS, 'raido').error, /no server called "raido" — configured: radio, Notes/)
})

test('nothing configured points at the fix', () => {
  assert.match(pickServer([], '').error, /action="servers"/)
})

// ── formatting ──────────────────────────────────────────────────────────────

test('the server listing counts only usable servers but shows the paused one', () => {
  const out = formatServers({ servers: SERVERS, shadowed: [], problems: [] })
  assert.match(out, /2 MCP servers configured/)
  assert.match(out, /• radio {2}stdio {2}uvx strands-radio/)
  assert.match(out, /from A/)
  assert.match(out, /⏸ sleepy/)
  assert.match(out, /disabled in that config/)
  assert.match(out, /action="tools" server="radio"/, 'the listing must show the next call')
})

test('one server is singular, because "1 servers" reads like a bug', () => {
  assert.match(formatServers({ servers: [SERVERS[0]], shadowed: [], problems: [] }), /1 MCP server configured/)
})

test('an empty listing is the place to teach the config format', () => {
  const out = formatServers({ servers: [], shadowed: [], problems: [] })
  assert.match(out, /nothing found/)
  assert.match(out, /~\/\.tiny\/mcp\.json/)
  assert.match(out, /"mcpServers"/)
  assert.ok(!out.includes('action="tools"'), 'offered a call with no server to make it against')
})

test('shadowing and problems are surfaced in the listing itself', () => {
  const out = formatServers({
    servers: [SERVERS[0]],
    shadowed: [{ name: 'radio', source: '~/.cursor/mcp.json' }],
    problems: ['~/.tiny/mcp.json: unreadable JSON (x)'],
  })
  assert.match(out, /⚠ radio in ~\/\.cursor\/mcp\.json is shadowed/)
  assert.match(out, /⚠ ~\/\.tiny\/mcp\.json: unreadable JSON/)
})

test('a remote server shows its url, not an empty command', () => {
  const out = formatServers({ servers: [{ name: 'r', transport: 'http', url: 'https://x.dev/mcp', source: 'A' }], shadowed: [], problems: [] })
  assert.match(out, /r {2}http {2}https:\/\/x\.dev\/mcp/)
})

test('a tool listing marks required arguments and keeps one line of prose', () => {
  const out = formatTools('fs', [{
    name: 'read_file',
    description: 'Read a file.\nSupports text and images.\nMore detail here.',
    inputSchema: { properties: { path: {}, encoding: {} }, required: ['path'] },
  }])
  assert.match(out, /1 tool$/m)
  assert.match(out, /• read_file\(path\*, encoding\)/)
  assert.match(out, /Read a file\./)
  assert.ok(!out.includes('More detail here'), 'a 70-tool server would bury the list')
  assert.match(out, /\* = required/)
})

test('a very long first line is truncated rather than allowed to dominate', () => {
  const out = formatTools('s', [{ name: 't', description: 'x'.repeat(400) }])
  const line = out.split('\n').find((l) => l.includes('xxx'))
  assert.ok(line.trim().length <= 161, `${line.trim().length} chars survived`)
  assert.match(line, /…$/)
})

test('a tool with no schema still lists, with empty parentheses', () => {
  assert.match(formatTools('s', [{ name: 'ping' }]), /• ping\(\)/)
})

test('a server with no tools says so instead of printing a bare header', () => {
  assert.equal(formatTools('s', []), '🧩 s exposes no tools')
})

test('every content block kind a server may answer with becomes text', () => {
  const out = formatCall('s', 't', {
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image', mimeType: 'image/png', data: 'A'.repeat(4096) },
      { type: 'resource', resource: { uri: 'file:///a', text: 'inline body' } },
      { type: 'resource_link', uri: 'file:///b' },
    ],
  })
  assert.match(out, /hello/)
  assert.match(out, /\[image image\/png, 3 KB\]/)
  // Exact line, not a substring: without the resource branch the whole block
  // gets JSON.stringify'd, which still CONTAINS "inline body".
  assert.ok(out.split('\n').includes('inline body'), out)
  assert.match(out, /\[resource file:\/\/\/b\]/)
})

test('isError is a FIELD, and a client that ignores it reports failure as success', () => {
  const out = formatCall('fs', 'read_file', { isError: true, content: [{ type: 'text', text: 'ENOENT' }] })
  assert.match(out, /^❌ fs\.read_file failed: ENOENT/)
})

test('an error with no content still reads as an error', () => {
  assert.match(formatCall('s', 't', { isError: true, content: [] }), /failed: no detail given/)
})

test('structured-only output is not lost', () => {
  assert.match(formatCall('s', 't', { structuredContent: { rows: 2 } }), /"rows": 2/)
})

test('a genuinely empty success says so — a blank answer looks like a hang', () => {
  assert.match(formatCall('s', 't', { content: [] }), /✅ s\.t returned nothing/)
  assert.match(formatCall('s', 't', undefined), /returned nothing/)
})

test('an unknown block kind is shown as JSON rather than swallowed', () => {
  assert.match(formatCall('s', 't', { content: [{ type: 'audio', data: 'x' }] }), /"type":"audio"/)
})

test('resources list with what a read needs', () => {
  const out = formatResources('fs', [{ uri: 'file:///a', name: 'A', mimeType: 'text/plain', description: 'the a file\nmore' }])
  assert.match(out, /1 resource$/m)
  assert.match(out, /• file:\/\/\/a {2}A {2}\(text\/plain\)/)
  assert.match(out, /the a file/)
  assert.ok(!out.includes('\n     more'))
  assert.match(out, /action="read"/)
  assert.equal(formatResources('fs', []), '🧩 fs exposes no resources')
})

test('a read returns the text, and describes binary rather than printing it', () => {
  assert.equal(formatRead('fs', 'file:///a', [{ text: 'body' }, { text: 'more' }]), 'body\nmore')
  assert.match(formatRead('fs', 'file:///a', [{ mimeType: 'image/png', uri: 'file:///a' }]), /\[image\/png at file:\/\/\/a\]/)
  assert.match(formatRead('fs', 'file:///a', []), /returned nothing for file:\/\/\/a/)
})

// ── connection bookkeeping ──────────────────────────────────────────────────

test('the cache key separates two servers sharing a name but not a command', () => {
  const k = (d) => serverKey({ transport: 'stdio', ...d })
  assert.notEqual(k({ name: 'a', command: 'uvx', args: ['x'] }), k({ name: 'a', command: 'uvx', args: ['y'] }))
  assert.equal(k({ name: 'a', command: 'uvx', args: ['x'] }), k({ name: 'a', command: 'uvx', args: ['x'] }))
  assert.notEqual(
    serverKey({ name: 'a', transport: 'sse', url: 'https://x/1' }),
    serverKey({ name: 'a', transport: 'sse', url: 'https://x/2' }),
  )
})

test('a cold uvx server gets longer to start than a call gets to answer... no', () => {
  // Deliberate: starting may download a package, but a call that takes two
  // minutes has already failed the conversation. Both are pinned so a later
  // "tidy up the constants" commit has to argue with a test.
  assert.equal(CONNECT_TIMEOUT_MS, 60_000)
  assert.equal(CALL_TIMEOUT_MS, 120_000)
  assert.equal(IDLE_MS, 300_000)
})

test('the child\'s own complaint is what comes back, last lines first-aid', () => {
  const said = readStderr({ stderr: { read: () => 'uvx: command not found\n' } }, [])
  assert.equal(said, 'uvx: command not found')
  const many = readStderr(null, [Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')])
  assert.equal(many.split('\n   ').length, 6, 'a chatty server must not flood the answer')
  assert.match(many, /line19/)
})

test('a transport with no stderr is not an error — remote ones have none', () => {
  assert.equal(readStderr({}, []), '')
  assert.equal(readStderr({ stderr: { read: () => { throw new Error('closed') } } }, []), '')
})

test('a server that cannot start explains itself in the error, not in a log', async () => {
  const e = await connect({ name: 'ghost', transport: 'stdio', command: '/nonexistent/mcp-server', source: 'fixture' })
    .then(() => null, (err) => err)
  assert.ok(e, 'connecting to a missing binary resolved')
  assert.match(e.message, /^ghost would not start: /)
  assert.equal(liveCount(), 0, 'a failed connection was cached')
})

// ── servers that misbehave ──────────────────────────────────────────────────

/**
 * Hand-written stdio MCP servers, one per failure mode.
 *
 * Raw newline-delimited JSON-RPC rather than the SDK, because the point is a
 * server that does NOT play along: one that dies talking, one that never
 * answers the handshake, one that answers the handshake and then goes deaf.
 * Each exits when its stdin closes, so nothing survives the test run.
 */
const FIXTURES = {
  loud: 'process.stderr.write("uvx: command not found\\n"); process.exit(127)',
  hang: 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))',
  deaf: `
    let buf = ''
    process.stdin.on('end', () => process.exit(0))
    process.stdin.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const m = JSON.parse(line)
        if (m.method !== 'initialize') continue
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: m.id,
          result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'deaf', version: '1' } },
        }) + '\\n')
      }
    })`,
}

const fixtureDir = mkdtempSync(join(tmpdir(), 'tiny-fx-'))
for (const [name, body] of Object.entries(FIXTURES)) writeFileSync(join(fixtureDir, `${name}.mjs`), body)
const fixtureDef = (name) => ({
  name, transport: 'stdio', source: 'fixture',
  command: process.execPath, args: [join(fixtureDir, `${name}.mjs`)],
})

test('a server that dies talking says why, in the error itself', async () => {
  const e = await connect(fixtureDef('loud')).then(() => null, (err) => err)
  assert.ok(e, 'a server that exits 127 connected')
  // The SDK's own message is "Connection closed", which explains nothing.
  assert.match(e.message, /it said: uvx: command not found/)
  assert.equal(liveCount(), 0)
})

test('a server that never finishes the handshake hits the connect deadline', async () => {
  const before = process.env.TINY_MCP_CONNECT_TIMEOUT_MS
  process.env.TINY_MCP_CONNECT_TIMEOUT_MS = '400'
  try {
    const t0 = process.hrtime.bigint()
    const e = await connect(fixtureDef('hang')).then(() => null, (err) => err)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    assert.ok(e, 'a silent server connected')
    assert.match(e.message, /hang would not start: connecting to hang timed out after 400ms/)
    assert.ok(ms < 5000, `waited ${ms.toFixed(0)}ms for a 400ms deadline`)
    assert.equal(liveCount(), 0)
  } finally {
    if (before === undefined) delete process.env.TINY_MCP_CONNECT_TIMEOUT_MS
    else process.env.TINY_MCP_CONNECT_TIMEOUT_MS = before
  }
})

test('the deadlines are overridable, and junk falls back rather than failing everything', () => {
  assert.equal(connectTimeout({}), CONNECT_TIMEOUT_MS)
  assert.equal(callTimeout({}), CALL_TIMEOUT_MS)
  assert.equal(connectTimeout({ TINY_MCP_CONNECT_TIMEOUT_MS: '1500' }), 1500)
  assert.equal(callTimeout({ TINY_MCP_CALL_TIMEOUT_MS: '1500' }), 1500)
  // 'Infinity' is why Number.isFinite is there: `n > 0` alone would accept it,
  // and a deadline of Infinity is no deadline at all.
  for (const junk of ['', 'soon', '0', '-5', 'NaN', 'Infinity']) {
    assert.equal(callTimeout({ TINY_MCP_CALL_TIMEOUT_MS: junk }), CALL_TIMEOUT_MS, junk)
  }
})

test('a server that connects and then goes deaf hits the call deadline', async () => {
  // Through the tool, because that is where the deadline is applied — and a
  // deaf server is the case a bare client await would hang on forever.
  const before = { call: process.env.TINY_MCP_CALL_TIMEOUT_MS, servers: process.env.MCP_SERVERS }
  process.env.TINY_MCP_CALL_TIMEOUT_MS = '400'
  process.env.MCP_SERVERS = JSON.stringify({ mcpServers: { deaf: { command: process.execPath, args: [join(fixtureDir, 'deaf.mjs')] } } })
  try {
    const t0 = process.hrtime.bigint()
    const out = await call({ action: 'tools', server: 'deaf' })
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    assert.match(out, /❌ deaf listing tools timed out after 400ms/, out)
    assert.ok(ms < 5000, `waited ${ms.toFixed(0)}ms for a 400ms deadline`)
    // Each action carries its own deadline; a call is the one that matters most.
    const called = await call({ action: 'call', server: 'deaf', tool: 'anything', args: '{}' })
    assert.match(called, /❌ deaf\.anything timed out after 400ms/, called)
    assert.match(await call({ action: 'resources', server: 'deaf' }), /timed out after 400ms/)
    assert.match(await call({ action: 'read', server: 'deaf', uri: 'file:///a' }), /timed out after 400ms/)
  } finally {
    for (const [k, v] of [['TINY_MCP_CALL_TIMEOUT_MS', before.call], ['MCP_SERVERS', before.servers]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await closeAll()
  }
})

test('a connected server does not hold the process open — `tiny "…"` must exit', async () => {
  // main() in cli.ts returns rather than calling process.exit, so a referenced
  // child (plus its three pipes) would wedge a one-shot run at 0% CPU forever.
  const script = join(fixtureDir, 'exits.mjs')
  writeFileSync(script, `
    const { connect } = await import(${JSON.stringify(join(ROOT, 'dist', 'agent', 'mcp.js'))})
    await connect(${JSON.stringify(fixtureDef('deaf'))})
    process.stdout.write('connected' + String.fromCharCode(10))`)
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', said = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { said += d })
  const code = await new Promise((res) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); res('TIMED OUT') }, 15000)
    child.on('exit', (c) => { clearTimeout(t); res(c) })
  })
  assert.match(out, /connected/, `the child never got as far as connecting: ${said}`)
  assert.equal(code, 0, 'a process with a live MCP connection would not exit on its own')
})

test('close takes down the one server it was asked for, not the others', async () => {
  await connect(fixtureDef('deaf'))
  await connect({ ...fixtureDef('deaf'), name: 'deaf2' })
  assert.equal(liveCount(), 2)
  const closed = await closeAll('deaf')
  assert.deepEqual(closed, ['deaf'])
  assert.equal(liveCount(), 1, 'closing one server closed both')
  assert.deepEqual(await closeAll('nobody'), [])
  assert.deepEqual(await closeAll(), ['deaf2'])
  assert.equal(liveCount(), 0)
})

// ── end to end, through the tool ────────────────────────────────────────────

const mcpTool = makeMcpTool()
const call = (input) => mcpTool._callback(input)

/** tiny-tech's own MCP server, as a server this machine is configured for. */
function selfConfig() {
  const home = mkdtempSync(join(tmpdir(), 'tiny-self-'))
  return {
    home,
    MCP_SERVERS: JSON.stringify({
      mcpServers: {
        self: {
          type: 'stdio',
          command: process.execPath,
          args: [join(ROOT, 'dist', 'cli.js'), 'serve'],
          // Only one device tool, so the child boots in ~1s instead of ~1.5s,
          // and TINY_MCP_CLIENT=0 so the child does not go discovering too.
          env: { TINY_HOME: home, TINY_MCP_DEVICE_TOOLS: 'computer', TINY_MCP_CLIENT: '0', PATH: process.env.PATH },
        },
      },
    }),
  }
}

const saved = {}
function useSelfConfig() {
  const { home, MCP_SERVERS } = selfConfig()
  for (const k of ['MCP_SERVERS', 'HOME', 'TINY_HOME']) saved[k] = process.env[k]
  // HOME too: the tool reads process.env, and this Mac's real ~/.claude.json
  // would otherwise put ten other servers in the listing.
  process.env.HOME = home
  process.env.TINY_HOME = join(home, '.tiny')
  process.env.MCP_SERVERS = MCP_SERVERS
}

after(async () => {
  await closeAll()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test('the tool answers without touching a server for the cheap actions', async () => {
  assert.match(await call({ action: 'help' }), /use_mcp — the MCP servers/)
  assert.match(await call({ action: 'help' }), /call\s+server=… tool=… args=/)
})

test('a real conversation: list, inspect, call, close', async (t) => {
  useSelfConfig()

  const listed = await call({ action: 'servers' })
  assert.match(listed, /1 MCP server configured/)
  assert.match(listed, /• self {2}stdio/)
  assert.match(listed, /from MCP_SERVERS/)

  const t0 = process.hrtime.bigint()
  const tools = await call({ action: 'tools' })   // no server= — there is only one
  const connectMs = Number(process.hrtime.bigint() - t0) / 1e6
  assert.match(tools, /🧩 self — \d+ tools/, tools)
  assert.match(tools, /• tiny_whoami\(/, 'the platform tools are missing')
  assert.match(tools, /• use_computer\(/, 'the child\'s device tools did not mount')
  assert.ok(connectMs < CONNECT_TIMEOUT_MS, `connect+list took ${connectMs.toFixed(0)}ms`)
  assert.equal(liveCount(), 1)

  const cached = process.hrtime.bigint()
  await call({ action: 'tools', server: 'self' })
  const againMs = Number(process.hrtime.bigint() - cached) / 1e6
  // The point of caching: no second process spawn. Measured 2ms against a
  // ~150ms spawn+boot, so the bar is well under the cheapest possible respawn.
  assert.ok(againMs < 50, `a cached listTools took ${againMs.toFixed(0)}ms — the spawn was repeated`)
  assert.ok(againMs * 5 < connectMs, `${againMs.toFixed(0)}ms vs ${connectMs.toFixed(0)}ms — no cache benefit`)
  assert.equal(liveCount(), 1, 'the same definition was connected twice')

  if (process.platform === 'darwin') {
    const answer = await call({
      action: 'call', server: 'self', tool: 'use_computer',
      args: JSON.stringify({ action: 'screen_size' }),
    })
    // Through two processes, a JSON-RPC hop each way, and both formatters.
    assert.match(answer, /logical points/, answer)
  }

  const closed = await call({ action: 'close' })
  assert.match(closed, /🧩 closed self/)
  assert.equal(liveCount(), 0)
  assert.match(await call({ action: 'close' }), /nothing was connected/)
  assert.match(await call({ action: 'close', server: 'self' }), /self was not connected/)
})

test('a call the server rejects comes back as an error, not a crash', async () => {
  useSelfConfig()
  const out = await call({ action: 'call', server: 'self', tool: 'no_such_tool', args: '{}' })
  assert.match(out, /❌/)
  assert.ok(!/no_such_tool returned nothing/.test(out), 'a rejected call was reported as an empty success')
})

test('the missing-argument cases name the action that fixes them', async () => {
  useSelfConfig()
  assert.match(await call({ action: 'call', server: 'self' }), /need tool — action="tools" server="self"/)
  assert.match(await call({ action: 'read', server: 'self' }), /need uri — action="resources"/)
  assert.match(await call({ action: 'call', server: 'self', tool: 'use_computer', args: 'action=screenshot' }), /args is not JSON/)
})

test('resources are asked for even from a server that has none', async () => {
  useSelfConfig()
  const out = await call({ action: 'resources', server: 'self' })
  assert.ok(/exposes no resources/.test(out) || /🧩 self — \d+ resource/.test(out), out)
})

test('the tool never throws, whatever it is handed', async () => {
  useSelfConfig()
  for (const input of [{ action: 'tools', server: 'ghost' }, { action: 'read', server: 'self', uri: 'file:///nope' }]) {
    const out = await call(input)
    assert.equal(typeof out, 'string', JSON.stringify(input))
    assert.ok(out.length, `empty answer for ${JSON.stringify(input)}`)
  }
})
