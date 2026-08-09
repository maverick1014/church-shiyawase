import { getDb, HttpError, json, unwrap } from '@/lib/server/db';
import {
  clearCookie,
  getSession,
  hashPassword,
  sessionCookie,
  signSession,
  verifyPassword,
} from '@/lib/server/auth';
import { churchInstant, churchParts, isSundayDate } from '@/lib/time';
import {
  meetingColumnKey,
  parseColumnKey,
  sheetColumns,
  sundayColumnKey,
} from '@/lib/sheet';
import type { SheetCell, SheetMeeting } from '@/lib/types';
import {
  isOptionalModule,
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

const MEMBER_SELECT = '*, group:groups(id,name), household:households(id,name), hall:halls(id,name)';
const MEMBER_BRIEF = 'id,full_name,church_role,group_position';
const ACCOUNT_MEMBER_BRIEF = 'id,full_name,email,church_role,group_position';
const PAIR_SELECT =
  '*, mentor:members!discipleship_pairs_mentor_id_fkey(id,full_name,church_role,group_position), trainee:members!discipleship_pairs_trainee_id_fkey(id,full_name,church_role,group_position)';
/** Same shape, but an !inner mentor join so a hall filter can be pushed down. */
const PAIR_SELECT_SCOPED =
  '*, mentor:members!discipleship_pairs_mentor_id_fkey!inner(id,full_name,church_role,group_position), trainee:members!discipleship_pairs_trainee_id_fkey(id,full_name,church_role,group_position)';
const ACCOUNT_SELECT = `*, member:members(${ACCOUNT_MEMBER_BRIEF}), hall:halls(id,name)`;

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

  const [r0, r1, r2, r3] = p;

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
  // training self-enrollment form (/enroll/<id>), and the church's own
  // name/description/logo — which the login card and both of those forms have
  // to render before anyone has signed in, and none of which is sensitive.
  // Each is a narrow, specific handler below; nothing else under these
  // prefixes is reachable unauthed, and /church is public for GET ONLY —
  // changing the record stays super_admin (see the role gate below).
  const isPublicForm =
    (r0 === 'discipleship' && r1 === 'form') ||
    (r0 === 'trainings' && r1 === 'enroll') ||
    (r0 === 'church' && !r1 && method === 'GET');

  // Hall scope for this request. `null` = 全堂权限 (sees and may write every
  // hall). A non-null value pins the account to one hall: reads are filtered
  // to it and writes are forced onto it, server-side — the client never gets
  // to choose (rule G2: the server is authoritative).
  let hallScope: string | null = null;
  if (!isPublicForm) {
    const session = await getSession(req);
    if (!session) throw new HttpError(401, 'Not signed in');
    hallScope = session.hall ?? null;
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
   * Body for a hall-scoped INSERT. A single-hall account always writes into
   * its own hall (any hall_id the client sent is discarded); a full-access
   * account may pass one explicitly, and for trainings/events may leave it
   * null to mean 全堂开放.
   */
  const withHall = (dto: Record<string, unknown>): Record<string, unknown> =>
    hallScope ? { ...dto, hall_id: hallScope } : dto;

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
  if (r0 === 'halls' && !r1 && method === 'GET') {
    let query = db.from('halls').select('id,name,sort_order').order('sort_order');
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
    if (!r1) {
      if (method === 'GET') {
        let query = db
          .from('members')
          .select(MEMBER_SELECT)
          .order('full_name', { ascending: true });
        if (hallFilter) query = query.eq('hall_id', hallFilter);
        if (q.get('church_role')) query = query.eq('church_role', q.get('church_role'));
        if (q.get('group_position')) query = query.eq('group_position', q.get('group_position'));
        if (q.get('group_id')) query = query.eq('group_id', q.get('group_id'));
        if (q.get('q')) query = query.ilike('full_name', `%${q.get('q')}%`);
        return json(unwrap(await query));
      }
      if (method === 'POST') {
        return json(unwrap(await db.from('members').insert(withHall(await body())).select().single()));
      }
    } else if (r2 === 'trainings' && method === 'GET') {
      await assertRowReadable('members', r1);
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
        return json(unwrap(await db.from('members').select(MEMBER_SELECT).eq('id', r1).single()));
      }
      if (method === 'PATCH') {
        const dto = await body();
        assertHallWritable(dto);
        await assertOwnsRow('members', r1);
        return json(unwrap(await db.from('members').update(dto).eq('id', r1).select().single()));
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
    if (!hallScope) return;
    const row = unwrap<{ group_id: string }>(
      await db.from('group_meetings').select('group_id').eq('id', meetingId).single(),
    );
    await assertOwnsRow('groups', row.group_id);
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
        return json(unwrap(await query));
      }
      if (method === 'POST')
        return json(unwrap(await db.from('groups').insert(withHall(await body())).select().single()));
    } else if (r2 === 'attendance' && method === 'GET') {
      await assertRowReadable('groups', r1);
      return json(await groupAttendance(db, r1));
    } else if (r2 === 'meetings' && method === 'POST') {
      // The roll call creates the week's meeting row lazily, so this is a
      // write into the group and follows the same hall rule as editing it.
      await assertOwnsRow('groups', r1);
      const dto = await body();
      return json(
        unwrap(
          await db
            .from('group_meetings')
            .insert({ group_id: r1, meeting_date: dto.meeting_date, note: dto.note ?? null })
            .select()
            .single(),
        ),
      );
    } else if (!r2) {
      if (method === 'GET') {
        await assertRowReadable('groups', r1);
        const group = unwrap<Record<string, unknown>>(
          await db.from('groups').select('*, hall:halls(id,name)').eq('id', r1).single(),
        );
        const members = unwrap(
          await db
            .from('members')
            .select('id,full_name,group_position,status')
            .eq('group_id', r1)
            .order('full_name'),
        );
        return json({ ...group, members });
      }
      if (method === 'PATCH') {
        const dto = await body();
        assertHallWritable(dto);
        await assertOwnsRow('groups', r1);
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
      return json(await rollCallSheet(db, hallFilter, year, month));
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
      const members = unwrap<Array<{ id: string; hall_id: string }>>(
        await db.from('members').select('id,hall_id').in('id', memberIds),
      );
      if (members.length !== memberIds.length)
        throw new HttpError(400, 'One of those members does not exist');
      if (hallScope && members.some((m) => m.hall_id !== hallScope))
        throw new HttpError(403, 'No permission to modify another congregation’s records');

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
        const matches = unwrap<Array<{ id: string; full_name: string }>>(
          await db.from('members').select('id,full_name').eq('full_name', fullName),
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
        const records = (dto.records as Array<Record<string, unknown>>).map((r) => ({
          session_id: r2,
          member_id: r.member_id,
          attended: r.attended,
          notes: r.notes ?? null,
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
              .select('*, member:members(id,full_name,church_role,group_position)')
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
            .select('*, member:members(id,full_name,church_role,group_position)')
            .eq('training_id', r1)
            .order('enrolled_at'),
        );
        return json({ ...training, sessions, enrollments });
      }
      if (method === 'PATCH') {
        const dto = trainingWrite(await body());
        assertHallWritable(dto);
        await assertOwnsRow('trainings', r1);
        const row = unwrap<{ id: string; kind: string }>(
          await db.from('trainings').update(dto).eq('id', r1).select().single(),
        );
        // 形态可以互换 (0016): a course that turns out to be one afternoon
        // becomes an activity, and an activity that grows becomes a course.
        // Only one direction has anything to reconcile — an activity is ONE
        // occasion, so its sessions above the first are removed here, taking
        // their attendance with them (`training_attendance.session_id` is
        // `on delete cascade`). The page names exactly what goes and asks
        // first (rule G3); the invariant itself is the SERVER's, so a stale
        // client can never leave a four-session activity behind (rule G2).
        // The other way round needs nothing: the single session simply becomes
        // session 1 of the course, keeping the roll call already taken.
        if (dto.kind !== undefined && row.kind === TrainingKind.Activity)
          await ensureSingleSession(db, row.id);
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
              .select('*, member:members(id,full_name,church_role,group_position)')
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
            unwrap(
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
            '*, mentor:members!discipleship_pairs_mentor_id_fkey(id,full_name), trainee:members!discipleship_pairs_trainee_id_fkey(id,full_name), program:discipleship_programs(id,name,total_days)',
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
        },
        { onConflict: 'pair_id,day_number' },
      )
      .select()
      .single(),
  );
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
 */
async function rollCallSheet(
  db: ReturnType<typeof getDb>,
  hallFilter: string | null,
  year: number,
  month: number,
) {
  // The month as MALAYSIA reads it: [1st 00:00, the 1st of the next month).
  // `churchInstant` normalises month 13 into January, so December needs no
  // special case.
  const monthStart = churchInstant(year, month, 1).toISOString();
  const monthEnd = churchInstant(year, month + 1, 1).toISOString();

  let memberQuery = db
    .from('members')
    .select(MEMBER_BRIEF)
    .eq('status', 'active')
    .order('full_name');
  if (hallFilter) memberQuery = memberQuery.eq('hall_id', hallFilter);

  let meetingQuery = db
    .from('events')
    .select('id,title,starts_at,hall_id')
    .gte('starts_at', monthStart)
    .lt('starts_at', monthEnd)
    .order('starts_at');
  // A narrowed view sees that hall's meetings plus every 全堂开放 one — the
  // same rule the events list itself follows.
  if (hallFilter) meetingQuery = meetingQuery.or(`hall_id.eq.${hallFilter},hall_id.is.null`);

  // Independent reads, so they go together (rule G6).
  const [memberRes, meetingRes] = await Promise.all([memberQuery, meetingQuery]);
  const members = unwrap(memberRes) as Array<{ id: string; full_name: string }>;
  const meetings = unwrap(meetingRes) as SheetMeeting[];

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
      .select('id, meeting_date, note')
      .eq('group_id', groupId)
      .order('meeting_date'),
  ) as Array<{ id: string; meeting_date: string; note: string | null }>;

  const members = unwrap(
    await db
      .from('members')
      .select('id, full_name, church_role, group_position')
      .eq('group_id', groupId)
      .order('full_name'),
  ) as Array<{ id: string; full_name: string }>;

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
 * What the PUBLIC sign-up page (`/enroll/:id`) is told about a training.
 *
 * An explicit list, never `*`: this endpoint answers with no session at all, so
 * every column it hands out is a deliberate decision. What is here is what a
 * visitor needs in order to decide and to pay — which shape it is, when and
 * where, who to ring, and the 报名费 with the instructions and QR to settle it.
 */
const PUBLIC_TRAINING_SELECT =
  'id,name,kind,is_enrollable,total_sessions,starts_on,ends_on,start_time,location,pic,pic_contact,fee,payment_instructions,payment_qr_url';

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
function trainingWrite(dto: Record<string, unknown>): Record<string, unknown> {
  const patch = { ...dto };
  if (patch.kind !== undefined) {
    if (!isTrainingKind(patch.kind))
      throw new HttpError(400, `Unknown kind: ${String(patch.kind)} — expected course or activity`);
    if (patch.kind === TrainingKind.Activity) {
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
 * Called when an activity is created and when a course is converted into one,
 * so the invariant lives in a single place rather than being re-derived at each
 * write. Sessions beyond the first are deleted, which takes their attendance
 * with them (`training_attendance.session_id` is `on delete cascade`); a
 * conversion that would destroy anything is confirmed in the UI first (G3).
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
      .select('id, member:members(id,full_name,church_role,group_position)')
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
      .select('id, email, account_role, status, hall_id, password_hash, member:members(id,full_name)')
      .eq('email', (dto.email ?? '').toLowerCase().trim())
      .maybeSingle();
    if (res.error) throw new HttpError(500, res.error.message);
    const user = res.data as {
      id: string;
      email: string;
      account_role: string;
      status: string;
      hall_id: string | null;
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
  'chinese_name',
  'email',
  'phone',
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
