import { getDb, HttpError, json, unwrap } from '@/lib/server/db';
import {
  clearCookie,
  getSession,
  hashPassword,
  sessionCookie,
  signSession,
  verifyPassword,
} from '@/lib/server/auth';
import { CHURCH_TZ_OFFSET, churchParts } from '@/lib/time';
import { LANGUAGES, normalizeLanguage } from '@tog/shared';

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

  // Public-by-design, no session: the mentor daily form (/d/<token>) and the
  // training self-enrollment form (/enroll/<id>). Both are narrow, specific
  // handlers below — nothing else under these prefixes is reachable unauthed.
  const isPublicForm =
    (r0 === 'discipleship' && r1 === 'form') || (r0 === 'trainings' && r1 === 'enroll');

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
    if (method !== 'GET') {
      // Permission matrix enforcement.
      if (session.role === 'readonly') throw new HttpError(403, 'A read-only account cannot make changes');
      if (method === 'DELETE' && !['super_admin', 'admin'].includes(session.role))
        throw new HttpError(403, 'This role may not delete records');
    }
  }

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
        is_enrollable: boolean;
        total_sessions: number;
      }>(
        await db
          .from('trainings')
          .select('id,name,category,is_enrollable,total_sessions')
          .eq('id', r2)
          .single(),
      );
      if (method === 'GET') {
        return json({
          id: training.id,
          name: training.name,
          category: training.category,
          is_enrollable: training.is_enrollable,
          total_sessions: training.total_sessions,
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
      if (method === 'POST')
        return json(unwrap(await db.from('trainings').insert(withHall(await body())).select().single()));
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
        const dto = await body();
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
      } else if (!r3 && method === 'GET') {
        return json(unwrap(await db.from('discipleship_programs').select('*').eq('id', r2).single()));
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
 * Top up the calendar from the 循环聚会 rules so a weekly service never has to
 * be added by hand. Runs on GET /events — generation is lazy on purpose: the
 * schedule only needs to be correct for someone actually looking at it, which
 * avoids a cron job that can fail silently.
 *
 * Two things keep it from fighting the user:
 *  - `generated_through` means a rule only ever looks at dates AFTER the last
 *    one it produced. Deleting a single occurrence (a public holiday) makes it
 *    stay deleted, and editing a rule's weekday/time doesn't regenerate the
 *    window it already filled at the old time.
 *  - A slot already occupied by an equivalent event — same hall, same type,
 *    same moment, whoever created it — is skipped. That covers services that
 *    predate the rules (their `recurring_id` is null) and anything added by
 *    hand, and stops the insert from colliding with the Sunday-service unique
 *    index from 0008.
 */
async function ensureRecurringEvents(db: ReturnType<typeof getDb>) {
  const rules = unwrap(
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
  }>;
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
  if (p[1] === 'me' && method === 'GET') {
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
    rest.email = member.email;
  }
  // Only the three supported interface languages may be stored, so a stale
  // client (or a hand-rolled request) can never park an account on a language
  // the app has no dictionary for.
  if (rest.language !== undefined) {
    if (!(LANGUAGES as readonly string[]).includes(String(rest.language)))
      throw new HttpError(400, `Unsupported language: ${String(rest.language)}`);
  }
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
export const PATCH = (req: Request, ctx: Ctx) => run('PATCH', req, ctx);
export const DELETE = (req: Request, ctx: Ctx) => run('DELETE', req, ctx);
