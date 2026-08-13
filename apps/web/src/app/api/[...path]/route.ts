import { getDb, HttpError, json, unwrap, unwrapWrite } from '@/lib/server/db';
import {
  clearCookie,
  generateRandomPassword,
  getSession,
  hashPassword,
  sessionCookie,
  signSession,
  verifyPassword,
} from '@/lib/server/auth';
import { addChurchDays, churchInstant, churchParts, isSundayDate } from '@/lib/time';
// Pure, and safe in the Worker: `lib/dashboard` and `lib/labels` pull only
// `@tog/shared` and `lib/time` at runtime — every other import in them is a
// type, erased at compile.
import { recentSundays } from '@/lib/dashboard';
import { groupHealthStatus } from '@/lib/labels';
import {
  meetingColumnKey,
  parseColumnKey,
  sheetColumns,
  sundayColumnKey,
} from '@/lib/sheet';
import type { SheetCell, SheetMeeting } from '@/lib/types';
import {
  IMPORT_COLUMNS,
  looksLikeEmail,
  looksLikePhone,
  MAX_IMPORT_ROWS,
  matchRegistrant,
  parseImportDate,
  parseList,
  planImport,
  tidy,
  type ImportContext,
  type ImportIssue,
  type ImportRow,
  type PlannedRow,
} from '@/lib/members-import';
import {
  AccountRole,
  AccountStatus,
  ChurchRole,
  Gender,
  GroupPosition,
  isOptionalModule,
  MemberStatus,
  isTrainingCategory,
  isTrainingKind,
  isUsableBrand,
  isUsableRail,
  LANGUAGES,
  MIN_BRAND_CONTRAST,
  MIN_RAIL_CONTRAST,
  moduleForApiPath,
  normalizeHexColor,
  normalizeLanguage,
  OPTIONAL_MODULES,
  themePreset,
  TrainingKind,
} from '@tog/shared';

/**
 * The whole REST API, ported from the NestJS app into a single Cloudflare
 * Workers-compatible route handler. Paths and response shapes match the
 * original `/api/*` contract 1:1 so the frontend is unchanged.
 */

type Ctx = { params: Promise<{ path: string[] }> };

// Every request is per-user (session cookie) and hits Supabase — never cache or
// statically optimize any method, or the auth gate would be skipped on GET.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

/**
 * 推荐人 is a foreign key from `members` back to `members` — a genuine
 * self-join, and PostgREST's embed syntax turns out not to be reliable for
 * one against this project's live schema cache: the column hint
 * (`referrer:members!referred_by(...)`) silently resolves the REVERSE
 * relationship (every member THIS one referred, not who referred them —
 * confirmed live, it returns `[]` for a row nobody else refers to), and the
 * constraint-name hint (`!members_referred_by_fkey`) answers PGRST200,
 * "no matches found in the schema cache", even though the constraint exists
 * (confirmed via `pg_constraint`) — a stale-cache class of problem no amount
 * of query-syntax tweaking fixes from the client side. `referred_by` is
 * therefore resolved by a plain, explicit follow-up query instead
 * (`withReferrers` below) rather than an embed — slower by one round trip,
 * correct regardless of what the schema cache currently believes.
 */
const MEMBER_SELECT = '*, group:groups(id,name), hall:halls(id,name)';

/**
 * Resolves `referred_by` → `referrer` for a batch of member rows with ONE
 * extra query (not one per row), since this is also used by the members
 * LIST. Rows with no referrer, or whose referrer no longer exists, get
 * `referrer: null` — the ordinary case every reader already guards (G6).
 */
async function withReferrers<T extends { referred_by?: string | null }>(
  db: ReturnType<typeof getDb>,
  rows: T[],
): Promise<Array<T & { referrer: { id: string; full_name: string; english_name: string | null; hall_id: string } | null }>> {
  const ids = Array.from(new Set(rows.map((r) => r.referred_by).filter((id): id is string => !!id)));
  const referrers = ids.length
    ? unwrap<Array<{ id: string; full_name: string; english_name: string | null; hall_id: string }>>(
        await db.from('members').select('id,full_name,english_name,hall_id').in('id', ids),
      )
    : [];
  const byId = new Map(referrers.map((r) => [r.id, r]));
  return rows.map((r) => ({ ...r, referrer: r.referred_by ? (byId.get(r.referred_by) ?? null) : null }));
}
/**
 * A person, everywhere a name is only shown: BOTH names (0018) and the hall
 * that decides which of them is drawn (0028).
 *
 * All three travel together in every brief because `<MemberName />` needs all
 * three to draw one person: the pair is still the identity and still what a
 * search matches, while the congregation picks which half is on screen. A
 * payload carrying only `full_name` would render half a person; one carrying
 * both names but no `hall_id` would quietly fall back to the Chinese name on
 * that screen alone, so the same person would read differently from page to
 * page — which is exactly what one shared component exists to prevent.
 */
const MEMBER_BRIEF = 'id,full_name,english_name,hall_id,church_role,group_position';
const ACCOUNT_MEMBER_BRIEF = 'id,full_name,english_name,hall_id,email,church_role,group_position';
const PAIR_SELECT =
  `*, mentor:members!discipleship_pairs_mentor_id_fkey(${MEMBER_BRIEF}), trainee:members!discipleship_pairs_trainee_id_fkey(${MEMBER_BRIEF})`;
/** Same shape, but an !inner mentor join so a hall filter can be pushed down. */
const PAIR_SELECT_SCOPED =
  `*, mentor:members!discipleship_pairs_mentor_id_fkey!inner(${MEMBER_BRIEF}), trainee:members!discipleship_pairs_trainee_id_fkey(${MEMBER_BRIEF})`;
const ACCOUNT_SELECT = `*, member:members(${ACCOUNT_MEMBER_BRIEF}), hall:halls(id,name)`;
/**
 * A 幸福小组, with its congregation, its leader (nullable) and its term's own
 * length — every list/detail read below shares this shape, so a group never
 * comes back missing the piece the page needs (rule G6: guard every join).
 */
const HAPPINESS_GROUP_SELECT =
  '*, hall:halls(id,name), leader:members(id,full_name,english_name,hall_id), term:happiness_terms(id,term_no,name,weeks)';

/**
 * One value inside a PostgREST `or(…)` filter, quoted.
 *
 * `or` takes a comma-separated list in a single string, so an unquoted value
 * that contains a comma or a parenthesis does not search for those characters —
 * it adds conditions of its own. Anything that comes from a REQUEST goes
 * through here (a search term does; a uuid this file just read does not), with
 * `"` and `\` escaped so the quoting itself cannot be closed early.
 */
function orValue(raw: string): string {
  return `"${raw.replace(/["\\]/g, '\\$&')}"`;
}

async function dispatch(method: string, req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  const p = path ?? [];
  const db = getDb();
  const url = new URL(req.url);
  const q = url.searchParams;
  const body = async () => {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  };

  const [r0, r1, r2, r3, r4, r5] = p;

  // ---- Auth + access control ------------------------------------------------
  if (r0 === 'auth') return authRoute(method, req, p, db);

  // Which build is serving. Deliberately public and ahead of the session gate:
  // the post-deploy suite polls it BEFORE logging in, to be sure it is testing
  // the version just shipped rather than the one Cloudflare is still serving.
  // (Probing "does endpoint X exist" instead stops working the moment X ships
  // — that is exactly how a stale Worker once failed a whole api-e2e run.)
  // The value is a commit sha of a public repo, so there is nothing to leak.
  if (r0 === 'version' && !r1 && method === 'GET') {
    return json({ build: process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev' });
  }

  // Public-by-design, no session: the mentor daily form (/d/<token>), the
  // training self-enrollment form (/enroll/<id>), the member self-registration
  // form (/join), and the church's own name/description/logo — which the login
  // card and all of those forms have to render before anyone has signed in,
  // and none of which is sensitive. Each is a narrow, specific handler below;
  // nothing else under these prefixes is reachable unauthed, and /church is
  // public for GET ONLY — changing the record stays super_admin (see the role
  // gate below). `/members/register` is likewise the ONLY public member path:
  // it is two methods on one exact path, never a prefix, so nothing else under
  // /members is opened by it.
  const isPublicForm =
    (r0 === 'discipleship' && r1 === 'form') ||
    (r0 === 'trainings' && r1 === 'enroll') ||
    (r0 === 'members' && r1 === 'register' && !r2 && (method === 'GET' || method === 'POST')) ||
    (r0 === 'church' && !r1 && method === 'GET');

  // Hall scope for this request. `null` = 全堂权限 (sees and may write every
  // hall). A non-null value pins the account to one hall: reads are filtered
  // to it and writes are forced onto it, server-side — the client never gets
  // to choose (rule G2: the server is authoritative).
  let hallScope: string | null = null;
  // Group scope — meaningful only for a `group_leader` session (migration
  // 0026), the same idea as `hallScope` but one dimension narrower: a
  // group_leader sees and may write only its OWN group, never the whole hall
  // its account happens to inherit. Read straight off the session (kept in
  // sync by `syncGroupLeaderAccount`), never re-derived from the member.
  let groupScope: string | null = null;
  // The account's permission role, for the handful of paths whose rule is more
  // than "may this role write at all" — a bulk import is one (see /members/
  // import). Null on the public forms, which have no account behind them.
  let sessionRole: string | null = null;
  if (!isPublicForm) {
    const session = await getSession(req);
    if (!session) throw new HttpError(401, 'Not signed in');
    hallScope = session.hall ?? null;
    groupScope = session.group ?? null;
    sessionRole = session.role;
    // Login accounts (emails, roles, sign-in history) are super_admin-only —
    // for reads as well as writes (rule G2), so the account list never leaks.
    if (r0 === 'accounts' && session.role !== 'super_admin')
      throw new HttpError(403, 'Only a super admin may manage login accounts');
    // The church record and the module catalog are readable by any signed-in
    // account (the shell renders the name and needs to know which nav entries
    // exist), but only a super admin may CHANGE either — the same split the
    // 教会设置 page renders (rule G2).
    if (r0 === 'church' && method !== 'GET' && session.role !== 'super_admin')
      throw new HttpError(403, 'Only a super admin may change church settings');
    if (method !== 'GET') {
      // Permission matrix enforcement.
      if (session.role === 'readonly') throw new HttpError(403, 'A read-only account cannot make changes');
      if (method === 'DELETE' && !['super_admin', 'admin'].includes(session.role))
        throw new HttpError(403, 'This role may not delete records');
    }
  }

  // ---- Group scope path allowlist (group_leader only) -----------------------
  // A FOURTH dimension of access control, beside role/hall/module (rule G2):
  // a group_leader's login is auto-provisioned for exactly one group
  // (`syncGroupLeaderAccount`) and has no business anywhere outside it —
  // narrower than every other role's hall-wide reach, on purpose. Rather than
  // threading a scoping check through every handler below (error-prone, hard
  // to audit), ONE early gate — the same shape as the module-enablement gate
  // above — refuses any path this role has no reason to touch at all; the
  // finer per-row group check (mirroring `hallFilter`'s own "session always
  // wins" precedence) happens inside the members/groups/attendance handlers
  // themselves, below.
  if (sessionRole === AccountRole.GroupLeader) {
    // `church` is included even though it owns nothing group-scoped: G2
    // already guarantees `GET /church` (name/logo/theme) is readable by any
    // signed-in account regardless of role, since the shell paints itself
    // from it on every load — excluding it here would not deny anything a
    // group_leader shouldn't see, it would just silently break their own
    // sidebar's branding. Writing to `/church` stays gated to super_admin by
    // its own existing role check, unaffected by this allowlist.
    const GROUP_LEADER_PREFIXES = ['members', 'groups', 'attendance', 'auth', 'church'];
    if (!GROUP_LEADER_PREFIXES.includes(r0 ?? ''))
      throw new HttpError(403, 'A group leader account may not reach this part of the app');
    // `app_users.group_id` is `on delete set null` — a group leader whose
    // group was deleted has nothing left to be scoped to. Refused outright
    // rather than silently falling through to "no narrowing", which is what a
    // null `groupScope` would otherwise read as everywhere below (the same
    // reasoning `hallScope` never needs, because a member's hall never goes
    // away from under it). `church` is exempt for the same branding reason
    // as above — a group leader stuck between reassignments should not also
    // lose the sidebar's own colours.
    if (!groupScope && r0 !== 'auth' && r0 !== 'church')
      throw new HttpError(403, 'This account is not linked to a group — ask a church admin to reassign it');
  }

  // ---- Module enablement ----------------------------------------------------
  // The third dimension of access control, beside role and hall: a church may
  // not run every module (四十天守望 is an add-on). Hiding the nav entry is
  // only the UX half — a path owned by a module this church has switched off
  // is refused HERE, so a bookmark, a stale tab or a hand-rolled request gets
  // nothing either (rule G2).
  //
  // Deliberately outside the session block above, so it covers the PUBLIC
  // mentor form too: switching the module off has to close its links as well,
  // or a mentor's daily form would outlive the feature it belongs to. It is
  // below `authRoute` (which returns earlier) and `moduleForApiPath` answers
  // null for /church, /auth and every core path, so signing in, reading the
  // church record and reaching the catalog can never be gated by it.
  //
  // 404 rather than 403 on purpose: a disabled module is not "you may not" —
  // no role, hall or session can reach it, because for this church the
  // feature does not exist. That is what "not found" means, it matches the
  // fall-through at the bottom of dispatch(), and it keeps a public token URL
  // from distinguishing "wrong token" from "module switched off".
  const gatedModule = moduleForApiPath(p);
  if (gatedModule && !(await moduleEnabled(db, gatedModule)))
    throw new HttpError(404, `The ${gatedModule} module is not enabled for this church`);

  /**
   * The hall this request's list reads are narrowed to — `null` = 全部堂会
   * (no narrowing). Two things can narrow a view, and the order matters:
   *
   *  1. The session's own hall (`hallScope`). It ALWAYS wins, so a hall-pinned
   *     account can never widen its view by sending a different `hall_id`.
   *  2. Only when the session has full access, the `?hall_id=` the congregation
   *     switcher appends to every request (`withHallParam` in `lib/hall.tsx`).
   *
   * Every hall-scoped list GET reads this one value rather than re-deriving the
   * precedence, so a new list can't accidentally trust the client (rule G2).
   */
  const hallFilter: string | null = hallScope ?? (q.get('hall_id') || null);

  /**
   * The group-scope analogue of `hallFilter`, same precedence rule: a
   * group_leader's own group ALWAYS wins over whatever `?group_id=` a
   * request carries, so it can never widen its view by sending a different
   * one. For every other role this is simply the client's own `?group_id=`
   * (or none), unchanged from before this feature existed.
   */
  const groupFilter: string | null = groupScope ?? (q.get('group_id') || null);

  /**
   * Body for a hall-scoped INSERT. A single-hall account always writes into
   * its own hall (any hall_id the client sent is discarded); a full-access
   * account may pass one explicitly, and for trainings/events may leave it
   * null to mean 全堂开放.
   */
  const withHall = (dto: Record<string, unknown>): Record<string, unknown> =>
    hallScope ? { ...dto, hall_id: hallScope } : dto;

  /**
   * Body for a group-scoped INSERT — the group-scope analogue of `withHall`:
   * a group_leader always creates members into its OWN group (any group_id
   * the client sent is discarded server-side, rule G2), the same "session
   * always wins" reasoning `withHall` already applies to the hall.
   */
  const withGroupScope = (dto: Record<string, unknown>): Record<string, unknown> =>
    groupScope ? { ...dto, group_id: groupScope } : dto;

  /** Reject an update that would move a record out of the caller's hall. */
  const assertHallWritable = (dto: Record<string, unknown>) => {
    if (hallScope && 'hall_id' in dto && dto.hall_id !== hallScope)
      throw new HttpError(403, 'Cannot move this record to another congregation');
  };

  /**
   * Guard an existing row before update/delete: a single-hall account may only
   * touch its own hall's records (and, for trainings/events, the all-hall ones
   * are read-only to it — those belong to whoever has full access).
   */
  const assertOwnsRow = async (table: string, id: string) => {
    if (!hallScope) return;
    const row = unwrap<{ hall_id: string | null }>(
      await db.from(table).select('hall_id').eq('id', id).single(),
    );
    if (row.hall_id !== hallScope) throw new HttpError(403, 'No permission to modify another congregation\u2019s records');
  };

  /**
   * Guard an id-addressed READ the same way `assertOwnsRow` guards a write:
   * a single-hall account may only open its own hall's records. "GET is
   * harmless" is not a defence (rule G2) \u2014 the list queries above already hide
   * other halls, so a detail route must not hand the same row back by id.
   * A null hall means \u5168\u5802\u5f00\u653e (trainings / events) and stays visible to
   * everyone, exactly as the list queries expose it.
   */
  const assertRowReadable = async (table: string, id: string) => {
    if (!hallScope) return;
    const row = unwrap<{ hall_id: string | null }>(
      await db.from(table).select('hall_id').eq('id', id).single(),
    );
    if (row.hall_id !== null && row.hall_id !== hallScope)
      throw new HttpError(403, 'No permission to view another congregation\u2019s records');
  };

  /**
   * For a group_leader session, the only `groups` row id it may ever address \u2014
   * the group-scope analogue of `assertOwnsRow`/`assertRowReadable`, called
   * ALONGSIDE them (never instead of \u2014 the hall check still applies too)
   * wherever a `groups` row is read or written by id.
   */
  const assertGroupScope = (id: string) => {
    if (groupScope && id !== groupScope)
      throw new HttpError(403, 'No permission to access another group\u2019s records');
  };

  /**
   * The same idea for a `members` row read: a group_leader may only open a
   * member who currently belongs to its own group. Reads are guarded here
   * because "GET is harmless" is not a defence (rule G2) \u2014 the list query
   * already narrows by `groupFilter`, so a detail route must not hand the
   * same row back by id regardless.
   */
  const assertMemberGroupReadable = async (id: string) => {
    if (!groupScope) return;
    const row = unwrap<{ group_id: string | null }>(
      await db.from('members').select('group_id').eq('id', id).single(),
    );
    if (row.group_id !== groupScope)
      throw new HttpError(403, 'No permission to view another group\u2019s records');
  };

  /**
   * Reads a member's group state before a PATCH, and \u2014 for a group_leader
   * session \u2014 asserts the write stays inside its own group. Unlike hall
   * (which a member's `assertHallWritable` refuses to ever change),
   * moving between groups is the ORDINARY shape of this write \u2014 that is what
   * "add a member to my roster" and "remove one" both are \u2014 so the rule is
   * nuanced rather than "must already match": a group_leader may touch a
   * member whose CURRENT group is its own, or whose write is ADMITTING them
   * into it, and the destination it names (if it names one) must be its own
   * group or null (leaving) \u2014 never anywhere else, which is what stops a
   * group_leader from re-homing somebody into a group that isn't theirs.
   *
   * Runs for every PATCH /members/:id regardless of role \u2014 the row it reads
   * is reused as `previousPosition`/`previousGroupId` for
   * `syncGroupLeaderAccount`, so this replaces what would otherwise be a
   * second "before" read rather than adding one.
   */
  const beforeMemberWrite = async (id: string, dto: Record<string, unknown>) => {
    const row = unwrap<{ group_id: string | null; group_position: string | null }>(
      await db.from('members').select('group_id,group_position').eq('id', id).single(),
    );
    if (groupScope) {
      const current = row.group_id;
      const next = 'group_id' in dto ? (dto.group_id as string | null) : current;
      if (current !== groupScope && next !== groupScope)
        throw new HttpError(403, 'No permission to modify another group\u2019s records');
      if (next !== null && next !== groupScope)
        throw new HttpError(403, 'A group leader may only add members into their own group');
    }
    return row;
  };

  /**
   * Same guard for a \u5b88\u671b\u914d\u5bf9: a pair carries no hall column of its own \u2014 its
   * hall is its MENTOR's hall (which is what `discipleship_pair_summary`
   * exposes as `hall_id`). Used for read and write alike; `members.hall_id` is
   * NOT NULL, so there is no \u5168\u5802 pair to make an exception for.
   */
  const assertPairInHall = async (pairId: string) => {
    if (!hallScope) return;
    const row = unwrap<{ mentor: { hall_id: string | null } | null }>(
      await db
        .from('discipleship_pairs')
        .select('mentor:members!discipleship_pairs_mentor_id_fkey(hall_id)')
        .eq('id', pairId)
        .single(),
    );
    if ((row.mentor?.hall_id ?? null) !== hallScope)
      throw new HttpError(403, 'No permission to view another congregation\u2019s records');
  };

  // ---- Halls (堂会) ----------------------------------------------------------
  // Read-only for now: the three halls are seeded by migration 0008. Every
  // logged-in user may list them (needed to render hall labels); a single-hall
  // account only ever sees its own.
  // Deliberately `hallScope`, never `hallFilter`: this list IS the congregation
  // switcher's options. Narrowing it by the switcher's own selection would
  // leave a single option and strand the user with no way back to 全部堂会.
  // ---- Dashboard --------------------------------------------------------
  // ONE aggregate read for the home page. The page used to pull the whole
  // roster and every event into the browser and count there; adding attendance
  // that way would have meant either a request per Sunday or shipping the
  // attendance table down. Everything here is counted server-side and only the
  // numbers the page draws come back — which also means a `group_leader` gets
  // the same page scoped to its own group for free, rather than the special
  // casing the old page needed to hide a section it could not read.
  if (r0 === 'dashboard' && !r1 && method === 'GET') {
    return json(await dashboard(db, hallFilter, groupFilter, Number(q.get('sundays')) || 8));
  }

  if (r0 === 'halls' && !r1 && method === 'GET') {
    // `*` rather than a column list, deliberately: `name_display` (0028) is
    // read from here, and naming it explicitly would make this endpoint — which
    // the whole shell waits on — a 500 on any deployment whose database has not
    // had that migration applied yet. With `*` the column simply isn't in the
    // payload until it exists, and a hall that doesn't say reads by the Chinese
    // name, which is what every congregation did before 0028. Nothing on this
    // table is sensitive.
    let query = db.from('halls').select('*').order('sort_order');
    if (hallScope) query = query.eq('id', hallScope);
    return json(unwrap(await query));
  }

  // ---- Church record & module catalog ---------------------------------------
  // The church's identity (name / description / logo) and which optional
  // modules it runs. `GET /church` is public — see `isPublicForm` above; every
  // write here is super_admin-only, enforced in the gate rather than repeated
  // per handler.
  if (r0 === 'church') {
    if (!r1) {
      if (method === 'GET') {
        // Deliberately only the public fields, not the whole row: this one
        // answers without a session. The theme is among them because the
        // login card and both public forms are painted in the church's
        // colours before anyone signs in — and a colour is not a secret.
        const c = await churchRow(db);
        return json({
          name: c.name,
          short_name: c.short_name,
          description: c.description,
          logo_url: c.logo_url,
          theme_preset: c.theme_preset,
          theme_rail: c.theme_rail,
          theme_brand: c.theme_brand,
        });
      }
      if (method === 'PATCH') {
        const c = await churchRow(db);
        return json(
          unwrap(
            await db
              .from('church')
              .update(churchWrite(await body()))
              .eq('id', c.id)
              .select(CHURCH_SELECT)
              .single(),
          ),
        );
      }
    } else if (r1 === 'logo' && method === 'POST') {
      // Same mechanism as a member's photo (`/members/:id/avatar`): the file
      // goes through this service-role handler into a public bucket and the
      // resulting URL is stored on the row.
      const c = await churchRow(db);
      const form = await req.formData();
      const file = checkedFile(form.get('file'), IMAGE_UPLOAD);
      const url = await storeFile(db, 'branding', `${c.id}/${Date.now()}.${fileExt(file, 'png')}`, file);
      return json(
        unwrap(
          await db
            .from('church')
            .update({ logo_url: url })
            .eq('id', c.id)
            .select(CHURCH_SELECT)
            .single(),
        ),
      );
    } else if (r1 === 'modules') {
      // Every signed-in account reads this — the nav has to know which entries
      // exist before it can render itself.
      if (!r2 && method === 'GET') return json(await moduleStates(db));
      if (r2 && !r3 && method === 'PATCH') {
        // A key that is not in the code registry is rejected outright rather
        // than inserted: `church_modules` must never hold a row for a feature
        // this build does not ship.
        if (!isOptionalModule(r2)) throw new HttpError(400, `Unknown module: ${r2}`);
        const enabled = (await body()).enabled;
        if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
        const c = await churchRow(db);
        const row = unwrap<{ module: string; enabled: boolean }>(
          await db
            .from('church_modules')
            .upsert({ church_id: c.id, module: r2, enabled }, { onConflict: 'church_id,module' })
            .select('module,enabled')
            .single(),
        );
        return json({ key: row.module, enabled: row.enabled });
      }
    }
  }

  // ---- Members --------------------------------------------------------------
  if (r0 === 'members') {
    // The two NAMED sub-paths come first, and each ends in a return or a 404,
    // so neither word can ever reach the id-addressed branches below: a
    // `DELETE /members/import` must be "no such route", not a delete addressed
    // by the word "import".
    //
    // /members/register — PUBLIC self-registration (no session; see the
    // isPublicForm gate above). The church hands out one link and people fill
    // in their own details instead of somebody typing them off a paper slip.
    //
    // What this path CAN do, deliberately and exhaustively: add one member
    // carrying almost everything the staff-facing add-member form does — a
    // name pair, a phone, an email, an address, a gender, a birthday, a
    // 推荐人, a life group, a 服侍岗位 list, notes and a photo — or, when a
    // match is found (see `matchRegistrant`), update those same fields on
    // that one row. What it CANNOT do: set a church role or a group POSITION
    // — those are things the church hands out, never something a visitor
    // claims for themselves on the way in; that split is the whole reason
    // `church_role` and `group_position` stay off REGISTER_FIELDS while
    // `referred_by`/`group_id`/`serving_roles`/`notes` are on it now. The
    // fields are read by name from an allow-list, so a body carrying
    // `church_role: 'pastor'` or `group_position: 'leader'` has it ignored
    // rather than obeyed; it can touch nobody but the single person whose
    // name was typed; and it reads nothing back — the answer is one word,
    // the same shape either way, and never a member's stored data.
    if (r1 === 'register' && !r2) {
      if (method === 'GET') {
        // The form's own bootstrap. A public page cannot call
        // /halls·/groups·/members (those need a session), and it must offer
        // the real congregations/groups/people rather than free-text boxes
        // nobody could match later. Only names travel here — never phone,
        // email, address or birthday — the minimum a 推荐人 Combobox and a
        // 小组 select need to work, and no more.
        return json({
          halls: unwrap(await db.from('halls').select('id,name').order('sort_order')),
          groups: unwrap(await db.from('groups').select('id,name,hall_id').order('name')),
          members: unwrap(await db.from('members').select('id,full_name,english_name').order('full_name')),
        });
      }
      if (method === 'POST') return json(await registerMember(db, req));
      throw new HttpError(404, `No route for ${method} /api/${p.join('/')}`);
    }
    // /members/import — a spreadsheet of members, matched on the name pair.
    if (r1 === 'import' && !r2) {
      if (method !== 'POST') throw new HttpError(404, `No route for ${method} /api/${p.join('/')}`);
      // One request that creates and overwrites people in bulk is a bigger
      // thing than editing one member, so it is held to the same bar as a
      // delete: super_admin / admin only. `readonly` is already refused by the
      // gate above; this is what keeps a coworker's mistyped file from
      // rewriting the whole roll (rule G2 — the button is hidden for the same
      // roles, but the server is what decides).
      if (!['super_admin', 'admin'].includes(sessionRole ?? ''))
        throw new HttpError(403, 'Only an administrator may import members');
      const dto = await body();
      const rows = Array.isArray(dto.rows) ? dto.rows : null;
      if (!rows || rows.length === 0)
        throw new HttpError(400, 'rows must be a non-empty list of member rows');
      if (rows.length > MAX_IMPORT_ROWS)
        throw new HttpError(
          400,
          `An import may carry at most ${MAX_IMPORT_ROWS} rows — split the file and import it in parts`,
        );
      const ctx = await importContext(db, hallScope, dto.hall_id);
      // The client previewed this same plan in the browser; it is computed
      // again HERE, against the database as it is right now, because that
      // preview is a courtesy and this is the decision (rule G2).
      const plan = planImport(rows.map(incomingImportRow), ctx);
      return json(await applyImport(db, plan, ctx));
    }
    if (!r1) {
      if (method === 'GET') {
        let query = db
          .from('members')
          .select(MEMBER_SELECT)
          .order('full_name', { ascending: true });
        if (hallFilter) query = query.eq('hall_id', hallFilter);
        if (q.get('church_role')) query = query.eq('church_role', q.get('church_role'));
        if (q.get('group_position')) query = query.eq('group_position', q.get('group_position'));
        if (groupFilter) query = query.eq('group_id', groupFilter);
        // Either name finds a person (0018): somebody who is filed as 陈约翰
        // is looked for as "John" just as often. The term is quoted, so a
        // comma or a parenthesis in it stays part of the search rather than
        // becoming another PostgREST filter.
        const term = q.get('q');
        if (term)
          query = query.or(
            `full_name.ilike.${orValue(`%${term}%`)},english_name.ilike.${orValue(`%${term}%`)}`,
          );
        return json(await withReferrers(db, unwrap<Array<{ referred_by: string | null }>>(await query)));
      }
      if (method === 'POST') {
        const created = unwrap<
          Record<string, unknown> & { id: string; group_id: string | null; group_position: string | null }
        >(
          await db
            .from('members')
            .insert(withGroupScope(withHall(await body())))
            .select()
            .single(),
        );
        const event = await syncGroupLeaderAccount(db, {
          memberId: created.id,
          previousPosition: null,
          previousGroupId: null,
          newPosition: created.group_position,
          groupId: created.group_id,
        });
        return json({ ...created, leader_account_event: leaderEventForClient(event) });
      }
    } else if (r2 === 'trainings' && method === 'GET') {
      await assertRowReadable('members', r1);
      await assertMemberGroupReadable(r1);
      return json(
        unwrap(
          await db
            .from('training_enrollments')
            .select('*, training:trainings(id,name,total_sessions)')
            .eq('member_id', r1)
            .order('enrolled_at', { ascending: false }),
        ),
      );
    } else if (r2 === 'avatar' && method === 'POST') {
      const form = await req.formData();
      const file = checkedFile(form.get('file'), IMAGE_UPLOAD);
      const url = await storeFile(db, 'avatars', `${r1}/${Date.now()}.${fileExt(file, 'jpg')}`, file);
      return json(
        unwrap(
          await db
            .from('members')
            .update({ avatar_url: url })
            .eq('id', r1)
            .select()
            .single(),
        ),
      );
    } else if (!r2) {
      if (method === 'GET') {
        await assertRowReadable('members', r1);
        await assertMemberGroupReadable(r1);
        const row = unwrap<{ referred_by: string | null }>(
          await db.from('members').select(MEMBER_SELECT).eq('id', r1).single(),
        );
        const [withReferrer] = await withReferrers(db, [row]);
        return json(withReferrer);
      }
      if (method === 'PATCH') {
        const dto = await body();
        assertHallWritable(dto);
        await assertOwnsRow('members', r1);
        // Reads the row's group state before the write and, for a
        // group_leader session, asserts the write stays inside its own
        // group (see the function's own comment for the exact rule) —
        // `before` is then reused as the sync hook's `previousPosition`/
        // `previousGroupId` rather than reading the row a second time.
        const before = await beforeMemberWrite(r1, dto);
        const updated = unwrap<
          Record<string, unknown> & { group_id: string | null; group_position: string | null }
        >(await db.from('members').update(dto).eq('id', r1).select().single());
        const event = await syncGroupLeaderAccount(db, {
          memberId: r1,
          previousPosition: before.group_position,
          previousGroupId: before.group_id,
          newPosition: updated.group_position,
          groupId: updated.group_id,
        });
        return json({ ...updated, leader_account_event: leaderEventForClient(event) });
      }
      if (method === 'DELETE') {
        await assertOwnsRow('members', r1);
        unwrap(await db.from('members').delete().eq('id', r1).select().single());
        return json({ id: r1 });
      }
    }
  }

  /**
   * A group meeting's hall is its GROUP's hall — `group_meetings` carries no
   * hall column of its own, the same shape a 守望配对 has. Used for the roll
   * call and for deleting a meeting, so a hall-pinned account cannot reach
   * another congregation's group through a meeting id (rule G2).
   *
   * It resolves the group and then defers to `assertOwnsRow`, rather than
   * re-rolling the comparison off an embedded join: the hall check stays in
   * one place, and there is no ambiguous-relationship shape to get wrong.
   */
  const assertGroupMeetingWritable = async (meetingId: string) => {
    if (!hallScope && !groupScope) return;
    const row = unwrap<{ group_id: string }>(
      await db.from('group_meetings').select('group_id').eq('id', meetingId).single(),
    );
    await assertOwnsRow('groups', row.group_id);
    assertGroupScope(row.group_id);
  };

  // ---- Groups ---------------------------------------------------------------
  if (r0 === 'groups') {
    // /groups/meetings/:meetingId ...
    if (r1 === 'meetings' && r2) {
      // The life-group roll call. `records` is a LIST by design — one tick is
      // a list of one, and the column header's 全员到齐 shortcut sends the
      // whole roster in the same call, so the two can never diverge (the same
      // reasoning as `member_ids` on the services sheet above).
      if (r3 === 'attendance' && method === 'POST') {
        await assertGroupMeetingWritable(r2);
        const dto = await body();
        const list = Array.isArray(dto.records) ? (dto.records as Array<Record<string, unknown>>) : null;
        if (!list || list.length === 0)
          throw new HttpError(400, 'records must be a non-empty list of { member_id, status }');
        if (list.length > 1000)
          throw new HttpError(400, 'Too many records in one write — 1000 at most');
        const records = list.map((r) => {
          const memberId = String(r.member_id ?? '');
          if (!memberId) throw new HttpError(400, 'every record needs a member_id');
          return { meeting_id: r2, member_id: memberId, status: r.status ?? 'present' };
        });
        // `assertGroupMeetingWritable` above only confirms the MEETING
        // belongs to this group_leader's own group — the member ids inside
        // `records` are addressed directly, so a hand-crafted request could
        // otherwise write attendance for somebody outside it. Same guard as
        // the services sheet's own member-addressed write, just for this
        // group's meeting instead.
        if (groupScope) {
          const memberIds = records.map((r) => r.member_id);
          const members = unwrap<Array<{ id: string; group_id: string | null }>>(
            await db.from('members').select('id,group_id').in('id', memberIds),
          );
          if (members.some((m) => m.group_id !== groupScope))
            throw new HttpError(403, 'No permission to modify another group’s records');
        }
        return json(
          unwrap(
            await db
              .from('group_attendance')
              .upsert(records, { onConflict: 'meeting_id,member_id' })
              .select(),
          ),
        );
      }
      if (!r3 && method === 'DELETE') {
        await assertGroupMeetingWritable(r2);
        unwrap(await db.from('group_meetings').delete().eq('id', r2).select().single());
        return json({ id: r2 });
      }
    } else if (!r1) {
      if (method === 'GET') {
        let query = db.from('groups').select('*, hall:halls(id,name)').order('name');
        if (hallFilter) query = query.eq('hall_id', hallFilter);
        // A group_leader's own group is the only row it may ever see in this
        // list — forced, exactly like `withGroupScope` forces an insert,
        // never merely offered as an optional narrowing.
        if (groupScope) query = query.eq('id', groupScope);
        return json(unwrap(await query));
      }
      if (method === 'POST') {
        // A group_leader has exactly one group by definition — creating a
        // second one is not a narrower version of that group, it is a new
        // one nothing scopes it to. Refused outright rather than silently
        // widening what "its own group" means.
        if (groupScope) throw new HttpError(403, 'No permission to create a group');
        return json(unwrap(await db.from('groups').insert(withHall(await body())).select().single()));
      }
    } else if (r2 === 'attendance' && method === 'GET') {
      await assertRowReadable('groups', r1);
      assertGroupScope(r1);
      return json(await groupAttendance(db, r1));
    } else if (r2 === 'meetings' && method === 'POST') {
      // The roll call creates the week's meeting row lazily, so this is a
      // write into the group and follows the same hall rule as editing it.
      await assertOwnsRow('groups', r1);
      assertGroupScope(r1);
      const dto = await body();
      return json(
        unwrap(
          await db
            .from('group_meetings')
            .insert({ group_id: r1, meeting_date: dto.meeting_date })
            .select()
            .single(),
        ),
      );
    } else if (!r2) {
      if (method === 'GET') {
        await assertRowReadable('groups', r1);
        assertGroupScope(r1);
        const group = unwrap<Record<string, unknown>>(
          await db.from('groups').select('*, hall:halls(id,name)').eq('id', r1).single(),
        );
        const members = unwrap(
          await db
            .from('members')
            .select('id,full_name,english_name,hall_id,group_position,status')
            .eq('group_id', r1)
            .order('full_name'),
        );
        return json({ ...group, members });
      }
      if (method === 'PATCH') {
        const dto = await body();
        assertHallWritable(dto);
        await assertOwnsRow('groups', r1);
        assertGroupScope(r1);
        return json(unwrap(await db.from('groups').update(dto).eq('id', r1).select().single()));
      }
      if (method === 'DELETE') {
        await assertOwnsRow('groups', r1);
        unwrap(await db.from('groups').delete().eq('id', r1).select().single());
        return json({ id: r1 });
      }
    }
  }

  // ---- 聚会点名 (the roll-call sheet) ----------------------------------------
  // ONE grid per month: that month's Sundays (`sunday_attendance`, migration
  // 0013) and the meetings someone genuinely added for it (`events` /
  // `event_attendance`), in date order. Nothing creates a Sunday — the
  // calendar already has them — and a meeting's own column appears the moment
  // the meeting does.
  //
  // The two tables are this handler's business, never the page's: the read
  // hands out an opaque `key` per column and the write resolves it here
  // (`parseColumnKey`), so a tick lands in the right table without the client
  // knowing there are two.
  if (r0 === 'attendance' && r1 === 'sheet' && !r2) {
    if (method === 'GET') {
      // Which month, defaulting to Malaysia's own calendar month — on a UTC
      // Worker the first 8 hours of a new month still read as the old one.
      const nowParts = churchParts(new Date());
      const year = Number(q.get('year')) || nowParts.year;
      const month = Number(q.get('month')) || nowParts.month;
      if (!Number.isInteger(year) || year < 1970 || year > 9999)
        throw new HttpError(400, 'year must be a four-digit year');
      if (!Number.isInteger(month) || month < 1 || month > 12)
        throw new HttpError(400, 'month must be a number from 1 to 12');
      // `hallFilter` may be null — 全部堂会 lists every congregation's members
      // in one sheet. A tick still records WHICH congregation the person was
      // counted in; it is read off the member's own hall when it is written.
      //
      // `group_id` narrows the ROWS to one life group, for the roll-call card
      // on `/groups/:id` — the same Sundays, the same tables, the same write
      // path, just fewer people. It is a READ of that group, so it goes through
      // the same guard the group's own detail route uses (rule G2): the hall
      // rules above still come first, and this parameter cannot be used to see
      // another congregation's roster.
      //
      // `groupFilter` rather than a bare `q.get('group_id')`: for a
      // group_leader session its own group ALWAYS wins (the same precedence
      // `hallFilter` uses), so it can never reach the unscoped, whole-
      // congregation sheet just by omitting the parameter.
      const groupId = groupFilter;
      if (groupId) {
        await assertRowReadable('groups', groupId);
        assertGroupScope(groupId);
      }
      return json(await rollCallSheet(db, hallFilter, year, month, groupId));
    }
    // ONE cell, or one whole column, through the SAME call.
    //
    // `member_ids` is the general shape and `member_id` its singular alias: a
    // single tick is a list of one, and the header's 全员到齐 shortcut is the
    // list of everybody on the sheet. Making the list the shape — rather than
    // adding a second "bulk" endpoint — is what guarantees the shortcut can
    // never drift from the single tick: same column resolution, same hall rule,
    // same gate, same delete-instead-of-false. Thirteen members × two ticks ×
    // five Sundays is 130 round trips otherwise, on a phone, over a mobile
    // link.
    if (method === 'PUT') {
      const dto = await body();
      const column = parseColumnKey(String(dto.column ?? ''));
      if (!column)
        throw new HttpError(400, `Unknown sheet column: ${String(dto.column ?? '')}`);
      // A group_leader's card has no meeting columns at all (`rollCallSheet`
      // returns none when `groupId` is set — a congregation meeting is not
      // the group's to roll, per CLAUDE.md) — this refuses a hand-crafted PUT
      // that names one directly, rather than relying on the GET response
      // simply never offering the key.
      if (groupScope && column.kind !== 'sunday')
        throw new HttpError(403, 'A group leader may only mark Sunday attendance');
      const asked = Array.isArray(dto.member_ids)
        ? dto.member_ids
        : dto.member_id !== undefined
          ? [dto.member_id]
          : [];
      const memberIds = [...new Set(asked.map((v) => String(v ?? '')).filter(Boolean))];
      if (memberIds.length === 0)
        throw new HttpError(400, 'member_id (or a non-empty member_ids) is required');
      // A sheet is one congregation's active members; anything an order of
      // magnitude past that is a malformed request, not a roll call.
      if (memberIds.length > 1000)
        throw new HttpError(400, 'Too many members in one write — 1000 at most');

      // Whose cells — and, for a Sunday, which congregation each tick is filed
      // under. The member's OWN hall decides that (never a client-sent
      // hall_id), and a hall-pinned account may only tick its own hall's
      // members, exactly like every other write (rule G2). Read once for the
      // whole list, so a column of thirteen is still one lookup.
      const members = unwrap<Array<{ id: string; hall_id: string; group_id: string | null }>>(
        await db.from('members').select('id,hall_id,group_id').in('id', memberIds),
      );
      if (members.length !== memberIds.length)
        throw new HttpError(400, 'One of those members does not exist');
      if (hallScope && members.some((m) => m.hall_id !== hallScope))
        throw new HttpError(403, 'No permission to modify another congregation’s records');
      // `groupFilter`/`groupScope` above already forces which ROSTER a
      // group_leader is looking at, but the write is member-addressed rather
      // than roster-addressed — this is what stops it from ticking a member
      // id outside its own group even if one were hand-crafted into the
      // request body.
      if (groupScope && members.some((m) => m.group_id !== groupScope))
        throw new HttpError(403, 'No permission to modify another group’s records');

      if (column.kind === 'sunday') {
        const serviceDate = column.date;
        // Postgres would refuse this too (the sunday_attendance_is_sunday
        // check), but a constraint name is not an answer anybody can act on.
        if (!isSundayDate(serviceDate))
          throw new HttpError(400, `${serviceDate} is not a Sunday — only Sundays belong on a Sunday column`);
        const preService = dto.pre_service === true;
        const service = dto.service === true;
        const cell: SheetCell = { pre_service: preService, service };
        // Both ticks off means "not recorded", which is what NO ROW already
        // means — and the table's not-empty check forbids storing it. So an
        // untick deletes rather than writing an empty row.
        if (!preService && !service) {
          // Grouped by the hall each member actually belongs to, exactly as a
          // single untick is: on 全部堂会 the list spans congregations, and
          // someone who moved mid-year can hold a row in each — clearing one
          // must never reach the other.
          const byHall = new Map<string, string[]>();
          for (const m of members) {
            const ids = byHall.get(m.hall_id);
            if (ids) ids.push(m.id);
            else byHall.set(m.hall_id, [m.id]);
          }
          for (const [hallId, ids] of byHall) {
            unwrap(
              await db
                .from('sunday_attendance')
                .delete()
                .eq('hall_id', hallId)
                .eq('service_date', serviceDate)
                .in('member_id', ids)
                .select('id'),
            );
          }
        } else {
          unwrap(
            await db
              .from('sunday_attendance')
              .upsert(
                members.map((m) => ({
                  hall_id: m.hall_id,
                  service_date: serviceDate,
                  member_id: m.id,
                  pre_service: preService,
                  service,
                })),
                { onConflict: 'hall_id,service_date,member_id' },
              )
              .select('id'),
          );
        }
        return json({
          column: sundayColumnKey(serviceDate),
          member_ids: memberIds,
          count: memberIds.length,
          ...cell,
        });
      }

      // A meeting column. `assertRowReadable` rather than `assertOwnsRow`: a
      // 全堂开放 meeting (hall_id is null) belongs to no single hall and every
      // congregation rolls its own people on it.
      await assertRowReadable('events', column.eventId);
      const attended = dto.attended === true;
      if (attended) {
        unwrap(
          await db
            .from('event_attendance')
            .upsert(
              memberIds.map((id) => ({ event_id: column.eventId, member_id: id, status: 'present' })),
              { onConflict: 'event_id,member_id' },
            )
            .select('id'),
        );
      } else {
        // Same rule as a Sunday: an untick removes the row, so "no row" keeps
        // meaning "nothing was recorded" rather than "was not there".
        unwrap(
          await db
            .from('event_attendance')
            .delete()
            .eq('event_id', column.eventId)
            .in('member_id', memberIds)
            .select('id'),
        );
      }
      return json({
        column: meetingColumnKey(column.eventId),
        member_ids: memberIds,
        count: memberIds.length,
        attended,
      });
    }
  }

  // ---- Events (the meetings someone adds by hand) ----------------------------
  // A row here is one occasion with a name, a date and a congregation. It gets
  // its own column on that month's roll-call sheet above, which is also where
  // its attendance is ticked — deleting it takes those ticks with it
  // (`event_attendance.event_id` is `on delete cascade`).
  if (r0 === 'events') {
    if (!r1) {
      if (method === 'GET') {
        let query = db
          .from('events')
          .select('*, hall:halls(id,name)')
          .order('starts_at', { ascending: false });
        // A narrowed view sees that hall plus every 全堂/联合 event — the same
        // rows a hall-pinned account sees, whether the narrowing came from the
        // session's own hall or from the congregation switcher.
        if (hallFilter) query = query.or(`hall_id.eq.${hallFilter},hall_id.is.null`);
        return json(unwrap(await query));
      }
      if (method === 'POST')
        return json(unwrap(await db.from('events').insert(withHall(await body())).select().single()));
    } else if (!r2) {
      if (method === 'GET') {
        await assertRowReadable('events', r1);
        return json(
          unwrap(await db.from('events').select('*, hall:halls(id,name)').eq('id', r1).single()),
        );
      }
      if (method === 'PATCH') {
        const dto = await body();
        assertHallWritable(dto);
        await assertOwnsRow('events', r1);
        return json(unwrap(await db.from('events').update(dto).eq('id', r1).select().single()));
      }
      if (method === 'DELETE') {
        await assertOwnsRow('events', r1);
        unwrap(await db.from('events').delete().eq('id', r1).select().single());
        return json({ id: r1 });
      }
    }
  }

  // ---- Trainings ------------------------------------------------------------
  if (r0 === 'trainings') {
    // /trainings/enroll/:id — PUBLIC self-enrollment (no session; see the
    // isPublicForm gate above). A visitor types their full Chinese name; we
    // enroll them only if it matches exactly one existing member, otherwise we
    // tell them to contact the pastor (never auto-create a member — avoids
    // duplicates).
    if (r1 === 'enroll' && r2) {
      const training = unwrap<PublicTraining>(
        await db.from('trainings').select(PUBLIC_TRAINING_SELECT).eq('id', r2).single(),
      );
      // GET /trainings/enroll/:id/check?name=… — the SAME verdict the POST
      // below would reach, without writing anything. The form calls it while
      // the visitor types, so a name that will not match is said so on the spot
      // instead of after the receipt has been attached and the button pressed.
      //
      // It answers with a status and, at most, the matched member's own name
      // (which the visitor just typed) — never a list, never an id. That is
      // strictly less than the POST already tells the same anonymous caller,
      // so it opens nothing new.
      if (r3 === 'check' && method === 'GET') {
        const name = (q.get('name') ?? '').trim();
        if (!training.is_enrollable) return json({ status: 'closed' });
        if (!name) return json({ status: 'no_member' });
        const matches = unwrap<Array<{ id: string; full_name: string }>>(
          await db.from('members').select('id,full_name').eq('full_name', name),
        );
        if (matches.length === 0) return json({ status: 'no_member' });
        if (matches.length > 1) return json({ status: 'ambiguous' });
        const existing = unwrap<Array<{ id: string }>>(
          await db
            .from('training_enrollments')
            .select('id')
            .eq('training_id', r2)
            .eq('member_id', matches[0].id),
        );
        return json({
          status: existing.length > 0 ? 'already' : 'ok',
          name: matches[0].full_name,
        });
      }
      if (method === 'GET') {
        // `kind`, the date/time/place and the payment block ride along so the
        // public page can read as an activity ("Saturday 12 Sept, 9am, the
        // church car park") instead of "1 sessions", and can show what the
        // 报名费 is and how to pay it BEFORE asking for a receipt (rule G8's
        // shape half: the wording follows the stored code, not a guess).
        // Deliberately these fields and no more: this endpoint answers without
        // a session, so it must never hand out the whole row.
        return json(training);
      }
      if (method === 'POST') {
        // Two body shapes on one public path: JSON for a free sign-up (what it
        // has always taken), multipart when a payment receipt rides along. The
        // slip travels WITH the sign-up rather than through an upload endpoint
        // of its own, which is what keeps this — the app's ONLY unauthenticated
        // upload — from being usable as anonymous file storage: nothing reaches
        // the bucket until every check below has passed.
        const contentType = req.headers.get('content-type') ?? '';
        let fullName = '';
        let slip: File | null = null;
        if (contentType.includes('multipart/form-data')) {
          const form = await req.formData();
          fullName = String(form.get('full_name') ?? '').trim();
          const sent = form.get('slip');
          slip = sent instanceof File && sent.size > 0 ? sent : null;
        } else {
          fullName = String((await body()).full_name ?? '').trim();
        }

        // Everything that can refuse this sign-up runs BEFORE a single byte is
        // written to storage: the course must be open, the name must match one
        // member, and that member must not already be on the list.
        if (!training.is_enrollable) return json({ status: 'closed' });
        if (!fullName) return json({ status: 'no_member' });
        const matches = unwrap<Array<{ id: string; full_name: string; gender: string | null }>>(
          await db.from('members').select('id,full_name,gender').eq('full_name', fullName),
        );
        if (matches.length === 0) return json({ status: 'no_member' });
        if (matches.length > 1) return json({ status: 'ambiguous' });
        const member = matches[0];
        const existing = unwrap<Array<{ id: string }>>(
          await db
            .from('training_enrollments')
            .select('id')
            .eq('training_id', r2)
            .eq('member_id', member.id),
        );
        if (existing.length > 0) return json({ status: 'already', name: member.full_name });

        // 性别限制 (0024) — a real eligibility rule, not a UI hint, so a
        // mismatch is refused here regardless of what the live "does this
        // match?" check told the visitor while they were still typing.
        if (training.gender && member.gender !== training.gender)
          throw new HttpError(400, `This training is open to ${training.gender} members only`);

        // A 报名费 makes the receipt part of the sign-up, not an afterthought:
        // without it there is nothing for the admin to check before approving,
        // so the request is refused rather than stored half-done.
        let slipUrl: string | null = null;
        if (isPaid(training.fee)) {
          if (!slip)
            throw new HttpError(
              400,
              'This sign-up has a fee — upload your payment receipt to complete it',
            );
          const file = checkedFile(slip, SLIP_UPLOAD);
          slipUrl = await storeFile(
            db,
            'payments',
            // A random name, not the member's or the training's: the bucket is
            // public, so an object's URL must not be derivable from anything a
            // stranger already knows.
            `slips/${r2}/${crypto.randomUUID()}.${fileExt(file, 'jpg')}`,
            file,
          );
        }

        unwrap(
          await db
            .from('training_enrollments')
            .insert({
              training_id: r2,
              member_id: member.id,
              status: 'pending',
              payment_slip_url: slipUrl,
            })
            .select('id')
            .single(),
        );
        return json({ status: 'ok', name: member.full_name });
      }
    }
    // /trainings/sessions/:sessionId ...
    else if (r1 === 'sessions' && r2) {
      if (r3 === 'attendance' && method === 'POST') {
        const dto = await body();
        // A roll call stores one fact: present, or no row at all.
        const records = (dto.records as Array<Record<string, unknown>>).map((r) => ({
          session_id: r2,
          member_id: r.member_id,
          attended: r.attended,
        }));
        return json(
          unwrap(
            await db
              .from('training_attendance')
              .upsert(records, { onConflict: 'session_id,member_id' })
              .select(),
          ),
        );
      }
      if (!r3) {
        if (method === 'PATCH')
          return json(
            unwrap(await db.from('training_sessions').update(await body()).eq('id', r2).select().single()),
          );
        if (method === 'DELETE') {
          unwrap(await db.from('training_sessions').delete().eq('id', r2).select().single());
          return json({ id: r2 });
        }
      }
    }
    // /trainings/enrollments/:enrollmentId
    else if (r1 === 'enrollments' && r2) {
      if (method === 'PATCH') {
        const dto = await body();
        const patch: Record<string, unknown> = { ...dto };
        if (dto.status === 'completed') {
          patch.completed_at = new Date().toISOString();
          if (dto.progress === undefined) patch.progress = 100;
        }
        return json(
          unwrap(
            await db
              .from('training_enrollments')
              .update(patch)
              .eq('id', r2)
              .select(`*, member:members(${MEMBER_BRIEF})`)
              .single(),
          ),
        );
      }
      if (method === 'DELETE') {
        unwrap(await db.from('training_enrollments').delete().eq('id', r2).select().single());
        return json({ id: r2 });
      }
    }
    // /trainings ...
    else if (!r1) {
      if (method === 'GET') {
        let query = db
          .from('trainings')
          .select('*, hall:halls(id,name)')
          .order('created_at', { ascending: false });
        // A narrowed view sees that hall plus every 全堂开放 course.
        if (hallFilter) query = query.or(`hall_id.eq.${hallFilter},hall_id.is.null`);
        return json(unwrap(await query));
      }
      if (method === 'POST') {
        const dto = trainingWrite(await body());
        const row = unwrap<{ id: string; kind: string }>(
          await db.from('trainings').insert(withHall(dto)).select().single(),
        );
        // An activity's ONE occasion is a session row, created here rather than
        // by the page: it is what gives the attendance sheet its single column
        // to tick, and the invariant "an activity always has exactly one
        // session" must not depend on a second request that can fail on its own.
        if (row.kind === TrainingKind.Activity) await ensureSingleSession(db, row.id);
        return json(row);
      }
    }
    // /trainings/:id ...
    else if (r1 && !r2) {
      if (method === 'GET') {
        await assertRowReadable('trainings', r1);
        const training = unwrap<Record<string, unknown>>(
          await db.from('trainings').select('*, hall:halls(id,name)').eq('id', r1).single(),
        );
        const sessions = unwrap(
          await db.from('training_sessions').select('*').eq('training_id', r1).order('session_number'),
        );
        const enrollments = unwrap(
          await db
            .from('training_enrollments')
            .select(`*, member:members(${MEMBER_BRIEF})`)
            .eq('training_id', r1)
            .order('enrolled_at'),
        );
        return json({ ...training, sessions, enrollments });
      }
      if (method === 'PATCH') {
        // `kind` is fixed at creation (0024 retires the course↔activity
        // conversion this endpoint used to perform): trainingWrite() still
        // 400s a junk value if one is sent, but `applyKindEffects: false`
        // skips the total_sessions/ends_on mutation that value would
        // otherwise carry (that only belongs to a CREATE), and the `kind`
        // key itself is deleted below so it can never reach the update —
        // there is no client left that sends it (the create path is the
        // separate POST branch below, still using ensureSingleSession for
        // its own, still-needed, invariant).
        const dto = trainingWrite(await body(), { applyKindEffects: false });
        delete dto.kind;
        assertHallWritable(dto);
        await assertOwnsRow('trainings', r1);
        const row = unwrap<{ id: string; kind: string }>(
          await db.from('trainings').update(dto).eq('id', r1).select().single(),
        );
        return json(row);
      }
      if (method === 'DELETE') {
        await assertOwnsRow('trainings', r1);
        unwrap(await db.from('trainings').delete().eq('id', r1).select().single());
        return json({ id: r1 });
      }
    }
    // /trainings/:id/{namelist,sessions,enroll,payment-qr}
    else if (r1 && r2) {
      if (r2 === 'namelist' && method === 'GET') {
        await assertRowReadable('trainings', r1);
        return json(await namelist(db, r1));
      }
      // The church's own payment QR (DuitNow / TnG). Same mechanism as a
      // member's photo and the church logo — service-role upload into a public
      // bucket, the URL onto the row (rule G4) — and the same hall rule as any
      // other write to this training. Removing it is a PATCH with
      // `payment_qr_url: null`, so there is no second delete path.
      if (r2 === 'payment-qr' && method === 'POST') {
        await assertOwnsRow('trainings', r1);
        const form = await req.formData();
        const file = checkedFile(form.get('file'), IMAGE_UPLOAD);
        const url = await storeFile(
          db,
          'payments',
          `qr/${r1}/${Date.now()}.${fileExt(file, 'png')}`,
          file,
        );
        return json(
          unwrap(
            await db
              .from('trainings')
              .update({ payment_qr_url: url })
              .eq('id', r1)
              .select()
              .single(),
          ),
        );
      }
      if (r2 === 'sessions' && method === 'POST')
        return json(
          unwrap(
            await db
              .from('training_sessions')
              .insert({ ...(await body()), training_id: r1 })
              .select()
              .single(),
          ),
        );
      if (r2 === 'enroll' && method === 'POST') {
        const dto = await body();
        return json(
          unwrap(
            await db
              .from('training_enrollments')
              .insert({ training_id: r1, member_id: dto.member_id, status: dto.status ?? 'pending' })
              .select(`*, member:members(${MEMBER_BRIEF})`)
              .single(),
          ),
        );
      }
    }
  }

  // ---- Discipleship ---------------------------------------------------------
  if (r0 === 'discipleship') {
    if (r1 === 'programs') {
      if (!r2) {
        if (method === 'GET')
          return json(
            unwrap(await db.from('discipleship_programs').select('*').order('created_at', { ascending: false })),
          );
        if (method === 'POST')
          return json(unwrap(await db.from('discipleship_programs').insert(await body()).select().single()));
      } else if (r3 === 'overview' && method === 'GET') {
        // A pair's hall is its mentor's hall, exposed on the view by 0008.
        // Scoped by `hallFilter`, so the congregation switcher narrows the
        // pastor overview (and the dashboard's 守望进行中 KPI, which counts
        // these rows) exactly like every other list.
        let query = db
          .from('discipleship_pair_summary')
          .select('*')
          .eq('program_id', r2)
          .order('percent_complete', { ascending: false });
        if (hallFilter) query = query.eq('hall_id', hallFilter);
        return json(unwrap(await query));
      } else if (!r3) {
        // A 守望模块 (discipleship_programs row) carries NO hall column — it is
        // church-wide configuration, like a training session or an enrollment,
        // so none of the hall helpers apply here. Access control is entirely
        // the gate at the top of dispatch(): `readonly` cannot write at all.
        //
        // READ ONLY BY ID, deliberately. A module is created (POST above) and
        // then left alone: editing or deleting one was a manager built on a
        // misreading of what the church meant by "module", and it shipped a
        // button whose whole job was to cascade away every pair under a module
        // and all of their daily records. PATCH and DELETE therefore fall
        // through to the 404 at the foot of dispatch() — the route does not
        // exist, rather than existing and being hidden in the UI (rule G2:
        // the server is the authority, not the page).
        if (method === 'GET') {
          return json(unwrap(await db.from('discipleship_programs').select('*').eq('id', r2).single()));
        }
      }
    } else if (r1 === 'pairs') {
      if (!r2) {
        if (method === 'GET') {
          // A pair belongs to its mentor's hall — an !inner join lets the
          // filter run in the database rather than post-filtering here. The
          // relay chart and the active/done/pending counts on /discipleship
          // are built from these rows, so this is what makes the congregation
          // switcher reach that page at all.
          let query = db
            .from('discipleship_pairs')
            .select(hallFilter ? PAIR_SELECT_SCOPED : PAIR_SELECT)
            .order('created_at');
          if (hallFilter) query = query.eq('mentor.hall_id', hallFilter);
          if (q.get('program_id')) query = query.eq('program_id', q.get('program_id'));
          return json(unwrap(await query));
        }
        if (method === 'POST') {
          // `backfill_days` lets a pair be created already partway through the
          // program — e.g. a mentor/trainee who were tracking progress on
          // paper before this system existed — by marking days 1..N complete
          // immediately instead of starting the pair at 0%.
          const { backfill_days, ...pairDto } = (await body()) as Record<string, unknown>;
          // The mentor decides the pair's hall, so a single-hall account may
          // only pair up its own hall's mentors — otherwise it would create a
          // pair inside another congregation (and never see it again).
          if (pairDto.mentor_id) await assertOwnsRow('members', String(pairDto.mentor_id));
          const pair = unwrap<{ id: string; program_id: string }>(
            await db.from('discipleship_pairs').insert(pairDto).select(PAIR_SELECT).single(),
          );
          const n = Math.trunc(Number(backfill_days) || 0);
          if (n > 0) {
            const program = unwrap(
              await db
                .from('discipleship_programs')
                .select('total_days')
                .eq('id', pair.program_id)
                .single<{ total_days: number }>(),
            );
            const days = Math.min(n, program.total_days);
            // unwrapWrite, not unwrap: an upsert with no `.select()` succeeds
            // with `data: null`, which unwrap reports as a 404 — the pair was
            // created and the days written, and the page still said "Resource
            // not found".
            unwrapWrite(
              await db.from('discipleship_progress').upsert(
                Array.from({ length: days }, (_, i) => ({
                  pair_id: pair.id,
                  day_number: i + 1,
                  completed: true,
                })),
                { onConflict: 'pair_id,day_number' },
              ),
            );
          }
          return json(pair);
        }
      } else if (r3 === 'progress' && method === 'POST') {
        await assertPairInHall(r2);
        return json(await upsertProgress(db, r2, await body()));
      } else if (!r3) {
        if (method === 'GET') {
          await assertPairInHall(r2);
          const pair = unwrap<Record<string, unknown>>(
            await db
              .from('discipleship_pairs')
              .select(`${PAIR_SELECT}, program:discipleship_programs(id,name,total_days)`)
              .eq('id', r2)
              .single(),
          );
          const progress = unwrap(
            await db.from('discipleship_progress').select('*').eq('pair_id', r2).order('day_number'),
          );
          return json({ ...pair, progress });
        }
        if (method === 'PATCH') {
          await assertPairInHall(r2);
          return json(unwrap(await db.from('discipleship_pairs').update(await body()).eq('id', r2).select().single()));
        }
        if (method === 'DELETE') {
          await assertPairInHall(r2);
          unwrap(await db.from('discipleship_pairs').delete().eq('id', r2).select().single());
          return json({ id: r2 });
        }
      }
    } else if (r1 === 'form' && r2) {
      const pair = unwrap(
        await db
          .from('discipleship_pairs')
          .select(
            // Both names, like everywhere else a person is shown: the mentor
            // reading this form knows their trainee by whichever one they use.
            // Nothing else about either member is handed out — this path
            // answers with no session at all.
            '*, mentor:members!discipleship_pairs_mentor_id_fkey(id,full_name,english_name,hall_id), trainee:members!discipleship_pairs_trainee_id_fkey(id,full_name,english_name,hall_id), program:discipleship_programs(id,name,total_days)',
          )
          .eq('form_token', r2)
          .single(),
      ) as { id: string };
      if (r3 === 'progress' && method === 'POST') {
        return json(await upsertProgress(db, pair.id, await body()));
      }
      if (!r3 && method === 'GET') {
        const progress = unwrap(
          await db.from('discipleship_progress').select('*').eq('pair_id', pair.id).order('day_number'),
        );
        return json({ ...pair, progress });
      }
    }
  }

  // ---- 幸福小组 (Happiness Groups) --------------------------------------------
  // 期 (term) → group → roster + weekly attendance. An add-on module (the gate
  // above already refuses every /happiness/* path while it is off), staff/
  // leader-only — no public form, unlike 守望's mentor link.
  //
  // Terms are church-wide (no hall column) and NOT create-once: several may
  // overlap, and full CRUD applies. Groups carry `hall_id` directly — exactly
  // like `groups` — so they use the same hall helpers as that section, never
  // the more roundabout "hall comes from a joined member" pattern discipleship
  // pairs need.
  if (r0 === 'happiness') {
    if (r1 === 'terms') {
      if (!r2) {
        if (method === 'GET') return json(await happinessTerms(db));
        if (method === 'POST') {
          // 期号 is no longer typed by the user — a church just names a term
          // and picks its dates; the number is assigned here, one past the
          // highest one on record, so it still sorts and reads the way
          // `happy.term.pageTitle`("第 {no} 期") always has.
          const b = await body();
          if (b.term_no == null) {
            const { data: maxRow } = await db
              .from('happiness_terms')
              .select('term_no')
              .order('term_no', { ascending: false })
              .limit(1)
              .maybeSingle();
            b.term_no = (maxRow?.term_no ?? 0) + 1;
          }
          return json(unwrap(await db.from('happiness_terms').insert(b).select().single()));
        }
      } else if (!r3) {
        if (method === 'GET')
          return json(unwrap(await db.from('happiness_terms').select('*').eq('id', r2).single()));
        if (method === 'PATCH')
          return json(
            unwrap(
              await db.from('happiness_terms').update(await body()).eq('id', r2).select().single(),
            ),
          );
        if (method === 'DELETE') {
          // Cascades its groups, their rosters and every week of attendance
          // (the FKs are `on delete cascade`, migration 0022). The DELETE
          // method gate above is already super_admin/admin only; the CLIENT
          // is what names the blast radius before this ever runs (rule G3).
          unwrap(await db.from('happiness_terms').delete().eq('id', r2).select().single());
          return json({ id: r2 });
        }
      }
    } else if (r1 === 'groups') {
      if (!r2) {
        if (method === 'GET') {
          let query = db.from('happiness_groups').select(HAPPINESS_GROUP_SELECT).order('created_at');
          if (hallFilter) query = query.eq('hall_id', hallFilter);
          if (q.get('term_id')) query = query.eq('term_id', q.get('term_id'));
          return json(
            await withRosterCounts(db, unwrap<Array<Record<string, unknown>>>(await query)),
          );
        }
        if (method === 'POST')
          return json(
            unwrap(
              await db
                .from('happiness_groups')
                .insert(withHall(await body()))
                .select(HAPPINESS_GROUP_SELECT)
                .single(),
            ),
          );
      } else if (r3 === 'members') {
        if (!r4 && method === 'POST') {
          // Add one or several to the roster in one call — the same
          // singular/list dual-accept the roll-call sheet uses
          // (`member_ids` general, `member_id` its alias). Duplicates
          // (already on the roster) are silently skipped rather than refused:
          // re-adding somebody who is already there is not an error.
          await assertOwnsRow('happiness_groups', r2);
          const dto = await body();
          const asked = Array.isArray(dto.member_ids)
            ? dto.member_ids
            : dto.member_id !== undefined
              ? [dto.member_id]
              : [];
          const memberIds = [...new Set(asked.map((v) => String(v ?? '')).filter(Boolean))];
          if (memberIds.length === 0)
            throw new HttpError(400, 'member_id (or a non-empty member_ids) is required');
          unwrap(
            await db
              .from('happiness_group_members')
              .upsert(
                memberIds.map((id) => ({ group_id: r2, member_id: id })),
                { onConflict: 'group_id,member_id', ignoreDuplicates: true },
              )
              .select('id'),
          );
          return json({ group_id: r2, member_ids: memberIds, count: memberIds.length });
        }
        if (r4 && method === 'DELETE') {
          // Deletes the ROSTER row only — `happiness_attendance` carries no FK
          // to `happiness_group_members`, so a week they attended stays on the
          // record even after they leave the roster (by design, per 0022).
          await assertOwnsRow('happiness_groups', r2);
          unwrap(
            await db
              .from('happiness_group_members')
              .delete()
              .eq('group_id', r2)
              .eq('member_id', r4)
              .select()
              .single(),
          );
          return json({ group_id: r2, member_id: r4 });
        }
      } else if (r3 === 'activities') {
        /*
         * 活动记录 (0029): what the group DID on a date, with photos and a
         * note. Every read and write is gated by the GROUP, exactly like its
         * roster and its roll call — an activity has no hall of its own,
         * it belongs to a group that has one (rule G2).
         */
        if (!r4) {
          if (method === 'GET') {
            await assertRowReadable('happiness_groups', r2);
            return json(
              unwrap(
                await db
                  .from('happiness_activities')
                  .select('*')
                  .eq('group_id', r2)
                  .order('happened_on', { ascending: false })
                  .order('created_at', { ascending: false }),
              ),
            );
          }
          if (method === 'POST') {
            await assertOwnsRow('happiness_groups', r2);
            const dto = await body();
            if (!tidy(String(dto.happened_on ?? ''))) throw new HttpError(400, 'happened_on is required');
            // `group_id` comes from the PATH, never the payload: the gate above
            // just checked THAT group, so letting the body name a different one
            // would file the record past its own permission check.
            return json(
              unwrap(
                await db
                  .from('happiness_activities')
                  .insert({ ...dto, group_id: r2 })
                  .select()
                  .single(),
              ),
            );
          }
        } else if (r5 === 'photos' && method === 'POST') {
          // The photo travels as multipart to the activity that already
          // exists, like a training's payment QR (rule G4): same bucket
          // helper, same size/type rule, and the URL is appended to the row's
          // own list rather than replacing it, because a record collects
          // several over an evening.
          await assertOwnsRow('happiness_groups', r2);
          const form = await req.formData();
          const file = checkedFile(form.get('file'), IMAGE_UPLOAD);
          const url = await storeFile(
            db,
            'photos',
            `happiness/${r2}/${r4}/${Date.now()}.${fileExt(file, 'jpg')}`,
            file,
          );
          const current = unwrap<{ photo_urls: string[] | null }>(
            await db.from('happiness_activities').select('photo_urls').eq('id', r4).single(),
          );
          return json(
            unwrap(
              await db
                .from('happiness_activities')
                .update({ photo_urls: [...(current.photo_urls ?? []), url] })
                .eq('id', r4)
                .eq('group_id', r2)
                .select()
                .single(),
            ),
          );
        } else if (r4 && !r5) {
          if (method === 'PATCH') {
            await assertOwnsRow('happiness_groups', r2);
            const dto = await body();
            // Same reason as the insert: the path owns `group_id`, so a PATCH
            // can never move a record into a group this session never passed
            // the gate for.
            delete dto.group_id;
            return json(
              unwrap(
                await db
                  .from('happiness_activities')
                  .update(dto)
                  .eq('id', r4)
                  .eq('group_id', r2)
                  .select()
                  .single(),
              ),
            );
          }
          if (method === 'DELETE') {
            await assertOwnsRow('happiness_groups', r2);
            unwrap(
              await db
                .from('happiness_activities')
                .delete()
                .eq('id', r4)
                .eq('group_id', r2)
                .select()
                .single(),
            );
            return json({ id: r4 });
          }
        }
      } else if (r3 === 'attendance' && !r4) {
        if (method === 'GET') {
          await assertRowReadable('happiness_groups', r2);
          return json(await happinessAttendance(db, r2));
        }
        if (method === 'PUT') {
          await assertOwnsRow('happiness_groups', r2);
          return json(await putHappinessAttendance(db, r2, await body()));
        }
      } else if (!r3) {
        if (method === 'GET') {
          await assertRowReadable('happiness_groups', r2);
          return json(await happinessGroupDetail(db, r2));
        }
        if (method === 'PATCH') {
          const dto = await body();
          assertHallWritable(dto);
          await assertOwnsRow('happiness_groups', r2);
          return json(
            unwrap(
              await db
                .from('happiness_groups')
                .update(dto)
                .eq('id', r2)
                .select(HAPPINESS_GROUP_SELECT)
                .single(),
            ),
          );
        }
        if (method === 'DELETE') {
          // Cascades the roster and every week of attendance (0022).
          await assertOwnsRow('happiness_groups', r2);
          unwrap(await db.from('happiness_groups').delete().eq('id', r2).select().single());
          return json({ id: r2 });
        }
      }
    } else if (r1 === 'members' && r2 && !r3) {
      // A member's own participation history — nested under the `happiness`
      // prefix (rather than `/members/:id/happiness`) specifically so the
      // module gate above still sees and refuses it when a church has 幸福小组
      // switched off; `moduleForApiPath` matches on the FIRST segment.
      if (method === 'GET') {
        await assertRowReadable('members', r2);
        await assertMemberGroupReadable(r2);
        return json(
          unwrap(
            await db
              .from('happiness_group_members')
              .select('role, group:happiness_groups(id,name,term:happiness_terms(id,term_no,name))')
              .eq('member_id', r2)
              .order('created_at', { ascending: false }),
          ),
        );
      }
    }
  }

  // ---- Accounts -------------------------------------------------------------
  if (r0 === 'accounts') {
    if (!r1) {
      if (method === 'GET')
        return json(unwrap(await db.from('app_users').select(ACCOUNT_SELECT).order('created_at', { ascending: true })));
      if (method === 'POST')
        return json(
          unwrap(
            await db
              .from('app_users')
              .insert(await accountWrite(db, await body()))
              .select(ACCOUNT_SELECT)
              .single(),
          ),
        );
    } else if (!r2) {
      if (method === 'GET')
        return json(unwrap(await db.from('app_users').select(ACCOUNT_SELECT).eq('id', r1).single()));
      if (method === 'PATCH') {
        const existing = unwrap(
          await db.from('app_users').select('member_id').eq('id', r1).single<{ member_id: string }>(),
        );
        return json(
          unwrap(
            await db
              .from('app_users')
              .update(await accountWrite(db, await body(), { existingMemberId: existing.member_id }))
              .eq('id', r1)
              .select(ACCOUNT_SELECT)
              .single(),
          ),
        );
      }
      if (method === 'DELETE') {
        unwrap(await db.from('app_users').delete().eq('id', r1).select().single());
        return json({ id: r1 });
      }
    } else if (r2 === 'password' && method === 'POST') {
      // Super-admin resets an account's password (gate already restricts
      // non-GET /accounts to super_admin). No current-password needed.
      const pw = String((await body()).password ?? '');
      if (pw.length < 8) throw new HttpError(400, 'The password must be at least 8 characters');
      unwrap(
        await db
          .from('app_users')
          .update({ password_hash: await hashPassword(pw) })
          .eq('id', r1)
          .select('id')
          .single(),
      );
      return json({ id: r1, ok: true });
    }
  }

  throw new HttpError(404, `No route for ${method} /api/${p.join('/')}`);
}

/* -------------------------------------------------------------------------
 * Members: self-registration and import
 *
 * Two ways a member row arrives other than somebody typing it into the form —
 * a stranger filling in the public link, and a spreadsheet — and BOTH decide
 * what a row means with the same `planImport` (lib/members-import.ts). That is
 * on purpose: the rule "a member is a pair of names, and an existing pair is an
 * update rather than a second row" is the whole point of migration 0018, and it
 * would be worth nothing if each entry point re-implemented it slightly
 * differently. What differs between them is only which columns they are allowed
 * to carry, which is exactly what each caller passes in.
 * ---------------------------------------------------------------------- */

/** Every issue the plan can report, as the sentence a person is told. */
const IMPORT_ISSUE_MESSAGE: Record<ImportIssue, string> = {
  name_missing: 'The Chinese name is required',
  too_long: 'One of the values is too long',
  duplicate_in_file: 'The same pair of names appears twice in this file',
  unknown_hall: 'No congregation goes by that name',
  unknown_group: 'No life group goes by that name',
  unknown_role: 'That is not a church role this app knows',
  unknown_referrer: 'Nobody on the roll goes by that name',
  ambiguous_referrer: 'More than one member goes by that name — write the English name too',
  self_referrer: 'Somebody cannot have referred themselves',
  unknown_gender: 'That is not a gender this app knows',
  unknown_status: 'That is not a member status this app knows',
  bad_date: 'That is not a date — write it as YYYY-MM-DD',
  bad_email: 'That is not an email address',
  bad_phone: 'That is not a phone number',
  no_hall: 'A congregation is required',
  other_hall: 'That record belongs to another congregation',
  group_other_hall: 'That life group belongs to another congregation',
};

/** The message a refused row is reported with — a value, never a stack. */
function rowFailure(e: unknown): string {
  return e instanceof HttpError ? e.message : ((e as Error)?.message ?? 'Could not be saved');
}

/**
 * The snapshot `planImport` decides against.
 *
 * `existing` is EVERY member, church-wide and never narrowed by hall: the name
 * pair is unique across congregations, so a hall-scoped account importing
 * somebody who is already filed in another hall has to be told that (and
 * refused), rather than inserting a row the database would reject anyway.
 * The list never leaves the server.
 *
 * If a deployment ever grew past whatever row ceiling PostgREST is configured
 * with, a member beyond it would read as "not on the roll" and the import would
 * try to add them again — at which point the pair INDEX refuses the insert and
 * the row comes back as a named failure. So the worst case is a row a person
 * has to look at, never a duplicate that quietly splits somebody's attendance.
 */
async function importContext(
  db: ReturnType<typeof getDb>,
  hallScope: string | null,
  wantedHallId: unknown,
): Promise<ImportContext> {
  // Three independent reads (rule G6).
  const [hallRes, groupRes, memberRes] = await Promise.all([
    db.from('halls').select('id,name').order('sort_order'),
    db.from('groups').select('id,name,hall_id'),
    db.from('members').select('id,full_name,english_name,hall_id,group_position,group_id'),
  ]);
  const halls = unwrap<Array<{ id: string; name: string }>>(hallRes);
  const groups = unwrap<Array<{ id: string; name: string; hall_id: string }>>(groupRes);
  const existing = unwrap<ImportContext['existing']>(memberRes);

  // Where a row that names no congregation lands. A hall-scoped account's own
  // hall always wins (the same precedence as `hallFilter`); a full-access one
  // may name the congregation it is looking at, and a church with a single
  // hall needs neither.
  const asked = wantedHallId == null ? '' : String(wantedHallId);
  if (asked && !halls.some((h) => h.id === asked))
    throw new HttpError(400, 'No congregation with that id');
  const defaultHallId = hallScope ?? (asked || (halls.length === 1 ? halls[0].id : null));
  return { halls, groups, existing, hallScope, defaultHallId };
}

/**
 * One row of the request body, reduced to the columns an import may carry.
 *
 * An allow-list, so a body that also carries `id`, `avatar_url` or anything
 * else the client invented is simply not read — the plan can only ever write
 * what `IMPORT_COLUMNS` names.
 */
function incomingImportRow(raw: unknown, index: number): ImportRow {
  const source = (raw ?? {}) as Record<string, unknown>;
  // Fall back to the position in the list: every refusal is reported by row
  // number, so a row without one would be unfixable.
  const row: ImportRow = { row: Math.trunc(Number(source.row)) || index + 1 };
  for (const column of IMPORT_COLUMNS) {
    const value = source[column.field];
    if (value === undefined || value === null) continue;
    row[column.field] = String(value);
  }
  return row;
}

/**
 * Write a plan. Nothing here decides anything — the plan already did.
 *
 * Creates go in as ONE statement per chunk, which is both far fewer round trips
 * and atomic per chunk: a chunk that trips the name-pair index writes nothing,
 * and is then retried row by row so the refusal can be reported against the
 * spreadsheet row that caused it rather than against fifty innocent ones.
 * Updates are one statement each by nature (each targets its own id), run a few
 * at a time so a re-import of a whole congregation is seconds rather than
 * minutes.
 */
/** Enough of a written member row to feed `syncGroupLeaderAccount` after an import write. */
type ImportedMemberRow = { id: string; group_id: string | null; group_position: string | null };

async function applyImport(
  db: ReturnType<typeof getDb>,
  plan: ReturnType<typeof planImport>,
  ctx: ImportContext,
) {
  const failures: Array<{ row: number; message: string }> = [];
  let created = 0;
  let updated = 0;
  // Every generated password this import produced — the ONE place its
  // plaintext is ever available, exactly as a single promotion's own
  // `leader_account_event: { event: 'created' }` is. An import cannot
  // actually PROMOTE anyone today (`planImport` only ever assigns
  // `GroupPosition.NewMember`, never `Leader`), so in practice this stays
  // empty — kept here so the mechanism is correct the moment that changes,
  // rather than needing a second pass through this function later.
  const leaderAccounts: Array<{ row: number; email: string; password: string }> = [];
  // Previous group state per existing member, for the sync hook's
  // `previousPosition`/`previousGroupId` — read once rather than per row.
  const existingById = new Map(ctx.existing.map((m) => [m.id, m]));

  const chunks = <T,>(list: T[], size: number): T[][] =>
    Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
      list.slice(i * size, i * size + size),
    );
  const creates = plan.rows.filter((r) => r.action === 'create');
  const updates = plan.rows.filter(
    (r): r is PlannedRow & { member_id: string } => r.action === 'update' && !!r.member_id,
  );

  /** Sync the leader account for a just-written row, and record a generated password if any. */
  const syncImportedRow = async (
    row: ImportedMemberRow,
    previousPosition: string | null,
    previousGroupId: string | null,
    spreadsheetRow: number,
  ) => {
    const event = await syncGroupLeaderAccount(db, {
      memberId: row.id,
      previousPosition,
      previousGroupId,
      newPosition: row.group_position,
      groupId: row.group_id,
    });
    if (event.event === 'created') leaderAccounts.push({ row: spreadsheetRow, email: event.email, password: event.password });
  };

  for (const chunk of chunks(creates, 50)) {
    // PostgREST refuses a bulk insert whose objects do not all carry the same
    // keys, and a spreadsheet's rows rarely do — one person has an email, the
    // next does not. So every row in a chunk is widened to the chunk's union of
    // columns, with the missing ones explicitly null. That is only sound
    // because these are NEW rows: an unmentioned column on an insert is null
    // anyway. The update path below must never do this — there a null would
    // erase what the church already had.
    //
    // `serving_roles` is the one column whose "unmentioned" is not null: it is
    // NOT NULL DEFAULT '{}' (0019), so a row in a chunk where somebody else
    // named a ministry is widened with the empty array instead.
    const columns = [...new Set(chunk.flatMap((r) => Object.keys(r.values)))];
    const widened = chunk.map((r) =>
      Object.fromEntries(
        columns.map((c) => [c, r.values[c] ?? (c === 'serving_roles' ? [] : null)]),
      ),
    );
    const res = await db.from('members').insert(widened).select('id,group_id,group_position');
    if (!res.error) {
      created += chunk.length;
      const inserted = (res.data ?? []) as ImportedMemberRow[];
      // A single INSERT ... VALUES (…), (…) returns its rows in the same
      // order they were given, so this zips 1:1 with `chunk` by index.
      for (let i = 0; i < chunk.length; i++) {
        const row = inserted[i];
        if (row) await syncImportedRow(row, null, null, chunk[i].row);
      }
      continue;
    }
    for (const row of chunk) {
      try {
        const inserted = unwrap<ImportedMemberRow>(
          await db.from('members').insert(row.values).select('id,group_id,group_position').single(),
        );
        created++;
        await syncImportedRow(inserted, null, null, row.row);
      } catch (e) {
        failures.push({ row: row.row, message: rowFailure(e) });
      }
    }
  }

  type UpdateResult =
    | { ok: true; row: PlannedRow & { member_id: string }; updatedRow: ImportedMemberRow }
    | { ok: false; row: PlannedRow & { member_id: string }; error: string };

  for (const chunk of chunks(updates, 10)) {
    const results = await Promise.all(
      chunk.map(async (row): Promise<UpdateResult> => {
        try {
          const updatedRow = unwrap<ImportedMemberRow>(
            await db
              .from('members')
              .update(row.values)
              .eq('id', row.member_id)
              .select('id,group_id,group_position')
              .single(),
          );
          return { ok: true, row, updatedRow };
        } catch (e) {
          return { ok: false, row, error: rowFailure(e) };
        }
      }),
    );
    for (const result of results) {
      if (!result.ok) {
        failures.push({ row: result.row.row, message: result.error });
        continue;
      }
      updated++;
      const before = existingById.get(result.row.member_id);
      await syncImportedRow(
        result.updatedRow,
        before?.group_position ?? null,
        before?.group_id ?? null,
        result.row.row,
      );
    }
  }

  return {
    created,
    updated,
    // The rows the plan itself refused, with the machine-readable reason the
    // page renders through the dictionary (rule G8) — plus the same sentence in
    // English, so a script (or api-e2e) reading this endpoint is told why too.
    skipped: plan.rows
      .filter((r) => r.action === 'skip')
      .map((r) => ({
        row: r.row,
        issue: r.issue,
        field: r.field ?? null,
        detail: r.detail ?? null,
        message: r.issue ? IMPORT_ISSUE_MESSAGE[r.issue] : 'Skipped',
      })),
    failures,
    // A 小组长 login this import generated, per row — see the comment above
    // `leaderAccounts`. Always present (possibly empty), the same "additive
    // field, existing consumers ignore it" contract `leader_account_event`
    // follows on the single-member write paths.
    leader_accounts: leaderAccounts,
  };
}

/** What the public form may send. Anything else in the body is not read. */
const REGISTER_FIELDS = [
  'full_name',
  'english_name',
  'phone',
  'email',
  'address',
  'gender',
  'date_of_birth',
  // Everything below reads like the staff-facing add-member form now
  // (church feedback: "all field is needed"), with two deliberate holdouts —
  // `church_role` and `group_position` stay off this list, because who
  // somebody RANKS as and what SEAT they hold in a group are the church's own
  // calls, never something a visitor gets to claim on the way in. A referral,
  // a life group, a ministry and a note are different: they read like facts
  // a person (or whoever is helping them fill this in at the door) can
  // reasonably supply about themselves.
  'referred_by',
  'group_id',
  'serving_roles',
  'notes',
] as const;

/**
 * How long each of those may be.
 *
 * This used to come free from `planImport`, which checked every row against
 * `IMPORT_COLUMNS`' own `maxLength` before the register handler stopped
 * running it (0128). Without it an UNAUTHENTICATED caller could post a
 * megabyte of text into columns that are plain `text` with no length
 * constraint of their own — which is exactly what the API E2E's "absurd name"
 * check caught. The caps are READ from `IMPORT_COLUMNS` rather than retyped,
 * so a column's limit cannot mean one thing to a spreadsheet and another to
 * this form (rule G4); the two fields the importer has no column for get
 * their own entry.
 */
const REGISTER_MAX_LENGTH = new Map<string, number>([
  ...IMPORT_COLUMNS.map((c) => [c.field, c.maxLength] as [string, number]),
  // A note is free text this form only started taking in 0128, and a life
  // group arrives here as an ID rather than the importer's own name column.
  ['notes', 2000],
  ['group_id', 64],
]);

/**
 * `POST /api/members/register` — the public self-registration form (`/join`).
 *
 * The shape follows the public sign-up path exactly (`/trainings/enroll/:id`):
 * JSON when there is no photo, multipart when there is, and the photo travels
 * WITH the registration rather than through an upload endpoint of its own. That
 * is what keeps the app's unauthenticated upload paths from being usable as
 * anonymous file storage: every check below runs first, and nothing reaches the
 * bucket until this row is going to be written.
 *
 * Matching is `matchRegistrant` (lib/members-import.ts), NOT `planImport`'s own
 * `pairKey` — a deliberately different question. An imported spreadsheet row is
 * trusted to carry the church's own exact spelling of both names; a person
 * typing their own registration is not, so requiring the English name to match
 * too would file a returning visitor as a stranger the moment they left it
 * blank the second time. The Chinese name alone is the anchor, with the phone
 * number as the tie-breaker on the rare collision — see that function's own
 * comment for the full rule.
 *
 * The answer is one word — `created` or `updated` — and the same shape either
 * way. It carries no member data at all: not an id, not a phone number, not
 * even the name that was typed. The one thing it does reveal is whether that
 * name was already on the roll, which is unavoidable given the church asked to
 * be told "we have updated your details" rather than "welcome", and is a fact
 * about the visitor's own name.
 */
async function registerMember(
  db: ReturnType<typeof getDb>,
  req: Request,
): Promise<{ status: 'created' | 'updated' }> {
  const contentType = req.headers.get('content-type') ?? '';
  const sent: Record<string, string> = {};
  let hallId = '';
  let photo: File | null = null;
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    for (const field of REGISTER_FIELDS) sent[field] = String(form.get(field) ?? '');
    hallId = String(form.get('hall_id') ?? '');
    const file = form.get('photo');
    photo = file instanceof File && file.size > 0 ? file : null;
  } else {
    const dto = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const field of REGISTER_FIELDS) sent[field] = String(dto[field] ?? '');
    hallId = String(dto.hall_id ?? '');
  }

  const halls = unwrap<Array<{ id: string; name: string }>>(
    await db.from('halls').select('id,name').order('sort_order'),
  );
  // A church with one congregation should not make a stranger pick it; one
  // with three must be told which, or the person lands in the wrong roll call.
  const hall = hallId ? halls.find((h) => h.id === hallId) : halls.length === 1 ? halls[0] : null;
  if (!hall) throw new HttpError(400, 'Please choose your congregation');

  // Before anything is looked up or written: nothing absurdly long gets in.
  // This is an unauthenticated path, so the cap is a real limit rather than a
  // nicety — see REGISTER_MAX_LENGTH above.
  for (const field of REGISTER_FIELDS) {
    const cap = REGISTER_MAX_LENGTH.get(field);
    if (cap !== undefined && tidy(sent[field]).length > cap)
      throw new HttpError(400, `That ${field.replace(/_/g, ' ')} is too long`);
  }

  const fullName = tidy(sent.full_name);
  if (!fullName) throw new HttpError(400, 'Please enter a name');

  const existing = unwrap<Array<{ id: string; full_name: string; phone: string | null }>>(
    await db.from('members').select('id,full_name,phone'),
  );
  const matched = matchRegistrant(fullName, tidy(sent.phone), existing);

  const values: Record<string, unknown> = {};
  if (!matched) {
    // A visitor may correct their own phone number on a later visit; they may
    // not re-spell the church's record of their name, and a brand-new person
    // starts in the congregation they picked, never one guessed at.
    values.full_name = fullName;
    const englishName = tidy(sent.english_name);
    if (englishName) values.english_name = englishName;
    values.hall_id = hall.id;
  }

  const phone = tidy(sent.phone);
  if (phone) {
    if (!looksLikePhone(phone)) throw new HttpError(400, 'That does not look like a phone number');
    values.phone = phone;
  }
  const email = tidy(sent.email);
  if (email) {
    if (!looksLikeEmail(email)) throw new HttpError(400, 'That does not look like an email address');
    // Sign-in matches on a lower-cased address, so stored emails are too.
    values.email = email.toLowerCase();
  }
  const address = tidy(sent.address);
  if (address) values.address = address;
  const gender = tidy(sent.gender);
  if (gender) {
    if (!(Object.values(Gender) as string[]).includes(gender))
      throw new HttpError(400, 'Unknown gender');
    values.gender = gender;
  }
  const dob = tidy(sent.date_of_birth);
  if (dob) {
    const date = parseImportDate(dob);
    if (!date) throw new HttpError(400, 'That does not look like a date');
    values.date_of_birth = date;
  }
  // 推荐人 — a member id straight from the form's own Combobox (unlike a
  // spreadsheet row, this form has no name to resolve: it already has ids to
  // pick from). Silently dropped on a self-referral rather than rejected —
  // the UI never offers it, so it can only happen from a stale id — and
  // refused outright when it names nobody at all, which is a real bug.
  const referredBy = tidy(sent.referred_by);
  if (referredBy && referredBy !== matched?.id) {
    if (!existing.some((m) => m.id === referredBy))
      throw new HttpError(400, 'Unknown referrer');
    values.referred_by = referredBy;
  }
  // 小组 — same shape: an id from a `<select>`, not a name to resolve. Must
  // belong to the SAME congregation the visitor is joining, the identical
  // rule `planImport` enforces on an imported row's own group column.
  const groupId = tidy(sent.group_id);
  if (groupId) {
    // Matched in JS against the whole (small) table, exactly the way `hall` is
    // resolved above — never `.eq('id', groupId)`, which hands an unvalidated
    // string to Postgres as a uuid and answers a malformed one with 22P02,
    // i.e. a 500 out of `unwrap` on a path a stranger can reach.
    const groups = unwrap<Array<{ id: string; hall_id: string }>>(
      await db.from('groups').select('id,hall_id'),
    );
    const group = groups.find((g) => g.id === groupId);
    if (!group || group.hall_id !== hall.id)
      throw new HttpError(400, 'That life group is not in this congregation');
    values.group_id = groupId;
  }
  // 服侍岗位 — free text, several per cell, exactly like the import column
  // and the shared TagsInput both already read it (rule G4).
  const serving = parseList(sent.serving_roles ?? '');
  if (serving.length > 0) values.serving_roles = serving;
  const notes = tidy(sent.notes);
  if (notes) values.notes = notes;

  // Only now — every field has validated and the row is going to be written.
  if (photo) {
    const file = checkedFile(photo, PHOTO_UPLOAD);
    values.avatar_url = await storeFile(
      db,
      'avatars',
      // A random name, not the person's: the bucket is public, so an object's
      // URL must not be derivable from anything a stranger already knows.
      `self/${crypto.randomUUID()}.${fileExt(file, 'jpg')}`,
      file,
    );
  }

  if (matched) {
    // Somebody who filled in nothing but their name has told us nothing new —
    // and PostgREST refuses an empty patch anyway. They are still on the roll,
    // which is what the answer says.
    if (Object.keys(values).length === 0) return { status: 'updated' };
    unwrap(await db.from('members').update(values).eq('id', matched.id).select('id').single());
    return { status: 'updated' };
  }
  unwrap(
    await db
      .from('members')
      .insert({
        ...values,
        // Everyone who registers themselves is an ordinary member. A church
        // role is something the church confers, never something a form
        // visitor claims — the same reason `church_role` is not in
        // REGISTER_FIELDS at all.
        church_role: ChurchRole.Member,
      })
      .select('id')
      .single(),
  );
  return { status: 'created' };
}

// --- Church record & modules ------------------------------------------------

const CHURCH_SELECT =
  'id,name,short_name,description,logo_url,theme_preset,theme_rail,theme_brand';

/** Only these may be written on the church record; anything else is refused
 *  loudly rather than dropped, the same allow-list shape as the self-service
 *  profile above. `id` and the timestamps are deliberately absent. */
const CHURCH_FIELDS = [
  'name',
  'short_name',
  'description',
  'logo_url',
  'theme_preset',
  'theme_rail',
  'theme_brand',
] as const;

type ChurchRow = {
  id: string;
  name: string;
  short_name: string | null;
  description: string | null;
  logo_url: string | null;
  theme_preset: string | null;
  theme_rail: string;
  theme_brand: string;
};

/**
 * The church. One deployment serves exactly one church (halls are the scope
 * column inside it), so this is a singleton row — seeded by migration 0012 and
 * never created from the app. A missing row means the migration has not been
 * applied, which is worth saying out loud rather than answering with nulls.
 */
async function churchRow(db: ReturnType<typeof getDb>): Promise<ChurchRow> {
  const rows = unwrap<ChurchRow[]>(
    await db.from('church').select(CHURCH_SELECT).order('created_at').limit(1),
  );
  if (rows.length === 0)
    throw new HttpError(500, 'No church record yet — apply migration 0012_church_and_modules');
  return rows[0];
}

/** Normalize a church PATCH: allow-listed fields only, and a real name. */
function churchWrite(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(CHURCH_FIELDS as readonly string[]).includes(key))
      throw new HttpError(403, `You may not change ${key} on the church record`);
    patch[key] = value;
  }
  if ('name' in patch) {
    const name = String(patch.name ?? '').trim();
    if (!name) throw new HttpError(400, 'The church name cannot be empty');
    patch.name = name;
  }
  for (const key of ['short_name', 'description', 'logo_url'] as const) {
    if (key in patch) {
      const v = String(patch[key] ?? '').trim();
      patch[key] = v === '' ? null : v;
    }
  }

  // ---- the theme (migration 0017) -------------------------------------------
  // Two colours, and they end up inside a CSS custom property on every page of
  // the app, so this is the place they are checked: a strict `#rrggbb` and
  // nothing else — not a colour name, not `var(…)`, not anything carrying a
  // `;` or a `}`. The column has the same constraint, but nothing should have
  // to rely on that.
  //
  // The two are also refused when they are too PALE to work. The sidebar is
  // light-on-dark by construction and the brand carries white text on every
  // button, so a pale pair would not be an alternative look, it would be an
  // app nobody can read (`isUsableRail` / `isUsableBrand` in packages/shared —
  // the shipped presets all pass, by construction).
  if ('theme_preset' in patch || 'theme_rail' in patch || 'theme_brand' in patch) {
    const wanted = patch.theme_preset == null ? null : String(patch.theme_preset);
    if (wanted !== null) {
      // A preset names its own colours: the catalogue in code is the authority
      // for what `charcoal` looks like, so a client cannot store a pair under
      // a preset's name that the preset never had.
      const preset = themePreset(wanted);
      if (!preset) throw new HttpError(400, `Unknown theme preset: ${wanted}`);
      patch.theme_preset = preset.key;
      patch.theme_rail = preset.rail;
      patch.theme_brand = preset.brand;
    } else {
      // Custom: both colours are required together. Writing one alone would
      // leave the pair half from a preset and half by hand, which is neither.
      const rail = normalizeHexColor(patch.theme_rail);
      const brand = normalizeHexColor(patch.theme_brand);
      if (!rail || !brand)
        throw new HttpError(
          400,
          'A custom theme needs both theme_rail and theme_brand as #rrggbb',
        );
      if (!isUsableRail(rail))
        throw new HttpError(
          400,
          `The sidebar colour is too light: it carries light text, so it needs at least ${MIN_RAIL_CONTRAST}:1 contrast against white`,
        );
      if (!isUsableBrand(brand))
        throw new HttpError(
          400,
          `The brand colour is too light: buttons put white text on it, so it needs at least ${MIN_BRAND_CONTRAST}:1 contrast against white`,
        );
      patch.theme_preset = null;
      patch.theme_rail = rail;
      patch.theme_brand = brand;
    }
  }
  return patch;
}

/**
 * Every optional module with its on/off state, in catalog order.
 *
 * The catalog is the CODE registry, not the table: a stored row for a module
 * this build no longer ships is ignored, and a module with no row yet counts
 * as ON — a newly shipped module is available until someone turns it off,
 * which is the same thing migration 0012's seed does for `discipleship`.
 */
async function moduleStates(
  db: ReturnType<typeof getDb>,
): Promise<Array<{ key: string; enabled: boolean }>> {
  const c = await churchRow(db);
  const rows = unwrap<Array<{ module: string; enabled: boolean }>>(
    await db.from('church_modules').select('module,enabled').eq('church_id', c.id),
  );
  const stored = new Map(rows.map((r) => [r.module, r.enabled]));
  return OPTIONAL_MODULES.map((m) => ({ key: m.key, enabled: stored.get(m.key) ?? true }));
}

/**
 * Is one module on? Used by the gate, so it is one query rather than two:
 * `church_modules.module` needs no church_id filter while the church row is a
 * singleton, and the composite primary key means at most one row can match.
 */
async function moduleEnabled(db: ReturnType<typeof getDb>, key: string): Promise<boolean> {
  const rows = unwrap<Array<{ enabled: boolean }>>(
    await db.from('church_modules').select('enabled').eq('module', key),
  );
  return rows[0]?.enabled ?? true;
}

// --- Shared helpers ---------------------------------------------------------

async function upsertProgress(
  db: ReturnType<typeof getDb>,
  pairId: string,
  dto: Record<string, unknown>,
) {
  return unwrap(
    await db
      .from('discipleship_progress')
      .upsert(
        {
          pair_id: pairId,
          day_number: dto.day_number,
          completed: dto.completed ?? false,
          notes: dto.notes ?? null,
          entry_date: dto.entry_date ?? undefined,
          entry_time: dto.entry_time ?? undefined,
        },
        { onConflict: 'pair_id,day_number' },
      )
      .select()
      .single(),
  );
}

/**
 * The home page, counted server-side (0130).
 *
 * Four questions, one request: how many came the last few Sundays, who has
 * stopped coming, what is on this week, and how do the life groups look.
 *
 * The whole thing walks the SAME gate every other read does — `hallFilter` for
 * the congregation and `groupFilter` for a `group_leader`'s one group — so no
 * section can answer for people this session cannot otherwise see. Nothing
 * here is a second source of truth: the Sunday counts come from
 * `sunday_attendance`, the same table the services sheet writes.
 */
async function dashboard(
  db: ReturnType<typeof getDb>,
  hallFilter: string | null,
  groupFilter: string | null,
  sundayCount: number,
) {
  // Bounded so a hand-crafted `?sundays=9999` cannot ask for a decade of
  // attendance in one query.
  const weeks = Math.min(Math.max(sundayCount, 1), 26);
  const sundays = recentSundays(new Date(), weeks);
  const first = sundays[0];
  const last = sundays[sundays.length - 1];

  const memberQuery = () => {
    let query = db
      .from('members')
      .select('id,full_name,english_name,hall_id,group_id,group_position,church_role,status')
      .eq('status', MemberStatus.Active)
      .neq('church_role', ChurchRole.Visitor);
    if (hallFilter) query = query.eq('hall_id', hallFilter);
    if (groupFilter) query = query.eq('group_id', groupFilter);
    return query;
  };

  const marksQuery = () => {
    let query = db
      .from('sunday_attendance')
      .select('service_date,member_id,pre_service,service')
      .gte('service_date', first)
      .lte('service_date', last);
    if (hallFilter) query = query.eq('hall_id', hallFilter);
    return query;
  };

  // The next seven days of hand-added meetings. A `group_leader` has no reach
  // for `events` at all, so it is not even asked for — the section simply is
  // not part of that account's dashboard.
  const eventsQuery = () => {
    if (groupFilter) return null;
    let query = db
      .from('events')
      .select('id,title,starts_at,location,hall_id')
      .gte('starts_at', new Date().toISOString())
      .lte('starts_at', addChurchDays(new Date(), 8).toISOString())
      .order('starts_at');
    if (hallFilter) query = query.or(`hall_id.eq.${hallFilter},hall_id.is.null`);
    return query;
  };

  const groupsQuery = () => {
    let query = db.from('groups').select('id,name,hall_id');
    if (hallFilter) query = query.eq('hall_id', hallFilter);
    if (groupFilter) query = query.eq('id', groupFilter);
    return query;
  };

  // Independent reads, together (rule G6).
  const ev = eventsQuery();
  const [memberRes, markRes, eventRes, groupRes] = await Promise.all([
    memberQuery(),
    marksQuery(),
    ev ? ev : Promise.resolve(null),
    groupsQuery(),
  ]);

  const members = unwrap<
    Array<{
      id: string;
      full_name: string;
      english_name: string | null;
      hall_id: string;
      group_id: string | null;
      group_position: string | null;
      church_role: string;
      status: string;
    }>
  >(memberRes);
  const marks = unwrap<
    Array<{ service_date: string; member_id: string; pre_service: boolean; service: boolean }>
  >(markRes);
  const groups = unwrap<Array<{ id: string; name: string; hall_id: string }>>(groupRes);
  const events = eventRes
    ? unwrap<Array<{ id: string; title: string; starts_at: string; location: string | null }>>(eventRes)
    : [];

  // A member's ticks only count toward THIS dashboard's numbers if that member
  // is in scope — the marks query is narrowed by hall, but a group-scoped
  // session must not see the congregation's whole turnout.
  const inScope = new Set(members.map((m) => m.id));
  const scoped = marks.filter((m) => inScope.has(m.member_id));

  const points = sundays.map((date: string) => {
    const onThatDay = scoped.filter((m) => m.service_date === date);
    return {
      date,
      preService: onThatDay.filter((m) => m.pre_service).length,
      service: onThatDay.filter((m) => m.service).length,
    };
  });

  /*
   * 需要关怀 — active, non-visitor members with no 主日 tick across the last
   * four Sundays.
   *
   * Four is "about a month away": long enough that a holiday or a bout of flu
   * does not flag somebody, short enough to still catch them early. It is
   * counted over the last four Sundays specifically, NOT the whole window the
   * chart draws, so widening the chart never widens who gets chased.
   *
   * `last_seen` is their most recent 主日 inside the window, or null for
   * "not in this window at all" — which is deliberately not the same claim as
   * "never came", since the window only reaches back so far.
   */
  const followUpWindow = sundays.slice(-4);
  const seenIn = new Set(
    scoped.filter((m) => m.service && followUpWindow.includes(m.service_date)).map((m) => m.member_id),
  );
  const lastSeenBy = new Map<string, string>();
  for (const m of scoped) {
    if (!m.service) continue;
    const prev = lastSeenBy.get(m.member_id);
    if (!prev || m.service_date > prev) lastSeenBy.set(m.member_id, m.service_date);
  }
  const groupNameById = new Map(groups.map((g) => [g.id, g.name]));
  const followUp = members
    .filter((m) => !seenIn.has(m.id))
    .map((m) => ({
      id: m.id,
      full_name: m.full_name,
      english_name: m.english_name,
      hall_id: m.hall_id,
      group_name: m.group_id ? (groupNameById.get(m.group_id) ?? null) : null,
      last_seen: lastSeenBy.get(m.id) ?? null,
    }))
    // Longest-absent first: never seen in the window, then oldest last_seen.
    .sort((a, b) => (a.last_seen ?? '').localeCompare(b.last_seen ?? ''));

  // 小组概况 — the health each group's own list already derives, counted here
  // so the page draws chips rather than re-deriving a roster count per group.
  const membersByGroup = new Map<string, { total: number; fresh: number }>();
  for (const m of members) {
    if (!m.group_id) continue;
    const bucket = membersByGroup.get(m.group_id) ?? { total: 0, fresh: 0 };
    bucket.total += 1;
    // A group's "new" member is its group POSITION, exactly as /groups' own
    // list counts it — never the church-wide role, which means something else.
    if (m.group_position === GroupPosition.NewMember) bucket.fresh += 1;
    membersByGroup.set(m.group_id, bucket);
  }
  const groupHealth = groups.map((g) => {
    const bucket = membersByGroup.get(g.id) ?? { total: 0, fresh: 0 };
    return { id: g.id, name: g.name, status: groupHealthStatus(bucket.total, bucket.fresh) };
  });

  return {
    sundays: points,
    follow_up: followUp,
    follow_up_sundays: followUpWindow,
    events,
    groups: groupHealth,
    active_members: members.length,
  };
}

/**
 * 聚会点名 — one month's sheet: the members down the left, and across the top
 * that month's Sundays followed, in date order, by every meeting someone added
 * for it.
 *
 * The columns come from the CALENDAR and from the meetings themselves, never
 * from the attendance data, so a Sunday nobody marked and a meeting nobody
 * ticked both still get their column. Two tables are read for the cells and
 * neither is named in the answer: each column carries the key a write quotes
 * back, and `lib/sheet.ts` is the one place that knows what a key means.
 *
 * `hallFilter` narrows it. Null means 全部堂会: every congregation's members in
 * one list, which is the simple thing to show when nobody has narrowed the
 * view. A tick is still filed under the member's own congregation (see the PUT
 * above), so what was recorded never loses its hall.
 *
 * `groupId` narrows it further, to one life group's roster: the Sunday half of
 * that group's roll-call card. The columns are then the month's Sundays alone —
 * the group's OWN meetings are its own half of that card, and a congregation
 * meeting is not the group's to roll. Nothing else changes, and in particular
 * NOT where a tick is stored: the group page quotes back the same column key
 * and lands in the same `sunday_attendance` row the services sheet writes. Two
 * doors, one record.
 *
 * The roster is read the way the group's own half reads it (`groupAttendance`
 * below) rather than with the sheet's usual 在册 filter: the card is ONE table,
 * so both halves have to be the same people or a row would mean two different
 * things across it.
 */
async function rollCallSheet(
  db: ReturnType<typeof getDb>,
  hallFilter: string | null,
  year: number,
  month: number,
  groupId: string | null = null,
) {
  // The month as MALAYSIA reads it: [1st 00:00, the 1st of the next month).
  // `churchInstant` normalises month 13 into January, so December needs no
  // special case.
  const monthStart = churchInstant(year, month, 1).toISOString();
  const monthEnd = churchInstant(year, month + 1, 1).toISOString();

  let memberQuery = db.from('members').select(MEMBER_BRIEF).order('full_name');
  if (groupId) memberQuery = memberQuery.eq('group_id', groupId);
  else memberQuery = memberQuery.eq('status', 'active');
  if (hallFilter) memberQuery = memberQuery.eq('hall_id', hallFilter);

  const readMeetings = async () => {
    // A group's card carries the group's own occasions beside these Sundays,
    // so the congregation's meetings have no column there.
    if (groupId) return [] as SheetMeeting[];
    let meetingQuery = db
      .from('events')
      .select('id,title,starts_at,location,hall_id')
      .gte('starts_at', monthStart)
      .lt('starts_at', monthEnd)
      .order('starts_at');
    // A narrowed view sees that hall's meetings plus every 全堂开放 one — the
    // same rule the events list itself follows.
    if (hallFilter) meetingQuery = meetingQuery.or(`hall_id.eq.${hallFilter},hall_id.is.null`);
    return unwrap(await meetingQuery) as SheetMeeting[];
  };

  // Independent reads, so they go together (rule G6).
  const [memberRes, meetings] = await Promise.all([memberQuery, readMeetings()]);
  const members = unwrap(memberRes) as Array<{ id: string; full_name: string; english_name: string | null; hall_id: string }>;

  const columns = sheetColumns(year, month, meetings);
  const sundays = columns.filter((c) => c.kind === 'sunday').map((c) => c.date);
  const eventIds = meetings.map((m) => m.id);

  const readSundayMarks = async () => {
    if (!sundays.length) return [];
    let query = db
      .from('sunday_attendance')
      .select('service_date,member_id,pre_service,service')
      .gte('service_date', sundays[0])
      .lte('service_date', sundays[sundays.length - 1]);
    if (hallFilter) query = query.eq('hall_id', hallFilter);
    return unwrap(await query) as Array<{
      service_date: string;
      member_id: string;
      pre_service: boolean;
      service: boolean;
    }>;
  };
  const readMeetingMarks = async () => {
    if (!eventIds.length) return [];
    return unwrap(
      await db.from('event_attendance').select('event_id,member_id,status').in('event_id', eventIds),
    ) as Array<{ event_id: string; member_id: string; status: string }>;
  };

  const [sundayMarks, meetingMarks] = await Promise.all([readSundayMarks(), readMeetingMarks()]);

  const byMember = new Map<string, Record<string, SheetCell>>();
  const cellOf = (memberId: string, key: string): SheetCell => {
    const cells = byMember.get(memberId) ?? {};
    byMember.set(memberId, cells);
    cells[key] = cells[key] ?? {};
    return cells[key];
  };

  for (const m of sundayMarks) {
    const cell = cellOf(m.member_id, sundayColumnKey(m.service_date.slice(0, 10)));
    // OR-merged rather than assigned: with no narrowing, someone who moved
    // congregation mid-year can carry a row in each hall for the same Sunday,
    // and a tick that was taken must not disappear because of the other row.
    cell.pre_service = cell.pre_service || m.pre_service;
    cell.service = cell.service || m.service;
  }
  for (const a of meetingMarks) {
    // A meeting column is one tick: was this person there. Rows left by the
    // old 出席/请假/缺席 roll call that say anything else are "not present".
    if (a.status !== 'present') continue;
    cellOf(a.member_id, meetingColumnKey(a.event_id)).attended = true;
  }

  return {
    hall_id: hallFilter,
    columns,
    rows: members.map((member) => ({ member, cells: byMember.get(member.id) ?? {} })),
  };
}

async function groupAttendance(db: ReturnType<typeof getDb>, groupId: string) {
  const meetings = unwrap(
    await db
      .from('group_meetings')
      .select('id, meeting_date')
      .eq('group_id', groupId)
      .order('meeting_date'),
  ) as Array<{ id: string; meeting_date: string }>;

  const members = unwrap(
    await db
      .from('members')
      .select(MEMBER_BRIEF)
      .eq('group_id', groupId)
      .order('full_name'),
  ) as Array<{ id: string; full_name: string; english_name: string | null; hall_id: string }>;

  const meetingIds = meetings.map((m) => m.id);
  const att = meetingIds.length
    ? (unwrap(
        await db
          .from('group_attendance')
          .select('meeting_id, member_id, status')
          .in('meeting_id', meetingIds),
      ) as Array<{ meeting_id: string; member_id: string; status: string }>)
    : [];

  const map = new Map<string, string>();
  for (const a of att) map.set(`${a.meeting_id}:${a.member_id}`, a.status);

  const rows = members.map((m) => ({
    member: m,
    cells: meetings.map((mt) => ({
      meeting_id: mt.id,
      status: map.get(`${mt.id}:${m.id}`) ?? null,
    })),
  }));
  return { meetings, rows };
}

/**
 * Every 幸福小组 term, newest first, each carrying how many groups run inside
 * it — ONE extra query for the whole list rather than one per row (rule G6),
 * so the term list and its delete confirmation both read a real count instead
 * of an N+1 client-side fetch.
 */
async function happinessTerms(db: ReturnType<typeof getDb>) {
  const [termsRes, groupsRes] = await Promise.all([
    db.from('happiness_terms').select('*').order('term_no', { ascending: false }),
    db.from('happiness_groups').select('id, term_id'),
  ]);
  const terms = unwrap<Array<Record<string, unknown>>>(termsRes);
  const groups = unwrap<Array<{ id: string; term_id: string }>>(groupsRes);
  const counts = new Map<string, number>();
  for (const g of groups) counts.set(g.term_id, (counts.get(g.term_id) ?? 0) + 1);
  return terms.map((t) => ({ ...t, group_count: counts.get(t.id as string) ?? 0 }));
}

/**
 * The same "count once, for the whole list" shape for a group's roster size —
 * read by the group list and by its own delete confirmation.
 */
async function withRosterCounts(
  db: ReturnType<typeof getDb>,
  groups: Array<Record<string, unknown>>,
) {
  if (groups.length === 0) return [];
  const ids = groups.map((g) => g.id as string);
  const rosterRows = unwrap<Array<{ group_id: string }>>(
    await db.from('happiness_group_members').select('group_id').in('group_id', ids),
  );
  const counts = new Map<string, number>();
  for (const r of rosterRows) counts.set(r.group_id, (counts.get(r.group_id) ?? 0) + 1);
  return groups.map((g) => ({ ...g, roster_count: counts.get(g.id as string) ?? 0 }));
}

/** One 幸福小组's detail: its own record plus its roster, both names included
 *  (rule G4 — every roster embeds `MEMBER_BRIEF`, never `full_name` alone). */
async function happinessGroupDetail(db: ReturnType<typeof getDb>, groupId: string) {
  const [groupRes, rosterRes] = await Promise.all([
    db.from('happiness_groups').select(HAPPINESS_GROUP_SELECT).eq('id', groupId).single(),
    db
      .from('happiness_group_members')
      .select(`role, member:members(${MEMBER_BRIEF})`)
      .eq('group_id', groupId)
      .order('created_at'),
  ]);
  const group = unwrap<Record<string, unknown>>(groupRes);
  // The embed's cardinality (one member per roster row) is a runtime fact
  // PostgREST gets right; the untyped client's own select-string parser
  // cannot know it without generated Database types, so it is force-cast
  // here rather than fought with a narrower generic on `unwrap`.
  const rosterRows = unwrap(rosterRes) as unknown as Array<{
    role: string | null;
    member: Record<string, unknown> | null;
  }>;
  // Guarded (rule G6): a roster row whose member was somehow left dangling
  // would otherwise crash the page instead of just being one fewer name.
  // `happiness_group_members.role` (0027) is still SELECTED and still stored,
  // but nothing draws it any more: the church asked for the roster's own role
  // column back out, since who is a 福友 is answered by `church_role` being
  // 访客 (0021) and everyone else needed no label at all. The column is left in
  // the database rather than dropped, because whatever a leader already typed
  // into it is theirs and a migration would throw it away.
  const members = rosterRows
    .filter((r): r is { role: string | null; member: Record<string, unknown> } => !!r.member)
    .map((r) => ({ ...r.member, happiness_role: r.role }));
  return { ...group, members };
}

/**
 * One group's whole roll call: `weeks` (the TERM's own length, read off the
 * group's `term`) and the flat list of `{ week_number, member_id }` pairs that
 * are actually recorded. Presence-only (0022) — a pair's absence from
 * `records` means "not marked", never "absent"; the page builds its own
 * member × week matrix from the roster it already has plus this list.
 */
async function happinessAttendance(db: ReturnType<typeof getDb>, groupId: string) {
  const group = unwrap<{ term: { weeks: number } | null }>(
    await db
      .from('happiness_groups')
      .select('term:happiness_terms(weeks)')
      .eq('id', groupId)
      .single(),
  );
  const records = unwrap<Array<{ week_number: number; member_id: string }>>(
    await db.from('happiness_attendance').select('week_number, member_id').eq('group_id', groupId),
  );
  return { weeks: group.term?.weeks ?? 8, records };
}

/**
 * ONE week, for a LIST of members — the same shape the services sheet's
 * column write takes (`member_ids` general, `member_id` its singular alias),
 * so a single cell and a whole-column 全员到齐 go down the same path. `present`
 * decides the direction: true upserts (marking present when already present
 * is a no-op — `ignoreDuplicates`), false DELETES those rows, which is what an
 * untick means for a presence-only table (0022).
 *
 * `week_number` is checked against the TERM's own `weeks`, not the database's
 * blanket 1..52 — a week 9 tick on an 8-week term is refused with a clear 400
 * rather than silently accepted by the looser table constraint.
 */
async function putHappinessAttendance(
  db: ReturnType<typeof getDb>,
  groupId: string,
  dto: Record<string, unknown>,
) {
  const weekNumber = Math.trunc(Number(dto.week_number));
  if (!Number.isInteger(weekNumber) || weekNumber < 1)
    throw new HttpError(400, 'week_number must be a positive integer');

  const group = unwrap<{ term: { weeks: number } | null }>(
    await db
      .from('happiness_groups')
      .select('term:happiness_terms(weeks)')
      .eq('id', groupId)
      .single(),
  );
  const termWeeks = group.term?.weeks ?? 8;
  if (weekNumber > termWeeks)
    throw new HttpError(400, `week_number must be between 1 and ${termWeeks} for this term`);

  const asked = Array.isArray(dto.member_ids)
    ? dto.member_ids
    : dto.member_id !== undefined
      ? [dto.member_id]
      : [];
  const memberIds = [...new Set(asked.map((v) => String(v ?? '')).filter(Boolean))];
  if (memberIds.length === 0)
    throw new HttpError(400, 'member_id (or a non-empty member_ids) is required');
  if (memberIds.length > 1000)
    throw new HttpError(400, 'Too many members in one write — 1000 at most');

  const present = dto.present !== false;
  if (present) {
    unwrap(
      await db
        .from('happiness_attendance')
        .upsert(
          memberIds.map((id) => ({ group_id: groupId, member_id: id, week_number: weekNumber })),
          { onConflict: 'group_id,member_id,week_number', ignoreDuplicates: true },
        )
        .select('id'),
    );
  } else {
    unwrap(
      await db
        .from('happiness_attendance')
        .delete()
        .eq('group_id', groupId)
        .eq('week_number', weekNumber)
        .in('member_id', memberIds)
        .select('id'),
    );
  }
  return { week_number: weekNumber, member_ids: memberIds, count: memberIds.length, present };
}

/**
 * What the PUBLIC sign-up page (`/enroll/:id`) is told about a training.
 *
 * An explicit list, never `*`: this endpoint answers with no session at all, so
 * every column it hands out is a deliberate decision. What is here is what a
 * visitor needs in order to decide and to pay — which shape it is, when and
 * where, who to ring, and the 报名费 with the instructions and QR to settle it.
 */
const PUBLIC_TRAINING_SELECT =
  'id,name,kind,is_enrollable,total_sessions,starts_on,ends_on,start_time,location,pic,pic_contact,gender,fee,payment_instructions,payment_qr_url';

type PublicTraining = {
  id: string;
  name: string;
  kind: string;
  is_enrollable: boolean;
  total_sessions: number;
  starts_on: string | null;
  ends_on: string | null;
  start_time: string | null;
  location: string | null;
  pic: string | null;
  pic_contact: string | null;
  /** null = open to everyone; else the sign-up is refused for a mismatch (0024). */
  gender: string | null;
  fee: string | number | null;
  payment_instructions: string | null;
  payment_qr_url: string | null;
};

/** Does this training charge? `numeric` comes back as a string from PostgREST. */
function isPaid(fee: string | number | null | undefined): boolean {
  return fee !== null && fee !== undefined && Number(fee) > 0;
}

/**
 * Normalize a 培训&活动 create/update payload.
 *
 * What the server owns rather than trusting the client with (rule G2):
 *  - `kind` must be one the app actually ships. The table's CHECK would refuse
 *    anything else too, but a constraint name is not an answer anybody can act
 *    on — and a stale client must not be able to park a row on a third shape.
 *  - an activity is ONE occasion, so its `total_sessions` is 1 whatever was
 *    sent, and it ends on the day it starts. That is the invariant the single
 *    auto-created session stands on.
 *  - `fee` is money: a blank field means FREE (null), and a negative number is
 *    a typo rather than a discount. The table's CHECK says the same; this says
 *    it in words.
 *  - the free-text fields are trimmed, and an empty one is stored as null, so
 *    "has a PIC" is one question rather than two.
 */
function trainingWrite(
  dto: Record<string, unknown>,
  opts: { applyKindEffects?: boolean } = {},
): Record<string, unknown> {
  // A junk `kind` is always refused, on both POST and PATCH — but the
  // activity-shape side effects below (forcing total_sessions to 1, ends_on
  // to starts_on) only make sense at CREATION. `kind` is fixed after that
  // (0024), so an edit still gets the same validation but never the
  // mutation — the PATCH handler deletes `kind` from the result afterward,
  // and must not have this quietly truncated total_sessions on its way there.
  const applyKindEffects = opts.applyKindEffects ?? true;
  const patch = { ...dto };
  if (patch.kind !== undefined) {
    if (!isTrainingKind(patch.kind))
      throw new HttpError(400, `Unknown kind: ${String(patch.kind)} — expected course or activity`);
    if (applyKindEffects && patch.kind === TrainingKind.Activity) {
      patch.total_sessions = 1;
      // One occasion: the same day twice, so "has it finished?" stays one
      // question for both shapes and there is no second date to edit.
      if (patch.starts_on !== undefined) patch.ends_on = patch.starts_on;
    }
  }
  if ('fee' in patch) {
    const raw = patch.fee;
    if (raw === null || raw === undefined || String(raw).trim() === '') patch.fee = null;
    else {
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount < 0)
        throw new HttpError(400, 'The sign-up fee must be a number of 0 or more');
      patch.fee = amount;
    }
  }
  // '' (the form's "open to all" option) stores NULL, same as every other
  // optional select in this app. The column is the same gender_type
  // members.gender uses, so the database enforces the value shape; the form
  // just never offers 'other' as a choice (see TrainingModal.tsx).
  if ('gender' in patch && patch.gender === '') patch.gender = null;
  // 活动分类 is a fixed, short list (0027) — free text would never roll up
  // into a dashboard summary, so a value that isn't one of the six is
  // refused rather than silently stored.
  if ('category' in patch) {
    if (patch.category === '' || patch.category === null || patch.category === undefined) patch.category = null;
    else if (!isTrainingCategory(patch.category))
      throw new HttpError(400, `Unknown category: ${String(patch.category)}`);
  }
  for (const key of ['pic', 'pic_contact', 'location', 'payment_instructions', 'payment_qr_url', 'start_time'] as const) {
    if (key in patch) {
      const value = String(patch[key] ?? '').trim();
      patch[key] = value === '' ? null : value;
    }
  }
  return patch;
}

/**
 * An ACTIVITY is one occasion, and that occasion IS exactly one
 * `training_sessions` row — the single column its roll call ticks.
 *
 * Called once, when an activity is created (`kind` is fixed after that, 0024
 * — there is no longer a conversion path that would need to call this a
 * second time). Sessions beyond the first are deleted, which takes their
 * attendance with them (`training_attendance.session_id` is `on delete
 * cascade`) — relevant only if a row is ever inserted with more than one
 * session already attached, which nothing in this app does, but the
 * invariant is enforced here rather than assumed.
 */
async function ensureSingleSession(db: ReturnType<typeof getDb>, trainingId: string) {
  const sessions = unwrap<Array<{ id: string; session_number: number }>>(
    await db
      .from('training_sessions')
      .select('id,session_number')
      .eq('training_id', trainingId)
      .order('session_number'),
  );
  if (sessions.length === 0) {
    unwrap(
      await db
        .from('training_sessions')
        .insert({ training_id: trainingId, session_number: 1 })
        .select('id')
        .single(),
    );
    return;
  }
  const extra = sessions.slice(1).map((s) => s.id);
  if (extra.length > 0)
    unwrap(await db.from('training_sessions').delete().in('id', extra).select('id'));
}

/* -------------------------------------------------------------------------
 * Uploads
 *
 * Four surfaces put a file in a public bucket — a member's photo, the church
 * logo, a training's payment QR and a payment receipt — and they all go the
 * same way (rule G4): validate the file HERE, write it with the service role,
 * store the resulting public URL on the row. Only the rule differs, because
 * only the rule should: a receipt may be a PDF, an avatar may not.
 * ---------------------------------------------------------------------- */

type UploadRule = {
  maxBytes: number;
  accepts: (contentType: string) => boolean;
  typeError: string;
  sizeError: string;
};

/** Avatars, the church logo, a payment QR — an image, 5MB at most. */
const IMAGE_UPLOAD: UploadRule = {
  maxBytes: 5 * 1024 * 1024,
  accepts: (type) => type.startsWith('image/'),
  typeError: 'Only image files are supported',
  sizeError: 'The image must be 5MB or smaller',
};

/**
 * A payment receipt: a photo of a transfer, or the PDF a banking app produces.
 *
 * An explicit list rather than `image/*` — this is the one upload path with NO
 * session behind it, so it accepts exactly the formats a receipt actually comes
 * in. `image/svg+xml` is deliberately absent: an SVG is a script that renders,
 * and these objects are served from a public bucket.
 */
const SLIP_TYPES = [
  'image/jpeg',
  'image/pjpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'application/pdf',
];
const SLIP_UPLOAD: UploadRule = {
  maxBytes: 5 * 1024 * 1024,
  accepts: (type) => SLIP_TYPES.includes(type),
  typeError:
    'The receipt must be a photo (JPG, PNG, WEBP, GIF or HEIC) or a PDF',
  sizeError: 'The receipt must be 5MB or smaller',
};

/**
 * A photo of a person sent by a STRANGER — the public /join form.
 *
 * Deliberately NOT `IMAGE_UPLOAD`: that one accepts any `image/*`, which
 * includes `image/svg+xml`, and an SVG is a script that renders. The other
 * three upload surfaces are behind a session; this one is not, and its objects
 * are served from a public bucket. So it takes the same explicit list a receipt
 * does, minus the PDF — a PDF is not a photograph of a face.
 */
const PHOTO_UPLOAD: UploadRule = {
  maxBytes: 5 * 1024 * 1024,
  accepts: (type) => SLIP_TYPES.includes(type) && type !== 'application/pdf',
  typeError: 'The photo must be a JPG, PNG, WEBP, GIF or HEIC image',
  sizeError: 'The photo must be 5MB or smaller',
};

/**
 * The uploaded file, or a 400 that says what was wrong in words a person can
 * act on. Both checks happen BEFORE the bytes are read, so an oversized upload
 * is refused rather than buffered.
 */
function checkedFile(value: FormDataEntryValue | File | null, rule: UploadRule): File {
  if (!(value instanceof File) || value.size === 0) throw new HttpError(400, 'No file uploaded');
  if (!rule.accepts((value.type || '').toLowerCase())) throw new HttpError(400, rule.typeError);
  if (value.size > rule.maxBytes) throw new HttpError(400, rule.sizeError);
  return value;
}

/** A safe extension for the stored object — never the uploaded name itself. */
function fileExt(file: File, fallback: string): string {
  return (file.name.split('.').pop() || fallback).toLowerCase().replace(/[^a-z0-9]/g, '') || fallback;
}

/** Write a validated file into a public bucket and return its public URL. */
async function storeFile(
  db: ReturnType<typeof getDb>,
  bucket: string,
  path: string,
  file: File,
): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const up = await db.storage
    .from(bucket)
    .upload(path, bytes, { contentType: file.type || 'application/octet-stream', upsert: true });
  if (up.error) throw new HttpError(500, up.error.message);
  return db.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

async function namelist(db: ReturnType<typeof getDb>, trainingId: string) {
  const enrollments = unwrap(
    await db
      .from('training_enrollments')
      .select(`id, member:members(${MEMBER_BRIEF})`)
      .eq('training_id', trainingId)
      .in('status', ['approved', 'in_progress', 'completed'])
      .order('id'),
  ) as unknown as Array<{ id: string; member: { id: string } }>;

  const sessions = unwrap(
    await db
      .from('training_sessions')
      .select('id, session_number, title, scheduled_at')
      .eq('training_id', trainingId)
      .order('session_number'),
  ) as Array<{ id: string; session_number: number }>;

  const sessionIds = sessions.map((s) => s.id);
  const attendance = sessionIds.length
    ? (unwrap(
        await db
          .from('training_attendance')
          .select('session_id, member_id, attended')
          .in('session_id', sessionIds),
      ) as Array<{ session_id: string; member_id: string; attended: boolean }>)
    : [];

  const attMap = new Map<string, boolean>();
  for (const a of attendance) attMap.set(`${a.session_id}:${a.member_id}`, a.attended);

  const rows = enrollments.map((e) => ({
    member: e.member,
    attendance: sessions.map((s) => ({
      session_id: s.id,
      session_number: s.session_number,
      attended: attMap.get(`${s.id}:${e.member.id}`) ?? false,
    })),
  }));

  return { sessions, rows };
}

// --- Auth routes ------------------------------------------------------------

async function authRoute(
  method: string,
  req: Request,
  p: string[],
  db: ReturnType<typeof getDb>,
): Promise<Response> {
  if (p[1] === 'login' && method === 'POST') {
    const dto = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
    const res = await db
      .from('app_users')
      .select('id, email, account_role, status, hall_id, group_id, password_hash, member:members(id,full_name)')
      .eq('email', (dto.email ?? '').toLowerCase().trim())
      .maybeSingle();
    if (res.error) throw new HttpError(500, res.error.message);
    const user = res.data as {
      id: string;
      email: string;
      account_role: string;
      status: string;
      hall_id: string | null;
      group_id: string | null;
      password_hash: string | null;
      member: { id: string; full_name: string } | null;
    } | null;
    if (!user || user.status !== 'active') throw new HttpError(401, 'The account does not exist or has been disabled');
    const ok = await verifyPassword(dto.password ?? '', user.password_hash);
    if (!ok) throw new HttpError(401, 'Incorrect email or password');
    await db
      .from('app_users')
      .update({ last_sign_in_at: new Date().toISOString() })
      .eq('id', user.id);
    const name = user.member?.full_name ?? user.email;
    const token = await signSession({
      sub: user.id,
      role: user.account_role,
      member: user.member?.id ?? null,
      hall: user.hall_id ?? null,
      group: user.group_id ?? null,
      name,
    });
    return new Response(
      JSON.stringify({ id: user.id, email: user.email, account_role: user.account_role, name }),
      { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie(token) } },
    );
  }
  if (p[1] === 'logout' && method === 'POST') {
    return new Response(null, { status: 204, headers: { 'set-cookie': clearCookie() } });
  }
  // Self-service profile — the one write path every signed-in account has to
  // its OWN record (a read-only account included). See selfProfileRoute.
  if (p[1] === 'me' && p[2] === 'profile' && !p[3]) return selfProfileRoute(method, req, db);
  if (p[1] === 'me' && !p[2] && method === 'GET') {
    const s = await getSession(req);
    if (!s) throw new HttpError(401, 'Not signed in');
    // The interface language is read live rather than baked into the session
    // cookie, so changing it in 用户管理 takes effect on the next page load
    // instead of only after signing out and back in.
    const row = (
      await db.from('app_users').select('language').eq('id', s.sub).maybeSingle()
    ).data as { language: string | null } | null;
    return json({
      id: s.sub,
      role: s.role,
      member: s.member,
      hall: s.hall ?? null,
      group: s.group ?? null,
      name: s.name,
      language: normalizeLanguage(row?.language),
    });
  }
  // Self-service password change — any logged-in user, verifies the old password.
  if (p[1] === 'password' && method === 'POST') {
    const s = await getSession(req);
    if (!s) throw new HttpError(401, 'Not signed in');
    const dto = (await req.json().catch(() => ({}))) as { current?: string; password?: string };
    const next = String(dto.password ?? '');
    if (next.length < 8) throw new HttpError(400, 'The new password must be at least 8 characters');
    const cur = unwrap(
      await db.from('app_users').select('password_hash').eq('id', s.sub).single(),
    ) as { password_hash: string | null };
    if (!(await verifyPassword(dto.current ?? '', cur.password_hash)))
      throw new HttpError(401, 'The current password is incorrect');
    unwrap(
      await db
        .from('app_users')
        .update({ password_hash: await hashPassword(next) })
        .eq('id', s.sub)
        .select('id')
        .single(),
    );
    return json({ ok: true });
  }
  throw new HttpError(404, `No auth route for ${method} /api/${p.join('/')}`);
}

// --- Self-service profile (/auth/me/profile) --------------------------------

/**
 * The ONLY fields a signed-in account may write on its own records, split by
 * the table they land in. Everything else is refused — see selfProfileRoute.
 *
 * `account_role`, `hall_id` and `status` are deliberately absent, and so is
 * every other `app_users` column: the list is an allow-list, so a column added
 * to the table later stays unwritable until someone puts it here on purpose.
 */
const SELF_MEMBER_FIELDS = [
  'full_name',
  'english_name',
  'email',
  'phone',
  // Where they live is theirs to keep current, exactly like their phone number.
  // `referred_by` is not: who brought somebody into the church is the church's
  // record of how they arrived, not something a person asserts about themselves.
  'address',
  'gender',
  'date_of_birth',
] as const;
const SELF_ACCOUNT_FIELDS = ['language'] as const;

/** The signed-in account plus its linked member — always read by account id. */
async function readSelfProfile(db: ReturnType<typeof getDb>, accountId: string) {
  const account = unwrap<Record<string, unknown> & { member_id: string | null }>(
    await db
      .from('app_users')
      .select(
        'id,member_id,email,account_role,hall_id,status,language,last_sign_in_at, hall:halls(id,name)',
      )
      .eq('id', accountId)
      .single(),
  );
  const member = account.member_id
    ? unwrap(await db.from('members').select(MEMBER_SELECT).eq('id', account.member_id).single())
    : null;
  return { ...account, language: normalizeLanguage(account.language as string | null), member };
}

/**
 * `GET`/`PATCH /api/auth/me/profile` — a user reading and editing their own
 * account and member record, and the one exception to "a read-only account
 * cannot make changes".
 *
 * It lives under `/auth` (dispatched ahead of the role gate) and is safe by
 * construction rather than by a chain of `if`s a later edit could miss
 * (rule G2):
 *
 *  1. **Whose row** comes from the signed session cookie — `s.sub` for the
 *     account, and the `member_id` read off that account row for the member.
 *     No id is taken from the URL or the body, so there is no request shape
 *     that can address somebody else's record. Nothing here widens `/accounts`,
 *     which stays super_admin-only for reads and writes.
 *  2. **Which fields** come from the allow-lists above, and an unknown key is
 *     a 403 rather than a silent drop — so `account_role`, `hall_id` and
 *     `status` are refused loudly and a read-only account cannot promote
 *     itself, move congregation, or re-enable a disabled login.
 */
async function selfProfileRoute(
  method: string,
  req: Request,
  db: ReturnType<typeof getDb>,
): Promise<Response> {
  const s = await getSession(req);
  if (!s) throw new HttpError(401, 'Not signed in');
  if (method === 'GET') return json(await readSelfProfile(db, s.sub));
  if (method !== 'PATCH') throw new HttpError(404, `No route for ${method} /api/auth/me/profile`);

  const dto = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const memberPatch: Record<string, unknown> = {};
  const accountPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dto)) {
    if ((SELF_MEMBER_FIELDS as readonly string[]).includes(key)) memberPatch[key] = value;
    else if ((SELF_ACCOUNT_FIELDS as readonly string[]).includes(key)) accountPatch[key] = value;
    else throw new HttpError(403, `You may not change ${key} on your own profile`);
  }

  // Read the account first: its `member_id` — not the session's cached copy —
  // decides which member row this may touch.
  const account = unwrap(
    await db.from('app_users').select('member_id').eq('id', s.sub).single<{ member_id: string | null }>(),
  );

  if ('email' in memberPatch) {
    const email = normalizeEmail(memberPatch.email);
    if (!email) throw new HttpError(400, 'Your email is also your sign-in name and cannot be removed');
    memberPatch.email = email;
    // The login email always mirrors the member's own email (the same rule
    // accountWrite enforces on the admin path), so move both together.
    accountPatch.email = email;
    // app_users.email is unique. Checked before either write so a clash leaves
    // nothing half-saved; the 23505 mapping below still covers the race.
    const clash = unwrap<Array<{ id: string }>>(
      await db.from('app_users').select('id').eq('email', email).neq('id', s.sub),
    );
    if (clash.length > 0)
      throw new HttpError(409, 'That email already belongs to another login account');
  }
  if (accountPatch.language !== undefined) assertSupportedLanguage(accountPatch.language);

  if (Object.keys(memberPatch).length > 0) {
    if (!account.member_id)
      throw new HttpError(400, 'This account is not linked to a member profile');
    unwrap(
      await db.from('members').update(memberPatch).eq('id', account.member_id).select('id').single(),
    );
  }
  if (Object.keys(accountPatch).length > 0) {
    const res = await db.from('app_users').update(accountPatch).eq('id', s.sub).select('id').single();
    // app_users.email is unique — a clash is the user's mistake, not a 500.
    if (res.error?.code === '23505')
      throw new HttpError(409, 'That email already belongs to another login account');
    unwrap(res);
  }
  return json(await readSelfProfile(db, s.sub));
}

/** Sign-in matches on a lower-cased address, so stored emails are too. */
function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Only the three shipped interface languages may be stored, so a stale client
 * (or a hand-rolled request) can never park an account on a language the app
 * has no dictionary for.
 */
function assertSupportedLanguage(value: unknown): void {
  if (!(LANGUAGES as readonly string[]).includes(String(value)))
    throw new HttpError(400, `Unsupported language: ${String(value)}`);
}

/**
 * Normalize an account create/update payload: a plaintext `password` field is
 * hashed into `password_hash` and stripped, so passwords are never stored raw.
 */
// An account's login email always mirrors its linked member's own email — it
// is never independently settable, even via a direct API call — so silently
// drop whatever `email` the caller sent and re-derive it from `members`.
async function accountWrite(
  db: ReturnType<typeof getDb>,
  body: Record<string, unknown>,
  opts: { existingMemberId?: string } = {},
): Promise<Record<string, unknown>> {
  const { password, email: _email, ...rest } = body;
  if (typeof password === 'string' && password.length > 0) {
    if (password.length < 8) throw new HttpError(400, 'The password must be at least 8 characters');
    rest.password_hash = await hashPassword(password);
  }
  const memberId = (rest.member_id as string | undefined) ?? opts.existingMemberId;
  if (memberId) {
    const member = unwrap(
      await db.from('members').select('email').eq('id', memberId).single<{ email: string | null }>(),
    );
    if (!member.email) throw new HttpError(400, 'This member has no email yet \u2014 add one to their profile first');
    rest.email = normalizeEmail(member.email);
  }
  if (rest.language !== undefined) assertSupportedLanguage(rest.language);
  return rest;
}

/**
 * What `syncGroupLeaderAccount` did, and — for `created` — the ONE place a
 * generated password's plaintext is ever available. `moved`/`noop` are
 * reported for completeness but nothing on screen needs them; the three
 * others are surfaced to the client (see `leaderEventForClient`).
 */
type LeaderAccountEvent =
  | { event: 'created'; email: string; password: string }
  | { event: 'disabled'; email: string }
  | { event: 'skipped_no_email' }
  | { event: 'unchanged_existing_account' }
  | { event: 'moved' }
  | { event: 'noop' };

/**
 * Keeps a group's 小组长 (`GroupPosition.Leader`) in sync with an
 * auto-provisioned `group_leader` login — grant on promotion, disable on
 * demotion. This IS the sync mechanism (there is no trigger): every write
 * surface that can change a member's `group_position` — `POST /members`,
 * `PATCH /members/:id`, and `applyImport()`'s insert/update loop — calls it
 * with the position and group as they were immediately before this write and
 * as they are after it.
 *
 * It only ever touches an account it would itself have created: a `member_id`
 * that already has ANY login (whatever its role) is left completely alone on
 * promotion — this mechanism manages what it manages, and silently
 * upgrading/touching a human-set-up account that happens to belong to
 * somebody who also leads a group would be a surprising side effect, not a
 * feature. Symmetrically, demotion only ever disables an account whose role
 * is specifically `group_leader` — never a super_admin/admin/coworker/
 * readonly account, even one belonging to a former leader.
 */
async function syncGroupLeaderAccount(
  db: ReturnType<typeof getDb>,
  params: {
    memberId: string;
    previousPosition: string | null;
    newPosition: string | null;
    /** The member's group BEFORE this write — used only to tell "stayed in
     *  the same group" apart from "moved to a different one" while staying
     *  leader; every other case is decided by position alone. */
    previousGroupId: string | null;
    /** The member's group AFTER this write; null if removed from a group
     *  entirely. */
    groupId: string | null;
  },
): Promise<LeaderAccountEvent> {
  const { memberId, previousPosition, newPosition, previousGroupId, groupId } = params;
  const wasLeader = previousPosition === GroupPosition.Leader;
  const isLeader = newPosition === GroupPosition.Leader;

  // Never was and still isn't, or was already leader and stays leader of the
  // SAME group: nothing for this mechanism to do. Checked before touching the
  // database at all — this is the overwhelmingly common case (an ordinary
  // profile edit that has nothing to do with leadership).
  if (!wasLeader && !isLeader) return { event: 'noop' };
  if (wasLeader && isLeader && previousGroupId === groupId) return { event: 'noop' };

  const accountRes = await db
    .from('app_users')
    .select('id,account_role,status')
    .eq('member_id', memberId)
    .maybeSingle();
  if (accountRes.error) throw new HttpError(500, accountRes.error.message);
  const existingAccount = accountRes.data as { id: string; account_role: string; status: string } | null;

  // ---- Becoming 小组长 -------------------------------------------------------
  if (!wasLeader && isLeader) {
    // A DISABLED account of our own making is not "existing" in the sense
    // that matters here — it is exactly the account this mechanism itself
    // turned off on a previous demotion, and re-promoting the same person
    // must not leave them locked out forever with no way back in. Its old
    // password is unrecoverable (only ever the hash was kept, rule G6), so
    // re-enabling it also issues a fresh one, same as a brand-new account.
    if (existingAccount) {
      if (existingAccount.account_role !== AccountRole.GroupLeader || existingAccount.status !== AccountStatus.Disabled)
        return { event: 'unchanged_existing_account' };
      if (!groupId) return { event: 'noop' };
      const member = unwrap<{ email: string | null }>(
        await db.from('members').select('email').eq('id', memberId).single(),
      );
      if (!member.email) return { event: 'skipped_no_email' };
      const email = normalizeEmail(member.email);
      const group = unwrap<{ hall_id: string }>(
        await db.from('groups').select('hall_id').eq('id', groupId).single(),
      );
      const password = generateRandomPassword();
      unwrap(
        await db
          .from('app_users')
          .update({
            email,
            status: AccountStatus.Active,
            hall_id: group.hall_id,
            group_id: groupId,
            password_hash: await hashPassword(password),
          })
          .eq('id', existingAccount.id)
          .select('id')
          .single(),
      );
      return { event: 'created', email, password };
    }
    // A leader with no group at all is not a state the UI can produce, but a
    // raw API call could send one — nothing to scope an account to, so this
    // is a no-op rather than a half-provisioned account.
    if (!groupId) return { event: 'noop' };
    const member = unwrap<{ email: string | null }>(
      await db.from('members').select('email').eq('id', memberId).single(),
    );
    if (!member.email) return { event: 'skipped_no_email' };
    const email = normalizeEmail(member.email);
    const group = unwrap<{ hall_id: string }>(
      await db.from('groups').select('hall_id').eq('id', groupId).single(),
    );
    const password = generateRandomPassword();
    unwrap(
      await db
        .from('app_users')
        .insert({
          member_id: memberId,
          email,
          account_role: AccountRole.GroupLeader,
          status: AccountStatus.Active,
          hall_id: group.hall_id,
          group_id: groupId,
          // Hashed immediately, exactly as `accountWrite` hashes a
          // human-chosen password — the plaintext above is returned to the
          // caller and never written anywhere (rule G6).
          password_hash: await hashPassword(password),
        })
        .select('id')
        .single(),
    );
    return { event: 'created', email, password };
  }

  // ---- Leaving 小组长 (including the group being cleared entirely) ----------
  if (wasLeader && !isLeader) {
    if (!existingAccount || existingAccount.account_role !== AccountRole.GroupLeader) return { event: 'noop' };
    const member = unwrap<{ email: string | null }>(
      await db.from('members').select('email').eq('id', memberId).single(),
    );
    unwrap(
      await db
        .from('app_users')
        .update({ status: AccountStatus.Disabled, group_id: null })
        .eq('id', existingAccount.id)
        .select('id')
        .single(),
    );
    return { event: 'disabled', email: member.email ?? '' };
  }

  // ---- Staying 小组长, but of a DIFFERENT group ------------------------------
  if (!existingAccount || existingAccount.account_role !== AccountRole.GroupLeader) return { event: 'noop' };
  if (!groupId) return { event: 'noop' };
  const group = unwrap<{ hall_id: string }>(
    await db.from('groups').select('hall_id').eq('id', groupId).single(),
  );
  unwrap(
    await db
      .from('app_users')
      .update({ group_id: groupId, hall_id: group.hall_id })
      .eq('id', existingAccount.id)
      .select('id')
      .single(),
  );
  return { event: 'moved' };
}

/**
 * Which of `syncGroupLeaderAccount`'s events the CLIENT needs to know about —
 * `moved`/`noop`/`unchanged_existing_account` are internal bookkeeping with
 * nothing for a person to act on. Shared by every write surface that merges
 * `leader_account_event` onto its response, so the three that matter can
 * never drift from one call site to the next.
 */
function leaderEventForClient(
  event: LeaderAccountEvent | undefined,
): Extract<LeaderAccountEvent, { event: 'created' | 'disabled' | 'skipped_no_email' }> | undefined {
  if (event && (event.event === 'created' || event.event === 'disabled' || event.event === 'skipped_no_email'))
    return event;
  return undefined;
}

// --- HTTP method entry points ----------------------------------------------

async function run(method: string, req: Request, ctx: Ctx): Promise<Response> {
  try {
    return await dispatch(method, req, ctx);
  } catch (e) {
    if (e instanceof HttpError) return json({ message: e.message }, e.status);
    return json({ message: (e as Error).message ?? 'Internal error' }, 500);
  }
}

export const GET = (req: Request, ctx: Ctx) => run('GET', req, ctx);
export const POST = (req: Request, ctx: Ctx) => run('POST', req, ctx);
// PUT exists for the roll-call sheet's one-cell write: the row behind a cell
// is created, updated or removed by the same call, so the client never has to
// know which — nor which of the two tables it lands in. It goes through the
// same gate as every other method — a `readonly` account is refused by the
// `method !== 'GET'` branch in dispatch().
export const PUT = (req: Request, ctx: Ctx) => run('PUT', req, ctx);
export const PATCH = (req: Request, ctx: Ctx) => run('PATCH', req, ctx);
export const DELETE = (req: Request, ctx: Ctx) => run('DELETE', req, ctx);
