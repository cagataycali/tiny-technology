/**
 * Local file → Strands content block for tiny_chat attachments.
 *
 * Mirrors the web app's lib/file-attachments.ts classification:
 *   images    → { image: { format, source: { bytes: base64 } } }
 *   documents → { document: { name, format, source: { bytes: base64 } } }
 *   text-ish  → inline text block (50k char cap)
 *
 * No canvas in Node, so images aren't downscaled — instead a hard size cap
 * keeps the request under the edge body limit; callers get a clear error
 * telling them to resize.
 */
import { closeSync, openSync, readSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'

const MAX_FILE_BYTES = 3_000_000 // base64 inflates 4/3× toward the ~4.5MB edge cap
const MAX_TOTAL_BYTES = 3_500_000
const MAX_TEXT_CHARS = 50_000
/**
 * How much of a text file is worth reading to keep MAX_TEXT_CHARS of it.
 *
 * 4 bytes per character is the worst case UTF-8 can do, so this prefix cannot
 * under-fill the character budget no matter what the encoding throws at it, and
 * it bounds the read at 200 KB whether the file is 200 KB or 200 GB. The old code
 * read the WHOLE file and then sliced — attaching a 2 GB production.log (exactly
 * the file you would attach to an agent) buffered 2 GB to keep 50 000 characters,
 * and past Node's ~2 GB ceiling threw ERR_FS_FILE_TOO_LARGE instead of the
 * actionable message the caps exist to produce.
 */
const TEXT_PREFIX_BYTES = MAX_TEXT_CHARS * 4

/** The first `n` bytes, without buffering a byte more. */
function readPrefix(path: string, n: number): { buf: Buffer; complete: boolean } {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(n)
    const read = readSync(fd, buf, 0, n, 0)
    // A short read means we reached EOF inside the window, so this IS the file.
    return { buf: buf.subarray(0, read), complete: read < n }
  } finally {
    closeSync(fd)
  }
}

const IMAGE_EXT: Record<string, string> = {
  jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp',
}
const DOC_EXT: Record<string, string> = {
  pdf: 'pdf', csv: 'csv', doc: 'doc', docx: 'docx', xls: 'xls', xlsx: 'xlsx',
  html: 'html', htm: 'html', xml: 'xml',
}
const TEXT_EXT = /^(txt|md|markdown|json|yml|yaml|ts|tsx|js|jsx|py|go|rs|c|cpp|h|java|rb|sh|css|sql|toml|ini|log)$/

function sanitizeDocName(name: string): string {
  return (
    name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9\s\-()\[\]]/g, '_').slice(0, 200) || 'document'
  )
}

/** Read one local file into a content block. Throws with actionable messages. */
export function fileToContentBlock(path: string): any {
  const full = resolve(path)
  const st = statSync(full) // throws ENOENT with the path in it
  const size = st.size
  const ext = extname(full).slice(1).toLowerCase()
  const name = basename(full)

  // statSync succeeds on a directory and reports a size, and extname('logs') is
  // '' — so a directory used to take the extensionless-text path and die inside
  // readFileSync with a bare EISDIR. Every other rejection in this file is a
  // sentence saying what to do instead; `attach ./logs` deserves one too.
  if (st.isDirectory()) {
    throw new Error(`${name} is a directory — attach a file inside it, not the folder`)
  }

  if (IMAGE_EXT[ext] || DOC_EXT[ext]) {
    if (size > MAX_FILE_BYTES) {
      throw new Error(
        `${name} is ${(size / 1024 / 1024).toFixed(1)}MB — attachments must be under ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(1)}MB (resize/compress it first)`
      )
    }
    const base64 = readFileSync(full).toString('base64')
    if (IMAGE_EXT[ext]) {
      return { image: { format: IMAGE_EXT[ext], source: { bytes: base64 } } }
    }
    return { document: { name: sanitizeDocName(name), format: DOC_EXT[ext], source: { bytes: base64 } } }
  }

  if (TEXT_EXT.test(ext) || ext === '') {
    // Bounded prefix, not the whole file. The sniff below only ever looked at
    // 8 KB, but `raw` used to be every byte — so a 5 GB extensionless blob was
    // read completely in order to examine 8 KB of it and then reject it.
    const { buf, complete } = readPrefix(full, TEXT_PREFIX_BYTES)
    // Extensionless files might be binaries (e.g. /bin/ls) — sniff for null
    // bytes before treating as text; UTF-8 text never contains 0x00
    if (buf.subarray(0, 8192).includes(0)) {
      throw new Error(`${name} looks like a binary file — attach images/PDFs/docs by extension, or convert to text first`)
    }
    const text = buf.toString('utf8')
    // Clipped if the character budget ran out, OR if the file continued past the
    // prefix we read — otherwise a 2 GB log would silently claim to be complete.
    const over = text.length > MAX_TEXT_CHARS
    const trimmed = over || !complete
      ? text.slice(0, MAX_TEXT_CHARS) + '\n...[truncated]'
      : text
    return { text: `\n\n--- Attached file: ${name} ---\n${trimmed}\n--- end ---` }
  }

  throw new Error(`${name}: unsupported file type '.${ext}' (images: jpg/png/gif/webp, docs: pdf/csv/docx/xlsx/html/xml, or any text file)`)
}

/** Read many files, enforcing the total payload budget. */
export function filesToContentBlocks(paths: string[]): any[] {
  const blocks = paths.map(fileToContentBlock)
  const total = blocks.reduce((n, b) => {
    const bytes = b.image?.source?.bytes || b.document?.source?.bytes
    return n + (bytes ? Math.floor(bytes.length * 0.75) : (b.text?.length || 0))
  }, 0)
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(`attachments total ${(total / 1024 / 1024).toFixed(1)}MB — must be under ${(MAX_TOTAL_BYTES / 1024 / 1024).toFixed(1)}MB combined`)
  }
  return blocks
}
