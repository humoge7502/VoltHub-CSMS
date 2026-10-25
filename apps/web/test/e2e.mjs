#!/usr/bin/env node
/* global process, console, location, localStorage, document */
// Authenticated UI E2E — the flows the smoke suite cannot reach without a session.
//
//   BASE_URL=https://<host> node test/e2e.mjs
//   BASE_URL=https://<host> ADMIN_PASSWORD='...' node test/e2e.mjs   # adds the admin leg
//
// The driver credential is a published demo login; the admin leg is opt-in so CI
// can run this without storing the provisioned secret (SEC-050).
import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const DRIVER = {
  email: process.env.DRIVER_EMAIL || 'divya.shankar1@example.in',
  password: process.env.DRIVER_PASSWORD || 'Driver@123',
};
// ADMIN_BOOTSTRAP_PASSWORD is the name the seed/migrate path already uses, so CI
// passes that one rather than maintaining a second copy of the secret.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_BOOTSTRAP_PASSWORD || '';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'admin@volthub.in', password: ADMIN_PASSWORD };

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};

const CHANNEL = process.env.PW_CHANNEL ?? 'chrome';
const browser = await chromium.launch({ ...(CHANNEL ? { channel: CHANNEL } : {}), headless: true });

async function login(page, creds) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // Wait for hydration: a click before React binds onSubmit triggers a native submit that
  // just reloads /login. A fixed sleep was flaky on a cold Next server, so wait for React's
  // props key on the button (proof the handler is attached), then fall back to a short sleep.
  await page
    .waitForFunction(
      () => {
        const btn = document.querySelector('button[type="submit"]');
        return !!btn && Object.keys(btn).some((k) => k.startsWith('__reactProps$'));
      },
      null,
      { timeout: 20000 }
    )
    .catch(() => page.waitForTimeout(2500));
  await page.fill('input[type="email"], input[name="email"]', creds.email);
  await page.fill('input[type="password"]', creds.password);
  await page.click('button[type="submit"]');
  try {
    await page.waitForFunction(() => !location.pathname.startsWith('/login'), null, { timeout: 20000 });
  } catch {
    const err = await page
      .locator('.err, [role="alert"]')
      .first()
      .innerText()
      .catch(() => '');
    throw new Error(`login did not navigate; form error: ${err || 'none'}`);
  }
  return page.evaluate(() => localStorage.getItem('vh_token'));
}

async function session(creds, label, extra) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  const token = await login(page, creds);
  check(`${label}: login issues a session token`, Boolean(token), token ? `${String(token).length} chars` : 'none');

  for (const path of ['/discover', '/wallet', '/invoices', '/reservations']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(800);
    const text = (
      (await page
        .locator('main')
        .innerText()
        .catch(() => '')) || ''
    ).trim();
    check(`${label}: ${path} renders for the signed-in user`, text.length > 20, `${text.length} chars`);
  }

  if (extra) await extra(page, label);

  check(`${label}: no uncaught exceptions across the tour`, errors.length === 0, errors[0] || '');
  await ctx.close();
}

await session(DRIVER, 'driver');

if (ADMIN.password) {
  await session(ADMIN, 'admin', async (page, label) => {
    await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.getByRole('button', { name: 'OCPP commands' }).click();
    await page.getByText('Charge-point command console').waitFor({ timeout: 15000 });
    await page
      .waitForFunction(() => [...document.querySelectorAll('select')].some((s) => s.options.length > 1), null, {
        timeout: 15000,
      })
      .catch(() => {});
    const cpOptions = await page.locator('select').first().locator('option').count();
    const text = (await page.locator('main').innerText()).trim();
    check(`${label}: /admin OCPP console renders`, /Charger answer/i.test(text) && /Send command/i.test(text), '');
    check(`${label}: OCPP inventory is populated`, cpOptions >= 2, `${cpOptions} options`);
  });
} else {
  console.log('SKIP  admin leg (set ADMIN_PASSWORD to include it)');
}

await browser.close();
console.log(`\n${failed ? `${failed} check(s) failed` : 'all E2E checks passed'} against ${BASE}`);
process.exit(failed ? 1 : 0);
