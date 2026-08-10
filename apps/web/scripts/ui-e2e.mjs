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
  /**
   * Poll an async predicate instead of sleeping a fixed time then reading
   * once — a click that triggers a server round-trip settles in variable
   * time on a live network, and a fixed sleep either wastes time or (under
   * load) loses the race. Returns the last result once `ok` accepts it, or
   * once it does not within `timeoutMs`.
   */
  const pollUntil = async (fn, ok, timeoutMs = 8000, stepMs = 300) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    do {
      last = await fn();
      if (ok(last)) return last;
      await w(stepMs);
    } while (Date.now() < deadline);
    return last;
  };
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
   * event, a course, a pair and four members behind, and they had to be
   * deleted by hand.
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
  /**
   * Settings this run took over and must hand back — the church's add-on module
   * states and the account's interface language. Deleting a fixture is not
   * enough: those two are switches on the LIVE church, and a run that dies
   * holding one leaves real users with a module switched off or an interface in
   * a language nobody chose.
   *
   * Each entry re-reads the current value and only writes when it differs, so
   * running one twice is harmless — which is what lets the normal path keep its
   * own explicit restores while the crash path below drains the same list.
   */
  const restorers = [];
  const restoreLater = (label, run) => restorers.push({ label, run });
  const runRestorers = async (why, stream = console.log) => {
    for (const r of restorers.splice(0).reverse()) {
      const ok = await r.run().then(() => true).catch(() => false);
      stream(`  ↳ ${why}: ${ok ? 'restored' : 'COULD NOT RESTORE'} ${r.label}`);
    }
  };

  /**
   * The last word on test data: delete EVERY ZZ_UITEST_… row in the church,
   * not just the ones this run registered.
   *
   * `sweep` above can only remove what this process created. Anything left by
   * an earlier run — one that was killed before its handlers fired, one whose
   * delete was refused, one from a build that predates the sweep — is invisible
   * to it and simply accumulates in the church's live database, which is what
   * the owner found. This asks the API what is actually there and removes
   * whatever carries the fixture prefix, whoever made it.
   *
   * Order matters and is the reverse of how a fixture is built: a pair holds
   * two members, a training holds its enrolments, a group holds its roster. So
   * pairs first, then the things that only reference members, then the members,
   * then the groups they sat in.
   *
   * It returns what it could NOT delete, because residue that cannot be removed
   * has to be loud rather than logged — see the check in main()'s finally.
   */
  const PREFIX = 'ZZ_UITEST';
  const purgeResidue = async (stream = console.log) => {
    const stuck = [];
    const list = (path) => apiGet(path).catch(() => []);
    const kill = async (label, path) => {
      if (await apiDelete(path)) stream(`  ↳ purge: deleted stray ${label} (${path})`);
      else stuck.push(`${label} (${path})`);
    };
    const named = (rows, field) =>
      (Array.isArray(rows) ? rows : []).filter((r) => String(r?.[field] ?? '').startsWith(PREFIX));

    // A pair has no name of its own — it is stray when either person on it is.
    for (const p of (await list('/discipleship/pairs')).filter?.(
      (x) =>
        String(x?.mentor?.full_name ?? '').startsWith(PREFIX) ||
        String(x?.trainee?.full_name ?? '').startsWith(PREFIX),
    ) ?? []) {
      await kill('pair', `/discipleship/pairs/${p.id}`);
    }
    for (const t of named(await list('/trainings'), 'name')) await kill('training', `/trainings/${t.id}`);
    for (const e of named(await list('/events'), 'title')) await kill('meeting', `/events/${e.id}`);
    for (const m of named(await list('/members'), 'full_name')) await kill('member', `/members/${m.id}`);
    for (const g of named(await list('/groups'), 'name')) await kill('group', `/groups/${g.id}`);
    // A fixture-named term cascades its group, roster and attendance with it.
    // The group sweep beneath it only catches one left under a REAL term,
    // which should never happen but is checked anyway (the same reason this
    // function exists at all: a run that died before its own `finally`).
    for (const t of named(await list('/happiness/terms'), 'name')) await kill('happiness term', `/happiness/terms/${t.id}`);
    for (const g of named(await list('/happiness/groups'), 'name')) await kill('happiness group', `/happiness/groups/${g.id}`);
    return stuck;
  };

  const dieCleanly = async (why, err) => {
    if (err) console.error(`UI E2E ${why}:`, err);
    if (leftovers.length) {
      console.error(`\n${leftovers.length} fixture(s) still live after ${why} — removing them.`);
      await sweep(why, console.error).catch(() => {});
    }
    if (restorers.length) {
      console.error(`${restorers.length} live setting(s) still held after ${why} — handing them back.`);
      await runRestorers(why, console.error).catch(() => {});
    }
    // And the same total purge the normal path ends with: a crash is exactly
    // when a fixture goes missing from the list (a module that died between
    // creating a row and registering it), so the by-name pass matters most here.
    await purgeResidue(console.error).catch(() => {});
    process.exit(1);
  };
  process.on('uncaughtException', (e) => void dieCleanly('uncaught exception', e));
  process.on('unhandledRejection', (e) => void dieCleanly('unhandled rejection', e));
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => void dieCleanly(sig));
  }

  // Today in MALAYSIA — the zone every sheet is read in. The runner may be in
  // UTC (or anywhere), so taking the month from `new Date()` would open the
  // wrong sheet for the first 8 hours of a new month (rule G6a).
  const KL_TODAY = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [SHEET_YEAR, SHEET_MONTH] = KL_TODAY.split('-');

  /**
   * One member's cells on this month's roll-call sheet, straight from the API —
   * keyed by column (`sunday:YYYY-MM-DD` / `meeting:<id>`), which is what the
   * page ticks and therefore what a tick has to show up as.
   */
  const sheetCellsOf = async (memberId) => {
    const sheet = await apiGet(`/attendance/sheet?year=${SHEET_YEAR}&month=${Number(SHEET_MONTH)}`);
    return sheet.rows.find((r) => r.member?.id === memberId)?.cells ?? {};
  };

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

  /**
   * A throwaway hand-added meeting, starting now so it lands in the month the
   * 崇拜与祷告会 page opens on — where it is a dated COLUMN on the roll-call
   * sheet. Sundays are no longer events at all (the calendar supplies them), so
   * this is a plain `meeting` — the shape someone actually adds.
   */
  const makeEvent = async () => {
    const row = await apiPost('/events', {
      title: fixtureName('MEETING'),
      event_type: 'meeting',
      starts_at: new Date().toISOString(),
      hall_id: await someHallId(),
    });
    return { id: row.id, name: row.title, remove: disposable(`meeting ${row.title}`, `/events/${row.id}`) };
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
   * A throwaway PAID course with one sign-up carrying a payment receipt
   * (migration 0016) — what the admin has to be able to open BEFORE approving.
   *
   * The receipt is uploaded through the PUBLIC sign-up path, exactly as a
   * visitor's would be, because that is the path that stores it; the sign-up
   * therefore needs a member whose full name matches exactly one row, which is
   * why it brings its own.
   */
  const makePaidTraining = async () => {
    const row = await apiPost('/trainings', {
      name: fixtureName('PAID'),
      total_sessions: 1,
      is_enrollable: true,
      fee: 30,
      payment_instructions: 'ZZ_UITEST Maybank 5123 4567 8901',
      pic: 'ZZ_UITEST PIC',
      pic_contact: '012-000 0000',
      hall_id: await someHallId(),
    });
    const removeTraining = disposable(`paid training ${row.name}`, `/trainings/${row.id}`);
    const payer = await makeMember('PAYER');
    // A 1×1 PNG standing in for a photo of a bank transfer.
    const receipt = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const signUp = await ctx.request.post(`${BASE}/api/trainings/enroll/${row.id}`, {
      multipart: {
        full_name: payer.name,
        slip: { name: 'receipt.png', mimeType: 'image/png', buffer: receipt },
      },
    });
    const outcome = await signUp.json().catch(() => null);
    if (outcome?.status !== 'ok')
      throw new Error(`paid sign-up fixture failed: ${signUp.status()} ${JSON.stringify(outcome)}`);
    return {
      id: row.id,
      name: row.name,
      payer,
      remove: async () => { await removeTraining(); await payer.remove(); },
    };
  };

  /**
   * A throwaway ACTIVITY — the other shape in the same catalog (`kind`,
   * migration 0014): one occasion, one sign-up, one column to tick. Its single
   * session is created by the API with it, so nothing is added here; the
   * approved sign-up is what puts a row on its roll call. It carries a time and
   * a meeting point too (0016), which live on the training row itself.
   */
  const makeActivity = async () => {
    const row = await apiPost('/trainings', {
      name: fixtureName('ACTIVITY'),
      kind: 'activity',
      is_enrollable: true,
      starts_on: KL_TODAY,
      ends_on: KL_TODAY,
      start_time: '09:30',
      location: 'ZZ_UITEST car park',
      hall_id: await someHallId(),
    });
    const removeActivity = disposable(`activity ${row.name}`, `/trainings/${row.id}`);
    const goer = await makeMember('GOER');
    await apiPost(`/trainings/${row.id}/enroll`, { member_id: goer.id, status: 'approved' });
    return {
      id: row.id,
      name: row.name,
      goer,
      remove: async () => { await removeActivity(); await goer.remove(); },
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
      mentorId: mentor.id,
      traineeId: trainee.id,
      mentorName: mentor.name,
      traineeName: trainee.name,
      remove: async () => { await removePair(); await trainee.remove(); await mentor.remove(); },
    };
  };

  /** One of everything, for the checks that sweep whole pages rather than one. */
  const makeSample = async () => {
    const group = await makeRosteredGroup();
    const event = await makeEvent();
    const training = await makeTraining();
    const pair = await makePair();
    return {
      group,
      event,
      training,
      pair,
      remove: async () => {
        await pair.remove();
        await training.remove();
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
      'sidebar lists every module + Users and Church settings (super admin only)',
      ['Members', 'Life Groups', 'Services', 'Trainings & Activities', 'Forty Days', 'Happiness Groups', 'Users', 'Church settings']
        .every((label) => sidebar.includes(label)),
    );
    // The brand at the top of the sidebar is the CHURCH's own name, read from
    // its record — not a translated string and not a hardcoded one.
    const churchRecord = await apiGet('/church');
    check('the sidebar brand shows the church record’s name',
      sidebar.includes(churchRecord.short_name || churchRecord.name),
      churchRecord.short_name || churchRecord.name);

    /* -- dashboard: trend chart · upcoming-events table · one KPI tile ----- */
    // The dashboard was rebuilt around three sections; the old 4-tile KPI row,
    // the "Identity distribution" bar chart and the "Discipleship progress"
    // card are gone entirely.
    // The `<h1>` above is the page shell, not the data — the trend card,
    // upcoming-events table and KPI tile all populate from their own
    // client-side fetch, which lands after the shell's first paint. Reading
    // `.content` before that fetch settles is a real race (not just here —
    // it read as an app bug the first few times it flaked), so wait on the
    // trend card's own heading, not just the page having loaded at all.
    await page.locator('.card:has-text("New Visits & Active Members")').first().waitFor({ timeout: 20000 });
    const dashBody = await page.locator('.content').innerText();
    check('the dashboard shows the New Visits / Active Members trend card',
      dashBody.includes('New Visits & Active Members'));
    check('…the upcoming-events section…', dashBody.includes('Upcoming events'));
    check('…and a single "Total Active Members" KPI tile',
      dashBody.includes('Total Active Members') && (await page.locator('.stat').count()) === 1);
    check('the retired KPI row / identity chart / discipleship-progress card are gone',
      !dashBody.includes('Identity distribution') && !dashBody.includes('Discipleship progress'));
    // Two independent toggle chips, both on by default — each hides its own
    // line without touching the other.
    const trendChips = page.locator('.card:has-text("New Visits & Active Members") .chip');
    const chipsOnByDefault = await trendChips.evaluateAll((els) => els.every((el) => el.classList.contains('on')));
    check('the trend card offers two toggle chips, both on by default',
      (await trendChips.count()) === 2 && chipsOnByDefault);
    const linesBefore = await page.locator('.card:has-text("New Visits & Active Members") svg polyline').count();
    await trendChips.first().click();
    await w(200);
    const linesAfter = await page.locator('.card:has-text("New Visits & Active Members") svg polyline').count();
    check('toggling a chip off removes its own line from the chart', linesAfter === linesBefore - 1, `${linesBefore} → ${linesAfter}`);
    await trendChips.first().click();
    await w(200);
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

    /* A person is TWO names (migration 0018) and every list draws both: the
       Chinese name with the English one under it, on its own line. The fixture
       brings its own English name — the church's real members may or may not
       have one, and "the church happens to have somebody bilingual" is not
       something a test may depend on. Searching for the Chinese name also
       proves the row is reachable at all. */
    const bilingual = await makeMember('BINAME', { english_name: 'E2E English Name' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.mtile').first().waitFor({ timeout: 20000 });
    await page.fill('input[placeholder*="Search"]', bilingual.name);
    await w(600);
    const nameTile = page.locator('.mtile').first();
    const nameTileText = (await nameTile.count()) ? await nameTile.innerText() : '';
    check('a member row shows the Chinese name with the English one under it',
      nameTileText.includes(bilingual.name) &&
        nameTileText.includes('E2E English Name') &&
        (await nameTile.locator('.member-name-en').count()) > 0,
      nameTileText.replace(/\n/g, ' ⏎ ').slice(0, 120));
    // …and the search itself matches EITHER name.
    await page.fill('input[placeholder*="Search"]', 'e2e english name');
    await w(600);
    check('the search box finds a member by their English name',
      (await page.locator('.mtile').count()) === 1 &&
        (await page.locator('.mtile').first().innerText()).includes(bilingual.name));
    await bilingual.remove();
    await page.fill('input[placeholder*="Search"]', '');
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
    // The single long FactGrid was split into several smaller, labelled
    // sections rather than one undifferentiated grid — Ministry (serving)
    // and Referral (领路人) later folded into Church and Contact respectively.
    const detailBody = await page.locator('.content').innerText();
    check('the member detail page groups its facts under section headers (Contact/Church/Notes)',
      ['Contact', 'Church', 'Notes'].every((label) => detailBody.includes(label)));
    await shot('03-member-detail');

    // Back button (rule G4 shared BackButton): a fresh navigation to this
    // page — no in-app history to pop — falls back to the list rather than
    // doing nothing. A `page.goto` here (not a click) is what actually
    // clears this tab's `navigatedSinceBoot` flag, the same as a direct
    // link, a refresh, or a new tab would.
    const memberDetailUrl = page.url();
    await page.goto(memberDetailUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('.back-btn').first().waitFor({ timeout: 10000 });
    await page.locator('.back-btn').first().click();
    await page.waitForURL(/\/members$/, { timeout: 10000 });
    check('Back on a freshly-loaded member page falls back to the members list',
      /\/members$/.test(page.url()), page.url());

    /* -- life groups ------------------------------------------------------ */
    // The weekly-attendance grid only draws rows for a group that HAS members,
    // and which of the church's own groups are populated is not this suite's
    // business to depend on. So the module brings its own group with its own
    // member, and opens exactly that one.
    mod('life groups · list · detail · attendance (Sundays + the group’s own)');
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
      // Every member picker is a type-to-search combobox now, never a native
      // <select>: on a phone a <select> is a system wheel with no search at
      // all, and the church's member list only gets longer.
      const trioPick = page.locator('.trio-pick input[role=combobox]');
      check('the three leadership seats are type-to-search comboboxes',
        (await trioPick.count()) === 3 && (await page.locator('select.trio-pick').count()) === 0,
        `${await trioPick.count()} comboboxes`);
      check('the year / month selects are present', (await page.locator('select').count()) >= 2);
      await page.locator('table.sheet-table').first().waitFor({ timeout: 20000 });
      // One header cell per Sunday of the month, each spanning its three
      // sub-ticks (小组 / 会前 / 主日) — merged into one block now, not two
      // side by side.
      const dateHeads = page.locator('table.sheet-table thead th.tnum');
      check('weekly attendance renders a column per Sunday', (await dateHeads.count()) > 0,
        `${await dateHeads.count()} Sundays`);
      check('weekly attendance has tick boxes', (await page.locator('input[type=checkbox]').count()) > 0);
      check('the roster lists the member who is in this group',
        (await page.locator(`td:has-text("${fxGroup.member.name}")`).count()) > 0);
      await shot('04-group-detail');

      // The group's roll call is ONE table, one column per date — no more
      // 小组 / 会前 / 主日 tabs, and no more two blocks side by side either:
      // 小组 is now the first sub-tick under the SAME date column 会前/主日
      // sit under, not a second table next to it.
      check('the roll-call card offers no roll-call tabs any more',
        (await page.locator('.seg').count()) === 0, `${await page.locator('.seg').count()} segmented control(s)`);

      // Its toolbar is the month picker's two selects on the left and the
      // export button LAST, in the right corner — the same halves a page bar
      // has (rule G7a). A spacer sits between them, so the shape is four
      // children and the assertion is about the ORDER and the last one, not
      // about a fixed count of controls.
      const sheetCard = page.locator('.card', { has: page.locator('table.sheet-table') });
      const toolbar = sheetCard.locator('.flex.gap-8.mb-14').first();
      await toolbar.waitFor({ timeout: 20000 });
      const toolbarShape = await toolbar.evaluate((el) =>
        [...el.children].map((c) => c.tagName.toLowerCase() + (c.getAttribute('aria-label') ? `[${c.getAttribute('aria-label')}]` : '')),
      );
      check('the export button is the last control in the card’s toolbar',
        toolbarShape.length >= 3 && toolbarShape[0].startsWith('select') && toolbarShape[1].startsWith('select') &&
          toolbarShape[toolbarShape.length - 1].startsWith('button'),
        toolbarShape.join(' | '));
      check('…and it is an export button, not something else',
        (await sheetCard.locator('button[aria-label*="Export"]').count()) === 1);

      // One block per date now, not two blocks side by side — a leader must
      // never wonder whether the box under their finger is the group's own
      // night or the church's Sunday. 小组 is the sub-tick's own label; 会前/
      // 主日 are the SAME sub-ticks 崇拜与祷告会 draws.
      check('every date column carries a 小组 tick as well as 会前/主日',
        (await sheetCard.locator('th:has-text("Group")').count()) >= 4 &&
          (await sheetCard.locator('th:has-text("Pre-service")').count()) >= 4,
        `${await sheetCard.locator('th:has-text("Group")').count()} Group headers, ` +
          `${await sheetCard.locator('th:has-text("Pre-service")').count()} 会前 columns`);

      // Ticking a week writes the group's own roll call, and unticking it puts
      // it back — the card is a sheet like every other one.
      //
      // Only ever the group's OWN column: the Sundays beside it are the
      // congregation's real record (that is the whole point of the Sunday half
      // being the same rows), and ticking one here would genuinely write it.
      // The group's own meetings hold nothing but what this run creates.
      const groupRow = sheetCard.locator('tr', { has: page.locator(`td:has-text("${fxGroup.member.name}")`) });
      await groupRow.first().waitFor({ timeout: 20000 });
      check('the sheet lists this group’s member exactly once',
        (await groupRow.count()) === 1, `${await groupRow.count()} row(s)`);
      // The 小组 tick is always the FIRST checkbox in the row: it renders
      // ahead of 会前/主日 under the first Sunday column, in that fixed order.
      const weekTick = groupRow.locator('input[type=checkbox]').first();
      // click, not check(): the tick is optimistic and the row re-renders from
      // the server, so the checkbox's own state is not the fact worth
      // asserting — what the API returns is.
      const markedFor = (sheet) => (sheet.rows || [])
        .find((r) => r.member?.id === fxGroup.member.id)?.cells
        ?.some((c) => c.status === 'present');
      // The click handler reads the row's CURRENT `present` prop from its own
      // closure to decide which way to toggle — clicking again before that
      // prop has actually re-rendered as true sends a second TICK, not an
      // untick. Confirming against the server (the poll below) is not the
      // same event as the checkbox's own re-render, so wait for the DOM
      // element itself between the two clicks, not only the API.
      await weekTick.click();
      await page.waitForFunction((el) => el.checked === true, await weekTick.elementHandle(), { timeout: 8000 }).catch(() => {});
      const groupSheet = await pollUntil(
        () => apiGet(`/groups/${fxGroup.id}/attendance`),
        (sheet) => markedFor(sheet) === true,
      );
      const marked = markedFor(groupSheet);
      check('ticking a week records the group’s own meeting', marked === true, JSON.stringify(groupSheet.meetings || []));
      await weekTick.click();
      await page.waitForFunction((el) => el.checked === false, await weekTick.elementHandle(), { timeout: 8000 }).catch(() => {});
      const groupAfter = await pollUntil(
        () => apiGet(`/groups/${fxGroup.id}/attendance`),
        (sheet) => markedFor(sheet) !== true,
      );
      const stillMarked = markedFor(groupAfter);
      check('unticking it takes the mark off again', stillMarked !== true);

      /* -- the column check-all (全员到齐) ------------------------------- */
      // Marking a roster one person at a time is what this shortcut exists to
      // stop. Driven on the group's OWN week columns only, for the same reason
      // the single tick above is: the Sunday check-alls beside them would
      // clear the congregation's real attendance.
      const presentIn = (sheet) =>
        (sheet.rows || []).filter((r) => (r.cells || []).some((c) => c.status === 'present')).length;
      const weekAll = sheetCard.locator('thead input.sheet-tick-all[aria-label*="Group"]');
      const weekCount = await sheetCard.locator('th:has-text("Group")').count();
      check('every week column carries a check-all in its header',
        (await weekAll.count()) === weekCount, `${await weekAll.count()} of ${weekCount}`);
      // The Sunday half has its own, one per sub-column, exactly as it does on
      // 崇拜与祷告会 — asserted by counting, never by pressing one.
      const sundayAllsHere = await sheetCard.locator('thead input.sheet-tick-all[aria-label*="Pre-service"]').count();
      check('each Sunday’s ticks carry their own check-all here too',
        sundayAllsHere >= 4, `${sundayAllsHere} 会前 check-alls`);
      // The DOM checkbox is a client re-render after its OWN fetch, which is
      // not the same event as the out-of-band apiGet polls above — waiting
      // on the server's answer does not guarantee the page has painted it
      // yet, so each DOM read below waits on the element itself first.
      const waitBoxState = (locator, wantChecked) =>
        page.waitForFunction(
          (el, want) => (want ? el.checked === true : el.checked === false && !el.indeterminate),
          locator,
          wantChecked,
          { timeout: 8000 },
        ).catch(() => {});

      const firstAll = weekAll.first();
      await waitBoxState(await firstAll.elementHandle(), false);
      check('…which reads as empty while nobody is ticked',
        !(await firstAll.isChecked()) && (await firstAll.evaluate((el) => el.indeterminate)) === false);

      await firstAll.click();
      await waitBoxState(await firstAll.elementHandle(), true);
      check('filling a whole column needs no confirmation — nothing is lost',
        (await page.locator('.modal-backdrop').count()) === 0);
      const filled = await pollUntil(
        () => apiGet(`/groups/${fxGroup.id}/attendance`),
        (sheet) => (sheet.rows || []).length > 0 && presentIn(sheet) === (sheet.rows || []).length,
      );
      check('the header check-all marks the whole roster',
        presentIn(filled) === (filled.rows || []).length && (filled.rows || []).length > 0,
        `${presentIn(filled)} of ${(filled.rows || []).length}`);
      // The DOM checkbox's own re-render is a SEPARATE round trip from the
      // API poll just above — the server confirming the write does not mean
      // the page has painted it yet, so wait on the element again here
      // rather than trusting the earlier (best-effort, silently-swallowed)
      // wait right after the click to have already caught up.
      await waitBoxState(await firstAll.elementHandle(), true);
      check('…and the header then reads as fully ticked', await firstAll.isChecked());

      // Clearing throws real marks away, so it must ask first and say how many
      // (rule G3).
      await firstAll.click();
      await page.locator('.modal-backdrop').last().waitFor({ timeout: 8000 });
      const clearCopy = await page.locator('.modal-backdrop').last().innerText();
      check('clearing a whole column asks first, names the DATE it is about to empty, and warns it is final',
        /\d{2}-\d{2}.*Group/.test(clearCopy) && /cannot be undone/i.test(clearCopy),
        clearCopy.replace(/\s+/g, ' ').slice(0, 140));
      await page.locator('.modal-backdrop').last().locator('button:has-text("Clear column")').last().click();
      const emptied = await pollUntil(
        () => apiGet(`/groups/${fxGroup.id}/attendance`),
        (sheet) => presentIn(sheet) === 0,
      );
      check('confirming clears every mark in that column', presentIn(emptied) === 0,
        `${presentIn(emptied)} still present`);

      /* -- the member combobox: type, filter, pick ----------------------- */
      // Driven on the leadership seat, whose options are this group's own
      // members — so the person typed for and the person picked are both
      // fixtures this run created.
      const seat = trioPick.first();
      await seat.click();
      await page.locator('.combo-list').first().waitFor({ timeout: 8000 });
      check('clicking a member picker opens its option list',
        (await page.locator('.combo-list .combo-option').count()) > 0,
        `${await page.locator('.combo-list .combo-option').count()} options`);
      await seat.fill('ZZ_NOBODY_BY_THIS_NAME');
      await w(400);
      check('a query nobody matches says so instead of showing a stale list',
        (await page.locator('.combo-empty').count()) === 1 &&
          (await page.locator('.combo-list .combo-option').count()) === 0);
      await seat.fill(fxGroup.member.name);
      await w(400);
      const narrowed = await page.locator('.combo-list .combo-option').count();
      check('typing part of a name narrows the list to that member', narrowed === 1, `${narrowed} options`);
      await page.locator('.combo-list .combo-option').first().click();
      await w(1800);
      const assigned = await apiGet(`/groups/${fxGroup.id}`);
      check('picking an option saves that member, not the typed text',
        (assigned.members || []).find((m) => m.id === fxGroup.member.id)?.group_position === 'leader',
        JSON.stringify((assigned.members || []).map((m) => m.group_position)));
      check('…and the field then reads back the member it saved',
        (await seat.inputValue()).includes(fxGroup.member.name),
        await seat.inputValue());
      check('the option list closes once something is picked',
        (await page.locator('.combo-list').count()) === 0);

      /* -- roster row: View navigates to the member's own detail page ----- */
      // A roster row is looked at far more often than it is edited, so its
      // own button now goes straight to that member's page (which still
      // carries the real Edit button, the shared `MemberEditModal.tsx`, rule
      // G4) rather than opening a second, roster-only editor here.
      // Scoped to the table that carries the Remove button — the group
      // detail page has TWO tables containing this member's name (the
      // attendance sheet above, and the roster below), and an unscoped
      // `table tr` locator grabs whichever comes first in the DOM (the
      // attendance sheet), whose row has no View/Remove buttons at all.
      const rosterRow = page.locator('table:has(button:has-text("Remove")) tr', { hasText: fxGroup.member.name }).first();
      await rosterRow.locator('button:has-text("View")').click();
      await page.waitForURL(new RegExp(`/members/${fxGroup.member.id}$`), { timeout: 10000 });
      check('the roster row’s View button opens that member’s own page',
        (await page.locator('h1, .entity-header').first().innerText().catch(() => '')).includes(fxGroup.member.name) ||
          (await page.locator('body').innerText()).includes(fxGroup.member.name));
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.locator('.sheet-table').first().waitFor({ timeout: 10000 });
    } finally {
      await fxGroup.remove();
    }

    /* -- group leadership · auto-provisioned 小组长 login ------------------- */
    // Promoting a member WITH AN EMAIL to the Leader seat auto-creates a
    // group_leader login and shows the credential ONCE, in a modal — never a
    // toast, which would disappear before anyone could copy a password off
    // it (rule G6). A fresh group + member of its own, separate from the
    // roster fixture above (which deliberately carries no email, so that
    // module's own leadership pick stays a no-op for this mechanism).
    mod('group leadership · auto-provisioned login (credential modal + copy)');
    const fxLeaderGroup = await (async () => {
      const row = await apiPost('/groups', { name: fixtureName('LEADGROUP'), hall_id: await someHallId() });
      const removeGroup = disposable(`group ${row.name}`, `/groups/${row.id}`);
      const leaderEmail = `zz-uitest-${STAMP}-${Math.floor(Math.random() * 1e4)}@grace.org`;
      // The trio picker's options are the group's OWN roster only (leadership
      // is assigned from among people already in the group) — so the member
      // has to be on the roster BEFORE the Leader seat can offer them, the
      // same shape `makeRosteredGroup` above sets up.
      const member = await makeMember('LEADER', { group_id: row.id, group_position: 'core_member', email: leaderEmail });
      return {
        id: row.id,
        name: row.name,
        member,
        email: leaderEmail,
        remove: async () => { await member.remove(); await removeGroup(); },
      };
    })();
    try {
      await page.goto(`${BASE}/groups/${fxLeaderGroup.id}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.trio-pick input[role=combobox]').first().waitFor({ timeout: 20000 });
      // The FIRST seat is the apex — Leader — the only one of the three this
      // mechanism ever acts on (`GroupPosition.Leader` specifically, not the
      // assistant/intern seats beside it).
      const leaderSeat = page.locator('.trio-pick input[role=combobox]').first();
      await leaderSeat.click();
      await page.locator('.combo-list').first().waitFor({ timeout: 8000 });
      await leaderSeat.fill(fxLeaderGroup.member.name);
      await w(400);
      await page.locator('.combo-list .combo-option').first().click();
      await w(1200);

      const credModal = page.locator('.modal:has-text("Login created")');
      await credModal.first().waitFor({ timeout: 8000 });
      check('promoting a member with an email to 小组长 shows a credential modal, once',
        (await credModal.count()) === 1);
      const credBody = await credModal.first().innerText();
      check('…naming the email the login was created for', credBody.includes(fxLeaderGroup.email), credBody.slice(0, 200));
      // A password long enough to satisfy this app's own 8-char minimum with
      // real margin (rule G6) — not asserting the exact string, since it is
      // randomly generated.
      check('…and showing a generated password of a sensible length',
        /Password/i.test(credBody) && (credBody.match(/[A-Za-z0-9]{12,}/) || []).length > 0,
        credBody.slice(0, 200));

      const assignedLeader = await apiGet(`/groups/${fxLeaderGroup.id}`);
      check('…and the member is actually saved as this group’s leader',
        (assignedLeader.members || []).find((m) => m.id === fxLeaderGroup.member.id)?.group_position === 'leader',
        JSON.stringify((assignedLeader.members || []).map((m) => m.group_position)));

      // The copy button answers the tap either way (rule G4's `copyText` —
      // through `navigator.clipboard` alone a denied/unsupported permission
      // runs no callback and the button reads as dead), the same tolerant
      // assertion the sign-up link's own copy button uses above.
      await credModal.first().locator('button:has-text("Copy")').first().click();
      const copyToasted = await page.locator('.toast').first().waitFor({ timeout: 5000 }).then(() => true, () => false);
      check('the copy button answers the tap, copied or not', copyToasted);

      await credModal.first().locator('button:has-text("Close")').first().click();
      await w(300);
      check('closing the credential modal dismisses it', (await page.locator('.modal').count()) === 0);
    } finally {
      await fxLeaderGroup.remove();
    }

    /* -- services · one roll-call sheet ------------------------------------ */
    // The page is ONE sheet: members down the left, and across the top the
    // month's Sundays (two ticks each, 会前 / 主日) with every hand-added
    // meeting sorted into place among them (one tick, 到场). Nothing creates a
    // Sunday, so this module needs only a member to put on the sheet and one
    // meeting to give it a meeting column.
    //
    // No congregation has to be picked any more: on 全部堂会 the sheet simply
    // lists every member, which is what this runs as.
    mod('services · roll-call sheet · meetings');
    const fxSheetMember = await makeMember('SUNDAY');
    const fxMeeting = await makeEvent();
    /** That member's cells on the live sheet, straight from the API. */
    const sheetCells = () => sheetCellsOf(fxSheetMember.id);
    try {
      await page.goto(`${BASE}/events`, { waitUntil: 'domcontentloaded' });
      await page.locator('.page-bar').first().waitFor({ state: 'attached', timeout: 20000 });

      const memberCell = page.locator(`td:has-text("${fxSheetMember.name}")`);
      await memberCell.first().waitFor({ timeout: 20000 });
      check('on 全部堂会 the sheet lists every congregation’s members, without asking for one',
        (await memberCell.count()) === 1 &&
          !/choose a congregation/i.test(await page.locator('.content').innerText()));
      // One column group per Sunday, each split in two — and a month holds four
      // Sundays at the very least. (There is no trailing totals group any more:
      // the headcount per occasion is a <tfoot> row, checked below.)
      const preHeads = await page.locator('th:has-text("Pre-service")').count();
      check('every Sunday gets a 会前 / 主日 pair of columns', preHeads >= 4, `${preHeads} headers`);
      // The sheet totals DOWN a column, not across a row: how many people came
      // to that occasion, in the foot of the table.
      const foot = page.locator('.sheet-table tfoot tr');
      check('the sheet totals each occasion in a footer row, not per person',
        (await foot.count()) === 1 &&
          /People present/i.test(await foot.first().innerText()));
      check('…and no row ends in a per-person tally column',
        (await page.locator('.sheet-table thead th:has-text("Total")').count()) === 0);
      check('the sheet is ticked with check boxes, like the life-group sheet',
        (await page.locator('input[type=checkbox]').count()) > 0);

      // The meeting is a COLUMN on the same grid, not a second card — with one
      // tick, because one occasion has one thing to record. That is its
      // header's own colspan: counting "Attended" headers across the sheet
      // instead would answer a different question, because the month may
      // legitimately hold other meetings than this run's, each with a column
      // of its own.
      const meetingHead = page.locator('th', { hasText: fxMeeting.name });
      await meetingHead.first().waitFor({ timeout: 20000 });
      check('a hand-added meeting is a dated column on the same sheet',
        (await meetingHead.count()) === 1);
      const meetingSpan = await meetingHead.first().getAttribute('colspan');
      check('…carrying exactly one tick, not an invented 会前 as well',
        meetingSpan === '1', `colspan=${meetingSpan}`);
      check('the meetings no longer have a card of their own',
        (await page.locator('.meeting-row').count()) === 0);

      // Tick → the cell is stored; untick → the row is GONE, not stored as two
      // falses ("no row" already means "not recorded"). Each tick names its own
      // column in its title, which is how the meeting's cell is found among the
      // Sundays' without counting columns.
      const sheetRow = page.locator('tr', { has: page.locator(`td:has-text("${fxSheetMember.name}")`) });
      const firstTick = sheetRow.locator('input[type=checkbox]').first();
      // click, not check(): the tick is optimistic and the row re-renders from
      // the server, so the checkbox's own state is not the fact worth
      // asserting — the row in the sheet is, and that is what the next check
      // reads back through the API. Same reasoning as the group sheet above.
      await firstTick.click();
      await w(1500);
      const ticked = await sheetCells();
      check('ticking a Sunday cell records it under a sunday column',
        Object.entries(ticked).some(([key, c]) => key.startsWith('sunday:') && c.pre_service),
        JSON.stringify(ticked));
      await firstTick.click();
      await w(1500);
      const cleared = await sheetCells();
      check('unticking it leaves no row behind', Object.keys(cleared).length === 0, JSON.stringify(cleared));

      const meetingTick = sheetRow.locator(`input[title*="${fxMeeting.name}"]`);
      check('the meeting’s column is ticked in the same row', (await meetingTick.count()) === 1);
      await meetingTick.first().click();
      await w(1500);
      const came = await sheetCells();
      check('ticking the meeting writes the OTHER table, on the same grid',
        came[`meeting:${fxMeeting.id}`]?.attended === true, JSON.stringify(came));
      await meetingTick.first().click();
      await w(1500);
      const wentBack = await sheetCells();
      check('unticking the meeting leaves no row behind either',
        !wentBack[`meeting:${fxMeeting.id}`], JSON.stringify(wentBack));

      /* -- the column check-all (全员到齐) ------------------------------- */
      // Deliberately driven on THIS RUN'S OWN MEETING column and never on a
      // Sunday one. The Sundays on this sheet hold the congregation's real
      // attendance, and clearing one of those columns would delete records the
      // church actually entered. The fixture meeting holds nothing but what
      // this run writes, and deleting it below takes every tick with it.
      const meetingAll = page.locator(`input.sheet-tick-all[aria-label*="${fxMeeting.name}"]`);
      check('a column carries its check-all in the header, under the date',
        (await meetingAll.count()) === 1);
      check('…reading as empty while nobody is ticked',
        !(await meetingAll.isChecked()) && (await meetingAll.evaluate((el) => el.indeterminate)) === false);
      // One check-all per sub-column, which is exactly one per tick in a
      // member's row: two per Sunday (会前 / 主日 filled separately) plus one
      // per meeting. Comparing the two counts states that without having to
      // know how many meetings this month happens to hold.
      const sundayAlls = await page.locator('input.sheet-tick-all').count();
      const rowTicks = await sheetRow.locator('input[type=checkbox]').count();
      check('every sub-column gets its own — a Sunday’s two ticks are filled separately',
        sundayAlls === rowTicks && rowTicks > (await page.locator('th:has-text("Pre-service")').count()),
        `${sundayAlls} check-alls vs ${rowTicks} ticks in a row`);

      // One person ticked out of the whole sheet is the in-between state, and
      // it has to be reported honestly rather than rounded to on or off.
      await meetingTick.first().click();
      await page.waitForFunction(
        (el) => el.indeterminate || el.checked,
        await meetingAll.elementHandle(),
        { timeout: 8000 },
      ).catch(() => {});
      check('one member ticked shows the header as indeterminate, not as checked',
        (await meetingAll.evaluate((el) => el.indeterminate)) === true &&
          !(await meetingAll.isChecked()));

      // Filling the column is ONE request for the whole sheet, not one per
      // member — the reason the write takes a list at all.
      let columnPuts = 0;
      const countPut = (r) => {
        if (r.method() === 'PUT' && r.url().includes('/api/attendance/sheet')) columnPuts++;
      };
      page.on('request', countPut);
      await meetingAll.click();
      await w(2500);
      page.off('request', countPut);
      check('filling a whole column is ONE request, not one per member',
        columnPuts === 1, `${columnPuts} PUT(s)`);
      check('…and needs no confirmation, because nothing is lost',
        (await page.locator('.modal-backdrop').count()) === 0);
      const wholeSheet = await apiGet(`/attendance/sheet?year=${SHEET_YEAR}&month=${Number(SHEET_MONTH)}`);
      const onColumn = (wholeSheet.rows || []).filter(
        (r) => r.cells?.[`meeting:${fxMeeting.id}`]?.attended === true,
      ).length;
      check('every member on the sheet is marked by that one call',
        onColumn === (wholeSheet.rows || []).length && onColumn > 0,
        `${onColumn} of ${(wholeSheet.rows || []).length}`);
      check('…and the header now reads as fully ticked', await meetingAll.isChecked());

      // Clearing throws real records away, so it asks first and says how many.
      await meetingAll.click();
      await page.locator('.modal-backdrop').last().waitFor({ timeout: 8000 });
      const clearCopy = await page.locator('.modal-backdrop').last().innerText();
      check('clearing a whole column asks first, names it and counts what goes',
        clearCopy.includes(fxMeeting.name) && new RegExp(`${onColumn}\\s+ticks`).test(clearCopy) &&
          /cannot be undone/i.test(clearCopy),
        clearCopy.replace(/\s+/g, ' ').slice(0, 160));
      // Backing out must leave the column exactly as it was.
      await page.locator('.modal-backdrop').last().locator('button:has-text("Cancel")').last().click();
      await w(1200);
      check('backing out of that confirmation changes nothing',
        (await sheetCells())[`meeting:${fxMeeting.id}`]?.attended === true);

      await meetingAll.click();
      await page.locator('.modal-backdrop').last().waitFor({ timeout: 8000 });
      await page.locator('.modal-backdrop').last().locator('button:has-text("Clear column")').last().click();
      await w(2500);
      const clearedSheet = await apiGet(`/attendance/sheet?year=${SHEET_YEAR}&month=${Number(SHEET_MONTH)}`);
      check('confirming leaves no row behind anywhere in that column',
        (clearedSheet.rows || []).every((r) => !r.cells?.[`meeting:${fxMeeting.id}`]));

      // The meeting's own name in the header is where it is edited from.
      await meetingHead.locator(`button:has-text("${fxMeeting.name}")`).first().click();
      await page.locator('.modal').waitFor({ timeout: 8000 });
      check('the edit modal opens on that meeting',
        (await page.locator('.modal input').first().inputValue()) === fxMeeting.name);
      // A hand-added meeting is a name, a date and where to go: no type and no
      // recurrence. Three inputs (+ the congregation select) and no more.
      check('a meeting asks for a name, a date and a place',
        (await page.locator('.modal input').count()) === 3,
        `${await page.locator('.modal input').count()} inputs`);
      // 地点 is what the dashboard has always rendered and nothing could fill,
      // so what matters is the round trip: typed here, stored on the row.
      const placeBox = page.locator('.modal input[placeholder*="prayer room"]');
      check('the meeting form offers a place to meet', (await placeBox.count()) === 1);
      if (await placeBox.count()) {
        await placeBox.fill('ZZ_UITEST_地点');
        await page.locator('.modal button:has-text("Save")').first().click();
        await w(1500);
        const savedMeeting = await apiGet(`/events/${fxMeeting.id}`).catch(() => null);
        check('a place typed into the meeting form is stored on it',
          savedMeeting?.location === 'ZZ_UITEST_地点', String(savedMeeting?.location));
      } else {
        await page.locator('.modal button:has-text("Cancel")').first().click();
      }

      // The sheet is the widest thing in the app. It has to scroll inside its
      // own card — the page body must never scroll sideways on a phone.
      await w(300);
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check('the wide sheet scrolls inside its card, not the page', over <= 1, `+${over}px`);
      await shot('05-events');

      // Deleting a meeting throws its ticks away with it, so it asks first and
      // names what it is deleting (rule G3).
      await meetingHead.locator(`button:has-text("${fxMeeting.name}")`).first().click();
      await page.locator('.modal').waitFor({ timeout: 8000 });
      await page.locator('.modal button:has-text("Delete meeting")').first().click();
      await page.locator('.modal-backdrop').last().waitFor({ timeout: 8000 });
      const meetingConfirm = await page.locator('.modal-backdrop').last().innerText();
      check('deleting a meeting asks first, and names it',
        meetingConfirm.includes(fxMeeting.name) && /attendance/i.test(meetingConfirm),
        meetingConfirm.replace(/\s+/g, ' ').slice(0, 140));
      await page.locator('.modal-backdrop').last().locator('button:has-text("Delete")').last().click();
      await w(1800);
      const goneFromSheet = (await page.locator('th', { hasText: fxMeeting.name }).count()) === 0;
      check('the deleted meeting’s column leaves the sheet', goneFromSheet);
      // Deleted through the UI — take it off the sweep list so the run does not
      // report a leftover it already cleaned up.
      if (goneFromSheet) forget(`/events/${fxMeeting.id}`);
    } finally {
      await fxMeeting.remove();
      await fxSheetMember.remove();
    }

    /* -- trainings -------------------------------------------------------- */
    // The catalog is empty in the live database, so the course opened here is
    // one this module creates — with a session and a pending enrolee, which is
    // what makes the detail page's two panels worth asserting on at all.
    mod('trainings & activities · catalog · detail');
    const fxTraining = await makeTraining();
    const fxActivity = await makeActivity();
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
      // The sign-up link button copies AND says so. Through `navigator.clipboard`
      // alone, a browser without the async API ran no callback at all: no copy
      // and no message, which reads as a dead button. Either outcome is now a
      // toast, so a toast is what this asserts.
      const linkBtn = page.locator('button:has-text("Sign-up link")');
      if (await linkBtn.count()) {
        await linkBtn.first().click();
        const toasted = await page.locator('.toast').first().waitFor({ timeout: 5000 }).then(() => true, () => false);
        check('the sign-up link button answers the tap, copied or not', toasted);
      }
      check('a pending enrolee is offered for approval',
        (await page.locator('.enrol-row button:has-text("Approve")').count()) > 0);
      await shot('06-training-detail');

      // The page is 培训&活动 now: the same catalog holds one-off activities
      // (兄弟团爬山), so it offers both create paths — and lists both shapes
      // together, with no filter to hide half of them behind.
      await page.goto(`${BASE}/trainings`, { waitUntil: 'domcontentloaded' });
      await page.locator('.page-bar').first().waitFor({ state: 'attached', timeout: 20000 });
      check('the catalog offers both “Add training” and “Add activity”',
        (await page.locator('button:visible:has-text("Add training")').count()) > 0 &&
          (await page.locator('button:visible:has-text("Add activity")').count()) > 0);
      const activityCard = page.locator('.card h3', { hasText: fxActivity.name });
      await activityCard.first().waitFor({ timeout: 20000 });
      check('a created activity appears in the same catalog', (await activityCard.count()) === 1);
      check('…beside the trainings, with no shape filter between them',
        (await page.locator('.card h3', { hasText: fxTraining.name }).count()) === 1 &&
          (await page.locator('.page-bar-filters select').count()) === 0);

      // An activity is ONE occasion: no session list to manage, and its roll
      // call is a single column of "came".
      await activityCard.first().click();
      await page.waitForURL(/\/trainings\/[0-9a-f-]+/, { timeout: 15000 });
      await page.locator('text=Attendance sheet').first().waitFor({ timeout: 20000 });
      check('an activity has no session list to manage',
        (await page.locator('.card-head h3:has-text("Sessions")').count()) === 0);
      // The card heading above renders before the sheet's own fetch settles —
      // wait for the header cell itself, not just its card, or this races.
      await page.locator('th:has-text("Came")').first().waitFor({ timeout: 15000 }).catch(() => {});
      check('its roll call is one “Came” column',
        (await page.locator('th:has-text("Came")').count()) === 1);
      check('the person who signed up is on the roll call',
        (await page.locator(`strong:has-text("${fxActivity.goer.name}")`).count()) > 0);
      const activityBody = await page.locator('.content').innerText();
      check('the page calls it an activity, not a training',
        /Activity/.test(activityBody) && !/Edit training/.test(activityBody),
        activityBody.replace(/\s+/g, ' ').slice(0, 120));
      // An activity is one occasion with a TIME and a PLACE (0016), and both
      // live on the training row — so both read off the header line, and the
      // form has one field for each rather than a session to open.
      check('an activity shows its time and its meeting point',
        /09:30/.test(activityBody) && /ZZ_UITEST car park/.test(activityBody),
        activityBody.replace(/\s+/g, ' ').slice(0, 200));
      await shot('06b-activity-detail');

      // Editing this activity: `kind` is fixed at creation now (0024) — no
      // shape picker in the edit form, and the meeting point pairs with the
      // congregation select in one row (it used to stand alone).
      await page.locator('button:has-text("Edit activity")').first().click();
      await page.locator('.modal').first().waitFor({ timeout: 15000 });
      // No shape field at all any more — not even read-only: the modal's
      // own title ("Edit activity" / "Edit training") already says which,
      // and a redundant field asked the same question a second time.
      check('editing an activity offers no shape picker any more',
        (await page.locator('.modal [role="group"][aria-label="Shape"]').count()) === 0);
      check('…and no read-only shape field either',
        (await page.locator('.modal .field:has(.field-label:has-text("Shape"))').count()) === 0);
      check('the edit form also offers a gender-restriction field',
        (await page.locator('.modal .field:has(.field-label:has-text("Restricted to")) select').count()) === 1);
      check('…and an activity category field (0027) — never on a course',
        (await page.locator('.modal .field:has(.field-label:has-text("Category")) select').count()) === 1);
      const actFormRows = page.locator('.modal .form-row');
      const actRowTexts = await actFormRows.allInnerTexts();
      check('the meeting point and the congregation select now share one row',
        actRowTexts.some((t2) => /Meeting point/.test(t2) && /Congregation/.test(t2)),
        JSON.stringify(actRowTexts));
      await page.locator('.modal button:has-text("Cancel")').click();

      // Editing the course fixture: same kind-lock, and its own row-pairing —
      // sessions beside the congregation select, start/end date together.
      await page.goto(`${BASE}/trainings/${fxTraining.id}`, { waitUntil: 'domcontentloaded' });
      await page.locator('button:has-text("Edit training")').first().click();
      await page.locator('.modal').first().waitFor({ timeout: 15000 });
      check('editing a course offers no shape picker any more',
        (await page.locator('.modal [role="group"][aria-label="Shape"]').count()) === 0);
      check('…and no category field either — that is an activity-only field (0027)',
        (await page.locator('.modal .field:has(.field-label:has-text("Category"))').count()) === 0);
      const courseFormRows = page.locator('.modal .form-row');
      const courseRowTexts = await courseFormRows.allInnerTexts();
      check('sessions and the congregation select now share one row',
        courseRowTexts.some((t2) => /Sessions/.test(t2) && /Congregation/.test(t2)),
        JSON.stringify(courseRowTexts));
      check('…and start date / end date share their own separate row',
        courseRowTexts.some((t2) => /Start date/.test(t2) && /End date/.test(t2)),
        JSON.stringify(courseRowTexts));
      check('the gender restriction and the sign-up fee now share one row',
        courseRowTexts.some((t2) => /Restricted to/.test(t2) && /Sign-up fee/.test(t2)),
        JSON.stringify(courseRowTexts));
      await page.locator('.modal button:has-text("Cancel")').click();
    } finally {
      await fxActivity.remove();
      await fxTraining.remove();
    }

    /* -- trainings: no shape picker anywhere any more, plus a direct QR
       upload chained onto the row the moment it exists ------------------- */
    mod('trainings & activities · no shape picker · QR upload at creation');
    {
      await page.goto(`${BASE}/trainings`, { waitUntil: 'domcontentloaded' });
      await page.locator('button:visible:has-text("Add training")').first().click();
      await page.locator('.modal').first().waitFor({ timeout: 15000 });
      // The two catalog buttons ("+ Add training" / "+ Add activity") already
      // say which shape — a picker inside the form asked the same question
      // the button had just answered, so it is gone even at CREATE.
      check('CREATE offers no shape picker either — the catalog button already said which',
        (await page.locator('.modal [role="group"][aria-label="Shape"]').count()) === 0);

      const field = (label) =>
        page.locator('.modal .field', { has: page.locator('.field-label', { hasText: label }) }).locator('input, select, textarea').first();
      const qrCourseName = fixtureName('QRCOURSE');
      await field('Training name').fill(qrCourseName);
      // A fee turns the payment block — and the QR picker — on.
      await field('Sign-up fee (RM)').fill('20');
      const qrInput = page.locator('.modal .field', { has: page.locator('.field-label', { hasText: 'Payment QR' }) }).locator('input[type=file]');
      check('the QR picker appears during CREATE, not only after the row is saved',
        (await qrInput.count()) === 1);
      const qrPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      await qrInput.setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: qrPng });
      // compressImage() decodes and re-encodes the picked file client-side —
      // give it a beat before Save is pressed.
      await w(400);
      await page.locator('.modal button:has-text("Save")').click();
      await page.waitForURL(/\/trainings\/[0-9a-f-]+/, { timeout: 20000 });
      const qrTrainingId = page.url().match(/trainings\/([0-9a-f-]+)/)?.[1];
      check('the training was created', !!qrTrainingId, page.url());
      if (qrTrainingId) {
        const removeQrTraining = disposable(`training ${qrCourseName}`, `/trainings/${qrTrainingId}`);
        const created = await apiGet(`/trainings/${qrTrainingId}`);
        check('…and its payment QR was chained onto it in the same action, one request after the other',
          typeof created?.payment_qr_url === 'string' && created.payment_qr_url.length > 0,
          String(created?.payment_qr_url));
        await removeQrTraining();
      }
    }

    /* -- 报名费: the fee fields, and the receipt behind an approval -------- */
    // The fee is what turns a sign-up form into a payment: it must stay out of
    // the way when there is none, and when there IS one the admin has to be
    // able to open the receipt from the row where they approve — not from
    // another page. Both halves are asserted here, on a paid course this run
    // created and signs up for itself.
    mod('trainings & activities · 报名费 · payment receipt');
    const fxPaid = await makePaidTraining();
    // A FREE course to compare against — the fee block and the receipt field
    // must be absent, not merely empty.
    const fxTrainingFree = await makeTraining();
    try {
      await page.goto(`${BASE}/trainings/${fxPaid.id}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.card-head h3:has-text("Sign-up fee")').first().waitFor({ timeout: 20000 });
      const paidBody = await page.locator('.content').innerText();
      check('a paid course shows the fee and how to pay it',
        /RM\s*30\.00/.test(paidBody) && /ZZ_UITEST Maybank/.test(paidBody),
        paidBody.replace(/\s+/g, ' ').slice(0, 200));
      check('…and the PIC with a number to ring',
        /ZZ_UITEST PIC/.test(paidBody) && /012-000 0000/.test(paidBody));

      // The receipt opens from the review row, beside Approve.
      const payerRow = page.locator('.enrol-row', { hasText: fxPaid.payer.name });
      await payerRow.first().waitFor({ timeout: 20000 });
      const slipLink = payerRow.locator('a:has-text("Receipt")');
      check('the pending sign-up offers its receipt where the approval is made',
        (await slipLink.count()) === 1);
      const slipHref = await slipLink.first().getAttribute('href');
      check('…as a real link the admin can open in a new tab',
        !!slipHref && /^https?:\/\//.test(slipHref) &&
          (await slipLink.first().getAttribute('target')) === '_blank',
        String(slipHref).slice(0, 80));
      check('…and it is next to the Approve button, not on another page',
        (await payerRow.locator('button:has-text("Approve")').count()) === 1);
      await shot('06c-paid-training');

      // The public page a payer sees: the amount, how to pay, and a REQUIRED
      // receipt with the copy that tells them to pay first.
      await page.goto(`${BASE}/enroll/${fxPaid.id}`, { waitUntil: 'domcontentloaded' });
      await page.locator('input[type=file]').first().waitFor({ timeout: 20000 });
      const publicBody = await page.locator('.card').first().innerText();
      check('the public sign-up page states the fee and how to pay it',
        /RM\s*30\.00/.test(publicBody) && /ZZ_UITEST Maybank/.test(publicBody),
        publicBody.replace(/\s+/g, ' ').slice(0, 200));
      // This public page has no session, so it renders in the DEFAULT
      // language (rule G8) — zh, not en — so the check has to read either.
      check('…with a line telling people to pay first and upload the receipt',
        (/pay the fee first/i.test(publicBody) && /before approving/i.test(publicBody)) ||
          (publicBody.includes('请先完成付款') && publicBody.includes('先核对凭证才通过')),
        publicBody.replace(/\s+/g, ' ').slice(0, 240));
      check('…and a receipt field that takes a photo or a PDF',
        (await page.locator('input[type=file]').first().getAttribute('accept'))?.includes('pdf') === true);
      // The button waits for the receipt: a name alone is not a paid sign-up.
      await page.locator('input[placeholder]').first().fill('ZZ_UITEST nobody');
      await w(300);
      // Public page, no session → default language (zh), not en (rule G8).
      check('the submit button stays disabled until a receipt is attached',
        await page.locator('button:has-text("提交报名")').first().isDisabled());

      // …and a FREE one asks for none of it, which is the other half.
      await page.goto(`${BASE}/enroll/${fxTrainingFree.id}`, { waitUntil: 'domcontentloaded' });
      await page.locator('input[placeholder]').first().waitFor({ timeout: 20000 });
      const freeBody = await page.locator('.card').first().innerText();
      check('a free sign-up page shows no fee block and asks for no receipt',
        !/Sign-up fee/i.test(freeBody) && !freeBody.includes('报名费') && (await page.locator('input[type=file]').count()) === 0,
        freeBody.replace(/\s+/g, ' ').slice(0, 160));
      await shot('06d-public-paid');
    } finally {
      await fxPaid.remove();
      await fxTrainingFree.remove();
    }

    /* -- members · import + the public registration link ------------------- */
    // Two doorways onto the same roll: a spreadsheet the office uploads, and a
    // link a stranger fills in. Neither may create a second copy of somebody
    // who is already on the roll — that rule lives in `lib/members-import.ts`
    // and is unit-tested there, so what this asserts is that both doorways
    // EXIST and open, which no unit test can see.
    mod('members · import · public registration link');
    try {
      await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
      await page.locator('.page-bar').first().waitFor({ state: 'attached', timeout: 20000 });
      check('the members page offers an import',
        (await page.locator('button:visible:has-text("Import")').count()) === 1);
      check('…and a registration link to hand out',
        (await page.locator('button:visible:has-text("Registration link")').count()) === 1);
      await page.locator('button:visible:has-text("Import")').first().click();
      await page.locator('.modal-backdrop').last().waitFor({ timeout: 8000 });
      const importCopy = await page.locator('.modal-backdrop').last().innerText();
      check('the import asks for a file and offers the template that names the columns',
        /template/i.test(importCopy) &&
          (await page.locator('.modal-backdrop').last().locator('input[type=file]').count()) === 1,
        importCopy.replace(/\s+/g, ' ').slice(0, 140));
      check('…and writes nothing on the way in — no apply button before a file',
        (await page.locator('.modal-backdrop').last().locator('button:has-text("Import"):not(:disabled)').count()) === 0);
      await page.keyboard.press('Escape');
      await w(400);

      // The public form itself: no session, no shell, and it must render for
      // somebody who has never signed in — which is the whole point of it.
      const anon = await browser.newContext({ viewport: { width: 402, height: 874 } });
      try {
        const anonPage = await anon.newPage();
        await anonPage.goto(`${BASE}/join`, { waitUntil: 'domcontentloaded' });
        await anonPage.locator('input').first().waitFor({ timeout: 20000 });
        const joinBody = await anonPage.locator('body').innerText();
        // No session → default language (zh), not en (rule G8).
        check('the registration link opens with no session at all',
          (/Register as a member/i.test(joinBody) || joinBody.includes('注册成为会友')) &&
            (await anonPage.locator('.sidebar').count()) === 0,
          joinBody.replace(/\s+/g, ' ').slice(0, 140));
        check('…and takes a photo from the camera OR the gallery, never forcing one',
          (await anonPage.locator('input[type=file][accept*="image"]').count()) === 1 &&
            (await anonPage.locator('input[type=file][capture]').count()) === 0);
        check('…and says it will update rather than duplicate somebody already on the roll',
          /updates your details/i.test(joinBody) || joinBody.includes('只会更新资料'));
      } finally {
        await anon.close();
      }
    } catch (e) {
      check('the run aborted', false, e.message.split('\n')[0]);
    }

    /* -- forty days ------------------------------------------------------- */
    // Every 守望 pair was wiped, so the relay chart and the progress dialog have
    // nothing to show unless this module pairs two throwaway members itself.
    mod('forty days · progress dialog');
    const fxPair = await makePair();
    try {
      // A staff remark, set directly (the point of C1's field is that AddPairModal
      // can also write it at creation — this covers the PATCH half of the same
      // column, and gives the overview table something real to show).
      const pairRemark = 'ZZ_UITEST 进度良好';
      await ctx.request.patch(`${BASE}/api/discipleship/pairs/${fxPair.id}`, { data: { remark: pairRemark } });

      await page.goto(`${BASE}/discipleship`, { waitUntil: 'domcontentloaded' });
      await page.locator('.chip', { hasText: 'Active' }).first().waitFor({ timeout: 20000 });
      await page.locator('.chip', { hasText: 'Completed' }).first().click();
      await w(400);
      await page.locator('.chip', { hasText: 'Active' }).first().click();
      await w(400);
      check('the relay chart state filter switches', true);

      // The pastor-overview table: mentor and trainee are now their OWN
      // columns (not one combined "trainee ← mentor" cell), and a Remark
      // column sits right before the actions column. This table is
      // `.only-desktop`, hidden at this suite's phone viewport, so the check
      // reads textContent (DOM-only) rather than innerText (visibility-aware).
      const theadThs = page.locator('.only-desktop table thead th');
      // Sortable columns (SortTh) append a caret to whichever is the active
      // sort key, so an exact 'Trainee' match breaks the moment sorting
      // lands on that column — hence startsWith rather than equality.
      const headerTexts = (await theadThs.allTextContents()).map((s) => s.trim());
      check('the pastor-overview table splits mentor and trainee into separate columns',
        headerTexts.some((h) => h.startsWith('Trainee')) && headerTexts.some((h) => h.startsWith('Mentor')),
        JSON.stringify(headerTexts));
      check('…and a Remark column sits immediately before the actions column',
        headerTexts.length >= 2 && headerTexts[headerTexts.length - 2] === 'Remark', JSON.stringify(headerTexts));
      const remarkCell = page.locator('.only-desktop table tbody tr', { has: page.locator(`text=${fxPair.traineeName}`) })
        .locator('.cell-remark');
      check('…and this pair’s row shows the remark that was set',
        (await remarkCell.first().textContent())?.trim() === pairRemark,
        await remarkCell.first().textContent());

      const pairTile = page.locator('.mtile', { hasText: fxPair.traineeName });
      await pairTile.first().waitFor({ timeout: 20000 });
      check('a created pair appears in the pastor overview', (await pairTile.count()) === 1);
      check('…and the mobile tile shows the remark too',
        (await pairTile.first().innerText()).includes(pairRemark));
      await pairTile.first().click();
      await page.locator('.modal .day-cell').first().waitFor({ timeout: 15000 });
      check('opening a pair shows the 40-day grid', (await page.locator('.modal .day-cell').count()) >= 40);

      // The pair-level remark is editable right here too, pre-filled with
      // what was just set — not merely displayed.
      const modalRemark = page.locator('.modal .field', { has: page.locator('.field-label', { hasText: 'Remark' }) }).locator('textarea');
      check('the remark is editable inside the progress dialog, pre-filled',
        (await modalRemark.inputValue()) === pairRemark);

      await page.locator('.modal .day-cell').first().click();
      await w(400);
      check("clicking a day shows that day's entry", /Day\s*1\b/.test(await page.locator('.modal').innerText()));

      // The day entry is now EDITABLE — a checkbox, notes, and entry
      // date/time — not a read-only badge. Nothing here auto-saves.
      check('a day cell offers a completed checkbox and entry date/time fields',
        (await page.locator('.modal input[type=checkbox]').count()) === 1 &&
          (await page.locator('.modal input[type=date]').count()) === 1 &&
          (await page.locator('.modal input[type=time]').count()) === 1);
      const dayNote = 'ZZ_UITEST day one note';
      await page.locator('.modal textarea').last().fill(dayNote);
      await page.locator('.modal input[type=checkbox]').first().check();
      await shot('07-pair-modal');

      // Footer is exactly one row: Delete, Share, Save — no separate "Open
      // form" any more, since this dialog can now fill in an entry itself.
      const footerLabels = (await page.locator('.modal .modal-actions button').allInnerTexts()).map((s) => s.trim());
      check('the footer is one row — Delete, Share, Save',
        footerLabels.some((l) => /Delete/i.test(l)) &&
          footerLabels.some((l) => /Copy link/i.test(l)) &&
          footerLabels.some((l) => /^Save$/i.test(l)),
        JSON.stringify(footerLabels));
      check('…and "Open form" is gone — Share is the only way to the public link now',
        !footerLabels.some((l) => /Open form/i.test(l)), JSON.stringify(footerLabels));

      await page.locator('.modal button:has-text("Save")').click();
      const saveToasted = await page.locator('.toast').first().waitFor({ timeout: 5000 }).then(() => true, () => false);
      check('saving the day entry and the remark together answers with a toast', saveToasted);
      await w(500);

      // Reopen and confirm it actually persisted — Save must not have been a
      // no-op that only looked like it worked.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.mtile', { hasText: fxPair.traineeName }).first().waitFor({ timeout: 20000 });
      await page.locator('.mtile', { hasText: fxPair.traineeName }).first().click();
      await page.locator('.modal .day-cell').first().waitFor({ timeout: 15000 });
      check('the day is marked done after reload', (await page.locator('.modal .day-cell.done').count()) >= 1);
      await page.locator('.modal .day-cell').first().click();
      await w(400);
      check('…and the note that was typed actually persisted',
        (await page.locator('.modal textarea').last().inputValue()) === dayNote);

      await page.locator('.modal .icon-btn').first().click();
      await w(300);
      check('✕ closes the dialog', (await page.locator('.modal').count()) === 0);

      // The pair reads as one sentence ("Led by X" / "Leading X") on the
      // MEMBER's own detail page now, not a bare "Mentor"/"Trainee" badge.
      await page.goto(`${BASE}/members/${fxPair.traineeId}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.content:has-text("Forty Days")').first().waitFor({ timeout: 15000 });
      // The "Forty Days" section heading renders before its own pairs fetch
      // settles — wait for the actual sentence, not just the card around it.
      await page.locator(`.content:has-text("Led by ${fxPair.mentorName}")`).first().waitFor({ timeout: 10000 }).catch(() => {});
      const traineePageBody = await page.locator('.content').innerText();
      check('the trainee’s own page reads the pair as "Led by <mentor>"',
        traineePageBody.includes(`Led by ${fxPair.mentorName}`) &&
          !traineePageBody.includes('Mentor') && !traineePageBody.includes('Trainee'));

      // AddPairModal (C1): mentor and trainee comboboxes sit in ONE row now,
      // divider "➜" between them, plus an optional remark field — replacing
      // the old vertical stack with a centred "↓".
      await page.goto(`${BASE}/discipleship`, { waitUntil: 'domcontentloaded' });
      await page.locator('button:visible:has-text("Add pair")').first().click();
      await page.locator('.modal').first().waitFor({ timeout: 15000 });
      const pickerRow = page.locator('.modal .flex.items-end.gap-10.flex-wrap');
      check('mentor and trainee sit in one row, not stacked with a ↓ divider',
        (await pickerRow.count()) === 1 &&
          (await pickerRow.locator('.combo').count()) === 2 &&
          /➜/.test(await pickerRow.innerText()));
      check('the add-pair form also offers a remark field',
        (await page.locator('.modal .field', { has: page.locator('.field-label', { hasText: 'Remark' }) }).locator('textarea').count()) === 1);
      await page.locator('.modal button:has-text("Cancel")').click();
    } finally {
      await fxPair.remove();
    }

    /* -- forty days · relay chart scoped to one member (0115) -------------- */
    // Z ➜ A ➜ B ➜ C, plus A ➜ D (a sibling branch off A, alongside B). Scoping
    // to B must keep the single lead-by chain UP (Z, A) and the whole
    // branching subtree DOWN (C), but never D — D is reachable from A, not
    // from B, and A having another trainee besides B is exactly the kind of
    // sibling noise the scope exists to cut out.
    mod('forty days · relay chart scoped to one member');
    const cxTop = await makeMember('RELAYTOP');
    const cxMid = await makeMember('RELAYMID');
    const cxTarget = await makeMember('RELAYTARGET');
    const cxSibling = await makeMember('RELAYSIB');
    const cxChild = await makeMember('RELAYCHILD');
    try {
      const relayProgramId = (await apiGet('/discipleship/programs'))?.[0]?.id;
      if (!relayProgramId) throw new Error('no discipleship program configured — cannot build the relay fixture');
      const mkRelayPair = async (mentorId, traineeId) => {
        const row = await apiPost('/discipleship/pairs', { program_id: relayProgramId, mentor_id: mentorId, trainee_id: traineeId });
        return disposable(`pair ${mentorId} → ${traineeId}`, `/discipleship/pairs/${row.id}`);
      };
      const removeRelayPairs = [
        await mkRelayPair(cxTop.id, cxMid.id),
        await mkRelayPair(cxMid.id, cxTarget.id),
        await mkRelayPair(cxMid.id, cxSibling.id),
        await mkRelayPair(cxTarget.id, cxChild.id),
      ];
      try {
        await page.goto(`${BASE}/discipleship`, { waitUntil: 'domcontentloaded' });
        await page.locator('.chip', { hasText: 'Active' }).first().waitFor({ timeout: 20000 });
        const chartCard = page.locator('.card').first();
        await chartCard.locator(`text=${cxTarget.name}`).first().waitFor({ timeout: 15000 });
        check('unscoped, the chart shows the whole tree — including the sibling branch',
          (await chartCard.innerText()).includes(cxSibling.name));

        const scopeCombo = chartCard.locator('input[role=combobox]').first();
        await scopeCombo.click();
        await scopeCombo.fill(cxTarget.name);
        await w(400);
        await page.locator('.combo-list .combo-option').first().waitFor({ timeout: 8000 });
        await page.locator('.combo-list .combo-option').first().click();
        await w(400);

        const scopedBody = await chartCard.innerText();
        check('scoped to the middle member, the chain shows the full ancestor chain upward',
          scopedBody.includes(cxTop.name) && scopedBody.includes(cxMid.name) && scopedBody.includes(cxTarget.name),
          scopedBody.slice(0, 300));
        check('…the whole descendant branch downward',
          scopedBody.includes(cxChild.name));
        check('…but never the sibling branch off an ancestor',
          !scopedBody.includes(cxSibling.name));

        // Clearing the scope (the Combobox's own ✕, rule G4) returns to the
        // unscoped, whole-forest view.
        await chartCard.locator('.combo-clear').first().click();
        await w(400);
        check('clearing the scope shows the sibling branch again',
          (await chartCard.innerText()).includes(cxSibling.name));
      } finally {
        for (const remove of removeRelayPairs) await remove();
      }
    } finally {
      await cxChild.remove();
      await cxSibling.remove();
      await cxTarget.remove();
      await cxMid.remove();
      await cxTop.remove();
    }

    /* -- forty days · the module is read, never managed -------------------- */
    // There WAS a 守望模块 manager here — a Modules button over a list dialog
    // with an edit form and a per-row delete, driven through a throwaway
    // module of its own. It was a misreading of what the church meant by
    // "module" and it is gone, along with the PATCH/DELETE routes behind it.
    // What is asserted now is that it is gone from BOTH halves: no button in
    // the UI, and no route on the server (rule G2 — hiding a control is not
    // removing a capability). The church's own module is only ever read, so
    // this module creates no fixture and has nothing to clean up.
    mod('forty days · no module manager');
    await page.goto(`${BASE}/discipleship`, { waitUntil: 'domcontentloaded' });
    await page.locator('.chip', { hasText: 'Active' }).first().waitFor({ timeout: 20000 });
    check('the page offers no module manager button',
      (await page.locator('button:visible:has-text("Modules")').count()) === 0);
    const liveModules = await apiGet('/discipleship/programs');
    check('the church still has its module, and it is readable',
      Array.isArray(liveModules) && liveModules.length >= 1, `${liveModules?.length} module(s)`);
    if (liveModules?.[0]?.id) {
      const moduleId = liveModules[0].id;
      const patched = await ctx.request.patch(`${BASE}/api/discipleship/programs/${moduleId}`, {
        data: { total_days: 999 },
      });
      check('editing a module by hand is refused — the route is gone',
        patched.status() === 404, `status ${patched.status()}`);
      const deleted = await ctx.request.delete(`${BASE}/api/discipleship/programs/${moduleId}`);
      check('deleting one by hand is refused too', deleted.status() === 404, `status ${deleted.status()}`);
      const afterModules = await apiGet('/discipleship/programs');
      check('…and the church’s module survived both attempts',
        afterModules.find((p) => p.id === moduleId)?.total_days === liveModules[0].total_days,
        String(afterModules.find((p) => p.id === moduleId)?.total_days));
    }

    /* -- happiness groups: term → group → roster → weekly attendance ------ */
    // Unlike 守望, a term is a first-class, repeatable entity with full CRUD —
    // so this module drives term creation and group creation THROUGH THE UI
    // (not pre-seeded over the API, the way the life-group fixture is), then
    // the roster Combobox and the week-by-week tick the same way the life
    // group's own column is driven above: on this run's own fixture, never a
    // week that could be somebody's real attendance.
    mod('happiness groups · term → group → roster → weekly attendance');
    const fxHappyMember = await makeMember('HAPPY');
    const happyTermNo = Math.floor(Date.now() / 1000);
    const happyTermName = fixtureName('TERM');
    const happyGroupName = fixtureName('GROUP');
    let happyTermId = null;
    try {
      /* -- term, created through the UI ----------------------------------- */
      await page.goto(`${BASE}/happiness`, { waitUntil: 'domcontentloaded' });
      await page.locator('button:visible:has-text("Add term")').first().waitFor({ timeout: 20000 });
      await page.locator('button:visible:has-text("Add term")').first().click();
      await page.locator('.modal').waitFor({ timeout: 8000 });
      // Term number, then weeks — both plain number inputs in that order.
      await page.locator('.modal input[type=number]').first().fill(String(happyTermNo));
      // The name field is the modal's only untyped text input.
      await page.locator('.modal input:not([type=number]):not([type=date])').first().fill(happyTermName);
      await page.locator('.modal button:has-text("Save")').first().click();
      await w(1500);
      // The catalog is a card grid now (0116, strictly copying 培训&活动's own
      // catalog shape) — a term's card is found by its own name, the same
      // `.card h3:has-text(...)` pattern the trainings catalog already uses.
      const termCard = page.locator('.card', { has: page.locator('h3', { hasText: happyTermName }) });
      await termCard.first().waitFor({ timeout: 20000 });
      check('creating a term through the UI adds it to the list', (await termCard.count()) === 1);
      const catalogBody = await page.locator('.content').innerText();
      check('the catalog is bucketed Current / Upcoming / Ended, like 培训&活动',
        ['Current', 'Upcoming', 'Ended'].every((label) => catalogBody.includes(label)));
      const termsAfter = await apiGet('/happiness/terms');
      happyTermId = termsAfter.find((t) => t.term_no === happyTermNo)?.id ?? null;
      check('…and it is readable from the API, weeks defaulting to 8',
        !!happyTermId && termsAfter.find((t) => t.id === happyTermId)?.weeks === 8,
        JSON.stringify(termsAfter.find((t) => t.term_no === happyTermNo)));

      /* -- group, under that term, created through the UI ------------------ */
      await termCard.locator('h3').first().click();
      await page.waitForURL(/\/happiness\/[0-9a-f-]+/, { timeout: 15000 });
      await page.locator('button:visible:has-text("Add group")').first().waitFor({ timeout: 20000 });
      check('opening a term shows its own facts (period number, weeks)',
        (await page.locator('.content').innerText()).includes(String(happyTermNo)));
      await page.locator('button:visible:has-text("Add group")').first().click();
      await page.locator('.modal').waitFor({ timeout: 8000 });
      await page.locator('.modal input').first().fill(happyGroupName);
      const groupHallSel = page.locator('.modal select').first();
      const groupHallOpt = await groupHallSel.locator('option').nth(1).getAttribute('value').catch(() => null);
      if (groupHallOpt) await groupHallSel.selectOption(groupHallOpt);
      await page.locator('.modal button:has-text("Save")').first().click();
      await w(1500);
      const groupTile = page.locator('.mtile', { hasText: happyGroupName });
      await groupTile.first().waitFor({ timeout: 20000 });
      check('creating a group through the UI adds it to the term’s own list', (await groupTile.count()) === 1);

      // The term's own group list offers a search box now (0116, the one
      // affordance groups/page.tsx has that this term-scoped list didn't).
      await page.fill('.page-bar-filters input', 'ZZ_NOMATCH_QUERY');
      await w(400);
      check('the group search box narrows the term’s list to nothing on a query that matches no group',
        (await page.locator('.mtile', { hasText: happyGroupName }).count()) === 0);
      await page.fill('.page-bar-filters input', happyGroupName);
      await w(400);
      check('…and back to the fixture group once the query matches it',
        (await page.locator('.mtile', { hasText: happyGroupName }).count()) === 1);
      await page.fill('.page-bar-filters input', '');
      await w(400);

      /* -- group detail: roster + week-numbered attendance sheet ---------- */
      await groupTile.first().click();
      await page.waitForURL(/\/happiness\/group\/[0-9a-f-]+/, { timeout: 15000 });
      const happyGroupId = page.url().match(/\/happiness\/group\/([0-9a-f-]+)/)?.[1] ?? null;
      check('…and its own detail page opens', !!happyGroupId);

      // Roster add via the shared Combobox (rule G4) — never a native <select>.
      const rosterCombo = page.locator('.combo input[role=combobox]').first();
      await rosterCombo.click();
      await rosterCombo.fill(fxHappyMember.name);
      await w(400);
      await page.locator('.combo-list .combo-option').first().waitFor({ timeout: 8000 });
      check('the roster combobox offers 教会成员 and 福友 with no role filtering — one option matches',
        (await page.locator('.combo-list .combo-option').count()) === 1);
      await page.locator('.combo-list .combo-option').first().click();
      await w(300);
      await page.locator('button:visible:has-text("Add member")').first().click();
      // The attendance table below (including its week columns) only renders
      // once the roster is non-empty, so this add has to actually land before
      // either check below — a fixed sleep here silently broke both.
      const rosterAdded = await page.locator(`table td:has-text("${fxHappyMember.name}")`).first()
        .waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
      check('adding a roster member via the Combobox shows them on the roster', rosterAdded);

      // The sheet's columns are WEEK NUMBERS, never dates — the one roll call
      // in the app that isn't date-based.
      const weekHeads = page.locator('table.sheet-table thead th', { hasText: 'Week' });
      await weekHeads.first().waitFor({ timeout: 10000 }).catch(() => {});
      check('the attendance sheet has a column per week (Week N), never a calendar date',
        (await weekHeads.count()) === 8, `${await weekHeads.count()} week column(s)`);

      const rosterRow = page.locator('table.sheet-table tbody tr', { hasText: fxHappyMember.name });
      await rosterRow.first().waitFor({ timeout: 20000 });
      // Week 1 is the first tick box in the row — the member-name cell carries
      // no checkbox of its own.
      const week1Tick = rosterRow.locator('input[type=checkbox]').first();
      await week1Tick.click();
      await w(1500);
      const attAfterTick = happyGroupId ? await apiGet(`/happiness/groups/${happyGroupId}/attendance`) : { records: [] };
      check('ticking week 1 records that member present that week',
        (attAfterTick.records || []).some((r) => r.week_number === 1 && r.member_id === fxHappyMember.id),
        JSON.stringify(attAfterTick.records));
      await week1Tick.click();
      await w(1500);
      const attAfterUntick = happyGroupId ? await apiGet(`/happiness/groups/${happyGroupId}/attendance`) : { records: [] };
      check('unticking it DELETES the row — a presence-only table, no absence to store',
        !(attAfterUntick.records || []).some((r) => r.week_number === 1 && r.member_id === fxHappyMember.id),
        JSON.stringify(attAfterUntick.records));
    } finally {
      // Deleting the term cascades its group, roster and every week of
      // attendance — nothing else here needs its own teardown.
      if (happyTermId) {
        const gone = await apiDelete(`/happiness/terms/${happyTermId}`);
        console.log(`  ↳ cleanup: ${gone ? 'deleted' : 'COULD NOT DELETE'} happiness term ${happyTermName} (cascades its group)`);
        if (!gone) console.log(`  ↳ purge will retry: /happiness/terms/${happyTermId}`);
      }
      await fxHappyMember.remove();
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

    // Cancel / Save is pinned to the foot of the viewport instead of sitting
    // at the bottom of a long form, so it is reachable from anywhere on the
    // page. Sticky, not fixed — measured at the TOP of the page, where a
    // non-sticky row would be far below the fold.
    await page.evaluate(() => window.scrollTo(0, 0));
    await w(400);
    const footer = page.locator('.detail-footer');
    check('the account form has one pinned Cancel / Save row', (await footer.count()) === 1);
    const footerBox = await footer.first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        position: getComputedStyle(el).position,
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        viewport: window.innerHeight,
        scrollable: document.documentElement.scrollHeight > window.innerHeight,
      };
    });
    check('…which is sticky and on screen from the top of the form',
      footerBox.position === 'sticky' && footerBox.scrollable &&
        footerBox.top >= 0 && footerBox.bottom <= footerBox.viewport + 1,
      JSON.stringify(footerBox));
    // It stays in the flow, so it can never sit on top of the last row of
    // content: scrolled to the very bottom, nothing overlaps it.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await w(400);
    const covers = await footer.first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top - 6);
      return !!hit && el.contains(hit);
    });
    check('…and never covers the last row of content', covers === false);
    await shot('08-settings');

    // The linked-member picker on the create form is the same shared
    // combobox, not a native <select> (rule G4).
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    await page.locator('button:visible:has-text("New account")').first().waitFor({ timeout: 20000 });
    await page.locator('button:visible:has-text("New account")').first().click();
    await page.locator('.modal').waitFor({ timeout: 8000 });
    check('the new-account form picks its member with a searchable combobox',
      (await page.locator('.modal input[role=combobox]').count()) === 1);
    // Two labels used to carry parenthetical asides the form no longer needs.
    const newAccountCopy = await page.locator('.modal').innerText();
    check('its labels are plain, without the explanations in brackets',
      !/members with an account are hidden/i.test(newAccountCopy) &&
        !/saved to the member profile/i.test(newAccountCopy),
      newAccountCopy.replace(/\s+/g, ' ').slice(0, 160));
    await page.locator('.modal button:has-text("Cancel")').first().click();
    await w(300);
    check('the new-account form closes again', (await page.locator('.modal').count()) === 0);

    /* -- church settings · add-on module catalog -------------------------- */
    // 四十天守望 is an ADD-ON, not a core module: a church may not run it. The
    // catalog on /church is where that is decided, and the thing worth
    // asserting is that switching it off actually reaches the whole app — the
    // nav entry goes, the page says why, and the API refuses.
    //
    // This writes to the church's LIVE settings, so the original state is read
    // first and restored in the `finally` whatever happens: a failed check
    // must never leave a module switched off for real users.
    mod('church settings · add-on modules');
    const moduleStatesBefore = await apiGet('/church/modules');
    const discBefore = moduleStatesBefore.find((m) => m.key === 'discipleship');
    const happyBefore = moduleStatesBefore.find((m) => m.key === 'happiness');
    // The `finally` below covers a failed check; this covers the process dying
    // outright, which runs no `finally` at all.
    if (discBefore) {
      restoreLater(`the discipleship module to enabled=${discBefore.enabled}`, async () => {
        const now = await ctx.request.get(`${BASE}/api/church/modules`).then((r) => r.json());
        const current = now?.find?.((m) => m.key === 'discipleship');
        if (current && current.enabled === discBefore.enabled) return;
        const r = await ctx.request.patch(`${BASE}/api/church/modules/discipleship`, {
          data: { enabled: discBefore.enabled },
        });
        if (!r.ok()) throw new Error(`restore failed: ${r.status()}`);
      });
    }
    if (happyBefore) {
      restoreLater(`the happiness module to enabled=${happyBefore.enabled}`, async () => {
        const now = await ctx.request.get(`${BASE}/api/church/modules`).then((r) => r.json());
        const current = now?.find?.((m) => m.key === 'happiness');
        if (current && current.enabled === happyBefore.enabled) return;
        const r = await ctx.request.patch(`${BASE}/api/church/modules/happiness`, {
          data: { enabled: happyBefore.enabled },
        });
        if (!r.ok()) throw new Error(`restore failed: ${r.status()}`);
      });
    }
    /** The row in the catalog for one module — its switch lives on it. */
    const catalogRow = (name) => page.locator('.card .flex-between', { hasText: name });

    // The church's two theme colours, read before anything is clicked and put
    // back in the `finally` below — the same treatment as the module switch,
    // and for the same reason: this is the live church's own branding, on
    // every screen including the sign-in page.
    const themeBefore = {
      preset: churchRecord.theme_preset ?? null,
      rail: churchRecord.theme_rail,
      brand: churchRecord.theme_brand,
    };
    /** Restore/choose a theme: by preset key when it had one, else the pair. */
    const themeBody = (t) =>
      t.preset ? { theme_preset: t.preset } : { theme_preset: null, theme_rail: t.rail, theme_brand: t.brand };
    /** Is the live record back on the colours this run found? */
    const themeIsRestored = async () => {
      const now = await ctx.request.get(`${BASE}/api/church`).then((r) => r.json());
      return now.theme_rail === themeBefore.rail && now.theme_brand === themeBefore.brand;
    };
    // …and once more for the path that runs no `finally` at all (a crash).
    if (themeBefore.rail) {
      restoreLater(`the church theme to ${themeBefore.preset ?? `${themeBefore.rail}/${themeBefore.brand}`}`, async () => {
        if (await themeIsRestored()) return;
        const r = await ctx.request.patch(`${BASE}/api/church`, { data: themeBody(themeBefore) });
        if (!r.ok()) throw new Error(`restore failed: ${r.status()}`);
      });
    }
    /** `#rrggbb` as the browser reports a computed colour. */
    const asRgb = (hex) => {
      const n = parseInt(String(hex).slice(1), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    const sidebarBg = () =>
      page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).backgroundColor);
    try {
      await page.goto(`${BASE}/church`, { waitUntil: 'domcontentloaded' });
      await page.locator('button:has-text("Save church profile")').first().waitFor({ timeout: 20000 });
      const churchBody = await page.locator('.content').innerText();
      check('church settings shows the church profile and the module catalog',
        churchBody.includes('Church profile') && churchBody.includes('Add-on modules'));
      // Skip file inputs: the logo picker is an invisible <input type=file>
      // that sits ABOVE the name field in the DOM, so "the card's first input"
      // is the file picker and its value is always empty.
      const churchName = page.locator('.card input:not([type=file])').first();
      check('the church name field is filled from the record',
        (await churchName.inputValue()) === churchRecord.name,
        `field=${await churchName.inputValue()} record=${churchRecord.name}`);

      /* -- the theme: two colours, chosen here, applied everywhere ---------- */
      // The theme is the church's branding, not a personal preference, so it
      // is stored on the church record and shows on every screen — the
      // sidebar's own colour above all. What is worth asserting is exactly
      // that: pick a preset, and the rail IS a different colour, without a
      // reload. Restored below, like the module switch: these are the colours
      // real users see.
      check('church settings offers the theme picker',
        churchBody.includes('Theme colours') && (await page.locator('.theme-option').count()) > 1,
        `${await page.locator('.theme-option').count()} presets`);
      check('the sidebar is painted in the church’s stored rail colour',
        (await sidebarBg()) === asRgb(themeBefore.rail),
        `sidebar=${await sidebarBg()} record=${themeBefore.rail}`);
      // Any chip that is not the one in use — `:not(.on)` guarantees a
      // different preset, and every preset ships a different pair.
      await page.locator('.theme-option:not(.on)').first().click();
      await w(1500);
      const themeAfter = await apiGet('/church');
      check('picking a preset stores its pair on the church record',
        themeAfter.theme_preset && themeAfter.theme_preset !== themeBefore.preset &&
          themeAfter.theme_rail !== themeBefore.rail,
        `${themeAfter.theme_preset} ${themeAfter.theme_rail}/${themeAfter.theme_brand}`);
      check('…and the sidebar repaints under the picker, with no reload',
        (await sidebarBg()) === asRgb(themeAfter.theme_rail),
        `sidebar=${await sidebarBg()} record=${themeAfter.theme_rail}`);
      check('the chosen preset is the one marked in use, with a tick as well as a colour',
        (await page.locator('.theme-option.on').count()) === 1 &&
          (await page.locator('.theme-option.on').innerText()).includes('✓'),
        (await page.locator('.theme-option.on').innerText().catch(() => '—')).replace(/\s+/g, ' '));
      await shot('08b-theme');
      // Put the church's own colours back, and prove they came back — the
      // `restoreLater` above only covers a run that dies before this point.
      const themeRestored = await ctx.request.patch(`${BASE}/api/church`, { data: themeBody(themeBefore) });
      check('the church theme was restored', themeRestored.ok(), `status ${themeRestored.status()}`);
      await page.goto(`${BASE}/church`, { waitUntil: 'domcontentloaded' });
      await page.locator('.theme-option').first().waitFor({ timeout: 20000 });
      await w(800);
      check('…and the sidebar is the church’s own colour again',
        (await sidebarBg()) === asRgb(themeBefore.rail),
        `sidebar=${await sidebarBg()} record=${themeBefore.rail}`);

      // The catalog is its own fetch and sits below the theme card, which is
      // all the navigation above waited for — so wait for the row itself
      // rather than counting whatever has arrived by now.
      await catalogRow('Forty Days').locator('.switch').first()
        .waitFor({ timeout: 20000 }).catch(() => {});
      check('the catalog lists the Forty Days add-on with a switch',
        (await catalogRow('Forty Days').locator('.switch').count()) === 1);

      check('the catalog reports the module’s stored state',
        typeof discBefore?.enabled === 'boolean', JSON.stringify(discBefore));
      // The toggle cycle starts from ON. A church that has genuinely switched
      // it off is not a failure — say so and leave its setting alone.
      if (!discBefore?.enabled) check('module already off — toggle cycle skipped', true);
      if (discBefore?.enabled) {
        // Turning one off removes a whole section for everyone, so it asks
        // first and the message has to say what goes and what is kept (G3).
        await catalogRow('Forty Days').locator('.switch').first().click();
        await page.locator('.modal-backdrop').last().waitFor({ timeout: 8000 });
        const confirmCopy = await page.locator('.modal-backdrop').last().innerText();
        check('switching a module off asks first, and says what disappears',
          confirmCopy.includes('Forty Days') && /sidebar/i.test(confirmCopy),
          confirmCopy.replace(/\s+/g, ' ').slice(0, 140));
        check('…and promises the existing pairs and progress are kept',
          /nothing is deleted/i.test(confirmCopy) && /progress/i.test(confirmCopy),
          confirmCopy.replace(/\s+/g, ' ').slice(0, 200));
        await page.locator('.modal-backdrop').last().locator('button:has-text("Turn off module")').last().click();
        await w(1500);

        const offStates = await apiGet('/church/modules');
        check('confirming stores the module as off',
          offStates.find((m) => m.key === 'discipleship')?.enabled === false,
          JSON.stringify(offStates));
        // The server is the authority: the path has to stop answering, not
        // just stop being linked (rule G2).
        const blocked = await ctx.request.get(`${BASE}/api/discipleship/programs`);
        check('a disabled module’s API path is refused', blocked.status() === 404, `status ${blocked.status()}`);

        await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
        await page.locator('.mtile').first().waitFor({ timeout: 20000 });
        check('the nav loses the disabled module’s entry',
          !(await page.locator('.sidebar').innerText()).includes('Forty Days'));

        await page.goto(`${BASE}/discipleship`, { waitUntil: 'domcontentloaded' });
        await page.locator('.empty').first().waitFor({ timeout: 20000 });
        const offPage = await page.locator('.content').innerText();
        check('going straight to its URL explains it is not enabled',
          /not enabled/i.test(offPage) && !/error/i.test(offPage),
          offPage.replace(/\s+/g, ' ').slice(0, 120));

        // Back on again — turning a module ON takes nothing away, so it needs
        // no confirmation, and the whole section has to come back.
        await page.goto(`${BASE}/church`, { waitUntil: 'domcontentloaded' });
        await catalogRow('Forty Days').locator('.switch').first().waitFor({ timeout: 20000 });
        await catalogRow('Forty Days').locator('.switch').first().click();
        await w(1500);
        check('turning it back on needs no confirmation',
          (await page.locator('.modal-backdrop').count()) === 0);
        const onStates = await apiGet('/church/modules');
        check('the module is stored as on again',
          onStates.find((m) => m.key === 'discipleship')?.enabled === true,
          JSON.stringify(onStates));
        await page.goto(`${BASE}/discipleship`, { waitUntil: 'domcontentloaded' });
        await page.locator('h1').first().waitFor({ timeout: 20000 });
        await w(1200);
        check('the nav entry and the page come back',
          (await page.locator('.sidebar').innerText()).includes('Forty Days') &&
            !/not enabled/i.test(await page.locator('.content').innerText()));
      }

      // The same on/off cycle, for 幸福小组 — a second, independent module
      // switch that must not disturb 守望's own state (asserted above).
      // The Forty Days cycle above ends on /discipleship (to prove the page
      // itself comes back), so this needs its own trip back to /church —
      // without it, every check below is asking a page that was never the
      // catalog for a row that was therefore never going to appear.
      await page.goto(`${BASE}/church`, { waitUntil: 'domcontentloaded' });
      await catalogRow('Happiness Groups').locator('.switch').first()
        .waitFor({ timeout: 20000 }).catch(() => {});
      check('the catalog lists the Happiness Groups add-on with a switch',
        (await catalogRow('Happiness Groups').locator('.switch').count()) === 1);
      if (!happyBefore?.enabled) check('happiness module already off — toggle cycle skipped', true);
      if (happyBefore?.enabled) {
        await catalogRow('Happiness Groups').locator('.switch').first().click();
        await page.locator('.modal-backdrop').last().waitFor({ timeout: 8000 });
        const confirmCopy = await page.locator('.modal-backdrop').last().innerText();
        check('switching off Happiness Groups asks first, and says what disappears',
          confirmCopy.includes('Happiness Groups') && /sidebar/i.test(confirmCopy),
          confirmCopy.replace(/\s+/g, ' ').slice(0, 140));
        await page.locator('.modal-backdrop').last().locator('button:has-text("Turn off module")').last().click();
        await w(1500);
        const offStates = await apiGet('/church/modules');
        check('confirming stores the happiness module as off',
          offStates.find((m) => m.key === 'happiness')?.enabled === false, JSON.stringify(offStates));
        const blocked = await ctx.request.get(`${BASE}/api/happiness/terms`);
        check('a disabled happiness module’s API path is refused', blocked.status() === 404, `status ${blocked.status()}`);
        await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
        await page.locator('.mtile').first().waitFor({ timeout: 20000 });
        check('the nav loses the disabled happiness entry',
          !(await page.locator('.sidebar').innerText()).includes('Happiness Groups'));
        await page.goto(`${BASE}/happiness`, { waitUntil: 'domcontentloaded' });
        await page.locator('.empty').first().waitFor({ timeout: 20000 });
        const offPage = await page.locator('.content').innerText();
        check('going straight to its URL explains it is not enabled',
          /not enabled/i.test(offPage) && !/error/i.test(offPage),
          offPage.replace(/\s+/g, ' ').slice(0, 120));

        await page.goto(`${BASE}/church`, { waitUntil: 'domcontentloaded' });
        await catalogRow('Happiness Groups').locator('.switch').first().waitFor({ timeout: 20000 });
        await catalogRow('Happiness Groups').locator('.switch').first().click();
        await w(1500);
        check('turning it back on needs no confirmation',
          (await page.locator('.modal-backdrop').count()) === 0);
        const onStates = await apiGet('/church/modules');
        check('the happiness module is stored as on again',
          onStates.find((m) => m.key === 'happiness')?.enabled === true, JSON.stringify(onStates));
        await page.goto(`${BASE}/happiness`, { waitUntil: 'domcontentloaded' });
        await page.locator('h1').first().waitFor({ timeout: 20000 });
        await w(1200);
        check('the nav entry and the page come back',
          (await page.locator('.sidebar').innerText()).includes('Happiness Groups') &&
            !/not enabled/i.test(await page.locator('.content').innerText()));
      }
      await shot('08a-church');
    } finally {
      // Belt and braces: whatever happened above, the church is left running
      // exactly the modules it was running before this ran — and wearing
      // exactly the colours it was wearing.
      if (themeBefore.rail && !(await themeIsRestored().catch(() => true))) {
        const restored = await ctx.request
          .patch(`${BASE}/api/church`, { data: themeBody(themeBefore) })
          .then((r) => r.ok())
          .catch(() => false);
        console.log(`  ↳ cleanup: ${restored ? 'restored' : 'COULD NOT RESTORE'} the church theme (${themeBefore.preset ?? `${themeBefore.rail}/${themeBefore.brand}`})`);
        check('the church theme was left as it was found', restored, themeBefore.preset ?? themeBefore.rail);
      }
      if (discBefore) {
        const now = await ctx.request
          .get(`${BASE}/api/church/modules`)
          .then((r) => r.json())
          .catch(() => null);
        const current = now?.find?.((m) => m.key === 'discipleship');
        if (!current || current.enabled !== discBefore.enabled) {
          const restored = await ctx.request
            .patch(`${BASE}/api/church/modules/discipleship`, { data: { enabled: discBefore.enabled } })
            .then((r) => r.ok())
            .catch(() => false);
          console.log(`  ↳ cleanup: ${restored ? 'restored' : 'COULD NOT RESTORE'} the discipleship module to enabled=${discBefore.enabled}`);
          check('the add-on module was left as it was found', restored, `enabled=${discBefore.enabled}`);
        }
      }
      if (happyBefore) {
        const now = await ctx.request
          .get(`${BASE}/api/church/modules`)
          .then((r) => r.json())
          .catch(() => null);
        const current = now?.find?.((m) => m.key === 'happiness');
        if (!current || current.enabled !== happyBefore.enabled) {
          const restored = await ctx.request
            .patch(`${BASE}/api/church/modules/happiness`, { data: { enabled: happyBefore.enabled } })
            .then((r) => r.ok())
            .catch(() => false);
          console.log(`  ↳ cleanup: ${restored ? 'restored' : 'COULD NOT RESTORE'} the happiness module to enabled=${happyBefore.enabled}`);
          check('the happiness add-on module was left as it was found', restored, `enabled=${happyBefore.enabled}`);
        }
      }
    }

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

    const LIST_PAGES = ['/members', '/groups', '/events', '/trainings', '/discipleship', '/happiness', '/settings'];
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
      const DETAIL_PAGES = [...LIST_PAGES];
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

    // The DEFAULT language — no session, no account, no cached choice — is
    // now Chinese (0025: the DB column's own DEFAULT flipped from 'en' to
    // 'zh', and DEFAULT_LANGUAGE in packages/shared with it). A brand-new
    // browser context has neither a cookie nor a localStorage entry, so
    // /login has nothing to fall back on but that default.
    {
      const fresh = await browser.newContext({ viewport: { width: 402, height: 874 } });
      try {
        const freshPage = await fresh.newPage();
        await freshPage.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
        await freshPage.locator('button[type=submit]').first().waitFor({ timeout: 20000 });
        const freshBody = await freshPage.locator('body').innerText();
        check('a fresh session with no language chosen renders /login in Chinese by default',
          /登录/.test(freshBody) && !/Sign in/.test(freshBody),
          freshBody.replace(/\s+/g, ' ').slice(0, 160));
      } finally {
        await fresh.close();
      }
    }

    // The language is a per-account setting, so switch this account's own and
    // confirm the whole shell re-renders in it (then switch straight back).
    const meRes = await ctx.request.get(`${BASE}/api/auth/me`);
    const me = await meRes.json();
    accountId = me.id;
    originalLanguage = me.language;
    // Same reasoning as the module switch: the `finally` handles a failed
    // check, this handles the process being killed mid-switch.
    restoreLater(`the account language to ${originalLanguage}`, async () => {
      if (!originalLanguage) return; // the run already put it back
      const r = await ctx.request.patch(`${BASE}/api/accounts/${accountId}`, {
        data: { language: originalLanguage },
      });
      if (!r.ok()) throw new Error(`restore failed: ${r.status()}`);
    });
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
    /* 访客 + 领路人 (migration 0021, renamed from 推荐人) — the fifth church
       role has to be on offer in the form that writes one, and the guide is
       a Combobox (never a `<select>`, rule G4) whose default is an explicit
       无领路人 rather than an empty field. */
    check('the member form offers 访客 as a church role',
      (await page.locator('.modal select option[value="visitor"]').count()) === 1);
    const referrerBox = page.locator('.modal input[role="combobox"]');
    check('…and a 领路人 picker that is a searchable member combobox',
      (await referrerBox.count()) === 1);
    if (await referrerBox.count())
      check('…defaulting to 无领路人 rather than to an empty field',
        (await referrerBox.inputValue()) === 'No guide', await referrerBox.inputValue());

    /* 服侍岗位 (migration 0019) — the shared TagsInput. Typed and then SAVED
       WITHOUT pressing Enter, which is the ordinary way to use it and the path
       that used to lose the value silently: leaving the field is what commits
       the chip (on a phone the keyboard's key says 完成, not Enter). The
       ministry is fixture-named, so the filter assertion below can look for a
       value only this run put there, and it leaves with the member. */
    const testMinistry = 'ZZ_UITEST_服侍';
    const servingBox = page.locator('.modal input[placeholder*="Worship"]');
    check('the add-member form offers a 服侍岗位 field', (await servingBox.count()) === 1);
    if (await servingBox.count()) {
      await servingBox.fill(testMinistry);
      // Leaving the field, and nothing else — no Enter anywhere in this block.
      await page.locator('.modal input').first().click();
      await w(200);
      check('a ministry typed into it becomes a chip when the field is left',
        (await page.locator(`.modal .chip:has-text("${testMinistry}")`).count()) === 1);
    }
    // Choosing a life group reveals a "Life Group Join Date" field — a fact
    // separate from 来访日期/joined_at (migration 0023).
    const groupSel = page.locator('.modal select').nth(1);
    const groupOpt = await groupSel.locator('option').nth(1).getAttribute('value');
    if (groupOpt) {
      await groupSel.selectOption(groupOpt);
      await w(300);
      check('choosing a life group reveals a "Life Group Join Date" field',
        (await page.locator('.modal label.field-label:has-text("Life Group Join Date")').count()) === 1);
      // Back to ungrouped — this fixture member has no business in a real group.
      await groupSel.selectOption('');
      await w(200);
    }
    // 备注/Remark — new on the ADD form (it was edit-only before); the members
    // list itself trades its old "Joined" column for this one.
    const remarkText = `ZZ_UITEST_备注 ${testName}`;
    const notesBox = page.locator('.modal textarea');
    check('the add-member form offers a remark/notes field', (await notesBox.count()) === 1);
    if (await notesBox.count()) await notesBox.fill(remarkText);
    await page.locator('.modal button:has-text("Save")').first().click();
    await w(1800);
    await page.fill('input[placeholder*="Search"]', testName);
    await w(700);
    const created = (await page.locator(`.mtile:has-text("${testName}")`).count()) > 0;
    check('creating a member through the UI adds it to the list', created);
    // The filter is derived from the ministries members actually serve in, so
    // the one just saved has to be an option on the page bar.
    check('the members page offers a ministry filter carrying it',
      (await page.locator(`.page-bar-filters select option[value="${testMinistry}"]`).count()) === 1);
    // The list traded its "Joined" column for "Remark" — checked in the DOM
    // rather than by visibility, since this suite runs at one phone viewport
    // where the desktop table is `display:none` but still present.
    check('the members list has traded its "Joined" column for a "Remark" one',
      (await page.locator('th:has-text("Joined")').count()) === 0 &&
        (await page.locator('th:has-text("Remark")').count()) === 1);
    if (created) {
      check('the new member’s tile shows the remark (truncated, not the old joined date)',
        (await page.locator(`.mtile:has-text("${testName}")`).first().locator('.cell-remark').count()) === 1);
    }

    if (created) {
      // capture id for API-fallback cleanup
      await page.locator(`.mtile:has-text("${testName}")`).first().click();
      await page.waitForURL(/\/members\/[0-9a-f-]+/, { timeout: 15000 });
      createdMemberId = page.url().match(/\/members\/([0-9a-f-]+)/)?.[1] ?? null;
      // waitForURL only proves the navigation happened, not that this page's
      // own fetch has landed — wait for a fact to actually appear.
      await page.locator('.fact .badge').first().waitFor({ timeout: 15000 }).catch(() => {});
      // The server's answer, not the form's state: this is what proves the
      // ministry survived a save that never saw an Enter key.
      check('the member’s profile shows the ministry as a badge',
        (await page.locator(`.fact .badge:has-text("${testMinistry}")`).count()) === 1);
      check('…and the remark under its own "Notes" section',
        (await page.locator('.content').innerText()).includes(remarkText));
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
    // The explicit restores above already ran on this path, so drain the
    // crash-path list without acting on it — leaving entries behind would make
    // a later exit hand back settings that are already correct.
    restorers.length = 0;
    // API-fallback cleanup: if the throwaway member survived, delete it.
    if (createdMemberId) {
      await ctx.request.delete(`${BASE}/api/members/${createdMemberId}`).catch(() => {});
      console.log(`  ↳ cleanup: deleted leftover test member ${createdMemberId}`);
    }
    // The last word, pass or fail: ask the API what ZZ_UITEST_… rows are
    // actually in the church and delete all of them — including any an earlier
    // run left behind. Residue that survives even this is reported as a FAILED
    // CHECK rather than a log line: a run that leaves data in the church's live
    // database has not passed, whatever its assertions said.
    mod('cleanup · the church is left as it was found');
    const stuck = await purgeResidue().catch((e) => [`purge itself failed: ${e.message}`]);
    check('the run leaves no test data behind', stuck.length === 0, stuck.join('; '));
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
