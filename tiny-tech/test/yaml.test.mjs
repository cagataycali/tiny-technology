/**
 * A YAML subset parser earns its keep by being pinned line by line.
 *
 * The failure mode this suite exists for: a spec that parses "fine" and is
 * quietly missing half an endpoint. Every construct below appears in real
 * OpenAPI specs — the flow collections spanning lines are Stripe's, the merge
 * keys are Kubernetes', the wrapped plain scalars are every hand-written spec —
 * and the last section checks that what we DON'T support says so with a line
 * number instead of guessing.
 */
import { test } from 'node:test'
import assert from 'node:assert'

const { parseYaml, parseJsonOrYaml, parseScalar, YamlError } = await import('../dist/agent/yaml.js')

const y = (s) => parseYaml(s)

// ─── scalars ────────────────────────────────────────────────────────────────

test('YAML 1.2 core types, and nothing more clever', () => {
  assert.equal(parseScalar('42'), 42)
  assert.equal(parseScalar('-3'), -3)
  assert.equal(parseScalar('3.14'), 3.14)
  assert.equal(parseScalar('1e3'), 1000)
  assert.equal(parseScalar('0x1f'), 31)
  assert.equal(parseScalar('true'), true)
  assert.equal(parseScalar('FALSE'), false)
  assert.equal(parseScalar('~'), null)
  assert.equal(parseScalar('null'), null)
  assert.equal(parseScalar(''), null)
  assert.equal(parseScalar('3.0.1'), '3.0.1', 'a version is a string, not a number')
  assert.equal(parseScalar('v1'), 'v1')
})

test('yes/no/on/off stay strings — 1.1 turned them into booleans and specs broke', () => {
  // A `description: no` that becomes `false` changes what an API doc SAYS.
  for (const s of ['yes', 'no', 'on', 'off', 'y', 'n', 'Yes', 'OFF']) {
    assert.equal(parseScalar(s), s, s)
  }
})

test('an unknown !tag is dropped and its value kept', () => {
  // PyYAML's safe_load REFUSES a document containing `!!python/name:...` —
  // devduck's own mkdocs.yml can't be read by the library devduck depends on.
  // A tag we don't know is not a reason to lose the file.
  assert.deepEqual(y('emoji: !!python/name:material.twemoji ""'), { emoji: '' })
  assert.equal(y('a: !!str 42').a, '42')
  assert.deepEqual(y('a: !Custom\n  b: 1'), { a: { b: 1 } })
})

test('quotes decide the type, and escapes are honoured', () => {
  assert.equal(y('a: "42"').a, '42', 'quoted digits are a string')
  assert.equal(y("a: '42'").a, '42')
  assert.equal(y('a: "line\\nbreak"').a, 'line\nbreak')
  assert.equal(y('a: "\\u00e7ay"').a, 'çay')
  assert.equal(y("a: 'it''s'").a, "it's")
  assert.equal(y('a: "quote \\" inside"').a, 'quote " inside')
  assert.equal(y('a: "tab\\there"').a, 'tab\there')
})

test('a # is only a comment where YAML says it is', () => {
  assert.deepEqual(y('a: 1 # trailing\n# whole line\nb: 2'), { a: 1, b: 2 })
  assert.equal(y('a: "issue #42"').a, 'issue #42', 'inside quotes it is data')
  assert.equal(y('a: red#ish').a, 'red#ish', 'glued to a word it is data')
  assert.equal(y("a: '#fff'").a, '#fff')
})

// ─── block collections ──────────────────────────────────────────────────────

test('nested mappings and sequences, the shape every spec is made of', () => {
  const doc = y(`openapi: 3.0.0
info:
  title: Pet Store
  version: "1.0"
servers:
- url: https://api.example.com/v1
- url: https://staging.example.com
tags:
  - name: pets
    description: everything about pets
  - name: store
`)
  assert.equal(doc.info.title, 'Pet Store')
  assert.equal(doc.info.version, '1.0')
  assert.equal(doc.servers.length, 2)
  assert.equal(doc.servers[0].url, 'https://api.example.com/v1', 'a colon inside a URL is not a key')
  assert.deepEqual(doc.tags[0], { name: 'pets', description: 'everything about pets' })
  assert.deepEqual(doc.tags[1], { name: 'store' })
})

test('a sequence may sit at its key\'s own indentation, or deeper', () => {
  assert.deepEqual(y('a:\n- 1\n- 2\nb: x'), { a: [1, 2], b: 'x' })
  assert.deepEqual(y('a:\n  - 1\n  - 2\nb: x'), { a: [1, 2], b: 'x' })
})

test('sequences of sequences, and maps that keep going after them', () => {
  assert.deepEqual(y('a:\n  - - 1\n    - 2\n  - - 3\nz: 9'), { a: [[1, 2], [3]], z: 9 })
})

test('an empty value is null, not an empty string', () => {
  const doc = y('a:\nb: 1\nc:')
  assert.equal(doc.a, null)
  assert.equal(doc.b, 1)
  assert.ok('c' in doc && doc.c === null)
})

test('deeply nested paths — the actual shape of an operation', () => {
  const doc = y(`paths:
  /pets/{petId}:
    get:
      operationId: getPet
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: ok
`)
  const op = doc.paths['/pets/{petId}'].get
  assert.equal(op.operationId, 'getPet')
  assert.equal(op.parameters[0].in, 'path')
  assert.equal(op.parameters[0].required, true)
  assert.equal(op.parameters[0].schema.type, 'string')
  assert.equal(op.responses['200'].description, 'ok', 'a quoted numeric key stays a key')
})

// ─── flow collections ───────────────────────────────────────────────────────

test('flow collections, including nested and empty', () => {
  assert.deepEqual(y('a: [1, 2, 3]').a, [1, 2, 3])
  assert.deepEqual(y('a: {x: 1, y: two}').a, { x: 1, y: 'two' })
  assert.deepEqual(y('a: [{n: 1}, {n: 2}]').a, [{ n: 1 }, { n: 2 }])
  assert.deepEqual(y('a: []').a, [])
  assert.deepEqual(y('a: {}').a, {})
  assert.deepEqual(y('a: ["with, comma", b]').a, ['with, comma', 'b'])
  assert.deepEqual(y('security: [{OAuth2: [read, write]}]').security, [{ OAuth2: ['read', 'write'] }])
})

test('a flow collection that runs over several lines (this is Stripe)', () => {
  const doc = y(`enum: [
    a,
    b,
    c
  ]
after: 1
`)
  assert.deepEqual(doc.enum, ['a', 'b', 'c'])
  assert.equal(doc.after, 1, 'parsing resumes on the line after the collection closes')
})

// ─── block scalars ──────────────────────────────────────────────────────────

test('literal block scalars keep their line breaks', () => {
  const doc = y('description: |\n  line one\n  line two\nnext: 1')
  assert.equal(doc.description, 'line one\nline two\n')
  assert.equal(doc.next, 1)
})

test('chomping: - strips, + keeps, default clips to one newline', () => {
  assert.equal(y('a: |-\n  x\n  y\nb: 1').a, 'x\ny')
  assert.equal(y('a: |\n  x\n\n\nb: 1').a, 'x\n')
  assert.equal(y('a: |+\n  x\n\n\nb: 1').a, 'x\n\n\n')
})

test('folded block scalars join lines, keep paragraphs, keep indented blocks', () => {
  assert.equal(y('a: >\n  one\n  two\nb: 1').a, 'one two\n')
  assert.equal(y('a: >\n  para one\n\n  para two\nb: 1').a, 'para one\npara two\n')
  // An indented line inside `>` is a code sample and must not be folded away.
  assert.equal(y('a: >\n  text\n    code\n  more\nb: 1').a, 'text\n  code\nmore\n')
})

test('an explicit indent indicator makes leading spaces part of the text', () => {
  assert.equal(y('a: |2\n    indented\nb: 1').a, '  indented\n')
})

test('a block scalar at the end of a file with no final newline gains none', () => {
  // Found by diffing this parser against PyYAML on a real GitHub Action: clip
  // chomping keeps the SOURCE's line break, and a file that stops mid-line has
  // none to keep. Every other file then matched byte for byte.
  assert.deepEqual(y('run: |\n  uv run agent.py'), { run: 'uv run agent.py' })
  assert.equal(y('run: |\n  uv run agent.py\n').run, 'uv run agent.py\n')
  assert.equal(y('run: |+\n  x\n').run, 'x\n', 'the final newline is a terminator, not a blank line')
})

test('a block scalar can BE a sequence item', () => {
  // Stripe's spec writes ~200 long enum values this way, and it was the only
  // thing standing between this reader and the flagship 170k-line spec: the
  // text sits one column right of the dash, which is not deeper than the item's
  // own content column, so measuring against the item read an empty scalar and
  // then tripped over the text as stray indentation.
  assert.deepEqual(y('enum:\n  - short\n  - >-\n    a_very_long_value_on_its_own_line\n  - other\n'),
    { enum: ['short', 'a_very_long_value_on_its_own_line', 'other'] })
  assert.deepEqual(y('a:\n  - |\n    one\n    two\nb: 1'), { a: ['one\ntwo\n'], b: 1 })
  assert.deepEqual(y('a:\n  - >-\n    folded\n    over\n'), { a: ['folded over'] })
})

test('a "blank" line inside a block scalar is only blank up to the indent', () => {
  // OpenAI's code samples have trailing whitespace on their empty lines. Those
  // spaces are CONTENT (they reach past the block indent), and reading them as
  // an empty line drops the break — the sample came back a line short.
  assert.equal(y('a: |\n  one\n    \n  two\n').a, 'one\n  \ntwo\n')
  assert.equal(y('a: |\n  one\n  \n  two\n').a, 'one\n\ntwo\n', 'exactly the indent IS blank')
  assert.equal(y('a: |\n  one\n\n  two\n').a, 'one\n\ntwo\n')
  // A `|+` block whose body is one empty line keeps that break and no other.
  assert.equal(y('a: |+\n  \nb: 1').a, '\n')
})

test('a block scalar swallows what looks like YAML inside it', () => {
  const doc = y('description: |\n  key: not a key\n  - not a list\nreal: 1')
  assert.equal(doc.description, 'key: not a key\n- not a list\n')
  assert.equal(doc.real, 1)
})

// ─── plain multi-line scalars ───────────────────────────────────────────────

test('a wrapped plain scalar folds — how every hand-written summary looks', () => {
  const doc = y(`summary: This is a long summary
  that wraps across lines
operationId: doThing
`)
  assert.equal(doc.summary, 'This is a long summary that wraps across lines')
  assert.equal(doc.operationId, 'doThing', 'the next key is still a key')
})

test('a wrapped scalar stops at the next key, sibling or parent', () => {
  const doc = y('a:\n  b: one\n     two\n  c: 3\nd: 4')
  assert.equal(doc.a.b, 'one two')
  assert.equal(doc.a.c, 3)
  assert.equal(doc.d, 4)
})

test('a quoted scalar may wrap, and a trailing \\ swallows the break', () => {
  // Both halves are OpenAI's spec. The plain fold is prose and wants a space;
  // the escaped break is a long `$ref` split mid-identifier, and a space there
  // is a reference that resolves to nothing.
  assert.equal(y('a: "one\n  two"\nb: 1').a, 'one two')
  assert.equal(
    y('schema:\n  $ref: "#/components/schemas/RunStepDetailsToolCallsFileSearchRankingOptionsObje\\\n    ct"\nx: 1').schema.$ref,
    '#/components/schemas/RunStepDetailsToolCallsFileSearchRankingOptionsObject',
  )
  // `esc \\` + a real line break: the backslash is itself escaped, so the
  // break is a plain fold and the value keeps one backslash and gains a space.
  assert.equal(y(['a: "esc \\\\', '  cont"'].join('\n')).a, 'esc \\ cont')
  assert.equal(y('a: "# not a comment\n  still data"').a, '# not a comment still data')
  assert.throws(() => y('a: "never closed\nb: 1'), /unterminated quoted string/)
})

// ─── anchors, aliases, merges ───────────────────────────────────────────────

test('anchors and aliases', () => {
  const doc = y(`base: &b
  type: object
  format: uuid
other: *b
list: [*b]
`)
  assert.deepEqual(doc.other, { type: 'object', format: 'uuid' })
  assert.deepEqual(doc.list[0], { type: 'object', format: 'uuid' })
})

test('a merge key merges, and local keys win', () => {
  const doc = y(`defaults: &d
  timeout: 30
  retries: 3
op:
  <<: *d
  retries: 5
`)
  assert.deepEqual(doc.op, { timeout: 30, retries: 5 })
})

test('an unknown alias is an error, not a silent null', () => {
  assert.throws(() => y('a: *nope'), (e) => e instanceof YamlError && /unknown alias \*nope/.test(e.message))
})

// ─── documents ──────────────────────────────────────────────────────────────

test('a leading --- is fine and the first document is the one we read', () => {
  assert.deepEqual(y('---\na: 1\n'), { a: 1 })
  assert.deepEqual(y('a: 1\n---\na: 2\n'), { a: 1 })
  assert.deepEqual(y('%YAML 1.2\n---\na: 1\n'), { a: 1 })
})

test('empty input is null, not a crash', () => {
  assert.equal(y(''), null)
  assert.equal(y('\n\n# just a comment\n'), null)
})

// ─── what we refuse ─────────────────────────────────────────────────────────

test('a tab in the indentation is named, not parsed around', () => {
  // The single most common way a YAML file is broken, and the error a user can
  // actually act on.
  assert.throws(() => y('a:\n\tb: 1'), (e) => e instanceof YamlError && /tab indentation/.test(e.message) && e.line === 1)
})

test('constructs outside the subset throw with a line number', () => {
  assert.throws(() => y('? complex\n: value'), (e) => /explicit `\? key`/.test(e.message))
  assert.throws(() => y('%TAG !e! tag:x\n---\na: 1'), (e) => /unsupported directive/.test(e.message))
  assert.throws(() => y('a: [1, 2'), (e) => /unterminated flow/.test(e.message))
  assert.throws(() => y('a: "bad \\q escape"'), (e) => /unknown escape/.test(e.message))
})

test('a line number points at the line, 1-based, in the message', () => {
  try { y('a: 1\nb: 2\n\tc: 3'); assert.fail('should throw') }
  catch (e) { assert.match(e.message, /^YAML line 3:/) }
})

// ─── the front door ─────────────────────────────────────────────────────────

test('parseJsonOrYaml takes either, and JSON wins the race', () => {
  assert.deepEqual(parseJsonOrYaml('{"a":1}'), { a: 1 })
  assert.deepEqual(parseJsonOrYaml('a: 1'), { a: 1 })
  // JSON *is* YAML, so this only proves both paths agree.
  assert.deepEqual(parseJsonOrYaml('[1, {"b": null}]'), [1, { b: null }])
})

test('unparseable content names its source, so the model knows what to fix', () => {
  assert.throws(
    () => parseJsonOrYaml('a:\n\tb: 1', 'https://example.com/openapi.yaml'),
    /could not parse https:\/\/example\.com\/openapi\.yaml as JSON or YAML — YAML line 2: tab/,
  )
})

// ─── a whole small spec, end to end ─────────────────────────────────────────

test('a realistic spec parses into the shape the OpenAPI code expects', () => {
  const doc = y(`openapi: 3.0.3
info:
  title: Tiny API
  version: 1.0.0
  description: >
    A small API used
    to prove the reader works.
servers:
  - url: https://api.tiny.example/v2
    description: production
security:
  - ApiKeyAuth: []
paths:
  /things:
    get:
      operationId: listThings
      summary: List things
      tags: [things]
      parameters:
        - name: limit
          in: query
          schema: {type: integer, default: 20}
        - name: X-Trace
          in: header
          schema:
            type: string
      responses:
        "200":
          description: |
            A page of things.
    post:
      operationId: createThing
      tags: [things]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Thing"
components:
  securitySchemes:
    ApiKeyAuth:
      type: apiKey
      in: header
      name: X-API-Key
  schemas:
    Thing:
      type: object
      required: [name]
      properties:
        name: {type: string}
        tags:
          type: array
          items: {type: string}
`)
  assert.equal(doc.info.description, 'A small API used to prove the reader works.\n')
  assert.equal(doc.servers[0].url, 'https://api.tiny.example/v2')
  assert.deepEqual(doc.security, [{ ApiKeyAuth: [] }])
  const get = doc.paths['/things'].get
  assert.deepEqual(get.tags, ['things'])
  assert.equal(get.parameters.length, 2)
  assert.deepEqual(get.parameters[0].schema, { type: 'integer', default: 20 })
  assert.equal(get.parameters[1].in, 'header')
  assert.equal(get.responses['200'].description, 'A page of things.\n')
  assert.equal(doc.paths['/things'].post.requestBody.content['application/json'].schema.$ref, '#/components/schemas/Thing')
  assert.equal(doc.components.securitySchemes.ApiKeyAuth.name, 'X-API-Key')
  assert.deepEqual(doc.components.schemas.Thing.required, ['name'])
  assert.deepEqual(doc.components.schemas.Thing.properties.tags.items, { type: 'string' })
})
