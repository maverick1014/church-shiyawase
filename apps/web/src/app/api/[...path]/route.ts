import { getDb, HttpError, json, unwrap } from '@/lib/server/db';
import {
  clearCookie,
  getSession,
  hashPassword,
  sessionCookie,
  signSession,
  verifyPassword,
} from '@/lib/server/auth';
import { CHURCH_TZ_OFFSET, churchParts, isSundayDate, sundaysOfMonth } from '@/lib/time';
import {
  isOptionalModule,
  isTrainingKind,
  LANGUAGES,
  moduleForApiPath,
  normalizeLanguage,
  OPTIONAL_MODULES,
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
        // Deliberately only the four public fields, not the whole row: this
        // one answers without a session.
        const c = await churchRow(db);
        return json({
          name: c.name,
          short_name: c.short_name,
          description: c.description,
          logo_url: c.logo_url,
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
      const file = form.get('file');
      if (!(file instanceof File)) throw new HttpError(400, 'No file uploaded');
      if (!(file.type || '').startsWith('image/')) throw new HttpError(400, 'Only image files are supported');
      if (file.size > 5 * 1024 * 1024) throw new HttpError(400, 'The image must be 5MB or smaller');
      const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
      const path = `${c.id}/${Date.now()}.${ext}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const up = await db.storage
        .from('branding')
        .upload(path, bytes, { contentType: file.type || 'image/png', upsert: true });
      if (up.error) throw new HttpError(500, up.error.message);
      const { data: pub } = db.storage.from('branding').getPublicUrl(path);
      return json(
        unwrap(
          await db
            .from('church')
            .update({ logo_url: pub.publicUrl })
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
            .select('*, training:trainings(id,name,category,total_sessions)')
            .eq('member_id', r1)
            .order('enrolled_at', { ascending: false }),
        ),
      );
    } else if (r2 === 'avatar' && method === 'POST') {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) throw new HttpError(400, 'No file uploaded');
      if (!(file.type || '').startsWith('image/')) throw new HttpError(400, 'Only image files are supported');
      if (file.size > 5 * 1024 * 1024) throw new HttpError(400, 'The image must be 5MB or smaller');
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${r1}/${Date.now()}.${ext}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const up = await db.storage
        .from('avatars')
        .upload(path, bytes, { contentType: file.type || 'image/jpeg', upsert: true });
      if (up.error) throw new HttpError(500, up.error.message);
      const { data: pub } = db.storage.from('avatars').getPublicUrl(path);
      return json(
        unwrap(
          await db
            .from('members')
            .update({ avatar_url: pub.publicUrl })
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

  // ---- Groups ---------------------------------------------------------------
  if (r0 === 'groups') {
    // /groups/meetings/:meetingId ...
    if (r1 === 'meetings' && r2) {
      if (r3 === 'attendance' && method === 'POST') {
        const dto = await body();
        const records = (dto.records as Array<Record<string, unknown>>).map((r) => ({
          meeting_id: r2,
          member_id: r.member_id,
          status: r.status ?? 'present',
        }));
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

  // ---- 主日点名 (the Sunday sheet) -------------------------------------------
  // Every Sunday happens, so nothing creates one: the sheet IS the data
  // (migration 0013). One request reads a whole month for ONE congregation,
  // one request writes a single cell.
  if (r0 === 'attendance' && r1 === 'sundays' && !r2) {
    if (method === 'GET') {
      const hallId = await resolveSheetHall(db, hallFilter);
      // Which month, defaulting to Malaysia's own calendar month — on a UTC
      // Worker the first 8 hours of a new month still read as the old one.
      const nowParts = churchParts(new Date());
      const year = Number(q.get('year')) || nowParts.year;
      const month = Number(q.get('month')) || nowParts.month;
      if (!Number.isInteger(year) || year < 1970 || year > 9999)
        throw new HttpError(400, 'year must be a four-digit year');
      if (!Number.isInteger(month) || month < 1 || month > 12)
        throw new HttpError(400, 'month must be a number from 1 to 12');
      return json(await sundaySheet(db, hallId, year, month));
    }
    if (method === 'PUT') {
      const dto = await body();
      // The hall is the caller's own whenever it has one — `assertHallWritable`
      // refuses a payload aimed at another congregation and `withHall` then
      // overwrites whatever was sent, exactly like every other write (rule G2).
      assertHallWritable(dto);
      const hallId = String(withHall(dto).hall_id ?? '');
      if (!hallId) throw new HttpError(400, 'hall_id is required — a Sunday sheet is always one congregation');
      const serviceDate = String(dto.service_date ?? '');
      const memberId = String(dto.member_id ?? '');
      if (!serviceDate || !memberId)
        throw new HttpError(400, 'service_date and member_id are required');
      // Postgres would refuse this too (the sunday_attendance_is_sunday check),
      // but a constraint name is not an answer anybody can act on.
      if (!isSundayDate(serviceDate))
        throw new HttpError(400, `${serviceDate} is not a Sunday — only Sundays belong on the Sunday sheet`);
      const preService = dto.pre_service === true;
      const service = dto.service === true;
      // Both ticks off means "not recorded", which is what NO ROW already
      // means — and the table's not-empty check forbids storing it. So an
      // untick deletes rather than writing an empty row.
      if (!preService && !service) {
        unwrap(
          await db
            .from('sunday_attendance')
            .delete()
            .eq('hall_id', hallId)
            .eq('service_date', serviceDate)
            .eq('member_id', memberId)
            .select('id'),
        );
        return json({ hall_id: hallId, service_date: serviceDate, member_id: memberId, pre_service: false, service: false });
      }
      return json(
        unwrap(
          await db
            .from('sunday_attendance')
            .upsert(
              {
                hall_id: hallId,
                service_date: serviceDate,
                member_id: memberId,
                pre_service: preService,
                service,
              },
              { onConflict: 'hall_id,service_date,member_id' },
            )
            .select('hall_id,service_date,member_id,pre_service,service')
            .single(),
        ),
      );
    }
  }

  // ---- Events ---------------------------------------------------------------
  if (r0 === 'events') {
    if (!r1) {
      if (method === 'GET') {
        await ensureRecurringEvents(db);
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
    } else if (r2 === 'attendance' && method === 'POST') {
      const dto = await body();
      const records = (dto.records as Array<Record<string, unknown>>).map((r) => ({
        event_id: r1,
        member_id: r.member_id,
        status: r.status ?? 'present',
        notes: r.notes ?? null,
      }));
      return json(
        unwrap(
          await db.from('event_attendance').upsert(records, { onConflict: 'event_id,member_id' }).select(),
        ),
      );
    } else if (!r2) {
      if (method === 'GET') {
        await assertRowReadable('events', r1);
        const event = unwrap<Record<string, unknown>>(
          await db.from('events').select('*, hall:halls(id,name)').eq('id', r1).single(),
        );
        const attendance = unwrap(
          await db
            .from('event_attendance')
            .select('*, member:members(id,full_name,church_role,group_position)')
            .eq('event_id', r1),
        );
        return json({ ...event, attendance });
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

  // ---- Recurring events (循环聚会) -------------------------------------------
  // Schedules that top up the events calendar. Hall-scoped exactly like the
  // events they generate; deleting a rule keeps its past events (the FK is
  // `on delete set null`), it only stops future generation.
  if (r0 === 'recurring-events') {
    if (!r1) {
      if (method === 'GET') {
        let query = db
          .from('recurring_events')
          .select('*, hall:halls(id,name)')
          .order('created_at');
        // Same rule as the events they generate: own hall + every 全堂 rule.
        if (hallFilter) query = query.or(`hall_id.eq.${hallFilter},hall_id.is.null`);
        return json(unwrap(await query));
      }
      if (method === 'POST')
        return json(
          unwrap(await db.from('recurring_events').insert(withHall(await body())).select().single()),
        );
    } else if (!r2) {
      if (method === 'PATCH') {
        const dto = await body();
        assertHallWritable(dto);
        await assertOwnsRow('recurring_events', r1);
        return json(
          unwrap(await db.from('recurring_events').update(dto).eq('id', r1).select().single()),
        );
      }
      if (method === 'DELETE') {
        await assertOwnsRow('recurring_events', r1);
        unwrap(await db.from('recurring_events').delete().eq('id', r1).select().single());
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
      const training = unwrap<{
        id: string;
        name: string;
        category: string | null;
        kind: string;
        is_enrollable: boolean;
        total_sessions: number;
        starts_on: string | null;
      }>(
        await db
          .from('trainings')
          .select('id,name,category,kind,is_enrollable,total_sessions,starts_on')
          .eq('id', r2)
          .single(),
      );
      if (method === 'GET') {
        // `kind` and `starts_on` ride along so the public page can read as an
        // activity ("Saturday 12 Sept") instead of "1 sessions" (rule G8's
        // shape half: the wording follows the stored code, not a guess).
        return json({
          id: training.id,
          name: training.name,
          category: training.category,
          kind: training.kind,
          is_enrollable: training.is_enrollable,
          total_sessions: training.total_sessions,
          starts_on: training.starts_on,
        });
      }
      if (method === 'POST') {
        if (!training.is_enrollable) return json({ status: 'closed' });
        const fullName = String((await body()).full_name ?? '').trim();
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
        unwrap(
          await db
            .from('training_enrollments')
            .insert({ training_id: r2, member_id: member.id, status: 'pending' })
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
          .select('*, trainer:members(id,full_name), hall:halls(id,name)')
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
        if (row.kind === TrainingKind.Activity)
          unwrap(
            await db
              .from('training_sessions')
              .insert({ training_id: row.id, session_number: 1 })
              .select('id')
              .single(),
          );
        return json(row);
      }
    }
    // /trainings/:id ...
    else if (r1 && !r2) {
      if (method === 'GET') {
        await assertRowReadable('trainings', r1);
        const training = unwrap<Record<string, unknown>>(
          await db
            .from('trainings')
            .select('*, trainer:members(id,full_name), hall:halls(id,name)')
            .eq('id', r1)
            .single(),
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
        return json(unwrap(await db.from('trainings').update(dto).eq('id', r1).select().single()));
      }
      if (method === 'DELETE') {
        await assertOwnsRow('trainings', r1);
        unwrap(await db.from('trainings').delete().eq('id', r1).select().single());
        return json({ id: r1 });
      }
    }
    // /trainings/:id/{namelist,sessions,enroll}
    else if (r1 && r2) {
      if (r2 === 'namelist' && method === 'GET') {
        await assertRowReadable('trainings', r1);
        return json(await namelist(db, r1));
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
        // the gate at the top of dispatch(): `readonly` cannot write at all,
        // and DELETE is super_admin/admin only.
        if (method === 'GET') {
          return json(unwrap(await db.from('discipleship_programs').select('*').eq('id', r2).single()));
        }
        if (method === 'PATCH') {
          return json(
            unwrap(await db.from('discipleship_programs').update(await body()).eq('id', r2).select().single()),
          );
        }
        if (method === 'DELETE') {
          // This CASCADES: discipleship_pairs.program_id is `on delete
          // cascade` and discipleship_progress.pair_id cascades from there, so
          // every pair under the module and all their daily entries go with
          // it. The 四十天守望 page names that blast radius (how many pairs,
          // how many days of records) in its confirmation before calling this.
          unwrap(await db.from('discipleship_programs').delete().eq('id', r2).select().single());
          return json({ id: r2 });
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

const CHURCH_SELECT = 'id,name,short_name,description,logo_url';

/** Only these may be written on the church record; anything else is refused
 *  loudly rather than dropped, the same allow-list shape as the self-service
 *  profile above. `id` and the timestamps are deliberately absent. */
const CHURCH_FIELDS = ['name', 'short_name', 'description', 'logo_url'] as const;

type ChurchRow = {
  id: string;
  name: string;
  short_name: string | null;
  description: string | null;
  logo_url: string | null;
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

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Top up the calendar from the 循环聚会 rules so a recurring weeknight meeting
 * never has to be added by hand. Runs on GET /events — generation is lazy on
 * purpose: the schedule only needs to be correct for someone actually looking
 * at it, which avoids a cron job that can fail silently.
 *
 * SUNDAYS ARE NOT GENERATED ANY MORE (migration 0013). Every Sunday happens,
 * so manufacturing a 主日崇拜 row to hang attendance off was only ever a way of
 * inventing a date the calendar already knew about; the Sunday sheet
 * (`sunday_attendance`) holds that attendance now, per congregation, with no
 * event row involved. A Sunday rule left over from before is therefore skipped
 * rather than deleted — its past occurrences stay readable as ordinary
 * meetings, and 循环聚会 keeps working for every other weekday.
 *
 * Two things keep the remaining generation from fighting the user:
 *  - `generated_through` means a rule only ever looks at dates AFTER the last
 *    one it produced. Deleting a single occurrence (a public holiday) makes it
 *    stay deleted, and editing a rule's weekday/time doesn't regenerate the
 *    window it already filled at the old time.
 *  - A slot already occupied by an equivalent event — same hall, same type,
 *    same moment, whoever created it — is skipped. That covers meetings that
 *    predate the rules (their `recurring_id` is null) and anything added by
 *    hand.
 */
async function ensureRecurringEvents(db: ReturnType<typeof getDb>) {
  const rules = (unwrap(
    await db
      .from('recurring_events')
      .select('id,title,event_type,weekday,start_time,location,hall_id,lookahead_days,generated_through')
      .eq('active', true),
  ) as Array<{
    id: string;
    title: string;
    event_type: string;
    weekday: string;
    start_time: string;
    location: string | null;
    hall_id: string | null;
    lookahead_days: number;
    generated_through: string | null;
  }>).filter((r) => r.weekday !== 'sunday');
  if (rules.length === 0) return;

  // Malaysia's calendar date, via the same helper the UI reads with.
  const nowParts = churchParts(new Date());
  const todayLocal = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day));

  // Every date a rule still owes, within its own lookahead window.
  const wanted: Array<{ rule: (typeof rules)[number]; date: string; startsAt: string }> = [];
  for (const rule of rules) {
    const target = WEEKDAY_INDEX[rule.weekday];
    if (target === undefined) continue;
    const daysUntil = (target - todayLocal.getUTCDay() + 7) % 7;
    for (let offset = daysUntil; offset <= rule.lookahead_days; offset += 7) {
      const d = new Date(todayLocal);
      d.setUTCDate(d.getUTCDate() + offset);
      const iso = d.toISOString().slice(0, 10);
      if (rule.generated_through && iso <= rule.generated_through) continue;
      wanted.push({ rule, date: iso, startsAt: `${iso}T${rule.start_time}${CHURCH_TZ_OFFSET}` });
    }
  }
  if (wanted.length === 0) return;

  // One read covering the whole window, then insert only what's missing.
  const times = wanted.map((w) => w.startsAt).sort();
  const existing = unwrap(
    await db
      .from('events')
      .select('starts_at,hall_id,event_type,recurring_id')
      .gte('starts_at', times[0])
      .lte('starts_at', times[times.length - 1]),
  ) as Array<{
    starts_at: string;
    hall_id: string | null;
    event_type: string;
    recurring_id: string | null;
  }>;
  const slotKey = (hallId: string | null, type: string, startsAt: string) =>
    `${hallId ?? ''}|${type}|${new Date(startsAt).toISOString()}`;
  const taken = new Set(existing.map((e) => slotKey(e.hall_id, e.event_type, e.starts_at)));

  const rows = wanted
    .filter((w) => !taken.has(slotKey(w.rule.hall_id, w.rule.event_type, w.startsAt)))
    .map((w) => ({
      title: w.rule.title,
      event_type: w.rule.event_type,
      location: w.rule.location,
      starts_at: w.startsAt,
      hall_id: w.rule.hall_id,
      recurring_id: w.rule.id,
    }));

  if (rows.length > 0) {
    // Best-effort: two concurrent requests could both see the same slot
    // missing. The unique index on (recurring_id, starts_at) turns that race
    // into a rejected insert rather than a duplicate — either way this must
    // never fail the surrounding GET /events request, so the error is logged
    // rather than thrown (a silent swallow once hid a real bug here).
    const ins = await db.from('events').insert(rows);
    if (ins.error) console.error('recurring top-up insert failed:', ins.error.message);
  }

  // Advance each rule's watermark to the last date it just covered, so those
  // dates are never reconsidered — even the ones skipped as already-occupied.
  const lastByRule = new Map<string, string>();
  for (const w of wanted) {
    const prev = lastByRule.get(w.rule.id);
    if (!prev || w.date > prev) lastByRule.set(w.rule.id, w.date);
  }
  await Promise.all(
    [...lastByRule].map(([id, date]) =>
      db.from('recurring_events').update({ generated_through: date }).eq('id', id),
    ),
  );
}

/**
 * Which congregation's Sunday sheet is being read.
 *
 * `hallFilter` already carries the whole precedence rule — the session's own
 * hall first, the congregation switcher's `?hall_id=` only for an account that
 * spans every hall (rule G2), so a hall-pinned account can never reach another
 * hall's sheet. What is special here is the FALLBACK: every other list happily
 * answers "all congregations", but a sheet is always exactly one. Rather than
 * merging three congregations' Sundays into one grid — the very thing this
 * model removes — an unnarrowed request is refused, unless the church has only
 * one congregation, where the answer is unambiguous.
 */
async function resolveSheetHall(
  db: ReturnType<typeof getDb>,
  hallFilter: string | null,
): Promise<string> {
  if (hallFilter) return hallFilter;
  const halls = unwrap<Array<{ id: string }>>(
    await db.from('halls').select('id').order('sort_order'),
  );
  if (halls.length === 1) return halls[0].id;
  if (halls.length === 0) throw new HttpError(500, 'No congregations configured yet');
  throw new HttpError(
    400,
    'Choose one congregation: a Sunday sheet always belongs to a single congregation, never to all of them at once',
  );
}

/**
 * One congregation's Sunday sheet for one month: its active members down the
 * left, that month's Sundays across the top, two ticks per Sunday.
 *
 * The dates come from the calendar, not from the data — that is the whole
 * point of 0013. A Sunday nobody has been marked on still gets its column.
 */
async function sundaySheet(
  db: ReturnType<typeof getDb>,
  hallId: string,
  year: number,
  month: number,
) {
  const dates = sundaysOfMonth(year, month);

  const members = unwrap(
    await db
      .from('members')
      .select(MEMBER_BRIEF)
      .eq('hall_id', hallId)
      .eq('status', 'active')
      .order('full_name'),
  ) as Array<{ id: string; full_name: string }>;

  // Independent of the member read, so they go together (rule G6). An empty
  // month (a calendar with no Sundays cannot happen, but be explicit) would
  // make the range filter meaningless.
  const marks = dates.length
    ? (unwrap(
        await db
          .from('sunday_attendance')
          .select('service_date,member_id,pre_service,service')
          .eq('hall_id', hallId)
          .gte('service_date', dates[0])
          .lte('service_date', dates[dates.length - 1]),
      ) as Array<{
        service_date: string;
        member_id: string;
        pre_service: boolean;
        service: boolean;
      }>)
    : [];

  const byMember = new Map<string, Record<string, { pre_service: boolean; service: boolean }>>();
  for (const m of marks) {
    const date = m.service_date.slice(0, 10);
    const cells = byMember.get(m.member_id) ?? {};
    cells[date] = { pre_service: m.pre_service, service: m.service };
    byMember.set(m.member_id, cells);
  }

  return {
    hall_id: hallId,
    dates,
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
 * Normalize a 培训&活动 create/update payload.
 *
 * Two things the server owns rather than trusting the client with (rule G2):
 *  - `kind` must be one the app actually ships. The table's CHECK would refuse
 *    anything else too, but a constraint name is not an answer anybody can act
 *    on — and a stale client must not be able to park a row on a third shape.
 *  - an activity is ONE occasion, so its `total_sessions` is 1 whatever was
 *    sent. That is the invariant the single auto-created session stands on.
 */
function trainingWrite(dto: Record<string, unknown>): Record<string, unknown> {
  const patch = { ...dto };
  if (patch.kind !== undefined) {
    if (!isTrainingKind(patch.kind))
      throw new HttpError(400, `Unknown kind: ${String(patch.kind)} — expected course or activity`);
    if (patch.kind === TrainingKind.Activity) patch.total_sessions = 1;
  }
  return patch;
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
// PUT exists for the Sunday sheet's one-cell write: the row for (hall, Sunday,
// member) is created, updated or removed by the same call, so the client never
// has to know which. It goes through the same gate as every other method — a
// `readonly` account is refused by the `method !== 'GET'` branch in dispatch().
export const PUT = (req: Request, ctx: Ctx) => run('PUT', req, ctx);
export const PATCH = (req: Request, ctx: Ctx) => run('PATCH', req, ctx);
export const DELETE = (req: Request, ctx: Ctx) => run('DELETE', req, ctx);
