import Chat from "@/components/chat/Chat"
import Onboarding from "@/components/chat/Onboarding";
import NotFound from "../not-found";
import { Metadata, Viewport } from "next";
import Profile, { getProfile, ProfileUnavailable } from "@/components/Profile";
import { advertisablePriceMicro } from "@/lib/x402/payer";
import { getTiny } from "@/lib/tiny-record";
const removeMd = require('remove-markdown');

// Chars that are legal in JSON but must be \u-escaped before embedding the
// JSON in an HTML <script> (else `</script>` breaks out → XSS): < > & and the
// two JSON-legal line separators U+2028/U+2029. Built via RegExp/fromCharCode
// so no raw separator (a JS source line terminator) appears in this file.
const HTML_UNSAFE_IN_JSON = new RegExp('[<>&' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

// 👤 /@<github_login> is a builder profile, not a tiny.
// Next.js keeps the %40 encoding in the param, so decode before checking.
function profileLogin(slug: string): string | null {
    // decodeURIComponent throws URIError on a malformed percent sequence
    // (/%, /%zz, a truncated multibyte). This runs before any try/catch, so an
    // unguarded throw here 500s the route on bot/scanner traffic instead of
    // falling through to the friendly NotFound. Fall back to the raw slug.
    let decoded: string;
    try { decoded = decodeURIComponent(slug); } catch { decoded = slug; }
    return decoded.startsWith('@') ? decoded.slice(1) : null;
}

// 🎨 Per-tiny browser chrome: the address bar / PWA titlebar tints to the
// tiny's own background (luna's is #0b0a1a purple-black), the way the native
// apps tint their whole surface — the root layout pins #000000 otherwise.
// The fetch is byte-identical to generateMetadata's, so Next's per-render
// request memoization collapses them into one worker call. Full viewport
// returned (not just themeColor) so nothing rides on cross-segment merge
// semantics — viewportFit:'cover' keeps env(safe-area-inset-*) alive.
export async function generateViewport({ params }: { params: Promise<{ slug: string }> }): Promise<Viewport> {
    const base: Viewport = {
        width: 'device-width',
        initialScale: 1,
        themeColor: '#000000',
        colorScheme: 'dark',
        viewportFit: 'cover',
    };
    const { slug } = await params;
    if (profileLogin(slug)) return base; // profiles keep the site chrome
    const result = await getTiny(slug);
    const bg = result.status === 'ok' ? (result.tiny as { theme?: { bg?: unknown } }).theme?.bg : undefined;
    if (typeof bg === 'string' && /^#[0-9a-fA-F]{6}$/.test(bg)) base.themeColor = bg;
    return base;
}

export async function generateMetadata({ params, searchParams }: { params: Promise<{ slug: string }>, searchParams: Promise<{ q?: string; share?: string }> }): Promise<Metadata> {
    const { slug } = await params;
    // Shared-conversation links (?share=<id>) unfurl as a conversation, not
    // as the tiny's homepage — the themed /og card and canonical stay the
    // tiny's own (a share view is not a separately-indexable page).
    const { share } = await searchParams;
    const sharedTitle = typeof share === 'string' && share.length > 0;

    const login = profileLogin(slug);
    if (login) {
        const result = await getProfile(login);
        if (result.status !== 'ok') return { title: 'tiny', description: 'Create your AI' };
        const profile = result.profile;
        const desc = `@${profile.login} on tiny.technology — ${profile.tinys.length} public tiny${profile.tinys.length === 1 ? '' : 's'}, ${profile.tools.length} forged tool${profile.tools.length === 1 ? '' : 's'}.`;
        return {
            title: `@${profile.login}`,
            description: desc,
            // Self-canonical: the root layout's canonical would otherwise mark
            // this indexable profile page a duplicate of the homepage.
            alternates: { canonical: `/@${profile.login}` },
            openGraph: {
                type: 'profile',
                url: `https://tiny.technology/@${profile.login}`,
                title: `@${profile.login}`,
                description: desc,
                siteName: 'tiny',
                images: profile.avatar ? [{ url: profile.avatar, width: 460, height: 460 }] : undefined,
            },
            twitter: {
                card: 'summary',
                site: '@tinyaid',
                title: `@${profile.login}`,
                description: desc,
                images: profile.avatar ? [profile.avatar] : undefined,
            },
        };
    }
    // getTiny degrades a worker hiccup to 'failed' instead of throwing inside
    // generateMetadata and 500ing the route; sentinel-field normalization
    // (response vs message, pass 138) lives in lib/tiny-record now.
    const tinyResult = await getTiny(slug);
    const tiny = tinyResult.status === 'ok' ? tinyResult.tiny : {};

    if (tinyResult.status !== 'ok') {
        return {
            title: 'tiny',
            description: 'Create your AI',
            // Unclaimed name — nothing to index (any slug resolves here)
            robots: { index: false, follow: true },
            "openGraph": {
                "type": "website",
                "url": "https://tiny.technology",
                "title": slug,
                "description": 'Tiny is a platform to create your own AI',
                "siteName": "tiny",
                // say.jpeg is 1920x1080 (verified) — the old 375x667 hint made
                // unfurlers reserve a portrait box for a landscape image →
                // letterbox/crop. Link previews ignore robots:noindex, so this
                // fallback branch still unfurls when an unclaimed name is shared.
                "images": [
                    {
                        "url": "https://tiny.technology/say.jpeg",
                        "width": 1920,
                        "height": 1080,
                        "type": "image/jpeg",
                    },
                ]
            },
            "twitter": {
                "card": "player",
                "site": "@tinyaid",
                // This branch fires when the tiny doesn't exist (!tiny.name) —
                // so tiny.name is undefined here. Mirror the OpenGraph block
                // above and use `slug`, else the card title renders the literal
                // "undefined" and the player URLs point at /undefined.
                "title": slug,
                "description": `Create your own AI`,
                "images": {
                    "url": "https://tiny.technology/say.jpeg",
                    "width": 1920,
                    "height": 1080,
                    "type": "image/jpeg",
                },
                "players": {
                    playerUrl: `https://tiny.technology/${slug}`,
                    streamUrl: `https://tiny.technology/${slug}`,
                    width: 375,
                    height: 667,
                },
                "creator": "@tinyaid"
            },
        }
    }

    if (tiny.private) {
        return {
            title: 'tiny',
            description: 'Private AI',
            // Keep private tinys out of search indexes even if the URL leaks
            robots: { index: false, follow: false },
            "openGraph": {
                "type": "website",
                "url": "https://tiny.technology",
                "title": slug,
                "description": 'This AI is private',
                "siteName": "tiny",
                // say.jpeg is 1920x1080 (verified) — see the not-exists branch;
                // the old 375x667 portrait hint letterboxed the landscape image.
                "images": [
                    {
                        "url": "https://tiny.technology/say.jpeg",
                        "width": 1920,
                        "height": 1080,
                        "type": "image/jpeg",
                    },
                ]
            },
            "twitter": {
                "card": "player",
                "site": "@tinyaid",
                "title": `${tiny.name}`,
                "description": `Create your own AI`,
                "images": {
                    "url": "https://tiny.technology/say.jpeg",
                    "width": 1920,
                    "height": 1080,
                    "type": "image/jpeg",
                },
                "players": {
                    playerUrl: `https://tiny.technology/${tiny.name}`,
                    streamUrl: `https://tiny.technology/${tiny.name}`,
                    width: 375,
                    height: 667,
                },
                "creator": "@tinyaid"
            },
        }
    }

    // One description for the page + both social cards. A public tiny with an
    // empty/whitespace systemPrompt used to yield description="" everywhere —
    // crawlers got a blank <meta description> and social cards had no body
    // text. Fall back to a generic line so the snippet/card is never empty.
    const description =
        removeMd(tiny.systemPrompt || '').slice(0, 140).trim() ||
        `${tiny.name} — an AI you can chat with on tiny.technology`
    const pageTitle = sharedTitle ? `A conversation with ${tiny.name}` : tiny.name;
    return {
        title: pageTitle,
        description,
        // Self-canonical: the root layout's canonical would otherwise mark this
        // indexable tiny page a duplicate of the homepage (sitemap priority 0.6).
        alternates: { canonical: `/${tiny.name}` },
        // 📱 Each tiny is installable as its own PWA
        manifest: `/api/manifest/${tiny.name}`,
        "openGraph": {
            "title": pageTitle,
            "description": description,
            "type": "website",
            "url": `https://tiny.technology/${tiny.name}`,
            "siteName": "tiny",
            "images": [
                {
                    // /og/[slug] renders via next/og ImageResponse — always a
                    // 1200×630 PNG (no JPEG encoder in that runtime). The old
                    // 375×667 / image/jpeg declaration mismatched the real
                    // bytes, so scrapers that trust the hints (dimension-aware
                    // croppers, type sniffers) mislaid the card.
                    "url": `https://tiny.technology/og/${tiny.name}`,
                    "width": 1200,
                    "height": 630,
                    "type": "image/png",
                }
            ]
        },
        "twitter": {
            "title": pageTitle,
            "description": description,
            "card": "player",
            "site": "@tinyaid",
            "images": {
                "url": `https://tiny.technology/og/${tiny.name}`,
                "width": 1200,
                "height": 630,
                "type": "image/png",
            },
            "players": {
                playerUrl: `https://tiny.technology/${tiny.name}`,
                streamUrl: `https://tiny.technology/${tiny.name}`,
                width: 375,
                height: 667,
            },
            "creator": "@tinyaid"
        },
    };
}

export default async function Detail({ params, searchParams }: { params: Promise<{ slug: string }>, searchParams: Promise<{ q?: string | string[] }> }) {
    const { slug } = await params;
    const resolvedSearchParams = await searchParams;
    // Next resolves a repeated key (?q=a&q=b) to a string[]; <Chat> expects a
    // single prefill string, so collapse to the first value.
    const q = Array.isArray(resolvedSearchParams.q) ? resolvedSearchParams.q[0] : resolvedSearchParams.q;

    const login = profileLogin(slug);
    if (login) {
        const result = await getProfile(login);
        // A worker outage/timeout is NOT a free handle — show a calm retry, not
        // the "unclaimed — claim this name" pitch (which would libel a real
        // builder's profile as available during a transient blip).
        if (result.status === 'failed') return <ProfileUnavailable login={login} />
        if (result.status === 'not-found') return <NotFound name={`@${login}`} />
        return <Profile profile={result.profile} />
    }

    // Fetch the record AND its x402 price in parallel. `/pay/pricing` is the
    // PUBLIC read-only pricing endpoint (payments.ts:254 — no auth), the same
    // one the ERC-8004 registration route pairs with /get (registration/[slug]:
    // 58). Price lives in a separate table, NOT on /get, so without this the
    // JSON-LD below hardcoded price:'0' — advertising a PRICED (x402-payable, up
    // to $100/msg) tiny to search engines + AI-agent crawlers as FREE. An agent
    // parsing schema.org offers to decide affordability reads $0, then hits the
    // 402 paywall — the discovery-vs-charge mismatch this arc closes everywhere
    // else (the composer price badge, the registration offer). Degrade to null
    // (treated as free below) on a blip — never 500 the page over a price read.
    const [tinyResult, pricing] = await Promise.all([
        getTiny(slug),
        fetch(`https://plugin.tiny.technology/pay/pricing?resource=${encodeURIComponent(`tiny:${slug}`)}`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(10_000),
        }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    // Tiny does not exist, or the lookup failed — show the friendly 404 rather
    // than a hard error page (an error boundary also backstops this).
    if (tinyResult.status !== 'ok') {
        return <NotFound name={slug} />
    }
    const tiny = tinyResult.tiny as { name: string } & Record<string, any>;

    // Price a public discovery surface may advertise: 0 for a private tiny (every
    // x402 door 403s it), else the real floored micro price. Shared with the OG
    // card's intent so structured data never advertises a payable-but-403 service.
    const advMicro = advertisablePriceMicro(pricing?.price_micro, !!tiny.private);

    // JSON embedded in <script> must escape the HTML-significant chars —
    // JSON.stringify does NOT neutralize `</script>`, so a systemPrompt like
    // `</script><script>…</script>` (free-form user input) would break out of
    // the ld+json element and execute on our origin (localStorage/BYOK-key
    // theft). Replace < > & and the JSON-legal line separators with their
    // \uXXXX forms — valid JSON, inert in HTML.
    const ldJson = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: tiny.name,
        applicationCategory: 'Artificial Intelligence Service',
        description: tiny.systemPrompt || '',
        url: `https://tiny.technology/${tiny.name}`,
        isPartOf: {
            "@type": "WebSite",
            "name": "tiny.technology",
            "url": "https://tiny.technology"
        },
        thumbnail: `https://tiny.technology/og/${tiny.name}`,
        // Real x402 price (micro-USDC → dollars). A priced tiny charges per
        // message over x402; advertise that honestly so a crawling agent can
        // budget for it instead of discovering the cost only at the 402. Free
        // (or a failed/absent price read) → '0', matching the prior default.
        //
        // Gate the PRICE on !private via advertisablePriceMicro(): /pay/pricing is
        // the PUBLIC unauthenticated endpoint (returns a price regardless of
        // privacy), but every x402 door 403s a private tiny — the POST/GET receiver
        // (x402/chat:253,485) and the ERC-8004 registration (registration/[slug]:
        // 101). Emitting a private tiny's price + "Pay-per-message via x402" +
        // InStock into crawlable structured data advertises a payable service every
        // payment door rejects — the discovery-vs-charge mismatch this arc closes
        // everywhere else. The OG share card already gates the SAME price read on
        // !private (og/[slug]:67); the shared helper makes a private tiny read as
        // free ('0', no x402 description) here too, so we never lure a crawler into
        // a guaranteed 403 pay. `advMicro > 0` is true only for a public priced tiny.
        offers: {
            '@type': 'Offer',
            price: (advMicro / 1_000_000).toString(),
            priceCurrency: 'USD',
            availability: 'https://schema.org/InStock',
            ...(advMicro > 0
                ? { description: 'Pay-per-message via x402 (USDC on Base)' }
                : {}),
        },
        softwareRequirements: 'Web Browser',
        author: {
            '@type': 'Organization',
            name: 'tiny.technology',
            url: 'https://tiny.technology',
        },
        keywords: (tiny.systemKnowledge || '').split(',').map((k: string) => k.trim()).filter(Boolean),
    }).replace(HTML_UNSAFE_IN_JSON, (c: string) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

    // Defense-in-depth mask: the worker already blanks systemPrompt/knowledge
    // for a private tiny fetched without owner auth (get.ts:128 — this SSR fetch
    // uses the shared tinyai:tinyai cred, so it gets the blanked shape). But this
    // render path is the ONE place that forwards those fields straight into the
    // client <Chat> props, while every sibling that reads /get (login route, og,
    // vcard, this file's own generateMetadata) re-masks locally too. Match them
    // so a future worker-side regression can't leak a private prompt through here.
    const priv = !!tiny.private;
    const systemPrompt = priv ? '' : tiny.systemPrompt;
    const systemKnowledge = priv ? '' : tiny.systemKnowledge;

    return <>
        {/* JSON-LD structured data — rendered INLINE, not via next/head
            (which is a no-op in the App Router; the previous <Head> wrapper
            silently dropped this). Google reads inline ld+json anywhere in
            the DOM. Public tinys only. */}
        {!priv && (<script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: ldJson }}
        />)}
        {/* name={tiny.name}, NOT {slug}: the worker canonicalizes on lookup
            (visiting /Weather resolves the same record as /weather and returns
            name:"weather"), but Chat's `name` prop is load-bearing — it keys
            localStorage message persistence (chat_messages_${name}), the
            sessionStorage BYOK key (${name}:key), the cross-tab TabMesh channel,
            and the {name} body of save/chat API calls. Passing the raw slug
            forks all of that per URL casing: /Weather and /weather would be the
            same AI with split history + split key stores. The home page already
            passes tiny.name for this reason; match it. (The not-exists branch
            above correctly keeps slug — tiny.name is undefined there.) */}
        <Chat tiny={tiny} priv={priv} systemPrompt={systemPrompt} name={tiny.name} systemKnowledge={systemKnowledge} query={q} metadata={""} />
        {/* 🚪 First-visit onboarding — free tier / on-device WebLLM / BYOK */}
        <Onboarding name={tiny.name} />
    </>
}