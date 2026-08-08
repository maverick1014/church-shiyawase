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

async function req(method, path, { cookie, body, raw } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  const mkMember = await req('POST', '/api/members', { ...H, body: { full_name: `E2E成员-${Date.now()}`, church_role: 'member', status: 'active', hall_id: hallId } });
  ok('create member → 200 + id', mkMember.status === 200 && mkMember.json?.id, `status ${mkMember.status}`);
  const memberId = mkMember.json?.id;
  if (memberId) {
    const patch = await req('PATCH', `/api/members/${memberId}`, { ...H, body: { phone: '012-000 0000' } });
    ok('update member → 200', patch.status === 200 && patch.json?.phone === '012-000 0000');
    const del = await req('DELETE', `/api/members/${memberId}`, H);
    ok('delete member → 200', del.status === 200);
  }

  // ---- Events CRUD --------------------------------------------------------
  const mkEv = await req('POST', '/api/events', { ...H, body: { title: `E2E聚会-${Date.now()}`, event_type: 'service', starts_at: new Date('2026-08-01T10:00:00Z').toISOString() } });
  ok('create event → 200 + id', mkEv.status === 200 && mkEv.json?.id, `status ${mkEv.status} ${JSON.stringify(mkEv.json).slice(0,120)}`);
  const evId = mkEv.json?.id;
  if (evId) {
    ok('update event → 200', (await req('PATCH', `/api/events/${evId}`, { ...H, body: { location: '副堂' } })).status === 200);
    if (memberOrNull(members)) {
      const att = await req('POST', `/api/events/${evId}/attendance`, { ...H, body: { records: [{ member_id: members[0].id, status: 'present' }] } });
      ok('event attendance → 200', att.status === 200, `status ${att.status}`);
    }
    ok('delete event → 200', (await req('DELETE', `/api/events/${evId}`, H)).status === 200);
  }

  // ---- 主日点名 (the Sunday sheet) -----------------------------------------
  await sundaySheet(admin, halls, hallId);

  // ---- Recurring events (循环聚会) ------------------------------------------
  const rules = (await req('GET', '/api/recurring-events', H)).json;
  ok('recurring-events is an array', Array.isArray(rules), JSON.stringify(rules).slice(0, 120));
  const mkRule = await req('POST', '/api/recurring-events', {
    ...H,
    body: { title: `E2E循环-${Date.now()}`, event_type: 'prayer', weekday: 'wednesday', start_time: '20:00:00', location: '副堂', hall_id: hallId, lookahead_days: 14 },
  });
  ok('create recurring rule → 200 + id', mkRule.status === 200 && mkRule.json?.id, `status ${mkRule.status} ${JSON.stringify(mkRule.json).slice(0,120)}`);
  const ruleId = mkRule.json?.id;
  if (ruleId) {
    ok('update recurring rule → 200', (await req('PATCH', `/api/recurring-events/${ruleId}`, { ...H, body: { active: false } })).status === 200);
    // GET /events tops the calendar up from the active rules; a paused rule
    // must not generate anything.
    const afterPause = (await req('GET', '/api/events', H)).json;
    ok('paused rule generates nothing', Array.isArray(afterPause) && !afterPause.some((e) => e.recurring_id === ruleId));
    ok('re-activate rule → 200', (await req('PATCH', `/api/recurring-events/${ruleId}`, { ...H, body: { active: true } })).status === 200);
    const afterResume = (await req('GET', '/api/events', H)).json;
    const generated = (afterResume || []).filter((e) => e.recurring_id === ruleId);
    ok('active rule fills the calendar', generated.length > 0, `${generated.length} generated`);
    ok('generated events land on the rule weekday', generated.every((e) => new Date(e.starts_at).getUTCDay() === 3 || new Date(e.starts_at).getDay() === 3));
    // Deleting the rule must KEEP the events it produced (they hold attendance).
    ok('delete recurring rule → 200', (await req('DELETE', `/api/recurring-events/${ruleId}`, H)).status === 200);
    const afterDelete = (await req('GET', '/api/events', H)).json;
    const survivors = (afterDelete || []).filter((e) => generated.some((g) => g.id === e.id));
    ok('generated events survive rule deletion', survivors.length === generated.length, `${survivors.length}/${generated.length} kept`);
    for (const e of survivors) await req('DELETE', `/api/events/${e.id}`, H); // cleanup
  }

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
    if (members?.length) {
      const matchEnroll = await req('POST', `/api/trainings/enroll/${trId}`, { body: { full_name: members[members.length - 1].full_name } });
      ok('public enroll matched name → ok/already/ambiguous', ['ok', 'already', 'ambiguous'].includes(matchEnroll.json?.status), JSON.stringify(matchEnroll.json));
    }
    ok('delete training → 200', (await req('DELETE', `/api/trainings/${trId}`, H)).status === 200);
  }

  // ---- 培训&活动: the ACTIVITY shape --------------------------------------
  await activityShape(admin, members, hallId);

  // ---- Discipleship module CRUD + pair CRUD + public form ------------------
  // 守望模块 (discipleship_programs) are creatable from the UI now, so this
  // block brings its OWN module and works on that — the same create → use →
  // delete shape as the training block above. The church's real module is
  // never touched: deleting one cascades to every pair under it and to all of
  // their daily records.
  const programsBefore = (await req('GET', '/api/discipleship/programs', H)).json;
  ok('discipleship modules list is an array', Array.isArray(programsBefore), JSON.stringify(programsBefore).slice(0, 120));
  const mkProg = await req('POST', '/api/discipleship/programs', { ...H, body: { name: `E2E模块-${Date.now()}`, description: 'api-e2e fixture', total_days: 7 } });
  ok('create discipleship module → 200 + id', mkProg.status === 200 && mkProg.json?.id, `status ${mkProg.status} ${JSON.stringify(mkProg.json).slice(0, 120)}`);
  const programId = mkProg.json?.id;
  if (programId) {
    ok('created module keeps its total_days', mkProg.json?.total_days === 7, String(mkProg.json?.total_days));
    const readProg = await req('GET', `/api/discipleship/programs/${programId}`, H);
    ok('read module by id → 200', readProg.status === 200 && readProg.json?.id === programId, `status ${readProg.status}`);
    const patchProg = await req('PATCH', `/api/discipleship/programs/${programId}`, { ...H, body: { name: `E2E模块改-${Date.now()}`, total_days: 12 } });
    ok('update module → 200 + new total_days', patchProg.status === 200 && patchProg.json?.total_days === 12, `status ${patchProg.status} ${patchProg.json?.total_days}`);
    // total_days >= 1 is a DB check constraint; the UI validates it too, but
    // the server must refuse a hand-rolled request all the same.
    const badDays = await req('PATCH', `/api/discipleship/programs/${programId}`, { ...H, body: { total_days: 0 } });
    ok('module with total_days < 1 → rejected', badDays.status >= 400, `status ${badDays.status}`);
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
  }
  if (programId) {
    ok('delete module → 200', (await req('DELETE', `/api/discipleship/programs/${programId}`, H)).status === 200);
    const after = (await req('GET', '/api/discipleship/programs', H)).json;
    ok('the deleted module is gone from the list', Array.isArray(after) && !after.some((p) => p.id === programId));
    ok('the church’s own modules survive', Array.isArray(after) && (programsBefore || []).every((p) => after.some((q) => q.id === p.id)));
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

  finish();
}

function memberOrNull(members) {
  return members && members.length ? members[0] : null;
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

/**
 * 主日点名 — the Sunday sheet (migration 0013).
 *
 * Every Sunday simply exists, so there is nothing to create: the sheet's
 * columns come from the calendar and a cell is written straight onto
 * (congregation, Sunday, member). Three properties have teeth here:
 *  - a cleared cell leaves NO row behind ("not recorded" and "all false" must
 *    not be two spellings of the same fact — the table forbids the second);
 *  - a date that is not a Sunday is refused in words, not as a constraint name;
 *  - an unnarrowed read is refused rather than merging congregations, which is
 *    exactly the joint-service idea this model removes.
 *
 * It works on a member it CREATES, in a far-future month, and deletes it in a
 * `finally`: this runs against the church's live database, so it must never
 * write into — or clear — a real Sunday's roll call. Deleting the member takes
 * its sheet rows with it (FK cascade).
 */
async function sundaySheet(adminCookie, halls, hallId) {
  const H = { cookie: adminCookie };
  if (!hallId) { ok('sunday sheet (skipped: no congregation)', true); return; }

  // A Sunday far outside anything the church has recorded, so a leaked row
  // could never be mistaken for real attendance. 2030-01-06 is a Sunday.
  const SUNDAY = '2030-01-06';
  const MONDAY = '2030-01-07';
  const sheetUrl = (extra = '') => `/api/attendance/sundays?hall_id=${hallId}&year=2030&month=1${extra}`;

  const mk = await req('POST', '/api/members', {
    ...H,
    body: { full_name: `E2E主日-${Date.now()}`, church_role: 'member', status: 'active', hall_id: hallId },
  });
  ok('sheet fixture member created', mk.status === 200 && mk.json?.id, `status ${mk.status}`);
  const memberId = mk.json?.id;
  if (!memberId) return;

  /** That member's row on the sheet, or undefined if it is not on it. */
  const readRow = async () => {
    const r = await req('GET', sheetUrl(), H);
    return { res: r, row: (r.json?.rows || []).find((x) => x.member?.id === memberId) };
  };

  try {
    const first = await readRow();
    ok('sunday sheet GET → 200', first.res.status === 200, `status ${first.res.status} ${JSON.stringify(first.res.json).slice(0, 120)}`);
    ok('the sheet names exactly one congregation', first.res.json?.hall_id === hallId, String(first.res.json?.hall_id));
    ok('the columns are that month’s Sundays, from the calendar',
      JSON.stringify(first.res.json?.dates) ===
        JSON.stringify(['2030-01-06', '2030-01-13', '2030-01-20', '2030-01-27']),
      JSON.stringify(first.res.json?.dates));
    ok('the congregation’s active members are the rows', !!first.row, `${(first.res.json?.rows || []).length} rows`);
    ok('a Sunday nobody was marked on carries no cell', first.row && !first.row.cells?.[SUNDAY],
      JSON.stringify(first.row?.cells));

    // Tick 会前 only, then both — a cell is written by one call whether or not
    // it already existed.
    const tick = await req('PUT', '/api/attendance/sundays', {
      ...H,
      body: { hall_id: hallId, service_date: SUNDAY, member_id: memberId, pre_service: true, service: false },
    });
    ok('ticking 会前 → 200', tick.status === 200 && tick.json?.pre_service === true && tick.json?.service === false,
      `status ${tick.status} ${JSON.stringify(tick.json)}`);
    const afterTick = await readRow();
    ok('the tick shows up on the sheet',
      afterTick.row?.cells?.[SUNDAY]?.pre_service === true && afterTick.row?.cells?.[SUNDAY]?.service === false,
      JSON.stringify(afterTick.row?.cells));

    const both = await req('PUT', '/api/attendance/sundays', {
      ...H,
      body: { hall_id: hallId, service_date: SUNDAY, member_id: memberId, pre_service: true, service: true },
    });
    ok('ticking the same cell again updates it rather than duplicating',
      both.status === 200 && both.json?.service === true, `status ${both.status} ${JSON.stringify(both.json)}`);

    // Untick both → the row must be GONE, not stored as two falses.
    const clear = await req('PUT', '/api/attendance/sundays', {
      ...H,
      body: { hall_id: hallId, service_date: SUNDAY, member_id: memberId, pre_service: false, service: false },
    });
    ok('unticking both → 200', clear.status === 200, `status ${clear.status} ${JSON.stringify(clear.json)}`);
    const afterClear = await readRow();
    ok('a cleared cell leaves no row behind', afterClear.row && !afterClear.row.cells?.[SUNDAY],
      JSON.stringify(afterClear.row?.cells));

    // A date that is not a Sunday is refused in words.
    const badDay = await req('PUT', '/api/attendance/sundays', {
      ...H,
      body: { hall_id: hallId, service_date: MONDAY, member_id: memberId, pre_service: true, service: false },
    });
    ok('a date that is not a Sunday → 400', badDay.status === 400, `status ${badDay.status}`);
    ok('…and says so in words, not as a constraint name',
      /not a Sunday/i.test(badDay.json?.message || ''), String(badDay.json?.message));

    // Missing pieces are refused too, rather than writing a half row.
    const noDate = await req('PUT', '/api/attendance/sundays', {
      ...H, body: { hall_id: hallId, member_id: memberId, pre_service: true },
    });
    ok('a write with no service_date → 400', noDate.status === 400, `status ${noDate.status}`);

    // A sheet is always ONE congregation: an unnarrowed read is refused rather
    // than merging them. (With a single-congregation church there is nothing
    // ambiguous to refuse, so that case is skipped.)
    if ((halls || []).length > 1) {
      const merged = await req('GET', '/api/attendance/sundays?year=2030&month=1', H);
      ok('an all-congregations sheet read → 400', merged.status === 400, `status ${merged.status}`);
      ok('…and explains that a sheet is one congregation',
        /congregation/i.test(merged.json?.message || ''), String(merged.json?.message));
    } else {
      ok('all-congregations refusal (skipped: one congregation)', true);
    }
  } finally {
    // Deleting the member cascades to every sheet row it left behind.
    const del = await req('DELETE', `/api/members/${memberId}`, H);
    ok('the Sunday-sheet fixture member was deleted', del.status === 200, `status ${del.status}`);
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
  // …and only the four public fields — no id, no timestamps.
  ok('public church profile exposes nothing else',
    pub.json && Object.keys(pub.json).sort().join(',') === 'description,logo_url,name,short_name',
    Object.keys(pub.json ?? {}).join(','));

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

  // Church profile round-trip, restored below.
  const originalDescription = pub.json?.description ?? null;
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
      // The Sunday sheet writes with PUT — a verb the gate had never seen
      // before 0013, so prove it is refused for a read-only account too, and
      // that the refusal happens before anything is written.
      if (hallId) {
        ok('readonly GET sunday sheet → 200',
          (await req('GET', `/api/attendance/sundays?hall_id=${hallId}&year=2030&month=1`, RH)).status === 200);
        ok('readonly PUT sunday sheet → 403',
          (await req('PUT', '/api/attendance/sundays', {
            ...RH,
            body: { hall_id: hallId, service_date: '2030-01-06', member_id: freeMembers[0].id, pre_service: true, service: true },
          })).status === 403);
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
  // A refusal that silently wrote would be worse than a 200 — read it back.
  const after = await req('GET', '/api/church/modules', RH);
  ok(`${role} left the module catalog untouched`,
    (after.json || []).find((m) => m.key === 'discipleship')?.enabled === wasEnabled,
    JSON.stringify(after.json).slice(0, 120));
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

function finish() {
  console.log(`\n==== API E2E: ${pass} passed, ${fail} failed ====`);
  if (fail) { console.error('Failures:\n - ' + fails.join('\n - ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('API E2E crashed:', e); process.exit(1); });
