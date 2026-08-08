'use client';

import { Fragment, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { usePageChrome, useMe, useHallScope } from '@/components/AppShell';
import {
  ErrorBanner,
  ExportButton,
  Field,
  HallSelect,
  Modal,
  MonthPicker,
  PageBar,
  RepeatIcon,
  SheetTick,
  Skeleton,
  SkeletonScreen,
  SkeletonTable,
  useConfirm,
  useToast,
} from '@/components/ui';
import { can } from '@/lib/perms';
import { exportMatrix } from '@/lib/export';
import { EventDetail, EventRow, MemberRow, SundaySheet, SundaySheetRow } from '@/lib/types';
import { ATTENDANCE_OPTIONS, attendanceKey, formatDate } from '@/lib/labels';
import { churchParts, fromChurchInput, toChurchInput } from '@/lib/time';
import { useT } from '@/lib/i18n';
import { AttendanceStatus, EventType, MemberStatus } from '@tog/shared';

/** Tone class per attendance option — matches the seg-button palette. */
const ATTENDANCE_TONE: Record<AttendanceStatus, string> = {
  [AttendanceStatus.Present]: 'on-good',
  [AttendanceStatus.Excused]: 'on-warn',
  [AttendanceStatus.Absent]: 'on-crit',
};

/** Which of a Sunday's two ticks a cell is. */
type Tick = 'pre_service' | 'service';

/**
 * 崇拜与祷告会 — Sunday roll call, plus the occasional meeting someone adds.
 *
 * Every Sunday simply happens, so nobody creates one: the page opens on a
 * SHEET whose columns are the Sundays of the month it is showing (migration
 * 0013). Below it sit the meetings that genuinely were added by hand — the
 * Wednesday prayer meeting that runs once in a while — which still keep their
 * own present/excused/absent roll call.
 *
 * The sheet is always ONE congregation: each hall rolls its own call, even on
 * a week the halls meet together. On 全部堂会 the page therefore asks for a
 * congregation instead of merging three member lists into one grid, and the
 * API refuses the merged read for the same reason.
 */
export default function EventsPage() {
  const t = useT();
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const perms = can(useMe().role);
  const { hallId, halls } = useHallScope();

  // Which month, defaulting to Malaysia's own calendar — on a UTC Worker the
  // first 8 hours of a new month still read as the old one (rule G6a).
  const nowParts = churchParts(new Date());
  const [year, setYear] = useState(nowParts.year);
  const [month, setMonth] = useState(nowParts.month);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<EventRow | null>(null);

  usePageChrome({ title: t('events.title') }, [t]);

  // The sheet's congregation: the one being viewed, or the only one there is.
  // Empty means "全部堂会 with more than one hall" — the one case that has no
  // single sheet to draw. `halls` is empty until /api/halls resolves, so the
  // decision waits for it rather than flashing the wrong branch.
  const hallsReady = halls.length > 0;
  const sheetHall = hallId || (halls.length === 1 ? halls[0].id : '');

  // useFetch appends the viewed hall itself (withHallParam), so the query here
  // carries only the month.
  const sheet = useFetch<SundaySheet>(
    hallsReady && sheetHall ? `/attendance/sundays?year=${year}&month=${month}` : null,
  );
  const events = useFetch<EventRow[]>('/events');

  const dates = sheet.data?.dates ?? [];
  const rows = sheet.data?.rows ?? [];

  /** How many of the month's Sundays this member carries a given tick on. */
  const countOf = (row: SundaySheetRow, tick: Tick) =>
    dates.filter((d) => row.cells[d]?.[tick]).length;

  const toggle = async (row: SundaySheetRow, date: string, tick: Tick) => {
    const current = row.cells[date] ?? { pre_service: false, service: false };
    const next = { ...current, [tick]: !current[tick] };
    try {
      await api.put('/attendance/sundays', {
        hall_id: sheetHall,
        service_date: date,
        member_id: row.member.id,
        ...next,
      });
      sheet.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const exportSheet = () => {
    if (!sheet.data) return;
    const headers = [
      t('members.col.member'),
      ...dates.flatMap((d) => [
        `${d.slice(5)} ${t('events.col.preService')}`,
        `${d.slice(5)} ${t('events.col.service')}`,
      ]),
      `${t('events.col.total')} ${t('events.col.preService')}`,
      `${t('events.col.total')} ${t('events.col.service')}`,
    ];
    const matrix = rows.map((r) => [
      r.member.full_name,
      ...dates.flatMap((d) => [
        r.cells[d]?.pre_service ? '✓' : '',
        r.cells[d]?.service ? '✓' : '',
      ]),
      countOf(r, 'pre_service'),
      countOf(r, 'service'),
    ]);
    exportMatrix(
      t('events.exportFile', { year, month: String(month).padStart(2, '0') }),
      t('events.sheet'),
      headers,
      matrix,
    );
  };

  // The meetings someone added by hand, narrowed to the month on screen. Read
  // in Malaysia time so a 08:00 meeting cannot fall into the previous month.
  const monthEvents = useMemo(
    () =>
      (events.data ?? [])
        .filter((e) => {
          const p = churchParts(new Date(e.starts_at));
          return p.year === year && p.month === month;
        })
        .sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at)),
    [events.data, year, month],
  );

  const deleteEvent = async (e: EventRow): Promise<boolean> => {
    const ok = await confirm({
      title: t('events.delete.title'),
      message: t('events.delete.message', { name: e.title }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return false;
    try {
      await api.delete(`/events/${e.id}`);
      events.reload();
      toast(t('events.toast.deleted'));
      return true;
    } catch (err) {
      toast((err as Error).message, 'error');
      return false;
    }
  };

  return (
    <>
      <ErrorBanner message={sheet.error || events.error} />

      <PageBar
        filters={
          <MonthPicker
            year={year}
            month={month}
            years={[nowParts.year, nowParts.year - 1]}
            onChange={(next) => {
              setYear(next.year);
              setMonth(next.month);
            }}
          />
        }
        actions={
          <>
            <ExportButton
              onClick={exportSheet}
              disabled={!sheet.data || rows.length === 0}
              title={t('events.exportTitle')}
            />
            {perms.write && (
              <button className="btn ghost" onClick={() => router.push('/events/recurring')}>
                <RepeatIcon />
                {t('events.recurring')}
              </button>
            )}
            {perms.write && (
              <button className="btn" onClick={() => setAddOpen(true)}>{t('events.addMeeting')}</button>
            )}
          </>
        }
      />

      {/* Card 1 — the Sunday sheet. Wide by nature, so it scrolls inside its
          own card exactly like the life-group sheet; the page body never
          scrolls sideways. */}
      <div className="card">
        <div className="card-head">
          <div>
            <h3>{t('events.sheet')}</h3>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{t('events.sheetSub')}</div>
          </div>
        </div>

        {hallsReady && !sheetHall ? (
          <div className="empty-inline">{t('events.sheetPickHall')}</div>
        ) : sheet.initialLoading ? (
          <SkeletonScreen>
            <SkeletonTable rows={5} columns={7} bare />
          </SkeletonScreen>
        ) : rows.length === 0 ? (
          <div className="empty-inline">{t('events.sheetEmpty')}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th rowSpan={2}>{t('members.col.member')}</th>
                  {dates.map((d) => (
                    <th key={d} colSpan={2} className="tnum" style={{ textAlign: 'center' }}>
                      {d.slice(5)}
                    </th>
                  ))}
                  <th colSpan={2} style={{ textAlign: 'center' }}>{t('events.col.total')}</th>
                </tr>
                <tr>
                  {dates.map((d) => (
                    <Fragment key={d}>
                      <th style={{ textAlign: 'center' }}>{t('events.col.preService')}</th>
                      <th style={{ textAlign: 'center' }}>{t('events.col.service')}</th>
                    </Fragment>
                  ))}
                  <th style={{ textAlign: 'center' }}>{t('events.col.preService')}</th>
                  <th style={{ textAlign: 'center' }}>{t('events.col.service')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.member.id}>
                    <td><strong>{r.member.full_name}</strong></td>
                    {dates.map((d) => (
                      <Fragment key={d}>
                        <td style={{ textAlign: 'center' }}>
                          <SheetTick
                            checked={!!r.cells[d]?.pre_service}
                            onToggle={() => toggle(r, d, 'pre_service')}
                            disabled={!perms.write}
                            title={t('events.col.preService')}
                          />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <SheetTick
                            checked={!!r.cells[d]?.service}
                            onToggle={() => toggle(r, d, 'service')}
                            disabled={!perms.write}
                            title={t('events.col.service')}
                          />
                        </td>
                      </Fragment>
                    ))}
                    <td className="tnum" style={{ textAlign: 'center', fontWeight: 600 }}>
                      {countOf(r, 'pre_service')}
                    </td>
                    <td className="tnum" style={{ textAlign: 'center', fontWeight: 600 }}>
                      {countOf(r, 'service')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Card 2 — the meetings someone added by hand this month. One row shape
          at every width (name · date · congregation, actions on the right), so
          there is no desktop table and mobile tile to keep in step (rule G5). */}
      <div className="card mt-16">
        <div className="card-head">
          <div>
            <h3>{t('events.meetings')}</h3>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{t('events.meetingsSub')}</div>
          </div>
        </div>

        {events.initialLoading ? (
          <SkeletonScreen>
            {[0, 1].map((i) => (
              <div key={i} className="meeting-row">
                <Skeleton width={148} height={14} />
                <Skeleton width={78} height={11} />
              </div>
            ))}
          </SkeletonScreen>
        ) : monthEvents.length === 0 ? (
          <div className="empty-inline">{t('events.meetingsEmpty')}</div>
        ) : (
          monthEvents.map((e) => (
            <div key={e.id} className="meeting-row">
              <strong style={{ fontSize: 13 }}>{e.title}</strong>
              <span className="muted tnum" style={{ fontSize: 12.5 }}>{formatDate(e.starts_at)}</span>
              <span className="faint" style={{ fontSize: 12 }}>{e.hall?.name ?? t('hall.allOpenEvent')}</span>
              <div className="grow" />
              <div className="flex gap-8">
                <button className="btn ghost sm" onClick={() => setActiveId(e.id)}>{t('events.rollCall')}</button>
                {perms.write && (
                  <button className="btn ghost sm" onClick={() => setEditing(e)}>{t('common.edit')}</button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {activeId && (
        <AttendancePanel
          key={activeId}
          eventId={activeId}
          onClose={() => setActiveId(null)}
          onSaved={() => {
            toast(t('events.toast.attendance'));
            setActiveId(null);
          }}
        />
      )}

      {(addOpen || editing) && (
        <MeetingModal
          event={editing}
          onClose={() => {
            setAddOpen(false);
            setEditing(null);
          }}
          onSaved={() => {
            setAddOpen(false);
            setEditing(null);
            events.reload();
            toast(editing ? t('events.toast.updated') : t('events.toast.created'));
          }}
          onDelete={
            editing && perms.delete
              ? async () => {
                  if (await deleteEvent(editing)) setEditing(null);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

/**
 * Roll call for a hand-added meeting: present / excused / absent per member,
 * saved once. The member list is fetched HERE rather than by the page, because
 * this is the only thing that needs it and it only ever opens on demand.
 */
function AttendancePanel({
  eventId,
  onClose,
  onSaved,
}: {
  eventId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const detail = useFetch<EventDetail>(`/events/${eventId}`);
  const allMembers = useFetch<MemberRow[]>('/members');
  const t = useT();
  const toast = useToast();
  const [marks, setMarks] = useState<Record<string, AttendanceStatus> | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const members = useMemo(
    () => (allMembers.data ?? []).filter((m) => m.status === MemberStatus.Active),
    [allMembers.data],
  );

  // What is already recorded, until the first tap edits it — derived from the
  // fetch rather than copied into state by an effect (rule G5).
  const saved = useMemo(() => {
    const init: Record<string, AttendanceStatus> = {};
    for (const a of detail.data?.attendance ?? []) init[a.member_id] = a.status;
    return init;
  }, [detail.data]);
  const current = marks ?? saved;

  const set = (memberId: string, status: AttendanceStatus) =>
    setMarks({ ...current, [memberId]: status });

  const loading = detail.initialLoading || allMembers.initialLoading;

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const records = members
        .filter((m) => current[m.id])
        .map((m) => ({ member_id: m.id, status: current[m.id] }));
      await api.post(`/events/${eventId}/attendance`, { records });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} size="wide">
      {err && <ErrorBanner message={err} />}
      <div className="flex-between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h3 className="serif" style={{ margin: 0, fontSize: 18 }}>
            {t('events.attendance.heading', { name: detail.data?.title ?? t('events.attendance.title') })}
          </h3>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{t('events.attendance.sub')}</div>
        </div>
        <button className="icon-btn" onClick={onClose} title={t('common.close')}>✕</button>
      </div>

      {loading ? (
        <SkeletonScreen>
          <div style={{ margin: '14px 0 4px' }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex-between" style={{ padding: '10px 4px', borderBottom: '1px solid var(--border)' }}>
                <Skeleton width={132} height={14} />
                <Skeleton width={186} height={32} radius={8} />
              </div>
            ))}
          </div>
        </SkeletonScreen>
      ) : (
        <div style={{ maxHeight: '54vh', overflowY: 'auto', margin: '14px 0 4px' }}>
          {members.map((m) => (
            <div key={m.id} className="flex-between" style={{ padding: '10px 4px', borderBottom: '1px solid var(--border)' }}>
              <strong>{m.full_name}</strong>
              <div className="seg">
                {ATTENDANCE_OPTIONS.map((st) => (
                  <button
                    key={st}
                    className={current[m.id] === st ? ATTENDANCE_TONE[st] : ''}
                    onClick={() => set(m.id, st)}
                  >
                    {t(attendanceKey(st))}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {members.length === 0 && <div className="empty-inline">{t('events.attendance.empty')}</div>}
        </div>
      )}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
        <button className="btn accent" onClick={save} disabled={saving || loading}>
          {t('events.attendance.save', { n: Object.keys(current).length })}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Add / edit one hand-added meeting. A name and a date is all it takes — the
 * Sunday sheet covers the standing services, so nothing here asks for a type,
 * a location or a recurrence. An existing meeting keeps its own time of day:
 * the field only moves the date, so a 20:00 prayer meeting does not silently
 * become a midnight one.
 */
function MeetingModal({
  event,
  onClose,
  onSaved,
  onDelete,
}: {
  event: EventRow | null;
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { hallId } = useHallScope();
  const stored = toChurchInput(event?.starts_at);
  const [form, setForm] = useState({
    title: event?.title ?? '',
    date: stored.slice(0, 10),
    // Editing keeps the meeting's own hall; creating defaults to the hall being
    // viewed (and to 全堂 only when viewing all congregations).
    hall_id: event ? event.hall_id : hallId || null,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timeOfDay = stored.slice(11, 16) || '00:00';

  const save = async () => {
    if (!form.title.trim() || !form.date) {
      setErr(t('events.err.required'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const payload = {
        title: form.title.trim(),
        starts_at: fromChurchInput(`${form.date}T${timeOfDay}`),
        hall_id: form.hall_id,
      };
      if (event) await api.patch(`/events/${event.id}`, payload);
      // `event_type` is set only on create, and never asked for: a hand-added
      // meeting is a meeting. Editing an older row leaves whatever type it
      // already carries alone.
      else await api.post('/events', { ...payload, event_type: EventType.Meeting });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={event ? t('events.edit.title') : t('events.new.title')} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <Field label={t('events.field.title')}>
        <input
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder={t('events.titlePlaceholder')}
        />
      </Field>
      <div className="form-row">
        <Field label={t('events.field.date')}>
          <input
            type="date"
            className={form.date ? undefined : 'date-empty'}
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
        </Field>
        <Field label={t('hall.label')}>
          <HallSelect
            value={form.hall_id}
            onChange={(id) => setForm({ ...form, hall_id: id })}
            allowAll
            allLabel={t('hall.allOpenEvent')}
          />
        </Field>
      </div>
      <div className="modal-actions">
        {onDelete && (
          <button className="btn danger" style={{ marginRight: 'auto' }} onClick={onDelete}>
            {t('events.delete')}
          </button>
        )}
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>
  );
}
