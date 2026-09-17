/**
 * 👀 use_image — put a picture INTO the conversation as pixels.
 *
 * use_computer shows the model its own screen; nothing showed it a FILE. Every
 * "look at these photos" request went through Preview + screenshot, or through
 * prose the daemon invented about a file only it could open. This tool reads
 * an image (path, URL, or a directory of them), makes it model-sized, and
 * returns a real Strands image block — the same shape computer.ts uses, so it
 * rides the media path to remote callers (agent.ts invokeWithMedia) unchanged.
 *
 * Three measured facts shape it (inherited from the see.ts that lived here
 * until the 0.10 prune):
 *   1. Format comes from the BYTES, never the extension — a JPEG named .png
 *      declared as png makes a provider refuse the request or decode garbage.
 *   2. Dimensions come from the header, so a Linux box with no sips can still
 *      show a small png. Only RESAMPLING needs a binary.
 *   3. `sips -Z n` UPSCALES. A 174×188 icon came back 1481×1600 and 16× the
 *      bytes. The edge handed to sips is never larger than the image's own.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import { apiUrl } from '../config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Formats a model can be shown (SDK ∩ media store). Others get converted. */
export const SHOWABLE: Record<string, string> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' }
/** Longest edge after resampling — past ~1600 every provider tiles anyway. */
export const MAX_EDGE = 1568
/** Decoded byte cap per attached image (it becomes base64 in the request). */
export const MAX_BYTES = 1_500_000
/** Images per call — the model pays vision tokens per image. */
export const MAX_IMAGES = 6
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i

export function expandTilde(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

/** Sniff the format from the first 16 bytes. Magic numbers read off real files. */
export function sniffFormat(head: Uint8Array): string | null {
  const eq = (i: number, ...b: number[]) => b.every((v, k) => head[i + k] === v)
  if (eq(0, 0x89, 0x50, 0x4e, 0x47)) return 'png'
  if (eq(0, 0xff, 0xd8, 0xff)) return 'jpeg'
  if (eq(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  if (eq(0, 0x52, 0x49, 0x46, 0x46) && eq(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  if (eq(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(head[8], head[9], head[10], head[11])
    return /^(heic|heix|hevc|heim|heis|hevm|mif1|msf1)$/.test(brand) ? 'heic' : null
  }
  if (eq(0, 0x4d, 0x4d, 0x00, 0x2a) || eq(0, 0x49, 0x49, 0x2a, 0x00)) return 'tiff'
  if (eq(0, 0x42, 0x4d)) return 'bmp'
  return null
}

/** Width/height from header bytes — no spawn. JPEG SOF sits behind the APPn
 *  blocks (EXIF can push it past 60KB), so pass a generous head. */
export function measureHeader(h: Uint8Array, fmt: string): { width: number; height: number } | null {
  const be = (i: number, n: number) => { let v = 0; for (let k = 0; k < n; k++) { if (i + k >= h.length) return null; v = v * 256 + h[i + k] } return v }
  const le = (i: number, n: number) => { let v = 0; for (let k = n - 1; k >= 0; k--) { if (i + k >= h.length) return null; v = v * 256 + h[i + k] } return v }
  const ok = (w: number | null, h2: number | null) => (w && h2 && w > 0 && h2 > 0 ? { width: w, height: h2 } : null)
  if (fmt === 'png') return String.fromCharCode(h[12], h[13], h[14], h[15]) === 'IHDR' ? ok(be(16, 4), be(20, 4)) : null
  if (fmt === 'gif') return ok(le(6, 2), le(8, 2))
  if (fmt === 'webp') {
    const chunk = String.fromCharCode(h[12], h[13], h[14], h[15])
    if (chunk === 'VP8 ') { const w = le(26, 2), hh = le(28, 2); return ok(w == null ? null : w & 0x3fff, hh == null ? null : hh & 0x3fff) }
    if (chunk === 'VP8L') { const b = le(21, 4); return b == null ? null : ok((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1) }
    if (chunk === 'VP8X') { const w = le(24, 3), hh = le(27, 3); return ok(w == null ? null : w + 1, hh == null ? null : hh + 1) }
    return null
  }
  if (fmt === 'jpeg') {
    let i = 2
    while (i + 3 < h.length) {
      if (h[i] !== 0xff) { i++; continue }
      const m = h[i + 1]
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
      if (m === 0xda || m === 0xd9) return null
      const len = be(i + 2, 2)
      if (len == null || len < 2) return null
      // SOF0..15 minus DHT(c4)/JPG(c8)/DAC(cc). Height comes BEFORE width.
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(be(i + 7, 2), be(i + 5, 2))
      i += 2 + len
    }
    return null
  }
  return null
}

export type Plan =
  | { kind: 'attach'; format: string }
  | { kind: 'convert'; to: 'jpeg' | 'png'; edge: number | null }
  | { kind: 'shrink'; format: string; edge: number }

/**
 * The policy, pure. Permanent disqualifier (format) before the fixable one
 * (size): a shrunk heic is still a heic. Edge passed on is never larger than
 * the image's own — see fact 3.
 */
export function plan(fmt: string, dims: { width: number; height: number } | null, bytes: number, maxEdge = MAX_EDGE, maxBytes = MAX_BYTES): Plan {
  const edge = dims ? Math.max(dims.width, dims.height) : null
  // JPEG on purpose: heic/tiff/bmp are photo containers; png would be several
  // times the bytes for detail a tiled vision model never resolves.
  if (!SHOWABLE[fmt]) return { kind: 'convert', to: 'jpeg', edge: edge && edge > maxEdge ? maxEdge : null }
  if (edge && edge > maxEdge) return { kind: 'shrink', format: SHOWABLE[fmt], edge: maxEdge }
  if (bytes > maxBytes) return { kind: 'shrink', format: SHOWABLE[fmt], edge: edge ?? maxEdge }
  return { kind: 'attach', format: SHOWABLE[fmt] }
}

/** sips argv for a plan (macOS). ImageMagick fallback is in resample(). */
export function sipsArgs(p: Plan, src: string, out: string): string[] {
  const a: string[] = []
  if (p.kind === 'convert') { a.push('-s', 'format', p.to); if (p.to === 'jpeg') a.push('-s', 'formatOptions', '85') }
  const edge = p.kind === 'attach' ? null : p.edge
  if (edge) a.push('-Z', String(edge))
  return [...a, src, '--out', out]
}

const isMac = os.platform() === 'darwin'
function has(bin: string): boolean {
  try { execFileSync(isMac ? 'which' : 'sh', isMac ? [bin] : ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true } catch { return false }
}
export function canResample(): boolean { return (isMac && has('sips')) || has('magick') || has('convert') }

/** heic/tiff/bmp carry no header this file parses; ask sips when it exists, so
 *  a 12MP iPhone heic is converted AT the edge cap instead of full size. */
function sipsDims(file: string): { width: number; height: number } | null {
  if (!isMac || !has('sips')) return null
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf-8', timeout: 10_000 })
    const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]), h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1])
    return w > 0 && h > 0 ? { width: w, height: h } : null
  } catch { return null }
}

function resample(p: Plan, src: string, out: string): void {
  if (isMac && has('sips')) { execFileSync('sips', sipsArgs(p, src, out), { stdio: 'ignore', timeout: 30_000 }); return }
  const bin = has('magick') ? 'magick' : 'convert'
  const edge = p.kind === 'attach' ? null : p.edge
  execFileSync(bin, [src, ...(edge ? ['-resize', `${edge}x${edge}>`] : []), out], { stdio: 'ignore', timeout: 30_000 })
}

export interface Shown { format: string; base64: string; note: string }

/** Read + prepare one file. Throws with a fix-naming message. */
export function prepareFile(file: string, maxEdge = MAX_EDGE): Shown {
  const st = fs.statSync(file)
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(Math.min(st.size, 65_536))
  try { fs.readSync(fd, head, 0, head.length, 0) } finally { fs.closeSync(fd) }
  const fmt = sniffFormat(head)
  if (!fmt) throw new Error(`${file} is not an image I can show (bytes are not png/jpeg/gif/webp/heic/tiff/bmp). PDFs and documents: read them with the file editor.`)
  const dims = measureHeader(head, fmt) ?? sipsDims(file)
  const p = plan(fmt, dims, st.size, maxEdge)
  let bytes: Buffer
  let out = p.kind === 'attach' ? p.format : p.kind === 'convert' ? p.to : p.format
  let did = ''
  if (p.kind === 'attach') bytes = fs.readFileSync(file)
  else {
    if (!canResample()) {
      if (p.kind === 'convert') throw new Error(`${file} is ${fmt}, which a model cannot be shown, and this machine has no sips/ImageMagick to convert it. Convert to jpeg/png first.`)
      bytes = fs.readFileSync(file)  // showable but big: attach as-is, say so
      did = `\n${dims ? `${dims.width}×${dims.height}` : `${Math.round(st.size / 1024)}KB`} exceeds the target and nothing here can resample; attached full size.`
    } else {
      const tmp = path.join(os.tmpdir(), `tiny-see-${process.pid}-${Date.now()}.${out === 'jpeg' ? 'jpg' : out}`)
      try {
        resample(p, file, tmp)
        bytes = fs.readFileSync(tmp)
        // A png that shrank and is still over the cap is continuous-tone: redo as jpeg.
        if (out === 'png' && bytes.length > MAX_BYTES && isMac) {
          resample({ kind: 'convert', to: 'jpeg', edge: p.edge }, file, tmp)
          bytes = fs.readFileSync(tmp); out = 'jpeg'
        }
      } finally { try { fs.unlinkSync(tmp) } catch { /* nothing to remove */ } }
      did = p.kind === 'convert'
        ? `\nConverted ${fmt} → ${out}${p.edge ? ` at ${p.edge}px` : ''} to show it; file on disk unchanged.`
        : `\nResampled to ${p.edge}px long edge (was ${dims!.width}×${dims!.height}); file on disk unchanged. Pixel positions read off this picture are NOT the file's own coordinates.`
    }
  }
  const size = dims ? `${dims.width}×${dims.height}px, ` : ''
  const note = `👀 ${file} — ${fmt}, ${size}${Math.max(1, Math.round(st.size / 1024))}KB on disk${did}`
  return { format: out, base64: bytes.toString('base64'), note }
}

async function fetchToTmp(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': `tiny-tech use_image (+${apiUrl()})`, accept: 'image/*,*/*;q=0.8' } })
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  const tmp = path.join(os.tmpdir(), `tiny-see-url-${process.pid}-${Date.now()}`)
  fs.writeFileSync(tmp, buf)
  return tmp
}

export function listImages(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => IMAGE_EXT.test(f) && !f.startsWith('.')).sort()
    .map((f) => path.join(dir, f))
}

export function makeImageTool() {
  return tool({
    name: 'use_image',
    description: `👀 SEE an image file — the picture itself lands in your context, not a description of it.
- view (path | paths[] | url) — attach up to ${MAX_IMAGES} images. A directory path attaches its first ${MAX_IMAGES} images (use offset to page). max_edge (default ${MAX_EDGE}) shrinks big photos; nothing is ever upscaled. HEIC/TIFF/BMP are converted on the fly (macOS sips or ImageMagick). Files on disk are never modified.
- info (path) — format (from bytes), dimensions, size; for a directory: every image with its dimensions, no pixels attached (free).
Phone photos are 4000px+ and get resampled to max_edge; pass max_edge=600 to skim many cheaply, or view one at a time at the default for detail.`,
    inputSchema: z.object({
      action: z.enum(['view', 'info']).default('view'),
      path: z.string().optional().describe('file or directory (~ ok)'),
      paths: z.array(z.string()).optional().describe('several files at once'),
      url: z.string().optional().describe('https image URL'),
      max_edge: z.number().optional().describe(`longest edge in px after resampling (default ${MAX_EDGE})`),
      offset: z.number().optional().describe('directory paging: skip this many images'),
    }),
    callback: async (a) => {
      const tmps: string[] = []
      try {
        let files: string[] = []
        for (const p of [...(a.path ? [a.path] : []), ...(a.paths ?? [])]) {
          const f = expandTilde(p)
          if (!fs.existsSync(f)) return `no such file: ${f}`
          if (fs.statSync(f).isDirectory()) files.push(...listImages(f))
          else files.push(f)
        }
        const label = new Map<string, string>()
        if (a.url) { const t = await fetchToTmp(a.url); tmps.push(t); files.push(t); label.set(t, a.url) }
        if (!files.length) return 'need path, paths or url (a directory with no images counts as empty)'

        if (a.action === 'info') {
          const rows = files.map((f) => {
            try {
              const st = fs.statSync(f)
              const fd = fs.openSync(f, 'r'); const head = Buffer.alloc(Math.min(st.size, 65_536))
              try { fs.readSync(fd, head, 0, head.length, 0) } finally { fs.closeSync(fd) }
              const fmt = sniffFormat(head); const d = fmt ? measureHeader(head, fmt) : null
              return `${f}  ${fmt ?? 'not-an-image'}  ${d ? `${d.width}×${d.height}` : '?×?'}  ${Math.round(st.size / 1024)}KB`
            } catch (e: any) { return `${f}  error: ${e.message}` }
          })
          return `${rows.length} file${rows.length === 1 ? '' : 's'}:\n${rows.join('\n')}`
        }

        const total = files.length
        const off = Math.max(0, a.offset ?? 0)
        files = files.slice(off, off + MAX_IMAGES)
        const blocks: any[] = []
        const notes: string[] = []
        for (const f of files) {
          try {
            const s = prepareFile(f, a.max_edge ?? MAX_EDGE)
            notes.push(`[${blocks.length + 1}] ${label.has(f) ? s.note.replace(f, label.get(f)!) : s.note}`)
            blocks.push({ image: { format: s.format, source: { bytes: s.base64 } } })
          } catch (e: any) { notes.push(`✗ ${e.message}`) }
        }
        if (total > off + files.length) notes.push(`… ${total - off - files.length} more; call again with offset=${off + files.length}`)
        if (!blocks.length) return notes.join('\n')
        return [{ text: `${notes.join('\n')}\nThe image${blocks.length === 1 ? ' follows' : 's follow'} in the order listed.` }, ...blocks]
      } catch (e: any) {
        return `use_image failed: ${e.message}`
      } finally {
        for (const t of tmps) try { fs.unlinkSync(t) } catch { /* gone */ }
      }
    },
  })
}
