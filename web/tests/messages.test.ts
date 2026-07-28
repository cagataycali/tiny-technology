// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

// Worker submodule — skip when absent (CI has no .gitmodules)
warnIfWorkerAbsent('messages')

let resolveRecipient: (env: any, opts: any) => Promise<any>
beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('messages.ts') /* @vite-ignore */)
  resolveRecipient = mod.resolveRecipient
})

/** Minimal D1 mock: routes prepared statements by SQL substring. */
function mockDb(handlers: Record<string, (binds: any[]) => any>) {
  return {
    prepare(sql: string) {
      const binds: any[] = []
      const stmt = {
        bind(...args: any[]) { binds.push(...args); return stmt },
        async first() {
          for (const [needle, fn] of Object.entries(handlers)) {
            if (sql.includes(needle)) return fn(binds)
          }
          return null
        },
        async all() { return { results: [] } },
        async run() { return { meta: { changes: 1 } } },
      }
      return stmt
    },
  }
}

// resolveRecipient is the DM trust boundary: it turns a client-supplied
// "to" string into a user row. A wrong resolution = message (and the
// sender's identity) delivered to the wrong person.
describe.skipIf(!present)('resolveRecipient', () => {
  const users: Record<string, any> = {
    'u-mert': { id: 'u-mert', github_login: 'mertsefa', name: 'Mert' },
    'u-cag': { id: 'u-cag', github_login: 'cagataycali', name: 'Cagatay' },
  }
  const env = {
    DB: mockDb({
      'FROM users WHERE id =': (b) => users[b[0]] || null,
      'LOWER(github_login)': (b) =>
        Object.values(users).find(u => u.github_login.toLowerCase() === String(b[0]).toLowerCase()) || null,
      'FROM tinys WHERE name =': (b) => (b[0] === 'mert' ? { user_id: 'u-mert' } : null),
    }),
  }

  it('resolves by exact userId', async () => {
    const u = await resolveRecipient(env, { toUserId: 'u-mert' })
    expect(u?.github_login).toBe('mertsefa')
  })

  it('resolves by login, case-insensitive, @ stripped', async () => {
    expect((await resolveRecipient(env, { toLogin: 'MertSefa' }))?.id).toBe('u-mert')
    expect((await resolveRecipient(env, { toLogin: '@mertsefa' }))?.id).toBe('u-mert')
  })

  it('falls through login-miss → tiny slug ownership', async () => {
    const u = await resolveRecipient(env, { toLogin: 'mert', toTiny: 'mert' })
    expect(u?.id).toBe('u-mert') // no user with login "mert", but tiny "mert" → owner
  })

  it('rejects malformed inputs instead of querying', async () => {
    expect(await resolveRecipient(env, { toLogin: 'x&userId=victim' })).toBeNull()
    expect(await resolveRecipient(env, { toTiny: 'UPPER CASE SLUG!' })).toBeNull()
    expect(await resolveRecipient(env, {})).toBeNull()
  })

  it('unknown everything → null (fail closed)', async () => {
    expect(await resolveRecipient(env, { toLogin: 'ghost', toTiny: 'ghost' })).toBeNull()
  })
})
