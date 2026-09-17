/**
 * 🫧 verify-docs-landing — prove the docs landing works in WebKit, not just in mkdocs.
 *
 *   mkdocs build && node scripts/verify-docs-landing.mjs [--shots /tmp/dir]
 *
 * WebKit on purpose: the interactive mark (docs/js/tiny-drop.js) exists to be
 * alive on iOS Safari, and iOS Safari is this engine. A Chromium pass would
 * prove almost nothing about the two behaviours that actually matter there —
 * the permission gate, and whether the mark moves before permission exists.
 *
 * The checks are written so that each one FAILS LOUDLY for a different reason:
 *   · injected      — the SVG and its seven blobs exist at all
 *   · alive          — the blobs move with no sensor, no hover, no tap
 *                      (this is the iOS case: most visitors never grant motion)
 *   · scrollable     — the hero did not steal touch scrolling from the page
 *   · gated          — with iOS's `requestPermission` present, the offer appears
 *   · granted        — after the tap, a deviceorientation event pours the drop
 *   · reduced        — prefers-reduced-motion draws once and says so
 *   · logo animated  — the header mark's SMIL is intact inside <img>
 *
 * Serves ./site over http rather than file:// because file:// gives WebKit an
 * opaque origin, and half the page's behaviour (fetch of search index, module
 * scoping) is then not the behaviour a reader gets.
 */
import { webkit } from "playwright-core";
import { createServer } from "node:http";
import { globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("../site/", import.meta.url).pathname;
const shotsFlag = process.argv.indexOf("--shots");
const SHOTS = shotsFlag > -1 ? process.argv[shotsFlag + 1] : null;

const TYPES = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
  ".woff2": "font/woff2", ".ico": "image/x-icon", ".webp": "image/webp",
  // Without a video type WebKit refuses the file and the gallery screenshots
  // show four broken-media glyphs — a harness artifact that reads as a bug.
  ".mp4": "video/mp4", ".webm": "video/webm",
  // The pendant on platform/devices.md. model-viewer fetches the GLB itself and
  // does not care, but AR Quick Look takes the USDZ from the response type — so
  // serving it as octet-stream here would test a path no iPhone follows.
  ".glb": "model/gltf-binary", ".usdz": "model/vnd.usdz+zip", ".txt": "text/plain",
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    // GitHub Pages publishes this site under /tinyai-id/, and one page's URLs are
    // root-absolute for a real reason: Pages serves 404.html for a path of ANY
    // depth, so its links cannot be relative (see overrides/404.html). Answer that
    // prefix here too, or the only page whose markup is absolute is the one page
    // this harness cannot load.
    p = p.replace(/^\/tinyai-id\//, "/");
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("nope");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  ok" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/* Click a control WITHOUT letting a dead one kill the run.
 *
 * The viewer's bar is disabled until <model-viewer> upgrades, so any bug that
 * leaves it disabled — or any mutation that removes setControls(true) — makes
 * page.click() spend 30s on "element is not enabled" and then throw an unhandled
 * TimeoutError. That aborts the process before a single verdict is printed, so
 * the checker reports NOTHING rather than a failure: to anything reading the
 * output, the check ceases to exist instead of going red. Found by the positive
 * control for "the bar comes alive once the module upgrades", which came back as
 * CHECK MISSING FROM OUTPUT rather than as a catch.
 *
 * Short timeout because the honest answer here is fast: by the time these run the
 * model has already loaded, so a control that is not pressable in 4s is not going
 * to become pressable. Returns whether the press landed; the checks downstream
 * read the DOM and go red on their own terms, which is a better message than a
 * stack trace. */
const press = async (page, selector, timeout = 4000) => {
  try {
    await page.click(selector, { timeout });
    return true;
  } catch {
    return false;
  }
};

// playwright-core asks for the webkit revision it shipped with; this machine has
// an older cached build. Point at whatever is actually here rather than making a
// verification script depend on a 90MB download — pinning to the newest local one
// so it keeps working after `npx playwright install webkit`.
const [wk] = globSync(`${process.env.HOME}/Library/Caches/ms-playwright/webkit-*/pw_run.sh`)
  .sort((a, b) => Number(b.match(/webkit-(\d+)/)[1]) - Number(a.match(/webkit-(\d+)/)[1]));
if (!wk) {
  console.error("no webkit build found — run: npx playwright install webkit");
  process.exit(1);
}
const browser = await webkit.launch({ executablePath: wk });

// ── 1. a phone-sized visit with no permission and no input ──────────────────
{
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForSelector(".drop__svg", { timeout: 5000 }).catch(() => {});

  const blobs = await page.$$eval(".drop__svg ellipse", (els) => els.length);
  check("injected: seven blobs", blobs === 7, `${blobs} ellipse(s)`);

  const filterOk = await page.evaluate(() => {
    const g = document.querySelector(".drop__svg [data-drop-blobs]");
    const id = (g?.getAttribute("filter") || "").replace(/^url\(#|\)$/g, "");
    return !!id && !!document.getElementById(id);
  });
  check("injected: goo filter resolves", filterOk);

  const sample = () =>
    page.$$eval(".drop__svg ellipse", (els) =>
      els.map((e) => e.getAttribute("transform") || ""));
  const before = await sample();
  await page.waitForTimeout(1400);
  const after = await sample();
  const moved = before.filter((t, i) => t !== after[i]).length;
  check("alive: moves with no sensor and no touch", moved >= 5, `${moved}/7 blobs moved`);

  const scroll = await page.evaluate(async () => {
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight > innerHeight + 100;
    window.scrollTo(0, 400);
    await new Promise((r) => requestAnimationFrame(r));
    return { scrollable, y: window.scrollY, touch: getComputedStyle(document.body).touchAction };
  });
  check("scrollable: page still scrolls past the hero",
    scroll.scrollable && scroll.y > 300 && scroll.touch !== "none",
    `y=${scroll.y}, body touch-action=${scroll.touch}`);

  const tapWorks = await page.evaluate(async () => {
    const el = document.querySelector(".drop__svg ellipse");
    const t0 = el.getAttribute("transform");
    document.querySelector("[data-drop-stage]")
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return t0 !== el.getAttribute("transform");
  });
  check("tap: a pointerdown splashes it", tapWorks);

  if (SHOTS) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, "landing-iphone-top.png") });
    await page.setViewportSize({ width: 390, height: 3000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, "landing-iphone-long.png"), fullPage: true });
  }
  await page.close();
}

// ── 2. the iOS permission gate, faked exactly as Safari 13+ presents it ─────
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await page.addInitScript(() => {
    // Safari exposes requestPermission as a static on the constructor. WebKit on
    // a Mac does not, so the gated branch is unreachable here without this.
    window.__perm = "granted";
    const stub = (C) => { C.requestPermission = () => Promise.resolve(window.__perm); };
    if (!window.DeviceMotionEvent) window.DeviceMotionEvent = class {};
    if (!window.DeviceOrientationEvent) window.DeviceOrientationEvent = class {};
    stub(window.DeviceMotionEvent);
    stub(window.DeviceOrientationEvent);
  });
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForSelector(".drop__svg");

  const offer = await page.evaluate(() => ({
    visible: !document.querySelector("[data-drop-enable]").hidden,
    status: document.querySelector("[data-drop-status]").textContent,
  }));
  check("gated: the tilt offer is shown, not an error",
    offer.visible && /tap/i.test(offer.status), `status="${offer.status}"`);

  await page.click("[data-drop-enable]");
  const poured = await page.evaluate(async () => {
    const ev = new Event("deviceorientation");
    Object.assign(ev, { alpha: 0, beta: 45, gamma: 20 });
    window.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 400));
    const host = document.querySelector("[data-tiny-drop]");
    return {
      input: host.dataset.dropInput,
      status: document.querySelector("[data-drop-status]").textContent,
      hidden: document.querySelector("[data-drop-enable]").hidden,
    };
  });
  check("granted: gravity takes over after the tap",
    poured.input === "gravity" && /gravity/i.test(poured.status) && poured.hidden,
    `input=${poured.input}, status="${poured.status}"`);
  await page.close();
}

// ── 3. denied is a sentence, not a dead mark ────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await page.addInitScript(() => {
    if (!window.DeviceMotionEvent) window.DeviceMotionEvent = class {};
    if (!window.DeviceOrientationEvent) window.DeviceOrientationEvent = class {};
    window.DeviceMotionEvent.requestPermission = () => Promise.resolve("denied");
    window.DeviceOrientationEvent.requestPermission = () => Promise.resolve("denied");
  });
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForSelector(".drop__svg");
  await page.click("[data-drop-enable]");
  await page.waitForTimeout(200);
  const s = await page.textContent("[data-drop-status]");
  const stillMoving = await page.evaluate(async () => {
    const el = document.querySelector(".drop__svg ellipse");
    const t0 = el.getAttribute("transform");
    await new Promise((r) => setTimeout(r, 700));
    return t0 !== el.getAttribute("transform");
  });
  check("denied: says what happened and keeps drifting",
    /drag|sensor/i.test(s) && stillMoving, `status="${s}", moving=${stillMoving}`);
  await page.close();
}

// ── 4. reduced motion ───────────────────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForSelector(".drop__svg");
  const r = await page.evaluate(async () => {
    const el = document.querySelector(".drop__svg ellipse");
    const t0 = el.getAttribute("transform");
    await new Promise((res) => setTimeout(res, 700));
    return {
      still: t0 === el.getAttribute("transform"),
      drawn: !!t0,
      status: document.querySelector("[data-drop-status]").textContent,
    };
  });
  check("reduced: drawn once, held still, and explained",
    r.still && r.drawn && /reduced/i.test(r.status), `status="${r.status}"`);
  await page.close();
}

// ── 5. the header mark, and the desktop view ────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/`, { waitUntil: "load" });
  const logo = await page.evaluate(async () => {
    const img = document.querySelector(".md-logo img, .md-logo svg");
    if (!img) return { ok: false };
    const src = img.getAttribute("src");
    const svg = src ? await fetch(src).then((r) => r.text()) : img.outerHTML;
    return {
      ok: true,
      tag: img.tagName,
      smil: (svg.match(/<animate/g) || []).length,
      goo: /feColorMatrix/.test(svg),
    };
  });
  check("logo: SMIL animation survives inside <img>",
    logo.ok && logo.smil >= 3 && logo.goo,
    `${logo.tag}, ${logo.smil} <animate>, goo=${logo.goo}`);

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("layout: no horizontal overflow (desktop)", overflow <= 1, `${overflow}px`);

  if (SHOTS) {
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(SHOTS, "landing-desktop-top.png") });
    await page.screenshot({ path: join(SHOTS, "landing-desktop-full.png"), fullPage: true });
  }

  // The section eyebrow comes from the nav (overrides/main.html), so it is worth
  // one assertion: a nested page has it, a top-level page has none, and the
  // homepage — whose h1 is the hero — must not grow a second label.
  const eyebrows = {};
  for (const [key, url] of Object.entries({
    nested: "/platform/memory/",
    topLevel: "/faq/",
  })) {
    await page.goto(base + url, { waitUntil: "load" });
    eyebrows[key] = await page.evaluate(() =>
      document.querySelector(".pagehead")?.textContent.trim() ?? null);
    if (SHOTS) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOTS, `page-${key}.png`) });
    }
  }
  check("eyebrow: section label comes from the nav",
    eyebrows.nested === "Platform" && eyebrows.topLevel === null,
    `nested=${JSON.stringify(eyebrows.nested)}, top-level=${JSON.stringify(eyebrows.topLevel)}`);

  if (SHOTS) {
    await page.goto(`${base}/developers/enroll-a-device/`, { waitUntil: "load" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, "page-desktop.png") });
    // Light mode has to be CLICKED, not emulated: the palettes in mkdocs.yml
    // carry no `media:` key, so slate is simply first and prefers-color-scheme
    // never enters into it.
    await page.goto(`${base}/getting-started/quickstart/`, { waitUntil: "load" });
    await page.click('label[for="__palette_1"]').catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOTS, "page-light.png") });
    // The palette choice is stored, so this second page loads light: cards,
    // chips, doors and .plain all pick their colours from Material's variables
    // and are worth seeing on white at least once.
    await page.goto(`${base}/business/trust/`, { waitUntil: "load" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, "page-light-cards.png"), fullPage: true });
  }
  await page.close();
}

// ── 6. a narrow phone must not overflow either ──────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true });
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("layout: no horizontal overflow (320px)", overflow <= 1, `${overflow}px`);
  await page.close();
}

// ── 7. no page anywhere ships its own markup as text ────────────────────────
// The md_in_html trap is silent and total: put `markdown="1"` on an inner element
// instead of the block's root, or indent the nested content, and the whole card
// grid renders as literal `<div class="card">` for the reader while the build
// still says "documentation built in 0.26 seconds". It cost the landing hero
// once. This is a static check — cheap enough to run over every page, so a new
// page cannot reintroduce it unnoticed.
{
  const pages = globSync(`${ROOT}**/*.html`).filter((p) => !p.includes("/assets/"));
  const leaks = [];
  for (const file of pages) {
    const html = await readFile(file, "utf8");
    const article = html.split("md-content__inner")[1]?.split("</article>")[0] ?? "";
    // A code sample may legitimately *show* HTML, and an authoring note about
    // this very trap survives into the page as an HTML comment. Only prose counts.
    const prose = article
      .replace(/<code[\s\S]*?<\/code>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    const hits = [
      ...prose.match(/&lt;\/?(?:div|ul|li|p|section)\b/g) ?? [],
      ...prose.match(/markdown=(?:"1"|&quot;1&quot;)/g) ?? [],
    ];
    if (hits.length) leaks.push(`${file.slice(ROOT.length)} (${hits.slice(0, 3).join(" ")})`);
  }
  check("pages: no page ships its own markup as text",
    leaks.length === 0, `${pages.length} pages scanned${leaks.length ? ` — ${leaks.join(", ")}` : ""}`);
}

// ── 7b. the grids are actually grids at desktop width ───────────────────────
// A too-large `minmax()` minimum does not warn, wrap or overflow — auto-fit just
// returns one track and the layout reads as "unstyled but fine". It cost the
// gallery two silent revisions (22rem, then 18rem) because Material sets the
// root font to 125%, so a rem is 20px and 18rem needs 736px of a 688px column.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const tracks = {};
  for (const [key, url, sel] of [
    ["tiles", "/gallery/", ".tiles"],
    ["cards", "/business/", ".cards"],
    ["doors", "/platform/memory/", ".doors"],
  ]) {
    await page.goto(base + url, { waitUntil: "load" });
    tracks[key] = await page.evaluate((s) =>
      getComputedStyle(document.querySelector(s)).gridTemplateColumns.split(" ").length, sel);
  }
  check("layout: the grids have more than one column at 1280",
    Object.values(tracks).every((n) => n >= 2), JSON.stringify(tracks));
  await page.close();
}

// ── 8. every asset a page points at is actually there ───────────────────────
// mkdocs --strict validates markdown links; it says nothing about `src=` inside
// a raw HTML block, and the gallery is 20 hand-written src/href pairs. A typo
// there ships a broken plate that no build step and no link checker notices.
{
  const pages = globSync(`${ROOT}**/*.html`).filter((p) => !p.includes("/assets/"));
  const missing = new Set();
  let refs = 0;
  for (const file of pages) {
    const html = await readFile(file, "utf8");
    const dir = file.slice(0, file.lastIndexOf("/") + 1);
    for (const [, attr] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^(?:https?:|mailto:|data:|#|\/\/)/.test(attr)) continue;
      if (!/\.(?:svg|png|jpe?g|webp|mp4|webm|ico|css|js|woff2?)$/i.test(attr)) continue;
      refs++;
      const target = attr.startsWith("/")
        ? join(ROOT, attr.replace(/^\/tinyai-id\//, ""))
        : normalize(dir + attr.split("?")[0]);
      try { await readFile(target); } catch {
        missing.add(`${file.slice(ROOT.length)} → ${attr}`);
      }
    }
  }
  check("assets: every local src/href resolves",
    missing.size === 0, `${refs} refs${missing.size ? ` — ${[...missing].slice(0, 4).join(", ")}` : ""}`);
}

// ── 8b. every in-page #anchor points at an id that exists ───────────────────
// The jump indexes (the FAQ's and what-to-build's chip rows, the roadmap's three
// phases) are hand-typed hrefs against ids Python-Markdown generates from the
// heading text — so `&` becomes nothing, `·` becomes nothing, and an em dash
// becomes a hyphen. `--strict` checks markdown links between *files* and says
// nothing about a fragment, so a renamed heading silently turns a chip into a
// no-op click that scrolls nowhere.
{
  const pages = globSync(`${ROOT}**/*.html`).filter((p) => !p.includes("/assets/"));
  const broken = [];
  let anchors = 0;
  for (const file of pages) {
    const html = await readFile(file, "utf8");
    const article = html.split("md-content__inner")[1]?.split("</article>")[0] ?? "";
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const [, frag] of article.matchAll(/href="#([^"]+)"/g)) {
      anchors++;
      if (!ids.has(decodeURIComponent(frag))) broken.push(`${file.slice(ROOT.length)} → #${frag}`);
    }
  }
  check("anchors: every in-page jump link resolves",
    broken.length === 0, `${anchors} anchors${broken.length ? ` — ${broken.slice(0, 4).join(", ")}` : ""}`);
}

// ── 8c. no content page overflows a phone ───────────────────────────────────
// The landing was already checked at 320px, but the content pages carry things
// the landing doesn't: five-column comparison tables, a `.wire` holding a long
// typed sentence, and `.cards`/`.plain` grids whose minimum track is wider than
// the viewport. A single overflowing row makes the whole document pan sideways.
{
  const page = await browser.newPage({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true });
  const wide = [];
  const PHONE = ["/business/", "/business/comparison/", "/business/pricing/", "/business/trust/",
                 "/business/enterprise/", "/business/integrate/", "/business/roadmap/",
                 "/getting-started/quickstart/", "/getting-started/what-to-build/",
                 "/platform/memory/", "/developers/enroll-a-device/", "/gallery/", "/faq/"];
  for (const url of PHONE) {
    await page.goto(base + url, { waitUntil: "load" });
    const over = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 1) wide.push(`${url} +${over}px`);
  }
  check("layout: no content page overflows 320px",
    wide.length === 0, `${PHONE.length} pages${wide.length ? ` — ${wide.join(", ")}` : ""}`);
  if (SHOTS) {
    await page.goto(`${base}/business/trust/`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, "p-trust-phone.png"), fullPage: true });
  }
  await page.close();
}

// ── 8d. the page AS A LINK: its own card, its own sentence ──────────────────
// Nothing else here reads the <head>. A docs page is shared more often than it is
// browsed, and every failure in an unfurl is invisible from the page itself: a
// renamed page points og:image at a card nobody generated, a card regenerated at
// the wrong size contradicts the og:image:width it ships beside, and a page with
// no `description:` front matter silently falls back to the site's one-liner —
// which is how 21 pages came to preview identically in the first place.
{
  const mk = await readFile(new URL("../mkdocs.yml", import.meta.url), "utf8");
  const siteUrl = mk.match(/^site_url:\s*(\S+)/m)[1];
  const siteDesc = mk.match(/^site_description:\s*"([^"]+)"/m)[1];
  const pages = globSync(`${ROOT}**/*.html`)
    .filter((p) => !p.includes("/assets/") && !p.endsWith("404.html"));

  const badImage = [];
  const descs = new Map();
  for (const file of pages) {
    const html = await readFile(file, "utf8");
    const name = file.slice(ROOT.length);
    const meta = (prop, attr = "property") =>
      html.match(new RegExp(`<meta ${attr}="${prop}" content="([^"]*)"`))?.[1] ?? null;

    for (const prop of [["og:image"], ["twitter:image", "name"]]) {
      const url = meta(prop[0], prop[1]);
      if (!url?.startsWith(siteUrl)) { badImage.push(`${name} → ${prop[0]}=${url}`); continue; }
      const png = await readFile(join(ROOT, url.slice(siteUrl.length))).catch(() => null);
      if (!png) { badImage.push(`${name} → ${prop[0]} 404 ${url.slice(siteUrl.length)}`); continue; }
      // The dimensions are asserted in the markup, so read them from the IHDR
      // rather than trusting the two <meta> lines that claim them.
      const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
      const claimed = [Number(meta("og:image:width")), Number(meta("og:image:height"))];
      if (w !== claimed[0] || h !== claimed[1])
        badImage.push(`${name} → ${prop[0]} is ${w}×${h}, markup says ${claimed.join("×")}`);
    }
    descs.set(name, meta("og:description"));
  }
  check("social: every page's card exists and is the size it claims",
    badImage.length === 0,
    `${pages.length} pages${badImage.length ? ` — ${badImage.slice(0, 4).join(", ")}` : ""}`);

  const dupes = [...descs.entries()].filter(([, d], _, all) =>
    !d || d === siteDesc || all.filter(([, o]) => o === d).length > 1);
  check("social: every page unfurls with its own sentence",
    dupes.length === 0,
    `${descs.size} descriptions${dupes.length ? ` — ${dupes.map(([n]) => n).slice(0, 4).join(", ")}` : ""}`);

  // A card is a PICTURE OF COPY, so it can go stale in a way nothing above can
  // see: reword a description, rebuild, and the page says the new sentence while
  // the PNG beside it still shows the old one — same filename, same 1200×630, same
  // everything a file check can reach. gen-og-cards.mjs records what each card was
  // drawn from; this compares that with what the page now says.
  const manifest = JSON.parse(
    await readFile(new URL("../docs/assets/og/manifest.json", import.meta.url), "utf8"));
  const stale = [];
  for (const file of pages) {
    const html = await readFile(file, "utf8");
    const name = file.slice(ROOT.length);
    const slug = name.replace(/\/?index\.html$/, "").replace(/\//g, "-") || "home";
    const entry = manifest[slug];
    if (!entry) { stale.push(`${name} → no card recorded for "${slug}"`); continue; }
    const article = html.split("md-content__inner")[1]?.split("</article>")[0] ?? "";
    const text = (s) => s.replace(/<[^>]+>/g, "").replace(/&para;/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ").replace(/&mdash;/g, "—").replace(/&hellip;/g, "…")
      .replace(/\s+/g, " ").trim();
    const live = {
      title: text(article.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? ""),
      desc: text(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? ""),
      eyebrow: text(html.match(/<p class="pagehead">([\s\S]*?)<\/p>/)?.[1] ?? ""),
    };
    for (const k of ["title", "desc", "eyebrow"]) {
      if (live[k] !== entry[k]) stale.push(`${name} ${k}: card has "${entry[k]}", page says "${live[k]}"`);
    }
  }
  check("social: every card still quotes its page",
    stale.length === 0,
    `${pages.length} cards${stale.length ? ` — ${stale.slice(0, 3).join(" | ")}` : ""}`);
}

// ── 8e. the page nobody links to on purpose ─────────────────────────────────
// Material ships 404.html as `<h1>404 - Not found</h1>` and nothing in a build
// ever renders it, so a broken override fails in total silence — for exactly the
// readers who already followed a dead link. Three ways it can be silently wrong:
// the override isn't picked up at all (the theme's default ships), the stylesheet
// or the mark never load (its URLs are root-absolute, unlike every other page's,
// because Pages serves this file at any path depth), or the way out is itself
// broken. So this asserts the copy, the CSS, the asset AND both exits.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/404.html`, { waitUntil: "load" });
  await page.waitForTimeout(300);
  const lost = await page.evaluate(() => {
    const el = document.querySelector(".lost");
    const mark = document.querySelector(".lost__mark");
    const doors = document.querySelector(".lost .doors");
    return {
      h1: document.querySelector(".md-content__inner h1")?.textContent.trim() ?? "",
      // naturalWidth is the proof the root-absolute src actually resolved; a
      // missing SVG still gives a laid-out 112×112 box with an alt string.
      mark: mark ? mark.naturalWidth : 0,
      // .lost is styled by landing.css, and .doors by the shared component block:
      // if either stylesheet failed to load, one of these is wrong.
      centred: el ? getComputedStyle(el).textAlign : null,
      tracks: doors ? getComputedStyle(doors).gridTemplateColumns.split(" ").length : 0,
      exits: [...document.querySelectorAll(".lost a[href]")].map((a) => a.getAttribute("href")),
    };
  });
  const dead = [];
  for (const href of lost.exits) {
    const res = await fetch(new URL(href, base)).catch(() => null);
    if (!res?.ok) dead.push(`${href} → ${res ? res.status : "no response"}`);
  }
  check("404: the designed page, its stylesheet, its mark and its way out",
    lost.h1 !== "" && !/^404 - Not found$/.test(lost.h1) &&
    lost.mark > 0 && lost.centred === "center" && lost.tracks === 2 &&
    lost.exits.length === 3 && dead.length === 0,
    `h1 "${lost.h1}" · mark ${lost.mark}px · ${lost.centred} · ${lost.tracks} door columns · ` +
    `${lost.exits.length} exits${dead.length ? ` — dead: ${dead.join(", ")}` : " all 200"}`);

  if (SHOTS) await page.screenshot({ path: join(SHOTS, "p-404.png"), fullPage: true });

  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForTimeout(200);
  const over = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("404: fits a 320px phone", over <= 1, `${over}px`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "p-404-phone.png"), fullPage: true });
  await page.close();
}

// ── 8f. the one page that ships a 3D model ──────────────────────────────────
// platform/devices.md carries the tiny necklace as real geometry: 271 KB of GLB
// you can spin, and 538 KB of USDZ that stands it on a desk at true 32 mm. Every
// way this breaks is quiet. The 956 KB module fails to load and <model-viewer>
// stays an unknown element whose children render as flow content — a live "View in
// your room" button over the prose and three hotspots taking 36px each, with an
// empty console. The relative src is wrong for the page's depth and you get an
// empty stage. A `<link rel="preload">` gets added back and WebKit fetches the
// model twice, doubling the page's bytes for nothing (measured: two 200s of
// 271,108 B, one xhr and one fetch, because the preload never matched
// model-viewer's own request). The camera comes in too close and the exploded
// model is cut off by an edge nothing reports. mkdocs, --strict and every other
// check in this file are blind to all of it, so it is driven here like a reader.
{
  const glbHits = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  page.on("request", (r) => { if (/\.glb(\?|$)/.test(r.url())) glbHits.push(r.url()); });
  const noise = [];
  page.on("console", (m) => {
    // "Failed to load resource: …status of NNN" carries no URL, so it cannot be
    // allowlisted by origin the way the response listener below can — and it is
    // redundant with it, since every failed request appears there WITH its URL.
    // Filtering these by status text is what made this check flake: it excused
    // `status of 404` only, and api.github.com answers 404 when the repo is private
    // but 403 once it rate-limits, so 1 run in 3 went red on a page that was fine.
    // Drop the resource echoes; keep anything that is actually a script error.
    if (m.type() === "error" && !/^Failed to load resource:/.test(m.text())) {
      noise.push(m.text());
    }
  });
  page.on("pageerror", (e) => noise.push("pageerror: " + e.message));
  // Material fetches repo stars/forks from api.github.com on every page of the
  // site. This repo is private, so unauthenticated that is a 404 — or a 403 once
  // the shared IP is rate-limited. Site-wide, nothing to do with the viewer, and
  // not something this page can fix.
  const httpFails = [];
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().startsWith("https://api.github.com/")) {
      httpFails.push(`${r.status()} ${r.url()}`);
    }
  });

  await page.goto(`${base}/platform/devices/`, { waitUntil: "load" });
  const firstPaintOrbit = await page.evaluate(() =>
    document.getElementById("pendant")?.getAttribute("camera-orbit"));
  // loading="lazy" means the model waits to be looked at, which is the point.
  await page.locator(".viewer model-viewer").scrollIntoViewIfNeeded();
  const loaded = await page
    .waitForFunction(() => document.getElementById("pendant")?.loaded, { timeout: 40000 })
    .then(() => true)
    .catch(() => false);

  const born = await page.evaluate(() => {
    const mv = document.getElementById("pendant");
    const d = mv.getDimensions ? mv.getDimensions() : null;
    return {
      defined: !!customElements.get("model-viewer"),
      dims: d ? [+(d.x * 1000).toFixed(1), +(d.y * 1000).toFixed(1), +(d.z * 1000).toFixed(1)] : null,
    };
  });
  // A pendant that arrives in metres instead of millimetres still renders
  // perfectly and still says "loaded" — it is AR that would put a 32-metre
  // necklace in the room. The GLB is exported in metres per the glTF spec, so
  // these are the caliper numbers: 31.6 wide, 35.8 tall with the crown, 12.5 deep.
  const scaleOk = born.dims &&
    Math.abs(born.dims[0] - 31.6) < 1 && Math.abs(born.dims[1] - 35.8) < 1 &&
    Math.abs(born.dims[2] - 12.5) < 1;
  check("viewer: the module upgrades and the model arrives at 32 mm",
    loaded && born.defined && scaleOk,
    `${born.defined ? "defined" : "NEVER DEFINED"} · ${loaded ? "loaded" : "NEVER LOADED"} · ` +
    `${born.dims ? born.dims.join(" × ") + " mm" : "no dimensions"}`);

  check("viewer: the model is fetched exactly once",
    glbHits.length === 1,
    `${glbHits.length} GLB request${glbHits.length === 1 ? "" : "s"}` +
    (glbHits.length > 1 ? ` — a preload or a second src is double-fetching: ${glbHits.join(", ")}` : ""));

  // Exploded: a different file, 2.6x deeper, and the camera left exactly where the
  // reader had it.
  //
  // THIS READS THE LIVE CAMERA, NOT THE ATTRIBUTE. It used to compare
  // getAttribute("camera-orbit") before and against after, which a src swap never
  // touches — so the comparison was true no matter what the page did, and its
  // positive control (deleting the restore from tiny-viewer.js) came back NOT
  // CAUGHT. getCameraOrbit() is the camera actually in use, and it diverges from
  // the attribute the moment anybody drags, which is exactly the state worth
  // protecting. The drag below puts it there first: measured, a drag moves the live
  // camera to theta -86.2deg / phi 113.7deg while the attribute still reads
  // "25deg 72deg 125mm".
  //
  // What holds it is model-viewer keeping the camera across a src change, not
  // anything in tiny-viewer.js — the "restore" line that used to sit in the swap
  // handler was measured to be a no-op and is gone. So this guards the vendored
  // runtime's behaviour and any future "fix" that reframes on toggle.
  const box = await page.locator(".viewer model-viewer").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 - 60, { steps: 24 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const swap = await page.evaluate(async () => {
    const mv = document.getElementById("pendant");
    // If the module never arrived, mv is still an unknown element: getCameraOrbit
    // is undefined and calling it rejects the evaluate, which ends the process and
    // prints no verdict for anything below. Say so and let the checks go red.
    if (typeof mv.getCameraOrbit !== "function") return { notUpgraded: true };
    const live = () => {
      const o = mv.getCameraOrbit();
      return [+(o.theta * 180 / Math.PI).toFixed(1), +(o.phi * 180 / Math.PI).toFixed(1),
        +(o.radius * 1000).toFixed(1)];
    };
    const before = live();
    document.querySelector('[data-model="exploded"]').click();
    // Bounded: without the module there is no loader, so this `load` never fires and
    // the await sat here forever — the run had no timeout of its own, so the
    // positive control for a broken module path came back as TIMED OUT after 240s
    // instead of as a red check. 8s is ~15x the measured swap.
    await Promise.race([
      new Promise((r) => mv.addEventListener("load", r, { once: true })),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const after = live();
    return {
      src: mv.getAttribute("src"),
      before, after,
      // Half a degree and a tenth of a millimetre: a reframe to the exploded box
      // would move the radius by tens of mm, so this is tight enough to catch it
      // and loose enough not to trip on interpolation's last frame.
      same: before.every((v, i) => Math.abs(v - after[i]) < 0.5),
      // The drag has to have actually moved the live camera off the markup's pose,
      // or "held" would be a claim about a camera nobody touched.
      dragged: Math.abs(before[0] - 25) > 5 || Math.abs(before[1] - 72) > 5,
      depth: +(mv.getDimensions().z * 1000).toFixed(1),
      on: document.querySelector('[data-model="exploded"]').classList.contains("on"),
      off: !document.querySelector('[data-model="assembled"]').classList.contains("on"),
    };
  });
  check("viewer: Exploded loads the other model and keeps the camera you dragged to",
    !swap.notUpgraded && /-exploded\.glb$/.test(swap.src || "") && swap.depth > 25 &&
    swap.dragged && swap.same && swap.on && swap.off,
    swap.notUpgraded
      ? "<model-viewer> never upgraded, so there was no camera to keep"
      : `${swap.depth} mm deep · dragged to ${swap.before.join("/")}` +
        `${swap.dragged ? "" : " (DRAG DID NOTHING — nothing was held)"} · ` +
        `camera ${swap.same ? "held" : `MOVED to ${swap.after.join("/")}`} · ` +
        `highlight ${swap.on && swap.off ? "moved" : "WRONG"}`);
  await press(page, '[data-model="assembled"]');
  await page.waitForFunction(() => document.getElementById("pendant").loaded, { timeout: 15000 })
    .catch(() => {});

  // Four named poses, and the one the page paints before any JS runs has to be the
  // one whose button starts highlighted — otherwise "Camera" is lit while you are
  // looking at something else. The orbit lives in two files (the markup, for first
  // paint, and tiny-viewer.js's VIEWS) and nothing but this holds them together.
  const poses = await page.evaluate(async () => {
    const mv = document.getElementById("pendant");
    const seen = {};
    for (const v of ["camera", "logo", "worn", "edge"]) {
      document.querySelector(`[data-view="${v}"]`).click();
      seen[v] = mv.getAttribute("camera-orbit");
    }
    return seen;
  });
  const distinct = new Set(Object.values(poses)).size;
  check("viewer: four distinct poses, and Camera is the one you land on",
    distinct === 4 && poses.camera === firstPaintOrbit,
    `${distinct}/4 distinct · first paint "${firstPaintOrbit}" ` +
    `${poses.camera === firstPaintOrbit ? "==" : "!="} Camera "${poses.camera}"`);

  // ── the strip is a radiogroup, and the keyboard has to reach all of it ──────
  //
  // The roving tabindex takes the bar from seven Tab stops to three, which also
  // takes three of the four view labels out of Tab's reach — so WITHOUT the arrow
  // keys a keyboard visitor can reach only the item already chosen, and this is
  // strictly worse than the plain buttons it replaces. The two are checked together
  // for that reason: a roving tabindex that passes while the arrows are dead is the
  // regression, not the feature.
  await press(page, '[data-view="camera"]');
  const roles = await page.evaluate(() =>
    [...document.querySelectorAll(".viewer .seg[role=radiogroup]")].map((g) => {
      const items = [...g.children];
      return {
        label: g.getAttribute("aria-label"),
        n: items.length,
        radios: items.filter((b) => b.getAttribute("role") === "radio").length,
        checked: items.filter((b) => b.getAttribute("aria-checked") === "true").length,
        // Exactly one 0 and the rest -1 IS the roving pattern. Two 0s means two Tab
        // stops in one strip; none means the strip cannot be tabbed to at all.
        tabbable: items.filter((b) => b.tabIndex === 0).length,
        roving: items.filter((b) => b.tabIndex === -1).length,
        // The class and the ARIA state have to name the same button. They are read by
        // different consumers — the pill is drawn from `.on`, a screen reader hears
        // only aria-checked — so a drift between them is invisible on screen.
        agree: items.every((b) => b.classList.contains("on") ===
          (b.getAttribute("aria-checked") === "true")),
      };
    }));
  check("viewer: each strip is one Tab stop with a radio role and exactly one checked",
    roles.length === 2 &&
    roles.every((g) => g.radios === g.n && g.checked === 1 && g.tabbable === 1 &&
      g.roving === g.n - 1 && g.agree),
    roles.map((g) => `${g.label}: ${g.radios}/${g.n} radios, ${g.checked} checked, ` +
      `${g.tabbable} tabbable, class${g.agree ? "==" : "!="}aria`).join(" · "));

  // Selection follows focus, so an arrow press has to move three things at once: the
  // focus, the ARIA state, and the thing the control is FOR. The camera orbit and the
  // model src are in here because a keyboard path that moved the highlight and nothing
  // else is exactly the bug the disabled-until-upgrade work fixed for the mouse.
  //
  // REAL key presses, not dispatchEvent. A synthetic KeyboardEvent never performs the
  // default action, so `window.scrollY` cannot move no matter what the handler does —
  // the preventDefault half of this check would have been unfailable, which is the
  // same shape as comparing an attribute a src swap never touches.
  const at = () => page.evaluate(() => ({
    view: document.activeElement?.dataset.view,
    model: document.activeElement?.dataset.model,
    orbit: document.getElementById("pendant").getAttribute("camera-orbit"),
    y: Math.round(window.scrollY),
  }));
  await page.evaluate(() => document.querySelector('[data-view="camera"]').focus());
  const y0 = (await at()).y;
  await page.keyboard.press("ArrowRight");
  const right = await at();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");        // wraps past the start, onto Edge
  const wrapped = (await at()).view;
  await page.keyboard.press("End");
  const end = (await at()).view;
  await page.keyboard.press("Home");
  const home = await at();
  // The Model strip's arrows must run the click handler's side effects too — the src
  // swap lives in there, and a second call path is a second place to forget one.
  await page.evaluate(() => document.querySelector('[data-model="assembled"]').focus());
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(250);
  const keys = await page.evaluate((y0) => ({
    scrolled: Math.round(window.scrollY) !== y0,
    model: document.activeElement?.dataset.model,
    src: document.getElementById("pendant").getAttribute("src"),
    checked: document.querySelector('[data-model="exploded"]').getAttribute("aria-checked"),
  }), y0);
  keys.right = right;
  keys.wrapped = wrapped;
  keys.end = end;
  keys.home = home;
  keys.right.on = right.view;
  keys.home.on = home.view;
  check("viewer: the arrow keys move the selection, and the camera and model with it",
    keys.right.on === "logo" && keys.right.orbit === "-155deg 74deg 125mm" &&
    keys.wrapped === "edge" && keys.end === "edge" &&
    keys.home.on === "camera" && keys.home.orbit === "25deg 72deg 125mm" &&
    !keys.scrolled &&
    keys.model === "exploded" && /-exploded\.glb$/.test(keys.src || "") &&
    keys.checked === "true",
    `Right→${keys.right.on} at "${keys.right.orbit}" · Left wraps to ${keys.wrapped} · ` +
    `End→${keys.end} · Home→${keys.home.on} · page ${keys.scrolled ? "SCROLLED" : "held"} · ` +
    `Model Right→${keys.model}, src ${/-exploded\.glb$/.test(keys.src || "") ? "swapped" : "UNCHANGED"}`);
  await press(page, '[data-model="assembled"]');
  await page.waitForFunction(() => document.getElementById("pendant").loaded, { timeout: 15000 })
    .catch(() => {});
  await press(page, '[data-view="camera"]');

  // The turntable stops on request, and grabbing the model counts as a request:
  // someone who has dragged it has said what they want to look at, and having it
  // rotate away under the thumb is the whole reason this yields.
  const spun = await page.evaluate(async () => {
    const mv = document.getElementById("pendant");
    const btn = document.getElementById("spin");
    if (!mv.hasAttribute("auto-rotate")) btn.click();     // start from spinning
    const spinning = mv.hasAttribute("auto-rotate");
    btn.click();
    const paused = !mv.hasAttribute("auto-rotate");
    const label = btn.textContent.trim(), pressed = btn.getAttribute("aria-pressed");
    btn.click();                                          // spinning again
    mv.dispatchEvent(new CustomEvent("camera-change", { detail: { source: "user-interaction" } }));
    return { spinning, paused, label, pressed, yielded: !mv.hasAttribute("auto-rotate") };
  });
  check("viewer: spin pauses on request and yields when you grab the model",
    spun.spinning && spun.paused && spun.label === "Resume spin" &&
    spun.pressed === "false" && spun.yielded,
    `paused ${spun.paused} · label "${spun.label}" · aria-pressed ${spun.pressed} · ` +
    `yields to a drag ${spun.yielded}`);

  // Annotations are pinned to measured board coordinates, so the body must occlude
  // the ones facing away, and :hover never fires on glass so tap has to open them.
  //
  // This names WHICH dots show, at TWO poses, because a count cannot:
  //   · the condition used to be `visible > 0 && visible < 3`, which held at 1/3 as
  //     happily as at the correct 2/3. Deleting one hotspot's
  //     data-visibility-attribute — an annotation that can then never appear on any
  //     pose — passed it, and its positive control came back NOT CAUGHT.
  //   · one pose cannot tell tracking from a constant: wiring that answered
  //     "visible" unconditionally would satisfy any single expectation of `true`.
  //     The lens faces you in Camera and sits behind the body in Logo, so the pair
  //     disagree with each other and a constant fails one of them.
  // Measured off the built page: Camera → lens + bail, Logo → bail alone, and the
  // USB mouth (normal 0 -1 0, on the bottom edge) shows at neither.
  const facingAt = {};
  for (const view of ["camera", "logo"]) {
    await press(page, `[data-view="${view}"]`);
    await page.evaluate(() => {
      document.getElementById("pendant").removeAttribute("auto-rotate");
      document.getElementById("pendant").jumpCameraToGoal();
    });
    await page.waitForTimeout(400);
    facingAt[view] = await page.evaluate(() =>
      Object.fromEntries([...document.querySelectorAll(".viewer .hotspot")].map((h) =>
        [(h.getAttribute("slot") || "").replace("hotspot-", ""), h.hasAttribute("data-visible")])));
  }
  await press(page, '[data-view="camera"]');
  await page.evaluate(() => document.getElementById("pendant").jumpCameraToGoal());
  await page.waitForTimeout(400);
  const spots = await page.evaluate(async () => {
    const all = [...document.querySelectorAll(".viewer .hotspot")];
    const vis = all.filter((h) => h.hasAttribute("data-visible"));
    // With the wiring gone entirely there is no vis[0], and clicking `undefined`
    // rejects this evaluate — which ends the run and prints no verdict for anything
    // below, rather than one red line. Answer with the counts and let it fail.
    if (!vis.length) {
      return { n: all.length, visible: 0, shut: false, opened: false, onlyOne: false,
        closed: false, labels: all.map((h) => h.querySelector(".tip")?.textContent.trim()) };
    }
    const opacity = (h) => +getComputedStyle(h.querySelector(".tip")).opacity;
    const shut = vis.every((h) => opacity(h) === 0);
    // The tip fades over 0.15s, so a computed opacity read in the same tick as the
    // click is the value it is animating FROM — 0, every time. Reading it too early
    // failed this check while the page was working perfectly.
    const settle = () => new Promise((r) => setTimeout(r, 260));
    vis[0].click();
    await settle();
    const opened = opacity(vis[0]) === 1;
    if (vis[1]) vis[1].click();     // a second tap must not leave two open
    const onlyOne = document.querySelectorAll(".viewer .hotspot.open").length === 1;
    vis[vis[1] ? 1 : 0].click();    // and tapping the open one closes it
    return { n: all.length, visible: vis.length, shut, opened, onlyOne,
      closed: document.querySelectorAll(".viewer .hotspot.open").length === 0,
      labels: all.map((h) => h.querySelector(".tip")?.textContent.trim()) };
  });
  const facing = (p) => Object.entries(p).filter(([, v]) => v).map(([k]) => k).join("+") || "none";
  check("viewer: the body occludes the dots behind it, and tap opens one at a time",
    spots.n === 3 &&
    facingAt.camera.lens === true && facingAt.camera.bail === true && facingAt.camera.usb === false &&
    facingAt.logo.lens === false && facingAt.logo.bail === true && facingAt.logo.usb === false &&
    spots.shut && spots.opened && spots.onlyOne && spots.closed,
    `Camera shows ${facing(facingAt.camera)}, Logo shows ${facing(facingAt.logo)} · ` +
    `closed by default ${spots.shut} · tap opens ${spots.opened}, ` +
    `one at a time ${spots.onlyOne}, taps shut ${spots.closed}`);

  // The note exists because model-viewer HIDES its own AR button where AR cannot
  // work, which leaves a reader wondering whether the feature is broken. It has to
  // agree with the platform: claiming "AR ready" on this desktop, or telling an
  // iPhone it needs an iPhone, is the exact failure it was written to prevent.
  const ar = await page.evaluate(() => {
    const mv = document.getElementById("pendant");
    const note = document.getElementById("ar-note");
    const btn = document.querySelector(".ar-btn");
    return { can: mv.canActivateAR, text: note.textContent.trim(), hidden: note.hidden,
      btnShown: !!btn && !!btn.offsetParent };
  });
  const claimsReady = /^AR ready/.test(ar.text);
  check("viewer: the AR note and button agree with the platform",
    !ar.hidden && ar.text !== "" && claimsReady === ar.can && ar.btnShown === ar.can,
    `canActivateAR ${ar.can} · button ${ar.btnShown ? "shown" : "hidden"} · "${ar.text}"`);

  // The stage clips (overflow:hidden), so a too-tight camera cuts the model off
  // with nothing in the console and nothing in the build. Measured from the
  // canvas' own alpha channel — the model's real silhouette, not its bounding box
  // — across every pose on both a content column and a phone. 112mm was the first
  // radius where the exploded body touched the bottom edge on desktop; the shipped
  // 125/155/118mm keep every one of the 16 poses clear of all four edges.
  const FRAME = async () => {
    const mv = document.getElementById("pendant");
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const img = new Image();
    img.src = mv.toDataURL("image/png");
    await new Promise((r, j) => { img.onload = r; img.onerror = j; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] > 24) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    return {
      pad: Math.min(x0 / c.width, (c.width - 1 - x1) / c.width,
        y0 / c.height, (c.height - 1 - y1) / c.height) * 100,
      fill: Math.max((x1 - x0) / c.width, (y1 - y0) / c.height) * 100,
    };
  };
  let tightest = { pad: 100 }, smallest = { fill: 100 }, blank = [];
  for (const [w, h] of [[1280, 950], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.locator(".viewer model-viewer").scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    for (const model of ["assembled", "exploded"]) {
      await press(page, `[data-model="${model}"]`);
      await page.waitForFunction(() => document.getElementById("pendant").loaded, { timeout: 15000 })
        .catch(() => {});
      for (const view of ["camera", "logo", "worn", "edge"]) {
        await press(page, `[data-view="${view}"]`);
        // jump rather than sleep through the interpolation: the pose under test is
        // the destination, and a half-flown camera measures as a different frame.
        await page.evaluate(() => document.getElementById("pendant").jumpCameraToGoal());
        await page.waitForTimeout(120);
        const m = await page.evaluate(FRAME);
        const where = `${w}px/${model}/${view}`;
        if (!m) { blank.push(where); continue; }
        if (m.pad < tightest.pad) tightest = { pad: m.pad, where };
        if (m.fill < smallest.fill) smallest = { fill: m.fill, where };
      }
    }
  }
  check("viewer: no pose is clipped, and the model fills the stage",
    blank.length === 0 && tightest.pad >= 3 && smallest.fill >= 40,
    blank.length ? `EMPTY CANVAS at ${blank.join(", ")}` :
      `tightest gap ${tightest.pad.toFixed(1)}% (${tightest.where}) · ` +
      `smallest ${smallest.fill.toFixed(1)}% of an axis (${smallest.where})`);

  // The detail used to read "only Material's private-repo stats 404" whenever noise
  // was non-empty at all — asserting the very thing it had not looked at, so a real
  // pageerror printed a reassuring line under a FAIL. Name what actually arrived.
  check("viewer: nothing failed to load and nothing threw",
    httpFails.length === 0 && noise.length === 0,
    [
      httpFails.length ? `HTTP: ${httpFails.join(", ")}` : "",
      noise.length ? `THREW: ${noise.map((n) => n.slice(0, 160)).join(" | ")}` : "",
      !httpFails.length && !noise.length ? "clean, bar Material's private-repo stats" : "",
    ].filter(Boolean).join(" · "));
  await page.close();
}

// ── 8g. the viewer's controls before its 956 KB runtime lands ────────────────
// A separate page because the state under test only exists while the module is in
// flight, and no screenshot taken after load can show it. Two bugs lived here.
// The bar was live from first paint, so pressing "Exploded" on slow 4G moved the
// highlight and did nothing else — a UI asserting a view change that had not
// happened. And model-viewer's children are ordinary flow content until the
// element upgrades, which put a live "View in your room" button over the page and
// gave three hotspots 36px of layout each.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  await page.route("**/model-viewer.min.js", async (route) => {
    await new Promise((r) => setTimeout(r, 4500));
    await route.continue();
  });
  // `commit`, NOT `domcontentloaded`: a module script is deferred, and deferred
  // scripts run before DOMContentLoaded — so waiting for that event waits for the
  // 4.5s delay above to elapse, and the state under test is already over. Which is
  // how this check first "failed": 7/7 controls pressable, because by the time it
  // looked the module had loaded. The parser does not block on a module, so the
  // markup and tiny-viewer.js (an ordinary script) are both there long before it.
  await page.goto(`${base}/platform/devices/`, { waitUntil: "commit" });
  await page.waitForSelector("#ar-note", { state: "attached" });
  await page.waitForTimeout(500);
  const waiting = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("[data-model], [data-view], #spin")];
    const arBtn = document.querySelector(".ar-btn");
    return {
      n: btns.length,
      live: btns.filter((b) => !b.disabled).length,
      upgraded: !!customElements.get("model-viewer"),
      // :not(:defined) > * — the proof the children are not laid out yet
      arBtnLaidOut: !!arBtn?.offsetParent,
      hotspotFlow: [...document.querySelectorAll(".viewer .hotspot")]
        .reduce((s, h) => s + h.offsetHeight, 0),
    };
  });
  check("viewer: the controls are inert while the module is still in flight",
    !waiting.upgraded && waiting.n === 7 && waiting.live === 0 &&
    !waiting.arBtnLaidOut && waiting.hotspotFlow === 0,
    `${waiting.upgraded ? "ALREADY UPGRADED — nothing was tested · " : ""}` +
    `${waiting.live}/${waiting.n} pressable · AR button ${waiting.arBtnLaidOut ? "LAID OUT" : "not laid out"} · ` +
    `hotspots take ${waiting.hotspotFlow}px of flow`);

  // Past three seconds it must say why, rather than leaving a dead bar. This is an
  // interim message only: whenDefined still resolves whenever the module lands.
  await page.waitForTimeout(2800);
  const said = await page.evaluate(() => {
    const n = document.getElementById("ar-note");
    return { hidden: n.hidden, text: n.textContent.trim() };
  });
  check("viewer: a slow module explains itself instead of going quiet",
    !said.hidden && /still loading/.test(said.text), `"${said.text}"`);

  // And when it does land, the bar comes alive and the interim message is replaced
  // — the AR note was once written by a blind setTimeout(1200), which told real
  // iPhones "AR needs an iPhone" for six seconds.
  await page.waitForFunction(() => !!customElements.get("model-viewer"), { timeout: 20000 });
  await page.waitForTimeout(600);
  const alive = await page.evaluate(() => ({
    live: [...document.querySelectorAll("[data-model], [data-view], #spin")]
      .filter((b) => !b.disabled).length,
    text: document.getElementById("ar-note").textContent.trim(),
  }));
  check("viewer: the bar comes alive once the module upgrades",
    alive.live === 7 && !/still loading/.test(alive.text),
    `${alive.live}/7 pressable · note "${alive.text}"`);
  await page.close();
}

// ── 8h. the AR assets are actually served ───────────────────────────────────
// The USDZ is reachable from nothing but an `ios-src` attribute: no <a href>, no
// markdown link, so check 8's asset resolver never sees it and a rename ships a
// "View in your room" button that opens a 404 in AR Quick Look — on the platform
// this whole section is aimed at, and nowhere else.
{
  const page = await browser.newPage();
  await page.goto(`${base}/platform/devices/`, { waitUntil: "domcontentloaded" });
  const srcs = await page.evaluate(() => {
    const mv = document.getElementById("pendant");
    return ["src", "data-src-assembled", "data-src-exploded", "ios-src"]
      .map((a) => [a, mv.getAttribute(a)]);
  });
  const bad = [];
  for (const [attr, rel] of srcs) {
    if (!rel) { bad.push(`${attr} missing`); continue; }
    const res = await fetch(new URL(rel, `${base}/platform/devices/`)).catch(() => null);
    // Count the bytes that arrive rather than trusting content-length: this
    // harness' own server answers with chunked encoding and sends no such header,
    // so reading it reported every one of these 271 KB files as "200, 0 B".
    const len = res?.ok ? (await res.arrayBuffer()).byteLength : 0;
    // A 200 of 0 bytes is a served file too; the smallest of these is 271 KB.
    if (!res?.ok || len < 100000) bad.push(`${attr} → ${res ? `${res.status}, ${len} B` : "no response"}`);
  }
  const usdz = srcs.find(([a]) => a === "ios-src")?.[1] ?? "";
  check("viewer: all four model URLs resolve, including the AR-only USDZ",
    bad.length === 0 && /\.usdz$/.test(usdz),
    bad.length ? bad.join(", ") : `4 served · ios-src ${/\.usdz$/.test(usdz) ? "is a .usdz" : `is NOT a usdz: ${usdz}`}`);
  await page.close();
}

// ── 8b. the sliding pill: on the label, and not gliding in on arrival ───────
//
// The pill is a ::before on the group whose position and width are MEASURED off the
// chosen button by tiny-viewer.js, because "Assembled" and "Camera" are different
// widths and no CSS-only translation can know them. Two ways that goes wrong, and
// both of them look fine in a screenshot taken a second late:
//
//   · 1px left on every group. `left: 0` on an absolutely positioned ::before
//     resolves against the PADDING box while getBoundingClientRect includes the
//     border, so a placement that forgets to subtract the group's border sits a
//     hairline off the label it is supposed to be under.
//   · it glides in from the left edge of the track on every page load. CSS compares
//     the before-change style with the after-change style, not the order of two
//     mutations inside one task — so writing --thumb-x before setting data-thumb is
//     NOT enough, and the first placement animates from translate3d(0). This counts
//     transitionrun events from before the page's first paint, which is the only
//     moment that can see it.
//
// Measured at BOTH states: zero glides before anyone has pressed anything, and a
// glide once they have. A pill that is simply never animated would satisfy the first
// half alone, and so would a pill that does not exist.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  await page.addInitScript(() => {
    window.__runs = [];
    // transitionrun bubbles, and for a pseudo-element the target is the originating
    // element with .pseudoElement set — so one document listener sees all four.
    document.addEventListener("transitionrun", (e) => {
      if (e.target.classList?.contains("seg")) {
        window.__runs.push(`${e.pseudoElement || "element"}:${e.propertyName}`);
      }
    }, true);
  });
  await page.goto(`${base}/platform/devices/`, { waitUntil: "load" });
  await page.locator(".viewer model-viewer").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.getElementById("pendant")?.loaded, { timeout: 40000 })
    .catch(() => {});
  await page.waitForTimeout(700);
  const pill = await page.evaluate(() => {
    const read = (g) => {
      const on = g.querySelector("button.on");
      const gb = g.getBoundingClientRect(), bb = on.getBoundingClientRect();
      const cs = getComputedStyle(g, "::before");
      const m = new DOMMatrixReadOnly(cs.transform);
      const bx = parseFloat(getComputedStyle(g).borderLeftWidth) || 0;
      return {
        label: g.getAttribute("aria-label"),
        shown: g.hasAttribute("data-thumb") && +cs.opacity === 1,
        // The pill's own box, in page coordinates, against the label's box.
        dx: +(gb.left + bx + m.m41 - bb.left).toFixed(2),
        dw: +(parseFloat(cs.width) - bb.width).toFixed(2),
      };
    };
    return [...document.querySelectorAll(".viewer .seg[role=radiogroup]")].map(read);
  });
  const runsOnLoad = await page.evaluate(() => window.__runs.slice());
  // Now press something: the pill has to move, and it has to move by animating.
  await press(page, '[data-view="edge"]');
  await page.waitForTimeout(120);
  const moved = await page.evaluate(() => {
    const g = document.querySelector('.viewer .seg[aria-label="View"]');
    const on = g.querySelector("button.on");
    const gb = g.getBoundingClientRect(), bb = on.getBoundingClientRect();
    const cs = getComputedStyle(g, "::before");
    const bx = parseFloat(getComputedStyle(g).borderLeftWidth) || 0;
    return { onEdge: on.dataset.view === "edge",
      // Read the SETTLED target off the custom property, not the mid-flight matrix:
      // this is 120ms into a 380ms glide on purpose, so m41 is somewhere in between.
      dx: +(parseFloat(g.style.getPropertyValue("--thumb-x")) -
        (bb.left - gb.left - bx)).toFixed(2),
      dw: +(parseFloat(g.style.getPropertyValue("--thumb-w")) - bb.width).toFixed(2),
      runs: window.__runs.length };
  });
  // 0.5px, not 1px: the mistake this is written against is a MISSING BORDER
  // SUBTRACTION, which is worth exactly 1px — a tolerance of 1 would excuse the
  // one defect the code above carries a paragraph about. Measured dx/dw are 0.00.
  const off = pill.filter((p) => Math.abs(p.dx) > 0.5 || Math.abs(p.dw) > 0.5);
  check("viewer: the pill sits on the chosen label and does not glide in on load",
    pill.length === 2 && pill.every((p) => p.shown) && off.length === 0 &&
    runsOnLoad.length === 0 &&
    moved.onEdge && Math.abs(moved.dx) <= 0.5 && Math.abs(moved.dw) <= 0.5 &&
    moved.runs > 0,
    pill.map((p) => `${p.label} ${p.shown ? "" : "HIDDEN "}dx ${p.dx}px dw ${p.dw}px`).join(" · ") +
    ` · glides before a press ${runsOnLoad.length}${runsOnLoad.length ? ` (${runsOnLoad.join(", ")})` : ""}` +
    ` · after ${moved.runs} · Edge dx ${moved.dx}px dw ${moved.dw}px`);

  // ── and a re-measure nobody asked for JUMPS ────────────────────────────────
  // The pill is re-placed on three things that are not selections: a resize, a
  // rotation, and the webfont landing. The font is why this check exists — with the
  // woff2 held 2.5s over a routed throttle, the shipped page's "Assembled" measured
  // 107.03px in the fallback and 104.20px in Roboto, and the fonts.ready re-measure
  // morphed the pill 2.7 SECONDS into the page. Every earlier probe missed it because
  // the font was already in hand before the first placement, so this does not wait for
  // a real swap: inject letter-spacing (the labels move, nothing re-measures), then
  // resize for real and watch the re-place.
  //
  // A synthetic `new Event("resize")` would test our listener but not that a real
  // resize reaches it, and setViewportSize costs nothing here.
  const geo = () => page.evaluate(() => {
    const g = document.querySelector('.viewer .seg[aria-label="View"]');
    const on = g.querySelector("button.on");
    const gb = g.getBoundingClientRect(), bb = on.getBoundingClientRect();
    const bx = parseFloat(getComputedStyle(g).borderLeftWidth) || 0;
    return {
      w: +bb.width.toFixed(2),
      quiet: g.hasAttribute("data-quiet"),
      // Settled target off the custom properties, not the matrix: a stale pill is
      // exactly what the first two reads are looking for.
      dx: +(parseFloat(g.style.getPropertyValue("--thumb-x")) - (bb.left - gb.left - bx)).toFixed(2),
      dw: +(parseFloat(g.style.getPropertyValue("--thumb-w")) - bb.width).toFixed(2),
    };
  });
  await page.waitForTimeout(400);                       // let the Edge glide settle
  const settled = await geo();
  await page.addStyleTag({ content: ".viewer .seg button { letter-spacing: 1.4px; }" });
  const stale = await geo();
  await page.evaluate(() => { window.__runs.length = 0; });
  await page.setViewportSize({ width: 1180, height: 950 });
  await page.waitForTimeout(250);
  const requiet = await geo();
  const quietRuns = await page.evaluate(() => window.__runs.slice());
  // data-quiet is added and removed inside one placement, so a version that forgets to
  // remove it would suppress every glide FOREVER and still pass everything above —
  // this check would have shipped the very artifact it exists to defend. Press again.
  await page.evaluate(() => { window.__runs.length = 0; });
  await press(page, '[data-view="worn"]');
  await page.waitForTimeout(120);
  const stillGlides = await page.evaluate(() => window.__runs.length);
  check("viewer: a re-measure the reader did not ask for re-places the pill without gliding",
    // The first two are the falsifiability: unless the labels really moved and left the
    // pill really stale, "re-placed within 0.5px and no glide" is satisfied by a pill
    // that never moved at all, and by one that is not there.
    stale.w > settled.w + 0.5 && Math.abs(stale.dw) > 0.5 &&
    Math.abs(requiet.dx) <= 0.5 && Math.abs(requiet.dw) <= 0.5 &&
    quietRuns.length === 0 && !requiet.quiet && stillGlides > 0,
    `label ${settled.w} → ${stale.w}px left the pill ${stale.dw}px stale · resize re-placed it ` +
    `dx ${requiet.dx}px dw ${requiet.dw}px with ${quietRuns.length} glides` +
    `${quietRuns.length ? ` (${quietRuns.join(", ")})` : ""}` +
    `${requiet.quiet ? " · data-quiet LATCHED" : ""} · a later press glides ${stillGlides}`);
  await page.close();
}

// ── 9. shots of the pages that carry the design language ────────────────────
if (SHOTS) {
  // devices/ first and on its own: its shot is worthless unless the model is in it,
  // and a fullPage screenshot of a lazy <model-viewer> that has not been looked at
  // is a screenshot of an empty box.
  const mv = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await mv.goto(`${base}/platform/devices/`, { waitUntil: "load" });
  await mv.locator(".viewer model-viewer").scrollIntoViewIfNeeded();
  await mv.waitForFunction(() => document.getElementById("pendant")?.loaded, { timeout: 40000 })
    .catch(() => {});
  await mv.waitForTimeout(900);
  await mv.evaluate(() => {
    // A turntable makes every shot a different shot. Park it on the pose the page
    // paints, so a diff between two runs means something changed.
    const el = document.getElementById("pendant");
    el.removeAttribute("auto-rotate");
    el.jumpCameraToGoal();
  });
  await mv.waitForTimeout(400);
  await mv.screenshot({ path: join(SHOTS, "p-platform-devices.png"), fullPage: true });
  await mv.locator(".viewer").screenshot({ path: join(SHOTS, "p-viewer.png") });
  await mv.close();

  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  for (const url of ["/platform/skills/", "/platform/automation/", "/business/",
                     "/business/comparison/", "/business/pricing/", "/business/trust/",
                     "/business/build-guide/", "/business/integrate/",
                     "/business/enterprise/", "/business/roadmap/", "/faq/",
                     "/developers/", "/developers/run-a-node/",
                     "/getting-started/what-to-build/", "/gallery/"]) {
    await page.goto(base + url, { waitUntil: "load" });
    await page.waitForTimeout(350);
    await page.screenshot({
      path: join(SHOTS, `p${url.replace(/\//g, "-")}.png`),
      fullPage: true,
    });
  }
  await page.close();
}

await browser.close();
server.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (SHOTS) console.log(`shots → ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
