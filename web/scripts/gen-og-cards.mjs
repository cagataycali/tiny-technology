#!/usr/bin/env node
/**
 * gen-og-cards — one share card per docs page, rendered from the page itself.
 *
 *   mkdocs build && node scripts/gen-og-cards.mjs [--only slug] [--check]
 *
 * A docs page is read far more often as a LINK than as a document: in a Slack
 * thread, an iMessage, a tweet, a Google result. Until this script existed all 21
 * pages shared one static `assets/og-card.png` and one `site_description`, so
 * every link previewed identically — the same picture and the same sentence for
 * "Pricing & economics" and for "Run a tiny node".
 *
 * Three things make this drift-proof, and they are the point of the design:
 *
 * 1. THE CARD IS READ OUT OF THE BUILT PAGE, not out of a table in this file.
 *    Eyebrow, title and description come from `site/**\/index.html` — the eyebrow
 *    from the same `.pagehead` the reader sees, the title from the same `<h1>`,
 *    the description from the same `<meta name="description">` Material emits
 *    from the page's front matter. Rename a heading and the card renames itself.
 *
 * 2. THE MARK IS THE MARK. `docs/assets/logo.svg` is inlined with its background
 *    plate removed, so the seven blobs, the hexagon spacing and the goo filter's
 *    fusion threshold are read from the one file that defines them. There is no
 *    second copy of the geometry here to fall out of sync.
 *
 * 3. THE TYPE IS FROM A FILE, NOT A FAMILY NAME. The fonts are vendored in
 *    scripts/og-fonts/ and loaded as base64 `@font-face` data URLs — see the
 *    NOTICE there for why resolving "Roboto" through the system instead would
 *    make every card change on a machine that happens to lack it.
 *
 * WebKit rather than an SVG rasterizer because the card needs real text layout:
 * titles are 7 to 31 characters and the description is a wrapped paragraph, and
 * hand-measuring glyph runs to place `<tspan>`s is how a card ends up with a word
 * hanging off the edge. The engine that wraps the site's prose wraps this too.
 * The title auto-shrinks (72px → 44px) until it fits three lines, so a long h1
 * gets smaller instead of clipped.
 *
 * --check re-renders to a temp dir and compares bytes with what is committed,
 * which is the assertion that the PNGs in git are the PNGs this script and this
 * content produce. Run it after editing a page's front matter.
 *
 * Emits docs/assets/og/<slug>.png where slug is the page URL with slashes turned
 * into dashes ('' → home, 'business/' → business, 'platform/memory/' →
 * platform-memory) — the same derivation overrides/main.html does in Jinja, so
 * the file a card is written to is the file the meta tag points at.
 */
import { webkit } from "playwright-core";
import sharp from "sharp";
import { globSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SITE = join(REPO, "site");
const OUT = join(REPO, "docs/assets/og");

const onlyFlag = process.argv.indexOf("--only");
const ONLY = onlyFlag > -1 ? process.argv[onlyFlag + 1] : null;
const CHECK = process.argv.includes("--check");

const W = 1200;
const H = 630;

// The site's palette, from docs/stylesheets/landing.css. Kept as a copy on
// purpose: a CSS custom property cannot be read out of a file that is never
// loaded into a document, and a card is not a page. If the brand green moves,
// both places move — hence the check below that fails if they disagree.
const PAL = {
  signal: "#00fd6f",
  void: "#040705",
  paper: "#d8e6dd",
  mute: "#4d6357",
};
{
  const css = await readFile(join(REPO, "docs/stylesheets/landing.css"), "utf8");
  for (const [name, want] of Object.entries(PAL)) {
    const got = css.match(new RegExp(`--tiny-${name}:\\s*([^;]+);`))?.[1]?.trim();
    if (got !== want) {
      console.error(`palette drift: --tiny-${name} is ${got} in landing.css, ${want} here`);
      process.exit(1);
    }
  }
}

// ── the mark ────────────────────────────────────────────────────────────────
// logo.svg opens with a full-bleed rounded rect in --tiny-void; the card already
// is that colour, and the plate would read as a box floating on the background.
// Everything else — the breathing glow, the goo filter, the seven blobs — is used
// exactly as the favicon uses it.
const logo = await readFile(join(REPO, "docs/assets/logo.svg"), "utf8");
const MARK = (() => {
  let stripped = logo.replace(/<rect\b[^>]*\/>\s*/, "");
  if (stripped === logo) {
    console.error("logo.svg no longer opens with a background <rect> — check the mark");
    process.exit(1);
  }
  // The mark is ALIVE in the file: the glow breathes on a 6s cycle, the centre
  // blob inhales, and the ring turns once a minute. A still card that keeps the
  // timeline is a still card that races it — pausing at t=0 from script still let
  // 0.3° of that 60s rotation through, which moved every blob edge by a pixel and
  // made one card in five come out with a different checksum for no visible
  // reason. A screenshot has nothing to gain from a clock, so remove it: what
  // remains is the mark at the values its own attributes declare.
  const before = stripped;
  stripped = stripped.replace(/<animate(?:Transform)?\b[^>]*\/>\s*/g, "");
  const removed = (before.match(/<animate(?:Transform)?\b/g) ?? []).length;
  if (removed !== 4 || /<animate/.test(stripped)) {
    console.error(`expected 4 SMIL elements in logo.svg, removed ${removed} — check the mark`);
    process.exit(1);
  }
  // Ids are global in a document. The card inlines the SVG, so `drop-goo` and
  // `drop-glow` would collide with nothing today, but a card that ever holds two
  // marks would silently share one filter — namespace them now.
  return stripped
    .replace(/id="drop-(goo|glow)"/g, 'id="card-drop-$1"')
    .replace(/url\(#drop-(goo|glow)\)/g, "url(#card-drop-$1)");
})();

const fontFace = async (file, family, weight) => {
  const b64 = (await readFile(join(HERE, "og-fonts", file))).toString("base64");
  return `@font-face{font-family:"${family}";font-weight:${weight};font-display:block;` +
    `src:url(data:font/ttf;base64,${b64}) format("truetype")}`;
};
const FONTS = (await Promise.all([
  fontFace("Roboto-Regular.ttf", "CardSans", 400),
  fontFace("Roboto-Bold.ttf", "CardSans", 700),
  fontFace("RobotoMono-Regular.ttf", "CardMono", 400),
])).join("");

// ── what each page says about itself ────────────────────────────────────────
const decode = (s) =>
  s.replace(/<[^>]+>/g, "")
    .replace(/&para;/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&mdash;/g, "—").replace(/&hellip;/g, "…")
    .replace(/\s+/g, " ")
    .trim();

const pages = [];
for (const file of globSync(`${SITE}/**/index.html`)) {
  const url = file.slice(SITE.length + 1, -"index.html".length); // "", "business/", …
  const slug = url.replace(/\/$/, "").replace(/\//g, "-") || "home";
  const html = await readFile(file, "utf8");
  const article = html.split("md-content__inner")[1]?.split("</article>")[0] ?? "";
  const title = decode(article.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const desc = decode(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "");
  const eyebrow = decode(html.match(/<p class="pagehead">([\s\S]*?)<\/p>/)?.[1] ?? "");
  if (!title || !desc) {
    console.error(`${url || "/"} — ${!title ? "no <h1>" : "no meta description"}; ` +
      `add \`description:\` front matter and rebuild`);
    process.exit(1);
  }
  pages.push({ slug, url, title, desc, eyebrow });
}
pages.sort((a, b) => a.slug.localeCompare(b.slug));
if (!pages.length) {
  console.error(`no built pages under ${SITE} — run \`mkdocs build\` first`);
  process.exit(1);
}

const card = (p) => `<!doctype html><meta charset="utf-8"><style>
${FONTS}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{
  display:grid;
  grid-template-columns:1fr 360px;
  align-items:center;
  gap:36px;
  padding:66px 72px;
  color:${PAL.paper};
  background:
    radial-gradient(120% 90% at 18% 30%, rgba(0,253,111,.13), transparent 62%),
    radial-gradient(90% 120% at 100% 0%, rgba(0,253,111,.07), transparent 55%),
    ${PAL.void};
  font-family:"CardSans",sans-serif;
  -webkit-font-smoothing:antialiased;
}
/* The hairline is the site's own card edge (--tiny-hair). Inset rather than
   full-bleed: link unfurlers crop a few pixels off every side, and an edge that
   sits ON the boundary is the one that comes back looking like a rendering bug. */
.frame{position:fixed;inset:22px;border:1px solid rgba(0,253,111,.16);border-radius:16px}
.copy{position:relative;display:grid;gap:22px;align-content:center;min-width:0}
.brow{
  font-family:"CardMono",monospace;font-size:21px;letter-spacing:.17em;
  text-transform:uppercase;color:${PAL.signal};white-space:nowrap;
}
.brow span{color:${PAL.mute}}
h1{
  font-weight:700;font-size:72px;line-height:1.04;letter-spacing:-.022em;
  overflow-wrap:break-word;
}
.desc{
  font-size:27px;line-height:1.42;color:rgba(216,230,221,.63);
  /* Descriptions are written to ~150 characters, which is three lines here. The
     clamp is a backstop, not the plan: a card that silently swallows the end of
     a sentence is worse than one that never got written, so --check exists. */
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;
}
.foot{
  font-family:"CardMono",monospace;font-size:20px;letter-spacing:.05em;
  color:${PAL.mute};
}
.mark{display:grid;justify-items:center;gap:18px}
.mark svg{width:300px;height:300px;filter:drop-shadow(0 0 34px rgba(0,253,111,.3))}
.mark .cap{
  font-family:"CardMono",monospace;font-size:18px;letter-spacing:.14em;
  text-transform:uppercase;color:${PAL.mute};
}
</style>
<div class="frame"></div>
<div class="copy">
  <p class="brow" data-brow>tiny.technology${p.eyebrow ? ` <span>· ${esc(p.eyebrow)}</span>` : ""}</p>
  <h1 data-title>${esc(p.title)}</h1>
  <p class="desc">${esc(p.desc)}</p>
  <p class="foot">${esc(foot(p))}</p>
</div>
<div class="mark">${MARK}<p class="cap">seven peers, no hub</p></div>
`;

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// "differs (67493 → 68681 bytes)" is a symptom with two very different causes, and
// the byte count cannot tell them apart. Reworded copy moves thousands of pixels in
// a band across the text column; the two determinism bugs this script has already
// had — a live SMIL clock, and one card in a run laid out in the fallback face —
// moved a handful of pixels inside the mark, or every glyph on the card. So when
// the bytes disagree, say WHERE and HOW MANY. Only runs on a mismatch.
async function pixelDiff(a, b) {
  const raw = async (buf) => {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    return { data, w: info.width, h: info.height, ch: info.channels };
  };
  const [x, y] = [await raw(a), await raw(b)];
  if (x.w !== y.w || x.h !== y.h) return `size changed: ${x.w}×${x.h} → ${y.w}×${y.h}`;
  let n = 0, worst = 0;
  const box = [x.w, x.h, -1, -1];   // minX, minY, maxX, maxY
  for (let i = 0, px = 0; i < x.data.length; i += x.ch, px++) {
    let d = 0;
    for (let c = 0; c < x.ch; c++) d = Math.max(d, Math.abs(x.data[i + c] - y.data[i + c]));
    if (!d) continue;
    n++;
    worst = Math.max(worst, d);
    const [cx, cy] = [px % x.w, (px / x.w) | 0];
    box[0] = Math.min(box[0], cx); box[1] = Math.min(box[1], cy);
    box[2] = Math.max(box[2], cx); box[3] = Math.max(box[3], cy);
  }
  // Equal pixels and unequal bytes is its own answer: nothing on the card moved,
  // so the difference is in the container — an embedded colour profile, a chunk
  // order, a different libpng. That is a toolchain change to go and look at, not
  // a card to regenerate.
  if (!n) return "0 px differ — identical image, so the difference is in the PNG " +
    "container (profile/metadata), not in what the card shows";
  const pct = ((n / (x.w * x.h)) * 100).toFixed(3);
  return `${n} px differ (${pct}%), worst channel delta ${worst}, ` +
    `bbox x ${box[0]}–${box[2]} y ${box[1]}–${box[3]} ` +
    `(the mark sits x 835–1059 y 193–397; the copy column is x < 800)`;
}

// The tagline is the brand line every page footer on the site ends with — except
// on the homepage, whose h1 IS that sentence. A card that says "Create your own AI
// by chatting." in 72px and then whispers the same words 260px below reads as a
// template someone forgot to fill in, so a page that already says it gets the
// other thing the site says instead.
const TAGLINE = "create your own AI by chatting";
function foot(p) {
  const bare = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return bare(p.title).includes(bare(TAGLINE)) ? "npx tiny-tech" : TAGLINE;
}

// Same reason as verify-docs-landing.mjs: playwright-core asks for the revision it
// shipped with, and this machine has an older cached build. Newest local one.
const [wk] = globSync(`${process.env.HOME}/Library/Caches/ms-playwright/webkit-*/pw_run.sh`)
  .sort((a, b) => Number(b.match(/webkit-(\d+)/)[1]) - Number(a.match(/webkit-(\d+)/)[1]));
if (!wk) {
  console.error("no webkit build found — run: npx playwright install webkit");
  process.exit(1);
}
const browser = await webkit.launch({ executablePath: wk });

const written = [];
const drift = [];
for (const p of pages) {
  if (ONLY && p.slug !== ONLY) continue;
  // A FRESH PAGE PER CARD. One page reused 21 times is ~2s faster and has cost two
  // afternoons: a card that came out in the fallback face, and a card whose bytes
  // moved for no visible reason — both of them cross-card state (the document's
  // font set, the layout the previous card left behind) in a script whose entire
  // contract is that the same page produces the same PNG. `--only home` and card 15
  // of 21 now render in the same conditions, which is the only way "matches what is
  // committed" means anything.
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(card(p), { waitUntil: "load" });
  // `document.fonts.ready` alone was not enough on the reused page: it resolves for
  // the document's current font set, and a face the new content had only just asked
  // for could still be pending. Kept even with a page per card, because a fresh
  // document also starts with no fonts at all — ask for each face by name, then let
  // two frames pass so the relayout is on screen.
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('700 72px "CardSans"'),
      document.fonts.load('400 27px "CardSans"'),
      document.fonts.load('400 21px "CardMono"'),
    ]);
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });

  // Fit the title. Three lines at 72px is 225px of the 498px content box; a
  // 4-line title would push the description into the footer, and `overflow:hidden`
  // on the body would hide the collision instead of showing it.
  const fitted = await page.evaluate(() => {
    const h1 = document.querySelector("[data-title]");
    const lh = () => parseFloat(getComputedStyle(h1).lineHeight);
    for (let size = 72; size >= 44; size -= 2) {
      h1.style.fontSize = `${size}px`;
      if (h1.scrollHeight <= lh() * 3 + 1) return size;
    }
    return 44;
  });
  // The eyebrow is one nowrap line; if a section name ever makes it wider than
  // the copy column it would silently push the mark off the card.
  const browOver = await page.evaluate(() => {
    const b = document.querySelector("[data-brow]");
    return b.scrollWidth - b.parentElement.clientWidth;
  });
  if (browOver > 0) {
    console.error(`${p.slug}: eyebrow overflows the copy column by ${browOver}px`);
    process.exit(1);
  }

  await page.waitForTimeout(60);

  const shot = await page.screenshot({ type: "png" });
  const png = await sharp(shot).png({ compressionLevel: 9, effort: 10 }).toBuffer();
  const target = join(OUT, `${p.slug}.png`);

  if (CHECK) {
    const have = await readFile(target).catch(() => null);
    if (!have) drift.push(`${p.slug}.png missing`);
    else if (!have.equals(png)) {
      // Keep the bytes. "differs" is not a diagnosis: the two ways this has
      // actually happened — a live SMIL clock, and one card in a run laid out in
      // the fallback face — are both invisible in a size and obvious in a pixel
      // diff against the committed file. Twice now the evidence was gone by the
      // time the run was read, so write it out where it can be looked at.
      const kept = join("/tmp/og-drift", `${p.slug}.png`);
      await mkdir("/tmp/og-drift", { recursive: true });
      await writeFile(kept, png);
      drift.push(`${p.slug}.png differs (${have.length} → ${png.length} bytes; fresh bytes at ${kept})` +
        `\n      ${await pixelDiff(have, png)}`);
    }
  } else {
    await mkdir(OUT, { recursive: true });
    await writeFile(target, png);
  }
  written.push(`${p.slug} — "${p.title}" ${fitted}px${p.eyebrow ? ` · ${p.eyebrow}` : ""} (${(png.length / 1024).toFixed(0)}KB)`);
  await page.close();
}
await browser.close();

// The manifest is what lets a checker that CANNOT render tell a fresh card from a
// stale one. `--check` catches stale copy by re-rendering, but it needs WebKit and
// 21 screenshots; the docs verifier just reads this file and compares it with what
// the built pages say, so editing a description without regenerating fails there
// instead of shipping a card that quotes the previous sentence.
// Written from the same objects the cards were drawn from, so it cannot describe a
// card that was never drawn — and `--only` deliberately leaves it alone rather
// than rewriting it from a single page.
if (!CHECK && !ONLY) {
  const manifest = Object.fromEntries(
    pages.map((p) => [p.slug, { title: p.title, desc: p.desc, eyebrow: p.eyebrow }]));
  await writeFile(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

for (const line of written) console.log(`  ${CHECK ? "·" : "→"} ${line}`);
if (CHECK) {
  if (drift.length) {
    console.error(`\n${drift.length} card(s) out of date — run without --check:`);
    for (const d of drift) console.error(`  ${d}`);
    process.exit(1);
  }
  console.log(`\n${written.length} cards match what is committed`);
} else {
  console.log(`\n${written.length} cards → docs/assets/og/`);
}
