#!/usr/bin/env node
/**
 * A language server that is not one — just enough LSP to test src/agent/lsp.ts
 * against the real wire protocol.
 *
 * The alternative is testing against typescript-language-server, and then the
 * suite only runs on a machine that has it (this one doesn't: `node_modules/.bin`
 * has tsserver, which speaks a different protocol). A fake that speaks real
 * Content-Length JSON-RPC tests the part that actually breaks — framing,
 * server→client requests, notification timing — and does it in 40 ms.
 *
 * Deliberately hostile, in the ways real servers are:
 *   · It SPLITS frames mid-header and mid-body, and coalesces two messages into
 *     one write, because that is what a real server's stdout does under load and
 *     it is the bug a naive parser has.
 *   · It asks `workspace/configuration` BEFORE it will publish diagnostics, the
 *     way pyright does, and stays silent forever if the answer is malformed.
 *   · Diagnostics arrive LATE (after a tick), never synchronously with didOpen.
 *
 * Knobs via env: FAKE_LSP_DIAG_DELAY_MS, FAKE_LSP_NO_CONFIG_WAIT=1,
 * FAKE_LSP_CRASH_ON=<method>, FAKE_LSP_SLOW_MS (delay every response).
 */
const DIAG_DELAY = Number(process.env.FAKE_LSP_DIAG_DELAY_MS || 15)
const SLOW = Number(process.env.FAKE_LSP_SLOW_MS || 0)
const CRASH_ON = process.env.FAKE_LSP_CRASH_ON || ''
const WAIT_FOR_CONFIG = process.env.FAKE_LSP_NO_CONFIG_WAIT !== '1'

let buf = Buffer.alloc(0)
let nextId = 10000
let configAnswered = !WAIT_FOR_CONFIG
const pendingDiags = []
const openDocs = new Map()

/** Write a frame, split at a rude place so the client's parser has to cope. */
function send(msg) {
  const body = JSON.stringify(msg)
  const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`, 'utf8')
  // Split roughly in the middle — sometimes inside the header, sometimes inside
  // the body, depending on the message. Both are legal and both have broken a
  // parser that assumed one write is one message.
  const cut = Math.max(1, Math.floor(frame.length / 2))
  process.stdout.write(frame.subarray(0, cut))
  process.stdout.write(frame.subarray(cut))
}

function reply(id, result) {
  if (SLOW) setTimeout(() => send({ jsonrpc: '2.0', id, result }), SLOW)
  else send({ jsonrpc: '2.0', id, result })
}

function publish(uri) {
  const text = openDocs.get(uri) || ''
  // "Diagnostics": one error per line containing BAD, so a test can control the
  // count from the file's contents.
  const diagnostics = text.split('\n').flatMap((line, i) => {
    if (!line.includes('BAD')) return []
    return [{
      range: { start: { line: i, character: line.indexOf('BAD') }, end: { line: i, character: line.indexOf('BAD') + 3 } },
      severity: 1,
      source: 'fake',
      code: 'E001',
      message: `something is BAD on line ${i + 1}`,
    }]
  })
  if (text.includes('WARN')) {
    diagnostics.push({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, source: 'fake', message: 'a warning' })
  }
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } })
}

function flushDiags() {
  while (pendingDiags.length) publish(pendingDiags.shift())
}

function handle(msg) {
  const { id, method, params } = msg

  // A response to something WE asked (the configuration request).
  if (id !== undefined && method === undefined) {
    // The point of the exercise: pyright expects an ARRAY, one entry per item.
    // devduck answers `null`, and a server that gets that never gets to work.
    if (Array.isArray(msg.result)) { configAnswered = true; setTimeout(flushDiags, DIAG_DELAY) }
    return
  }

  if (CRASH_ON && method === CRASH_ON) { process.exit(3) }

  switch (method) {
    case 'initialize':
      reply(id, {
        capabilities: {
          textDocumentSync: 1, hoverProvider: true, definitionProvider: true,
          referencesProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true,
        },
        serverInfo: { name: 'fake-lsp', version: '1.0.0' },
      })
      return
    case 'initialized':
      if (WAIT_FOR_CONFIG) {
        send({ jsonrpc: '2.0', id: ++nextId, method: 'workspace/configuration', params: { items: [{ section: 'fake' }, { section: 'other' }] } })
      }
      return
    case 'shutdown': reply(id, null); return
    case 'exit': process.exit(0); return

    case 'textDocument/didOpen':
      openDocs.set(params.textDocument.uri, params.textDocument.text || '')
      pendingDiags.push(params.textDocument.uri)
      if (configAnswered) setTimeout(flushDiags, DIAG_DELAY)
      return
    case 'textDocument/didChange':
      openDocs.set(params.textDocument.uri, params.contentChanges?.[0]?.text ?? '')
      pendingDiags.push(params.textDocument.uri)
      if (configAnswered) setTimeout(flushDiags, DIAG_DELAY)
      return
    case 'textDocument/didClose':
      openDocs.delete(params.textDocument.uri)
      return

    // Positional answers ECHO the position back, which is how the tests prove
    // that a symbol NAME resolved to the right line and column.
    case 'textDocument/definition':
      reply(id, { uri: params.textDocument.uri, range: { start: params.position, end: params.position } })
      return
    case 'textDocument/references':
      reply(id, [
        { uri: params.textDocument.uri, range: { start: params.position, end: params.position } },
        { uri: 'file:///other/place.ts', range: { start: { line: 41, character: 2 }, end: { line: 41, character: 8 } } },
      ])
      return
    case 'textDocument/hover':
      reply(id, { contents: { kind: 'markdown', value: `type at ${params.position.line}:${params.position.character}` } })
      return
    case 'textDocument/documentSymbol':
      reply(id, [{
        name: 'Thing', kind: 5, detail: 'class Thing',
        range: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        children: [{
          name: 'method', kind: 6,
          range: { start: { line: 2, character: 2 }, end: { line: 4, character: 3 } },
          selectionRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 8 } },
        }],
      }])
      return
    case 'workspace/symbol':
      reply(id, [{
        name: String(params.query), kind: 12,
        location: { uri: 'file:///project/src/found.ts', range: { start: { line: 6, character: 0 }, end: { line: 6, character: 10 } } },
      }])
      return
    default:
      if (id !== undefined) reply(id, null)
  }
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  while (true) {
    const sep = buf.indexOf('\r\n\r\n')
    if (sep < 0) break
    const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, sep).toString('ascii'))
    if (!m) { buf = buf.subarray(sep + 4); continue }
    const len = Number(m[1])
    if (buf.length < sep + 4 + len) break
    const body = buf.subarray(sep + 4, sep + 4 + len).toString('utf8')
    buf = buf.subarray(sep + 4 + len)
    try { handle(JSON.parse(body)) } catch { /* ignore */ }
  }
})
process.stdin.on('end', () => process.exit(0))
