import SiteHeader from '@/components/SiteHeader'
import WearablesHandoff from './WearablesHandoff'

/**
 * /wearables — the universal-link target for the Meta Wearables Device
 * Access Toolkit integration (Meta AI glasses ↔ tiny).
 *
 * Three jobs, one URL:
 *  1. Universal link / Android App Link destination — declared in
 *     public/.well-known/apple-app-site-association and assetlinks.json,
 *     so phones with tiny installed open the APP here, not this page.
 *  2. Callback fallback — if the Meta AI app's callback lands in a browser
 *     (no app installed), WearablesHandoff forwards the params into
 *     tinyapp://wearables.
 *  3. The human-readable "connect your glasses" explainer.
 */

const TITLE = 'tiny × Meta glasses'
const DESCRIPTION =
  'Give your tiny eyes. Link your Meta AI glasses to the tiny app and your AI can see what you see, hear you hands-free, and act while you live your life.'

export const metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/wearables' },
  openGraph: {
    type: 'website',
    url: '/wearables',
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'tiny.technology',
  },
  twitter: {
    card: 'summary',
    site: '@tinyaid',
    creator: '@tinyaid',
    title: TITLE,
    description: DESCRIPTION,
  },
}

const ACCENT = 'var(--tiny-accent)'

const STEPS: { n: string; title: string; body: string }[] = [
  { n: '1', title: 'Pair your glasses', body: 'Set up your Meta AI glasses with the Meta AI app on your phone, as usual.' },
  { n: '2', title: 'Install tiny', body: 'Get the tiny app for iOS or Android — the same app your tiny already lives in.' },
  { n: '3', title: 'Link them', body: 'In tiny, open Devices → Glasses and tap Link. The Meta AI app asks for your permission and hands the connection back to tiny.' },
  { n: '4', title: 'Your tiny can see', body: 'Ask it what you are looking at, capture what matters, and let it act on the world in front of you — always visibly, never in secret.' },
]

export default function WearablesPage() {
  return (
    <>
      <SiteHeader />
      <main
        id="main"
        style={{ background: 'var(--tiny-bg)', color: '#E8FFF3', minHeight: '100vh' }}
        className="px-6 py-16 sm:px-10"
      >
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-semibold tracking-wide" style={{ color: ACCENT }}>
            tiny.technology
          </p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
            Your tiny, <span style={{ color: ACCENT }}>through your glasses.</span>
          </h1>
          <p className="mt-5 text-lg leading-relaxed" style={{ color: '#9FDFC0' }}>
            {DESCRIPTION}
          </p>

          <WearablesHandoff />

          <section className="mt-14">
            <h2 className="text-2xl font-bold" style={{ color: ACCENT }}>
              How to connect
            </h2>
            <ol className="mt-6 space-y-5">
              {STEPS.map((s) => (
                <li key={s.n} className="flex gap-4">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold"
                    style={{ background: 'rgba(var(--tiny-accent-rgb), 0.15)', color: ACCENT }}
                  >
                    {s.n}
                  </span>
                  <div>
                    <h3 className="font-semibold">{s.title}</h3>
                    <p className="mt-1 leading-relaxed" style={{ color: '#9FDFC0' }}>{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="mt-14">
            <h2 className="text-2xl font-bold" style={{ color: ACCENT }}>
              On your terms
            </h2>
            <p className="mt-4 leading-relaxed" style={{ color: '#9FDFC0' }}>
              The connection is made by Meta&rsquo;s own toolkit with your explicit
              permission, camera access is asked for like on any phone, and everything
              your tiny does with what it sees follows the same rules as the rest of
              tiny: no invisible actions, no agent code on your device, and you can
              unlink at any time from either app.
            </p>
          </section>
        </div>
      </main>
    </>
  )
}
