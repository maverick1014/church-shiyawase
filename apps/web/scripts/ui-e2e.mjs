#!/usr/bin/env node
/**
 * UI end-to-end test — drives the REAL website through a real browser and
 * asserts each interaction produces its expected outcome. Complements the
 * API-level scripts/api-e2e.mjs with actual user-interface coverage.
 *
 * WHY THE MIRROR: in a locked-down sandbox the browser can't tunnel through the
 * egress proxy, but Node's fetch can. So we run a tiny in-process reverse proxy
 * on 127.0.0.1 that replays every browser request against the target site
 * (cookies and all). The browser only ever talks to localhost. In CI / locally
 * (no egress proxy) this is transparent — Node fetch reaches the target
 * directly. Set UI_E2E_DIRECT=1 to skip the mirror and hit the target straight.
 *
 * RUN:
 *   node scripts/ui-e2e.mjs                       # tests the live Worker
 *   UI_E2E_URL=https://staging... node scripts/ui-e2e.mjs
 *   # in a proxied sandbox, Node fetch needs the proxy + the browser path:
 *   NODE_USE_ENV_PROXY=1 \
 *   PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *   node scripts/ui-e2e.mjs
 *
 * ENV:
 *   UI_E2E_URL       target base URL (default: the tog Worker)
 *   UI_E2E_EMAIL     login email    (default: john@grace.org)
 *   UI_E2E_PASSWORD  login password (REQUIRED — never hardcode a real password)
 *   UI_E2E_DIRECT    "1" → browser hits the target directly (no mirror)
 *   UI_E2E_SHOTS     dir → write a screenshot per module (debugging)
 *   PLAYWRIGHT_CHROMIUM_PATH  explicit Chromium binary (needed in the sandbox)
 *
 * Exits 0 if every check passes, 1 otherwise. Self-cleaning: the one write it
 * performs (create a throwaway member) is deleted again, with an API fallback.
 */
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const TARGET = (process.env.UI_E2E_URL || 'https://tog.tabernacleofgrace-cn.workers.dev').replace(/\/+$/, '');
const EMAIL = process.env.UI_E2E_EMAIL || 'john@grace.org';
const PASSWORD = process.env.UI_E2E_PASSWORD;
const DIRECT = process.env.UI_E2E_DIRECT === '1';

if (!PASSWORD) {
  console.error('UI_E2E_PASSWORD is required (the login password). Set it in the environment — e.g.\n' +
    '  UI_E2E_PASSWORD=… npm run test:ui-e2e\n' +
    'Optionally set UI_E2E_EMAIL (default john@grace.org) and UI_E2E_URL.');
  process.exit(2);
}
const SHOTS = process.env.UI_E2E_SHOTS || '';
const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

/* ------------------------------------------------------------------ mirror */
let server = null;
async function startMirror() {
  server = createServer(async (req, res) => {
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
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(String(e));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

/* ------------------------------------------------------------------ harness */
const results = [];
let currentModule = '?';
function check(name, ok, detail = '') {
  results.push({ module: currentModule, name, ok, detail });
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}\n`);
}

async function main() {
  const BASE = DIRECT ? TARGET : await startMirror();
  console.log(`UI E2E → ${TARGET}${DIRECT ? '' : `  (via mirror ${BASE})`}\n`);

  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 880 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const w = (ms) => page.waitForTimeout(ms);
  const shot = (n) => (SHOTS ? page.screenshot({ path: `${SHOTS}/ui-${n}.png`, fullPage: true }) : Promise.resolve());
  const mod = (m) => { currentModule = m; console.log(`▸ ${m}`); };

  let createdMemberId = null;
  // Restored in `finally` so a mid-run failure can never leave the account
  // parked on a language the operator didn't choose.
  let accountId = null;
  let originalLanguage = null;

  try {
    /* -- login / auth ----------------------------------------------------- */
    mod('login · auth');
    // Submit is triggered by Enter in the field (a bare submit-button .click()
    // doesn't fire this form's onSubmit reliably). Type character-by-character
    // so the controlled inputs commit, then retry the whole flow a few times —
    // the login POST goes over the network so an occasional miss is expected.
    let loggedIn = false;
    for (let attempt = 1; attempt <= 4 && !loggedIn; attempt++) {
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
      await page.locator('input[type=email]').click();
      await page.locator('input[type=email]').pressSequentially(EMAIL, { delay: 12 });
      await page.locator('input[type=password]').click();
      await page.locator('input[type=password]').pressSequentially(PASSWORD, { delay: 12 });
      await w(200);
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/auth/login'), { timeout: 20000 }).catch(() => null),
        page.locator('input[type=password]').press('Enter'),
      ]);
      if (resp && resp.status() === 200) {
        loggedIn = await page.locator('h1:has-text("Dashboard")').waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
      }
      if (!loggedIn) await w(800);
    }
    check('submitting the login form lands on the dashboard', loggedIn);
    if (!loggedIn) throw new Error('login failed — aborting remaining checks');
    const sidebar = await page.locator('.sidebar').innerText();
    check(
      'sidebar lists every module + Users (super admin only)',
      ['Members', 'Life Groups', 'Events & Attendance', 'Trainings', 'Forty Days', 'Users']
        .every((label) => sidebar.includes(label)),
    );
    await shot('01-dashboard');

    /* -- member directory ------------------------------------------------- */
    mod('members');
    await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
    await page.locator('.mtile').first().waitFor({ timeout: 20000 });
    const total = await page.locator('.mtile').count();
    // Member names are data, not UI copy, so they stay Chinese whatever the
    // interface language is — search still has to match them.
    await page.fill('input[placeholder*="Search"]', '陈');
    await w(600);
    check('the search box filters the list live', total > 0 && (await page.locator('.mtile').count()) < total, `${total} → filtered`);
    await page.fill('input[placeholder*="Search"]', '');
    await w(300);
    // Identity + group are <select> filters. Scope to the page bar's filter
    // half — the shell hall switcher is also a <select> and comes first in
    // the DOM.
    const filters = page.locator('.page-bar-filters select');
    // The value is the language-independent DisplayRole code, not a label.
    await filters.first().selectOption('pastor');
    await w(500);
    check('the identity filter narrows the list', (await page.locator('.mtile').count()) < total);
    // Export is icon-only now, so identify it by its accessible name.
    check('the export button is present', (await page.locator('button[aria-label*="Export"]').count()) > 0);
    await filters.first().selectOption('all');
    await w(300);
    // Group filter = second filter select; drive its first real option (index 1).
    const groupVal = await filters.nth(1).locator('option').nth(1).getAttribute('value');
    if (groupVal) {
      await filters.nth(1).selectOption(groupVal);
      await w(400);
      check('the life-group filter narrows the list', (await page.locator('.mtile').count()) <= total);
      await filters.nth(1).selectOption('all');
      await w(300);
    }
    await shot('02-members');

    /* -- member detail ---------------------------------------------------- */
    mod('member detail');
    await page.locator('.mtile').first().click();
    await page.waitForURL(/\/members\/[0-9a-f-]+/, { timeout: 15000 });
    await page.locator('button:has-text("Edit profile")').first().waitFor({ timeout: 15000 });
    await page.locator('button:visible:has-text("Edit profile")').first().click();
    await page.locator('.modal').waitFor({ timeout: 8000 });
    check('the edit-profile modal opens', true);
    await page.locator('.modal button:has-text("Cancel")').first().click();
    await w(300);
    check('the modal closes again', (await page.locator('.modal').count()) === 0);
    await shot('03-member-detail');

    /* -- life groups ------------------------------------------------------ */
    mod('life groups · list · detail · weekly attendance');
    await page.goto(`${BASE}/groups`, { waitUntil: 'domcontentloaded' });
    // Mobile viewport → the groups list renders as .mtile tiles (the desktop
    // table is .only-desktop / hidden). Each tile navigates to its detail page.
    await page.locator('.mtile').first().waitFor({ timeout: 20000 });
    const groupTiles = await page.locator('.mtile').count();
    check('the group list renders', groupTiles > 0);
    // The weekly-attendance grid only has rows for a group that HAS members, so
    // open one that reports a non-zero count rather than whatever sorts first —
    // an empty group is a perfectly normal state and must not fail the suite.
    //
    // The counts come from a second fetch (/members) than the list itself, so
    // every tile reads "0 members" for a moment after the list paints — wait for
    // the real numbers before scanning, or this always picks the wrong group.
    const POPULATED = /\b[1-9]\d*\s+members\b/;
    await page
      .waitForFunction(
        () => /\b[1-9]\d*\s+members\b/.test(document.body.innerText),
        null,
        { timeout: 15000 },
      )
      .catch(() => {});
    let populatedTile = -1;
    for (let i = 0; i < groupTiles; i++) {
      if (POPULATED.test(await page.locator('.mtile').nth(i).innerText())) {
        populatedTile = i;
        break;
      }
    }
    if (populatedTile < 0) {
      check('a group with members exists to open', false, 'every group is empty — weekly attendance not covered');
    } else {
      await page.locator('.mtile').nth(populatedTile).click();
      await page.waitForURL(/\/groups\/[0-9a-f-]+/, { timeout: 15000 });
      await page.locator('text=Leadership trio').first().waitFor({ timeout: 15000 });
      check('group detail shows the leadership trio', true);
      check('the leadership assignment dropdowns are present', (await page.locator('select.sm').count()) > 0);
      check('the year / month selects are present', (await page.locator('select').count()) >= 2);
      await page.locator('th:has-text("Week")').first().waitFor({ timeout: 20000 });
      check('weekly attendance renders a column per Sunday', (await page.locator('th:has-text("Week")').count()) > 0,
        `${await page.locator('th:has-text("Week")').count()} weeks`);
      check('weekly attendance has tick boxes', (await page.locator('input[type=checkbox]').count()) > 0);
    }
    await shot('04-group-detail');

    /* -- events & attendance ---------------------------------------------- */
    mod('events & attendance');
    await page.goto(`${BASE}/events`, { waitUntil: 'domcontentloaded' });
    await page.locator('button:has-text("Roll call")').first().waitFor({ timeout: 20000 });
    await page.locator('button:visible:has-text("Roll call")').first().click();
    await page.locator('.modal').waitFor({ timeout: 8000 });
    check('roll call opens the attendance modal', true);
    await page.locator('.modal .icon-btn, .modal button:has-text("Close")').first().click();
    await w(300);
    await page.locator('button:visible:has-text("Edit")').first().click();
    await page.locator('.modal').waitFor({ timeout: 8000 });
    check('the event edit modal opens', true);
    await page.locator('.modal button:has-text("Cancel")').first().click();
    await shot('05-events');

    /* -- trainings -------------------------------------------------------- */
    mod('trainings · detail');
    await page.goto(`${BASE}/trainings`, { waitUntil: 'domcontentloaded' });
    await page.locator('.card h3').first().waitFor({ timeout: 20000 });
    await page.locator('.card h3').first().click();
    await page.waitForURL(/\/trainings\/[0-9a-f-]+/, { timeout: 15000 });
    await page.locator('.card-head h3:has-text("Sessions")').first().waitFor({ timeout: 15000 });
    check('training detail shows the session list', true);
    check('training detail shows the attendance sheet', (await page.locator('text=Attendance sheet').count()) > 0);
    await shot('06-training-detail');

    /* -- forty days ------------------------------------------------------- */
    mod('forty days · progress dialog');
    await page.goto(`${BASE}/discipleship`, { waitUntil: 'domcontentloaded' });
    await page.locator('.chip', { hasText: 'Active' }).first().waitFor({ timeout: 20000 });
    await page.locator('.chip', { hasText: 'Completed' }).first().click();
    await w(400);
    await page.locator('.chip', { hasText: 'Active' }).first().click();
    await w(400);
    check('the relay chart state filter switches', true);
    await page.locator('.mtile').first().click();
    await page.locator('.modal .day-cell').first().waitFor({ timeout: 15000 });
    check('opening a pair shows the 40-day grid', (await page.locator('.modal .day-cell').count()) >= 40);
    await page.locator('.modal .day-cell').first().click();
    await w(400);
    check("clicking a day shows that day's entry", /Day\s*1\b/.test(await page.locator('.modal').innerText()));
    await shot('07-pair-modal');
    await page.locator('.modal .icon-btn').first().click();
    await w(300);
    check('✕ closes the dialog', (await page.locator('.modal').count()) === 0);

    /* -- user management -------------------------------------------------- */
    mod('user management');
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    // The page action renders twice (topbar + content actions) with CSS deciding
    // which one shows, so this must target the visible one — .first() is the
    // topbar copy, which is display:none at this viewport and never "appears".
    await page.locator('button:visible:has-text("New account")').first().waitFor({ timeout: 20000 });
    const settingsBody = await page.locator('body').innerText();
    check('the user list loads (not the login page)', settingsBody.includes('New account'));
    // Permission roles now live behind an info icon rather than an always-open card.
    await page.locator('button[aria-label="Permission roles"]').first().click();
    await w(300);
    check('the info icon expands the permission matrix', (await page.locator('.info-pop-body').count()) > 0);
    // Unpin AND move the pointer away — the popover also stays open on hover,
    // and it overlays the top of the list underneath it.
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await w(300);
    // The account list is .mtile tiles at this (mobile) viewport, like the groups list.
    await page.locator('.mtile').first().click();
    await page.locator('button:has-text("Save account settings")').waitFor({ timeout: 10000 });
    check('an account detail page opens', true);
    await shot('08-settings');

    /* -- chrome layout is the same on every list page --------------------- */
    // The bug this guards: the congregation switcher used to sit in the same
    // stretch-to-fill row as each page's own buttons, so the top of every list
    // page wrapped differently depending on how many buttons it happened to
    // have. The switcher belongs to the shell, not the page.
    mod('page chrome consistency');
    // The switcher only renders for an account that can actually see more than
    // one congregation, so only demand the drawer copy when one is expected.
    const halls = await (await ctx.request.get(`${BASE}/api/halls`)).json();
    const expectSwitcher = Array.isArray(halls) && halls.length > 1;

    const LIST_PAGES = ['/members', '/groups', '/events', '/trainings', '/discipleship', '/settings'];
    const strays = [];
    const missingDrawerHall = [];
    const noBar = [];
    const barShape = [];
    for (const path of LIST_PAGES) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
      // The h1 belongs to the shell and renders immediately, while the page
      // body is still <Loading />. Waiting on it would count zero page bars
      // everywhere — wait for the bar itself.
      const barReady = await page
        .locator('.page-bar')
        .first()
        .waitFor({ state: 'attached', timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      // Every list page's top row is one shared PageBar: filters left, the
      // page's own buttons right. A select in the actions half means a filter
      // leaked into the button group (or the switcher was rendered by a page).
      if ((await page.locator('.page-bar-actions select').count()) > 0) strays.push(path);
      const bars = barReady ? await page.locator('.page-bar').count() : 0;
      if (bars !== 1) noBar.push(`${path} (${bars})`);
      // Actions must be the last child of the bar so they land on the right
      // (desktop) / at the bottom (stacked mobile).
      const actionsLast = await page
        .locator('.page-bar > :last-child')
        .evaluate((el) => el.classList.contains('page-bar-actions'))
        .catch(() => false);
      const hasActions = (await page.locator('.page-bar-actions').count()) > 0;
      if (hasActions && !actionsLast) barShape.push(path);
      // …and the switcher lives in the nav drawer instead. It renders only once
      // /api/halls has resolved, which is after the page's own h1, so wait for
      // it rather than reading an empty drawer and calling it a regression.
      if (expectSwitcher) {
        const inDrawer = await page
          .locator('.sidebar .nav-hall select')
          .waitFor({ state: 'attached', timeout: 15000 })
          .then(() => true)
          .catch(() => false);
        if (!inDrawer) missingDrawerHall.push(path);
      }
    }
    check('no page mixes a dropdown into its own action row',
      strays.length === 0, strays.join(', ') || 'all clean');
    check('every list page has exactly one shared page bar',
      noBar.length === 0, noBar.join(', ') || `1 on each of ${LIST_PAGES.length}`);
    check('the action group is the last thing in the page bar',
      barShape.length === 0, barShape.join(', ') || 'right-aligned everywhere');
    check('the congregation switcher sits in the nav drawer on mobile',
      missingDrawerHall.length === 0,
      expectSwitcher ? missingDrawerHall.join(', ') || 'present on every page' : 'single congregation — n/a');

    /* -- interface language ----------------------------------------------- */
    mod('interface language');
    // The language is a per-account setting, so switch this account's own and
    // confirm the whole shell re-renders in it (then switch straight back).
    const meRes = await ctx.request.get(`${BASE}/api/auth/me`);
    const me = await meRes.json();
    accountId = me.id;
    originalLanguage = me.language;
    check('/api/auth/me reports the account language', typeof me.language === 'string', String(me.language));

    const setLang = (lang) =>
      ctx.request.patch(`${BASE}/api/accounts/${accountId}`, { data: { language: lang } });

    await setLang('zh');
    await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
    await page.locator('h1').first().waitFor({ timeout: 20000 });
    check('switching to 简体中文 re-renders the UI in Chinese',
      (await page.locator('h1').first().innerText()).includes('成员'));

    await setLang('ms');
    await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
    await page.locator('h1').first().waitFor({ timeout: 20000 });
    check('switching to Bahasa Melayu re-renders the UI in Malay',
      (await page.locator('.sidebar').innerText()).includes('Kumpulan Sel'));

    const badLang = await ctx.request.patch(`${BASE}/api/accounts/${accountId}`, { data: { language: 'fr' } });
    check('the server rejects an unsupported language', badLang.status() === 400, `status ${badLang.status()}`);

    await setLang(originalLanguage);
    originalLanguage = null; // restored — nothing left for the finally block
    await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
    await page.locator('h1').first().waitFor({ timeout: 20000 });
    check('switching back restores the original language',
      (await page.locator('.sidebar').innerText()).includes('Life Groups'));
    await shot('09-language');

    /* -- write cycle: create + delete a member (self-cleaning) ------------- */
    mod('write cycle · create / delete a member');
    const testName = 'ZZ_UITEST_' + String(Date.now()).slice(-7);
    await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
    await page.locator('button:visible:has-text("Add member")').first().waitFor({ timeout: 20000 });
    await page.locator('button:visible:has-text("Add member")').first().click();
    await page.locator('.modal').waitFor({ timeout: 8000 });
    await page.locator('.modal input').first().fill(testName);
    // The congregation is required and is the modal's first <select>. A
    // full-access account viewing all halls starts with none chosen, so pick
    // the first real one.
    const hallSel = page.locator('.modal select').first();
    const hallOpt = await hallSel.locator('option').nth(1).getAttribute('value');
    if (hallOpt) await hallSel.selectOption(hallOpt);
    await page.locator('.modal button:has-text("Save")').first().click();
    await w(1800);
    await page.fill('input[placeholder*="Search"]', testName);
    await w(700);
    const created = (await page.locator(`.mtile:has-text("${testName}")`).count()) > 0;
    check('creating a member through the UI adds it to the list', created);

    if (created) {
      // capture id for API-fallback cleanup
      await page.locator(`.mtile:has-text("${testName}")`).first().click();
      await page.waitForURL(/\/members\/[0-9a-f-]+/, { timeout: 15000 });
      createdMemberId = page.url().match(/\/members\/([0-9a-f-]+)/)?.[1] ?? null;
      await page.locator('button:visible:has-text("Delete")').first().click();
      await page.locator('.modal-backdrop').waitFor({ timeout: 8000 });
      await page.locator('.modal-backdrop button:has-text("Delete")').last().click();
      await w(1800);
      await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
      await w(1500);
      await page.fill('input[placeholder*="Search"]', testName);
      await w(700);
      const gone = (await page.locator(`.mtile:has-text("${testName}")`).count()) === 0;
      check('deleting it through the UI removes it from the list', gone);
      if (gone) createdMemberId = null; // cleaned via UI
    }
  } catch (e) {
    check('the run aborted', false, e.message.split('\n')[0]);
  } finally {
    // Put the account's language back if the run died mid-switch.
    if (accountId && originalLanguage) {
      await ctx.request
        .patch(`${BASE}/api/accounts/${accountId}`, { data: { language: originalLanguage } })
        .catch(() => {});
      console.log(`  ↳ cleanup: restored account language to ${originalLanguage}`);
    }
    // API-fallback cleanup: if the throwaway member survived, delete it.
    if (createdMemberId) {
      await ctx.request.delete(`${BASE}/api/members/${createdMemberId}`).catch(() => {});
      console.log(`  ↳ cleanup: deleted leftover test member ${createdMemberId}`);
    }
    await browser.close();
    if (server) server.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n==== UI E2E: ${passed} passed, ${failed} failed ====`);
  if (failed) {
    console.log('failed checks:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ [${r.module}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('UI E2E crashed:', e); process.exit(1); });
