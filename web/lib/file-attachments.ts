/**
 * File attachment utilities — read files into typed Attachment objects and
 * convert them to Strands content blocks (careless pattern, ported).
 *
 * Client-side only (uses FileReader/canvas). Two additions over careless:
 *  - images are downscaled + recompressed (canvas) so a 12MP iOS camera
 *    shot doesn't blow the ~4.5MB Vercel Edge request body limit
 *  - every attachment gets a small `thumb` dataUrl so previews can be
 *    persisted to localStorage without storing the full base64 payload
 */

export interface Attachment {
  type: 'image' | 'file' | 'document'
  /** Full-size dataUrl for lightbox/preview during the session */
  dataUrl?: string
  /** Raw base64 payload sent to the model (stripped before persistence) */
  base64?: string
  /** image: jpeg|png|gif|webp — document: pdf|csv|docx|... */
  format?: string
  name?: string
  size?: number
  /** Extracted text for text-ish files */
  text?: string
  mime?: string
  /** Small persisted preview (~12KB) that survives localStorage round-trips */
  thumb?: string
}

/** Keep the JSON body comfortably under Vercel Edge's ~4.5MB request cap:
 * base64 inflates 4/3× and history/system context rides along too. */
export const MAX_PAYLOAD_BYTES = 3_500_000
/** Longest edge for model-bound images — Anthropic downscales past ~1568px anyway */
const MAX_IMAGE_DIM = 1568
const JPEG_QUALITY = 0.85
const THUMB_DIM = 192
const THUMB_QUALITY = 0.7
/** Single document cap — larger than this can't fit the request body */
export const MAX_DOCUMENT_BYTES = 3_000_000

const TEXT_FILE_EXTENSIONS = /\.(txt|md|json|yml|yaml|csv|ts|tsx|js|jsx|py|go|rs|c|cpp|h|java|rb|sh|html|css|xml|sql|toml|ini|log)$/i
const TEXT_MIME_PREFIX = /^text\//

const DOC_EXT_TO_FORMAT: Record<string, string> = {
  pdf: 'pdf', csv: 'csv', doc: 'doc', docx: 'docx', xls: 'xls', xlsx: 'xlsx',
  html: 'html', htm: 'html', txt: 'txt', md: 'md', markdown: 'md', json: 'json', xml: 'xml',
}
const DOC_MIME_TO_FORMAT: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/html': 'html',
  'text/xml': 'xml', 'application/xml': 'xml',
}

function getDocumentFormat(file: File): string | null {
  if (DOC_MIME_TO_FORMAT[file.type]) return DOC_MIME_TO_FORMAT[file.type]
  const ext = file.name.toLowerCase().split('.').pop() || ''
  return DOC_EXT_TO_FORMAT[ext] || null
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function drawScaled(img: HTMLImageElement, maxDim: number, quality: number): string {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

/** Approximate decoded byte size of a base64 string */
export function base64Bytes(b64: string): number {
  return Math.floor(b64.length * 0.75)
}

/**
 * Downscale + recompress an image dataUrl for the model. GIFs pass through
 * (canvas would kill the animation) unless they're oversized.
 */
async function processImage(dataUrl: string, mime: string): Promise<{ dataUrl: string; format: string; thumb: string }> {
  const img = await loadImage(dataUrl)
  const thumb = drawScaled(img, THUMB_DIM, THUMB_QUALITY)
  const oversized = base64Bytes(dataUrl.split(',')[1] || '') > 1_000_000
  const tooBig = Math.max(img.naturalWidth, img.naturalHeight) > MAX_IMAGE_DIM
  const format = (mime.split('/')[1] || 'jpeg').toLowerCase().replace('jpg', 'jpeg')

  if (format === 'gif' && !oversized) return { dataUrl, format, thumb }
  if (!tooBig && !oversized && ['jpeg', 'png', 'webp', 'gif'].includes(format)) {
    return { dataUrl, format, thumb }
  }
  // Re-encode: iOS HEIC, oversized camera shots, exotic formats all land here
  return { dataUrl: drawScaled(img, MAX_IMAGE_DIM, JPEG_QUALITY), format: 'jpeg', thumb }
}

export async function readFileAsAttachment(file: File): Promise<Attachment> {
  const isImage = file.type.startsWith('image/')
  const docFormat = isImage ? null : getDocumentFormat(file)
  const isTextish = !isImage && !docFormat && (TEXT_MIME_PREFIX.test(file.type) || TEXT_FILE_EXTENSIONS.test(file.name) || file.type === 'application/json')

  if (isImage) {
    const raw = await readAsDataUrl(file)
    const { dataUrl, format, thumb } = await processImage(raw, file.type)
    const base64 = dataUrl.split(',')[1]
    return { type: 'image', dataUrl, base64, format, thumb, name: file.name, size: base64Bytes(base64), mime: file.type }
  }
  if (docFormat) {
    if (file.size > MAX_DOCUMENT_BYTES) {
      throw new Error(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB — documents must be under ${(MAX_DOCUMENT_BYTES / 1024 / 1024).toFixed(1)}MB`)
    }
    const dataUrl = await readAsDataUrl(file)
    const base64 = dataUrl.split(',')[1]
    let text: string | undefined
    if (['txt', 'md', 'csv', 'html', 'xml', 'json'].includes(docFormat)) {
      try { text = await file.text() } catch {}
    }
    return { type: 'document', base64, format: docFormat, name: file.name, size: file.size, mime: file.type, text }
  }
  if (isTextish) {
    const text = await file.text()
    const trimmed = text.length > 50000 ? text.slice(0, 50000) + '\n...[truncated]' : text
    return { type: 'file', text: trimmed, name: file.name, size: file.size, mime: file.type || 'text/plain' }
  }
  return { type: 'file', text: `(binary file: ${file.name}, ${file.size} bytes, type=${file.type || 'unknown'})`, name: file.name, size: file.size, mime: file.type }
}

/**
 * Process multiple files, isolating failures: one undecodable image (a
 * corrupt file, HEIC outside Safari) or oversized document must not drop
 * the whole picked batch — successes attach, failures return as messages
 * for the caller to surface.
 */
export async function ingestFiles(
  files: FileList | File[],
): Promise<{ attachments: Attachment[]; errors: string[] }> {
  const list = Array.from(files)
  const results = await Promise.allSettled(list.map(readFileAsAttachment))
  const attachments: Attachment[] = []
  const errors: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') attachments.push(r.value)
    // Image decode rejections carry an Event, not an Error — synthesize a
    // named message so the toast tells the user WHICH file failed
    else errors.push(r.reason?.message || `Couldn't read ${list[i]?.name || 'file'} — unsupported or corrupted`)
  })
  return { attachments, errors }
}

/**
 * Convert text + attachments into Strands ContentBlockData[]
 * ({text} / {image:{format,source:{bytes}}} / {document:{name,format,source:{bytes}}}).
 * Document names are sanitized — Anthropic rejects odd characters.
 */
export function buildContentBlocks(text: string, attachments?: Attachment[]): any[] {
  const blocks: any[] = []
  const promptText = text.trim() || 'Have a look.'
  blocks.push({ text: promptText })
  if (attachments?.length) {
    for (const att of attachments) {
      if (!att || typeof att !== 'object') continue // skip null/garbage entries
      if (att.type === 'image' && att.base64) {
        blocks.push({ image: { format: att.format || 'jpeg', source: { bytes: att.base64 } } })
      } else if (att.type === 'document' && att.base64 && att.format) {
        const safeName = (att.name || 'document')
          .replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9\s\-()\[\]]/g, '_').slice(0, 200) || 'document'
        blocks.push({ document: { name: safeName, format: att.format, source: { bytes: att.base64 } } })
      } else if ((att.type === 'file' || att.type === 'document') && att.text) {
        blocks.push({ text: `\n\n--- Attached file: ${att.name} ---\n${att.text}\n--- end ---` })
      } else {
        blocks.push({ text: `[attachment "${att.name || 'file'}" no longer available — it was sent in an earlier session]` })
      }
    }
  }
  return blocks
}

/** Total model-bound bytes across attachments (base64 payloads + inline text) */
export function attachmentsPayloadBytes(attachments: Attachment[]): number {
  return attachments.reduce((n, a) => n + (a.base64 ? base64Bytes(a.base64) : 0) + (a.text?.length || 0), 0)
}

// Per-attachment cap on the `text` we persist. Extracted file/document text
// can be up to 50KB each (documents: uncapped `file.text()`), so a few large
// attachments across a session would blow the ~5MB localStorage quota and the
// history write would throw. Small files keep full text (still render on
// reload); larger ones are truncated with a marker.
const PERSIST_TEXT_CAP = 4000

/**
 * Strip heavy payloads before localStorage persistence — keeps the ~5MB
 * quota safe. Thumbs + metadata survive so history still renders previews.
 * Base64/dataUrl are dropped entirely; extracted `text` is capped (not the
 * heavy binary, but big enough across many files to overflow the quota).
 */
export function persistableAttachments(attachments?: Attachment[]): Attachment[] | undefined {
  if (!attachments?.length) return undefined
  return attachments.map(({ base64, dataUrl, ...rest }) => {
    if (rest.text && rest.text.length > PERSIST_TEXT_CAP) {
      return { ...rest, text: rest.text.slice(0, PERSIST_TEXT_CAP) + '\n...[truncated in saved history]' }
    }
    return rest
  })
}
