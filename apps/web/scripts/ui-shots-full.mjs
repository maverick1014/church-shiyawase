#!/usr/bin/env node
/**
 * Extended screenshot sweep for a full visual review pass — every list page
 * PLUS the detail/inner pages this session's batch of work actually touched
 * (dashboard, member detail, group detail w/ attendance, an activity and a
 * course training, discipleship, happiness term/group), at a phone and a
 * desktop viewport. Read-only, like scripts/ui-shots.mjs.
 *
 * RUN (this sandbox):
 *   NODE_USE_ENV_PROXY=1 \
 *   PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *   UI_E2E_PASSWORD=… node scripts/ui-shots-full.mjs            # phone
 *   … WIDE=1 node scripts/ui-shots-full.mjs                     # desktop
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

let loggedIn = false;
for (let attempt = 1; attempt <= 5 && !loggedIn; attempt++) {
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
  if (!loggedIn) await page.waitForTimeout(1000);
}
if (!loggedIn) throw new Error('login failed');

// Real, live IDs — found via direct DB lookups earlier this session so the
// shots show populated content rather than empty states.
const get = (path) => ctx.request.get(`${BASE}/api${path}`).then((r) => r.json());
const groups = await get('/groups').catch(() => []);
const rosteredGroup = groups.find((g) => (g.member_count ?? 0) > 0) ?? groups[0];
const members = await get('/members?q=林').catch(() => []);
const traineeMember = members[0];
const trainings = await get('/trainings').catch(() => []);
const course = trainings.find((t) => t.kind === 'course');
const activity = trainings.find((t) => t.kind === 'activity');
const happyTerms = await get('/happiness/terms').catch(() => []);
const term = happyTerms[0];
const happyGroups = term ? await get(`/happiness/groups?term_id=${term.id}`).catch(() => []) : [];
const happyGroup = happyGroups[0];

const pages = [
  ['dashboard', '/'],
  ['members', '/members'],
  ...(traineeMember ? [['member-detail', `/members/${traineeMember.id}`]] : []),
  ['groups', '/groups'],
  ...(rosteredGroup ? [['group-detail', `/groups/${rosteredGroup.id}`]] : []),
  ['events', '/events'],
  ['trainings', '/trainings'],
  ...(course ? [['training-course', `/trainings/${course.id}`]] : []),
  ...(activity ? [['training-activity', `/trainings/${activity.id}`]] : []),
  ['discipleship', '/discipleship'],
  ['happiness', '/happiness'],
  ...(term ? [['happiness-term', `/happiness/${term.id}`]] : []),
  ...(happyGroup ? [['happiness-group', `/happiness/group/${happyGroup.id}`]] : []),
  ['settings', '/settings'],
  ['church', '/church'],
];

console.log(`capturing ${pages.length} pages at ${WIDE ? 'desktop 1280px' : 'phone 402px'}`);
for (const [name, path] of pages) {
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.locator('h1').first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/${WIDE ? 'wide' : 'm'}-${name}.png`, fullPage: true });
    console.log('  ✓', name);
  } catch (e) {
    console.log('  ✗', name, String(e).slice(0, 150));
  }
}

if (!WIDE) {
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
