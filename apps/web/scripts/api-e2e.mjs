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

  // ---- Discipleship pair CRUD + public form -------------------------------
  const programs = (await req('GET', '/api/discipleship/programs', H)).json;
  const programId = programs?.[0]?.id;
  ok('has a discipleship program', !!programId);
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

async function roleMatrix(freeMembers, hallId) {
  if (freeMembers.length < 2) { ok('role-matrix (skipped: need 2 free members)', true); return; }
  const admin = await login(EMAIL, PASSWORD);
  const H = { cookie: admin };
  const made = [];
  const originalEmails = new Map();
  const provision = async (role, member) => {
    const email = `e2e-${role}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@grace.org`;
    if (!originalEmails.has(member.id)) originalEmails.set(member.id, member.email ?? null);
    await req('PATCH', `/api/members/${member.id}`, { ...H, body: { email } });
    const r = await req('POST', '/api/accounts', { ...H, body: { member_id: member.id, account_role: role, password: 'e2ePass2026' } });
    if (r.json?.id) made.push(r.json.id);
    return { email, cookie: await login(email, 'e2ePass2026') };
  };
  try {
    const ro = await provision('readonly', freeMembers[0]);
    ok('readonly can login', !!ro.cookie);
    if (ro.cookie) {
      const RH = { cookie: ro.cookie };
      ok('readonly GET members → 200', (await req('GET', '/api/members', RH)).status === 200);
      ok('readonly POST members → 403', (await req('POST', '/api/members', { ...RH, body: { full_name: 'x', church_role: 'member', status: 'active' } })).status === 403);
      ok('readonly GET accounts → 403', (await req('GET', '/api/accounts', RH)).status === 403);
    }
    const co = await provision('coworker', freeMembers[1]);
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
    }
  } finally {
    for (const id of made) await req('DELETE', `/api/accounts/${id}`, H);
    for (const [id, email] of originalEmails) await req('PATCH', `/api/members/${id}`, { ...H, body: { email } });
  }
}

function finish() {
  console.log(`\n==== API E2E: ${pass} passed, ${fail} failed ====`);
  if (fail) { console.error('Failures:\n - ' + fails.join('\n - ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('API E2E crashed:', e); process.exit(1); });
