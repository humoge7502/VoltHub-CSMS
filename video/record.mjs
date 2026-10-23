#!/usr/bin/env node
// VoltHub demo — segment recorder.
//
// One Playwright context per narration segment, so each segment is an independent video
// file whose length the assembler can force to the exact narration duration. Stage scenes
// (title / problem / idea / terminal / receipts / close) are driven from video/stage.html;
// the three app segments are real tours of the running console — no mock-ups, no
// re-typed numbers. The race terminal types the captured stdout of the live race suite
// (out/race.txt), which the build regenerates against whatever database is running.
//
// Usage:  node video/record.mjs [--only 05-app,06-wallet] [--keep]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const SEG = path.join(OUT, 'seg');
const WEB = (process.env.WEB_BASE || 'http://localhost:3120').replace(/\/$/, '');
const API = (process.env.API_BASE || 'http://localhost:4000/api/v1').replace(/\/$/, '');

const argv = process.argv.slice(2);
const onlyArg = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '';
const ONLY = onlyArg.split(',').filter(Boolean);
const LEAD = 0.6; // seconds of slack before the first kept frame (video warms up on open)

const timing = JSON.parse(fs.readFileSync(path.join(OUT, 'timing.json'), 'utf8'));
const raceText = fs.readFileSync(path.join(OUT, 'race.txt'), 'utf8').trim();

const CHAPTER = {
  title: ['01', 'TITLE'],
  problem: ['02', 'THE PROBLEM'],
  idea: ['03', 'THE DESIGN'],
  terminal: ['04', 'THE RACE'],
  receipts: ['05', 'THE RECEIPTS'],
  close: ['06', 'CLOSE'],
};

const stageUrl = (scene, seconds) => {
  const [n, t] = CHAPTER[scene] || ['—', scene];
  const q = new URLSearchParams({ s: scene, d: String(seconds), ch: `${n}/09`, t });
  return `${pathToFileURL(path.join(HERE, 'stage.html')).href}?${q}`;
};

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

const authFetch =
  (tok) =>
  async (p, opts = {}) => {
    const r = await fetch(`${API}${p}`, {
      ...opts,
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    });
    return r.json().catch(() => ({}));
  };

// The live session the app tour films. A durable CSMS may hold several; prefer one that is
// actually charging, then anything open, then the newest finished session (the page renders
// both, so the tour never depends on a simulator being mid-flight).
async function pickSession(get) {
  const { sessions = [] } = await get('/sessions');
  const live = sessions.find((s) => s.state === 'CHARGING' || s.state === 'PREPARING');
  if (live) return live.session_id;
  const suspended = sessions.find((s) => s.state === 'SUSPENDED');
  if (suspended) return suspended.session_id;
  return sessions[0]?.session_id;
}

const run = async () => {
  fs.mkdirSync(SEG, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const driver = await token('divya.shankar1@example.in', 'Driver@123');
  const staff = await token('admin@volthub.in', 'Admin@123');
  const asDriver = authFetch(driver);
  const asStaff = authFetch(staff);

  const liveId = await pickSession(asDriver);
  console.log(`live session for the tour: #${liveId}`);

  const results = [];
  for (const seg of timing) {
    if (ONLY.length && !ONLY.includes(seg.id)) continue;
    const d = seg.duration;
    const ctx = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      recordVideo: { dir: SEG, size: { width: 1920, height: 1080 } },
      reducedMotion: 'no-preference',
    });
    const page = await ctx.newPage();
    const t0 = Date.now();
    // Wait until `s` seconds have elapsed in this segment — navigation and network time
    // then eat into the beat instead of stretching the segment past its narration.
    const at = async (s) => {
      const ms = s * 1000 - (Date.now() - t0);
      if (ms > 0) await page.waitForTimeout(ms);
    };
    const goto = (url) => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    console.log(`\n▶ ${seg.id}  ${seg.kind}  ${d.toFixed(2)}s`);
    try {
      if (seg.kind === 'scene') {
        if (seg.scene === 'terminal') await page.addInitScript((t) => (window.__RACE_TEXT__ = t), raceText);
        await goto(stageUrl(seg.scene, d));
        await page.waitForFunction(() => document.fonts?.status === 'loaded', null, { timeout: 8000 }).catch(() => {});
        await at(d);
      } else if (seg.scene === 'app-tour') {
        await goto(`${WEB}/`);
        await page.evaluate((t) => localStorage.setItem('vh_token', t), driver);
        await goto(`${WEB}/discover`);
        await at(7.0);
        await goto(`${WEB}/stations/1`);
        await at(9.0);
        // Reserve the first free connector exactly as a driver would.
        const reserve = page.getByRole('button', { name: /^Reserve$/ });
        if (await reserve.count()) {
          await reserve
            .first()
            .click({ timeout: 4000 })
            .catch(() => {});
        }
        await at(13.5);
        await goto(`${WEB}/session/${liveId}`);
        await at(23.0);
        await goto(`${WEB}/invoices`);
        await at(d);
      } else if (seg.scene === 'wallet') {
        // Film the ceremony from an unlinked state: the connect proof only renders the
        // first time. The link is a real one — it is re-created on camera, not seeded.
        const me = await asDriver('/me/wallet');
        for (const l of me.links || []) await asDriver(`/me/wallet/link/${l.address}`, { method: 'DELETE' });
        await goto(`${WEB}/`);
        await page.evaluate((t) => localStorage.setItem('vh_token', t), driver);
        await goto(`${WEB}/wallet`);
        await at(7.0);
        const connect = page.locator('section.sec').first();
        await connect.scrollIntoViewIfNeeded().catch(() => {});
        await at(9.0);
        await page
          .getByRole('button', { name: /Link wallet/i })
          .click({ timeout: 5000 })
          .catch(() => {});
        await page
          .locator('.w-proof')
          .scrollIntoViewIfNeeded({ timeout: 4000 })
          .catch(() => {});
        await at(21.0);
        const topup = page.locator('section.sec').nth(1);
        await topup.scrollIntoViewIfNeeded().catch(() => {});
        await at(23.0);
        await page
          .locator('.w-chip', { hasText: '500' })
          .first()
          .click({ timeout: 4000 })
          .catch(() => {});
        await at(24.5);
        await page
          .getByRole('button', { name: /^Authorise/i })
          .click({ timeout: 5000 })
          .catch(() => {});
        await at(34.0);
        await page
          .locator('section.sec')
          .nth(2)
          .scrollIntoViewIfNeeded()
          .catch(() => {});
        await at(d);
      } else if (seg.scene === 'operator') {
        await goto(`${WEB}/`);
        await page.evaluate((t) => localStorage.setItem('vh_token', t), staff);
        await goto(`${WEB}/dashboard`);
        await at(7.0);
        await goto(`${WEB}/telemetry`);
        await at(11.0);
        // The utilisation matrix lives below the fold on the telemetry page.
        await page.mouse.wheel(0, 620).catch(() => {});
        await at(17.0);
        await goto(`${WEB}/faults`);
        await at(21.5);
        await goto(`${WEB}/admin`);
        await at(d);
      }
      // Keep the context alive past the narration so the assembler always has material to
      // trim, then pad — never the other way round.
      await at(d + LEAD + 0.6);
      const vid = page.video();
      await page.close();
      await ctx.close();
      const src = await vid.path();
      const dst = path.join(SEG, `${seg.id}.webm`);
      fs.renameSync(src, dst);
      const bytes = fs.statSync(dst).size;
      results.push({ id: seg.id, file: dst, bytes, target: d });
      console.log(`  ✔ ${path.basename(dst)}  ${(bytes / 1e6).toFixed(1)} MB`);
    } catch (e) {
      console.error(`  ✖ ${seg.id}: ${e.message}`);
      await ctx.close().catch(() => {});
      process.exitCode = 1;
    }
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'segments.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length} segment(s) -> ${path.relative(process.cwd(), SEG)}`);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
