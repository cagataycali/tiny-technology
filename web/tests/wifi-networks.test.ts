// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 📶 The saved WiFi list, where it crosses a file boundary.
 *
 * The rules themselves are tested in Swift (`WifiNetworksTests`): order, dedupe,
 * the wire shape, and what fits a board's buffer. What can only be checked here
 * is the wiring — the parts that live inside a `@MainActor` view — and the two
 * claims about OTHER files that the design rests on:
 *
 *   1. The sheet sizes the payload BEFORE enrolling, using the exact widths the
 *      worker mints (`worker/src/devices.ts`). If those widths
 *      change, the preview starts lying about what fits, and the only place the
 *      truth would surface is after `POST /api/devices` — which returns a board's
 *      token exactly once.
 *   2. A Nicla Voice is sent no networks at all. It has no WiFi radio (nRF52832)
 *      and a 256-byte config buffer, so a list would be both useless and the
 *      reason identity provisioning starts answering "too long".
 *
 * ⚠️ Comments are stripped before every scan: the docs in both files quote the
 * removed single-pair code and the byte widths verbatim while explaining them.
 */

const repo = join(__dirname, '..')
const raw = (p: string) => readFileSync(join(repo, p), 'utf8')
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\/\/\/.*$/gm, '')

const between = (src: string, from: string, to: string, what: string) => {
  const a = src.indexOf(from)
  expect(a, `${what}: "${from}" is gone — re-anchor`).toBeGreaterThan(-1)
  const b = src.indexOf(to, a)
  expect(b, `${what}: "${to}" is gone — re-anchor`).toBeGreaterThan(a)
  return strip(src.slice(a, b))
}

const setup = () => raw('ios/Tiny/Sources/TinySetup.swift')
const model = () => raw('ios/Tiny/Sources/WifiNetworks.swift')
const setUpFn = () => between(setup(), 'private func setUp() async {', '\n    }\n', 'setUp()')

describe('the board is given a list, not the one network it was born on', () => {
  it('the sheet no longer writes a single pair into the config', () => {
    const body = setUpFn()
    // The defect this replaces: one ssid/key, so the necklace was pinned to the
    // network it was provisioned on and a phone hotspot could not go on it.
    expect(body, 'the single-pair write is back').not.toMatch(/config\["ssid"\]\s*=/)
    expect(body, 'the single-pair write is back').not.toMatch(/config\["key"\]\s*=/)
    expect(body, 'the list is not being sent').toMatch(/WifiNetworks\.fit\(wifi\.networks/)
    expect(body, 'the list never reaches the provisioner').toMatch(/networks:\s*planned/)
  })

  it('a Voice gets an empty list, not a trimmed one', () => {
    const body = setUpFn()
    // `isVoice ? [] : fit(...)` — the branch, not a filter downstream, because
    // the reason is the absent radio and not the size of what would be sent.
    expect(body).toMatch(/let planned = isVoice\s*\n\s*\?\s*\[\]/)
  })

  it('Set up is gated on having a network saved, not on a text field', () => {
    // The field is now an "add" box that empties itself; gating on it would
    // disable the button right after the owner successfully saved a network.
    const src = strip(setup())
    expect(src).toMatch(/\.disabled\(\(!isVoice && wifi\.networks\.isEmpty\)/)
    expect(src, 'the button reads the emptied add-field again').not.toMatch(/\.disabled\(\(!isVoice && ssid\.isEmpty\)/)
  })

  it('one function frames the payload, so the size shown is the size sent', () => {
    const send = between(setup(), 'func send(config: [String: String]', '\n    }\n', 'send()')
    expect(send, 'a second encoder is back in send()').not.toMatch(/JSONSerialization/)
    expect(send).toMatch(/WifiNetworks\.encoded\(identity: config, networks: networks\)/)
    // The newline terminator belongs to that one encoder now.
    expect(strip(model())).toMatch(/json\.append\(0x0A\)/)
    expect(strip(setup()), 'the terminator is appended twice').not.toMatch(/append\(0x0A\)/)
  })
})

describe('what the sheet promises about a board it has not enrolled yet', () => {
  const devices = () => raw('worker/src/devices.ts')

  it('the reserved token width is the width the worker actually mints', () => {
    const mint = between(devices(), 'function mintToken()', '\n}', 'mintToken()')
    // 32 random bytes → base64 is ceil(32/3)*4 = 44 chars, one of them '=' for a
    // 32-byte input, and the padding is stripped → 43. Plus the 5-char prefix.
    expect(mint, 'the token is no longer 32 bytes of base64url').toMatch(/getRandomValues\(new Uint8Array\(32\)\)/)
    expect(mint, 'the padding is no longer stripped').toMatch(/replace\(\/=\+\$\/, ""\)/)
    expect(mint).toMatch(/\$\{DEVICE_TOKEN_PREFIX\}\$\{b64\}/)

    const prefix = devices().match(/DEVICE_TOKEN_PREFIX\s*=\s*"([^"]+)"/)?.[1]
    expect(prefix, 'the prefix moved').toBe('tind_')
    const width = prefix!.length + Math.ceil(32 / 3) * 4 - 1
    expect(width).toBe(48)

    const planned = between(setup(), 'private var plannedIdentity', '\n    }\n', 'plannedIdentity')
    expect(planned, `the sheet reserves the wrong token width — the worker mints ${width}`)
      .toContain(`"token": String(repeating: "x", count: ${width})`)
  })

  it('the reserved id width is a UUID, which is what the worker uses', () => {
    const post = between(devices(), 'const id = crypto.randomUUID();', 'device_token: token', 'enrol')
    expect(post, 'the id is no longer the randomUUID minted above it').toMatch(/device_id: id/)
    // "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" — 32 hex + 4 hyphens.
    const planned = between(setup(), 'private var plannedIdentity', '\n    }\n', 'plannedIdentity')
    expect(planned).toContain('"device_id": String(repeating: "x", count: 36)')
  })

  it('an overflow is named, never quietly trimmed', () => {
    const src = strip(setup())
    // `dropped` is derived from the whole saved list, so the count it reports
    // cannot come from an already-truncated array.
    expect(src).toMatch(/WifiNetworks\.fit\(wifi\.networks,\s*\n\s*identity: plannedIdentity/)
    expect(src, 'the dropped networks are no longer named').toMatch(/dropped\.map\(\\?\.ssid\)\.joined/)
  })
})

describe('WiFi passwords are stored like credentials', () => {
  it('the list lives in the keychain, not in UserDefaults', () => {
    const src = strip(model())
    expect(src).toMatch(/Keychain\.set\(Self\.slot/)
    expect(src).toMatch(/Keychain\.get\(Self\.slot\)/)
    expect(src, 'passwords are in UserDefaults again').not.toMatch(/@AppStorage|UserDefaults/)
  })

  it('the sheet keeps remembering only the SSID in plain storage', () => {
    // @AppStorage is fine for the add-field's convenience prefill: iOS won't hand
    // an app the current SSID without a location entitlement. It is not fine for
    // the password beside it, which stays @State and is cleared after each add.
    const src = strip(setup())
    expect(src).toMatch(/@AppStorage\("cfg_last_wifi_ssid"\) private var ssid = ""/)
    expect(src, 'the password became persistent plain storage').not.toMatch(/@AppStorage\([^)]*\) private var password/)
    expect(src, 'the password is no longer cleared after adding').toMatch(/password = ""/)
  })
})
