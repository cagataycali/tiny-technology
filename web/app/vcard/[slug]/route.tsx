import removeMd from 'remove-markdown';

export const runtime = 'edge';

// vCard text values: escape per RFC 6350 and strip line breaks
function esc(v: string): string {
    return String(v || '')
        .replace(/\\/g, '\\\\')
        .replace(/[,;]/g, (m) => `\\${m}`)
        .replace(/\r?\n/g, '\\n');
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;

    // 10s bound: .catch already handles a worker ERROR (→ {} → 404), but a
    // worker that connects and never responds would otherwise stall the edge
    // request indefinitely (house timeout-hardening rule).
    const tiny = await fetch(`https://plugin.tiny.technology/get?name=${encodeURIComponent(slug)}`, {
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
    }).then(res => res.json()).catch(() => ({}));

    // The worker returns the not-found sentinel under `response` (get.ts), so
    // the `.message` read was the dead one (worked only via the `&& tiny.name`
    // fallback). Check both fields for correctness (see pass 138).
    const sentinel = 'tiny.technology is not exists';
    const exists = tiny.response !== sentinel && tiny.message !== sentinel && tiny.name;
    if (!exists) {
        return new Response('Not found', { status: 404 });
    }

    // Private tinys: no prompt in the NOTE (the /get response already masks
    // it, but never trust a single layer)
    const note = tiny.private
        ? 'This AI is private.'
        : removeMd(tiny.systemPrompt || '').slice(0, 400);

    const name = tiny.name;
    // Names are slugified worker-side ([a-z0-9-]), but this value reaches
    // HTTP header values and URLs below — constrain it here too rather
    // than trusting a single layer (house trust-boundary rule)
    const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, '');
    const vCard = `BEGIN:VCARD
VERSION:3.0
FN;CHARSET=UTF-8:${esc(name)}
N;CHARSET=UTF-8:;${esc(name)};;;
EMAIL;CHARSET=UTF-8;type=HOME,INTERNET:${safeName}@tiny.technology
PHOTO;VALUE=URI;TYPE=PNG:https://tiny.technology/og/${safeName}
TITLE;CHARSET=UTF-8:${esc(name)}
ORG;CHARSET=UTF-8:tiny.technology
URL;CHARSET=UTF-8:https://tiny.technology/${safeName}
NOTE;CHARSET=UTF-8:${esc(note)}
REV:${new Date().toISOString()}
END:VCARD`;

    return new Response(vCard, {
        headers: {
            'Content-Type': `text/vcard; name="${safeName}.vcf"`,
            'Content-Disposition': `inline; filename="${safeName}.vcf"`,
        },
    });
}
