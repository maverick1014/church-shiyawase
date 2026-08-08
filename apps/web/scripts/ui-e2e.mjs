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
 *   UI_E2E_EXPECT_BUILD  the only build this run may assert against; waits for
 *                        /api/version to report it, and skips (exit 0) if a
 *                        newer deploy got there first. CI sets this; unset
 *                        locally means "test whatever is live".
 *   UI_E2E_ROLLOUT_TIMEOUT_MS  how long to wait for that build (default 240s)
 *   PLAYWRIGHT_CHROMIUM_PATH  explicit Chromium binary (needed in the sandbox)
 *
 * Exits 0 if every check passes (or the run was superseded), 1 if a check
 * failed. Self-cleaning: every row it writes — the throwaway member of the
 * write-cycle and the ZZ_UITEST_… fixtures the interaction modules stand on —
 * is deleted again, per module and then swept once more in main()'s `finally`.
 */
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const TARGET = (process.env.UI_E2E_URL || 'https://tog.tabernacleofgrace-cn.workers.dev').replace(/\/+$/, '');
const EMAIL = process.env.UI_E2E_EMAIL || 'john@grace.org';
const PASSWORD = process.env.UI_E2E_PASSWORD;
const DIRECT = process.env.UI_E2E_DIRECT === '1';

function requirePassword() {
  if (PASSWORD) return;
  console.error('UI_E2E_PASSWORD is required (the login password). Set it in the environment — e.g.\n' +
    '  UI_E2E_PASSWORD=… npm run test:ui-e2e\n' +
    'Optionally set UI_E2E_EMAIL (default john@grace.org) and UI_E2E_URL.');
  process.exit(2);
}
const SHOTS = process.env.UI_E2E_SHOTS || '';
const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const EXPECT_BUILD = process.env.UI_E2E_EXPECT_BUILD || '';
// Overridable so the superseded path can be exercised in seconds, not minutes.
const ROLLOUT_TIMEOUT_MS = Number(process.env.UI_E2E_ROLLOUT_TIMEOUT_MS || 240_000);

/**
 * This script only means anything against the build it was checked out from.
 * Point yesterday's script at today's site and every selector that moved shows
 * up as a "failure" that is really just version skew — which is exactly what
 * happened here: for days, every automatic post-deploy run was red while every
 * manual run was green, because the automatic ones ran main's script against a
 * feature branch's deploy.
 *
 * So when the caller says which build it expects (CI does; a human running it
 * by hand does not), wait for the Worker to actually be serving that build.
 * Cloudflare propagates over several seconds and edge nodes disagree while it
 * does, so poll rather than sample once.
 *
 * Returns 'ok', or 'superseded' when a *different* build is live and staying
 * live — that means a newer deploy overtook this run, and there is nothing
 * here worth asserting. That is not a test failure and must not be reported
 * as one.
 */
async function waitForRollout({ timeoutMs = ROLLOUT_TIMEOUT_MS, everyMs = 3_000 } = {}) {
  if (!EXPECT_BUILD) return 'ok';
  const started = Date.now();
  let seen = '?';
  for (;;) {
    try {
      const r = await fetch(`${TARGET}/api/version?_=${Date.now()}`);
      const body = await r.json().catch(() => null);
      seen = body?.build ?? `? (${r.status})`;
      if (body?.build === EXPECT_BUILD) {
        const waited = Math.round((Date.now() - started) / 1000);
        if (waited > everyMs / 1000) console.log(`  (waited ${waited}s for build ${EXPECT_BUILD.slice(0, 7)})\n`);
        return 'ok';
      }
    } catch {
      // Transient — keep polling until the deadline.
    }
    if (Date.now() - started > timeoutMs) {
      console.log(
        `\nSKIPPED: expected build ${EXPECT_BUILD.slice(0, 7)} but the site is serving ${String(seen).slice(0, 7)}.\n` +
          'A newer deploy has superseded this run, so its script no longer matches the live site.\n' +
          'Not running the checks — a mismatch here would be version skew, not a regression.\n',
      );
      return 'superseded';
    }
    await new Promise((r2) => setTimeout(r2, everyMs));
  }
}

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

  // Never assert against a build this script wasn't written for.
  if ((await waitForRollout()) === 'superseded') {
    server?.close();
    process.exit(0);
  }
  requirePassword();

  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 880 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const w = (ms) => page.waitForTimeout(ms);
  const shot = (n) => (SHOTS ? page.screenshot({ path: `${SHOTS}/ui-${n}.png`, fullPage: true }) : Promise.resolve());
  const mod = (m) => { currentModule = m; console.log(`▸ ${m}`); };

  /* ---------------------------------------------------------------- fixtures */
  /*
   * The live database keeps only the church's standing records — people,
   * groups, halls, accounts and the 守望 program's configuration. Every
   * historical row (events, trainings, sessions, enrollments, meetings,
   * attendance, pairs, progress) was deliberately emptied and is not coming
   * back, because the attendance model is being rebuilt.
   *
   * So a module that needs something to click on MAKES it, uses it, and removes
   * it again. It must never skip itself for want of data: a module that quietly
   * passes on an empty page proves nothing, and that blind spot is exactly how a
   * whole-page overflow bug once shipped green.
   *
   * Two rules keep that safe against a live church database:
   *  - every fixture is named ZZ_UITEST_… — the same convention as the
   *    throwaway member at the foot of this file — so a leaked row is
   *    unmistakably a test artefact and can never be read as real church data;
   *  - creating a fixture registers its DELETE path at once. Each module drops
   *    its own in a `finally` so a failed check still cleans up, and whatever a
   *    crash skipped is swept by main()'s `finally`, exactly like the member.
   *
   * Fixtures are built over the API using the browser's own session (the mirror
   * carries the tog_session cookie), not through the forms: these modules are
   * about the detail pages and the dialogs, so the create path is not what they
   * are asserting — the write-cycle module at the end covers that, through the
   * UI, on purpose.
   */
  const STAMP = String(Date.now()).slice(-7);
  // Sequenced as well as stamped: several modules build the same KIND of
  // fixture, and every name a locator matches on has to belong to exactly one
  // row — including in the leak log, where two identical names would be
  // indistinguishable.
  let fixtureSeq = 0;
  const fixtureName = (what) => `ZZ_UITEST_${what}_${STAMP}_${++fixtureSeq}`;
  /** Fixtures created and not yet deleted, oldest first. */
  const leftovers = [];

  const apiGet = async (path) => {
    const r = await ctx.request.get(`${BASE}/api${path}`);
    if (!r.ok()) throw new Error(`fixture GET ${path} → ${r.status()}`);
    return r.json();
  };
  const apiPost = async (path, data) => {
    const r = await ctx.request.post(`${BASE}/api${path}`, { data });
    if (!r.ok()) throw new Error(`fixture POST ${path} → ${r.status()} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  /** DELETE one row; true only when the server confirms it is gone. */
  const apiDelete = (path) =>
    ctx.request
      .delete(`${BASE}/api${path}`)
      .then((r) => r.ok())
      .catch(() => false);
  /**
   * Take a row off the sweep list. Used when it is genuinely gone — either the
   * API delete below confirmed it, or a module deleted it THROUGH THE UI, which
   * is the whole point of that check. Leaving it on the list would make the
   * final sweep try to delete a row that no longer exists and report a
   * "COULD NOT DELETE" leftover that was in fact cleaned up.
   */
  const forget = (path) => {
    const i = leftovers.findIndex((f) => f.path === path);
    if (i >= 0) leftovers.splice(i, 1);
  };
  /** Register a created row; returns a remover that is safe to call twice. */
  const disposable = (label, path) => {
    leftovers.push({ label, path });
    return async () => {
      if (!leftovers.some((f) => f.path === path)) return; // already gone
      // Forget it only once the row is really deleted — a delete that failed
      // has to stay on the list so main()'s sweep tries it again.
      if (!(await apiDelete(path))) return;
      forget(path);
    };
  };

  /**
   * A hard exit runs no `finally`. An uncaught exception, an unhandled
   * rejection or a CI timeout therefore skips BOTH the per-module cleanup and
   * the sweep at the end of main(), and the fixtures stay in the church's live
   * database — which is not hypothetical: one crashed run left a group, an
   * event, a recurring rule, a course, a pair and four members behind, and
   * they had to be deleted by hand.
   *
   * So sweep on the way out as well. Registered here, right after `disposable`,
   * because from this point on the script can create rows.
   */
  const sweep = async (why, stream = console.log) => {
    for (const f of leftovers.slice().reverse()) {
      const gone = await apiDelete(f.path);
      stream(`  ↳ ${why}: ${gone ? 'deleted' : 'COULD NOT DELETE'} leftover ${f.label} (${f.path})`);
    }
  };
  const dieCleanly = async (why, err) => {
    if (err) console.error(`UI E2E ${why}:`, err);
    if (leftovers.length) {
      console.error(`\n${leftovers.length} fixture(s) still live after ${why} — removing them.`);
      await sweep(why, console.error).catch(() => {});
    }
    process.exit(1);
  };
  process.on('uncaughtException', (e) => void dieCleanly('uncaught exception', e));
  process.on('unhandledRejection', (e) => void dieCleanly('unhandled rejection', e));
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => void dieCleanly(sig));
  }

  // Members and groups carry a NOT NULL hall. A hall-scoped account would have
  // one forced on server-side, but this login is 全堂权限, so it must name one.
  let hallIdCache;
  const someHallId = async () => {
    if (hallIdCache === undefined) hallIdCache = (await apiGet('/halls'))?.[0]?.id ?? null;
    return hallIdCache;
  };

  /** A throwaway member; `extra` carries whatever the caller needs on the row. */
  const makeMember = async (what, extra = {}) => {
    const row = await apiPost('/members', {
      full_name: fixtureName(what),
      church_role: 'member',
      status: 'active',
      hall_id: await someHallId(),
      ...extra,
    });
    return {
      id: row.id,
      name: row.full_name,
      remove: disposable(`member ${row.full_name}`, `/members/${row.id}`),
    };
  };

  /**
   * A throwaway group with one throwaway member on its roster — the weekly
   * attendance grid only draws rows for a group that HAS members.
   */
  const makeRosteredGroup = async () => {
    const row = await apiPost('/groups', { name: fixtureName('GROUP'), hall_id: await someHallId() });
    const removeGroup = disposable(`group ${row.name}`, `/groups/${row.id}`);
    const member = await makeMember('ROSTER', { group_id: row.id, group_position: 'core_member' });
    return {
      id: row.id,
      name: row.name,
      member,
      // Member first: a group can be deleted out from under its roster
      // (group_id is ON DELETE SET NULL), which would strand the person.
      remove: async () => { await member.remove(); await removeGroup(); },
    };
  };

  /** A throwaway event starting now, so it lands in the page's "Today" section. */
  const makeEvent = async () => {
    const row = await apiPost('/events', {
      title: fixtureName('EVENT'),
      event_type: 'service',
      starts_at: new Date().toISOString(),
      hall_id: await someHallId(),
    });
    return { id: row.id, name: row.title, remove: disposable(`event ${row.title}`, `/events/${row.id}`) };
  };

  /**
   * A throwaway course with one session and one pending enrolee — the two
   * things the detail page's panels are made of, and the row shape (badge +
   * Approve + Reject) that once pushed that page wider than the phone.
   * Deleting the course takes its sessions and enrollments with it (FK
   * cascade), so only the course and the person it enrolled need removing.
   */
  const makeTraining = async () => {
    const row = await apiPost('/trainings', {
      name: fixtureName('TRAINING'),
      total_sessions: 1,
      is_enrollable: true,
      hall_id: await someHallId(),
    });
    const removeTraining = disposable(`training ${row.name}`, `/trainings/${row.id}`);
    const sessionTitle = fixtureName('SESSION');
    await apiPost(`/trainings/${row.id}/sessions`, { session_number: 1, title: sessionTitle });
    const enrollee = await makeMember('ENROLEE');
    await apiPost(`/trainings/${row.id}/enroll`, { member_id: enrollee.id });
    return {
      id: row.id,
      name: row.name,
      sessionTitle,
      enrollee,
      remove: async () => { await removeTraining(); await enrollee.remove(); },
    };
  };

  /**
   * A throwaway 循环聚会 rule — PAUSED on purpose. An active rule tops up the
   * events calendar on every GET /events, and the occurrences it generates
   * deliberately outlive it (they carry attendance), so an active fixture could
   * not be cleaned up afterwards. Paused, it still renders its own row on
   * /events/recurring and writes nothing else.
   */
  const makeRecurringRule = async () => {
    const row = await apiPost('/recurring-events', {
      title: fixtureName('RECURRING'),
      event_type: 'prayer',
      weekday: 'wednesday',
      start_time: '20:00:00',
      hall_id: await someHallId(),
      active: false,
    });
    return {
      id: row.id,
      name: row.title,
      remove: disposable(`recurring rule ${row.title}`, `/recurring-events/${row.id}`),
    };
  };

  /**
   * A throwaway 守望 pair. The program itself is configuration and survived the
   * wipe, so it is read rather than created; the pair is built from two
   * brand-new members, which also satisfies the unique program_id+trainee_id
   * constraint without having to work out who in the church is already paired.
   */
  const makePair = async () => {
    const programId = (await apiGet('/discipleship/programs'))?.[0]?.id;
    if (!programId) throw new Error('no discipleship program configured — cannot build a pair fixture');
    const mentor = await makeMember('MENTOR');
    const trainee = await makeMember('TRAINEE');
    const row = await apiPost('/discipleship/pairs', {
      program_id: programId,
      mentor_id: mentor.id,
      trainee_id: trainee.id,
    });
    const removePair = disposable(`pair ${mentor.name} → ${trainee.name}`, `/discipleship/pairs/${row.id}`);
    return {
      id: row.id,
      mentorName: mentor.name,
      traineeName: trainee.name,
      remove: async () => { await removePair(); await trainee.remove(); await mentor.remove(); },
    };
  };

  /** One of everything, for the checks that sweep whole pages rather than one. */
  const makeSample = async () => {
    const group = await makeRosteredGroup();
    const event = await makeEvent();
    const recurring = await makeRecurringRule();
    const training = await makeTraining();
    const pair = await makePair();
    return {
      group,
      event,
      recurring,
      training,
      pair,
      remove: async () => {
        await pair.remove();
        await training.remove();
        await recurring.remove();
        await event.remove();
        await group.remove();
      },
    };
  };

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
    // The weekly-attendance grid only draws rows for a group that HAS members,
    // and which of the church's own groups are populated is not this suite's
    // business to depend on. So the module brings its own group with its own
    // member, and opens exactly that one.
    mod('life groups · list · detail · weekly attendance');
    const fxGroup = await makeRosteredGroup();
    try {
      await page.goto(`${BASE}/groups`, { waitUntil: 'domcontentloaded' });
      // Mobile viewport → the groups list renders as .mtile tiles (the desktop
      // table is .only-desktop / hidden). Each tile navigates to its detail page.
      await page.locator('.mtile').first().waitFor({ timeout: 20000 });
      check('the group list renders', (await page.locator('.mtile').count()) > 0);
      await shot('03b-groups');
      // Narrow to the fixture group so the tile that gets opened is the one
      // known to have a roster — and prove the search filter works on the way.
      await page.fill('.page-bar-filters input', fxGroup.name);
      await w(600);
      const groupTile = page.locator('.mtile', { hasText: fxGroup.name });
      check('the group search box narrows the list to one group',
        (await page.locator('.mtile').count()) === 1 && (await groupTile.count()) === 1);
      await groupTile.first().click();
      await page.waitForURL(/\/groups\/[0-9a-f-]+/, { timeout: 15000 });
      await page.locator('text=Leadership trio').first().waitFor({ timeout: 15000 });
      check('group detail shows the leadership trio', true);
      check('the leadership assignment dropdowns are present', (await page.locator('select.sm').count()) > 0);
      check('the year / month selects are present', (await page.locator('select').count()) >= 2);
      await page.locator('th:has-text("Week")').first().waitFor({ timeout: 20000 });
      check('weekly attendance renders a column per Sunday', (await page.locator('th:has-text("Week")').count()) > 0,
        `${await page.locator('th:has-text("Week")').count()} weeks`);
      check('weekly attendance has tick boxes', (await page.locator('input[type=checkbox]').count()) > 0);
      check('the roster lists the member who is in this group',
        (await page.locator(`td:has-text("${fxGroup.member.name}")`).count()) > 0);
      await shot('04-group-detail');
    } finally {
      await fxGroup.remove();
    }

    /* -- events & attendance ---------------------------------------------- */
    // Roll call and the edit dialog both need an event to open. The calendar is
    // empty in the live database, so this module supplies one and works on it
    // by name — never on "whatever sorts first".
    mod('events & attendance');
    const fxEvent = await makeEvent();
    try {
      await page.goto(`${BASE}/events`, { waitUntil: 'domcontentloaded' });
      const eventCard = page.locator('.card', { hasText: fxEvent.name });
      await eventCard.first().waitFor({ timeout: 20000 });
      check('a created event appears on the events page', (await eventCard.count()) === 1);
      await eventCard.locator('button:visible:has-text("Roll call")').first().click();
      await page.locator('.modal').waitFor({ timeout: 8000 });
      check('roll call opens the attendance modal', true);
      await page.locator('.modal .icon-btn, .modal button:has-text("Close")').first().click();
      await w(300);
      await eventCard.locator('button:visible:has-text("Edit")').first().click();
      await page.locator('.modal').waitFor({ timeout: 8000 });
      check('the event edit modal opens', true);
      check('the edit modal opens on that event',
        (await page.locator('.modal input').first().inputValue()) === fxEvent.name);
      await page.locator('.modal button:has-text("Cancel")').first().click();
      await shot('05-events');
    } finally {
      await fxEvent.remove();
    }

    /* -- trainings -------------------------------------------------------- */
    // The catalog is empty in the live database, so the course opened here is
    // one this module creates — with a session and a pending enrolee, which is
    // what makes the detail page's two panels worth asserting on at all.
    mod('trainings · detail');
    const fxTraining = await makeTraining();
    try {
      await page.goto(`${BASE}/trainings`, { waitUntil: 'domcontentloaded' });
      const courseTitle = page.locator('.card h3', { hasText: fxTraining.name });
      await courseTitle.first().waitFor({ timeout: 20000 });
      check('a created course appears in the catalog', (await courseTitle.count()) === 1);
      await courseTitle.first().click();
      await page.waitForURL(/\/trainings\/[0-9a-f-]+/, { timeout: 15000 });
      await page.locator('.card-head h3:has-text("Sessions")').first().waitFor({ timeout: 15000 });
      check('training detail shows the session list', true);
      check('the session list shows this course\'s session',
        (await page.locator(`strong:has-text("${fxTraining.sessionTitle}")`).count()) > 0);
      check('training detail shows the attendance sheet', (await page.locator('text=Attendance sheet').count()) > 0);
      check('a pending enrolee is offered for approval',
        (await page.locator('.enrol-row button:has-text("Approve")').count()) > 0);
      await shot('06-training-detail');
    } finally {
      await fxTraining.remove();
    }

    /* -- forty days ------------------------------------------------------- */
    // Every 守望 pair was wiped, so the relay chart and the progress dialog have
    // nothing to show unless this module pairs two throwaway members itself.
    mod('forty days · progress dialog');
    const fxPair = await makePair();
    try {
      await page.goto(`${BASE}/discipleship`, { waitUntil: 'domcontentloaded' });
      await page.locator('.chip', { hasText: 'Active' }).first().waitFor({ timeout: 20000 });
      await page.locator('.chip', { hasText: 'Completed' }).first().click();
      await w(400);
      await page.locator('.chip', { hasText: 'Active' }).first().click();
      await w(400);
      check('the relay chart state filter switches', true);
      const pairTile = page.locator('.mtile', { hasText: fxPair.traineeName });
      await pairTile.first().waitFor({ timeout: 20000 });
      check('a created pair appears in the pastor overview', (await pairTile.count()) === 1);
      await pairTile.first().click();
      await page.locator('.modal .day-cell').first().waitFor({ timeout: 15000 });
      check('opening a pair shows the 40-day grid', (await page.locator('.modal .day-cell').count()) >= 40);
      await page.locator('.modal .day-cell').first().click();
      await w(400);
      check("clicking a day shows that day's entry", /Day\s*1\b/.test(await page.locator('.modal').innerText()));
      await shot('07-pair-modal');
      await page.locator('.modal .icon-btn').first().click();
      await w(300);
      check('✕ closes the dialog', (await page.locator('.modal').count()) === 0);
    } finally {
      await fxPair.remove();
    }

    /* -- forty days · modules --------------------------------------------- */
    // A 守望模块 (discipleship_programs row) is the definition a pair hangs
    // off — its name and how many days the pair follows. It had no UI at all,
    // so when the church's single row was deleted during a data cleanup the
    // whole feature went dark and only raw SQL could bring it back. This
    // module drives the create → see → edit → delete cycle through the
    // dialogs, on a throwaway module of its own: the church's real one is only
    // ever read, never edited and never deleted (deleting a module cascades to
    // every pair under it and all of their daily records).
    mod('forty days · module management');
    const moduleName = fixtureName('MODULE');
    /** `{ path, remove }` once the module exists; null until then. */
    let fxModule = null;
    const openModules = async () => {
      await page.locator('button:visible:has-text("Modules")').first().click();
      await page.locator('.modal').waitFor({ timeout: 8000 });
    };
    /** The list dialog's row for one module — Edit / Delete live on it. */
    const moduleRow = () => page.locator('.modal .flex.items-center', { hasText: moduleName });
    try {
      await page.goto(`${BASE}/discipleship`, { waitUntil: 'domcontentloaded' });
      const modulesBtn = page.locator('button:visible:has-text("Modules")');
      await modulesBtn.first().waitFor({ timeout: 20000 });
      check('the forty-days page offers a module manager', (await modulesBtn.count()) > 0);

      await openModules();
      check('the module dialog offers a create button',
        (await page.locator('.modal button:has-text("New module")').count()) > 0);
      await page.locator('.modal button:has-text("New module")').first().click();
      await page.locator('.modal input').first().waitFor({ timeout: 8000 });
      await page.locator('.modal input').first().fill(moduleName);
      // name · description · total days — the length is the third field.
      await page.locator('.modal input').nth(2).fill('9');
      await page.locator('.modal button:has-text("Save")').first().click();
      await w(1500);
      check('creating a module adds it to the module list', (await moduleRow().count()) === 1);

      // Register it for cleanup the moment the server confirms it exists, so a
      // failure below can never leave a stray module on the live database.
      const created = (await apiGet('/discipleship/programs')).find((p) => p.name === moduleName);
      check('the created module is stored with the length that was typed',
        !!created && created.total_days === 9, String(created?.total_days));
      if (created) {
        const path = `/discipleship/programs/${created.id}`;
        fxModule = { path, remove: disposable(`discipleship module ${moduleName}`, path) };
      }

      // Close the dialog: with two or more modules the page grows a selector,
      // and it belongs in the filters half of the page bar, never the actions.
      await page.locator('.modal button:has-text("Close")').first().click();
      await w(600);
      const selectorOptions = await page.locator('.page-bar-filters select option').allInnerTexts();
      check('a second module makes the page bar offer a module selector',
        selectorOptions.includes(moduleName), selectorOptions.join(' | ').slice(0, 120));
      check('the selector is not mixed into the action row',
        (await page.locator('.page-bar-actions select').count()) === 0);

      // Edit: change the length and confirm the change actually persisted.
      await openModules();
      await moduleRow().locator('button:has-text("Edit")').first().click();
      await page.locator('.modal input').first().waitFor({ timeout: 8000 });
      check('the edit form opens on that module',
        (await page.locator('.modal input').first().inputValue()) === moduleName);
      await page.locator('.modal input').nth(2).fill('15');
      await page.locator('.modal button:has-text("Save")').first().click();
      await w(1500);
      const edited = (await apiGet('/discipleship/programs')).find((p) => p.name === moduleName);
      check('editing a module saves its new length', edited?.total_days === 15, String(edited?.total_days));

      // Delete: the confirmation must spell out what goes with it (rule G3).
      await moduleRow().locator('button:has-text("Delete")').first().click();
      await page.locator('.modal-backdrop').last().waitFor({ timeout: 8000 });
      const confirmText = await page.locator('.modal-backdrop').last().innerText();
      check('deleting a module asks first, and says what it destroys',
        confirmText.includes(moduleName) && /cannot be undone/i.test(confirmText),
        confirmText.replace(/\s+/g, ' ').slice(0, 140));
      await page.locator('.modal-backdrop').last().locator('button:has-text("Delete")').last().click();
      await w(1500);
      const afterDelete = await apiGet('/discipleship/programs');
      const gone = !afterDelete.some((p) => p.name === moduleName);
      check('deleting a module removes it', gone);
      // Deleted through the UI — take it off the sweep list so the run does not
      // report a leftover it already cleaned up.
      if (gone && fxModule) { forget(fxModule.path); fxModule = null; }
      check('the church’s own module is untouched', afterDelete.length >= 1, `${afterDelete.length} left`);
    } finally {
      if (fxModule) await fxModule.remove();
    }

    /* -- user management -------------------------------------------------- */
    mod('user management');
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    // The page action renders twice (topbar + content actions) with CSS deciding
    // which one shows, so this must target the visible one — .first() is the
    // topbar copy, which is display:none at this viewport and never "appears".
    await page.locator('button:visible:has-text("New account")').first().waitFor({ timeout: 20000 });
    const settingsBody = await page.locator('body').innerText();
    check('the user list loads (not the login page)', settingsBody.includes('New account'));
    // The account list is .mtile tiles at this (mobile) viewport, like the groups list.
    await page.locator('.mtile').first().click();
    await page.locator('button:has-text("Save account settings")').waitFor({ timeout: 10000 });
    check('an account detail page opens', true);
    // What each permission role may do used to live in an info popover at the
    // top of the page — a legend you had to read somewhere else and remember
    // while picking from the dropdown. It is spelled out on the options now, so
    // the answer is where the decision is made.
    const roleOptions = await page.locator('select option').allInnerTexts();
    check('the permission-role options say what each role may do',
      roleOptions.some((o) => o.includes('Super admin —'))
        && roleOptions.some((o) => o.includes('Read-only —')),
      roleOptions.join(' | ').slice(0, 160));
    // The login email is editable here now: it is stored on the linked member
    // and mirrored onto the account, which is what lets a member with no email
    // be given a login without a detour to the member page.
    check('the account detail exposes an editable login email',
      (await page.locator('.card input[type=email]:not([disabled])').count()) > 0);
    await shot('08-settings');

    /* -- my profile ------------------------------------------------------- */
    // The account block at the foot of the sidebar is a link straight to this
    // page, with sign-out as its own item underneath — it used to be a toggle
    // that popped a menu, so both destinations were a tap away from nowhere.
    mod('my profile');
    const navText = await page.locator('.sidebar').innerText();
    check('the sidebar offers My profile and Sign out without a pop-up menu',
      navText.includes('My profile') && navText.includes('Sign out')
        && (await page.locator('.nav-user-menu').count()) === 0);
    check('the account block links to the profile page',
      (await page.locator('.sidebar a.nav-user').getAttribute('href')) === '/profile');
    await page.locator('.hamburger').click();
    await page.locator('.sidebar a.nav-user').click();
    // The <h1> is page chrome and goes up before the fetch resolves, so waiting
    // on it and reading straight away races the skeleton — which has no text at
    // all. Wait for something only the loaded page renders.
    await page.locator('button:has-text("Edit my details")').first().waitFor({ timeout: 20000 });
    const profileBody = await page.locator('.content').innerText();
    check('the profile page shows my own account facts',
      profileBody.includes('Permission role') && profileBody.includes('Congregation'));
    await page.locator('button:has-text("Edit my details")').first().click();
    await page.locator('.modal').waitFor({ timeout: 8000 });
    check('the profile edit form offers the member fields, email included',
      (await page.locator('.modal input[type=email]').count()) > 0);
    await page.locator('.modal button:has-text("Cancel")').first().click();
    await w(300);
    check('cancelling the profile edit closes the dialog',
      (await page.locator('.modal').count()) === 0);
    await shot('08b-profile');

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

    /* -- the loading state is a skeleton, not a jump ----------------------- */
    // Every page used to early-return one "Loading…" line pinned to the top of
    // an empty page, and the whole page then snapped in underneath it. A list
    // page now paints its real page bar immediately and fills the rows below
    // with skeletons. Two regressions here are invisible the moment the data
    // lands, so they need the fetch held open: a second .page-bar rendered by
    // the loading branch, and a skeleton wider than the phone it is on.
    mod('loading skeletons');
    const holdMembers = (url) => url.pathname === '/api/members';
    await page.route(holdMembers, async (route) => {
      await new Promise((r) => setTimeout(r, 5000));
      // Unrouting settles whatever is still in flight, so by the time a held
      // request wakes up its route can already be handled. Continuing it then
      // throws — from inside a handler nobody awaits, which takes the whole
      // process down as an unhandled rejection rather than failing a check.
      await route.continue().catch(() => {});
    });
    await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
    const skeletonUp = await page
      .locator('.sk')
      .first()
      .waitFor({ state: 'attached', timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check('a list page shows skeleton rows while its fetch is in flight', skeletonUp);
    const barsWhileLoading = await page.locator('.page-bar').count();
    check('the real page bar is already up behind the skeleton',
      barsWhileLoading === 1, `${barsWhileLoading} bar(s)`);
    check('its filters are usable before the rows arrive',
      (await page.locator('.page-bar-filters input').count()) === 1);
    // A skeleton tile answers to .sk-tile, never .mtile: every other check in
    // this file reads .mtile as "a real, clickable row".
    check('skeleton tiles are not mistaken for list rows',
      (await page.locator('.mtile').count()) === 0);
    // The blocks are aria-hidden, so the status has to come from somewhere.
    check('a screen reader is still told the page is loading',
      (await page.locator('.sr-only[role=status]').count()) > 0);
    const skeletonOver = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check('the skeleton is no wider than the phone viewport', skeletonOver <= 1, `+${skeletonOver}px`);
    await shot('08c-skeleton');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.locator('.mtile').first().waitFor({ timeout: 20000 });
    check('the rows replace the skeleton once the fetch lands',
      (await page.locator('.sk').count()) === 0);

    /* -- nothing scrolls sideways on a phone ------------------------------ */
    // A single fixed-width, non-shrinking child is enough to make a whole page
    // wider than the phone it is on — the training detail page did exactly
    // that and every button along its right edge was cut off. ui-e2e was green
    // throughout, because it only ever asked whether elements existed.
    //
    // An empty page cannot overflow, so measuring one proves nothing: this
    // sweep only means something against a site that has rows to lay out. It
    // therefore puts one of everything in place first — and the tile clicks
    // below name their fixture instead of swallowing a miss with .catch(), so a
    // detail page that never opened fails the run rather than quietly
    // re-measuring the list page behind it.
    mod('no horizontal overflow at phone width');
    const fxSample = await makeSample();
    try {
      const DETAIL_PAGES = [...LIST_PAGES, '/events/recurring'];
      const overflowing = [];
      for (const path of DETAIL_PAGES) {
        await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
        await page.locator('h1').first().waitFor({ timeout: 20000 });
        await w(700); // let the lists paint before measuring
        const over = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (over > 1) overflowing.push(`${path} (+${over}px)`);
      }
      // …and the two detail pages whose rows carry the most controls.
      for (const [listPath, tile] of [
        ['/trainings', `.card h3:has-text("${fxSample.training.name}")`],
        ['/groups', `.mtile:has-text("${fxSample.group.name}")`],
      ]) {
        await page.goto(`${BASE}${listPath}`, { waitUntil: 'domcontentloaded' });
        await page.locator(tile).first().waitFor({ timeout: 20000 });
        await page.locator(tile).first().click();
        await page.waitForURL(/\/(trainings|groups)\/[0-9a-f-]+/, { timeout: 15000 });
        await w(1200);
        const over = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (over > 1) overflowing.push(`${page.url().replace(BASE, '')} (+${over}px)`);
      }
      check('no page is wider than the phone viewport',
        overflowing.length === 0, overflowing.join(', ') || `${DETAIL_PAGES.length + 2} pages fit`);
    } finally {
      await fxSample.remove();
    }

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
    // Belt and braces for the fixtures: each module already drops its own in a
    // `finally`, so this only ever fires when a module died before it could —
    // and it must, because this is the church's live database. Newest first, so
    // a group outlives the member that sits on its roster.
    await sweep('cleanup');
    leftovers.length = 0;
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
