#!/usr/bin/env node
/* global process, console, document, getComputedStyle */
// Web smoke suite — the console's first automated test (ISS-02).
// Runs against any origin, so the same file gates local dev, CI, and the public demo:
//
//   BASE_URL=https://stock-page-med-yesterday.trycloudflare.com node test/smoke.mjs
//
// It asserts *outcomes* (visible content, no uncaught exceptions, no horizontal
// overflow, real font applied) rather than implementation details, so refactors
// do not break it but regressions do.

import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function visit(path, { width = 1280, height = 800 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  const res = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200); // let client islands hydrate
  return { ctx, page, errors, status: res ? res.status() : 0 };
}

// 1. Home renders the hero and the type system actually applied.
{
  const { ctx, page, errors, status } = await visit('/');
  check('home: HTTP 200', status === 200, `status ${status}`);

  const h1 =
    (await page
      .locator('h1')
      .first()
      .innerText()
      .catch(() => '')) || '';
  check('home: hero headline is visible', /certainty/i.test(h1), JSON.stringify(h1.slice(0, 60)));

  const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily).catch(() => '');
  check('home: distinctive body font applied (not Inter)', /plex/i.test(font) && !/\binter\b/i.test(font), font);

  const links = await page.locator('a[href]').count();
  check('home: navigation present', links >= 3, `${links} links`);

  check('home: no uncaught exceptions', errors.length === 0, errors[0] || '');
  await ctx.close();
}

// 2. No horizontal overflow at phone and desktop widths (taste-skill frame rule).
for (const width of [375, 1280]) {
  const { ctx, page } = await visit('/', { width, height: width === 375 ? 812 : 800 });
  const overflow = await page
    .evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    .catch(() => 0);
  check(`home: no horizontal overflow @${width}px`, overflow <= 1, `${overflow}px`);
  await ctx.close();
}

// 3. Login form is reachable and has the expected controls.
{
  const { ctx, page, errors, status } = await visit('/login');
  check('login: HTTP 200', status === 200, `status ${status}`);
  const email = await page.locator('input[type="email"], input[name="email"]').count();
  const pass = await page.locator('input[type="password"]').count();
  check('login: email + password fields', email >= 1 && pass >= 1, `${email}/${pass}`);
  check('login: no uncaught exceptions', errors.length === 0, errors[0] || '');
  await ctx.close();
}

// 4. Discover renders stations or an honest empty state.
{
  const { ctx, page, errors, status } = await visit('/discover');
  check('discover: HTTP 200', status === 200, `status ${status}`);
  const text = (
    (await page
      .locator('main')
      .innerText()
      .catch(() => '')) || ''
  ).trim();
  check('discover: main content rendered', text.length > 20, `${text.length} chars`);
  check('discover: no uncaught exceptions', errors.length === 0, errors[0] || '');
  await ctx.close();
}

await browser.close();

console.log(`\n${results.length - failed}/${results.length} smoke checks passed`);
if (failed) {
  console.error(`${failed} check(s) failed against ${BASE}`);
  process.exit(1);
}
