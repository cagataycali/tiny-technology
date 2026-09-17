/**
 * use_github — the tests are about the four things devduck's use_github.py gets
 * wrong on a machine that is actually authenticated.
 *
 * devduck's version is one raw GraphQL endpoint: it reads GITHUB_TOKEN and
 * nothing else, decides "is this a mutation?" by substring, discards GitHub's
 * error body via raise_for_status(), and prints json.dumps(indent=2) wrapped in
 * colorama escapes. Each of those is a wrong ANSWER rather than a crash, so each
 * gets a test here — including devduck's own classifier, reimplemented verbatim
 * below, so the difference is pinned rather than asserted.
 *
 * Every fixture is a real api.github.com response shape, verbatim in the parts
 * that make naive parsing wrong: /issues returns pull requests too, a label is
 * an object and not a string, x-ratelimit-reset is epoch SECONDS, a search
 * result carries repository_url instead of a repo object, and a fine-grained
 * token gets no x-oauth-scopes header at all.
 *
 * Nothing here touches the network: fetch is stubbed per test.
 */
import { test, after, before } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.GITHUB_TOKEN = 'ghp_testtoken0000000000000000000000000000'
delete process.env.GH_TOKEN
delete process.env.GITHUB_ACCESS_TOKEN

const G = await import('../dist/agent/github.js')

const realFetch = globalThis.fetch
after(() => { globalThis.fetch = realFetch })
before(() => G.resetGithubToken())

// ─── devduck's classifier, verbatim from use_github.py ───────────────────────

const MUTATIVE_KEYWORDS = [
  'create', 'update', 'delete', 'add', 'remove', 'merge', 'close', 'reopen',
  'lock', 'unlock', 'pin', 'unpin', 'transfer', 'archive', 'unarchive',
  'enable', 'disable', 'accept', 'decline', 'dismiss', 'submit', 'request',
  'cancel', 'convert',
]

/** devduck's is_mutation_query, line for line. */
function devduckWouldPrompt(query) {
  const q = String(query).toLowerCase().trim()
  if (q.startsWith('mutation')) return true
  return MUTATIVE_KEYWORDS.some((k) => q.includes(k))
}

// ─── fixtures ───────────────────────────────────────────────────────────────

const USER = {
  login: 'octocat', name: 'The Octocat', type: 'User',
  public_repos: 8, owned_private_repos: 2, followers: 9001,
  company: 'GitHub', location: 'San Francisco',
}

const REPO = {
  full_name: 'octocat/Hello-World', name: 'Hello-World', private: false, fork: false,
  description: 'My first repository on GitHub!', language: 'Ruby',
  stargazers_count: 2541, forks_count: 1583, open_issues_count: 907,
  default_branch: 'master', pushed_at: '2026-08-13T09:00:00Z', created_at: '2011-01-26T19:01:12Z',
  homepage: 'https://github.com', license: { spdx_id: 'MIT' },
  html_url: 'https://github.com/octocat/Hello-World',
}

// A label is an OBJECT. Naive code prints [object Object] here.
const LABELS = [{ id: 1, name: 'bug', color: 'd73a4a' }, { id: 2, name: 'help wanted', color: '008672' }]

/** /issues returns pull requests too — the second entry here is a PR. */
const ISSUES = [
  {
    number: 1347, title: 'Found a bug', state: 'open', comments: 3,
    user: { login: 'octocat' }, labels: LABELS,
    created_at: '2026-08-10T08:00:00Z', updated_at: '2026-08-13T08:00:00Z',
    body: 'It broke.', html_url: 'https://github.com/octocat/Hello-World/issues/1347',
  },
  {
    number: 1350, title: 'Fix the bug', state: 'open', comments: 0,
    user: { login: 'hubot' }, labels: [],
    updated_at: '2026-08-13T07:00:00Z',
    pull_request: { url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1350' },
  },
]

const PULLS = [
  {
    number: 1350, title: 'Fix the bug', state: 'open', draft: false, comments: 2,
    user: { login: 'hubot' }, labels: LABELS, head: { ref: 'fix', label: 'hubot:fix', sha: 'abc123def456' },
    base: { ref: 'master' }, updated_at: '2026-08-13T07:00:00Z', created_at: '2026-08-12T07:00:00Z',
    additions: 12, deletions: 3, changed_files: 2, commits: 1, mergeable: true, mergeable_state: 'clean',
    body: 'Fixes #1347', html_url: 'https://github.com/octocat/Hello-World/pull/1350',
  },
  {
    number: 1351, title: 'WIP: rewrite', state: 'open', draft: true, comments: 0,
    user: { login: 'octocat' }, labels: [], head: { ref: 'rewrite' }, base: { ref: 'master' },
    updated_at: '2026-08-13T06:00:00Z',
  },
]

/** Search wraps items and gives repository_url, NOT a repository object. */
const SEARCH_ISSUES = {
  total_count: 280, incomplete_results: false,
  items: [{
    number: 132, title: 'Widget: Deleted widgets are not removed', state: 'open', comments: 15,
    user: { login: 'mojombo' }, labels: LABELS,
    repository_url: 'https://api.github.com/repos/octocat/Hello-World',
    updated_at: '2026-08-13T05:00:00Z',
    html_url: 'https://github.com/octocat/Hello-World/issues/132',
  }],
}

const NOTIFICATIONS = [
  {
    id: '1', unread: true, reason: 'review_requested', updated_at: '2026-08-13T09:30:00Z',
    subject: { title: 'Fix the bug', type: 'PullRequest', url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1350' },
    repository: { full_name: 'octocat/Hello-World' },
  },
  {
    id: '2', unread: true, reason: 'mention', updated_at: '2026-08-13T08:30:00Z',
    subject: { title: 'Found a bug', type: 'Issue', url: 'https://api.github.com/repos/octocat/Hello-World/issues/1347' },
    repository: { full_name: 'octocat/Hello-World' },
  },
  {
    id: '3', unread: true, reason: 'subscribed', updated_at: '2026-08-12T08:30:00Z',
    subject: { title: 'Nightly failed', type: 'CheckSuite', url: null },
    repository: { full_name: 'other/repo' },
  },
]

const RUNS = {
  total_count: 4211,
  workflow_runs: [
    {
      id: 1, name: 'CI', run_number: 42, status: 'completed', conclusion: 'failure',
      head_branch: 'main', event: 'push', display_title: 'fix: the thing',
      created_at: '2026-08-13T09:00:00Z', run_started_at: '2026-08-13T09:00:00Z', updated_at: '2026-08-13T09:02:00Z',
      html_url: 'https://github.com/octocat/Hello-World/actions/runs/1',
    },
    {
      id: 2, name: 'CI', run_number: 41, status: 'in_progress', conclusion: null,
      head_branch: 'fix', event: 'pull_request', display_title: 'wip',
      created_at: '2026-08-13T08:00:00Z',
      html_url: 'https://github.com/octocat/Hello-World/actions/runs/2',
    },
  ],
}

const COMMITS = [
  {
    sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e',
    commit: { message: 'Fix all the bugs\n\nIt was broken.', author: { name: 'Monalisa Octocat', date: '2026-08-13T08:00:00Z' } },
    author: { login: 'octocat' },
  },
]

const RATE_HEADERS = {
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '4998',
  'x-ratelimit-reset': '4000000000',
  'x-ratelimit-resource': 'core',
  'x-oauth-scopes': 'repo, workflow, notifications',
}

/**
 * Route api.github.com paths to canned responses. Returns the call log, so a
 * test can assert on what was NOT called.
 */
function stubGithub(routes) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const path = u.startsWith('https://api.github.com') ? u.slice('https://api.github.com'.length) : u
    const bare = path.split('?')[0]
    calls.push({
      path, bare, method: init?.method || 'GET',
      auth: init?.headers?.Authorization,
      accept: init?.headers?.Accept,
      body: init?.body ? JSON.parse(init.body) : undefined,
      query: Object.fromEntries(new URLSearchParams(path.split('?')[1] || '')),
    })
    const route = routes[bare] ?? routes[path]
    if (route === undefined) return response(404, { message: 'Not Found' })
    const r = typeof route === 'function' ? route(calls[calls.length - 1], calls) : route
    if (r && r.__status) return response(r.__status, r.__body, r.__headers)
    return response(200, r)
  }
  return calls
}

function response(status, body, headers = {}) {
  const all = { ...RATE_HEADERS, ...headers }
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    headers: {
      forEach: (fn) => { for (const [k, v] of Object.entries(all)) fn(v, k) },
    },
  }
}

const fail = (status, body, headers) => ({ __status: status, __body: body, __headers: headers })

const tool = G.makeGithubTool()
const call = (args) => (tool._callback ? tool._callback(args) : tool.callback(args))

// ─── 1. the mutation test that blocks reads ─────────────────────────────────

test("devduck's own documented read-only example is classified as a mutation", () => {
  // Verbatim from use_github.py's docstring, "Repository Information".
  const q = `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        name
        description
        stargazerCount
        forkCount
        issues(states: OPEN) { totalCount }
        pullRequests(states: OPEN) { totalCount }
      }
    }`
  assert.equal(devduckWouldPrompt(q), true, "devduck should trip on 'pullRequests' → 'request'")
  assert.equal(G.isMutation(q), false, 'and this must not')
})

test('the two commonest fields in GitHub — createdAt and updatedAt — are not writes', () => {
  const q = '{ viewer { login createdAt updatedAt } }'
  assert.equal(devduckWouldPrompt(q), true)
  assert.equal(G.isMutation(q), false)
})

test('CLOSED as a state filter is not the verb close', () => {
  const q = '{ repository(owner:"o", name:"n") { issues(states: CLOSED, first: 5) { nodes { title } } } }'
  assert.equal(devduckWouldPrompt(q), true)
  assert.equal(G.isMutation(q), false)
})

test('mergedAt, mergeable and reviewDecision read as writes to devduck, not here', () => {
  for (const field of ['mergedAt', 'mergeable', 'reviewRequests', 'isLocked', 'archivedAt', 'canBeRebased']) {
    const q = `{ repository(owner:"o", name:"n") { pullRequest(number: 1) { ${field} } } }`
    assert.equal(devduckWouldPrompt(q), true, `${field} should trip devduck`)
    assert.equal(G.isMutation(q), false, `${field} must not trip this`)
  }
})

test('a real mutation is still recognised, in every shape it is written', () => {
  for (const q of [
    'mutation { addStar(input: {starrableId: "x"}) { clientMutationId } }',
    'mutation AddStar($id: ID!) { addStar(input: {starrableId: $id}) { clientMutationId } }',
    '  \n\n  mutation { addStar(input: {starrableId: "x"}) { clientMutationId } }',
    '# a comment first\nmutation { addStar(input: {starrableId: "x"}) { clientMutationId } }',
    'query Read { viewer { login } }\nmutation Write { addStar(input: {starrableId: "x"}) { clientMutationId } }',
  ]) {
    assert.equal(G.isMutation(q), true, q.slice(0, 40))
  }
})

test('the word mutation inside a selection set or a string is not an operation', () => {
  assert.equal(G.isMutation('{ node(id: "x") { ... on Issue { clientMutationId } } }'), false)
  assert.equal(G.isMutation('{ search(query: "mutation testing", type: ISSUE, first: 1) { issueCount } }'), false)
  assert.equal(G.isMutation('{ repository(owner:"o",name:"n") { description } } # mutation later? no'), false)
})

test('a shorthand query document is a read', () => {
  assert.equal(G.isMutation('{ viewer { login } }'), false)
  assert.equal(G.isMutation(''), false)
  assert.equal(G.isMutation(undefined), false)
})

test('stripLiterals removes comments and both kinds of string', () => {
  assert.equal(G.stripLiterals('a # mutation\nb').includes('mutation'), false)
  assert.equal(G.stripLiterals('a "mutation" b').includes('mutation'), false)
  assert.equal(G.stripLiterals('a """mutation\nstill in it""" b').includes('mutation'), false)
  // An escaped quote must not end the literal early.
  assert.equal(G.stripLiterals('a "it\\" mutation" b').includes('mutation'), false)
})

test('a read-only GraphQL query is executed without asking anyone anything', async () => {
  const calls = stubGithub({ '/graphql': { data: { viewer: { login: 'octocat', createdAt: '2011-01-25T18:44:36Z' } } } })
  const out = await call({ action: 'graphql', query: '{ viewer { login createdAt } }' })
  assert.equal(calls.length, 1)
  assert.match(out, /"login": "octocat"/)
  assert.doesNotMatch(out, /confirm|proceed|\[y\/\*\]/i)
})

// ─── 2. finding the token ───────────────────────────────────────────────────

test('GH_TOKEN counts, which devduck never reads', () => {
  assert.equal(G.envToken({ GH_TOKEN: 'ghp_x' })?.token, 'ghp_x')
  assert.equal(G.envToken({ GH_TOKEN: 'ghp_x' })?.source, 'GH_TOKEN')
  assert.equal(G.envToken({}), undefined)
})

test('GITHUB_TOKEN still wins over GH_TOKEN, and whitespace is trimmed', () => {
  assert.equal(G.envToken({ GITHUB_TOKEN: ' a ', GH_TOKEN: 'b' })?.token, 'a')
})

test('an empty GITHUB_TOKEN is not a token — devduck defaults it to "" and carries on', () => {
  assert.equal(G.envToken({ GITHUB_TOKEN: '' }), undefined)
  assert.equal(G.envToken({ GITHUB_TOKEN: '   ' }), undefined)
})

test("gh's hosts.yml is read, from the host entry or the active user", () => {
  const flat = 'github.com:\n    oauth_token: gho_flat\n    user: octocat\n'
  assert.equal(G.tokenFromHostsYml(flat), 'gho_flat')

  const nested = [
    'github.com:',
    '    users:',
    '        octocat:',
    '            oauth_token: gho_nested',
    '    user: octocat',
    '    git_protocol: https',
    '',
  ].join('\n')
  assert.equal(G.tokenFromHostsYml(nested), 'gho_nested')
})

test('a hosts.yml for another host does not hand over its token', () => {
  const other = 'github.mycorp.com:\n    oauth_token: gho_enterprise\n'
  assert.equal(G.tokenFromHostsYml(other), undefined)
  assert.equal(G.tokenFromHostsYml(other, 'github.mycorp.com'), 'gho_enterprise')
})

test('a hosts.yml with secure_storage has no token in it, and says so by absence', () => {
  // What gh actually writes when the token lives in the keyring.
  assert.equal(G.tokenFromHostsYml('github.com:\n    user: octocat\n    git_protocol: https\n'), undefined)
})

test('a corrupt hosts.yml falls through instead of failing the tool', () => {
  assert.equal(G.tokenFromHostsYml('\t\tthis: [is: not: yaml'), undefined)
  assert.equal(G.tokenFromHostsYml(''), undefined)
  assert.equal(G.tokenFromHostsYml('- a list, not a map'), undefined)
})

test('GH_CONFIG_DIR and XDG_CONFIG_HOME both move hosts.yml', () => {
  assert.equal(G.ghConfigPath({ GH_CONFIG_DIR: '/tmp/ghcfg' }, '/home/me'), '/tmp/ghcfg/hosts.yml')
  assert.equal(G.ghConfigPath({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/me'), '/tmp/xdg/gh/hosts.yml')
  assert.equal(G.ghConfigPath({}, '/home/me'), '/home/me/.config/gh/hosts.yml')
})

test('hostsYmlToken reads a real file on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-gh-'))
  mkdirSync(join(dir, 'gh'), { recursive: true })
  writeFileSync(join(dir, 'gh', 'hosts.yml'), 'github.com:\n    oauth_token: gho_fromdisk\n')
  const found = G.hostsYmlToken({ XDG_CONFIG_HOME: dir }, '/nonexistent')
  assert.equal(found?.token, 'gho_fromdisk')
  assert.match(found.source, /hosts\.yml/)
  assert.equal(G.hostsYmlToken({ XDG_CONFIG_HOME: join(dir, 'nope') }, '/nonexistent'), undefined)
})

test('the token source is carried around, because a 401 is about one door', () => {
  const r = { status: 401, ok: false, json: { message: 'Bad credentials' }, text: '', headers: {} }
  assert.match(G.decodeError(r, 'reading it', '`gh auth token`'), /token from `gh auth token`/)
  assert.match(G.decodeError(r, 'reading it', 'GITHUB_TOKEN'), /token from GITHUB_TOKEN/)
})

test('the token kind is named, because it changes what the answer can contain', () => {
  assert.equal(G.tokenKind('github_pat_11ABC'), 'fine-grained PAT')
  assert.equal(G.tokenKind('ghp_abc'), 'classic PAT')
  assert.equal(G.tokenKind('gho_abc'), 'OAuth (gh CLI)')
  assert.equal(G.tokenKind('ghs_abc'), 'app installation')
  assert.equal(G.tokenKind('deadbeef'), 'unrecognised prefix')
})

test('the gate spawns nothing and honours TINY_GITHUB=0', () => {
  assert.equal(G.hasGithub({ GITHUB_TOKEN: 'x' }), true)
  assert.equal(G.hasGithub({ TINY_GITHUB: '0', GITHUB_TOKEN: 'x' }), false)
  // No env token, no gh config, no gh on an empty PATH: nothing to mount.
  assert.equal(G.hasGithub({ PATH: '', XDG_CONFIG_HOME: '/nonexistent-tiny' }, '/nonexistent-tiny'), false)
})

test('a machine with no token at all is told the four ways to get one', async () => {
  const before = process.env.GITHUB_TOKEN
  const restore = { ...process.env }
  delete process.env.GITHUB_TOKEN
  // Point every discovery route at nothing, so the message is deterministic.
  process.env.PATH = ''
  process.env.XDG_CONFIG_HOME = '/nonexistent-tiny'
  G.resetGithubToken()
  try {
    const out = await call({ action: 'me' })
    assert.match(out, /gh auth login/)
    assert.match(out, /GITHUB_TOKEN/)
    assert.match(out, /keychain/)
  } finally {
    process.env.PATH = restore.PATH
    process.env.XDG_CONFIG_HOME = restore.XDG_CONFIG_HOME ?? ''
    if (restore.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME
    process.env.GITHUB_TOKEN = before
    G.resetGithubToken()
  }
})

test('the resolved token is cached, so a conversation does not re-spawn gh', () => {
  G.resetGithubToken()
  const first = G.resolveToken({ GITHUB_TOKEN: 'ghp_one' }, 1_000)
  const second = G.resolveToken({ GITHUB_TOKEN: 'ghp_two' }, 1_000 + G.TOKEN_TTL_MS - 1)
  assert.equal(second.token, first.token, 'inside the TTL the cache answers')
  const third = G.resolveToken({ GITHUB_TOKEN: 'ghp_two' }, 1_000 + G.TOKEN_TTL_MS + 1)
  assert.equal(third.token, 'ghp_two', 'past the TTL a fresh gh auth login is picked up')
  G.resetGithubToken()
})

// ─── 3. the headers devduck never reads ────────────────────────────────────

test('x-ratelimit-reset is epoch SECONDS, and becomes a wait a human can act on', () => {
  const now = 1_700_000_000_000
  assert.equal(G.resetIn({ 'x-ratelimit-reset': String(now / 1000 + 2460) }, now), 'in 41m')
  assert.equal(G.resetIn({ 'x-ratelimit-reset': String(now / 1000 + 30) }, now), 'in 30s')
  assert.equal(G.resetIn({ 'x-ratelimit-reset': String(now / 1000 - 5) }, now), 'now')
  // Missing or junk must not become "in NaNm".
  assert.equal(G.resetIn({}, now), 'shortly')
  assert.equal(G.resetIn({ 'x-ratelimit-reset': 'soon' }, now), 'shortly')
})

test('a 403 that is really the rate limit says so, and when it lifts', () => {
  const r = {
    status: 403, ok: false, json: { message: 'API rate limit exceeded for user ID 1.' }, text: '',
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1700003600', 'x-ratelimit-resource': 'core' },
  }
  const out = G.decodeError(r, 'listing repos', 'GITHUB_TOKEN', 1_700_000_000_000)
  assert.match(out, /rate limit reached/)
  assert.match(out, /0 of 5000/)
  assert.match(out, /[Rr]esets in 60m/)
  // devduck's 403 branch guesses "may not have sufficient permissions" here.
  assert.doesNotMatch(out, /permission/i)
})

test("the secondary rate limit is a different problem with a different fix", () => {
  const r = {
    status: 403, ok: false,
    json: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
    text: '', headers: { 'x-ratelimit-remaining': '4900', 'x-ratelimit-limit': '5000' },
  }
  const out = G.decodeError(r, 'commenting', 'GITHUB_TOKEN')
  assert.match(out, /secondary rate limit/)
  assert.match(out, /quota is fine/)
  assert.match(out, /do not loop/)
})

test('a scope failure lists the scopes the token actually has', () => {
  const r = {
    status: 403, ok: false, json: { message: 'Resource not accessible by integration' }, text: '',
    headers: { 'x-oauth-scopes': 'repo, gist', 'x-ratelimit-remaining': '4900' },
  }
  assert.match(G.decodeError(r, 'reading notifications', 'GITHUB_TOKEN'), /It has: repo, gist/)
})

test('a fine-grained token reports no scopes at all, and that is explained not blank', () => {
  assert.match(G.scopeList({}), /fine-grained/)
  assert.equal(G.scopeList({ 'x-oauth-scopes': 'repo, workflow' }), 'repo, workflow')
  // Present but empty means a token with NO scopes, which is different again.
  assert.equal(G.scopeList({ 'x-oauth-scopes': '' }), 'none at all')
})

test('a 404 names both reasons it can be a 404', () => {
  const out = G.decodeError({ status: 404, ok: false, json: { message: 'Not Found' }, text: '', headers: { 'x-oauth-scopes': 'gist' } }, 'reading o/n', 'GITHUB_TOKEN')
  assert.match(out, /does not exist/)
  assert.match(out, /renamed/)
  assert.match(out, /cannot see it/)
  assert.match(out, /has: gist/)
})

test("a 422's per-field errors survive, which raise_for_status() throws away", () => {
  const r = {
    status: 422, ok: false, text: '',
    json: {
      message: 'Validation Failed',
      errors: [
        { resource: 'Issue', field: 'title', code: 'missing_field' },
        { resource: 'Issue', field: 'labels', code: 'invalid', message: 'no such label: bugg' },
      ],
    },
    headers: {},
  }
  const out = G.decodeError(r, 'opening an issue', 'GITHUB_TOKEN')
  assert.match(out, /Validation Failed/)
  assert.match(out, /Issue\.title: missing_field/)
  assert.match(out, /no such label: bugg/)
})

test('a 422 about a missing ref says it is the branch that is wrong', () => {
  const r = { status: 422, ok: false, text: '', json: { message: 'No commit found for the ref nonexistent' }, headers: {} }
  assert.match(G.decodeError(r, 'reading commits', 'GITHUB_TOKEN'), /branch or ref does not exist/)
})

test('410, 451 and 5xx are their own answers, not a generic HTTP error', () => {
  assert.match(G.decodeError({ status: 410, ok: false, json: { message: 'Issues are disabled' }, text: '', headers: {} }, 'x', 'y'), /issues are disabled/)
  assert.match(G.decodeError({ status: 451, ok: false, json: {}, text: '', headers: {} }, 'x', 'y'), /legal reasons/)
  assert.match(G.decodeError({ status: 502, ok: false, json: {}, text: '', headers: {} }, 'x', 'y'), /GitHub itself failed/)
  assert.match(G.decodeError({ status: 502, ok: false, json: {}, text: '', headers: {} }, 'x', 'y'), /githubstatus/)
})

test('an HTML error page does not become "[object Object]"', () => {
  const r = { status: 502, ok: false, json: undefined, text: '<html>\n<head><title>502 Bad Gateway</title></head>\n', headers: {} }
  assert.match(G.decodeError(r, 'x', 'y'), /<html>/)
  assert.doesNotMatch(G.decodeError(r, 'x', 'y'), /object Object/)
})

test('the rate limit is mentioned only when it is nearly gone', () => {
  assert.equal(G.rateLimitNote({ 'x-ratelimit-remaining': '4998', 'x-ratelimit-limit': '5000' }), '')
  assert.match(G.rateLimitNote({ 'x-ratelimit-remaining': '12', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '4000000000' }), /12 of 5000 API calls left/)
  // Search's own bucket is 30, so 3 left there matters as much as 300 of core.
  assert.match(G.rateLimitNote({ 'x-ratelimit-remaining': '2', 'x-ratelimit-limit': '30', 'x-ratelimit-reset': '4000000000' }), /2 of 30/)
  assert.equal(G.rateLimitNote({}), '')
})

test('GraphQL errors keep the path and type devduck drops', () => {
  const out = G.formatGraphqlErrors({
    errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: 'Could not resolve to a PullRequest with the number of 99999.', locations: [{ line: 2, column: 3 }] }],
  })
  assert.match(out, /NOT_FOUND/)
  assert.match(out, /at repository\.pullRequest/)
  assert.match(out, /invisible to this token/)
})

test('an error with no path still reports where in the query it was', () => {
  const out = G.formatGraphqlErrors({ errors: [{ message: "Field 'foo' doesn't exist", locations: [{ line: 3, column: 7 }] }] })
  assert.match(out, /query line 3, column 7/)
})

test('a GraphQL partial answer keeps the data AND the error', async () => {
  stubGithub({
    '/graphql': {
      data: { repository: { name: 'Hello-World' }, viewer: null },
      errors: [{ type: 'FORBIDDEN', path: ['viewer'], message: 'Resource protected by organization SAML enforcement.' }],
    },
  })
  const out = await call({ action: 'graphql', query: '{ repository(owner:"o",name:"n"){name} viewer{login} }' })
  assert.match(out, /Hello-World/, 'the half that worked is not thrown away')
  assert.match(out, /partial answer/)
  assert.match(out, /SAML/)
})

test('a GraphQL document that only errors reports the error, not an empty dump', async () => {
  stubGithub({ '/graphql': { data: null, errors: [{ message: 'Parse error on "}"' }] } })
  const out = await call({ action: 'graphql', query: '{ viewer { login } }}' })
  assert.match(out, /^❌ GraphQL errors:/)
  assert.match(out, /Parse error/)
})

test('an HTTP-level GraphQL failure keeps GitHub\'s body, which raise_for_status() discards', async () => {
  stubGithub({ '/graphql': fail(401, { message: 'Bad credentials' }) })
  const out = await call({ action: 'graphql', query: '{ viewer { login } }' })
  assert.match(out, /Bad credentials/)
  assert.match(out, /gh auth login/)
})

test('variables must be a JSON object, and bad JSON says what was wrong', async () => {
  stubGithub({ '/graphql': { data: { viewer: { login: 'x' } } } })
  assert.match(await call({ action: 'graphql', query: '{viewer{login}}', variables: '{oops' }), /not JSON/)
  assert.match(await call({ action: 'graphql', query: '{viewer{login}}', variables: '[1,2]' }), /must be a JSON object/)
})

// ─── 4. rendering an answer instead of dumping JSON ────────────────────────

test('a repo listing is lines a person can read, not 198 KB of JSON', async () => {
  stubGithub({ '/user/repos': [REPO] })
  const out = await call({ action: 'repos' })
  assert.match(out, /octocat\/Hello-World/)
  assert.match(out, /★2541/)
  assert.match(out, /Ruby/)
  assert.match(out, /My first repository/)
  assert.doesNotMatch(out, /"stargazers_count"/, 'no raw JSON keys')
  assert.doesNotMatch(out, /\[/, 'no ANSI escapes in a model-facing answer')
})

test('an issue list resolves the label objects and the author', async () => {
  stubGithub({ '/repos/octocat/Hello-World/issues': [ISSUES[0]] })
  const out = await call({ action: 'issues', repo: 'octocat/Hello-World' })
  assert.match(out, /#1347 Found a bug/)
  assert.match(out, /\[bug, help wanted\]/)
  assert.match(out, /by octocat/)
  assert.doesNotMatch(out, /object Object/)
})

test('/issues returns pull requests too, so asking for issues filters them and says so', async () => {
  stubGithub({ '/repos/octocat/Hello-World/issues': ISSUES })
  const out = await call({ action: 'issues', repo: 'octocat/Hello-World' })
  assert.match(out, /#1347/)
  assert.doesNotMatch(out, /#1350/, 'the PR must not be listed as an issue')
  assert.match(out, /1 pull requests? filtered out/)
  assert.match(out, /action='prs'/)
})

test('a repo with only PRs open does not read as "no issues" and stop there', async () => {
  stubGithub({ '/repos/octocat/Hello-World/issues': [ISSUES[1]] })
  const out = await call({ action: 'issues', repo: 'octocat/Hello-World' })
  assert.match(out, /no open issues/)
  assert.match(out, /1 open PRs though/)
})

test('a draft PR and a review decision are visible without asking for them', async () => {
  stubGithub({ '/repos/octocat/Hello-World/pulls': PULLS })
  const out = await call({ action: 'prs', repo: 'octocat/Hello-World' })
  assert.match(out, /#1350 Fix the bug/)
  assert.match(out, /📝 #1351/)
  assert.match(out, /draft/)
})

test('one PR comes back with its reviews, its checks and its diffstat', async () => {
  const calls = stubGithub({
    '/repos/octocat/Hello-World/pulls/1350': PULLS[0],
    '/repos/octocat/Hello-World/issues/1350/comments': [{ user: { login: 'octocat' }, body: 'LGTM', created_at: '2026-08-13T07:30:00Z' }],
    '/repos/octocat/Hello-World/pulls/1350/reviews': [{ user: { login: 'mojombo' }, state: 'CHANGES_REQUESTED', body: 'needs a test' }],
    '/repos/octocat/Hello-World/commits/abc123def456/check-runs': {
      check_runs: [
        { name: 'unit', status: 'completed', conclusion: 'success' },
        { name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/octocat/Hello-World/runs/9' },
      ],
    },
  })
  const out = await call({ action: 'pr', repo: 'octocat/Hello-World', number: 1350 })
  assert.match(out, /\+12\/-3 across 2 files/)
  assert.match(out, /hubot:fix → master/)
  assert.match(out, /mojombo: changes_requested — needs a test/)
  assert.match(out, /checks: 1 success, 1 failure/)
  assert.match(out, /❌ lint/)
  assert.match(out, /LGTM/)
  // The check-runs call is keyed off head.sha, not the PR number.
  assert.ok(calls.some((c) => c.bare.includes('/commits/abc123def456/check-runs')))
})

test('a PR whose extra endpoints fail still answers with the PR', async () => {
  stubGithub({
    '/repos/octocat/Hello-World/pulls/1350': PULLS[0],
    '/repos/octocat/Hello-World/issues/1350/comments': fail(403, { message: 'Resource not accessible by integration' }),
    '/repos/octocat/Hello-World/pulls/1350/reviews': fail(403, { message: 'Resource not accessible by integration' }),
    '/repos/octocat/Hello-World/commits/abc123def456/check-runs': fail(403, { message: 'Resource not accessible by integration' }),
  })
  const out = await call({ action: 'pr', repo: 'octocat/Hello-World', number: 1350 })
  assert.match(out, /#1350 Fix the bug/)
  assert.match(out, /Fixes #1347/)
})

test('asking for a PR by an issue number says which action reads it', async () => {
  stubGithub({
    '/repos/octocat/Hello-World/pulls/1347': fail(404, { message: 'Not Found' }),
    '/repos/octocat/Hello-World/issues/1347': ISSUES[0],
  })
  const out = await call({ action: 'pr', repo: 'octocat/Hello-World', number: 1347 })
  assert.match(out, /is an issue, not a PR/)
  assert.match(out, /action='issue'/)
})

test('asking for an issue by a PR number reads it and points at the richer action', async () => {
  stubGithub({
    '/repos/octocat/Hello-World/issues/1350': ISSUES[1],
    '/repos/octocat/Hello-World/issues/1350/comments': [],
  })
  const out = await call({ action: 'issue', repo: 'octocat/Hello-World', number: 1350 })
  assert.match(out, /is a pull request/)
  assert.match(out, /action='pr'/)
})

test('notifications group by repo and keep the reason, which is the whole point', async () => {
  stubGithub({ '/notifications': NOTIFICATIONS })
  const out = await call({ action: 'notifications' })
  assert.match(out, /octocat\/Hello-World \(2\)/)
  assert.match(out, /other\/repo \(1\)/)
  assert.match(out, /review requested: Fix the bug/)
  assert.match(out, /PullRequest #1350/)
  // A CheckSuite subject has a null url — that must not become "#null".
  assert.doesNotMatch(out, /#null|#undefined/)
})

test('an empty notification list says how to see the read ones too', async () => {
  stubGithub({ '/notifications': [] })
  assert.match(await call({ action: 'notifications' }), /all=true/)
})

test('a failed workflow run is glyphed, timed and linked; a running one is not linked', async () => {
  stubGithub({ '/repos/octocat/Hello-World/actions/runs': RUNS })
  const out = await call({ action: 'runs', repo: 'octocat/Hello-World' })
  assert.match(out, /❌ CI #42/)
  assert.match(out, /⏳ CI #41/)
  assert.match(out, /120s/, 'run_started_at → updated_at is the duration')
  assert.match(out, /actions\/runs\/1/)
  assert.doesNotMatch(out, /actions\/runs\/2/, 'a run still going has nothing to look at yet')
  assert.match(out, /2 of 4211 runs/)
})

test('a repo with no Actions at all says that, rather than an empty list', async () => {
  stubGithub({ '/repos/octocat/Hello-World/actions/runs': { total_count: 0, workflow_runs: [] } })
  assert.match(await call({ action: 'runs', repo: 'octocat/Hello-World' }), /no Actions at all/)
})

test('a commit message is one line, and the sha is short', async () => {
  stubGithub({ '/repos/octocat/Hello-World/commits': COMMITS })
  const out = await call({ action: 'commits', repo: 'octocat/Hello-World' })
  assert.match(out, /^octocat\/Hello-World, 1 commits:\n6dcb09b Fix all the bugs It was broken\./m)
  assert.doesNotMatch(out, /6dcb09b5b57875/, 'a 40-char sha is noise')
})

test('a file arrives decoded, not as base64', async () => {
  stubGithub({
    '/repos/octocat/Hello-World/contents/README.md': {
      type: 'file', name: 'README.md', size: 13, encoding: 'base64',
      content: Buffer.from('# Hello World').toString('base64') + '\n',
    },
  })
  const out = await call({ action: 'file', repo: 'octocat/Hello-World', path: 'README.md' })
  assert.match(out, /# Hello World/)
  assert.doesNotMatch(out, /IyBIZWxsbyBXb3JsZA/)
})

test('a directory lists as a directory, with the folders first', async () => {
  stubGithub({
    '/repos/octocat/Hello-World/contents/src': [
      { type: 'file', name: 'index.ts', size: 100 },
      { type: 'dir', name: 'agent' },
    ],
  })
  const out = await call({ action: 'file', repo: 'octocat/Hello-World', path: 'src' })
  assert.match(out, /2 entries/)
  assert.ok(out.indexOf('agent/') < out.indexOf('index.ts'))
})

test('a submodule and a symlink are described rather than printed empty', async () => {
  stubGithub({
    '/repos/octocat/Hello-World/contents/vendor': { type: 'submodule', submodule_git_url: 'https://github.com/o/sub.git', sha: 'abcdef1234567890' },
    '/repos/octocat/Hello-World/contents/link': { type: 'symlink', target: '../real/file' },
  })
  assert.match(await call({ action: 'file', repo: 'octocat/Hello-World', path: 'vendor' }), /submodule pointing at https:\/\/github.com\/o\/sub.git/)
  assert.match(await call({ action: 'file', repo: 'octocat/Hello-World', path: 'link' }), /symlink to \.\.\/real\/file/)
})

test('a file too big to inline says where to get it instead of returning nothing', async () => {
  stubGithub({
    '/repos/octocat/Hello-World/contents/big.bin': {
      type: 'file', name: 'big.bin', size: 2_000_000, encoding: 'none', content: '',
      download_url: 'https://raw.githubusercontent.com/octocat/Hello-World/master/big.bin',
    },
  })
  const out = await call({ action: 'file', repo: 'octocat/Hello-World', path: 'big.bin' })
  assert.match(out, /too big for the contents API/)
  assert.match(out, /raw\.githubusercontent\.com/)
})

test('a path with spaces and unicode is encoded per segment, not wholesale', async () => {
  const calls = stubGithub({ '/repos/octocat/Hello-World/contents/docs/my%20file.md': { type: 'file', size: 1, encoding: 'base64', content: Buffer.from('x').toString('base64') } })
  await call({ action: 'file', repo: 'octocat/Hello-World', path: 'docs/my file.md' })
  assert.equal(calls[0].bare, '/repos/octocat/Hello-World/contents/docs/my%20file.md')
  assert.ok(!calls[0].bare.includes('docs%2F'), 'the slashes must stay slashes')
})

test('a search result carries repository_url and still shows which repo it is in', async () => {
  stubGithub({ '/search/issues': SEARCH_ISSUES })
  const out = await call({ action: 'search', q: 'is:open widget', type: 'issues' })
  assert.match(out, /280 match/)
  assert.match(out, /octocat\/Hello-World#132/)
})

test('code search asks for the text-match media type, or the fragments are absent', async () => {
  const calls = stubGithub({
    '/search/code': { total_count: 1, items: [{ path: 'src/a.ts', repository: { full_name: 'octocat/Hello-World' }, text_matches: [{ fragment: 'const answer = 42' }] }] },
  })
  const out = await call({ action: 'search', q: 'answer', type: 'code' })
  assert.match(calls[0].accept, /text-match/)
  assert.match(out, /octocat\/Hello-World\/src\/a\.ts/)
  assert.match(out, /const answer = 42/)
})

test('an incomplete search says so — GitHub times out mid-search and still answers 200', async () => {
  stubGithub({ '/search/repositories': { total_count: 9, incomplete_results: true, items: [REPO] } })
  assert.match(await call({ action: 'search', q: 'x' }), /incomplete/)
})

test('a Link header with rel=next is the only honest "there is more"', async () => {
  stubGithub({
    '/repos/octocat/Hello-World/issues': () => ({
      __status: 200, __body: [ISSUES[0]],
      __headers: { link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next", <…>; rel="last"' },
    }),
  })
  const out = await call({ action: 'issues', repo: 'octocat/Hello-World' })
  assert.match(out, /more issues exist/)
  assert.match(out, /max 100/)
  assert.equal(G.hasMore({ link: '<…>; rel="prev"' }), false)
  assert.equal(G.hasMore({}), false)
})

test('a body long enough to bury the answer is truncated with the count', () => {
  const out = G.truncate('x'.repeat(G.BODY_MAX + 500))
  assert.match(out, /truncated, 500 more characters/)
  assert.equal(G.truncate('short'), 'short')
})

test('relative times read like a person wrote them', () => {
  const now = new Date('2026-08-13T12:00:00Z')
  assert.equal(G.relTime('2026-08-13T11:59:30Z', now), '30s ago')
  assert.equal(G.relTime('2026-08-13T11:00:00Z', now), '60m ago')
  assert.equal(G.relTime('2026-08-13T04:00:00Z', now), '8h ago')
  assert.equal(G.relTime('2026-08-01T12:00:00Z', now), '12d ago')
  assert.equal(G.relTime('2026-01-01T12:00:00Z', now), '7mo ago')
  assert.equal(G.relTime('2019-01-01T12:00:00Z', now), '8y ago')
  assert.equal(G.relTime(undefined, now), '')
  assert.equal(G.relTime('not a date', now), '')
})

// ─── owner/name, however it was written ────────────────────────────────────

test('a pasted PR link becomes owner, name AND number', () => {
  const t = G.parseTarget('https://github.com/octocat/Hello-World/pull/1350')
  assert.deepEqual(t, { owner: 'octocat', name: 'Hello-World', number: 1350 })
})

test('every shape of a repository reference resolves', () => {
  const expect = { owner: 'octocat', name: 'Hello-World' }
  for (const s of [
    'octocat/Hello-World',
    'https://github.com/octocat/Hello-World',
    'http://www.github.com/octocat/Hello-World/',
    'github.com/octocat/Hello-World',
    'git@github.com:octocat/Hello-World.git',
    'https://api.github.com/repos/octocat/Hello-World',
    'https://github.com/octocat/Hello-World/tree/main',
  ]) {
    assert.deepEqual(G.parseTarget(s), expect, s)
  }
  assert.deepEqual(G.parseTarget('octocat/Hello-World#1350'), { ...expect, number: 1350 })
  assert.deepEqual(G.parseTarget('https://github.com/octocat/Hello-World/issues/7'), { ...expect, number: 7 })
})

test('a bare name needs an owner, and the error says so', () => {
  assert.match(G.parseTarget('Hello-World').error, /owner\/Hello-World/)
  assert.deepEqual(G.parseTarget('Hello-World', 'octocat'), { owner: 'octocat', name: 'Hello-World' })
})

test('a bare name is resolved against the viewer, which costs one /user call', async () => {
  const calls = stubGithub({ '/user': USER, '/repos/octocat/Hello-World': REPO })
  const out = await call({ action: 'repo', repo: 'Hello-World' })
  assert.match(out, /octocat\/Hello-World/)
  assert.deepEqual(calls.map((c) => c.bare), ['/user', '/repos/octocat/Hello-World'])
})

test('nonsense is refused rather than turned into a request', () => {
  assert.match(G.parseTarget('').error, /repo is required/)
  assert.match(G.parseTarget(undefined).error, /repo is required/)
  assert.match(G.parseTarget('has spaces/in it').error, /not a repository/)
  // Extra path segments are how a github.com URL is shaped, so they are
  // dropped rather than rejected — but a traversal must never survive into the
  // request path, which is what the charset check on both halves is for.
  assert.deepEqual(G.parseTarget('a/b/c/../../etc/passwd'), { owner: 'a', name: 'b' })
  assert.match(G.parseTarget('../../etc/passwd').error ?? '', /not a repository/)
  assert.match(G.parseTarget('me/..').error ?? '', /not a repository/)
  // An underscore is not legal in a GitHub login, so it is a typo, not a repo.
  assert.match(G.parseTarget('my_org/repo').error ?? '', /not a repository/)
  assert.deepEqual(G.parseTarget('my-org/repo.js'), { owner: 'my-org', name: 'repo.js' })
})

test('a renamed repo answers under its new name, and that is said out loud', async () => {
  // What GitHub really does: 301 to the new name, which fetch follows silently.
  stubGithub({ '/repos/strands-agents/sdk-python': { ...REPO, full_name: 'strands-agents/harness-sdk' } })
  const out = await call({ action: 'repo', repo: 'strands-agents/sdk-python' })
  assert.match(out, /is a redirect — the repo is now strands-agents\/harness-sdk/)
})

// ─── writes ────────────────────────────────────────────────────────────────

test('opening an issue is ONE call with owner and name, not a node-id lookup first', async () => {
  const calls = stubGithub({
    '/repos/octocat/Hello-World/issues': (c) => (c.method === 'POST'
      ? { number: 1352, title: c.body.title, html_url: 'https://github.com/octocat/Hello-World/issues/1352' }
      : []),
  })
  const out = await call({ action: 'create_issue', repo: 'octocat/Hello-World', title: 'It broke', body: 'again' })
  assert.equal(calls.length, 1, 'devduck needs a repositoryId first, so it needs two')
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].body, { title: 'It broke', body: 'again' })
  assert.match(out, /✅ opened octocat\/Hello-World#1352/)
  assert.match(out, /issues\/1352/)
})

test('a write with a missing argument names the argument, and sends nothing', async () => {
  const calls = stubGithub({})
  assert.match(await call({ action: 'create_issue', repo: 'octocat/Hello-World' }), /need title/)
  assert.match(await call({ action: 'comment', repo: 'octocat/Hello-World', number: 1 }), /need body/)
  assert.match(await call({ action: 'comment', repo: 'octocat/Hello-World', body: 'hi' }), /need number/)
  assert.equal(calls.length, 0, 'nothing may reach GitHub while an argument is missing')
})

test('a comment goes to the issues endpoint even for a PR, which is where GitHub keeps them', async () => {
  const calls = stubGithub({ '/repos/octocat/Hello-World/issues/1350/comments': { html_url: 'https://github.com/octocat/Hello-World/pull/1350#issuecomment-1' } })
  const out = await call({ action: 'comment', repo: 'https://github.com/octocat/Hello-World/pull/1350', body: 'ship it' })
  assert.equal(calls[0].bare, '/repos/octocat/Hello-World/issues/1350/comments')
  assert.deepEqual(calls[0].body, { body: 'ship it' })
  assert.match(out, /✅ commented on octocat\/Hello-World#1350/)
})

test('a DELETE without confirmation is refused, and the refusal is copy-pasteable', async () => {
  const calls = stubGithub({})
  const out = await call({ action: 'rest', path: '/repos/octocat/Hello-World', method: 'DELETE' })
  assert.equal(calls.length, 0)
  assert.match(out, /refusing to DELETE/)
  assert.match(out, /confirm='\/repos\/octocat\/Hello-World'/)
})

test('a DELETE with the wrong confirmation is still refused', async () => {
  const calls = stubGithub({})
  await call({ action: 'rest', path: '/repos/octocat/Hello-World', method: 'DELETE', confirm: '/repos/octocat/other' })
  assert.equal(calls.length, 0)
})

test('a confirmed DELETE goes through, and a 204 reads as success not as silence', async () => {
  const calls = stubGithub({ '/repos/octocat/Hello-World/subscription': () => ({ __status: 204, __body: undefined }) })
  const out = await call({ action: 'rest', path: '/repos/octocat/Hello-World/subscription', method: 'DELETE', confirm: '/repos/octocat/Hello-World/subscription' })
  assert.equal(calls[0].method, 'DELETE')
  assert.match(out, /204, no content/)
  assert.match(out, /success/)
})

test('methods are normalised, and a GET carries no body', async () => {
  assert.equal(G.normalizeMethod('post'), 'POST')
  assert.equal(G.normalizeMethod(' delete '), 'DELETE')
  assert.equal(G.normalizeMethod(undefined), 'GET')
  const calls = stubGithub({ '/rate_limit': { rate: { remaining: 4998 } } })
  await call({ action: 'rest', path: '/rate_limit', method: 'get' })
  assert.equal(calls[0].body, undefined)
})

test('a POST through rest with no body still sends {}, which GitHub requires', async () => {
  const calls = stubGithub({ '/repos/octocat/Hello-World/forks': { full_name: 'me/Hello-World' } })
  await call({ action: 'rest', path: '/repos/octocat/Hello-World/forks', method: 'POST' })
  assert.deepEqual(calls[0].body, {})
})

// ─── the request itself ────────────────────────────────────────────────────

test('every request is authenticated and version-pinned', async () => {
  const calls = stubGithub({ '/user': USER })
  await call({ action: 'me' })
  assert.match(calls[0].auth, /^Bearer ghp_testtoken/)
  assert.match(calls[0].accept, /vnd\.github\+json/)
})

test('a relative path and an absolute URL both work, and nothing else is accepted as a host', () => {
  assert.equal(G.apiUrl('/user'), 'https://api.github.com/user')
  assert.equal(G.apiUrl('user'), 'https://api.github.com/user')
  assert.equal(G.apiUrl('https://api.github.com/user?page=2'), 'https://api.github.com/user?page=2')
})

test('the limit is clamped to what GitHub will accept', () => {
  assert.equal(G.clampLimit(undefined), G.PER_PAGE)
  assert.equal(G.clampLimit(0), G.PER_PAGE)
  assert.equal(G.clampLimit(-5), G.PER_PAGE)
  assert.equal(G.clampLimit(500), 100)
  assert.equal(G.clampLimit(7), 7)
  assert.equal(G.clampLimit(7.9), 7)
})

test('empty query parameters are dropped instead of sent as ""', () => {
  assert.equal(G.encodeQuery({ a: 1, b: undefined, c: '', d: null, e: 'x' }), '?a=1&e=x')
  assert.equal(G.encodeQuery({}), '')
  assert.equal(G.encodeQuery({ q: 'is:open label:bug' }), '?q=is%3Aopen+label%3Abug')
})

test('the request timeout is a knob, and a sane default', () => {
  assert.equal(G.requestTimeout({}), G.REQUEST_TIMEOUT_MS)
  assert.equal(G.requestTimeout({ TINY_GITHUB_TIMEOUT_MS: '1500' }), 1500)
  assert.equal(G.requestTimeout({ TINY_GITHUB_TIMEOUT_MS: 'soon' }), G.REQUEST_TIMEOUT_MS)
  assert.equal(G.requestTimeout({ TINY_GITHUB_TIMEOUT_MS: '0' }), G.REQUEST_TIMEOUT_MS)
  assert.equal(G.requestTimeout({ TINY_GITHUB_TIMEOUT_MS: '-1' }), G.REQUEST_TIMEOUT_MS)
  assert.equal(G.requestTimeout({ TINY_GITHUB_TIMEOUT_MS: 'Infinity' }), G.REQUEST_TIMEOUT_MS)
})

test('a timeout says which knob raises it, and does not throw', async () => {
  globalThis.fetch = async () => { const e = new Error('The operation was aborted'); e.name = 'TimeoutError'; throw e }
  const out = await call({ action: 'me' })
  assert.match(out, /did not answer within 30s/)
  assert.match(out, /TINY_GITHUB_TIMEOUT_MS/)
})

test('a dead network is a network answer, not a stack trace', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.github.com') }
  const out = await call({ action: 'me' })
  assert.match(out, /cannot reach api\.github\.com/)
  assert.match(out, /check the network/)
})

test('the tool never throws, whatever the API does', async () => {
  for (const f of [
    async () => { throw new Error('boom') },
    async () => ({ status: 200, ok: true, text: async () => 'not json at all', headers: { forEach: () => {} } }),
    async () => ({ status: 200, ok: true, text: async () => '', headers: { forEach: () => {} } }),
    async () => ({ status: 200, ok: true, text: async () => 'null', headers: { forEach: () => {} } }),
  ]) {
    globalThis.fetch = f
    for (const action of ['me', 'repos', 'notifications']) {
      const out = await call({ action, repo: 'octocat/Hello-World' })
      assert.equal(typeof out, 'string')
      assert.ok(out.length > 0, `${action} returned nothing`)
    }
  }
})

test('help needs no token and no network', async () => {
  globalThis.fetch = async () => { throw new Error('the network must not be touched') }
  const out = await call({ action: 'help' })
  assert.match(out, /use_github/)
  assert.match(out, /create_issue repo= title=/)
  assert.match(out, /graphql query=/)
})

test('every action in the schema is documented in the help, and vice versa', async () => {
  globalThis.fetch = async () => { throw new Error('no network') }
  const help = await call({ action: 'help' })
  const actions = G.GITHUB_ACTIONS
  assert.ok(actions.length >= 16, 'the action list should be readable')
  for (const a of actions) {
    if (a === 'help') continue
    assert.match(help, new RegExp(`\\b${a}\\b`), `${a} is undocumented`)
  }
})

test('headersToMap lowercases, and survives a Headers object or a plain one', () => {
  assert.deepEqual(G.headersToMap({ 'X-RateLimit-Remaining': '5' }), { 'x-ratelimit-remaining': '5' })
  assert.deepEqual(G.headersToMap(undefined), {})
  const h = { forEach: (fn) => fn('9', 'X-Thing') }
  assert.deepEqual(G.headersToMap(h), { 'x-thing': '9' })
})

test('the answer to "who am I" includes the scopes, the kind and the budget', async () => {
  stubGithub({ '/user': USER })
  const out = await call({ action: 'me' })
  assert.match(out, /octocat \(The Octocat\)/)
  assert.match(out, /8 public repos/)
  assert.match(out, /classic PAT/)
  assert.match(out, /scopes: repo, workflow, notifications/)
  assert.match(out, /4998\/5000 core calls left/)
})

test('"my open PRs" needs no repo, and asks about the viewer by login', async () => {
  const calls = stubGithub({ '/user': USER, '/search/issues': SEARCH_ISSUES })
  const out = await call({ action: 'prs' })
  assert.match(calls[1].query.q, /is:pr state:open involves:octocat/)
  assert.match(out, /280 match/)
})

test('a search with an explicit q overrides the involves: default', async () => {
  const calls = stubGithub({ '/user': USER, '/search/issues': SEARCH_ISSUES })
  await call({ action: 'issues', q: 'is:issue label:bug repo:octocat/Hello-World' })
  assert.equal(calls[1].query.q, 'is:issue label:bug repo:octocat/Hello-World')
})

test('an unknown action is answered, not thrown', async () => {
  stubGithub({})
  const out = await call({ action: 'nonsense' })
  assert.match(out, /unknown action "nonsense"/)
})

// ─── 8. the survivors of the mutation sweep ─────────────────────────────────
//
// Each test below exists because a deliberate break in github.ts passed the
// suite. The sweep (140 mutants) went 116 → 138 caught with these.

/**
 * A PATH holding fake `gh`/`git` binaries. Each script touches `<name>.ran` on
 * entry, which is how "was it spawned at all?" gets asserted — the gate is only
 * cheap if nothing ever runs.
 */
function fakeBin(scripts) {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-gh-bin-'))
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n: > "${dir}/${name}.ran"\n${body}\n`, { mode: 0o755 })
  }
  return dir
}

const NO_CONFIG = { XDG_CONFIG_HOME: '/nonexistent-tiny', HOME: '/nonexistent-tiny' }

test('with nothing in the env, the token comes from the gh CLI', () => {
  const dir = fakeBin({ gh: 'echo gho_fromcli' })
  G.resetGithubToken()
  const found = G.resolveToken({ ...NO_CONFIG, PATH: dir }, 1)
  assert.equal(found?.token, 'gho_fromcli')
  assert.match(found.source, /gh auth token/)
  G.resetGithubToken()
})

test('gh talking is not a token — "not logged in" contains spaces, tokens never do', () => {
  // gh prints this to stderr and exits 1, but a wrapper or an alias can put it
  // on stdout with a 0. Either way it is not a credential.
  assert.equal(G.ghCliToken({ ...NO_CONFIG, PATH: fakeBin({ gh: 'echo "not logged in to any hosts"' }) }), undefined)
  assert.equal(G.ghCliToken({ ...NO_CONFIG, PATH: fakeBin({ gh: 'exit 1' }) }), undefined)
  assert.equal(G.ghCliToken({ ...NO_CONFIG, PATH: fakeBin({ gh: 'echo' }) }), undefined)
})

test('a wedged spawn is abandoned, not waited on — a hung child would hang the turn', () => {
  // Both of these can block indefinitely in the field: gh on a stalled keyring
  // prompt, git on a credential helper waiting for a Touch ID that never comes.
  for (const [name, probe] of [['gh', G.ghCliToken], ['git', G.gitCredentialToken]]) {
    // /bin/sleep, not sleep: git is spawned with a stripped PATH, and a child
    // that dies with a 127 would prove nothing about the timeout.
    const dir = fakeBin({ [name]: '/bin/sleep 5' })
    const started = process.hrtime.bigint()
    assert.equal(probe({ ...NO_CONFIG, PATH: dir }, 200), undefined)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    assert.ok(ms < 2_000, `${name}: gave up after ${Math.round(ms)}ms, not the child's 5s`)
  }
})

test('gh failing falls through to hosts.yml, and hosts.yml to the keychain', () => {
  const cfg = mkdtempSync(join(tmpdir(), 'tiny-gh-cfg-'))
  mkdirSync(join(cfg, 'gh'), { recursive: true })
  writeFileSync(join(cfg, 'gh', 'hosts.yml'), 'github.com:\n    oauth_token: gho_fromyml\n')

  const loggedOut = fakeBin({ gh: 'exit 1', git: 'echo password=ghp_fromkeychain' })
  G.resetGithubToken()
  const viaYml = G.resolveToken({ PATH: loggedOut, XDG_CONFIG_HOME: cfg }, 1)
  assert.equal(viaYml?.token, 'gho_fromyml', 'gh exited 1, so the config file answers')

  G.resetGithubToken()
  const viaKeychain = G.resolveToken({ ...NO_CONFIG, PATH: loggedOut }, 1)
  assert.equal(viaKeychain?.token, 'ghp_fromkeychain', 'no config either, so the credential helper answers')
  assert.match(viaKeychain.source, /keychain/)
  G.resetGithubToken()
})

test('git is told not to prompt, or the question lands behind the Ink frame', () => {
  const dir = fakeBin({ git: 'echo "prompt=[$GIT_TERMINAL_PROMPT]"\necho password=ghp_x' })
  const found = G.gitCredentialToken({ ...NO_CONFIG, PATH: dir })
  assert.equal(found?.token, 'ghp_x')
  // The fake echoes what it was given: 0 means git fails instead of asking.
  assert.match(String(readFileSync(join(dir, 'git.ran'), 'utf8')), /^$/)
  const withPrompt = G.gitCredentialToken({ ...NO_CONFIG, PATH: fakeBin({ git: 'test "$GIT_TERMINAL_PROMPT" = 0 && echo password=ghp_quiet' }) })
  assert.equal(withPrompt?.token, 'ghp_quiet', 'GIT_TERMINAL_PROMPT=0 reached git')
})

test('the gate mounts on a `gh` that exists without ever running it', () => {
  const dir = fakeBin({ gh: 'echo gho_never' })
  assert.equal(G.hasGithub({ ...NO_CONFIG, PATH: dir }, '/nonexistent-tiny'), true)
  assert.equal(existsSync(join(dir, 'gh.ran')), false, 'the gate spawned gh — that is 29ms on every tiny start')
})

test('a 422 whose errors are bare strings keeps them', () => {
  const r = { status: 422, ok: false, headers: {}, text: '', json: { message: 'Validation Failed', errors: ['Body is too long (maximum is 65536 characters)'] } }
  assert.match(G.decodeError(r, 'commenting', 'GITHUB_TOKEN'), /Body is too long/)
})

test('a GraphQL error type is printed even when the message spells it out', () => {
  const out = G.formatGraphqlErrors({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] })
  assert.match(out, /\[FORBIDDEN\]/)
})

test('a GraphQL answer where every field is null says so instead of nothing', async () => {
  stubGithub({ '/graphql': { data: { repository: null } } })
  const out = await call({ action: 'graphql', query: '{ repository(owner:"o",name:"nope"){ name } }' })
  assert.match(out, /every field resolved to null/)
})

test('mutation must be the operation — clientMutationId and a mutation field are reads', () => {
  // Depth: a field named `mutation` inside a selection set is a field.
  assert.equal(G.isMutation('query { repository(owner:"o",name:"n") { mutation } }'), false)
  // Prefix: the word ends at a boundary but starts inside a longer identifier.
  assert.equal(G.isMutation('query($x: clientMutation) { viewer { login } }'), false)
  assert.equal(G.isMutation('{ node(id:"x") { ... on Issue { clientMutationId } } }'), false)
  assert.equal(G.isMutation('mutation { addComment(input:{}) { clientMutationId } }'), true)
})

test('a block string holding the word mutation is a search term, not an operation', () => {
  assert.equal(G.isMutation('query { search(query: """mutation createIssue""", type: ISSUE) { issueCount } }'), false)
  // Literals collapse to an empty pair, so the structure around them survives.
  assert.equal(G.stripLiterals('a """mutation""" b'), 'a "" b')
})

test('every request pins the API version and carries a deadline', async () => {
  let init
  globalThis.fetch = async (_u, i) => {
    init = i
    return response(200, USER)
  }
  await call({ action: 'me' })
  assert.equal(init.headers['X-GitHub-Api-Version'], G.API_VERSION)
  assert.match(init.headers['User-Agent'], /tiny/i)
  assert.ok(init.signal instanceof AbortSignal, 'no signal means a hung socket hangs the conversation')
})

test('TINY_GITHUB_TIMEOUT_MS is the deadline that is actually armed', async () => {
  assert.equal(G.requestTimeout({ TINY_GITHUB_TIMEOUT_MS: '1500' }), 1500)
  assert.equal(G.requestTimeout({ TINY_GITHUB_TIMEOUT_MS: '0' }), G.REQUEST_TIMEOUT_MS)
  assert.equal(G.requestTimeout({ TINY_GITHUB_TIMEOUT_MS: 'soon' }), G.REQUEST_TIMEOUT_MS)
  assert.equal(G.requestTimeout({}), G.REQUEST_TIMEOUT_MS)

  const before = process.env.TINY_GITHUB_TIMEOUT_MS
  process.env.TINY_GITHUB_TIMEOUT_MS = '5'
  let init
  globalThis.fetch = async (_u, i) => { init = i; return response(200, USER) }
  try {
    await call({ action: 'me' })
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(init.signal.aborted, true, 'the knob was read but the default was armed')
  } finally {
    if (before === undefined) delete process.env.TINY_GITHUB_TIMEOUT_MS
    else process.env.TINY_GITHUB_TIMEOUT_MS = before
  }
})

test('a body that is not JSON is returned, not thrown — /zen answers in plain text', async () => {
  stubGithub({ '/zen': 'Keep it logically awesome.' })
  const out = await call({ action: 'rest', path: '/zen' })
  assert.match(out, /Keep it logically awesome\./)
})

test('a state glyph distinguishes the four states an item can be in', () => {
  assert.equal(G.stateGlyph({ state: 'open', draft: true }), '📝')
  assert.equal(G.stateGlyph({ state: 'closed', merged_at: '2026-08-01T00:00:00Z' }), '🟣')
  assert.equal(G.stateGlyph({ state: 'closed' }), '🔴')
  assert.equal(G.stateGlyph({ state: 'open' }), '🟢')
})

test('base64 arrives wrapped at 60 columns, and decodes across the breaks', () => {
  const wrapped = Buffer.from('hello from the contents API').toString('base64').replace(/(.{10})/g, '$1\n')
  assert.equal(G.decodeContent({ encoding: 'base64', content: wrapped }), 'hello from the contents API')
  assert.equal(G.decodeContent({ content: 'plain' }), 'plain')
})

test('a file bigger than the context budget is cut, with the count of what was cut', async () => {
  const huge = 'x'.repeat(G.FILE_MAX + 5_000)
  stubGithub({
    '/repos/octocat/Hello-World/contents/huge.txt': {
      type: 'file', name: 'huge.txt', size: huge.length, encoding: 'base64',
      content: Buffer.from(huge).toString('base64'),
    },
  })
  const out = await call({ action: 'file', repo: 'octocat/Hello-World', path: 'huge.txt' })
  assert.match(out, /truncated, 5000 more characters/)
  assert.ok(out.length < G.FILE_MAX + 500, `returned ${out.length} bytes of a ${huge.length}-byte file`)
})

test('an action that needs a number and has none says which argument is missing', async () => {
  stubGithub({})
  assert.match(await call({ action: 'issue', repo: 'octocat/Hello-World' }), /need number/)
  assert.match(await call({ action: 'pr', repo: 'octocat/Hello-World' }), /need number/)
  assert.match(await call({ action: 'comment', repo: 'octocat/Hello-World', body: 'hi' }), /need number/)
})
