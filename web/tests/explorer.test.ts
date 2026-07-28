// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { explorerHref, explorerName, explorerLinkLabel, explorerOpenHint } from '@/lib/x402/explorer'

/**
 * 🔗 EXPLORER LINK PRESENTATION (lib/x402/explorer.ts).
 *
 * The last corner of report §1.2 items 6/7. Every explorer URL a client receives
 * is already deployment-correct — `explorerTxUrl` picks its host from the CAIP-2
 * network WE signed for, `explorerFor` in the withdraw route defers to
 * `tinyExplorerTxUrl`, and both omit the JSON key entirely when the chain has no
 * explorer. The LABEL is what's still wrong: five render sites across three
 * clients say "View on BaseScan" no matter where the link goes, twice of them in
 * an accessibility string.
 *
 * So these tests are about the two claims a screenshot can't check:
 *
 *  1. **The label names the place the link opens.** Not the network field (which
 *     is nullable at every site and doesn't determine the explorer anyway) — the
 *     URL's own host. A self-hosted Blockscout gets its host; Base gets the brand
 *     we actually emit; an unnameable host degrades to generic wording rather
 *     than to a guess or to nothing.
 *  2. **A non-http URL is never linkable.** The web card renders
 *     `<a href={explorer}>` straight from the JSON. That field is first-party
 *     today, so this is a latent sink rather than a live bug — but the label work
 *     has to parse the URL regardless, and refusing `javascript:` while we're
 *     already holding the parse costs nothing.
 */

const TX = '0x' + 'ab'.repeat(32)

describe('explorerHref — which URLs a client may link at all', () => {
  it('passes http and https through unchanged — the href IS the checked value', () => {
    expect(explorerHref(`https://basescan.org/tx/${TX}`)).toBe(`https://basescan.org/tx/${TX}`)
    // http, not https: a self-hosted explorer on a LAN typically has no TLS, and
    // refusing it would silently drop the proof link on the deployment this whole
    // track exists for.
    expect(explorerHref('http://127.0.0.1:4000/tx/0xabc')).toBe('http://127.0.0.1:4000/tx/0xabc')
  })

  it('refuses a script-scheme URL — the web card renders this string as an href', () => {
    expect(explorerHref('javascript:alert(1)')).toBe('')
    expect(explorerHref('data:text/html,<script>alert(1)</script>')).toBe('')
    expect(explorerHref('vbscript:msgbox(1)')).toBe('')
    // Scheme matching must not be fooled by case or leading whitespace — `new
    // URL` normalizes both, which is exactly why the check runs on the PARSED
    // protocol rather than on a prefix test of the raw string.
    expect(explorerHref('  JavaScript:alert(1)')).toBe('')
  })

  it('refuses anything that is not a parseable absolute URL', () => {
    expect(explorerHref('')).toBe('')
    expect(explorerHref('basescan.org/tx/0xabc')).toBe('') // scheme-less
    expect(explorerHref('/tx/0xabc')).toBe('') // relative
    expect(explorerHref(undefined)).toBe('')
    expect(explorerHref(null)).toBe('')
    // The field arrives from JSON, so a non-string is reachable without anyone
    // writing a bug: `{"explorer": 12345}` parses fine.
    expect(explorerHref(12345)).toBe('')
    expect(explorerHref({ url: 'https://basescan.org' })).toBe('')
  })
})

describe('explorerName — the brand we emit, else the host, else nothing', () => {
  it('names BaseScan on both Base deployments — the only brand this repo produces', () => {
    expect(explorerName(`https://basescan.org/tx/${TX}`)).toBe('BaseScan')
    // Sepolia's explorer IS BaseScan; the subdomain is the network, not a
    // different product, so the label must not read "sepolia.basescan.org".
    expect(explorerName(`https://sepolia.basescan.org/tx/${TX}`)).toBe('BaseScan')
    expect(explorerName(`https://www.basescan.org/tx/${TX}`)).toBe('BaseScan')
  })

  it('does NOT match a lookalike host that merely contains the brand', () => {
    // `basescan.org.evil.tld` and `notbasescan.org` are different sites. A
    // substring check would have called both BaseScan — the failure mode that
    // makes a wrong label actively dangerous rather than merely sloppy.
    //
    // The FULL host is shown, not a registrable-domain reduction: 'evil.tld'
    // would hide the very prefix that makes the host suspicious, and the label's
    // job is to say where the link goes.
    expect(explorerName('https://basescan.org.evil.tld/tx/0xabc')).toBe('basescan.org.evil.tld')
    expect(explorerName('https://notbasescan.org/tx/0xabc')).toBe('notbasescan.org')
    expect(explorerLinkLabel('https://basescan.org.evil.tld/tx/0xabc')).toBe('View on basescan.org.evil.tld')
  })

  it('names a self-hosted explorer by host, port included', () => {
    // The port is part of the identity: "View on 127.0.0.1" would name a
    // different service than the link opens.
    expect(explorerName('http://127.0.0.1:4000/tx/0xabc')).toBe('127.0.0.1:4000')
    expect(explorerName('https://explorer.lan/tx/0xabc')).toBe('explorer.lan')
    expect(explorerName('https://Explorer.Internal.Example/tx/0xabc')).toBe('explorer.internal.example')
  })

  it('yields nothing for an unshowable host — that is the generic case, not the no-link case', () => {
    // Punycode is the SAFE rendering of a unicode host (decoding it would print
    // a homograph of a domain the user isn't visiting), but a long one would
    // blow the caption apart, so it degrades to generic wording.
    const long = 'https://' + 'x'.repeat(60) + '.example/tx/0xabc'
    expect(explorerName(long)).toBe('')
    expect(explorerLinkLabel(long)).toBe('View transaction')
    // …while the link itself is still perfectly good. Losing the NAME must never
    // mean losing the user's on-chain proof.
    expect(explorerHref(long)).toBe(long)
  })

  it('names the HOST, never a userinfo prefix — the one spoof our own label could carry', () => {
    // `https://basescan.org@evil.tld/tx/…` goes to evil.tld. Every client parses
    // this the same way (web `URL.hostname`, Foundation `URL.host`, and
    // java.net.URI's authority after stripping everything before the last '@'),
    // and all three must name the destination, not the decoration.
    expect(explorerName('https://basescan.org@evil.tld/tx/0xabc')).toBe('evil.tld')
    expect(explorerLinkLabel('https://basescan.org@evil.tld/tx/0xabc')).toBe('View on evil.tld')
  })

  it('keeps an underscore host — illegal in DNS, routine on a LAN', () => {
    // The parse side of all three clients accepts `my_explorer.lan`; the label
    // side has to as well, or web becomes the only client that refuses to name a
    // reachable self-hosted explorer.
    expect(explorerName('http://my_explorer.lan:4000/tx/0xabc')).toBe('my_explorer.lan:4000')
  })

  it('declines to name an IPv6 literal — the three clients cannot agree on its shape', () => {
    // web's URL keeps the brackets ("[::1]"), Foundation strips them ("::1"), and
    // java.net.URI's authority keeps them with the port ("[::1]:8545"). Naming it
    // would print a different string on each client, and one of them ("::1:8545")
    // reads as neither address nor port. The LINK still works everywhere.
    expect(explorerName('http://[::1]:8545/tx/0xabc')).toBe('')
    expect(explorerLinkLabel('http://[::1]:8545/tx/0xabc')).toBe('View transaction')
    expect(explorerHref('http://[::1]:8545/tx/0xabc')).toBe('http://[::1]:8545/tx/0xabc')
  })

  it('yields nothing when there is no link', () => {
    expect(explorerName('')).toBe('')
    expect(explorerName('javascript:alert(1)')).toBe('')
  })
})

describe('explorerLinkLabel / explorerOpenHint — what the five client sites render', () => {
  it('reproduces the current Base copy exactly — this cycle changes no Base UI', () => {
    // The whole point: today's five hardcoded strings are the Base ANSWER, not
    // the question. Anything else here would be a regression dressed as a fix.
    expect(explorerLinkLabel(`https://basescan.org/tx/${TX}`)).toBe('View on BaseScan')
    expect(explorerLinkLabel(`https://sepolia.basescan.org/tx/${TX}`)).toBe('View on BaseScan')
    expect(explorerOpenHint(`https://basescan.org/tx/${TX}`)).toBe('open the transaction on BaseScan')
  })

  it('names the self-hosted explorer instead of Base', () => {
    expect(explorerLinkLabel('http://127.0.0.1:4000/tx/0xabc')).toBe('View on 127.0.0.1:4000')
    expect(explorerOpenHint('http://127.0.0.1:4000/tx/0xabc')).toBe('open the transaction on 127.0.0.1:4000')
  })

  it('falls back to wording that is true on every chain, never to the empty string', () => {
    // A caller that already decided to render a link must always get text for
    // it; an empty label would ship a tappable void.
    expect(explorerLinkLabel('')).toBe('View transaction')
    expect(explorerOpenHint('')).toBe('open the transaction in the block explorer')
    expect(explorerLinkLabel(undefined)).toBe('View transaction')
  })

  it('carries no arrow or glyph — each client adds its own', () => {
    // Web appends "→", Android prepends "↗", iOS uses an SF Symbol. Baking one
    // in would either double up or force two of the three to strip it.
    for (const url of [`https://basescan.org/tx/${TX}`, 'http://127.0.0.1:4000/tx/0xabc', '']) {
      expect(explorerLinkLabel(url)).not.toMatch(/[→↗]/)
      expect(explorerOpenHint(url)).not.toMatch(/[→↗]/)
    }
  })

  it('never says BaseScan for a link that does not go to BaseScan', () => {
    // The regression this cycle exists to prevent, stated as one assertion over
    // every non-Base shape a deployment can produce.
    for (const url of [
      'http://127.0.0.1:4000/tx/0xabc',
      'https://explorer.lan/tx/0xabc',
      'https://blockscout.internal:8080/tx/0xabc',
      '',
      undefined,
    ]) {
      expect(explorerLinkLabel(url)).not.toMatch(/basescan/i)
      expect(explorerOpenHint(url)).not.toMatch(/basescan/i)
    }
  })
})
