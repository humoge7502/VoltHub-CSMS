#!/usr/bin/env node
// Render diagrams/da3.html into one PNG per diagram section, and optionally a PDF.
//
//   node scripts/render-da3.mjs [--scale 2] [--pdf]
//
// The HTML is the source of truth for these two diagrams: Mermaid's layout engine
// produced a 10:1 strip for the pipeline and a 1:3.2 tower for the schema, neither of
// which survives being scaled into a README. Authored CSS gives an aspect ratio that
// actually reads, and the palette matches the console.
//
// The PDF is vector, not a wrapped PNG: Chromium embeds the real glyphs, so the text
// stays selectable and searchable and the lines stay crisp at any zoom. One page per
// section, sized to the section's own design width.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// playwright is a devDependency of apps/web, not of the root workspace, and NODE_PATH
// does not apply to ESM resolution — so fall back to the installed copy explicitly.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import(
    pathToFileURL(join(ROOT, 'apps', 'web', 'node_modules', 'playwright', 'index.mjs')).href
  ));
}

const SRC = join(ROOT, 'diagrams', 'da3.html');
const OUT = join(ROOT, 'diagrams', 'out');

const scaleArg = process.argv.indexOf('--scale');
const SCALE = scaleArg > -1 ? Number(process.argv[scaleArg + 1]) : 2;
const WANT_PDF = process.argv.includes('--pdf');

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.PW_CHANNEL === '' ? {} : { channel: process.env.PW_CHANNEL || 'chrome' }),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 2200, height: 1400 }, deviceScaleFactor: SCALE });

await page.goto(pathToFileURL(SRC).href, { waitUntil: 'load' });
// Webfonts are a network round trip; without this the first screenshot lands in a
// fallback face and the diagram ships with the wrong typography.
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);

const sections = await page.$$eval('[data-diagram]', (els) =>
  els.map((el) => ({ id: el.dataset.diagram, width: el.offsetWidth, height: el.offsetHeight }))
);

for (const { id } of sections) {
  const file = join(OUT, `da3-${id}.png`);
  await page.locator(`[data-diagram="${id}"]`).screenshot({ path: file });
  console.log(`rendered ${file}`);
}

if (WANT_PDF) {
  // One page per section, at the width the diagram was designed for. Heights differ
  // between the two sections, so the page takes the tallest and every section is
  // stretched to fill it — otherwise the shorter one trails a strip of bare background
  // that reads as a rendering mistake rather than as margin.
  const pageWidth = Math.max(...sections.map((s) => s.width));
  const pageHeight = Math.ceil(Math.max(...sections.map((s) => s.height)) / 10) * 10;

  await page.addStyleTag({
    content: `@media print {
      html, body { background: #0b0e11; }
      .dgm { min-height: ${pageHeight}px; break-after: page; }
      .dgm:last-of-type { break-after: auto; }
    }`,
  });
  await page.emulateMedia({ media: 'print' });
  // Chromium copies document.title into the PDF's /Title metadata — that is what a
  // reader shows in its tab and what a search index picks up.
  await page.evaluate(() => {
    document.title = 'VoltHub CSMS — DA3: outbox pipeline and TimescaleDB schema';
  });

  const file = join(OUT, 'da3.pdf');
  await page.pdf({
    path: file,
    width: `${pageWidth}px`,
    height: `${pageHeight}px`,
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
  });
  console.log(`rendered ${file} (${sections.length} pages, ${pageWidth}x${pageHeight}px)`);
}

await browser.close();
