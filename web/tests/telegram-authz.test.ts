// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('telegram-authz')

let chatIsAllowed: (allowed: string, chatId: string) => boolean
let senderName: (msg: any) => string
beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('telegram.ts') /* @vite-ignore */)
  chatIsAllowed = mod.chatIsAllowed
  senderName = mod.senderName
})

// This is the bot's authorization gate — who it will act for. A false
// positive here = the bot runs an agent turn (spending the owner's key,
// exposing their tiny) for a stranger.
describe.skipIf(!present)('chatIsAllowed', () => {
  it('exact chat-id match allows', () => {
    expect(chatIsAllowed('12345', '12345')).toBe(true)
    expect(chatIsAllowed('111,12345,999', '12345')).toBe(true)
  })

  it('rejects non-members', () => {
    expect(chatIsAllowed('111,222', '333')).toBe(false)
  })

  it('empty allowlist rejects everyone (fail closed)', () => {
    expect(chatIsAllowed('', '12345')).toBe(false)
    expect(chatIsAllowed('  ', '12345')).toBe(false)
  })

  it('no substring/prefix bypass — "123" must not match "12345"', () => {
    expect(chatIsAllowed('12345', '123')).toBe(false)
    expect(chatIsAllowed('123', '12345')).toBe(false)
  })

  it('whitespace in the stored list is tolerated', () => {
    expect(chatIsAllowed(' 111 , 222 , 333 ', '222')).toBe(true)
  })
})

describe.skipIf(!present)('senderName', () => {
  it('prefers @username, falls back to names, then unknown', () => {
    expect(senderName({ from: { username: 'alice' } })).toBe('@alice')
    expect(senderName({ from: { first_name: 'Bob', last_name: 'Lee' } })).toBe('Bob Lee')
    expect(senderName({ from: { first_name: 'Sol' } })).toBe('Sol')
    expect(senderName({})).toBe('unknown')
    expect(senderName({ from: {} })).toBe('unknown')
  })
})
