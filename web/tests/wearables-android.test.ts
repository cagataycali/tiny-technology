// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * 🕶️ Meta Wearables integration — the Android half.
 *
 * Same shape as wearables-ios.test.ts: the SDK is wired by declaration
 * (gradle placeholders → manifest meta-data, a GitHub-Packages repo, pinned
 * artifacts), and each declaration must agree with an artifact elsewhere —
 * meta.md (what Meta issued), the iOS MWDAT dict (the other client), and the
 * public-repo rule (no token may ever be hardcoded).
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const gradle = read('android/app/build.gradle.kts')
const settings = read('android/settings.gradle.kts')
const manifest = read('android/app/src/main/AndroidManifest.xml')
const catalog = read('android/gradle/libs.versions.toml')
const metaMd = read('meta.md')

const plistValue = (key: string) =>
  metaMd.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1]

const placeholder = (name: string) =>
  gradle.match(new RegExp(`manifestPlaceholders\\["${name}"\\] =\\s*\\n?\\s*"([^"]+)"`))?.[1]

describe('DAT creds ↔ meta.md ↔ the iOS client (one identity, three artifacts)', () => {
  it('gradle placeholders carry the issued MetaAppID + ClientToken, verbatim', () => {
    expect(placeholder('mwdat_application_id')).toBe(plistValue('MetaAppID'))
    expect(placeholder('mwdat_client_token')).toBe(plistValue('ClientToken'))
  })

  it('iOS and Android declare the SAME app to Meta', () => {
    const ios = parseYaml(read('ios/project.yml')).targets.Tiny.info.properties.MWDAT
    expect(placeholder('mwdat_application_id')).toBe(String(ios.MetaAppID))
    expect(placeholder('mwdat_client_token')).toBe(ios.ClientToken)
  })

  it('the manifest wires both placeholders into the SDK meta-data keys', () => {
    for (const [key, ph] of [
      ['com.meta.wearable.mwdat.APPLICATION_ID', 'mwdat_application_id'],
      ['com.meta.wearable.mwdat.CLIENT_TOKEN', 'mwdat_client_token'],
    ]) {
      const entry = manifest.match(new RegExp(`android:name="${key}"\\s*\\n\\s*android:value="([^"]+)"`))?.[1]
      expect(entry).toBe(`\${${ph}}`)
    }
  })
})

describe('manifest declarations the SDK needs', () => {
  it('BLUETOOTH_CONNECT is declared (the API 31+ runtime half)', () => {
    expect(manifest).toContain('android.permission.BLUETOOTH_CONNECT')
  })

  it('a host-less tinyapp filter exists for the Meta AI callback', () => {
    // The routed filters all pin android:host; the SDK returns on an
    // SDK-chosen path, so exactly the bare-scheme form must exist too.
    expect(manifest).toMatch(/<data android:scheme="tinyapp" \/>/)
  })
})

describe('the glasses tools — Android executors ↔ server mounts', () => {
  it('every tool the route mounts for tiny-android has a ChatViewModel dispatch', () => {
    const route = read('app/api/chat/route.ts')
    const vm = read('android/app/src/main/java/technology/tiny/app/chat/ChatViewModel.kt')
    const mount = route.match(/tinySession === 'tiny-android' \? \[([^\]]+)\]/)?.[1] ?? ''
    // metaTakePhotoTool → "meta_take_photo" etc. — a mounted tool with no
    // executor strands every call to the 90s timeout.
    const names = mount.split(',').map((s) => s.trim())
      .map((s) => s.replace(/Tool$/, '').replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, ''))
    expect(names.length).toBeGreaterThanOrEqual(4)
    for (const name of names) expect(vm).toContain(`"${name}"`)
  })

  it('the recorder respects the 6MB cap and uploads video/mp4', () => {
    const rec = read('android/app/src/main/java/technology/tiny/app/fleet/WearablesRecorder.kt')
    expect(rec).toMatch(/6 \* 1024 \* 1024/)
    expect(rec).toContain('.put("contentType", "video/mp4")')
  })
})

describe('the SDK dependency', () => {
  it('is pinned in the version catalog', () => {
    expect(catalog).toMatch(/^mwdat = "0\.8\.0"$/m)
    for (const artifact of ['mwdat-core', 'mwdat-camera', 'mwdat-mockdevice']) {
      expect(catalog).toContain(`name = "${artifact}", version.ref = "mwdat"`)
    }
  })

  it('core+camera ship; the mock device rides DEBUG builds only', () => {
    expect(gradle).toMatch(/^\s*implementation\(libs\.mwdat\.core\)/m)
    expect(gradle).toMatch(/^\s*implementation\(libs\.mwdat\.camera\)/m)
    expect(gradle).toMatch(/^\s*debugImplementation\(libs\.mwdat\.mockdevice\)/m)
    expect(gradle).not.toMatch(/^\s*implementation\(libs\.mwdat\.mockdevice\)/m)
  })

  it('the GitHub Packages repo is scoped to the SDK group and reads its token from the env', () => {
    expect(settings).toContain('maven.pkg.github.com/facebook/meta-wearables-dat-android')
    expect(settings).toContain('includeGroup("com.meta.wearable")')
    expect(settings).toContain('System.getenv("GITHUB_TOKEN")')
  })

  it('no token is hardcoded anywhere in the gradle wiring (public-repo rule)', () => {
    // GitHub token shapes: classic ghp_…, fine-grained github_pat_…, and the
    // older 40-hex form. This tree is destined to be ported to a public repo.
    for (const source of [settings, gradle, catalog]) {
      expect(source).not.toMatch(/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}/)
    }
  })
})
