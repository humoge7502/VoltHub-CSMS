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
import { requireServer } from './preflight.mjs';

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

await requireServer(BASE);
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

// A page that renders *something* proves the route answered; it does not prove the
// data island hydrated. These staff pages are all polled now, so the assertion waits
// for text that only exists once the first tick resolved — a poller that silently
// fails (bad token, wrong payload shape, aborted request) fails the check instead of
// showing a skeleton forever, which is exactly the bug the analytics page had.
// Case-insensitive because the console upper-cases KPI labels in CSS
// (text-transform), and innerText returns what is *rendered*, not what the source says.
async function waitForText(page, pattern, timeout = 20000) {
  try {
    await page.waitForFunction((src) => new RegExp(src, 'i').test(document.body.innerText), pattern.source, {
      timeout,
    });
    return true;
  } catch {
    return false;
  }
}

async function staffPage(page, label, path, pattern) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const ok = await waitForText(page, pattern);
  check(`${label}: ${path} first poll resolves`, ok, ok ? '' : `no match for ${pattern}`);
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

// The four pages rebuilt around usePoll (dashboard fan-out, telemetry, analytics,
// live session) plus the home health island. Each marker below is text that only
// renders from fetched data, so this leg fails if a poller never resolves.
async function staffTour(page, label) {
  // The home island resolves to the live engine mode ('oracle' against the compose stack,
  // 'local' for the hermetic store) and an outbox lag in events. The `…` placeholder has
  // no digits, so this only matches after the first poll landed.
  await staffPage(page, label, '/', /outbox lag[\s\S]{0,24}?\d+ ev/);
  await staffPage(page, label, '/dashboard', /Active \/ Faults/);
  const pick = page.locator('select#station-pick').first();
  const stations = await pick
    .locator('option')
    .count()
    .catch(() => 0);
  check(`${label}: /dashboard station picker is populated`, stations >= 2, `${stations} options`);

  // Repicking a station must never leave the PREVIOUS station's numbers under the new
  // station's label — the stale-data defect the 2026-10-25 audit rated Critical. The poll
  // is now scoped to the selection, so the payload is dropped the moment it changes and
  // the KPI block disappears before the new batch lands.
  const kpiBlock = () =>
    page.evaluate(() => {
      const el = document.querySelector('.grid.cards');
      return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
    });
  const before = await kpiBlock();
  check(`${label}: /dashboard renders a KPI block for the first station`, before.length > 0, before);
  await pick.selectOption(await pick.locator('option').nth(1).getAttribute('value'));
  const cleared = await page
    .waitForFunction(
      (prev) => {
        const el = document.querySelector('.grid.cards');
        return !el || el.innerText.replace(/\s+/g, ' ').trim() !== prev;
      },
      before,
      { timeout: 4000 }
    )
    .then(() => true)
    .catch(() => false);
  check(
    `${label}: /dashboard repick drops the previous station's KPIs`,
    cleared,
    cleared ? '' : `still showing "${before}"`
  );
  const reloaded = await waitForText(page, /Active \/ Faults/);
  check(`${label}: /dashboard re-polls after the repick`, reloaded, reloaded ? '' : 'second station never resolved');
  // The toast region has to exist BEFORE the first toast: a live region inserted in the
  // same commit as its content is not watched by assistive tech, so the first toast of
  // every visit — usually the error the user most needs — used to be silent.
  const liveRegion = await page.evaluate(() => Boolean(document.querySelector('div[aria-live="polite"]')));
  check(`${label}: /dashboard mounts the toast live region with nothing to say`, liveRegion, '');
  await staffPage(page, label, '/telemetry', /MEAN DRAW/);
  // WCAG 1.1.1: the charts are pictures of series, so each must ship its numbers. The
  // heatmap only has numbers when the station has history, so an honest empty state
  // ("no utilization history yet") satisfies the rule too — what must never happen is a
  // chart on screen with no table behind it, which is what the skeleton did before.
  const tables = await page
    .locator('details.datatbl table.t')
    .count()
    .catch(() => 0);
  const heatEmpty = await page.locator('[data-empty="heatmap"]').count();
  check(
    `${label}: /telemetry charts carry a data-table alternative`,
    tables >= 2 || (tables >= 1 && heatEmpty === 1),
    `${tables} tables${heatEmpty ? ' + honest heatmap empty state' : ''}`
  );
  await staffPage(page, label, '/analytics', /Utilization signal/);

  // Session detail needs a real id: take the first link the history list renders
  // rather than hard-coding one the seed may not produce.
  await page.goto(`${BASE}/history`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitForText(page, /\/session\//);
  const href = await page
    .evaluate(() => document.querySelector('a[href^="/session/"]')?.getAttribute('href') || '')
    .catch(() => '');
  check(`${label}: /history links to a session`, href.startsWith('/session/'), href || 'none');
  if (href) {
    await page.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const gotData = await waitForText(page, /Meter frames/);
    check(`${label}: ${href} live view renders its meter frames`, gotData, gotData ? '' : 'no data');
    // The hero number is an aria-label set from the polled payload — proof the
    // scoped live region (not the whole page) carries the announced value.
    const heroLabel = await page
      .locator('h1[aria-live="polite"]')
      .first()
      .getAttribute('aria-label')
      .catch(() => null);
    check(`${label}: ${href} hero meter is announced`, /kilowatt hours/.test(heroLabel || ''), heroLabel || 'none');
  }
}

if (ADMIN.password) {
  await session(ADMIN, 'admin', async (page, label) => {
    await staffTour(page, label);
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
