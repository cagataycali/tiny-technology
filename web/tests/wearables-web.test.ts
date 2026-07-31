// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildHandoffUrl, isCallbackVisit, APP_SCHEME } from '@/app/wearables/handoff'

/**
 * 🕶️ Meta Wearables integration — the web half.
 *
 * The universal-link plumbing is three artifacts that must agree with things
 * OUTSIDE this app: the AASA file with the Xcode project (team + bundle), the
 * assetlinks file with the Android build (package + signing cert), and the
 * handoff scheme with the iOS Info.plist. None of those agreements is enforced
 * by any compiler, so they are pinned here — the same cross-client parity
 * idiom as the rest of this suite.
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const aasa = JSON.parse(read('public/.well-known/apple-app-site-association'))
const assetlinks = JSON.parse(read('public/.well-known/assetlinks.json'))
const pbxproj = read('ios/Tiny.xcodeproj/project.pbxproj')
const gradle = read('android/app/build.gradle.kts')
const infoPlist = read('ios/Tiny/Info.plist')

describe('apple-app-site-association ↔ the Xcode project', () => {
  it('names exactly the app the project builds (team ID + bundle ID)', () => {
    // This repo deliberately leaves DEVELOPMENT_TEAM unset (project.yml
    // explains — build-on-device.sh detects YOUR team). The deployed AASA
    // still pins the tiny.technology production team; when a fork sets its
    // own team, the pbxproj value must agree with the AASA it deploys.
    const teams = Array.from(new Set(
      Array.from(pbxproj.matchAll(/DEVELOPMENT_TEAM = ([A-Z0-9]+);/g), (m) => m[1]),
    ))
    expect(teams.length).toBeLessThanOrEqual(1)
    const bundles = new Set(Array.from(pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([\w.]+);/g), (m) => m[1]))

    const appIds: string[] = aasa.applinks.details.flatMap((d: any) => d.appIDs)
    expect(appIds.length).toBeGreaterThan(0)
    for (const id of appIds) {
      const [team, ...rest] = id.split('.')
      expect(team).toMatch(/^[A-Z0-9]{10}$/)
      if (teams.length === 1) expect(team).toBe(teams[0])
      expect(bundles.has(rest.join('.'))).toBe(true)
    }
  })

  it('routes /wearables (and subpaths) to the app, and that page actually exists', () => {
    const patterns = aasa.applinks.details.flatMap((d: any) => d.components.map((c: any) => c['/']))
    expect(patterns).toContain('/wearables')
    expect(patterns).toContain('/wearables/*')
    // A declared universal-link destination with no page 404s in every
    // browser that ever sees it (no app installed).
    expect(existsSync(join(ROOT, 'app/wearables/page.tsx'))).toBe(true)
  })

  it('webcredentials names the same app', () => {
    expect(aasa.webcredentials.apps).toEqual(aasa.applinks.details[0].appIDs)
  })
})

describe('assetlinks.json ↔ the Android build', () => {
  const target = assetlinks[0].target

  it('names the applicationId the gradle build produces', () => {
    const appId = gradle.match(/applicationId = "([\w.]+)"/)?.[1]
    expect(appId).toBeTruthy()
    expect(target.package_name).toBe(appId)
  })

  it('carries one well-formed SHA-256 cert fingerprint', () => {
    expect(target.sha256_cert_fingerprints).toHaveLength(1)
    expect(target.sha256_cert_fingerprints[0]).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  })

  it('is the same certificate the Meta console was given (base64url, unpadded)', () => {
    // The value typed into Meta's Wearables Developer Center on 2026-07-28.
    // If the fingerprint here ever changes (new keystore), the console entry
    // must be updated too — this test is what says so.
    const hex = target.sha256_cert_fingerprints[0].replaceAll(':', '')
    const b64url = Buffer.from(hex, 'hex').toString('base64')
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    expect(b64url).toBe('Ka05bK6mgYFpiBJhkFRcLOi1NZn050T2OEbt0GYuHXg')
  })
})

describe('the AASA file is served as JSON', () => {
  it('next.config headers() sets Content-Type for the extension-less file', async () => {
    // Execute the config, don't grep it: a renamed source pattern or a typo'd
    // header key would keep a string assertion green (c25's docblock lesson).
    const config = require(join(ROOT, 'next.config.js'))
    const rules = await config.headers()
    const rule = rules.find((r: any) => r.source === '/.well-known/apple-app-site-association')
    expect(rule).toBeTruthy()
    expect(rule.headers).toContainEqual({ key: 'Content-Type', value: 'application/json' })
  })
})

describe('the browser → app handoff', () => {
  it('forwards callback params into the app scheme untouched', () => {
    expect(buildHandoffUrl('?code=abc&state=x')).toBe('tinyapp://wearables?code=abc&state=x')
    expect(buildHandoffUrl('code=abc')).toBe('tinyapp://wearables?code=abc')
  })

  it('is a plain destination when there is nothing to forward', () => {
    expect(buildHandoffUrl('')).toBe('tinyapp://wearables')
    expect(buildHandoffUrl('?')).toBe('tinyapp://wearables')
  })

  it('only treats visits WITH params as callbacks', () => {
    expect(isCallbackVisit('?code=abc')).toBe(true)
    expect(isCallbackVisit('')).toBe(false)
    expect(isCallbackVisit('?')).toBe(false)
  })

  it('uses a scheme iOS actually claims (CFBundleURLSchemes)', () => {
    // The scheme is registered in Info.plist for auth today; the handoff
    // rides the same registration. If someone renames it there, this is
    // the only place that notices the wearables callback broke.
    const urlTypes = infoPlist.slice(infoPlist.indexOf('CFBundleURLTypes'))
    expect(urlTypes).toContain(`<string>${APP_SCHEME}</string>`)
  })
})
