'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe, useHallScope } from '@/components/AppShell';
import {
  BackBar,
  ChevronRightIcon,
  ErrorBanner,
  Field,
  HallSelect,
  Loading,
  Modal,
  SortTh,
  useConfirm,
  useToast,
} from '@/components/ui';
import { can } from '@/lib/perms';
import { RecurringEventRow } from '@/lib/types';
import {
  EVENT_TYPE_OPTIONS,
  eventBadgeClass,
  eventTypeKey,
  formatDate,
  formatMeetingTime,
  weekdayKey,
  WEEKDAY_OPTIONS,
} from '@/lib/labels';
import { churchDayOfWeek, churchInstant, churchParts } from '@/lib/time';
import { useT } from '@/lib/i18n';
import { EventType, Weekday } from '@tog/shared';

/** The next date this rule will land on, for the "next" column. */
function nextOccurrence(weekday: Weekday, time: string): Date {
  const WEEKDAY_INDEX: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  };
  // All of this is Malaysia time: which day it is now, which weekday that is,
  // and what the rule's start_time means. Using the runtime's zone put the
  // Worker (UTC) a day out for anything scheduled before 08:00.
  const now = new Date();
  const p = churchParts(now);
  const todayIdx = churchDayOfWeek(now);
  const target = WEEKDAY_INDEX[weekday] ?? 0;
  const [h, m] = time.split(':').map(Number);
  let day = p.day + ((target - todayIdx + 7) % 7);
  let at = churchInstant(p.year, p.month, day, h || 0, m || 0);
  // Today but already past → next week.
  if (at.getTime() < now.getTime()) {
    day += 7;
    at = churchInstant(p.year, p.month, day, h || 0, m || 0);
  }
  return at;
}

export default function RecurringEventsPage() {
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const perms = can(useMe().role);
  const { locked: hallLocked } = useHallScope();
  const rules = useFetch<RecurringEventRow[]>('/recurring-events');
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringEventRow | null>(null);

  usePageChrome({ title: t('recurring.title') }, [t]);

  const rows = useMemo(
    () =>
      (rules.data ?? []).map((r) => ({
        ...r,
        next: nextOccurrence(r.weekday, r.start_time),
      })),
    [rules.data],
  );

  const { sorted, sortKey, sortDir, toggleSort } = useSortableRows(
    rows,
    (r, key) => {
      switch (key) {
        case 'type':
          return t(eventTypeKey(r.event_type));
        case 'when':
          return `${r.weekday}${r.start_time}`;
        case 'hall':
          return r.hall?.name ?? undefined;
        case 'next':
          return r.next.getTime();
        case 'active':
          return r.active ? 0 : 1;
        default:
          return r.title;
      }
    },
    { key: 'when', dir: 'asc' },
  );

  const remove = async (r: RecurringEventRow): Promise<boolean> => {
    const ok = await confirm({
      title: t('recurring.delete.title'),
      message: t('recurring.delete.message', { name: r.title }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return false;
    try {
      await api.delete(`/recurring-events/${r.id}`);
      rules.reload();
      toast(t('recurring.toast.deleted'));
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    }
  };

  const toggleActive = async (r: RecurringEventRow) => {
    try {
      await api.patch(`/recurring-events/${r.id}`, { active: !r.active });
      rules.reload();
      toast(r.active ? t('recurring.toast.paused') : t('recurring.toast.resumed'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (rules.initialLoading) return <Loading />;

  return (
    <>
      {/* Back and this page's one action share a row — the page has no filters,
          so a second bar below back was an empty row's worth of height. */}
      <BackBar
        onBack={() => router.push('/events')}
        actions={
          perms.write && (
            <button className="btn" onClick={() => setAddOpen(true)}>{t('recurring.add')}</button>
          )
        }
      />

      <ErrorBanner message={rules.error} />

      <div className="hint mb-16">{t('recurring.hint')}</div>

      {/* Desktop — table */}
      <div className="card only-desktop" style={{ padding: 6 }}>
        <div className="table-wrap">
          <table className="table-fixed">
            <thead>
              <tr>
                <SortTh sortKey="title" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('recurring.col.name')}</SortTh>
                <SortTh sortKey="type" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('recurring.col.type')}</SortTh>
                <SortTh sortKey="when" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('recurring.col.when')}</SortTh>
                {!hallLocked && (
                  <SortTh sortKey="hall" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('hall.label')}</SortTh>
                )}
                <th>{t('recurring.col.location')}</th>
                <SortTh sortKey="next" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('recurring.col.next')}</SortTh>
                <SortTh sortKey="active" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('recurring.col.status')}</SortTh>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.title}</strong></td>
                  <td>
                    <span className={`badge ${eventBadgeClass(r.event_type)}`}>
                      {t(eventTypeKey(r.event_type))}
                    </span>
                  </td>
                  <td className="muted">
                    {t('recurring.every', {
                      day: t(weekdayKey(r.weekday)),
                      time: formatMeetingTime(r.start_time),
                    })}
                  </td>
                  {!hallLocked && <td className="muted">{r.hall?.name ?? t('hall.allOpen')}</td>}
                  <td className="muted">{r.location ?? '—'}</td>
                  <td className="muted tnum">{r.active ? formatDate(r.next.toISOString()) : '—'}</td>
                  <td>
                    <span className={`badge ${r.active ? 'b-good' : 'b-gray'}`}>
                      {r.active ? t('common.enabled') : t('common.disabled')}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {perms.write && (
                      <button className="btn ghost sm" onClick={() => toggleActive(r)}>
                        {r.active ? t('common.disable') : t('common.enable')}
                      </button>
                    )}
                    {perms.write && (
                      <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => setEditing(r)}>{t('common.edit')}</button>
                    )}
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={hallLocked ? 7 : 8} className="empty-inline">
                    {t('recurring.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile — list tiles */}
      <div className="only-mobile">
        {sorted.map((r) => (
          <div key={r.id} className="mtile" onClick={perms.write ? () => setEditing(r) : undefined}>
            <div className="mtile-row1">
              <div style={{ minWidth: 0 }}>
                <strong>{r.title}</strong>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {' · '}
                  {t('recurring.every', {
                    day: t(weekdayKey(r.weekday)),
                    time: formatMeetingTime(r.start_time),
                  })}
                </span>
              </div>
              <div className="flex items-center gap-8" style={{ flexShrink: 0 }}>
                <span className={`badge ${r.active ? 'b-good' : 'b-gray'}`}>
                  {r.active ? t('common.enabled') : t('common.disabled')}
                </span>
                {perms.write && <span className="mtile-cta"><ChevronRightIcon /></span>}
              </div>
            </div>
            <div className="mtile-line">
              {r.hall?.name ?? t('hall.allOpen')}
              {r.location ? ` · ${r.location}` : ''}
              {r.active
                ? ` ${t('recurring.nextInline', { date: formatDate(r.next.toISOString()) })}`
                : ''}
            </div>
          </div>
        ))}
        {sorted.length === 0 && (
          <div className="empty-inline">{t('recurring.empty')}</div>
        )}
      </div>

      {(addOpen || editing) && (
        <RecurringModal
          rule={editing}
          onClose={() => {
            setAddOpen(false);
            setEditing(null);
          }}
          onSaved={() => {
            const wasEdit = !!editing;
            setAddOpen(false);
            setEditing(null);
            rules.reload();
            toast(wasEdit ? t('recurring.toast.updated') : t('recurring.toast.created'));
          }}
          onDelete={
            editing && perms.delete
              ? async () => {
                  // Only close the modal once the delete is confirmed — backing
                  // out of the confirmation must leave the edits on screen.
                  if (await remove(editing)) setEditing(null);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

function RecurringModal({
  rule,
  onClose,
  onSaved,
  onDelete,
}: {
  rule: RecurringEventRow | null;
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { hallId } = useHallScope();
  const [form, setForm] = useState({
    title: rule?.title ?? t('recurring.defaultTitle'),
    event_type: (rule?.event_type ?? EventType.Service) as EventType,
    weekday: (rule?.weekday ?? Weekday.Sunday) as Weekday,
    start_time: rule?.start_time?.slice(0, 5) ?? '10:00',
    location: rule?.location ?? '',
    hall_id: rule ? rule.hall_id : hallId || null,
    lookahead_days: rule?.lookahead_days ?? 35,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!form.title.trim()) {
      setErr(t('recurring.err.name'));
      return;
    }
    if (!form.start_time) {
      setErr(t('recurring.err.time'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const payload = {
        title: form.title.trim(),
        event_type: form.event_type,
        weekday: form.weekday,
        start_time: form.start_time,
        location: form.location || null,
        hall_id: form.hall_id,
        lookahead_days: Number(form.lookahead_days) || 35,
      };
      if (rule) await api.patch(`/recurring-events/${rule.id}`, payload);
      else await api.post('/recurring-events', payload);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={rule ? t('recurring.edit.title') : t('recurring.new.title')} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <Field label={t('recurring.col.name')}>
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('recurring.titlePlaceholder')} />
      </Field>
      <div className="form-row">
        <Field label={t('events.field.type')}>
          <select value={form.event_type} onChange={(e) => setForm({ ...form, event_type: e.target.value as EventType })}>
            {EVENT_TYPE_OPTIONS.map((et) => (
              <option key={et} value={et}>{t(eventTypeKey(et))}</option>
            ))}
          </select>
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
      <div className="form-row">
        <Field label={t('recurring.field.everyWeek')}>
          <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: e.target.value as Weekday })}>
            {WEEKDAY_OPTIONS.map((d) => (
              <option key={d} value={d}>{t(weekdayKey(d))}</option>
            ))}
          </select>
        </Field>
        <Field label={t('training.session.time')}>
          <input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('recurring.col.location')}>
          <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder={t('recurring.locationPlaceholder')} />
        </Field>
        <Field label={t('recurring.field.lookahead')}>
          <input
            type="number"
            min={1}
            max={365}
            value={form.lookahead_days}
            onChange={(e) => setForm({ ...form, lookahead_days: Number(e.target.value) })}
          />
        </Field>
      </div>
      <div className="hint" style={{ marginBottom: 14 }}>{t('recurring.lookaheadHint')}</div>
      <div className="modal-actions">
        {onDelete && (
          <button
            className="btn danger"
            style={{ marginRight: 'auto' }}
            onClick={onDelete}
          >
            {t('recurring.delete')}
          </button>
        )}
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>
  );
}
