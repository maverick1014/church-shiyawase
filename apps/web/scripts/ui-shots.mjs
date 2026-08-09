#!/usr/bin/env node
/**
 * UI screenshot sweep — logs in and captures every list page at a phone and a
 * desktop viewport, so a change can be REVIEWED rather than just asserted.
 *
 * scripts/ui-e2e.mjs proves the pages work; it cannot see that two pages lay
 * their header out differently. Run this after any layout change and actually
 * look at the output.
 *
 * RUN (this sandbox):
 *   NODE_USE_ENV_PROXY=1 \
 *   PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *   UI_E2E_PASSWORD=… npm run ui:shots            # phone
 *   … WIDE=1 npm run ui:shots                     # desktop
 *
 * ENV: UI_E2E_URL / UI_E2E_EMAIL / UI_E2E_PASSWORD (as scripts/ui-e2e.mjs),
 *      OUT (default /tmp/shots), WIDE=1 for the 1280px viewport.
 *
 * It only reads — no data is created or changed.
 */
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const TARGET = (process.env.UI_E2E_URL || 'https://tog.tabernacleofgrace-cn.workers.dev').replace(/\/+$/, '');
const EMAIL = process.env.UI_E2E_EMAIL || 'john@grace.org';
const PASSWORD = process.env.UI_E2E_PASSWORD;
const OUT = process.env.OUT || '/tmp/shots';
const WIDE = process.env.WIDE === '1';

if (!PASSWORD) {
  console.error('UI_E2E_PASSWORD is required (the login password).');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const server = createServer(async (req, res) => {
  try {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) continue;
      headers[k] = v;
    }
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = chunks.length ? Buffer.concat(chunks) : undefined;
    }
    const r = await fetch(TARGET + req.url, { method: req.method, headers, body, redirect: 'manual' });
    const out = {};
    r.headers.forEach((v, k) => {
      if (['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie', 'strict-transport-security'].includes(k)) return;
      out[k] = v;
    });
    if (out.location) out.location = out.location.replace(TARGET, '');
    const cookies = r.headers.getSetCookie?.() ?? [];
    if (cookies.length) out['set-cookie'] = cookies.map((c) => c.replace(/;\s*Secure/gi, ''));
    res.writeHead(r.status, out);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502); res.end(String(e));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: WIDE ? { width: 1280, height: 900 } : { width: 402, height: 880 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
page.setDefaultTimeout(25000);

// The login POST goes over the network, so an occasional miss is expected.
let loggedIn = false;
for (let attempt = 1; attempt <= 4 && !loggedIn; attempt++) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=email]').click();
  await page.locator('input[type=email]').pressSequentially(EMAIL, { delay: 12 });
  await page.locator('input[type=password]').click();
  await page.locator('input[type=password]').pressSequentially(PASSWORD, { delay: 12 });
  await page.waitForTimeout(200);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/login'), { timeout: 20000 }).catch(() => null),
    page.locator('input[type=password]').press('Enter'),
  ]);
  if (resp && resp.status() === 200) {
    loggedIn = await page.locator('h1').first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  }
  if (!loggedIn) await page.waitForTimeout(800);
}
if (!loggedIn) throw new Error('login failed');

const pages = [
  ['members', '/members'],
  ['groups', '/groups'],
  ['events', '/events'],
  ['trainings', '/trainings'],
  ['discipleship', '/discipleship'],
  ['settings', '/settings'],
  ['church', '/church'],
];
for (const [name, path] of pages) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.locator('h1').first().waitFor();
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `${OUT}/${WIDE ? 'wide' : 'm'}-${name}.png` });
}

if (!WIDE) {
  // Drawer open, to show the congregation switcher above Dashboard.
  await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
  await page.locator('h1').first().waitFor();
  await page.waitForTimeout(1500);
  await page.locator('.hamburger').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/m-drawer.png` });
}

await browser.close();
server.close();
console.log('shots written to', OUT);
