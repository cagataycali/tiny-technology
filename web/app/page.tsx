import dynamic from 'next/dynamic'
import QRCode from 'qrcode'
import Onboarding from '@/components/chat/Onboarding'
import IosInstallBanner from '@/components/chat/IosInstallBanner'
import { getTiny } from '@/lib/tiny-record'

const Chat = dynamic(() => import('@/components/chat/Chat'), { ssr: true })

// The "get tiny on your phone" QR encodes the site itself (PWA install path —
// no App Store). Rendered server-side so the qrcode lib stays out of the client
// bundle; the accent-tinted SVG matches the banner chrome. Degrades to '' on
// any failure — the banner self-hides without a QR.
const A2HS_URL = 'https://tiny.technology/'
async function buildInstallQr(): Promise<string> {
  try {
    return await QRCode.toString(A2HS_URL, {
      // margin 2 = a wider white quiet-zone (the QR spec wants ≥2 modules of
      // silence around the code) so phone cameras lock on reliably; width is a
      // vector hint only (SVG scales cleanly to whatever the banner renders).
      type: 'svg', margin: 2, width: 256,
      color: { dark: '#0a0a0a', light: '#ffffff' },
    })
  } catch {
    return ''
  }
}

export default async function HomePage(props: { searchParams: Promise<{ q?: string | string[], ref?: string }> }) {
    const tinyName = 'tiny';
    const searchParams = await props.searchParams;
    // Next resolves a repeated key (?q=a&q=b) to a string[]; <Chat> expects a
    // single prefill string, so collapse to the first value.
    const q = Array.isArray(searchParams.q) ? searchParams.q[0] : searchParams.q;

    // Degrade, don't crash: a worker hiccup on this top-level fetch would
    // otherwise white-screen the whole landing page. getTiny() carries the
    // ok-gate + sentinel classification (lib/tiny-record); ANY non-ok result —
    // failed lookup or (theoretically) a not-exists sentinel for 'tiny' —
    // falls back to an empty record so Chat renders its default hero.
    const [tinyResult, installQr] = await Promise.all([
        getTiny(tinyName),
        buildInstallQr(),
    ])
    const record = tinyResult.status === 'ok' ? tinyResult.tiny : {}
    // Normalize the fields Chat consumes at this trust boundary — a worker
    // record with a non-string prompt degrades per-field, same spirit as the
    // whole-fetch fallback above.
    const tiny = {
        ...record,
        name: typeof record.name === 'string' && record.name ? record.name : tinyName,
        systemPrompt: typeof record.systemPrompt === 'string' ? record.systemPrompt : '',
        systemKnowledge: typeof record.systemKnowledge === 'string' ? record.systemKnowledge : '',
    }

    return (<>
        <Chat tiny={tiny} name={tiny.name} systemKnowledge={tiny.systemKnowledge} systemPrompt={tiny.systemPrompt} query={q} metadata={"."} />
        {/* 🚪 First-visit onboarding — free tier / on-device WebLLM / BYOK */}
        <Onboarding name={tiny.name} />
        {/* 📲 Install-on-phone nudge (PWA, no App Store): iOS Safari gets
            Add-to-Home-Screen steps; desktop gets a QR to open tiny on a phone.
            Fills the gap where iOS never fires beforeinstallprompt. */}
        <IosInstallBanner url={A2HS_URL} qrSvg={installQr} />
        {/* 🌌 The Tiny Universe now lives in the header drawer (UniverseDrawer)
            + the /universe page — the old in-flow footer section rendered
            behind the fixed composer (overlap bug). */}
    </>)
}
