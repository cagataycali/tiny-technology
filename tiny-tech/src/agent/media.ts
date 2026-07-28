/**
 * 🖼️ Media out of the LOCAL agent loop — how a picture the daemon made gets
 * back to whoever asked for it (loop item d-d).
 *
 * use_computer already returns a real image block, so the local agent SEES the
 * screen it captured. But everything downstream of that turn is a string:
 * TinyAgent.invoke returns String(result) and relay-poller replies with
 * { result: "<text>" }. So "screenshot my laptop and read the error to me",
 * asked from the web (or the phone) through use_device, could only ever come
 * back as the daemon's PROSE ABOUT an image the cloud agent never saw — the
 * one thing a vision model doesn't need help with.
 *
 * The delivery path already exists for on-device generation: upload the bytes
 * ONCE to /api/media (R2), pass the hosted URL through the small message, and
 * let the reader turn the URL back into pixels. Base64 can never travel the
 * relay itself — the worker rejects any envelope over 8KB, and one screenshot
 * is hundreds of KB.
 *
 * Everything here is pure except uploadImages, which takes its poster as an
 * argument, so the whole path is testable with no screen and no network.
 */

/** How many images ride one reply. The newest are the relevant ones (a turn
 *  that shot the screen five times was iterating; the last frame is the
 *  answer), and the cloud agent pays vision tokens per image. */
export const MAX_IMAGES_PER_REPLY = 2

/** The worker's own decoded-upload cap (media.ts MEDIA_MAX_BYTES). Anything
 *  larger is rejected there, so drop it here where we can say why. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024

/** Formats the media store accepts (worker media.ts EXT allowlist). */
export const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

export interface HarvestedImage {
  format: string
  /** base64 bytes — what /api/media takes. */
  base64: string
  /** Decoded size, for the cap and for the log line. */
  bytes: number
}

export interface HostedImage { url: string; format: string }

/** base64 for whatever the SDK left in an image source: a class instance holds
 *  Uint8Array (ImageBlock decodes on construction), a serialized/raw block
 *  holds the base64 string the tool returned. Accept both — the harvester runs
 *  against live agent messages, whose shape depends on which path built them. */
export function imageBase64(source: unknown): string | null {
  const bytes = (source as any)?.bytes
  if (typeof bytes === 'string') return bytes || null
  if (bytes instanceof Uint8Array || Buffer.isBuffer(bytes)) {
    return bytes.length ? Buffer.from(bytes).toString('base64') : null
  }
  return null
}

/** Decoded byte count of base64 text, without decoding it. */
export function base64Bytes(b64: string): number {
  const clean = b64.replace(/=+$/, '')
  return Math.floor((clean.length * 3) / 4)
}

function imageFrom(block: any): HarvestedImage | null {
  // Class instance (ImageBlock) or wrapped data ({ image: {...} }).
  const img = block?.type === 'imageBlock' ? block : block?.image
  if (!img) return null
  const format = String(img.format || 'png').toLowerCase()
  if (!IMAGE_CONTENT_TYPES[format]) return null
  const base64 = imageBase64(img.source)
  if (!base64) return null
  const bytes = base64Bytes(base64)
  if (!bytes || bytes > MAX_IMAGE_BYTES) return null
  return { format, base64, bytes }
}

/**
 * Pull the images a turn produced out of the agent's messages.
 *
 * Only TOOL RESULTS count: those are the pictures this turn made (a screenshot,
 * a generated image). Images the user attached to the prompt are already on the
 * asker's side — echoing them back would spend vision tokens to tell someone
 * what they just sent.
 */
export function harvestImages(messages: unknown, limit = MAX_IMAGES_PER_REPLY): HarvestedImage[] {
  if (!Array.isArray(messages)) return []
  const found: HarvestedImage[] = []
  for (const msg of messages) {
    const content = (msg as any)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const tr = block?.type === 'toolResultBlock' ? block : block?.toolResult
      if (!tr || !Array.isArray(tr.content)) continue
      for (const inner of tr.content) {
        const img = imageFrom(inner)
        if (img) found.push(img)
      }
    }
  }
  // Newest wins when a turn made more than the cap.
  return limit > 0 ? found.slice(-limit) : []
}

/**
 * Upload harvested images to the media store, one POST each, and return the
 * hosted URLs. `poster` is the seam: the daemon passes TinyApi.post, tests pass
 * a recorder. A single failed upload drops THAT image and keeps the rest — a
 * missing picture must never cost the user the text answer as well.
 */
export async function uploadImages(
  images: HarvestedImage[],
  poster: (path: string, body: any) => Promise<any>,
): Promise<HostedImage[]> {
  const out: HostedImage[] = []
  for (const img of images) {
    const contentType = IMAGE_CONTENT_TYPES[img.format]
    if (!contentType) continue
    try {
      const r = await poster('/api/media', { data: img.base64, contentType })
      const url = r?.url ? String(r.url) : ''
      if (/^https?:\/\//i.test(url)) out.push({ url, format: img.format === 'jpg' ? 'jpeg' : img.format })
    } catch { /* one lost image, not a lost reply */ }
  }
  return out
}

/**
 * Serialize a relay reply that FITS.
 *
 * The old code clamped the text to 8000 chars and then JSON.stringify'd it —
 * but escaping GROWS the string: 8000 newlines serialize to 16000 characters,
 * over the worker's 8192-byte envelope limit, so the PATCH was rejected and the
 * whole reply vanished (the asker just timed out). Measure the serialized form
 * and shrink the text until it actually fits, and keep the image URLs while
 * doing it: pixels are the part that can't be re-derived from prose.
 */
export function buildRelayReply(text: string, images: HostedImage[] = [], max = 8000): string {
  const imgs = images.filter((i) => i?.url).slice(0, MAX_IMAGES_PER_REPLY)
  const pack = (t: string) => JSON.stringify(imgs.length ? { result: t, images: imgs } : { result: t })

  let body = String(text ?? '')
  let payload = pack(body)
  if (payload.length <= max) return payload

  // Binary-search the longest prefix whose SERIALIZED form fits. Character
  // arithmetic can't predict this: one char may cost 1 or 6 in JSON.
  let lo = 0
  let hi = body.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (pack(body.slice(0, mid) + '…').length <= max) lo = mid
    else hi = mid - 1
  }
  body = body.slice(0, lo) + '…'
  payload = pack(body)
  // Degenerate case: the image URLs alone don't fit (absurdly long URLs) —
  // drop them rather than emit an envelope the worker will refuse.
  if (payload.length > max) payload = JSON.stringify({ result: body.slice(0, Math.max(0, max - 32)) })
  return payload
}

/** Told-you-so line when a picture existed but couldn't be delivered — better
 *  than the cloud agent silently believing the daemon only talks. */
export function undeliveredNote(harvested: number, hosted: number): string {
  const lost = harvested - hosted
  if (lost <= 0) return ''
  return `\n\n(⚠️ ${lost} image${lost === 1 ? '' : 's'} from this run could not be uploaded — the device may not be logged in (\`npx tiny-tech login\`). The text above is complete.)`
}
