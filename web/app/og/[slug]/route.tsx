import { ImageResponse } from 'next/og';
import removeMd from 'remove-markdown';
import { compact } from '@/lib/community';
import { advertisablePriceMicro } from '@/lib/x402/payer';

export const runtime = 'edge';

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;

    // 10s bound: .catch already turns a worker ERROR into {} → the branded
    // fallback card, but a worker that connects and never responds would
    // otherwise stall this edge render indefinitely — and the OG card is hit
    // on every social unfurl + the sitemap thumbnail, so it must not hang
    // (house timeout-hardening rule, matching the vcard sibling).
    // Fetch the record AND its x402 price in parallel. `/pay/pricing` is the
    // PUBLIC read-only pricing endpoint (payments.ts:254 — no auth), the same
    // one the [slug] page (C183) + ERC-8004 registration pair with /get. Price
    // isn't on /get, so without this the share card gave NO signal a tiny is
    // payable — the visual sibling of the JSON-LD price:'0' gap fixed in C183.
    // Degrades to null (free, no chip) on a blip — the card must never 500
    // (it's also the PWA icon + sitemap thumbnail).
    const [tiny, pricing] = await Promise.all([
        fetch(`https://plugin.tiny.technology/get?name=${encodeURIComponent(slug)}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            signal: AbortSignal.timeout(10_000),
        }).then(res => res.json()).catch(() => ({})),
        fetch(`https://plugin.tiny.technology/pay/pricing?resource=${encodeURIComponent(`tiny:${slug}`)}`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(10_000),
        }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    // The worker returns the not-found sentinel under `response` (get.ts) —
    // the `.message` read was actually the dead one (this only worked by
    // accident through the `&& tiny.name` fallback). Check both fields so it's
    // correct regardless of which the worker uses (see pass 138).
    const sentinel = 'tiny.technology is not exists';
    const exists = tiny.response !== sentinel && tiny.message !== sentinel && tiny.name;
    const name = exists ? tiny.name : 'tiny';
    // 🎨 The card wears the tiny's own accent (same /get `theme` the web
    // page and both native apps tint themselves with) — a purple tiny's
    // share card was default-green. ImageResponse can't resolve CSS vars,
    // so the hex is applied directly; strict 6-digit validation because a
    // malformed stored value must not reach the renderer. rgb split feeds
    // the rgba() gradient/glow stops.
    const accent = exists && /^#[0-9a-fA-F]{6}$/.test(tiny?.theme?.accent || '')
        ? tiny.theme.accent : '#00FF88';
    const rgb = `${parseInt(accent.slice(1, 3), 16)},${parseInt(accent.slice(3, 5), 16)},${parseInt(accent.slice(5, 7), 16)}`;
    // Truncate AFTER stripping markdown, and gate the ellipsis on the
    // stripped length — raw length included the markdown syntax, so a
    // heavily-marked prompt got a spurious "…" on untruncated text
    const stripped = removeMd(tiny.systemPrompt || '');
    const prompt = !exists
        ? 'Create your own AI by chatting — free, forever.'
        : tiny.private
            ? 'This AI is private.'
            : stripped.slice(0, 220) + (stripped.length > 220 ? '…' : '');
    const stats = exists && !tiny.private ? tiny.stats : null;
    // 💳 Payable signal: a priced PUBLIC tiny charges per message over x402.
    // Surface it as a per-msg rate so a social unfurl (or a card scrape)
    // announces the cost up front — the visual complement to the JSON-LD offer
    // (C183). Private → no chip (its price row 403s the payable URLs anyway).
    // Strip trailing zeros (a RATE, not a ledger charge) — byte-identical to the
    // composer price badge (Chat.tsx:2740): $0.01, $0.5, $2/msg.
    // Shared advertisablePriceMicro() is the SINGLE source of truth for "what
    // price a public crawlable surface may show" (private → 0, else floored) —
    // the same helper the tiny page's JSON-LD offer uses, so this card and the
    // structured data can never drift on the private-price gate. A missing tiny
    // (!exists) is treated as private → 0, preserving the prior guard exactly.
    const priceMicro = advertisablePriceMicro(pricing?.price_micro, !exists || !!tiny.private);
    const priceLabel = priceMicro > 0
        ? `💵 $${(priceMicro / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}/msg`
        : null;

    try {
    return new ImageResponse(
        (
            <div
                style={{
                    height: '100%',
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    backgroundColor: '#000',
                    backgroundImage: `radial-gradient(circle at 25% 110%, rgba(${rgb},0.25), transparent 50%)`,
                    padding: '64px',
                    fontFamily: 'sans-serif',
                }}
            >
                {/* Header: tiny url + (if priced) the per-message x402 rate chip.
                    marginLeft:auto pushes the chip to the right edge so the URL
                    keeps the lede. Only a public, priced tiny shows it. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '16px', height: '16px', borderRadius: '50%', background: accent, boxShadow: `0 0 20px rgba(${rgb},0.8)` }} />
                    <div style={{ color: accent, fontSize: '28px' }}>
                        {`tiny.technology${exists ? `/${name}` : ''}`}
                    </div>
                    {priceLabel && (
                        <div style={{
                            display: 'flex', marginLeft: 'auto', color: accent, fontSize: '26px',
                            padding: '6px 18px', borderRadius: '9999px',
                            background: `rgba(${rgb},0.12)`, border: `1px solid rgba(${rgb},0.4)`,
                        }}>
                            {priceLabel}
                        </div>
                    )}
                </div>

                {/* Body: name + prompt */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                    <div style={{ color: '#fff', fontSize: '72px', fontWeight: 700, lineHeight: 1.05 }}>
                        {name}
                    </div>
                    <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: '32px', lineHeight: 1.35, maxWidth: '1000px' }}>
                        {prompt}
                    </div>
                </div>

                {/* Footer: stats or tagline */}
                {stats ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '32px', color: 'rgba(255,255,255,0.5)', fontSize: '26px' }}>
                        <div style={{ display: 'flex' }}>{`${compact(stats.tinyMessageCount ?? 0)} messages`}</div>
                        <div style={{ display: 'flex' }}>{`${compact(stats.viewCount ?? 0)} views`}</div>
                        <div style={{ display: 'flex', marginLeft: 'auto', color: accent }}>Chat with me &gt;</div>
                    </div>
                ) : (
                    <div style={{ display: 'flex', color: accent, fontSize: '26px' }}>Create your own AI by chatting &gt;</div>
                )}
            </div>
        ),
        {
            width: 1200,
            height: 630,
        },
    );
    } catch {
        // ImageResponse can throw on an exotic glyph / unexpected shape —
        // a social card must never 500 (it's also the PWA icon + sitemap
        // thumbnail). Degrade to a minimal branded card.
        return new ImageResponse(
            (
                <div
                    style={{
                        height: '100%', width: '100%', display: 'flex',
                        alignItems: 'center', justifyContent: 'center',
                        backgroundColor: '#000', color: '#00FF88',
                        fontSize: '64px', fontFamily: 'sans-serif',
                    }}
                >
                    tiny.technology
                </div>
            ),
            { width: 1200, height: 630 },
        );
    }
}
