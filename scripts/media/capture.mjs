// Screenshot + recording harness for docs and the demo video.
// Usage: node scripts/media/capture.mjs [--out DIR] [--only route,route]
// Requires: API on :4000, web on :3000, playwright installed (npm i -D playwright).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 ? process.argv[i + 1] : d;
};
const OUT = path.resolve(arg('--out', 'docs/screenshots'));
const ONLY = arg('--only', '')
  .split(',')
  .filter(Boolean);
const W = Number(arg('--w', 1440));
const H = Number(arg('--h', 900));
const SCALE = Number(arg('--scale', 2));
const FULL = process.argv.includes('--full');

const API = process.env.API_BASE || 'http://localhost:4000/api/v1';
const WEB = process.env.WEB_BASE || 'http://localhost:3120';

const ROUTES = [
  ['home', '/', 'driver'],
  ['discover', '/discover', 'driver'],
  ['reservations', '/reservations', 'driver'],
  ['history', '/history', 'driver'],
  ['invoices', '/invoices', 'driver'],
  ['wallet', '/wallet', 'driver'],
  ['notifications', '/notifications', 'driver'],
  ['profile', '/profile', 'driver'],
  ['dashboard', '/dashboard', 'staff'],
  ['telemetry', '/telemetry', 'staff'],
  ['analytics', '/analytics', 'staff'],
  ['faults', '/faults', 'staff'],
  ['admin', '/admin', 'staff'],
  ['login', '/login', 'anon'],
  ['signup', '/signup', 'anon'],
];

async function token(email, password) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!j.accessToken) throw new Error(`login failed for ${email}: ${JSON.stringify(j)}`);
  return j.accessToken;
}

const run = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  const page = await ctx.newPage();

  const driverTok = await token('divya.shankar1@example.in', 'Driver@123');
  const staffTok = await token('admin@volthub.in', 'Admin@123');

  const results = [];
  for (const [name, route, who] of ROUTES) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const tok = who === 'staff' ? staffTok : who === 'driver' ? driverTok : null;
    await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => {
      if (t) localStorage.setItem('vh_token', t);
      else localStorage.removeItem('vh_token');
    }, tok);
    const res = await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    // let skeletons settle: wait for any .skel to disappear (max 6s)
    await page
      .waitForFunction(() => !document.querySelector('.skel'), null, { timeout: 6000 })
      .catch(() => {});
    await page.waitForTimeout(400);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage: FULL });
    const status = res?.status();
    results.push({ name, route, status, file });
    console.log(`${status}  ${route}  ->  ${path.relative(process.cwd(), file)}`);
  }

  // Mobile pass — the same routes at 390x844, drawer closed.
  if (!ONLY.length) {
    const m = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const mp = await m.newPage();
    for (const [name, route, who] of ROUTES.slice(0, 8)) {
      const tok = who === 'staff' ? staffTok : who === 'driver' ? driverTok : null;
      await mp.goto(`${WEB}/`, { waitUntil: 'domcontentloaded' });
      await mp.evaluate((t) => (t ? localStorage.setItem('vh_token', t) : localStorage.removeItem('vh_token')), tok);
      await mp.goto(`${WEB}${route}`, { waitUntil: 'networkidle' });
      await mp.waitForTimeout(700);
      await mp.screenshot({ path: path.join(OUT, `mobile-${name}.png`), fullPage: FULL });
    }
    await m.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length} shots -> ${OUT}`);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
