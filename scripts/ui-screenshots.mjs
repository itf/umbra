/**
 * Drives the built app in headless Chromium and captures screenshots of the key
 * UI states so layout regressions are visible (the test env has no DOM renderer).
 *
 * Usage:
 *   npm run build && node scripts/ui-screenshots.mjs [outDir]
 * Assumes a server is already serving `dist/` at $BASE_URL (default localhost:4317).
 * Captures at a small phone-ish viewport where overflow/off-screen bugs show up.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4317';
const OUT = process.argv[2] ?? 'scratchpad-shots';
mkdirSync(OUT, { recursive: true });

const VIEWPORT = { width: 390, height: 740 }; // iPhone-ish portrait

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`  saved ${OUT}/${name}.png`);
}

async function overflowReport(page, label) {
  const r = await page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    const offenders = [];
    for (const el of document.querySelectorAll('button, #level-picker *, section')) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      // Element wholly or partly outside the viewport.
      if (b.bottom < 0 || b.top > vh || b.right < 0 || b.left > vw) {
        offenders.push({ tag: el.tagName, id: el.id, cls: el.className, top: Math.round(b.top), bottom: Math.round(b.bottom) });
      }
    }
    return { vw, vh, scrollH: document.documentElement.scrollHeight, offenders: offenders.slice(0, 12) };
  });
  console.log(`[${label}] viewport ${r.vw}x${r.vh} scrollHeight=${r.scrollH}`);
  if (r.offenders.length) {
    console.log(`  OFF-VIEWPORT elements (${r.offenders.length}):`);
    for (const o of r.offenders) console.log(`    <${o.tag} id="${o.id}" class="${o.cls}"> top=${o.top} bottom=${o.bottom}`);
  } else {
    console.log('  no off-viewport interactive elements ✓');
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT });

// 1. Game page — picker
await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await shot(page, '01-game-picker');
await overflowReport(page, 'game picker');

// 2. Game page — Begin screen (click a level card in the picker list)
try {
  await page.locator('#level-picker .picker-item').first().waitFor({ timeout: 3000 });
  await page.locator('#level-picker .picker-item').first().click();
  await page.locator('#start-screen:not([hidden])').waitFor({ timeout: 3000 });
  await page.waitForTimeout(200);
  await shot(page, '02-game-start');
  await overflowReport(page, 'game start');
  // 3. Begin -> game screen (feet). Audio may fail headless; the layout still shows.
  await page.click('#start-button');
  await page.waitForTimeout(800);
  await shot(page, '03-game-playing');
  await overflowReport(page, 'game playing (feet must be on-screen)');
  // Explicitly check the feet are within the viewport and clickable.
  const feet = await page.evaluate(() => {
    const vh = innerHeight, vw = innerWidth;
    return ['step-left', 'step-right'].map((id) => {
      const el = document.getElementById(id);
      if (!el) return { id, present: false };
      const b = el.getBoundingClientRect();
      return { id, present: true, top: Math.round(b.top), bottom: Math.round(b.bottom),
               inView: b.top >= 0 && b.bottom <= vh && b.left >= 0 && b.right <= vw,
               w: Math.round(b.width), h: Math.round(b.height) };
    });
  });
  console.log('  feet:', JSON.stringify(feet));
} catch (e) {
  console.log('start/begin flow:', e.message);
}

// 4. Editor
await page.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await shot(page, '04-editor');
await overflowReport(page, 'editor');

// 5. Trainer
await page.goto(`${BASE}/trainer.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await shot(page, '05-trainer');

await browser.close();
console.log('done');
