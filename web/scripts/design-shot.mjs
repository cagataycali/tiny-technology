/**
 * 📸 design-shot — screenshot a route with a REAL emulated viewport.
 *
 *   node scripts/design-shot.mjs <url> <out.png> [width] [height]
 *   node scripts/design-shot.mjs http://localhost:3000/universe /tmp/u.png 390 844
 *
 * Exists because Google Chrome's `--headless=new --screenshot` is a trap
 * for design QA (learned in design-parity cycle 10):
 *   1. `--window-size` below ~500px wide gets CLAMPED for layout and the
 *      image is then cropped — pages look broken (fake horizontal
 *      overflow) when they are fine.
 *   2. `--virtual-time-budget` starves React's MessageChannel scheduler,
 *      so the page never hydrates — client-rendered content (the
 *      constellation, anything rAF-driven) silently vanishes.
 * Playwright emulates the viewport for real and waits for hydration.
 * reducedMotion: 'reduce' makes animation-settled states deterministic
 * (the constellation settles synchronously under it).
 *
 * Browser binary: `npx playwright install chromium` (cached in
 * ~/Library/Caches/ms-playwright; bump the revision glob below if
 * playwright-core updates).
 */
import { chromium } from "playwright-core";
import { globSync } from "node:fs";

const [url, out, w = "1280", h = "900"] = process.argv.slice(2);
if (!url || !out) {
  console.error("usage: node scripts/design-shot.mjs <url> <out.png> [width] [height]");
  process.exit(1);
}

const [exe] = globSync(
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-mac/headless_shell`,
).sort().reverse();
if (!exe) {
  console.error("no headless shell found — run: npx playwright install chromium");
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({
  viewport: { width: Number(w), height: Number(h) },
  reducedMotion: "reduce",
});
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
await browser.close();
console.log(`${out} (${w}x${h})`);
