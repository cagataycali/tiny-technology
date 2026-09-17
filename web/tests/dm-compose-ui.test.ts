// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DM_FILE_ACCEPT } from '../lib/chat/dm-media-upload'

/**
 * The DM composer's attachment wiring, pinned at the source.
 *
 * These are source assertions rather than a DOM test because what matters here
 * is a set of ORDERING and CLEANUP properties — a send that leaves while an
 * upload is in flight, a blob URL nobody revokes, a mic left open — and each of
 * those is a specific expression in a specific place. The behaviour they protect
 * is not "does it render", it's "can this deliver half of what the user staged".
 */
const src = readFileSync(join(__dirname, '..', 'components/chat/MessagesHUD.tsx'), 'utf8')

/** Comments in this file name the very defects being pinned, so assertions read
 *  the code with comments stripped or they pass on the prose. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n')

describe('🔴 the send never delivers PART of what is staged', () => {
  it('bails while an attachment is still uploading, before the POST', () => {
    const gate = code.indexOf('s.status === "uploading"')
    const post = code.indexOf('fetch("/api/messages", {\n      method: "POST"')
    expect(gate).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(gate)
    // A computed verdict that doesn't leave the function decides nothing (the
    // lesson from the route's own ordering pin).
    expect(code.slice(gate, post)).toMatch(/return;/)
  })

  it('bails when an attachment FAILED to upload rather than dropping it', () => {
    const gate = code.indexOf('s.status === "failed"')
    const post = code.indexOf('fetch("/api/messages", {\n      method: "POST"')
    expect(gate).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(gate)
    expect(code.slice(gate, post)).toMatch(/return;/)
  })

  it('sends the URLs of the READY attachments, not the staged objects', () => {
    // The staged object holds megabytes of prepared bytes and a blob: URL —
    // JSON.stringifying it would blow the request cap and store nonsense.
    expect(code).toMatch(/const attachments = mine\.map\(\(s\) => s\.attachment\)\.filter\(Boolean\)/)
    expect(code).toContain('message: text, attachments, viaTiny')
  })

  it('🔴 a caption-less photo is sendable (both the bail and the button)', () => {
    // The server allows an empty body when media is present (decideDmPayload).
    // If the client still requires text, the commonest phone message — a photo
    // with no caption — is unsendable here.
    expect(code).toContain('if (!text && !attachments.length) return;')
    expect(code).not.toMatch(/if \(!text \|\| !peer/)
    expect(code).toMatch(/disabled=\{sending \|\| \(!draft\.trim\(\) && stagedNow\.length === 0\)\}/)
  })
})

describe('🔴 staged media is keyed by peer, like the drafts it sits beside', () => {
  it('holds a map, not one shared list', () => {
    // Same defect class as the shared draft string this file documents: every
    // peer transition leaves the composer mounted, so one list would carry a
    // photo meant for A into a send to B.
    expect(code).toContain('useState<Record<string, Staged[]>>({})')
    expect(code).not.toMatch(/useState<Staged\[\]>\(\[\]\)/)
  })

  it('captures the key BEFORE the async prepare/upload', () => {
    // prepareDmFile awaits canvas work and prepareDmRecording awaits a decode;
    // reading the open peer afterwards files the result under whoever is on
    // screen when it finishes.
    for (const fn of ['const onPickFiles', 'const startRecording']) {
      const at = code.indexOf(fn)
      expect(at, fn).toBeGreaterThan(-1)
      const body = code.slice(at, at + 900)
      expect(body, fn).toMatch(/const key = stageKey;/)
    }
    expect(code).toMatch(/stageMedia\(key, \(\) => prepareDmFile\(file\)\)/)
    expect(code).toMatch(/stageMedia\(key, \(\) => prepareDmRecording\(blob, transcript\)\)/)
  })

  it('the send clears the chips of the peer it SENT to', () => {
    const at = code.indexOf('clearDmDraft(prev, sentTo)')
    expect(at).toBeGreaterThan(-1)
    const after = code.slice(at, at + 600)
    expect(after).toMatch(/prev\[sentTo\]/)
    expect(after).toMatch(/delete next\[sentTo\]/)
    // Not by whoever is open when the POST resolves — that's the misdirection
    // bug in its other direction.
    expect(after).not.toMatch(/delete next\[(stageKey|draftKeyNow)\]/)
  })
})

describe('cleanup — a blob URL and a microphone both outlive the thing that made them', () => {
  it('revokes the preview URL when a chip is removed AND after a send', () => {
    const revokes = (code.match(/URL\.revokeObjectURL/g) || []).length
    // remove-one + clear-after-send. Without both, every attached photo leaks
    // its bytes for the life of the page.
    expect(revokes).toBeGreaterThanOrEqual(2)
    expect(code).toMatch(/removeStaged[\s\S]{0,400}revokeObjectURL/)
  })

  it('🔴 stops the recording on unmount and on panel close', () => {
    // A MediaRecorder holds the mic and lights the tab's recording indicator.
    // Closing the sheet mid-recording must not leave either running.
    expect(code).toMatch(/useEffect\(\(\) => \(\) => \{ stopRecording\(true\); \}, \[\]\)/)
    expect(code).toMatch(/if \(!open\) stopRecording\(true\)/)
  })

  it('releases the mic stream inside onstop, before anything else can fail', () => {
    const at = code.indexOf('rec.onstop')
    expect(at).toBeGreaterThan(-1)
    const body = code.slice(at, code.indexOf('recTranscript.current = startDmTranscript'))
    expect(body).toMatch(/stream\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/)
    // The track stop must precede the prepare/stage work, which can throw — and
    // both must actually be in this handler for the ordering to mean anything.
    expect(body).toContain('stageMedia')
    expect(body.indexOf('getTracks')).toBeLessThan(body.indexOf('stageMedia'))
  })

  it('discards a cancelled recording instead of attaching it', () => {
    expect(code).toMatch(/if \(recDiscard\.current\) return;/)
  })
})

describe('the composer offers exactly what the pipeline can accept', () => {
  it('🔴 takes its accept list from the module, not an inlined literal', () => {
    // An `image/⁠*` literal in this .tsx is read as the start of a block comment
    // by the comment-stripping pins above (measured: it swallowed the
    // `maxLength={2000}` assertion in dm-send.test.ts, which is the DM cap's
    // only client-side guard).
    expect(code).toContain('accept={DM_FILE_ACCEPT}')
    expect(src).not.toMatch(/accept="image/)
    // ...and the list itself must not offer a container the plan refuses.
    expect(DM_FILE_ACCEPT).not.toMatch(/quicktime|video\/webm/)
    expect(DM_FILE_ACCEPT).toContain('video/mp4')
  })

  it('refuses to open the picker past the attachment cap', () => {
    expect(code).toMatch(/disabled=\{stagedNow\.length >= DM_MAX_ATTACHMENTS\}/)
    // The batch itself is refused whole by dmAttachmentRoom, not trimmed.
    expect(code).toMatch(/dmAttachmentRoom\(stagedNow\.length, list\.length, DM_MAX_ATTACHMENTS\)/)
  })

  it('shows the refusal text verbatim rather than a generic message', () => {
    // Every refusal from dm-media-upload names the cause and the fix; replacing
    // them with "couldn't attach that" throws away the actionable half.
    expect(code).toMatch(/toast\.error\(e\?\.message \|\| "Couldn't attach that file"\)/)
  })

  it('renders media in the bubbles and stages a preview in the composer', () => {
    expect(code).toMatch(/<DmMedia items=\{m\.attachments\}/)
    expect(code).toMatch(/m\.attachments && m\.attachments\.length > 0/)
    // The optimistic bubble carries them too, or a just-sent photo blinks out
    // until the next poll.
    expect(code).toMatch(/body: text,\s*attachments,/)
  })

  it('a voice note is capped by STOPPING, not by refusing afterwards', () => {
    expect(code).toMatch(/if \(ms >= DM_VOICE_MAX_MS\) stopRecording\(false\)/)
  })
})
