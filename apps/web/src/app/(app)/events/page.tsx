'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { usePageChrome, useMe, useHallScope } from '@/components/AppShell';
import { Empty, ErrorBanner, Field, HallSelect, Loading, Modal, PageBar, RepeatIcon, useConfirm, useToast } from '@/components/ui';
import { can } from '@/lib/perms';
import { EventDetail, EventRow, MemberRow } from '@/lib/types';
import {
  ATTENDANCE_OPTIONS,
  attendanceKey,
  eventBadgeClass,
  eventTypeKey,
  EVENT_TYPE_OPTIONS,
  formatDateTime,
} from '@/lib/labels';
import { addChurchDays, fromChurchInput, startOfChurchDay, toChurchInput } from '@/lib/time';
import { useT } from '@/lib/i18n';
import { AttendanceStatus, EventType, MemberStatus } from '@tog/shared';

/** Tone class per attendance option — matches the seg-button palette. */
const ATTENDANCE_TONE: Record<AttendanceStatus, string> = {
  [AttendanceStatus.Present]: 'on-good',
  [AttendanceStatus.Excused]: 'on-warn',
  [AttendanceStatus.Absent]: 'on-crit',
};

export default function EventsPage() {
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const perms = can(useMe().role);
  const events = useFetch<EventRow[]>('/events');
  const members = useFetch<MemberRow[]>('/members');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<EventRow | null>(null);

  usePageChrome({ title: t('events.title') }, [t]);

  // Same three-section shape as the training catalog, so both pages read the
  // same way: what needs attention now, what is coming, what is done.
  // "Today" is its own group because it is the one an admin actually acts on —
  // it is the roll-call list for the day.
  const { today, upcoming, past } = useMemo(() => {
    // "Today" means today in Malaysia — setHours() would use the runtime's
    // zone, so the Worker (UTC) put the 08:00-and-earlier services in the
    // wrong bucket.
    const startOfToday = startOfChurchDay();
    const startOfTomorrow = addChurchDays(startOfToday, 1);

    const td: EventRow[] = [];
    const up: EventRow[] = [];
    const pa: EventRow[] = [];
    for (const e of events.data ?? []) {
      const at = new Date(e.starts_at);
      if (at >= startOfTomorrow) up.push(e);
      else if (at >= startOfToday) td.push(e);
      else pa.push(e);
    }
    const byTime = (a: EventRow, b: EventRow) => +new Date(a.starts_at) - +new Date(b.starts_at);
    // Soonest first while it is still ahead; most recent first once it is over.
    return { today: td.sort(byTime), upcoming: up.sort(byTime), past: pa.sort(byTime).reverse() };
  }, [events.data]);

  const total = today.length + upcoming.length + past.length;

  const delEvent = async (e: EventRow): Promise<boolean> => {
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

  // One card shape for every section — same structure as a training card.
  const renderCards = (items: EventRow[], faded?: boolean) => (
    <div className="grid g3">
      {items.map((e) => (
        <div className="card" key={e.id} style={{ display: 'flex', flexDirection: 'column', opacity: faded ? 0.86 : 1 }}>
          <div className="flex-between">
            <span className={`badge ${eventBadgeClass(e.event_type)}`}>
              {t(eventTypeKey(e.event_type))}
            </span>
            {e.hall?.name && (
              <span className="muted" style={{ fontSize: 12 }}>{e.hall.name}</span>
            )}
          </div>
          <h3 style={{ margin: '12px 0 2px', fontSize: 16 }} className="serif">{e.title}</h3>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {formatDateTime(e.starts_at)}{e.location ? ` · ${e.location}` : ''}
          </div>
          <div className="grow" />
          <div className="flex gap-8 mt-14">
            <button className="btn sm grow" onClick={() => setActiveId(e.id)}>{t('events.rollCall')}</button>
            {perms.write && (
              <button className="btn ghost sm" onClick={() => setEditing(e)}>{t('common.edit')}</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );

  const section = (
    dot: string,
    title: string,
    sub: string,
    items: EventRow[],
    empty: string,
    faded?: boolean,
  ) => (
    <>
      <div className="section-label mb-14" style={{ marginTop: 28 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, display: 'inline-block' }} />
        {title} <span className="faint" style={{ fontWeight: 400 }}>{sub}</span>
      </div>
      {items.length ? renderCards(items, faded) : <div className="empty">{empty}</div>}
    </>
  );

  if (events.initialLoading) return <Loading />;

  return (
    <>
      <ErrorBanner message={events.error} />

      {perms.write && (
        <PageBar
          actions={
            <>
              <button className="btn ghost" onClick={() => router.push('/events/recurring')}>
                <RepeatIcon />
                {t('events.recurring')}
              </button>
              <button className="btn" onClick={() => setAddOpen(true)}>{t('events.add')}</button>
            </>
          }
        />
      )}

      {total === 0 ? (
        <Empty>{t('events.empty')}</Empty>
      ) : (
        <>
          {section('var(--brand)', t('events.today'), t('events.todaySub'), today, t('events.emptyToday'))}
          {section('var(--good)', t('events.upcoming'), t('events.upcomingSub'), upcoming, t('events.emptyUpcoming'))}
          {section('var(--faint)', t('events.past'), t('events.pastSub'), past, t('events.emptyPast'), true)}
        </>
      )}

      {activeId && (
        <AttendancePanel
          key={activeId}
          eventId={activeId}
          members={(members.data ?? []).filter((m) => m.status === MemberStatus.Active)}
          onClose={() => setActiveId(null)}
          onSaved={() => {
            toast(t('events.toast.attendance'));
            setActiveId(null);
          }}
        />
      )}

      {(addOpen || editing) && (
        <EventModal
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
                  if (await delEvent(editing)) setEditing(null);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

function AttendancePanel({
  eventId,
  members,
  onClose,
  onSaved,
}: {
  eventId: string;
  members: MemberRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const detail = useFetch<EventDetail>(`/events/${eventId}`);
  const t = useT();
  const toast = useToast();
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!detail.data) return;
    const init: Record<string, AttendanceStatus> = {};
    for (const a of detail.data.attendance) init[a.member_id] = a.status;
    setMarks(init);
  }, [detail.data]);

  const set = (memberId: string, status: AttendanceStatus) =>
    setMarks((m) => ({ ...m, [memberId]: status }));

  const marked = Object.keys(marks).length;

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const records = members
        .filter((m) => marks[m.id])
        .map((m) => ({ member_id: m.id, status: marks[m.id] }));
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

      {detail.loading ? (
        <div style={{ padding: 24 }}><Loading /></div>
      ) : (
        <div style={{ maxHeight: '54vh', overflowY: 'auto', margin: '14px 0 4px' }}>
          {members.map((m) => {
            const cur = marks[m.id];
            return (
              <div key={m.id} className="flex-between" style={{ padding: '10px 4px', borderBottom: '1px solid var(--border)' }}>
                <strong>{m.full_name}</strong>
                <div className="seg">
                  {ATTENDANCE_OPTIONS.map((st) => (
                    <button
                      key={st}
                      className={cur === st ? ATTENDANCE_TONE[st] : ''}
                      onClick={() => set(m.id, st)}
                    >
                      {t(attendanceKey(st))}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {members.length === 0 && <div className="empty-inline">{t('events.attendance.empty')}</div>}
        </div>
      )}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
        <button className="btn accent" onClick={save} disabled={saving || detail.loading}>
          {t('events.attendance.save', { n: marked })}
        </button>
      </div>
    </Modal>
  );
}

function EventModal({
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
  const [form, setForm] = useState({
    title: event?.title ?? '',
    event_type: (event?.event_type ?? EventType.Service) as EventType,
    location: event?.location ?? '',
    starts_at: toChurchInput(event?.starts_at),
    // Editing keeps the event's own hall; creating defaults to the hall being
    // viewed (and to the all-halls / joint option only when viewing all halls).
    hall_id: event ? event.hall_id : hallId || null,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!form.title.trim() || !form.starts_at) {
      setErr(t('events.err.required'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const payload = {
        title: form.title.trim(),
        event_type: form.event_type,
        location: form.location || null,
        starts_at: fromChurchInput(form.starts_at),
        hall_id: form.hall_id,
      };
      if (event) await api.patch(`/events/${event.id}`, payload);
      else await api.post('/events', payload);
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
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('events.titlePlaceholder')} />
      </Field>
      <div className="form-row">
        <Field label={t('events.field.type')}>
          <select value={form.event_type} onChange={(e) => setForm({ ...form, event_type: e.target.value as EventType })}>
            {EVENT_TYPE_OPTIONS.map((et) => (
              <option key={et} value={et}>{t(eventTypeKey(et))}</option>
            ))}
          </select>
        </Field>
        <Field label={t('events.field.location')}>
          <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder={t('events.locationPlaceholder')} />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('events.field.startsAt')}>
          <input type="datetime-local" className={form.starts_at ? undefined : 'date-empty'} value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
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
          <button
            className="btn danger"
            style={{ marginRight: 'auto' }}
            onClick={onDelete}
          >
            {t('events.delete')}
          </button>
        )}
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>
  );
}
