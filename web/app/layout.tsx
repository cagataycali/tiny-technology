import './globals.css'
import { Analytics } from '@vercel/analytics/react';
import { Metadata, Viewport } from 'next';
import Script from 'next/script'
import { ThemeProvider } from "@/components/theme-provider"
import GlobalMapBackdrop from "@/components/GlobalMapBackdrop"

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#000000',
  colorScheme: 'dark',
  // env(safe-area-inset-*) returns 0 without this — .pb-safe (composer
  // clearing the iOS home indicator) depends on it
  viewportFit: 'cover',
}

export const metadata: Metadata = {
  metadataBase: new URL('https://tiny.technology'),
  "title": {
    "default": "Tiny AI - Create your own AI by chatting",
    // Tab strips full of bare names ("strands", "@user") lose their origin —
    // a short brand suffix keeps the name first but identifiable
    "template": '%s · tiny',
  },
  "description": "We're a software, together.",
  "applicationName": "tiny.technology",
  "authors": [
    {
      "name": "contact",
      "url": "https://tiny.technology/egg"
    }
  ],
  "generator": "tiny.technology",
  "keywords": [
    "tiny ai id",
    "ai creator",
    "ai creation platform",
    "ai creation tool",
    "ai creation software",
    "ai creation app",
    "ai creation service",
    "create an ai by yourself",
    "create your own ai by chatting",
    "chat to create an ai",
    "artificial general intelligence",
    "agi",
    "artificial intelligence",
    "AI",
    "AGI",
    "TinyAI",
    "Personal AI",
    "Personal Artificial Intelligence",
    "Personal Assistant",
    "AI Assistant",
    "AI Friend",
    "AI Companion",
    "AI Chatbot",
    "AI Chat Bot",
    "AI Chat",
  ],
  "referrer": "origin",
  "creator": "tiny ai team",
  "publisher": "Formaticai.com.",
  "robots": "index, follow",
  // NOTE: no global `alternates.canonical` here — a root canonical is
  // INHERITED by every child segment that doesn't set its own, which pointed
  // /universe and every /[slug] tiny page at the homepage (telling Google
  // they're duplicates of `/`, contradicting sitemap.ts which lists them as
  // indexable). Each indexable page sets its own self-canonical instead:
  // home (`/`) below, /universe, and the public-tiny + profile branches of
  // app/[slug]. metadataBase resolves the relative paths.
  "alternates": {
    "canonical": "/",
  },
  "icons": [
    {
      "rel": "icon",
      "url": "https://tiny.technology/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      // apple-touch-icon must be SQUARE — iOS stretched the 174x188
      // tiny.png into a squished home-screen tile (same bug class as the
      // manifest icons, fixed in 91ea400; this was the last non-square ref)
      "rel": "apple-touch-icon",
      "url": "https://tiny.technology/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    }
  ],
  "openGraph": {
    "type": "website",
    "url": "https://tiny.technology",
    "title": "tiny technology",
    "description": "We're a software, together.",
    "siteName": "tiny.technology",
    // Dimensions MUST match the real assets — say.jpeg is 1920x1080, tiny.mp4
    // is 1280x720 (both verified via `file`/ffprobe). The old 375x667 hints
    // made every crawler (Slack/iMessage/FB/LinkedIn) reserve a portrait box
    // for landscape media → letterboxed/cropped previews. Same bug class as
    // pass 143 (/[slug] + /og), which missed this root-layout block.
    "images": [
      {
        "url": "https://tiny.technology/say.jpeg",
        "width": 1920,
        "height": 1080,
        "type": "image/jpeg",
      },
      {
        "url": "https://tiny.technology/tiny.mp4",
        "width": 1280,
        "height": 720,
        "type": "video/mp4",
      },
    ]
  },
  "twitter": {
    "card": "player",
    "site": "@tinyaid",
    "title": "tiny technology",
    "description": "We're a software, together.",
    "images": {
      "url": "https://tiny.technology/say.jpeg",
      "width": 1920,
      "height": 1080,
      "type": "image/jpeg",
    },
    "players": {
      playerUrl: 'https://tiny.technology/tiny',
      streamUrl: 'https://tiny.technology/tiny',
      // Player card aspect must match the mp4 (1280x720) so the embed isn't
      // letterboxed in the tweet.
      width: 1280,
      height: 720,
    },
    "creator": "@tinyaid"
  },
  "appleWebApp": {
    "capable": true,
    "title": "Tiny",
    "statusBarStyle": "black-translucent"
  },
  "formatDetection": {
    "telephone": true
  },
  "abstract": "We're a software, together.",
}

export default async function RootLayout({
  children
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* 🎨 Pre-paint theme — apply a saved custom theme BEFORE first paint.
            Chat.tsx applies the theme in a post-hydration effect, so a visitor
            with a saved theme (e.g. cyberpunk magenta on blue-black) flashed
            the default green-on-black, then flipped once JS ran. This blocking
            inline script front-runs that: it reads the same `tiny-theme`
            localStorage key and mirrors lib/theme.ts applyTheme + hexToRgbTriplet
            (preset "tiny" / invalid hex → no-op, globals.css defaults win). The
            effect still re-applies idempotently and handles remote/owner themes.
            <html> carries suppressHydrationWarning, so mutating its style/attr
            here doesn't trip hydration. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var r=localStorage.getItem('tiny-theme');if(!r)return;var t=JSON.parse(r);var h=/^#[0-9a-fA-F]{6}$/;if(!t||t.preset==='tiny'||!h.test(t.accent)||!h.test(t.bg))return;var x=t.accent.replace('#',''),c=[0,2,4].map(function(i){return parseInt(x.substring(i,i+2),16)}),L=function(a,b,e){var f=function(n){var s=n/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4)};return 0.2126*f(a)+0.7152*f(b)+0.0722*f(e)};for(var i=0;i<20&&L(c[0],c[1],c[2])<0.15;i++){c[0]+=Math.round((255-c[0])*0.15);c[1]+=Math.round((255-c[1])*0.15);c[2]+=Math.round((255-c[2])*0.15)}var a='#'+c.map(function(v){return Math.min(255,v).toString(16).padStart(2,'0')}).join(''),g=c.map(function(v){return Math.min(255,v)}).join(', '),d=document.documentElement;d.style.setProperty('--tiny-accent',a);d.style.setProperty('--tiny-accent-rgb',g);d.style.setProperty('--tiny-bg',t.bg);d.setAttribute('data-tiny-theme',t.preset)}catch(e){}})();`,
          }}
        />
        <ThemeProvider
          attribute="data-theme"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {/* 🗺️ Ambient map (phase 2) — one mount for the whole app: while
              the shared pref is on, the dark map rides under EVERY page and
              map-mode makes page blacks translucent. Renders null (and never
              loads the Maps API) for everyone else. */}
          <GlobalMapBackdrop />
          <div className='overscroll-none'>
            {children}
          </div>
        </ThemeProvider>
      </body>
    </html>
  )
}
