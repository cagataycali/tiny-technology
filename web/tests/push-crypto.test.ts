// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { workerFile, workerPresent as present, warnIfWorkerAbsent } from './_worker'

/**
 * Decrypt-side verification of the worker's RFC 8291 aes128gcm push
 * encryption: we play the BROWSER — generate a real P-256 subscription
 * key pair, let the worker code encrypt, then run the full RFC 8291
 * decrypt path. If any HKDF info string, salt handling, or record
 * delimiter is wrong, decryption fails loudly.
 *
 * Skips when the worker submodule is absent (CI has no .gitmodules).
 */
warnIfWorkerAbsent('push-crypto')

let encryptPayload: (payload: string, keys: { p256dh: string; auth: string }) => Promise<Uint8Array>
let b64urlToBytes: (s: string) => Uint8Array
let bytesToB64url: (b: Uint8Array | ArrayBuffer) => string

beforeAll(async () => {
  if (!present) return
  const mod = await import(workerFile('push.ts') /* @vite-ignore */)
  encryptPayload = mod.encryptPayload
  b64urlToBytes = mod.b64urlToBytes
  bytesToB64url = mod.bytesToB64url
})

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, key, length * 8
  ))
}

const concat = (...arrs: Uint8Array[]) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of arrs) { out.set(a, o); o += a.length }
  return out
}

/** Full RFC 8291 receiver: parse header, ECDH, HKDF, AES-GCM decrypt. */
async function browserDecrypt(body: Uint8Array, uaKeys: CryptoKeyPair, authSecret: Uint8Array): Promise<string> {
  // header: salt(16) || rs(4) || idlen(1) || keyid(idlen)
  const salt = body.slice(0, 16)
  const idlen = body[20]
  const asPublic = body.slice(21, 21 + idlen)
  const ciphertext = body.slice(21 + idlen)

  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey))
  const asKey = await crypto.subtle.importKey('raw', asPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey } as any, uaKeys.privateKey, 256))

  const te = new TextEncoder()
  const ikm = await hkdf(ecdh, authSecret, concat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const cek = await hkdf(ikm, salt, te.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(ikm, salt, te.encode('Content-Encoding: nonce\0'), 12)

  const aesKey = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt'])
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aesKey, ciphertext as BufferSource))

  // strip the 0x02 last-record delimiter (+ any zero padding after it)
  let end = plain.length - 1
  while (end >= 0 && plain[end] === 0) end--
  expect(plain[end]).toBe(2)
  return new TextDecoder().decode(plain.slice(0, end))
}

describe.skipIf(!present)('push aes128gcm encryption', () => {
  it('a real browser-side key pair can decrypt what the worker encrypts', async () => {
    const uaKeys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey))
    const authSecret = crypto.getRandomValues(new Uint8Array(16))

    const message = JSON.stringify({ title: 'tiny', body: 'job finished ✅', data: { url: '/cagatay' } })
    const encrypted = await encryptPayload(message, {
      p256dh: bytesToB64url(uaPublic),
      auth: bytesToB64url(authSecret),
    })

    const decrypted = await browserDecrypt(encrypted, uaKeys, authSecret)
    expect(decrypted).toBe(message)
  })

  it('header layout matches RFC 8188 (salt/rs/idlen/keyid)', async () => {
    const uaKeys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey))
    const encrypted = await encryptPayload('x', {
      p256dh: bytesToB64url(uaPublic),
      auth: bytesToB64url(crypto.getRandomValues(new Uint8Array(16))),
    })
    const rs = new DataView(encrypted.buffer, encrypted.byteOffset + 16, 4).getUint32(0)
    expect(rs).toBe(4096)
    expect(encrypted[20]).toBe(65) // uncompressed P-256 point
    expect(encrypted[21]).toBe(4)  // 0x04 uncompressed marker
  })

  it('unique salt + ephemeral key per encryption (no ciphertext reuse)', async () => {
    const uaKeys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey))
    const keys = { p256dh: bytesToB64url(uaPublic), auth: bytesToB64url(crypto.getRandomValues(new Uint8Array(16))) }
    const a = await encryptPayload('same message', keys)
    const b = await encryptPayload('same message', keys)
    expect(bytesToB64url(a.slice(0, 16))).not.toBe(bytesToB64url(b.slice(0, 16)))   // salt differs
    expect(bytesToB64url(a.slice(21, 86))).not.toBe(bytesToB64url(b.slice(21, 86))) // ephemeral key differs
  })
})

describe.skipIf(!present)('b64url round-trip', () => {
  it('bytes → b64url → bytes is identity (incl. padding edge lengths)', () => {
    for (const len of [1, 2, 3, 16, 32, 65]) {
      const bytes = crypto.getRandomValues(new Uint8Array(len))
      const back = b64urlToBytes(bytesToB64url(bytes))
      expect(Array.from(back)).toEqual(Array.from(bytes))
    }
  })
})
