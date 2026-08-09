#!/usr/bin/env node
/**
 * API-level end-to-end test for the TOG church-management API.
 *
 * Exercises every flow the browser suite covers, but over HTTP: auth,
 * role-based access control (401/403), and full CRUD round-trips for every
 * entity — all self-cleaning (created data is deleted again). Deterministic and
 * fast; no browser. Runs post-deploy in deploy.yml and can be run locally with
 *   NODE_USE_ENV_PROXY=1 node scripts/api-e2e.mjs
 *
 * Env: SMOKE_URL (base, default live), SMOKE_EMAIL / SMOKE_PASSWORD (super_admin).
 * Exits 0 on success, 1 on any failed assertion.
 */

const BASE = (process.env.SMOKE_URL || process.env.E2E_BASE_URL || 'https://tog.tabernacleofgrace-cn.workers.dev').replace(/\/+$/, '');
const EMAIL = process.env.SMOKE_EMAIL || process.env.E2E_EMAIL || 'john@grace.org';
const PASSWORD = process.env.SMOKE_PASSWORD || process.env.E2E_PASSWORD || 'grace2026';

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push(`${name}${detail ? ` — ${detail}` : ''}`); console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * One request. `body` is JSON; `form` is a multipart body (an upload) and is
 * sent as-is so the runtime writes its own boundary — never both.
 */
async function req(method, path, { cookie, body, form, raw } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: form !== undefined ? form : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie') || '';
  let json;
  if (!raw) { try { json = await res.json(); } catch { json = undefined; } }
  return { status: res.status, json, cookie: setCookie.split(';')[0] };
}

async function login(email, password) {
  const r = await req('POST', '/api/auth/login', { body: { email, password } });
  return r.status === 200 ? r.cookie : null;
}

/**
 * `wrangler deploy` returns as soon as Cloudflare accepts the upload, but the
 * new Worker version takes a few seconds to actually start serving traffic.
 * This suite runs immediately after, so without this wait the first requests
 * hit the PREVIOUS version and the whole run tests stale code.
 *
 * Wait on the deployed build id, not on "does endpoint X answer": an existence
 * probe stops being a rollout signal the moment X ships, and a stale Worker
 * then sails straight through it (which is precisely how a fixed bug kept
 * "failing" here). EXPECT_BUILD is the commit deploy.yml just built; without
 * it (local runs) there's nothing to wait for.
 *
 * The window is generous because propagation is occasionally much slower than
 * the usual few seconds, and waiting a bit longer is far cheaper than a whole
 * run that silently tested the previous release. Each poll is cache-busted so
 * no intermediary can pin us to a stale answer.
 */
async function waitForRollout({ timeoutMs = 240_000, everyMs = 3_000 } = {}) {
  const expected = process.env.EXPECT_BUILD;
  if (!expected) return true;
  const started = Date.now();
  for (;;) {
    const r = await req('GET', `/api/version?_=${Date.now()}`);
    if (r.status === 200 && r.json?.build === expected) {
      const waited = Date.now() - started;
      if (waited > everyMs) console.log(`  (waited ${Math.round(waited / 1000)}s for build ${expected.slice(0, 7)})`);
      return true;
    }
    if (Date.now() - started > timeoutMs) {
      console.error(
        `  still serving build ${r.json?.build ?? `? (${r.status})`} after ${Math.round(timeoutMs / 1000)}s, expected ${expected}`,
      );
      return false;
    }
    await new Promise((r2) => setTimeout(r2, everyMs));
  }
}

async function main() {
  console.log(`API E2E → ${BASE}`);

  // Before anything is asserted, make sure we're testing the build we just
  // deployed rather than the one still being served.
  ok('deployed build is live', await waitForRollout());

  // ---- Auth ---------------------------------------------------------------
  ok('unauth GET /members → 401', (await req('GET', '/api/members')).status === 401);
  ok('bad login → 401', (await req('POST', '/api/auth/login', { body: { email: EMAIL, password: 'nope' } })).status === 401);

  const admin = await login(EMAIL, PASSWORD); // super_admin bootstrap
  ok('super_admin login → cookie', !!admin);
  if (!admin) return finish();
  const me = await req('GET', '/api/auth/me', { cookie: admin });
  ok('me returns super_admin', me.json?.role === 'super_admin', me.json?.role);
  ok('me carries a supported interface language',
    ['en', 'zh', 'ms'].includes(me.json?.language), String(me.json?.language));
  const H = { cookie: admin };

  // ---- Reference data -----------------------------------------------------
  const members = (await req('GET', '/api/members', H)).json;
  ok('members is non-empty array', Array.isArray(members) && members.length > 0);
  const accounts = (await req('GET', '/api/accounts', H)).json;
  ok('super_admin can read accounts', Array.isArray(accounts));
  const taken = new Set((accounts || []).map((a) => a.member_id));
  const freeMembers = (members || []).filter((m) => !taken.has(m.id));

  // ---- Halls (堂会) --------------------------------------------------------
  // Members and groups carry a required hall_id, so every create below needs
  // one. The smoke account has full access, so it sees all three halls.
  const halls = (await req('GET', '/api/halls', H)).json;
  ok('halls is non-empty array', Array.isArray(halls) && halls.length > 0, JSON.stringify(halls).slice(0, 120));
  const hallId = halls?.[0]?.id;

  // ---- Members CRUD -------------------------------------------------------
  // 服侍岗位 (migration 0019) rides along with the create: it is a `text[]`, so
  // what is asserted is that it comes BACK as the list that went in — a column
  // the API forgot to select would read as an ordinary absent field.
  const mkMember = await req('POST', '/api/members', { ...H, body: { full_name: `E2E成员-${Date.now()}`, church_role: 'member', status: 'active', hall_id: hallId, serving_roles: ['敬拜', '音响'] } });
  ok('create member → 200 + id', mkMember.status === 200 && mkMember.json?.id, `status ${mkMember.status}`);
  const memberId = mkMember.json?.id;
  if (memberId) {
    const read = await req('GET', `/api/members/${memberId}`, H);
    ok('…and reads back with the ministries it was created with',
      JSON.stringify(read.json?.serving_roles) === JSON.stringify(['敬拜', '音响']),
      JSON.stringify(read.json?.serving_roles));
    const patch = await req('PATCH', `/api/members/${memberId}`, { ...H, body: { phone: '012-000 0000', serving_roles: ['招待'] } });
    ok('update member → 200', patch.status === 200 && patch.json?.phone === '012-000 0000');
    ok('…and 服侍岗位 is editable, not write-once',
      JSON.stringify(patch.json?.serving_roles) === JSON.stringify(['招待']),
      JSON.stringify(patch.json?.serving_roles));
    const del = await req('DELETE', `/api/members/${memberId}`, H);
    ok('delete member → 200', del.status === 200);
  }

  await namePairIdentity(admin, hallId);
  await memberImport(admin, hallId);
  await selfRegistration(admin, hallId);

  // ---- Events CRUD --------------------------------------------------------
  const mkEv = await req('POST', '/api/events', { ...H, body: { title: `E2E聚会-${Date.now()}`, event_type: 'service', starts_at: new Date('2026-08-01T10:00:00Z').toISOString() } });
  ok('create event → 200 + id', mkEv.status === 200 && mkEv.json?.id, `status ${mkEv.status} ${JSON.stringify(mkEv.json).slice(0,120)}`);
  const evId = mkEv.json?.id;
  if (evId) {
    // 地点 is the field the meeting form only just started asking for — the
    // dashboard has always rendered it, so what is checked is that a written
    // one comes back rather than vanishing between the form and the row.
    const evPatch = await req('PATCH', `/api/events/${evId}`, { ...H, body: { location: '副堂' } });
    ok('update event → 200', evPatch.status === 200);
    ok('…and the meeting keeps the location it was given', evPatch.json?.location === '副堂', evPatch.json?.location);
    // A meeting's attendance is not its own endpoint any more: it is a column
    // on the roll-call sheet, ticked by PUT /api/attendance/sheet — exercised
    // in full by rollCallSheet() below, on a fixture of its own.
    ok('delete event → 200', (await req('DELETE', `/api/events/${evId}`, H)).status === 200);
  }

  // ---- 聚会点名 (the roll-call sheet) ---------------------------------------
  await rollCallSheet(admin, halls, hallId);
  await groupScopedSheet(admin, halls, hallId);

  // ---- Groups CRUD (+ weekly attendance) ----------------------------------
  const mkGrp = await req('POST', '/api/groups', { ...H, body: { name: `E2E小组-${Date.now()}`, hall_id: hallId } });
  ok('create group → 200 + id', mkGrp.status === 200 && mkGrp.json?.id, `status ${mkGrp.status}`);
  const grpId = mkGrp.json?.id;
  if (grpId) {
    ok('update group → 200', (await req('PATCH', `/api/groups/${grpId}`, { ...H, body: { description: '周日 14:00' } })).status === 200);
    const mkMeet = await req('POST', `/api/groups/${grpId}/meetings`, { ...H, body: { meeting_date: '2026-08-02' } });
    ok('add group meeting → 200 + id', mkMeet.status === 200 && mkMeet.json?.id, `status ${mkMeet.status}`);
    const meetId = mkMeet.json?.id;
    if (meetId && members?.length) {
      ok('meeting attendance → 200', (await req('POST', `/api/groups/meetings/${meetId}/attendance`, { ...H, body: { records: [{ member_id: members[0].id, status: 'present' }] } })).status === 200);
      ok('delete meeting → 200', (await req('DELETE', `/api/groups/meetings/${meetId}`, H)).status === 200);
    }
    ok('delete group → 200', (await req('DELETE', `/api/groups/${grpId}`, H)).status === 200);
  }

  // ---- Trainings CRUD (+ session, enroll, attendance) ---------------------
  const mkTr = await req('POST', '/api/trainings', { ...H, body: { name: `E2E课程-${Date.now()}`, total_sessions: 1, is_enrollable: true } });
  ok('a training defaults to the course shape', mkTr.json?.kind === 'course', String(mkTr.json?.kind));
  ok('create training → 200 + id', mkTr.status === 200 && mkTr.json?.id, `status ${mkTr.status} ${JSON.stringify(mkTr.json).slice(0,120)}`);
  const trId = mkTr.json?.id;
  if (trId) {
    const mkSess = await req('POST', `/api/trainings/${trId}/sessions`, { ...H, body: { session_number: 1, title: '第一课' } });
    ok('add session → 200', mkSess.status === 200, `status ${mkSess.status}`);
    if (members?.length) {
      const enr = await req('POST', `/api/trainings/${trId}/enroll`, { ...H, body: { member_id: members[0].id } });
      ok('enroll member → 200 + id', enr.status === 200 && enr.json?.id, `status ${enr.status}`);
      if (enr.json?.id) ok('approve enrollment → 200', (await req('PATCH', `/api/trainings/enrollments/${enr.json.id}`, { ...H, body: { status: 'approved' } })).status === 200);
    }
    // Public self-enrollment (no auth) — matches a full Chinese name to a member.
    const pubInfo = await req('GET', `/api/trainings/enroll/${trId}`);
    ok('public enroll info (no auth) → 200', pubInfo.status === 200 && pubInfo.json?.is_enrollable === true, `status ${pubInfo.status}`);
    const badEnroll = await req('POST', `/api/trainings/enroll/${trId}`, { body: { full_name: `查无此人-${Date.now()}` } });
    ok('public enroll unknown name → no_member', badEnroll.json?.status === 'no_member', JSON.stringify(badEnroll.json));
    // The form's as-you-type check reaches the SAME verdict without writing
    // anything, and hands back nothing but a status and the name that was
    // typed — no id, no list, no member row.
    const badCheck = await req('GET', `/api/trainings/enroll/${trId}/check?name=${encodeURIComponent(`查无此人-${Date.now()}`)}`);
    ok('public name check, unknown name → no_member',
      badCheck.status === 200 && badCheck.json?.status === 'no_member', JSON.stringify(badCheck.json));
    const emptyCheck = await req('GET', `/api/trainings/enroll/${trId}/check?name=`);
    ok('public name check, no name → no_member', emptyCheck.json?.status === 'no_member', JSON.stringify(emptyCheck.json));
    if (members?.length) {
      const who = members[members.length - 1].full_name;
      const goodCheck = await req('GET', `/api/trainings/enroll/${trId}/check?name=${encodeURIComponent(who)}`);
      ok('public name check, a real member → a verdict the submit would give',
        ['ok', 'already', 'ambiguous'].includes(goodCheck.json?.status), JSON.stringify(goodCheck.json));
      ok('…and it leaks nothing but the status and that name',
        Object.keys(goodCheck.json ?? {}).sort().join(',') === 'name,status',
        Object.keys(goodCheck.json ?? {}).join(','));
    }
    if (members?.length) {
      const matchEnroll = await req('POST', `/api/trainings/enroll/${trId}`, { body: { full_name: members[members.length - 1].full_name } });
      ok('public enroll matched name → ok/already/ambiguous', ['ok', 'already', 'ambiguous'].includes(matchEnroll.json?.status), JSON.stringify(matchEnroll.json));
    }
    ok('delete training → 200', (await req('DELETE', `/api/trainings/${trId}`, H)).status === 200);
  }

  // ---- 培训&活动: the ACTIVITY shape --------------------------------------
  await activityShape(admin, members, hallId);

  // ---- 培训&活动: a PAID course, from the fee to the receipt ---------------
  await paidTraining(admin, hallId);

  // ---- Discipleship modules (read-only) + pair CRUD + public form ----------
  // A 守望模块 is created once and then left alone: the module MANAGER that
  // used to edit and delete them is gone, and so are the routes behind it. So
  // this block reads the church's own module and pairs two members under it —
  // it must not create a module of its own, because there is no longer any way
  // to delete one and a leaked module would sit on the live database for good.
  const programs = (await req('GET', '/api/discipleship/programs', H)).json;
  ok('discipleship modules list is an array', Array.isArray(programs), JSON.stringify(programs).slice(0, 120));
  const programId = programs?.[0]?.id;
  if (programId) {
    const readProg = await req('GET', `/api/discipleship/programs/${programId}`, H);
    ok('read module by id → 200', readProg.status === 200 && readProg.json?.id === programId, `status ${readProg.status}`);
    // The manager's two write routes are GONE, not merely hidden in the UI: a
    // hand-rolled PATCH must not edit a module, and a hand-rolled DELETE must
    // not cascade away every pair under it and all of their daily records
    // (rule G2 — the server is the authority). 404 because the route does not
    // exist at all; both are checked against the church's REAL module, which
    // is exactly the row that must survive them.
    const patchProg = await req('PATCH', `/api/discipleship/programs/${programId}`, { ...H, body: { total_days: 12 } });
    ok('PATCH a module → 404 (the module manager is gone)', patchProg.status === 404, `status ${patchProg.status}`);
    const delProg = await req('DELETE', `/api/discipleship/programs/${programId}`, H);
    ok('DELETE a module → 404 (the module manager is gone)', delProg.status === 404, `status ${delProg.status}`);
    const survived = await req('GET', `/api/discipleship/programs/${programId}`, H);
    ok('…and the module is untouched by either attempt',
      survived.status === 200 && survived.json?.id === programId && survived.json?.total_days === readProg.json?.total_days,
      `status ${survived.status} total_days ${survived.json?.total_days}`);
  }
  // The trainee must not already be paired (unique program_id+trainee_id).
  const existingPairs = (await req('GET', '/api/discipleship/pairs', H)).json || [];
  const usedTrainees = new Set(existingPairs.map((p) => p.trainee_id));
  const freeTrainees = (members || []).filter((m) => !usedTrainees.has(m.id));
  if (programId && freeTrainees.length >= 2) {
    const mentor = freeTrainees[0];
    const trainee = freeTrainees.find((m) => m.id !== mentor.id);
    const mkPair = await req('POST', '/api/discipleship/pairs', { ...H, body: { program_id: programId, mentor_id: mentor.id, trainee_id: trainee.id } });
    ok('create pair → 200 + id', mkPair.status === 200 && mkPair.json?.id, `status ${mkPair.status} ${JSON.stringify(mkPair.json).slice(0,120)}`);
    const token = mkPair.json?.form_token;
    if (token) {
      ok('public form GET (no auth) → 200', (await req('GET', `/api/discipleship/form/${token}`)).status === 200);
      const prog = await req('POST', `/api/discipleship/form/${token}/progress`, { body: { day_number: 1, completed: true } });
      ok('public form submit progress → 200', prog.status === 200, `status ${prog.status}`);
    }
    if (mkPair.json?.id) ok('delete pair → 200', (await req('DELETE', `/api/discipleship/pairs/${mkPair.json.id}`, H)).status === 200);

    // 补进度: a pair that was already partway through on paper. The days are
    // written by a second statement AFTER the pair row exists, and that
    // statement asks for nothing back — which is exactly how it used to answer
    // 404 "Resource not found" for a pair it had just created successfully.
    // So this asserts the STATUS as well as the days.
    const backPair = await req('POST', '/api/discipleship/pairs', {
      ...H,
      body: { program_id: programId, mentor_id: mentor.id, trainee_id: trainee.id, backfill_days: 3 },
    });
    ok('create pair with 补进度 → 200, not a 404 for work it did',
      backPair.status === 200 && backPair.json?.id,
      `status ${backPair.status} ${JSON.stringify(backPair.json).slice(0, 140)}`);
    if (backPair.json?.id) {
      const read = await req('GET', `/api/discipleship/pairs/${backPair.json.id}`, H);
      const done = (read.json?.progress || []).filter((d) => d.completed).map((d) => d.day_number);
      ok('…and days 1–3 are marked complete',
        done.length === 3 && done.every((n) => n >= 1 && n <= 3),
        JSON.stringify(done));
      ok('delete the 补进度 pair → 200',
        (await req('DELETE', `/api/discipleship/pairs/${backPair.json.id}`, H)).status === 200);
    }
  }

  // ---- Church record + add-on modules -------------------------------------
  await churchAndModules(admin);

  // ---- Accounts CRUD + password (super_admin) -----------------------------
  if (freeMembers.length) {
    // An account's login email is always derived server-side from its linked
    // member — set the member's email first (restored after), matching real usage.
    const targetMember = freeMembers[0];
    const originalEmail = targetMember.email ?? null;
    const email = `e2e-acct-${Date.now()}@grace.org`;
    await req('PATCH', `/api/members/${targetMember.id}`, { ...H, body: { email } });
    const mkAcc = await req('POST', '/api/accounts', { ...H, body: { member_id: targetMember.id, account_role: 'coworker', password: 'e2ePass2026' } });
    ok('create account → 200 + id', mkAcc.status === 200 && mkAcc.json?.id, `status ${mkAcc.status}`);
    ok('account email follows member', mkAcc.json?.email === email, mkAcc.json?.email);
    const accId = mkAcc.json?.id;
    if (accId) {
      ok('update account role → 200', (await req('PATCH', `/api/accounts/${accId}`, { ...H, body: { account_role: 'admin' } })).status === 200);
      ok('reset account password → 200', (await req('POST', `/api/accounts/${accId}/password`, { ...H, body: { password: 'newPass2026' } })).status === 200);
      // Interface language: new accounts default to English, only the three
      // shipped languages are storable, and anything else is a 400.
      ok('new account defaults to English', mkAcc.json?.language === 'en', String(mkAcc.json?.language));
      const setZh = await req('PATCH', `/api/accounts/${accId}`, { ...H, body: { language: 'zh' } });
      ok('set account language → 200 + persisted', setZh.status === 200 && setZh.json?.language === 'zh', `status ${setZh.status} ${setZh.json?.language}`);
      const badLang = await req('PATCH', `/api/accounts/${accId}`, { ...H, body: { language: 'fr' } });
      ok('unsupported language → 400', badLang.status === 400, `status ${badLang.status}`);
      ok('delete account → 200', (await req('DELETE', `/api/accounts/${accId}`, H)).status === 200);
    }
    await req('PATCH', `/api/members/${targetMember.id}`, { ...H, body: { email: originalEmail } });
  }

  // ---- Access control: provision role accounts, assert the matrix ---------
  await roleMatrix(freeMembers, hallId);

  // ---- The church is left as it was found --------------------------------
  const stuck = await purgeResidue(H).catch((e) => [`purge itself failed: ${e.message}`]);
  ok('the run leaves no test data behind', stuck.length === 0, stuck.join('; '));

  finish();
}

/**
 * 培训&活动 — the second shape in the same catalog (`kind`, migration 0014).
 *
 * An activity is one occasion people sign up for and get ticked off at. What
 * has teeth here is that the SERVER owns the invariants, not the page:
 *  - it creates the activity's single session itself, so the attendance sheet
 *    always has exactly one column to tick;
 *  - `total_sessions` is forced to 1 however many the client asked for;
 *  - a `kind` the app does not ship is a 400 in words, not a constraint name.
 * The public sign-up link has to keep working for an activity too — same link,
 * same full-name match, different wording — so it is exercised here as well.
 */
/**
 * A member is identified by the PAIR of names (migration 0018).
 *
 * `full_name` is the Chinese name and `english_name` the English one, and the
 * database holds a unique index over the two together — case- and
 * whitespace-insensitively, with "no English name" counting as a value of its
 * own. So the same Chinese name may be used again ONLY by somebody with a
 * different English name, and the collision has to come back as a 409 that a
 * church secretary can read rather than a Postgres constraint name.
 *
 * Everything it creates is deleted again, including on the failing paths.
 */
async function namePairIdentity(adminCookie, hallId) {
  const H = { cookie: adminCookie };
  const shared = `E2E同名-${Date.now()}`;
  const base = { church_role: 'member', status: 'active', hall_id: hallId };
  const made = [];

  const first = await req('POST', '/api/members', {
    ...H,
    body: { ...base, full_name: shared, english_name: 'E2E Pair One' },
  });
  ok('create member with both names → 200', first.status === 200 && first.json?.id, `status ${first.status}`);
  if (first.json?.id) made.push(first.json.id);

  // The SAME pair, typed the way it would really be re-typed: different case,
  // a stray trailing space. Both are normalised away by the index, so this is
  // the same person and must be refused.
  const dup = await req('POST', '/api/members', {
    ...H,
    body: { ...base, full_name: `${shared} `, english_name: 'e2e pair one' },
  });
  ok('a duplicate name pair → 409', dup.status === 409, `status ${dup.status}`);
  ok('…and says what collided, not a constraint name',
    typeof dup.json?.message === 'string' &&
      /pair of names/i.test(dup.json.message) &&
      !/duplicate key|members_name_pair_key/i.test(dup.json.message),
    JSON.stringify(dup.json).slice(0, 160));
  if (dup.json?.id) made.push(dup.json.id); // should not exist; clean up if it does

  // Same Chinese name, different English name — a different person, allowed.
  const sibling = await req('POST', '/api/members', {
    ...H,
    body: { ...base, full_name: shared, english_name: 'E2E Pair Two' },
  });
  ok('the same Chinese name with another English name → 200',
    sibling.status === 200 && sibling.json?.id, `status ${sibling.status}`);
  if (sibling.json?.id) made.push(sibling.json.id);

  // Editing one INTO the other's pair is the same collision on the update path.
  if (sibling.json?.id) {
    const patch = await req('PATCH', `/api/members/${sibling.json.id}`, {
      ...H,
      body: { english_name: 'E2E Pair One' },
    });
    ok('renaming a member onto an existing pair → 409', patch.status === 409, `status ${patch.status}`);
  }

  for (const id of made) await req('DELETE', `/api/members/${id}`, H);
  ok('name-pair fixtures cleaned up', true, `${made.length} removed`);
}

/**
 * 成员导入 — a spreadsheet of members, decided server-side.
 *
 * The browser previews what an import will do, but the decision is this
 * endpoint's (rule G2), so what is asserted here is the decision itself: an
 * existing name pair is an UPDATE rather than a second row, a sparse file does
 * not blank the columns it left empty, and every refused row comes back naming
 * its own spreadsheet row and what was wrong with it — one bad cell must never
 * take the rest of the file with it.
 *
 * Everything it creates is deleted again, including on the failing paths.
 */
async function memberImport(adminCookie, hallId) {
  const H = { cookie: adminCookie };
  const stamp = Date.now();
  const chinese = `E2E导入-${stamp}`;
  const made = [];

  const first = await req('POST', '/api/members/import', {
    ...H,
    body: {
      hall_id: hallId,
      rows: [
        // One cell, several 服侍岗位 — and the row beside it names none, which
        // is what puts the bulk insert's column-widening on the 0019 column.
        { row: 2, full_name: chinese, english_name: 'Import One', phone: '012-111 1111', email: `e2e-import-${stamp}@grace.org`, serving_roles: '敬拜、音响' },
        // The same Chinese name with another English name is a different
        // person — that is what the pair index is for.
        { row: 3, full_name: chinese, english_name: 'Import Two' },
        // …and the SAME pair typed again is one person, not two.
        { row: 4, full_name: ` ${chinese} `, english_name: 'IMPORT ONE' },
        { row: 5, full_name: '   ' },
        { row: 6, full_name: `${chinese}-日期`, date_of_birth: '4 May 1990' },
        { row: 7, full_name: `${chinese}-堂会`, hall: '德文堂' },
      ],
    },
  });
  ok('import → 200', first.status === 200, `status ${first.status} ${JSON.stringify(first.json).slice(0, 160)}`);
  ok('…creates the two real people', first.json?.created === 2, String(first.json?.created));
  ok('…and nothing was refused by the database',
    (first.json?.failures || []).length === 0, JSON.stringify(first.json?.failures || []));
  const skipped = new Map((first.json?.skipped || []).map((s) => [s.row, s.issue]));
  ok('…the repeated pair is skipped naming the row it repeats', skipped.get(4) === 'duplicate_in_file', String(skipped.get(4)));
  ok('…a row with no Chinese name is skipped', skipped.get(5) === 'name_missing', String(skipped.get(5)));
  ok('…an unreadable date is skipped', skipped.get(6) === 'bad_date', String(skipped.get(6)));
  ok('…an unknown congregation is skipped', skipped.get(7) === 'unknown_hall', String(skipped.get(7)));

  const found = (await req('GET', `/api/members?q=${encodeURIComponent(chinese)}`, H)).json || [];
  for (const m of found) made.push(m.id);
  ok('…and exactly two members carry that Chinese name', found.length === 2, String(found.length));
  const one = found.find((m) => m.english_name === 'Import One');
  ok('…the imported email landed', one?.email === `e2e-import-${stamp}@grace.org`, one?.email);
  ok('…one cell of 服侍岗位 became a list',
    JSON.stringify(one?.serving_roles) === JSON.stringify(['敬拜', '音响']), JSON.stringify(one?.serving_roles));
  ok('…and the row that named none serves nowhere rather than being refused',
    (found.find((m) => m.english_name === 'Import Two')?.serving_roles || []).length === 0,
    JSON.stringify(found.find((m) => m.english_name === 'Import Two')?.serving_roles));

  // The re-import: the same pair, a new phone, and NO email column at all. An
  // update must take the phone and leave the email the church already had.
  const again = await req('POST', '/api/members/import', {
    ...H,
    body: { hall_id: hallId, rows: [{ row: 2, full_name: chinese, english_name: 'Import One', phone: '012-999 9999' }] },
  });
  ok('re-importing an existing pair updates rather than duplicates',
    again.status === 200 && again.json?.updated === 1 && again.json?.created === 0,
    `status ${again.status} ${JSON.stringify(again.json).slice(0, 140)}`);
  const after = ((await req('GET', `/api/members?q=${encodeURIComponent(chinese)}`, H)).json || [])
    .find((m) => m.english_name === 'Import One');
  ok('…the phone the file supplied was written', after?.phone === '012-999 9999', after?.phone);
  ok('…and the email the file left out was NOT blanked',
    after?.email === `e2e-import-${stamp}@grace.org`, String(after?.email));
  ok('…nor the ministries it left out',
    JSON.stringify(after?.serving_roles) === JSON.stringify(['敬拜', '音响']), JSON.stringify(after?.serving_roles));
  ok('…and there is still only one of them',
    ((await req('GET', `/api/members?q=${encodeURIComponent(chinese)}`, H)).json || []).length === 2);

  // Refusals that are about the REQUEST rather than about a row.
  ok('an import with no rows → 400',
    (await req('POST', '/api/members/import', { ...H, body: { rows: [] } })).status === 400);
  const flood = Array.from({ length: 301 }, (_, i) => ({ row: i + 2, full_name: `E2E洪水-${stamp}-${i}` }));
  const tooMany = await req('POST', '/api/members/import', { ...H, body: { hall_id: hallId, rows: flood } });
  ok('an import past the row cap → 400, before anything is written',
    tooMany.status === 400, `status ${tooMany.status}`);
  ok('…and nothing from it exists',
    ((await req('GET', `/api/members?q=${encodeURIComponent(`E2E洪水-${stamp}`)}`, H)).json || []).length === 0);
  ok('an unknown congregation id → 400',
    (await req('POST', '/api/members/import', {
      ...H,
      body: { hall_id: '00000000-0000-0000-0000-000000000000', rows: [{ row: 2, full_name: 'x' }] },
    })).status === 400);
  ok('GET /members/import → 404 (it is a write path, and not a member id)',
    (await req('GET', '/api/members/import', H)).status === 404);

  for (const id of made) await req('DELETE', `/api/members/${id}`, H);
  ok('import fixtures cleaned up', true, `${made.length} removed`);
}

/**
 * `/members/register` — the PUBLIC self-registration form (/join).
 *
 * The only unauthenticated write that touches the member roll, so what is
 * asserted is mostly what it REFUSES: a stranger may leave their contact
 * details, and may not make themselves a pastor, put themselves on a ministry,
 * park a note on their own record, or reach any other method on the path. And
 * the same pair rule as everywhere else — registering twice updates the one row
 * rather than growing a twin.
 */
async function selfRegistration(adminCookie, hallId) {
  const H = { cookie: adminCookie };
  const stamp = Date.now();
  const chinese = `E2E注册-${stamp}`;
  const made = [];

  const options = await req('GET', '/api/members/register');
  ok('public GET /members/register → 200 + halls', options.status === 200 && Array.isArray(options.json?.halls),
    `status ${options.status}`);
  ok('…and hands out nothing but each hall’s id and name',
    (options.json?.halls || []).every((h) => Object.keys(h).sort().join(',') === 'id,name'),
    JSON.stringify(options.json?.halls || []).slice(0, 120));

  // Deliberately carrying fields a stranger must not be able to set.
  const join = await req('POST', '/api/members/register', {
    body: {
      full_name: chinese,
      english_name: 'Join One',
      phone: '012-222 2222',
      gender: 'male',
      date_of_birth: '1990-05-04',
      hall_id: hallId,
      church_role: 'pastor',
      status: 'inactive',
      notes: 'promote me',
      serving_roles: ['敬拜'],
      group_id: '00000000-0000-0000-0000-000000000000',
    },
  });
  ok('public registration (no session) → created', join.status === 200 && join.json?.status === 'created',
    `status ${join.status} ${JSON.stringify(join.json)}`);
  ok('…and the answer carries no member data at all',
    join.json && Object.keys(join.json).join(',') === 'status', JSON.stringify(join.json));

  const found = ((await req('GET', `/api/members?q=${encodeURIComponent(chinese)}`, H)).json || []);
  for (const m of found) made.push(m.id);
  ok('…one member was created', found.length === 1, String(found.length));
  const person = found[0];
  ok('…as an ordinary member, whatever the body claimed', person?.church_role === 'member', person?.church_role);
  ok('…on the roll, not with the status it asked for', person?.status === 'active', person?.status);
  ok('…with no notes and no life group', !person?.notes && !person?.group_id,
    `${person?.notes} / ${person?.group_id}`);
  // A ministry is something the church hands out, so the allow-list simply does
  // not read the field — the row comes back serving nowhere, not serving 敬拜.
  ok('…and serving nowhere, whatever ministry the body claimed',
    (person?.serving_roles || []).length === 0, JSON.stringify(person?.serving_roles));
  ok('…and the details it WAS allowed to set',
    person?.phone === '012-222 2222' && person?.gender === 'male' && person?.date_of_birth === '1990-05-04',
    `${person?.phone} / ${person?.gender} / ${person?.date_of_birth}`);

  // Registering again is the same person: an update, not a twin — and the page
  // is told which, in the same one-word shape.
  const twice = await req('POST', '/api/members/register', {
    body: { full_name: ` ${chinese} `, english_name: 'JOIN ONE', phone: '012-333 3333', hall_id: hallId },
  });
  ok('registering the same pair again → updated', twice.status === 200 && twice.json?.status === 'updated',
    `status ${twice.status} ${JSON.stringify(twice.json)}`);
  const reread = ((await req('GET', `/api/members?q=${encodeURIComponent(chinese)}`, H)).json || []);
  ok('…still exactly one row', reread.length === 1, String(reread.length));
  ok('…with the new phone', reread[0]?.phone === '012-333 3333', reread[0]?.phone);
  ok('…and the name the church filed them under, not the visitor’s re-spelling',
    reread[0]?.english_name === 'Join One', reread[0]?.english_name);

  // The photo rides along with the registration, and an SVG is a script that
  // renders — this is the one unauthenticated upload of an image into a public
  // bucket, so it takes an explicit list of photo types rather than `image/*`.
  const svg = await req('POST', '/api/members/register', {
    form: fileForm(
      'photo',
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
      'photo.svg',
      'image/svg+xml',
      { full_name: `${chinese}-svg`, hall_id: hallId },
    ),
  });
  ok('registration with an SVG “photo” → 400', svg.status === 400, `status ${svg.status}`);
  ok('…and no member was created by it',
    ((await req('GET', `/api/members?q=${encodeURIComponent(`${chinese}-svg`)}`, H)).json || []).length === 0);

  // What it refuses.
  ok('registration with no name → 400',
    (await req('POST', '/api/members/register', { body: { hall_id: hallId } })).status === 400);
  ok('registration with an absurd name → 400',
    (await req('POST', '/api/members/register', { body: { full_name: '甲'.repeat(500), hall_id: hallId } })).status === 400);
  ok('registration with an unreadable birthday → 400',
    (await req('POST', '/api/members/register', {
      body: { full_name: `${chinese}-x`, hall_id: hallId, date_of_birth: '4 May 1990' },
    })).status === 400);
  ok('registration into a congregation that does not exist → 400',
    (await req('POST', '/api/members/register', {
      body: { full_name: `${chinese}-y`, hall_id: '00000000-0000-0000-0000-000000000000' },
    })).status === 400);
  // Only GET and POST are public on this exact path; nothing else under
  // /members is opened by it.
  ok('unauthenticated PATCH /members/register → 401',
    (await req('PATCH', '/api/members/register', { body: { full_name: 'x' } })).status === 401);
  ok('unauthenticated GET /members → still 401', (await req('GET', '/api/members')).status === 401);
  ok('DELETE /members/register (signed in) → 404, never a delete by id',
    (await req('DELETE', '/api/members/register', H)).status === 404);

  for (const id of made) await req('DELETE', `/api/members/${id}`, H);
  ok('registration fixtures cleaned up', true, `${made.length} removed`);
}

async function activityShape(adminCookie, members, hallId) {
  const H = { cookie: adminCookie };
  const mk = await req('POST', '/api/trainings', {
    ...H,
    body: {
      name: `E2E活动-${Date.now()}`,
      kind: 'activity',
      // Deliberately wrong: an activity is ONE occasion whatever is sent.
      total_sessions: 5,
      is_enrollable: true,
      starts_on: '2030-03-09',
      ends_on: '2030-03-09',
      hall_id: hallId,
    },
  });
  ok('create activity → 200 + id', mk.status === 200 && mk.json?.id, `status ${mk.status} ${JSON.stringify(mk.json).slice(0, 140)}`);
  const id = mk.json?.id;
  if (!id) return;
  try {
    ok('the activity keeps its kind', mk.json?.kind === 'activity', String(mk.json?.kind));
    ok('an activity is one occasion, whatever total_sessions was sent',
      mk.json?.total_sessions === 1, String(mk.json?.total_sessions));

    const detail = await req('GET', `/api/trainings/${id}`, H);
    ok('the API gives the activity its single session to tick',
      detail.status === 200 && (detail.json?.sessions || []).length === 1,
      `${(detail.json?.sessions || []).length} sessions`);

    // Sign up + tick who came, over the same paths a course uses.
    const sessionId = detail.json?.sessions?.[0]?.id;
    if (members?.length && sessionId) {
      const enr = await req('POST', `/api/trainings/${id}/enroll`, { ...H, body: { member_id: members[0].id, status: 'approved' } });
      ok('sign a member up for the activity → 200', enr.status === 200 && enr.json?.id, `status ${enr.status}`);
      const att = await req('POST', `/api/trainings/sessions/${sessionId}/attendance`, {
        ...H, body: { records: [{ member_id: members[0].id, attended: true }] },
      });
      ok('tick who came → 200', att.status === 200, `status ${att.status}`);
      const nl = await req('GET', `/api/trainings/${id}/namelist`, H);
      ok('the activity roll call has one column and the tick is on it',
        (nl.json?.sessions || []).length === 1 &&
          (nl.json?.rows || []).some((r) => r.attendance?.[0]?.attended === true),
        JSON.stringify(nl.json?.rows || []).slice(0, 140));
    }

    // The public link makes sense for an activity: it says which shape it is
    // and when it happens, rather than claiming "1 sessions".
    const pub = await req('GET', `/api/trainings/enroll/${id}`);
    ok('public sign-up info for an activity → 200 + kind + date',
      pub.status === 200 && pub.json?.kind === 'activity' && String(pub.json?.starts_on).startsWith('2030-03-09'),
      JSON.stringify(pub.json));
    const badName = await req('POST', `/api/trainings/enroll/${id}`, { body: { full_name: `查无此人-${Date.now()}` } });
    ok('public sign-up still matches on a full name', badName.json?.status === 'no_member', JSON.stringify(badName.json));

    // A shape the app does not ship never reaches the table.
    const junk = await req('PATCH', `/api/trainings/${id}`, { ...H, body: { kind: 'workshop' } });
    ok('an unknown kind → 400', junk.status === 400, `status ${junk.status}`);
    ok('…and says which kinds there are', /course/i.test(junk.json?.message || ''), String(junk.json?.message));
    const unchanged = await req('GET', `/api/trainings/${id}`, H);
    ok('the rejected kind was not stored', unchanged.json?.kind === 'activity', String(unchanged.json?.kind));
  } finally {
    const del = await req('DELETE', `/api/trainings/${id}`, H);
    ok('the activity fixture was deleted', del.status === 200, `status ${del.status}`);
  }
}

/** The smallest real PNG there is — a 1×1 pixel, for the upload paths. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A multipart body carrying one file, the way a browser sends an upload. */
function fileForm(field, bytes, name, type, extra = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append(field, new Blob([bytes], { type }), name);
  return form;
}

/**
 * 报名费 — a PAID course, end to end (migration 0016).
 *
 * A fee changes what the public sign-up form IS: it has to say how much and
 * how to pay before it can ask for proof, and the sign-up then only counts
 * with a receipt attached. What has teeth here:
 *  - the public payload carries the fee, the instructions and the QR — the
 *    three things a payer needs, and still nothing else;
 *  - a sign-up with NO receipt is refused outright, in words, rather than
 *    stored as an enrolment nobody can check;
 *  - a file that is neither an image nor a PDF is refused too — this is the
 *    one upload path with no session behind it;
 *  - a receipt that IS attached comes back to the ADMIN on the enrolment, and
 *    resolves, because approving a paid sign-up means somebody opened it.
 *
 * It works on a course and a member it CREATES and deletes in a `finally`:
 * this runs against the church's live database, and a stray paid course would
 * show up in the catalog for everyone.
 */
async function paidTraining(adminCookie, hallId) {
  const H = { cookie: adminCookie };
  const FEE = 30;
  const INSTRUCTIONS = 'Maybank 5123 4567 8901 (E2E) · TnG 012-000 0000';

  const mk = await req('POST', '/api/trainings', {
    ...H,
    body: {
      name: `E2E收费课程-${Date.now()}`,
      total_sessions: 1,
      is_enrollable: true,
      fee: FEE,
      payment_instructions: INSTRUCTIONS,
      pic: 'E2E 负责人',
      pic_contact: '012-000 0000',
      hall_id: hallId,
    },
  });
  ok('create a paid course → 200 + id', mk.status === 200 && mk.json?.id, `status ${mk.status} ${JSON.stringify(mk.json).slice(0, 140)}`);
  const id = mk.json?.id;
  if (!id) return;

  // Its own signer-up, so the full-name match has exactly one answer and the
  // enrolment disappears with the member (FK cascade).
  const mkMember = await req('POST', '/api/members', {
    ...H,
    body: { full_name: `E2E报名者-${Date.now()}`, church_role: 'member', status: 'active', hall_id: hallId },
  });
  const memberId = mkMember.json?.id;
  const memberName = mkMember.json?.full_name;
  ok('paid-course fixture member created', mkMember.status === 200 && !!memberId, `status ${mkMember.status}`);

  try {
    ok('the fee is stored as money, not as text', Number(mk.json?.fee) === FEE, String(mk.json?.fee));
    ok('the PIC is free text, with a number to ring',
      mk.json?.pic === 'E2E 负责人' && mk.json?.pic_contact === '012-000 0000',
      JSON.stringify({ pic: mk.json?.pic, contact: mk.json?.pic_contact }));

    // ---- the church's payment QR ------------------------------------------
    const qr = await req('POST', `/api/trainings/${id}/payment-qr`, {
      ...H,
      form: fileForm('file', PNG_1PX, 'qr.png', 'image/png'),
    });
    ok('upload a payment QR → 200 + a url on the row',
      qr.status === 200 && typeof qr.json?.payment_qr_url === 'string' && qr.json.payment_qr_url.length > 0,
      `status ${qr.status} ${String(qr.json?.payment_qr_url).slice(0, 80)}`);
    const badQr = await req('POST', `/api/trainings/${id}/payment-qr`, {
      ...H,
      form: fileForm('file', Buffer.from('not an image'), 'notes.txt', 'text/plain'),
    });
    ok('a QR that is not an image → 400', badQr.status === 400, `status ${badQr.status}`);

    // ---- what the PUBLIC page is told -------------------------------------
    const pub = await req('GET', `/api/trainings/enroll/${id}`);
    ok('the public payload carries the fee, the instructions and the QR',
      pub.status === 200 &&
        Number(pub.json?.fee) === FEE &&
        pub.json?.payment_instructions === INSTRUCTIONS &&
        typeof pub.json?.payment_qr_url === 'string' && pub.json.payment_qr_url.length > 0,
      JSON.stringify(pub.json).slice(0, 200));
    ok('…and the PIC and their contact, because people ring before signing up',
      pub.json?.pic === 'E2E 负责人' && pub.json?.pic_contact === '012-000 0000',
      JSON.stringify({ pic: pub.json?.pic, contact: pub.json?.pic_contact }));
    // Still an allow-list: no hall, no timestamps, nothing else off the row.
    ok('…and nothing else off the row',
      pub.json && Object.keys(pub.json).sort().join(',') ===
        'ends_on,fee,id,is_enrollable,kind,location,name,payment_instructions,payment_qr_url,pic,pic_contact,start_time,starts_on,total_sessions',
      Object.keys(pub.json ?? {}).sort().join(','));

    // ---- signing up (no auth), with and without a receipt ------------------
    const noSlip = await req('POST', `/api/trainings/enroll/${id}`, { body: { full_name: memberName } });
    ok('a paid sign-up with no receipt → 400', noSlip.status === 400, `status ${noSlip.status}`);
    ok('…and says what to do about it, in words',
      /receipt/i.test(noSlip.json?.message || ''), String(noSlip.json?.message));

    const badType = await req('POST', `/api/trainings/enroll/${id}`, {
      form: fileForm('slip', Buffer.from('MZ not a receipt'), 'payload.exe', 'application/x-msdownload', {
        full_name: memberName,
      }),
    });
    ok('a receipt that is neither an image nor a PDF → 400', badType.status === 400, `status ${badType.status}`);
    ok('…and names the formats that are accepted',
      /PDF/i.test(badType.json?.message || ''), String(badType.json?.message));

    // Nothing was stored by either refusal — a half-done sign-up would be
    // worse than none.
    const beforeOk = await req('GET', `/api/trainings/${id}`, H);
    ok('neither refusal left an enrolment behind',
      (beforeOk.json?.enrollments || []).length === 0,
      `${(beforeOk.json?.enrollments || []).length} enrolment(s)`);

    const signedUp = await req('POST', `/api/trainings/enroll/${id}`, {
      form: fileForm('slip', PNG_1PX, 'receipt.png', 'image/png', { full_name: memberName }),
    });
    ok('a paid sign-up WITH a receipt → ok', signedUp.json?.status === 'ok', JSON.stringify(signedUp.json));

    // ---- what the ADMIN sees before approving ------------------------------
    const detail = await req('GET', `/api/trainings/${id}`, H);
    const enrolment = (detail.json?.enrollments || []).find((e) => e.member_id === memberId);
    ok('the enrolment reaches the admin with its receipt attached',
      !!enrolment?.payment_slip_url, JSON.stringify(enrolment ?? null).slice(0, 160));
    if (enrolment?.payment_slip_url) {
      const slip = await fetch(enrolment.payment_slip_url).catch((e) => ({ status: 0, error: e }));
      ok('…and the receipt actually opens, which is the whole point',
        slip.status === 200, `status ${slip.status}${slip.error ? ` ${slip.error}` : ''}`);
      ok('…and the approval it gates still works',
        (await req('PATCH', `/api/trainings/enrollments/${enrolment.id}`, { ...H, body: { status: 'approved' } })).status === 200);
    }

    // ---- what the server refuses on the fee itself -------------------------
    const negative = await req('PATCH', `/api/trainings/${id}`, { ...H, body: { fee: -5 } });
    ok('a negative fee → 400', negative.status === 400, `status ${negative.status}`);
    const free = await req('PATCH', `/api/trainings/${id}`, { ...H, body: { fee: '' } });
    ok('an empty fee means FREE, stored as null',
      free.status === 200 && free.json?.fee === null, `status ${free.status} ${String(free.json?.fee)}`);
    const nowFree = await req('POST', `/api/trainings/enroll/${id}`, {
      body: { full_name: `查无此人-${Date.now()}` },
    });
    ok('…and a free course takes a plain sign-up again, with no receipt',
      nowFree.status === 200 && nowFree.json?.status === 'no_member', JSON.stringify(nowFree.json));
  } finally {
    const del = await req('DELETE', `/api/trainings/${id}`, H);
    ok('the paid-course fixture was deleted', del.status === 200, `status ${del.status}`);
    if (memberId) {
      const delMember = await req('DELETE', `/api/members/${memberId}`, H);
      ok('the paid-course fixture member was deleted', delMember.status === 200, `status ${delMember.status}`);
    }
  }

  await convertShape(adminCookie, hallId);
}

/**
 * 形态互换 (0016): a course becomes an activity and back.
 *
 * The trap is the activity's single session — it is API-created plumbing, and
 * a course may have several. Converting one way must therefore reduce to
 * exactly one session (the FIRST, so the roll call already taken on it
 * survives) and converting back must not manufacture a second. The UI asks
 * before that destroys anything; the INVARIANT is the server's, which is what
 * this asserts.
 */
async function convertShape(adminCookie, hallId) {
  const H = { cookie: adminCookie };
  const mk = await req('POST', '/api/trainings', {
    ...H,
    body: { name: `E2E形态-${Date.now()}`, total_sessions: 3, is_enrollable: false, hall_id: hallId },
  });
  ok('create a three-session course → 200 + id', mk.status === 200 && mk.json?.id, `status ${mk.status}`);
  const id = mk.json?.id;
  if (!id) return;
  try {
    for (const n of [1, 2, 3])
      await req('POST', `/api/trainings/${id}/sessions`, { ...H, body: { session_number: n, title: `第 ${n} 堂` } });
    const before = await req('GET', `/api/trainings/${id}`, H);
    ok('…with all three sessions on it', (before.json?.sessions || []).length === 3,
      `${(before.json?.sessions || []).length} sessions`);
    const firstId = before.json?.sessions?.[0]?.id;

    const toActivity = await req('PATCH', `/api/trainings/${id}`, { ...H, body: { kind: 'activity', starts_on: '2030-05-04' } });
    ok('turning it into an activity → 200 + one occasion',
      toActivity.status === 200 && toActivity.json?.kind === 'activity' && toActivity.json?.total_sessions === 1,
      `status ${toActivity.status} ${JSON.stringify(toActivity.json).slice(0, 140)}`);
    ok('…and an activity ends on the day it starts',
      String(toActivity.json?.ends_on).startsWith('2030-05-04'), String(toActivity.json?.ends_on));
    const converted = await req('GET', `/api/trainings/${id}`, H);
    ok('the sessions above the first are gone, and the FIRST is the one kept',
      (converted.json?.sessions || []).length === 1 && converted.json?.sessions?.[0]?.id === firstId,
      JSON.stringify((converted.json?.sessions || []).map((s) => s.session_number)));

    const backToCourse = await req('PATCH', `/api/trainings/${id}`, { ...H, body: { kind: 'course', total_sessions: 4 } });
    ok('turning it back into a course → 200', backToCourse.status === 200 && backToCourse.json?.kind === 'course',
      `status ${backToCourse.status}`);
    const back = await req('GET', `/api/trainings/${id}`, H);
    ok('…and its one session simply becomes session 1 again — nothing manufactured',
      (back.json?.sessions || []).length === 1 && back.json?.sessions?.[0]?.id === firstId,
      JSON.stringify((back.json?.sessions || []).map((s) => s.session_number)));
  } finally {
    const del = await req('DELETE', `/api/trainings/${id}`, H);
    ok('the shape-conversion fixture was deleted', del.status === 200, `status ${del.status}`);
  }
}

/**
 * 聚会点名 — the roll-call sheet (`/api/attendance/sheet`).
 *
 * ONE grid per month whose columns are that month's Sundays (from the
 * calendar, `sunday_attendance`) and the meetings someone added for it
 * (`events` / `event_attendance`), in date order. What has teeth:
 *  - a cleared cell leaves NO row behind, in EITHER table ("not recorded" and
 *    "everyone was absent" must not be two spellings of the same fact);
 *  - a hand-added meeting sorts into place among the Sundays and gets exactly
 *    ONE tick — there is no 会前 to invent for a single occasion;
 *  - the column key decides which table a tick lands in, so a key the server
 *    never handed out is refused rather than guessed at;
 *  - an unnarrowed read now ANSWERS: 全部堂会 simply lists every congregation's
 *    members (it used to be a 400), while a tick is still filed under the
 *    member's own congregation.
 *
 * It works on a member and a meeting it CREATES, in a far-future month, and
 * deletes both in a `finally`: this runs against the church's live database, so
 * it must never write into — or clear — a real roll call. Deleting the member
 * takes its sheet rows with it, and deleting the meeting takes its ticks
 * (both FKs cascade).
 */
async function rollCallSheet(adminCookie, halls, hallId) {
  const H = { cookie: adminCookie };
  if (!hallId) { ok('roll-call sheet (skipped: no congregation)', true); return; }

  // A month far outside anything the church has recorded, so a leaked row could
  // never be mistaken for real attendance. January 2030 starts on a Tuesday and
  // its Sundays are the 6th, 13th, 20th and 27th.
  const SUNDAY = 'sunday:2030-01-06';
  const MONDAY = 'sunday:2030-01-07';
  const sheetUrl = `/api/attendance/sheet?hall_id=${hallId}&year=2030&month=1`;

  const mk = await req('POST', '/api/members', {
    ...H,
    body: { full_name: `E2E点名-${Date.now()}`, church_role: 'member', status: 'active', hall_id: hallId },
  });
  ok('sheet fixture member created', mk.status === 200 && mk.json?.id, `status ${mk.status}`);
  const memberId = mk.json?.id;
  if (!memberId) return;

  // A second member, so the 全员到齐 shortcut below has a real column to fill
  // rather than a list of one. Deleted alongside the first in the `finally`.
  const mk2 = await req('POST', '/api/members', {
    ...H,
    body: { full_name: `E2E点名乙-${Date.now()}`, church_role: 'member', status: 'active', hall_id: hallId },
  });
  ok('second sheet fixture member created', mk2.status === 200 && mk2.json?.id, `status ${mk2.status}`);
  const memberId2 = mk2.json?.id;

  // 15 January 2030, 20:00 in Malaysia — a night prayer meeting, which must
  // appear as its own column between the 13th and the 20th.
  const mkMeeting = await req('POST', '/api/events', {
    ...H,
    body: {
      title: `E2E祷告会-${Date.now()}`,
      event_type: 'meeting',
      starts_at: '2030-01-15T12:00:00.000Z',
      hall_id: hallId,
    },
  });
  ok('sheet fixture meeting created', mkMeeting.status === 200 && mkMeeting.json?.id, `status ${mkMeeting.status}`);
  const meetingId = mkMeeting.json?.id;
  const MEETING = `meeting:${meetingId}`;

  /** That member's cells on the sheet, or undefined if they are not on it. */
  const readRow = async (url = sheetUrl) => {
    const r = await req('GET', url, H);
    return { res: r, row: (r.json?.rows || []).find((x) => x.member?.id === memberId) };
  };
  const cellsOf = (row) => JSON.stringify(row?.cells ?? {});

  try {
    const first = await readRow();
    ok('roll-call sheet GET → 200', first.res.status === 200, `status ${first.res.status} ${JSON.stringify(first.res.json).slice(0, 120)}`);
    ok('the narrowed sheet names its congregation', first.res.json?.hall_id === hallId, String(first.res.json?.hall_id));
    const columns = first.res.json?.columns || [];
    ok('the Sundays come from the calendar, and the meeting sorts into place',
      JSON.stringify(columns.map((c) => `${c.date}/${c.kind}`)) ===
        JSON.stringify([
          '2030-01-06/sunday',
          '2030-01-13/sunday',
          '2030-01-15/meeting',
          '2030-01-20/sunday',
          '2030-01-27/sunday',
        ]),
      JSON.stringify(columns.map((c) => `${c.date}/${c.kind}`)));
    ok('a Sunday carries two ticks and the meeting exactly one',
      JSON.stringify(columns.find((c) => c.kind === 'sunday')?.ticks) === JSON.stringify(['pre_service', 'service']) &&
        JSON.stringify(columns.find((c) => c.kind === 'meeting')?.ticks) === JSON.stringify(['attended']),
      JSON.stringify(columns.map((c) => c.ticks)));
    ok('the meeting column carries the meeting itself, so it can be edited',
      columns.find((c) => c.kind === 'meeting')?.meeting?.id === meetingId,
      JSON.stringify(columns.find((c) => c.kind === 'meeting')?.meeting));
    ok('the congregation’s active members are the rows', !!first.row, `${(first.res.json?.rows || []).length} rows`);
    ok('a column nobody was marked on carries no cell', first.row && !first.row.cells?.[SUNDAY], cellsOf(first.row));

    // ---- a Sunday cell: tick 会前, then both, then clear ------------------
    const tick = await req('PUT', '/api/attendance/sheet', {
      ...H,
      body: { column: SUNDAY, member_id: memberId, pre_service: true, service: false },
    });
    ok('ticking 会前 → 200', tick.status === 200 && tick.json?.pre_service === true && tick.json?.service === false,
      `status ${tick.status} ${JSON.stringify(tick.json)}`);
    const afterTick = await readRow();
    ok('the tick shows up on the sheet',
      afterTick.row?.cells?.[SUNDAY]?.pre_service === true && !afterTick.row?.cells?.[SUNDAY]?.service,
      cellsOf(afterTick.row));

    const both = await req('PUT', '/api/attendance/sheet', {
      ...H,
      body: { column: SUNDAY, member_id: memberId, pre_service: true, service: true },
    });
    ok('ticking the same cell again updates it rather than duplicating',
      both.status === 200 && both.json?.service === true, `status ${both.status} ${JSON.stringify(both.json)}`);

    const clear = await req('PUT', '/api/attendance/sheet', {
      ...H,
      body: { column: SUNDAY, member_id: memberId, pre_service: false, service: false },
    });
    ok('unticking both → 200', clear.status === 200, `status ${clear.status} ${JSON.stringify(clear.json)}`);
    const afterClear = await readRow();
    ok('a cleared Sunday cell leaves no row behind', afterClear.row && !afterClear.row.cells?.[SUNDAY], cellsOf(afterClear.row));

    // ---- the meeting's own column, in the other table ----------------------
    if (meetingId) {
      const came = await req('PUT', '/api/attendance/sheet', {
        ...H, body: { column: MEETING, member_id: memberId, attended: true },
      });
      ok('ticking the meeting → 200', came.status === 200 && came.json?.attended === true,
        `status ${came.status} ${JSON.stringify(came.json)}`);
      const afterCame = await readRow();
      ok('the meeting tick shows up on the same grid',
        afterCame.row?.cells?.[MEETING]?.attended === true, cellsOf(afterCame.row));
      const undo = await req('PUT', '/api/attendance/sheet', {
        ...H, body: { column: MEETING, member_id: memberId, attended: false },
      });
      ok('unticking the meeting → 200', undo.status === 200, `status ${undo.status}`);
      const afterUndo = await readRow();
      ok('…and leaves no row behind either', afterUndo.row && !afterUndo.row.cells?.[MEETING], cellsOf(afterUndo.row));
    }

    // ---- what the server refuses ------------------------------------------
    const badDay = await req('PUT', '/api/attendance/sheet', {
      ...H, body: { column: MONDAY, member_id: memberId, pre_service: true, service: false },
    });
    ok('a Sunday column that is not a Sunday → 400', badDay.status === 400, `status ${badDay.status}`);
    ok('…and says so in words, not as a constraint name',
      /not a Sunday/i.test(badDay.json?.message || ''), String(badDay.json?.message));

    const junkColumn = await req('PUT', '/api/attendance/sheet', {
      ...H, body: { column: 'weekday:2030-01-07', member_id: memberId, pre_service: true },
    });
    ok('a column key the server never handed out → 400', junkColumn.status === 400, `status ${junkColumn.status}`);

    const noMember = await req('PUT', '/api/attendance/sheet', { ...H, body: { column: SUNDAY, pre_service: true } });
    ok('a write with no member_id → 400', noMember.status === 400, `status ${noMember.status}`);

    // ---- 全员到齐: one whole column in ONE call ---------------------------
    // The column header's check-all sends the members as a LIST through the
    // same PUT a single tick uses. What has teeth: every member really is
    // written by the one call, clearing the column leaves NO rows behind (not
    // rows of falses), and an id that is not a member is refused outright
    // rather than half-written.
    if (memberId2) {
      const bothIds = [memberId, memberId2];
      const rowsOf = async () => {
        const r = await req('GET', sheetUrl, H);
        return bothIds.map((id) => (r.json?.rows || []).find((x) => x.member?.id === id));
      };

      const fillAll = await req('PUT', '/api/attendance/sheet', {
        ...H,
        body: { column: SUNDAY, member_ids: bothIds, pre_service: true, service: true },
      });
      ok('ticking a whole column → 200 + the members it wrote',
        fillAll.status === 200 && fillAll.json?.count === 2 &&
          JSON.stringify((fillAll.json?.member_ids || []).slice().sort()) === JSON.stringify(bothIds.slice().sort()),
        `status ${fillAll.status} ${JSON.stringify(fillAll.json)}`);
      const filled = await rowsOf();
      ok('…and every member in that one call is on the sheet',
        filled.every((row) => row?.cells?.[SUNDAY]?.pre_service === true && row?.cells?.[SUNDAY]?.service === true),
        JSON.stringify(filled.map((r) => r?.cells?.[SUNDAY])));

      // Filling only 主日 must leave 会前 exactly as it was — the page sends
      // the whole cell per group of members, so this is what proves the write
      // never rewrites the tick beside the one being changed.
      const onlyService = await req('PUT', '/api/attendance/sheet', {
        ...H,
        body: { column: SUNDAY, member_ids: bothIds, pre_service: true, service: false },
      });
      ok('re-writing a whole column updates rather than duplicating',
        onlyService.status === 200 && onlyService.json?.service === false, `status ${onlyService.status}`);
      const halfway = await rowsOf();
      ok('…and the other tick in the same cell survives it',
        halfway.every((row) => row?.cells?.[SUNDAY]?.pre_service === true && !row?.cells?.[SUNDAY]?.service),
        JSON.stringify(halfway.map((r) => r?.cells?.[SUNDAY])));

      const clearAll = await req('PUT', '/api/attendance/sheet', {
        ...H,
        body: { column: SUNDAY, member_ids: bothIds, pre_service: false, service: false },
      });
      ok('unticking a whole column → 200', clearAll.status === 200, `status ${clearAll.status}`);
      const cleared = await rowsOf();
      ok('…and leaves NO row behind for anybody, not rows of falses',
        cleared.every((row) => row && !row.cells?.[SUNDAY]),
        JSON.stringify(cleared.map((r) => r?.cells ?? null)));

      // The meeting column, whose whole-column write lands in the other table.
      if (meetingId) {
        const allCame = await req('PUT', '/api/attendance/sheet', {
          ...H, body: { column: MEETING, member_ids: bothIds, attended: true },
        });
        ok('ticking a whole meeting column → 200', allCame.status === 200 && allCame.json?.count === 2,
          `status ${allCame.status} ${JSON.stringify(allCame.json)}`);
        const came = await rowsOf();
        ok('…and every member is marked on it', came.every((row) => row?.cells?.[MEETING]?.attended === true),
          JSON.stringify(came.map((r) => r?.cells?.[MEETING])));
        const noneCame = await req('PUT', '/api/attendance/sheet', {
          ...H, body: { column: MEETING, member_ids: bothIds, attended: false },
        });
        ok('unticking a whole meeting column → 200', noneCame.status === 200, `status ${noneCame.status}`);
        const wiped = await rowsOf();
        ok('…and leaves no row behind for anybody there either',
          wiped.every((row) => row && !row.cells?.[MEETING]),
          JSON.stringify(wiped.map((r) => r?.cells ?? null)));
      }

      // A list that names somebody who does not exist is refused whole — a
      // half-applied roll call is worse than a rejected one.
      const ghost = await req('PUT', '/api/attendance/sheet', {
        ...H,
        body: {
          column: SUNDAY,
          member_ids: [memberId, '00000000-0000-0000-0000-000000000000'],
          pre_service: true,
          service: false,
        },
      });
      ok('a whole-column write naming an unknown member → 400', ghost.status === 400, `status ${ghost.status}`);
      const untouched = await rowsOf();
      ok('…and wrote nothing at all', untouched.every((row) => row && !row.cells?.[SUNDAY]),
        JSON.stringify(untouched.map((r) => r?.cells ?? null)));

      const emptyList = await req('PUT', '/api/attendance/sheet', {
        ...H, body: { column: SUNDAY, member_ids: [], pre_service: true },
      });
      ok('an empty member_ids → 400', emptyList.status === 400, `status ${emptyList.status}`);
    }

    // ---- 全部堂会 answers now, instead of refusing -------------------------
    const merged = await req('GET', '/api/attendance/sheet?year=2030&month=1', H);
    ok('an all-congregations read → 200', merged.status === 200, `status ${merged.status} ${JSON.stringify(merged.json).slice(0, 120)}`);
    ok('…and names no single congregation', (merged.json?.hall_id ?? null) === null, String(merged.json?.hall_id));
    const mergedRows = merged.json?.rows || [];
    ok('…and lists every congregation’s members, this fixture included',
      mergedRows.some((r) => r.member?.id === memberId) &&
        mergedRows.length >= (first.res.json?.rows || []).length,
      `${mergedRows.length} rows vs ${(first.res.json?.rows || []).length} in one congregation`);
  } finally {
    // Deleting the member cascades to every sheet row it left behind; deleting
    // the meeting takes its own ticks with it.
    if (meetingId) {
      const delMeeting = await req('DELETE', `/api/events/${meetingId}`, H);
      ok('the roll-call fixture meeting was deleted', delMeeting.status === 200, `status ${delMeeting.status}`);
    }
    const del = await req('DELETE', `/api/members/${memberId}`, H);
    ok('the roll-call fixture member was deleted', del.status === 200, `status ${del.status}`);
    if (memberId2) {
      const del2 = await req('DELETE', `/api/members/${memberId2}`, H);
      ok('the second roll-call fixture member was deleted', del2.status === 200, `status ${del2.status}`);
    }
  }
}

/**
 * 聚会点名, asked for ONE life group — `GET /attendance/sheet?group_id=`, which
 * is the Sunday half of the roll-call card on `/groups/:id`.
 *
 * The assertion that matters most is the third one: a Sunday ticked through the
 * group page must be visible on the UNSCOPED sheet, because it is meant to be
 * the same `sunday_attendance` row and not a second store. Two doors, one
 * record — if that ever stopped holding, a group leader and the office would be
 * looking at two different answers to one question.
 *
 * The rest: the parameter narrows the ROWS and nothing else (the columns stay
 * the month's Sundays), an untick still leaves no row anywhere, and the
 * parameter cannot be used to read a group in a congregation the account is not
 * in — the hall rules come first, exactly as they do on every other read.
 *
 * Everything is fixture data in a far-future month, deleted in a `finally`.
 */
async function groupScopedSheet(adminCookie, halls, hallId) {
  const H = { cookie: adminCookie };
  if (!hallId) { ok('group-scoped sheet (skipped: no congregation)', true); return; }

  // The same far-future month the sheet suite uses: January 2030, whose
  // Sundays are the 6th, 13th, 20th and 27th.
  const SUNDAY = 'sunday:2030-01-06';
  const WHEN = 'year=2030&month=1';

  const mkGroup = await req('POST', '/api/groups', {
    ...H, body: { name: `E2E小组点名-${Date.now()}`, hall_id: hallId },
  });
  ok('group-sheet fixture group created', mkGroup.status === 200 && mkGroup.json?.id, `status ${mkGroup.status}`);
  const groupId = mkGroup.json?.id;
  if (!groupId) return;

  const mkIn = await req('POST', '/api/members', {
    ...H,
    body: { full_name: `E2E组内-${Date.now()}`, church_role: 'member', status: 'active', hall_id: hallId, group_id: groupId },
  });
  const mkOut = await req('POST', '/api/members', {
    ...H,
    body: { full_name: `E2E组外-${Date.now()}`, church_role: 'member', status: 'active', hall_id: hallId },
  });
  ok('group-sheet fixture members created',
    mkIn.status === 200 && mkIn.json?.id && mkOut.status === 200 && mkOut.json?.id,
    `${mkIn.status} / ${mkOut.status}`);
  const insider = mkIn.json?.id;
  const outsider = mkOut.json?.id;

  /** The insider's cells, on whichever sheet is asked for. */
  const cellsOn = async (url) => {
    const r = await req('GET', url, H);
    return { res: r, cells: (r.json?.rows || []).find((x) => x.member?.id === insider)?.cells ?? null };
  };

  try {
    const scoped = await req('GET', `/api/attendance/sheet?${WHEN}&group_id=${groupId}`, H);
    ok('a group-scoped sheet GET → 200', scoped.status === 200, `status ${scoped.status} ${JSON.stringify(scoped.json).slice(0, 120)}`);
    const ids = (scoped.json?.rows || []).map((r) => r.member?.id);
    ok('…and its rows are that group’s roster, nobody else',
      ids.includes(insider) && !ids.includes(outsider) && ids.length === 1,
      `${ids.length} row(s)`);
    ok('…while the columns stay the month’s Sundays',
      (scoped.json?.columns || []).length === 4 &&
        (scoped.json?.columns || []).every((c) => c.kind === 'sunday'),
      JSON.stringify((scoped.json?.columns || []).map((c) => `${c.date}/${c.kind}`)));

    // ---- the one that matters: two doors, ONE record ----------------------
    const tick = await req('PUT', '/api/attendance/sheet', {
      ...H, body: { column: SUNDAY, member_id: insider, pre_service: false, service: true },
    });
    ok('ticking 主日 from the group page → 200', tick.status === 200, `status ${tick.status} ${JSON.stringify(tick.json)}`);
    const wide = await cellsOn(`/api/attendance/sheet?${WHEN}&hall_id=${hallId}`);
    ok('a Sunday ticked on the group page is the SAME row the services sheet shows',
      wide.cells?.[SUNDAY]?.service === true, JSON.stringify(wide.cells));
    const back = await cellsOn(`/api/attendance/sheet?${WHEN}&group_id=${groupId}`);
    ok('…and reads back the same way on the group’s own sheet',
      back.cells?.[SUNDAY]?.service === true, JSON.stringify(back.cells));

    const clear = await req('PUT', '/api/attendance/sheet', {
      ...H, body: { column: SUNDAY, member_id: insider, pre_service: false, service: false },
    });
    ok('unticking it → 200', clear.status === 200, `status ${clear.status}`);
    const gone = await cellsOn(`/api/attendance/sheet?${WHEN}&hall_id=${hallId}`);
    ok('…and it leaves no row behind on either sheet', gone.cells && !gone.cells[SUNDAY], JSON.stringify(gone.cells));

    // ---- the hall rule comes first ----------------------------------------
    const otherHall = (halls || []).find((h) => h.id !== hallId);
    if (!otherHall) {
      ok('a hall-scoped account cannot read another congregation’s group (skipped: one congregation)', true);
    } else {
      // A login pinned to the OTHER congregation, on a fixture member of its
      // own — nothing on a real person is touched, and both go in the finally.
      const email = `e2e-groupsheet-${Date.now()}-${Math.floor(Math.random() * 1e4)}@grace.org`;
      const stranger = await req('POST', '/api/members', {
        ...H,
        body: { full_name: `E2E外堂-${Date.now()}`, church_role: 'member', status: 'active', hall_id: otherHall.id, email },
      });
      const account = await req('POST', '/api/accounts', {
        ...H,
        body: { member_id: stranger.json?.id, account_role: 'coworker', hall_id: otherHall.id, password: 'e2ePass2026' },
      });
      ok('a congregation-scoped login was provisioned',
        stranger.status === 200 && account.status === 200,
        `${stranger.status} / ${account.status} ${JSON.stringify(account.json).slice(0, 120)}`);
      try {
        const cookie = await login(email, 'e2ePass2026');
        ok('…and can sign in', !!cookie);
        if (cookie) {
          const across = await req('GET', `/api/attendance/sheet?${WHEN}&group_id=${groupId}`, { cookie });
          ok('group_id cannot reach another congregation’s roster', across.status === 403,
            `status ${across.status} ${JSON.stringify(across.json).slice(0, 120)}`);
          const own = await req('GET', `/api/attendance/sheet?${WHEN}`, { cookie });
          ok('…while its own congregation’s sheet still answers', own.status === 200, `status ${own.status}`);
          ok('…and that sheet holds none of the other congregation’s members',
            !(own.json?.rows || []).some((r) => r.member?.id === insider),
            `${(own.json?.rows || []).length} rows`);
        }
      } finally {
        // The account first: a member cannot go while a login holds it.
        if (account.json?.id) {
          const delAcc = await req('DELETE', `/api/accounts/${account.json.id}`, H);
          ok('the congregation-scoped login was deleted', delAcc.status === 200, `status ${delAcc.status}`);
        }
        if (stranger.json?.id) {
          const delStranger = await req('DELETE', `/api/members/${stranger.json.id}`, H);
          ok('the other congregation’s fixture member was deleted', delStranger.status === 200, `status ${delStranger.status}`);
        }
      }
    }
  } finally {
    // Members first: deleting the group would only unset their group_id and
    // strand them (`group_id` is ON DELETE SET NULL).
    for (const [what, id] of [['in-group', insider], ['ungrouped', outsider]]) {
      if (!id) continue;
      const del = await req('DELETE', `/api/members/${id}`, H);
      ok(`the ${what} group-sheet fixture member was deleted`, del.status === 200, `status ${del.status}`);
    }
    const delGroup = await req('DELETE', `/api/groups/${groupId}`, H);
    ok('the group-sheet fixture group was deleted', delGroup.status === 200, `status ${delGroup.status}`);
  }
}

/**
 * The church record and the add-on module catalog (migration 0012).
 *
 * Three properties, and one of them has teeth: switching a module off must
 * make the SERVER refuse its paths, not merely hide the nav entry (rule G2).
 * Proving that means turning 四十天守望 off on the live site for a moment, so
 * everything here is restored in a `finally` — the original module state, the
 * original description, whether the assertions passed or blew up.
 */
async function churchAndModules(adminCookie) {
  const H = { cookie: adminCookie };

  // Public: the login card and both public forms render the church's name
  // before anyone has signed in.
  const pub = await req('GET', '/api/church');
  ok('church profile is public (no auth) → 200', pub.status === 200, `status ${pub.status}`);
  ok('public church profile carries a name', typeof pub.json?.name === 'string' && pub.json.name.length > 0, JSON.stringify(pub.json).slice(0, 120));
  // …and only the public fields — no id, no timestamps. The theme is among
  // them because the sign-in card and both public forms are painted in the
  // church's own colours before anyone has a session (migration 0017).
  ok('public church profile exposes nothing else',
    pub.json && Object.keys(pub.json).sort().join(',') ===
      'description,logo_url,name,short_name,theme_brand,theme_preset,theme_rail',
    Object.keys(pub.json ?? {}).join(','));
  const HEX = /^#[0-9a-f]{6}$/i;
  ok('the public payload carries the church’s two theme colours',
    HEX.test(String(pub.json?.theme_rail)) && HEX.test(String(pub.json?.theme_brand)),
    `rail=${pub.json?.theme_rail} brand=${pub.json?.theme_brand}`);
  ok('…and says which preset they came from (null = picked by hand)',
    pub.json?.theme_preset === null || typeof pub.json?.theme_preset === 'string',
    String(pub.json?.theme_preset));

  // Writing it is not public, and not for every role either (the role matrix
  // below checks coworker/readonly with a real session).
  ok('unauth PATCH church → 401', (await req('PATCH', '/api/church', { body: { name: 'nope' } })).status === 401);

  const states = await req('GET', '/api/church/modules', H);
  ok('module catalog → 200 + array', states.status === 200 && Array.isArray(states.json), `status ${states.status}`);
  const original = (states.json || []).find((m) => m.key === 'discipleship');
  ok('the catalog lists the Forty Days add-on', !!original, JSON.stringify(states.json).slice(0, 120));

  // A key that is not in the code registry must never reach the table.
  const junk = await req('PATCH', '/api/church/modules/not_a_module', { ...H, body: { enabled: false } });
  ok('unknown module key → 400', junk.status === 400, `status ${junk.status} ${JSON.stringify(junk.json)}`);
  const junkGone = await req('GET', '/api/church/modules', H);
  ok('the rejected key was not stored', !(junkGone.json || []).some((m) => m.key === 'not_a_module'));

  // Non-boolean bodies are refused too, so `enabled` can never end up as a
  // string that reads truthy forever.
  const badBody = await req('PATCH', '/api/church/modules/discipleship', { ...H, body: { enabled: 'yes' } });
  ok('non-boolean enabled → 400', badBody.status === 400, `status ${badBody.status}`);

  // Church profile round-trip, restored below. The theme is restored the same
  // way: this runs against the live site, and the colours are what everyone in
  // the church sees.
  const originalDescription = pub.json?.description ?? null;
  const originalTheme = {
    preset: pub.json?.theme_preset ?? null,
    rail: pub.json?.theme_rail,
    brand: pub.json?.theme_brand,
  };
  const marker = `api-e2e ${Date.now()}`;
  try {
    const patched = await req('PATCH', '/api/church', { ...H, body: { description: marker } });
    ok('super_admin PATCH church → 200 + saved', patched.status === 200 && patched.json?.description === marker, `status ${patched.status}`);
    const readBack = await req('GET', '/api/church');
    ok('the church description round-trips through the public GET', readBack.json?.description === marker, String(readBack.json?.description));
    // A field that is not on the allow-list is refused rather than dropped.
    const sneaky = await req('PATCH', '/api/church', { ...H, body: { id: '00000000-0000-0000-0000-000000000000' } });
    ok('church PATCH refuses an unknown field → 403', sneaky.status === 403, `status ${sneaky.status}`);
    ok('church name cannot be blanked → 400', (await req('PATCH', '/api/church', { ...H, body: { name: '   ' } })).status === 400);

    // ---- the theme: two colours, and what may not be stored as one --------
    // These strings end up inside a CSS custom property on every page, so the
    // server refuses anything that is not a strict #rrggbb — never sanitises
    // it — and refuses a pair the app cannot be read on.
    for (const [what, body] of [
      ['a colour name', { theme_preset: null, theme_rail: 'red', theme_brand: '#a51f24' }],
      ['three-digit shorthand', { theme_preset: null, theme_rail: '#abc', theme_brand: '#a51f24' }],
      ['a CSS injection', { theme_preset: null, theme_rail: '#fff; } html { display: none } :root { --x: #fff', theme_brand: '#a51f24' }],
      ['one colour without the other', { theme_preset: null, theme_rail: '#201d1b' }],
      ['a preset this build does not ship', { theme_preset: 'neon_pink' }],
      ['a sidebar too pale to read its own menu', { theme_preset: null, theme_rail: '#ffffff', theme_brand: '#a51f24' }],
      ['a brand too pale for the white text on every button', { theme_preset: null, theme_rail: '#201d1b', theme_brand: '#ffee00' }],
    ]) {
      const bad = await req('PATCH', '/api/church', { ...H, body });
      ok(`church theme refuses ${what} → 400`, bad.status === 400, `status ${bad.status} ${JSON.stringify(bad.json)}`);
    }
    // Nothing above was stored: the colours are still the ones we started with.
    const untouched = await req('GET', '/api/church');
    ok('a refused theme changed nothing',
      untouched.json?.theme_rail === originalTheme.rail && untouched.json?.theme_brand === originalTheme.brand,
      `${untouched.json?.theme_rail}/${untouched.json?.theme_brand}`);

    // A valid custom pair round-trips through the PUBLIC read, which is where
    // the login page and the sign-up form take their colours from.
    const custom = await req('PATCH', '/api/church', { ...H, body: { theme_preset: null, theme_rail: '#1A2130', theme_brand: '#2F6690' } });
    ok('super_admin PATCH theme → 200 + normalized to lowercase',
      custom.status === 200 && custom.json?.theme_rail === '#1a2130' && custom.json?.theme_brand === '#2f6690' && custom.json?.theme_preset === null,
      `status ${custom.status} ${JSON.stringify(custom.json)}`);
    const publicTheme = await req('GET', '/api/church');
    ok('the theme round-trips through the public GET',
      publicTheme.json?.theme_rail === '#1a2130' && publicTheme.json?.theme_brand === '#2f6690',
      JSON.stringify(publicTheme.json));

    // A preset names its OWN colours: the catalogue in code is the authority,
    // so colours sent alongside a preset key are ignored rather than stored
    // under a name that never had them.
    const preset = await req('PATCH', '/api/church', { ...H, body: { theme_preset: 'charcoal', theme_rail: '#123456', theme_brand: '#654321' } });
    ok('picking a preset stores the preset’s own colours, not the sender’s',
      preset.status === 200 && preset.json?.theme_preset === 'charcoal' &&
        preset.json?.theme_rail !== '#123456' && preset.json?.theme_brand !== '#654321' &&
        HEX.test(String(preset.json?.theme_rail)) && HEX.test(String(preset.json?.theme_brand)),
      `status ${preset.status} ${JSON.stringify(preset.json)}`);

    // ---- the gate: a disabled module's paths must stop answering ----------
    if (original) {
      const off = await req('PATCH', '/api/church/modules/discipleship', { ...H, body: { enabled: false } });
      ok('disable module → 200 + enabled:false', off.status === 200 && off.json?.enabled === false, `status ${off.status} ${JSON.stringify(off.json)}`);
      const blocked = await req('GET', '/api/discipleship/programs', H);
      ok('a disabled module refuses its own API path → 404', blocked.status === 404, `status ${blocked.status}`);
      const blockedPair = await req('GET', '/api/discipleship/pairs', H);
      ok('every path the module owns is refused, not just the first → 404', blockedPair.status === 404, `status ${blockedPair.status}`);
      // The PUBLIC mentor form belongs to the module too, so it closes with it.
      const blockedForm = await req('GET', '/api/discipleship/form/whatever');
      ok('the public mentor form closes with the module → 404', blockedForm.status === 404, `status ${blockedForm.status}`);
      // …and nothing else moved: core paths and the catalog itself stay up.
      ok('core paths are untouched while a module is off', (await req('GET', '/api/members', H)).status === 200);
      ok('the church profile stays public while a module is off', (await req('GET', '/api/church')).status === 200);
      ok('the catalog itself is still readable while a module is off', (await req('GET', '/api/church/modules', H)).status === 200);
    }
  } finally {
    // This runs against the church's live site: put both back exactly as they
    // were, whatever happened above, and SAY whether it worked.
    if (original) {
      const back = await req('PATCH', `/api/church/modules/discipleship`, { ...H, body: { enabled: original.enabled } });
      ok('the module was restored to its original state',
        back.status === 200 && back.json?.enabled === original.enabled,
        `status ${back.status} ${JSON.stringify(back.json)}`);
      if (original.enabled)
        ok('the module answers again after being re-enabled', (await req('GET', '/api/discipleship/programs', H)).status === 200);
    }
    const restored = await req('PATCH', '/api/church', { ...H, body: { description: originalDescription } });
    ok('the church description was restored',
      restored.status === 200 && (restored.json?.description ?? null) === originalDescription,
      `status ${restored.status} ${String(restored.json?.description)}`);
    // The colours everyone in this church sees — put back exactly as found,
    // by preset key when there was one (so the pair keeps its name) and by the
    // two colours when it was a custom pair.
    if (originalTheme.rail && originalTheme.brand) {
      const backToTheme = await req('PATCH', '/api/church', {
        ...H,
        body: originalTheme.preset
          ? { theme_preset: originalTheme.preset }
          : { theme_preset: null, theme_rail: originalTheme.rail, theme_brand: originalTheme.brand },
      });
      ok('the church theme was restored',
        backToTheme.status === 200 &&
          backToTheme.json?.theme_rail === originalTheme.rail &&
          backToTheme.json?.theme_brand === originalTheme.brand &&
          (backToTheme.json?.theme_preset ?? null) === originalTheme.preset,
        `status ${backToTheme.status} ${JSON.stringify(backToTheme.json)}`);
    }
  }
}

/** Was this address minted by `provision` below rather than by the church? */
const generatedEmail = (v) => /^e2e-(readonly|coworker|admin|super_admin)-\d+-\d+@grace\.org$/i.test(String(v ?? ''));
/** Was this the phone `selfProfileMatrix` writes (012- plus seven digits)? */
const generatedPhone = (v) => /^012-\d{7}$/.test(String(v ?? ''));

async function roleMatrix(freeMembers, hallId) {
  if (freeMembers.length < 2) { ok('role-matrix (skipped: need 2 free members)', true); return; }
  const admin = await login(EMAIL, PASSWORD);
  const H = { cookie: admin };
  const made = [];
  const originalEmails = new Map();
  const originalPhones = new Map();
  // A hard exit runs no `finally`. This block writes to real members and
  // creates real login accounts, so the process-level handlers get the same
  // undo — otherwise a crash here is what leaves an e2e address on someone's
  // profile and a stray account in 用户管理.
  const bail = async (why, err) => {
    if (err) console.error(`API E2E ${why}:`, err);
    await restoreRoleMatrix(H, made, originalEmails, originalPhones).catch(() => {});
    // And the same total purge the normal path ends with — a crash is exactly
    // when a fixture goes missing from every list that knows about it.
    await purgeResidue(H).catch(() => {});
    process.exit(1);
  };
  process.on('uncaughtException', (e) => void bail('uncaught exception', e));
  process.on('unhandledRejection', (e) => void bail('unhandled rejection', e));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void bail(sig));
  const provision = async (role, member) => {
    const email = `e2e-${role}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@grace.org`;
    // Never adopt this script's own leftovers as "the original". A run that
    // died before its restore leaves an e2e address on a real member; the next
    // run would then record THAT as the value to put back, and the church's
    // member list keeps a fake email for ever. Same for the generated phone.
    // (It happened: four members were carrying e2e addresses before this.)
    if (!originalEmails.has(member.id)) originalEmails.set(member.id, generatedEmail(member.email) ? null : member.email ?? null);
    if (!originalPhones.has(member.id)) originalPhones.set(member.id, generatedPhone(member.phone) ? null : member.phone ?? null);
    await req('PATCH', `/api/members/${member.id}`, { ...H, body: { email } });
    const r = await req('POST', '/api/accounts', { ...H, body: { member_id: member.id, account_role: role, password: 'e2ePass2026' } });
    if (r.json?.id) made.push(r.json.id);
    return { id: r.json?.id, email, cookie: await login(email, 'e2ePass2026') };
  };
  try {
    // Both are provisioned up front so each can stand in as "somebody else's
    // account" for the other's cross-account checks below.
    const ro = await provision('readonly', freeMembers[0]);
    const co = await provision('coworker', freeMembers[1]);
    ok('readonly can login', !!ro.cookie);
    if (ro.cookie) {
      const RH = { cookie: ro.cookie };
      ok('readonly GET members → 200', (await req('GET', '/api/members', RH)).status === 200);
      ok('readonly POST members → 403', (await req('POST', '/api/members', { ...RH, body: { full_name: 'x', church_role: 'member', status: 'active' } })).status === 403);
      ok('readonly GET accounts → 403', (await req('GET', '/api/accounts', RH)).status === 403);
      // Importing is a bulk create-and-overwrite, so it is admin-only — and a
      // read-only account is refused by the write gate before that even.
      ok('readonly POST members/import → 403',
        (await req('POST', '/api/members/import', {
          ...RH,
          body: { hall_id: hallId, rows: [{ row: 2, full_name: `E2E禁止-${Date.now()}` }] },
        })).status === 403);
      // The roll-call sheet writes with PUT — a verb the gate had never seen
      // before 0013, so prove it is refused for a read-only account too, and
      // that the refusal happens before anything is written.
      if (hallId) {
        ok('readonly GET roll-call sheet → 200',
          (await req('GET', `/api/attendance/sheet?hall_id=${hallId}&year=2030&month=1`, RH)).status === 200);
        ok('readonly PUT roll-call sheet → 403',
          (await req('PUT', '/api/attendance/sheet', {
            ...RH,
            body: { column: 'sunday:2030-01-06', member_id: freeMembers[0].id, pre_service: true, service: true },
          })).status === 403);
        // The column header's 全员到齐 shortcut is the SAME verb on the same
        // path with a list instead of one id — so it is refused by the same
        // gate, before a single row is written. A bulk hole would be a bigger
        // one than a single-cell hole, which is exactly why it is asserted.
        const bulkIds = freeMembers.slice(0, 2).map((m) => m.id);
        ok('readonly PUT a whole roll-call column → 403',
          (await req('PUT', '/api/attendance/sheet', {
            ...RH,
            body: { column: 'sunday:2030-01-06', member_ids: bulkIds, pre_service: true, service: true },
          })).status === 403);
        const untouched = await req('GET', `/api/attendance/sheet?hall_id=${hallId}&year=2030&month=1`, RH);
        ok('…and nothing was written by the refused whole-column write',
          (untouched.json?.rows || [])
            .filter((r) => bulkIds.includes(r.member?.id))
            .every((r) => !r.cells?.['sunday:2030-01-06']),
          JSON.stringify((untouched.json?.rows || []).filter((r) => bulkIds.includes(r.member?.id)).map((r) => r.cells)));
      }
      await churchRoleMatrix('readonly', RH);
      await selfProfileMatrix('readonly', RH, ro, co.id);
    }
    ok('coworker can login', !!co.cookie);
    if (co.cookie) {
      const CH = { cookie: co.cookie };
      const mk = await req('POST', '/api/members', { ...CH, body: { full_name: `E2E同工建-${Date.now()}`, church_role: 'member', status: 'active', hall_id: hallId } });
      ok('coworker POST members → 200', mk.status === 200, `status ${mk.status}`);
      if (mk.json?.id) {
        ok('coworker DELETE member → 403', (await req('DELETE', `/api/members/${mk.json.id}`, CH)).status === 403);
        await req('DELETE', `/api/members/${mk.json.id}`, H); // cleanup as super_admin
      }
      ok('coworker GET accounts → 403', (await req('GET', '/api/accounts', CH)).status === 403);
      // A coworker may add members one at a time (asserted above) but not
      // rewrite the roll in one request — the same bar as a delete.
      const coImport = `E2E同工导入-${Date.now()}`;
      ok('coworker POST members/import → 403',
        (await req('POST', '/api/members/import', {
          ...CH,
          body: { hall_id: hallId, rows: [{ row: 2, full_name: coImport }] },
        })).status === 403);
      ok('…and the refused import wrote nothing',
        ((await req('GET', `/api/members?q=${encodeURIComponent(coImport)}`, H)).json || []).length === 0);
      await churchRoleMatrix('coworker', CH);
      await selfProfileMatrix('coworker', CH, co, ro.id);
    }
  } finally {
    await restoreRoleMatrix(H, made, originalEmails, originalPhones);
  }
}

/**
 * Put the church's own records back. Kept out of the `finally` so the crash
 * handler can call the same thing: a hard exit runs no `finally`, and what this
 * undoes is not a throwaway fixture — it is two real members' email and phone,
 * and two login accounts on the live site.
 */
async function restoreRoleMatrix(H, made, originalEmails, originalPhones) {
  for (const id of made.splice(0)) await req('DELETE', `/api/accounts/${id}`, H).catch(() => {});
  for (const [id, email] of originalEmails) await req('PATCH', `/api/members/${id}`, { ...H, body: { email } }).catch(() => {});
  originalEmails.clear();
  for (const [id, phone] of originalPhones) await req('PATCH', `/api/members/${id}`, { ...H, body: { phone } }).catch(() => {});
  originalPhones.clear();
}

/**
 * Church settings are readable by everyone signed in — the shell renders the
 * name, and the nav needs to know which modules exist — but only a super admin
 * may change either the record or a module's state. A role that could switch
 * 四十天守望 off for the whole church would be a far bigger hole than one that
 * could edit a member.
 */
async function churchRoleMatrix(role, RH) {
  ok(`${role} GET church → 200`, (await req('GET', '/api/church', RH)).status === 200);
  const before = await req('GET', '/api/church/modules', RH);
  ok(`${role} GET module catalog → 200`, before.status === 200, `status ${before.status}`);
  const wasEnabled = (before.json || []).find((m) => m.key === 'discipleship')?.enabled;
  const rename = await req('PATCH', '/api/church', { ...RH, body: { name: `hijacked-${Date.now()}` } });
  ok(`${role} PATCH church → 403`, rename.status === 403, `status ${rename.status}`);
  const toggle = await req('PATCH', '/api/church/modules/discipleship', { ...RH, body: { enabled: !wasEnabled } });
  ok(`${role} cannot switch a module off → 403`, toggle.status === 403, `status ${toggle.status}`);
  // The theme is the church's branding, on every screen including the public
  // ones — the same super_admin-only write as the name (rule G2).
  const themeBefore = await req('GET', '/api/church', RH);
  const repaint = await req('PATCH', '/api/church', { ...RH, body: { theme_preset: 'forest' } });
  ok(`${role} cannot repaint the church → 403`, repaint.status === 403, `status ${repaint.status}`);
  // A refusal that silently wrote would be worse than a 200 — read it back.
  const after = await req('GET', '/api/church/modules', RH);
  ok(`${role} left the module catalog untouched`,
    (after.json || []).find((m) => m.key === 'discipleship')?.enabled === wasEnabled,
    JSON.stringify(after.json).slice(0, 120));
  const themeAfter = await req('GET', '/api/church', RH);
  ok(`${role} left the theme untouched`,
    themeAfter.json?.theme_rail === themeBefore.json?.theme_rail &&
      themeAfter.json?.theme_brand === themeBefore.json?.theme_brand,
    `${themeAfter.json?.theme_rail}/${themeAfter.json?.theme_brand}`);
}

/**
 * `/auth/me/profile` — the self-service keyhole in the permission matrix, and
 * the one thing here that would be a privilege-escalation bug if it were wrong.
 *
 * Two properties are asserted for EVERY non-super-admin role, `readonly`
 * included: the account may edit its own member details (that is the whole
 * point of the endpoint), and it may not use the same endpoint to hand itself a
 * bigger role, a different congregation, or a re-enabled status. A silent
 * no-op would be almost as bad as a write, so the role is read back afterwards
 * rather than trusting the refusal.
 *
 * `otherAccountId` is the sibling role's account — somebody else's record, to
 * prove the endpoint never widens into the super_admin-only /accounts path.
 */
async function selfProfileMatrix(role, RH, account, otherAccountId) {
  const self = await req('GET', '/api/auth/me/profile', RH);
  ok(`${role} GET own profile → 200`, self.status === 200 && self.json?.id === account.id, `status ${self.status}`);
  ok(`${role} own profile carries its member`, !!self.json?.member?.id, JSON.stringify(self.json?.member ?? null).slice(0, 80));

  const phone = `012-${Math.floor(1e6 + Math.random() * 8e6)}`;
  const edit = await req('PATCH', '/api/auth/me/profile', { ...RH, body: { phone } });
  ok(`${role} PATCH own profile → 200 + saved`, edit.status === 200 && edit.json?.member?.phone === phone, `status ${edit.status} ${edit.json?.member?.phone}`);

  // The three fields the self-service path must never accept. Each is refused
  // outright (403) rather than quietly dropped, so a client that tries gets told.
  for (const [field, value] of [['account_role', 'super_admin'], ['hall_id', null], ['status', 'active']]) {
    const r = await req('PATCH', '/api/auth/me/profile', { ...RH, body: { [field]: value } });
    ok(`${role} cannot set own ${field} → 403`, r.status === 403, `status ${r.status} ${JSON.stringify(r.json)}`);
  }
  // …and a valid field alongside a forbidden one must not sneak the pair past.
  const mixed = await req('PATCH', '/api/auth/me/profile', { ...RH, body: { phone, account_role: 'super_admin' } });
  ok(`${role} cannot smuggle a role change beside a legal field → 403`, mixed.status === 403, `status ${mixed.status}`);

  const after = await req('GET', '/api/auth/me/profile', RH);
  ok(`${role} is still ${role} after the escalation attempts`, after.json?.account_role === role, String(after.json?.account_role));

  // The admin path stays shut: no reading or writing anyone else's account.
  if (otherAccountId) {
    ok(`${role} PATCH another account → 403`, (await req('PATCH', `/api/accounts/${otherAccountId}`, { ...RH, body: { account_role: 'admin' } })).status === 403);
    ok(`${role} GET another account → 403`, (await req('GET', `/api/accounts/${otherAccountId}`, RH)).status === 403);
  }
}

/**
 * The last word on test data: delete every row this suite's naming convention
 * owns, whoever created it.
 *
 * Each block already deletes its own fixtures in a `finally`, and the crash
 * handler restores the two real members it borrows. What none of that covers is
 * a row from an EARLIER run that died between creating something and reaching
 * its `finally` — invisible to this process, and simply accumulating in the
 * church's live database. That is not hypothetical: a crashed deploy run left
 * two login accounts behind, and the two real members whose email addresses
 * they had overwritten.
 *
 * So ask the API what is actually there and remove anything carrying a fixture
 * name, in the reverse of the order fixtures are built. Residue that survives
 * is a FAILED CHECK, not a log line — a run that leaves data in the live
 * database has not passed.
 */
const FIXTURE_NAME = /^(E2E|ZZ_UITEST|查无此人)/;
const FIXTURE_EMAIL = /^e2e-[a-z_]+-\d+-\d+@grace\.org$/i;
async function purgeResidue(H) {
  const stuck = [];
  const list = async (path) => {
    const r = await req('GET', path, H);
    return Array.isArray(r.json) ? r.json : [];
  };
  const kill = async (label, path) => {
    const r = await req('DELETE', path, H);
    if (r.status === 200 || r.status === 404) console.log(`  ↳ purge: removed stray ${label}`);
    else stuck.push(`${label} → ${r.status}`);
  };

  // Accounts first: one holds a member, and a member cannot go while it does.
  for (const a of await list('/api/accounts')) {
    if (FIXTURE_EMAIL.test(String(a?.email ?? ''))) await kill(`account ${a.email}`, `/api/accounts/${a.id}`);
  }
  for (const p2 of await list('/api/discipleship/pairs')) {
    if (FIXTURE_NAME.test(String(p2?.mentor?.full_name ?? '')) ||
        FIXTURE_NAME.test(String(p2?.trainee?.full_name ?? '')))
      await kill('pair', `/api/discipleship/pairs/${p2.id}`);
  }
  for (const t of await list('/api/trainings')) {
    if (FIXTURE_NAME.test(String(t?.name ?? ''))) await kill(`training ${t.name}`, `/api/trainings/${t.id}`);
  }
  for (const e of await list('/api/events')) {
    if (FIXTURE_NAME.test(String(e?.title ?? ''))) await kill(`meeting ${e.title}`, `/api/events/${e.id}`);
  }
  for (const m of await list('/api/members')) {
    if (FIXTURE_NAME.test(String(m?.full_name ?? ''))) await kill(`member ${m.full_name}`, `/api/members/${m.id}`);
  }
  for (const g of await list('/api/groups')) {
    if (FIXTURE_NAME.test(String(g?.name ?? ''))) await kill(`group ${g.name}`, `/api/groups/${g.id}`);
  }
  // A member the suite borrowed rather than created: its email was overwritten
  // with a generated one and the restore never ran. Clearing it is right — a
  // fabricated address on a real person is worse than none, and it is the
  // address their login is derived from.
  for (const m of await list('/api/members')) {
    if (FIXTURE_EMAIL.test(String(m?.email ?? ''))) {
      const r = await req('PATCH', `/api/members/${m.id}`, { ...H, body: { email: null } });
      if (r.status === 200) console.log(`  ↳ purge: cleared a fabricated email off ${m.full_name}`);
      else stuck.push(`fabricated email on ${m.full_name} → ${r.status}`);
    }
  }
  return stuck;
}

function finish() {
  console.log(`\n==== API E2E: ${pass} passed, ${fail} failed ====`);
  if (fail) { console.error('Failures:\n - ' + fails.join('\n - ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('API E2E crashed:', e); process.exit(1); });
