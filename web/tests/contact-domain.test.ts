// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('contact-domain')

/**
 * 📮 WE WERE PUBLISHING AN EMAIL ADDRESS AT A DOMAIN SOMEBODY ELSE NOW OWNS.
 *
 * `tinyai.id` was the original product domain. Its registration lapsed and it
 * now resolves to an unrelated third-party site (checked 2026-08-02: A records
 * on Cloudflare, no MX, apex 301s off-site). Two shipped worker strings still
 * named it, and both are the kind that only a stranger reads:
 *
 *   1. `index.ts` `contact_email` — served publicly in
 *      /.well-known/ai-plugin.json as "mail here when tiny misbehaves".
 *   2. `push.ts` VAPID `sub` — the contact a push service uses to reach the
 *      sender about a bad subscription. `VAPID_SUBJECT` is NOT among the
 *      deployed secrets (`wrangler secret list --env production` returns
 *      DEPOSIT_ADDRESS / INTERNAL_API_KEY / OPENAI_API_KEY / VAPID_PUBLIC_KEY /
 *      VAPID_PRIVATE_KEY only), so the `||` fallback IS what production signs
 *      into every push JWT — not a dev default.
 *
 * Neither one can fail a build, break a test, or show up in the UI: the only
 * symptom is mail to a domain we don't control, from surfaces we tell other
 * people to trust. So the domain gets pinned here instead.
 *
 * The rule is deliberately about the DEAD domain, not about one blessed
 * address — a future help@ / support@ / legal@ on tiny.technology is fine, and
 * a hostname we no longer own never is.
 */

/** Domains that were ours and no longer are — must not appear in shipped source. */
const LAPSED_DOMAINS = ['tinyai.id']

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return e.isFile() && e.name.endsWith('.ts') ? [p] : []
  })
}

describe.skipIf(!present)('contact domains in worker source', () => {
  it('names no lapsed domain anywhere in the worker', () => {
    const offenders: string[] = []
    for (const file of walk(WORKER_SRC)) {
      const src = readFileSync(file, 'utf8')
      src.split('\n').forEach((line, i) => {
        // The comments explaining WHY the domain is banned name it themselves;
        // a mention in prose is the documentation, a mention in a string is
        // the bug. Only flag lines that aren't comments.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
        for (const dead of LAPSED_DOMAINS) {
          if (code.includes(dead)) offenders.push(`${file.split('/src/')[1]}:${i + 1} → ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('signs VAPID JWTs with a domain we own, even unconfigured', () => {
    const src = readFileSync(join(WORKER_SRC, 'push.ts'), 'utf8')
    // The literal after `env.VAPID_SUBJECT ||` is what production actually
    // signs (the secret is unset), so assert on THAT, not on the file's prose.
    const fallback = src.match(/env\.VAPID_SUBJECT\s*\|\|\s*'([^']+)'/)
    expect(fallback, 'VAPID_SUBJECT fallback literal').toBeTruthy()
    expect(fallback![1]).toMatch(/^mailto:.+@tiny\.technology$/)
  })

  it('publishes a reachable contact_email in the plugin manifest', () => {
    const src = readFileSync(join(WORKER_SRC, 'index.ts'), 'utf8')
    const contact = src.match(/contact_email:\s*'([^']+)'/)
    expect(contact, 'contact_email literal').toBeTruthy()
    expect(contact![1]).toMatch(/@tiny\.technology$/)
  })
})
