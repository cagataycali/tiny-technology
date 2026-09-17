// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { workerFile, WORKER_SRC, workerPresent as present, warnIfWorkerAbsent } from './_worker'

warnIfWorkerAbsent('media-retention-manifest')

/**
 * 🗑️ A COMMENT THAT PROMISED AN ARCHIVE NOBODY BUILT.
 *
 * `transcripts.ts` opened with: "a transcript is a note about a moment, not an
 * archive; **the audio in R2 is the archive**." That sentence is what made the
 * ring cap look considered — the words are disposable *because* the recording is
 * durable. The code never had a basis for it, in two independent ways:
 *
 *   1. `audio_url` is stored in exactly ONE place — the row `TRANSCRIPT_PRUNE_SQL`
 *      deletes. Nothing else durably holds the URL, so the prune drops the only
 *      reference that ever existed.
 *   2. the worker has `MEDIA.put/head/get` and NO `MEDIA.delete` and NO
 *      `MEDIA.list`. So the orphan is not merely un-garbage-collected: it can
 *      never be found again even deliberately, and it is billed forever.
 *
 * The losses are asymmetric in the worst direction: the text (small, useful) is
 * deleted; the audio (large, expensive) is kept forever and reachable by nobody.
 * "The archive" was the exact opposite of what happens.
 *
 * This suite pins the shape rather than the sentence, because a comment can be
 * reworded back:
 *
 *   - the FALSE CLAIM cannot return (in any file — it was a plausible thing to
 *     believe, so it is pinned worker-wide, not just where it was written)
 *   - the premise it depended on is measured, not assumed: no delete, no list
 *   - `MEDIA_KEY_FAMILIES` covers every key template the worker actually writes
 *     — enumerated FROM SOURCE, because an unlisted family is an ABSENCE and no
 *     grep for a symbol finds one (delete.ts's TINY_OWNED_STORES pattern)
 *   - every `reclaimed: false` entry says WHY in prose
 *   - the prune site itself says what it orphans
 *
 * ⚠️ If a `MEDIA.delete` ever lands, several assertions here should FAIL — that
 * is the point. They encode "there is no reclaim path", and the fix for them is
 * to wire the families up, not to relax the pin.
 */
let media: any
let transcriptsSrc = ''
let worker = ''
let workerFiles: string[] = []

beforeAll(async () => {
  if (!present) return
  media = await import(workerFile('media.ts') /* @vite-ignore */)
  transcriptsSrc = readFileSync(workerFile('transcripts.ts'), 'utf8')
  // The WHOLE worker: the claim was in transcripts.ts, but the belief it encodes
  // ("something else keeps the bytes") is available to every file that uploads.
  workerFiles = readdirSync(WORKER_SRC).filter((f) => f.endsWith('.ts'))
  worker = workerFiles.map((f) => readFileSync(workerFile(f), 'utf8')).join('\n')
})

describe.skipIf(!present)('the premise: R2 here is write-only and un-enumerable', () => {
  it('the scrape read real source (an empty read would pass every check below)', () => {
    expect(workerFiles.length, 'the worker src/ scrape found no .ts files').toBeGreaterThan(3)
    expect(worker, 'the worker no longer writes to R2 at all — re-read this suite')
      .toMatch(/MEDIA\??\.put\(/)
  })

  it('no MEDIA.delete anywhere — an orphan is permanent, not merely uncollected', () => {
    expect(
      worker.match(/MEDIA\??\.delete\(/g),
      'the worker gained MEDIA.delete — MEDIA_KEY_FAMILIES describes a bucket with NO reclaim ' +
        'path. Wire the families that can now be reclaimed (with an owner check) and update ' +
        'their `reclaimed`/`how`, rather than leaving a manifest that reads as researched.',
    ).toBeNull()
  })

  it('no MEDIA.list either — so a dropped reference cannot be recovered by probing', () => {
    // This is the half that turns "uncollected" into "unreachable", and it is why
    // the manifest tracks referrers instead of planning a prefix sweep.
    expect(
      worker.match(/MEDIA\??\.list\(/g),
      'the worker gained MEDIA.list — orphans are now enumerable, so a reference-counted ' +
        'sweep is possible and MEDIA_KEY_FAMILIES should say so.',
    ).toBeNull()
  })
})

describe.skipIf(!present)('the false archive claim cannot come back', () => {
  it('nothing in the worker claims R2 is the archive for pruned text', () => {
    // The exact sentence that was there, and the near-misses a reword would reach
    // for. Matching on the CLAIM's shape (R2/audio + archive) rather than one
    // phrasing: the failure mode is a confident restatement, not a copy-paste.
    const claims = [
      /the audio in R2 is\s+(?:\*\*)?the archive/i,
      /R2 is the archive/i,
      /audio (?:in R2 )?is the (?:durable |permanent )?archive/i,
    ]
    for (const re of claims) {
      const hit = worker.match(re)
      expect(
        hit,
        `a file claims R2 is the archive (${re}) — it is not: the pruned row is the only ` +
          `holder of audio_url, and there is no MEDIA.delete/list. Say what actually ` +
          `happens to the bytes instead.`,
      ).toBeNull()
    }
  })

  it('transcripts.ts states the real consequence where the claim used to be', () => {
    // Not just "the lie is gone" — the reader who arrives at the ring cap needs
    // the fact the old sentence displaced.
    //
    // ⚠️ Anchored to the EXPLANATION block, not to the whole header. The header
    // also carries the route signature `{ deviceId, token, text, label?,
    // audioUrl?, durationS? }`, which has always been there — a whole-header
    // scan for /audio_url/ is satisfied by that SIBLING and passes even with the
    // entire explanation deleted (measured: mutant W3 survived on exactly this,
    // the same way c41's N7 did on a slice that ran into teardown()).
    const from = transcriptsSrc.indexOf('never had a basis for it:')
    expect(from, 'the header no longer says the old claim had no basis').toBeGreaterThan(-1)
    const to = transcriptsSrc.indexOf('import ')
    expect(to, 'could not find the end of the header').toBeGreaterThan(from)
    const why = transcriptsSrc.slice(from, to)
    expect(why, 'the explanation no longer names the audio_url column that holds the reference')
      .toMatch(/audio_url/)
    expect(why, 'the explanation no longer names the missing reclaim path')
      .toMatch(/MEDIA\.delete/)
    expect(why, 'the explanation no longer says the bucket cannot be enumerated either')
      .toMatch(/MEDIA\.list/)
  })

  it('the prune site says what it orphans', () => {
    // The header is where someone learns the design; the prune is where someone
    // EDITS it. c34's lesson: the warning has to sit at the line that does the
    // damage, or a reader working bottom-up never sees it.
    const at = transcriptsSrc.indexOf('await env.DB.prepare(TRANSCRIPT_PRUNE_SQL)')
    expect(at, 'the prune call moved — re-anchor this pin').toBeGreaterThan(-1)
    // The comment block immediately above the call.
    const before = transcriptsSrc.slice(Math.max(0, at - 700), at)
    expect(before, 'the prune no longer warns that it permanently orphans the R2 audio')
      .toMatch(/orphan/i)
  })
})

describe.skipIf(!present)('MEDIA_KEY_FAMILIES stays honest', () => {
  it('every R2 key template written by the worker is a declared family', () => {
    // ABSENCE again: the bug is a key family nobody wrote down. Enumerate the
    // real `MEDIA.put(<key>` argument from source and normalize the template
    // (`${...}` → `<…>`), so a new prefix fails here until someone decides — in
    // the manifest, in writing — what would ever reclaim it.
    const prefixes: string[] = []
    const re = /MEDIA\??\.put\(\s*(`[^`]+`|[A-Za-z_$][\w$]*)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(worker)) !== null) {
      const raw = m[1]
      // A bare identifier (media.ts's `key`) is the flat uuid family; a template
      // literal carries its own prefix.
      const p = raw.startsWith('`')
        ? raw.slice(1, -1).replace(/\$\{[^}]*\}/g, '<>').split('/')[0]
        : '<>'
      if (prefixes.indexOf(p) === -1) prefixes.push(p)
    }
    // Proof the regex matched anything at all — a scraper that finds nothing
    // "covers" every family forever.
    expect(prefixes.length, 'no MEDIA.put key expressions were parsed out of the worker')
      .toBeGreaterThan(1)

    const declared: string[] = media.MEDIA_KEY_FAMILIES.map((f: any) => f.key)
    const declaredPrefixes = declared.map((k: string) =>
      k.indexOf('/') === -1 ? '<>' : k.split('/')[0].replace(/<[^>]*>/g, '<>'))
    const missing = prefixes.filter((p) => declaredPrefixes.indexOf(p) === -1)
    expect(
      missing,
      `R2 key prefix(es) written by the worker but absent from MEDIA_KEY_FAMILIES: ` +
        `${missing.join(', ')}. There is no delete and no list, so an undeclared family is ` +
        `bytes nobody can find and nobody can bill back.`,
    ).toEqual([])
  })

  it('the voice families are all declared — they are the highest-volume writers', () => {
    // Named explicitly, not left to the prefix check: `voice/` collapses to ONE
    // prefix, so a single declared voice entry would satisfy the test above while
    // three distinct key shapes went undocumented.
    const keys: string[] = media.MEDIA_KEY_FAMILIES.map((f: any) => f.key)
    for (const suffix of ['recording.wav', 'events.jsonl', '.pcm']) {
      expect(
        keys.some((k) => k.indexOf('voice/') === 0 && k.indexOf(suffix) > -1),
        `no MEDIA_KEY_FAMILIES entry covers voice/<id>/…${suffix}`,
      ).toBe(true)
    }
    // And they must really be written, or the manifest documents fiction.
    const voiceSrc = readFileSync(workerFile('voice.ts'), 'utf8')
    expect(voiceSrc).toMatch(/MEDIA\??\.put\(`voice\/\$\{id\}\/recording\.wav`/)
    expect(voiceSrc).toMatch(/MEDIA\??\.put\(`voice\/\$\{id\}\/events\.jsonl`/)
    expect(voiceSrc).toMatch(/MEDIA\??\.put\(key, merged/) // the pcm segments
  })

  it('every family names a referrer and a reason, in prose', () => {
    // delete.ts's `how.length > 20` rule: a blank reads as researched. The
    // referrer matters more than the reason here — "who still points at this"
    // is the only way to know an object is reachable at all.
    expect(media.MEDIA_KEY_FAMILIES.length).toBeGreaterThan(3)
    for (const f of media.MEDIA_KEY_FAMILIES) {
      expect(f.writtenBy.length, `${f.key}: needs the writer named`).toBeGreaterThan(10)
      expect(f.referencedBy.length, `${f.key}: needs its referrer named`).toBeGreaterThan(20)
      expect(f.how.length, `${f.key}: needs a reason, not a blank`).toBeGreaterThan(20)
    }
  })

  it('no family claims to be reclaimed while no delete exists', () => {
    // The mirror check — a `reclaimed: true` entry would be the same species of
    // lie as the archive claim: coverage asserted, code absent.
    const claimed = media.MEDIA_KEY_FAMILIES.filter((f: any) => f.reclaimed)
    expect(
      claimed.map((f: any) => f.key),
      'a family claims to be reclaimed, but the worker has no MEDIA.delete',
    ).toEqual([])
  })

  it('the flat-uuid family names the ring/sweep referrers that drop it silently', () => {
    // The specific thing that made the transcripts prune invisible: the referrer
    // is itself a RING. Orphaning happens in normal operation, not just on an
    // explicit user delete — which is what everyone assumes when they read
    // "orphaned media".
    const flat = media.MEDIA_KEY_FAMILIES.find((f: any) => f.key.indexOf('/') === -1)
    expect(flat, 'no flat-uuid family declared — media.ts MediaUploadCall writes one').toBeTruthy()
    expect(flat.how, 'the flat family does not mention the ring/sweep that drops its referrers')
      .toMatch(/ring|sweep|prune/i)
    expect(flat.referencedBy, 'the flat family does not name the transcripts referrer')
      .toMatch(/transcript/i)
  })
})

describe.skipIf(!present)('the reference really is single-held (why the prune loses the bytes)', () => {
  it('audio_url is PERSISTED by no table but transcripts', () => {
    // If some other table also held the URL, the prune would be survivable and
    // this whole cycle would be wrong. Measured, not assumed.
    //
    // ⚠️ Scanned for SQL that persists the column, not for the string: media.ts's
    // own MEDIA_KEY_FAMILIES *names* `transcripts.audio_url` as the referrer, and
    // a mention-based scan flagged that prose as a second holder (measured — this
    // pin failed on its own manifest). Prose describing a reference is not one.
    const persists = workerFiles.filter((f) => {
      const src = readFileSync(workerFile(f), 'utf8')
      return /(INSERT INTO|UPDATE|SET)[^;`]*\baudio_url\b/i.test(src)
    })
    expect(
      persists.sort(),
      'a worker file other than transcripts.ts now WRITES audio_url — the prune may no longer ' +
        'be the last reference, so re-check the manifest and this suite\'s premise',
    ).toEqual(['transcripts.ts'])
    // And the write really is there, or the filter above proves nothing.
    expect(transcriptsSrc, 'transcripts.ts no longer persists audio_url')
      .toMatch(/INSERT INTO transcripts[\s\S]{0,200}audio_url/)
  })

  it('the migration keeps audio_url on the pruned table, not a side table', () => {
    const dir = workerFile('../migrations')
    const sql = readdirSync(dir).filter((f: string) => f.endsWith('.sql'))
      .map((f: string) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n')
    expect(sql.length, 'the migrations scrape read nothing').toBeGreaterThan(500)
    // The column lives on `transcripts` — the same table TRANSCRIPT_PRUNE_SQL
    // deletes from. A future migration moving it elsewhere is exactly the change
    // that would make the orphan avoidable.
    const table = /CREATE TABLE (?:IF NOT EXISTS )?transcripts\s*\(([^;]*?)\)\s*;/s.exec(sql)
    expect(table, 'the transcripts table is gone from the migrations').toBeTruthy()
    // ⚠️ A COLUMN DEFINITION, not a mention: strip `-- …` comments first. The
    // migration's own prose names audio_url, so `/audio_url/` on the raw body
    // passes even when the column is commented out and moved to a side table
    // (measured — mutant S2 survived by replacing the definition with a comment
    // that still contained the word).
    const cols = table![1].replace(/--[^\n]*/g, '')
    expect(cols, 'audio_url is no longer a COLUMN on the pruned transcripts table — ' +
      'if the URL moved to a table the ring does not prune, the orphan is avoidable and ' +
      'this suite\'s premise needs re-deriving')
      .toMatch(/^\s*audio_url\s+TEXT/m)
  })
})
