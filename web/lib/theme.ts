/**
 * 🎨 Tiny theme engine (careless theme-engine pattern, simplified).
 *
 * A theme is {accent, bg} applied as CSS custom properties on :root —
 * the whole UI derives from --tiny-accent / --tiny-accent-rgb / --tiny-bg
 * (see globals.css). Presets mirror careless's theme-engine palettes.
 *
 * Persistence is two-layer:
 *   - localStorage: instant, per-device, works signed-out
 *   - worker /prefs (via /api/prefs): follows the account across devices
 */

import { isAuthed } from './chat/whoami'
import { deadlineFor } from './deadlines'

export interface TinyTheme {
  preset: string
  accent: string        // hex, e.g. #00FF88
  bg: string            // hex page background
}

export const THEME_PRESETS: Record<string, { accent: string; bg: string; description: string }> = {
  tiny:      { accent: '#00FF88', bg: '#000000', description: 'The classic green-on-black' },
  cyberpunk: { accent: '#ff00ff', bg: '#0a0a1a', description: 'Neon magenta on deep blue-black' },
  ocean:     { accent: '#5da9e9', bg: '#0d1b2a', description: 'Cool blues, deep sea dark' },
  forest:    { accent: '#8fce8f', bg: '#1a2618', description: 'Soft greens, mossy dark' },
  sunset:    { accent: '#ffa07a', bg: '#1f1418', description: 'Warm peach on dusk maroon' },
  dracula:   { accent: '#bd93f9', bg: '#282a36', description: 'Purple on graphite' },
  nord:      { accent: '#88c0d0', bg: '#2e3440', description: 'Frosty cyan on arctic grey' },
  amber:     { accent: '#ffb000', bg: '#100c00', description: 'Retro terminal amber' },
}

const STORAGE_KEY = 'tiny-theme'
const HEX_RE = /^#[0-9a-fA-F]{6}$/

export function hexToRgbTriplet(hex: string): string {
  const h = hex.replace('#', '')
  return [0, 2, 4].map(i => parseInt(h.substring(i, i + 2), 16)).join(', ')
}

export function isValidHex(hex: string): boolean {
  return HEX_RE.test(hex)
}

/**
 * WCAG legibility floor for the accent color.
 *
 * The accent is used two ways that BOTH fail when it's too dark: as button
 * fill under hardcoded black glyphs (`color:'#000'` on `background: accent` —
 * the composer Send button, WalletSheet Link/Claim, ~25 sites) and as *text*
 * on the near-black page bg (price badge, links). set_theme accepts any
 * 6-hex accent, so an owner/model can set e.g. `#050505`, which drops both to
 * ~1:1 contrast (invisible) — WCAG 1.4.3 / 1.4.11 failures.
 *
 * Lift a too-dark accent toward white in bounded fixed steps until its
 * relative luminance clears a floor that keeps black-on-accent AND
 * accent-on-black legible (≈4:1). Every preset is well above the floor
 * (dimmest is cyberpunk magenta at L≈0.285), so this only ever touches
 * pathological inputs. Kept in lock-step with the inline pre-paint script in
 * app/layout.tsx so server and client resolve the same accent (no flash).
 */
const ACCENT_MIN_LUM = 0.15

function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function ensureLegibleAccent(hex: string): string {
  if (!isValidHex(hex)) return hex
  const h = hex.replace('#', '')
  const c = [0, 2, 4].map(i => parseInt(h.substring(i, i + 2), 16))
  if (relativeLuminance(c[0], c[1], c[2]) >= ACCENT_MIN_LUM) return hex
  // Blend toward white; white is a safe cap (black-on-white and white-on-black
  // both pass). Bounded loop — deterministic, mirrored in the SSR bootstrap.
  for (let i = 0; i < 20 && relativeLuminance(c[0], c[1], c[2]) < ACCENT_MIN_LUM; i++) {
    c[0] += Math.round((255 - c[0]) * 0.15)
    c[1] += Math.round((255 - c[1]) * 0.15)
    c[2] += Math.round((255 - c[2]) * 0.15)
  }
  return '#' + c.map(v => Math.min(255, v).toString(16).padStart(2, '0')).join('')
}

/** Normalize any input (preset name and/or hex overrides) into a theme. */
export function resolveTheme(input: { preset?: string; accent?: string; background?: string }): TinyTheme | null {
  const presetName = (input.preset || '').toLowerCase().trim()
  const base = THEME_PRESETS[presetName]
  if (!base && !input.accent && !input.background) return null
  const accent = input.accent && isValidHex(input.accent) ? input.accent : (base?.accent || THEME_PRESETS.tiny.accent)
  const bg = input.background && isValidHex(input.background) ? input.background : (base?.bg || THEME_PRESETS.tiny.bg)
  return { preset: base ? presetName : 'custom', accent, bg }
}

/** Apply to the live document. No-op on the server. */
export function applyTheme(theme: TinyTheme | null): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (!theme || theme.preset === 'tiny') {
    // Default: clear overrides so globals.css defaults win
    root.style.removeProperty('--tiny-accent')
    root.style.removeProperty('--tiny-accent-rgb')
    root.style.removeProperty('--tiny-bg')
    root.removeAttribute('data-tiny-theme')
    return
  }
  const accent = ensureLegibleAccent(theme.accent)
  root.style.setProperty('--tiny-accent', accent)
  root.style.setProperty('--tiny-accent-rgb', hexToRgbTriplet(accent))
  root.style.setProperty('--tiny-bg', theme.bg)
  root.setAttribute('data-tiny-theme', theme.preset)
}

export function saveThemeLocal(theme: TinyTheme | null): void {
  try {
    if (!theme || theme.preset === 'tiny') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(theme))
  } catch { }
}

export function loadThemeLocal(): TinyTheme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const t = JSON.parse(raw)
    if (t && isValidHex(t.accent) && isValidHex(t.bg)) return t
  } catch { }
  return null
}

/** Push to the account (fire-and-forget; signed-out silently no-ops). */
export function saveThemeRemote(theme: TinyTheme | null): void {
  try {
    fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'theme', value: theme && theme.preset !== 'tiny' ? JSON.stringify(theme) : '' }),
      signal: AbortSignal.timeout(deadlineFor('/api/prefs')),
    }).catch(() => { })
  } catch { }
}

/** Pull the account theme; null if signed out / none set. */
export async function loadThemeRemote(): Promise<TinyTheme | null> {
  try {
    // Signed out there is no account theme — skip the guaranteed 401
    // (c12: anon visits fired 7 auth'd endpoints; localStorage already
    // covers the anonymous fallback).
    if (!(await isAuthed())) return null
    const res = await fetch('/api/prefs?key=theme', { signal: AbortSignal.timeout(deadlineFor('/api/prefs')) })
    if (!res.ok) return null
    const data = await res.json()
    if (!data?.value) return null
    const t = JSON.parse(data.value)
    if (t && isValidHex(t.accent) && isValidHex(t.bg)) return t
  } catch { }
  return null
}

// ── 🖌️ Custom page CSS + JS (customize_page tool) ─────────────────────────
//
// CSS: injected as a <style> tag — same trust level as the theme vars.
// JS:  runs with full page access (like render_ui already does live), BUT
//      persisted JS re-runs on every page load, so applying a *stored*
//      script requires a one-time per-content user approval. The approval
//      is remembered as a hash in localStorage; any changed script asks
//      again. A tiny can never silently plant startup code.

const CUSTOM_CSS_STYLE_ID = 'tiny-custom-css'
const CUSTOM_CSS_KEY = 'tiny-custom-css'
const CUSTOM_JS_KEY = 'tiny-custom-js'
const JS_APPROVED_KEY = 'tiny-custom-js-approved' // stores approved content hash

export const CUSTOM_CSS_MAX = 8_192
export const CUSTOM_JS_MAX = 8_192

export function applyCustomCss(css: string | null): void {
  if (typeof document === 'undefined') return
  document.getElementById(CUSTOM_CSS_STYLE_ID)?.remove()
  if (!css) return
  const style = document.createElement('style')
  style.id = CUSTOM_CSS_STYLE_ID
  style.textContent = css.slice(0, CUSTOM_CSS_MAX)
  document.head.appendChild(style)
}

export function saveCustomCssLocal(css: string | null): void {
  try {
    if (css) localStorage.setItem(CUSTOM_CSS_KEY, css.slice(0, CUSTOM_CSS_MAX))
    else localStorage.removeItem(CUSTOM_CSS_KEY)
  } catch { }
}

export function loadCustomCssLocal(): string | null {
  try { return localStorage.getItem(CUSTOM_CSS_KEY) } catch { return null }
}

/**
 * Content fingerprint for the startup-JS approval gate. MUST be
 * collision-resistant: this is a security check (approving script A must never
 * authorize a different script B), so a 32-bit non-crypto hash like djb2 was
 * trivially collidable — an attacker could push a malicious script engineered
 * to match an already-approved fingerprint and have it auto-run. SHA-256 via
 * SubtleCrypto (available on edge + browser).
 */
async function hashContent(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Execute custom JS in the page. Errors surface to the caller. */
export function runCustomJs(js: string): { ok: boolean; error?: string } {
  if (typeof document === 'undefined') return { ok: false, error: 'no document' }
  try {
    new Function(js.slice(0, CUSTOM_JS_MAX))()
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

export function saveCustomJsLocal(js: string | null): void {
  try {
    if (js) localStorage.setItem(CUSTOM_JS_KEY, js.slice(0, CUSTOM_JS_MAX))
    else {
      localStorage.removeItem(CUSTOM_JS_KEY)
      localStorage.removeItem(JS_APPROVED_KEY)
    }
  } catch { }
}

export function loadCustomJsLocal(): string | null {
  try { return localStorage.getItem(CUSTOM_JS_KEY) } catch { return null }
}

export async function isCustomJsApproved(js: string): Promise<boolean> {
  try { return localStorage.getItem(JS_APPROVED_KEY) === (await hashContent(js)) } catch { return false }
}

export async function approveCustomJs(js: string): Promise<void> {
  try { localStorage.setItem(JS_APPROVED_KEY, await hashContent(js)) } catch { }
}

/** Push custom css/js to the account (empty string clears). */
export function saveCustomizationRemote(key: 'custom_css' | 'custom_js', value: string | null): void {
  try {
    fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: value || '' }),
      signal: AbortSignal.timeout(deadlineFor('/api/prefs')),
    }).catch(() => { })
  } catch { }
}

export async function loadCustomizationRemote(key: 'custom_css' | 'custom_js'): Promise<string | null> {
  try {
    // Same gate as loadThemeRemote — customizations are account state.
    if (!(await isAuthed())) return null
    const res = await fetch(`/api/prefs?key=${key}`, { signal: AbortSignal.timeout(deadlineFor('/api/prefs')) })
    if (!res.ok) return null
    const data = await res.json()
    return data?.value || null
  } catch { return null }
}
