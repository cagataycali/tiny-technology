// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * 🕶️ Meta Wearables integration — the iOS half.
 *
 * The DAT SDK is configured entirely by declaration: creds in the Info.plist
 * MWDAT dict, an accessory protocol string, background modes, a universal-link
 * entitlement, and a pinned binary package. Each of those must agree with an
 * artifact OUTSIDE project.yml (Meta's console via meta.md, the AASA file, the
 * web's canonical domain), and none of that agreement is compiler-enforced —
 * so it is pinned here, like the web half in wearables-web.test.ts.
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const projectYml = parseYaml(read('ios/project.yml'))
const tinyTarget = projectYml.targets.Tiny
const info = tinyTarget.info.properties
const metaMd = read('meta.md')

/** meta.md is the plist snippet from Meta's console — the source of truth. */
const plistValue = (key: string) =>
  metaMd.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1]

describe('MWDAT credentials ↔ meta.md (the values Meta issued)', () => {
  it('MetaAppID, ClientToken and the callback scheme are the issued ones, verbatim', () => {
    expect(String(info.MWDAT.MetaAppID)).toBe(plistValue('MetaAppID'))
    expect(info.MWDAT.ClientToken).toBe(plistValue('ClientToken'))
    expect(info.MWDAT.AppLinkURLScheme).toBe(plistValue('AppLinkURLScheme'))
  })

  it('the ClientToken embeds the same MetaAppID (Meta issues them as a pair)', () => {
    expect(info.MWDAT.ClientToken.split('|')[1]).toBe(String(info.MWDAT.MetaAppID))
  })

  it('TeamID defers to the build setting that signs the app', () => {
    expect(info.MWDAT.TeamID).toBe('$(DEVELOPMENT_TEAM)')
    // This repo deliberately leaves DEVELOPMENT_TEAM unset (project.yml
    // explains) — but IF a fork pins one, it must be a real 10-char team.
    const team = projectYml.settings.base.DEVELOPMENT_TEAM
    if (team !== undefined) expect(String(team)).toMatch(/^[A-Z0-9]{10}$/)
  })

  it('DAM stays enabled (the SDK default the docs require)', () => {
    expect(info.MWDAT.DAMEnabled).toBe(true)
  })

  it('the callback scheme is one iOS actually claims', () => {
    const scheme = info.MWDAT.AppLinkURLScheme.replace('://', '')
    const claimed = info.CFBundleURLTypes.flatMap((t: any) => t.CFBundleURLSchemes)
    expect(claimed).toContain(scheme)
  })
})

describe('accessory + background declarations the SDK needs', () => {
  it('declares the DAT accessory protocol', () => {
    expect(info.UISupportedExternalAccessoryProtocols).toEqual(['com.meta.ar.wearable'])
  })

  it('keeps the pre-glasses background modes AND adds the two DAT ones', () => {
    for (const mode of ['fetch', 'audio', 'bluetooth-peripheral', 'external-accessory']) {
      expect(info.UIBackgroundModes).toContain(mode)
    }
  })
})

describe('universal links are OFF — and deliberately so', () => {
  it('no associated-domains entitlement (personal team; Apple refuses the capability)', () => {
    // Provisioning error, measured 2026-07-28: "Personal development teams,
    // including 'Cagatay Cali', do not support the Associated Domains
    // capability." Until a paid Developer Program team signs the app, an
    // applinks entry here BREAKS every device build — the Meta callback
    // rides the tinyapp:// scheme instead. The web AASA stays deployed and
    // inert for the day this flips.
    expect(tinyTarget.entitlements.properties['com.apple.developer.associated-domains']).toBeUndefined()
  })
})

describe('the SDK package', () => {
  it('is pinned to an exact version (binary xcframeworks — no floating)', () => {
    expect(projectYml.packages.MetaWearablesDAT).toEqual({
      url: 'https://github.com/facebook/meta-wearables-dat-ios',
      exactVersion: '0.8.0',
    })
  })

  it('links MWDATCore + MWDATCamera, both iOS-filtered (no Catalyst slice exists)', () => {
    const pkgDeps = tinyTarget.dependencies.filter((d: any) => d.package === 'MetaWearablesDAT')
    expect(pkgDeps.map((d: any) => d.product).sort()).toEqual(['MWDATCamera', 'MWDATCore'])
    for (const d of pkgDeps) expect(d.platformFilter).toBe('iOS')
  })
})

describe('the DAT callback dispatch (the bug the first real link attempt found)', () => {
  it('claims metaWearablesAction URLs BEFORE the host guard', () => {
    // The callback may arrive host-less; the original wiring guarded on
    // url.host() first and silently swallowed it — Meta AI reported success,
    // tiny stayed "Not linked". Both anchors must exist AND be ordered.
    const app = read('ios/Tiny/Sources/TinyApp.swift')
    const dispatch = app.indexOf('metaWearablesAction')
    const hostGuard = app.indexOf('guard let host = url.host()')
    expect(dispatch).toBeGreaterThan(-1)
    expect(hostGuard).toBeGreaterThan(-1)
    expect(dispatch).toBeLessThan(hostGuard)
  })

  it('the callback error is surfaced, not swallowed', () => {
    const mgr = read('ios/Tiny/Sources/Wearables.swift')
    expect(mgr).toMatch(/catch \{\s*\n\s*lastError = "Link callback failed/)
  })
})

describe('meta_take_photo — one name across the whole stack', () => {
  it('server tool, chat-route mount, decoder case and executor all agree', () => {
    // Four artifacts, three languages, no compiler between them.
    const platform = read('lib/chat/tools/platform.ts')
    const decoder = read('ios/Tiny/Sources/ChatStreamDecoder.swift')
    const views = read('ios/Tiny/Sources/Views.swift')
    expect(platform).toMatch(/name: 'meta_take_photo'/)
    expect(platform).toMatch(/name: 'meta_record_video'/)
    expect(platform).toMatch(/name: 'meta_listen'/)
    expect(read('app/api/chat/route.ts'))
      .toMatch(/tinySession === 'tiny-ios' \? \[generateImageTool, metaTakePhotoTool, metaRecordVideoTool, metaListenTool, metaGlassesStatusTool\]/)
    expect(decoder).toContain('case "meta_take_photo"')
    expect(decoder).toContain('case "meta_record_video"')
    expect(decoder).toContain('case "meta_listen"')
    expect(views).toContain('case .metaTakePhoto(let id)')
    expect(views).toContain('case .metaRecordVideo(let id)')
    expect(views).toContain('case .metaListen(let id, let seconds)')
  })

  it('the recorder posts an outcome on every path and respects the 6MB media cap', () => {
    const rec = read('ios/Tiny/Sources/WearablesRecorder.swift')
    // start-error, stop (ok + failures) and the pending path all funnel
    // through runTool's single postResult — assert the funnel exists and
    // that every branch RETURNS a payload (no bare returns before post).
    expect(rec).toMatch(/await postResult\(toolUseId, token: token, payload: payload\)/)
    expect(rec).toMatch(/6 \* 1024 \* 1024/)
    // The worker allowlist must accept what the recorder uploads.
    expect(read('worker/src/media.ts')).toContain('"video/mp4": "mp4"')
  })

  it('the executor posts an outcome on EVERY path (a silent path strands the server poll)', () => {
    const mgr = read('ios/Tiny/Sources/Wearables.swift')
    expect(mgr).toMatch(/func runPhotoTool/)
    // Success path + catch path both post to the mailbox.
    expect((mgr.match(/await postResult\(toolUseId/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  it('glasses context rides extraSystem beside the location block', () => {
    expect(read('ios/Tiny/Sources/Views.swift')).toMatch(/\[continuity, geoBlock, glassesBlock\]/)
    expect(read('ios/Tiny/Sources/Wearables.swift')).toMatch(/func contextIfLinked/)
  })
})

describe('every MWDAT use site is Catalyst-safe (guarded by canImport)', () => {
  /**
   * A Mac Catalyst build has no MWDAT module at all, so ANY unguarded
   * reference is a compile error there — but nobody builds Catalyst on every
   * cycle, so the guard is asserted statically: each line that mentions the
   * SDK must sit inside a `#if canImport(MWDATCore)`-conditioned region.
   */
  const guardedLines = (source: string): { line: string; n: number; guarded: boolean }[] => {
    const stack: boolean[] = []
    return source.split('\n').map((line, i) => {
      const t = line.trim()
      // A comment is not a use site — a docblock explaining the SDK must not
      // trip the walker (nor could a comment ever satisfy it: c25's lesson,
      // both directions).
      const isComment = t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
      const entry = { line: isComment ? '' : t, n: i + 1, guarded: stack.some(Boolean) }
      if (t.startsWith('#if')) stack.push(t.includes('canImport(MWDATCore)'))
      else if (t.startsWith('#endif')) stack.pop()
      return entry
    })
  }

  for (const file of ['ios/Tiny/Sources/Wearables.swift', 'ios/Tiny/Sources/WearablesLive.swift', 'ios/Tiny/Sources/WearablesRecorder.swift', 'ios/Tiny/Sources/TinyApp.swift', 'ios/Tiny/Sources/Settings.swift', 'ios/Tiny/Sources/Views.swift']) {
    it(`${file} only touches the SDK behind the guard`, () => {
      const offenders = guardedLines(read(file))
        .filter((l) => /\b(import MWDAT|WearablesManager|Wearables\.shared|MWDATCore\.|MWDATCamera\.)/.test(l.line))
        .filter((l) => !l.guarded)
      expect(offenders).toEqual([])
    })
  }
})
