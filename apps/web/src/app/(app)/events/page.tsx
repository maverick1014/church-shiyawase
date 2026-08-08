'use client';

import { Fragment, useMemo, useState } from 'react';
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
  SheetTick,
  SheetTickAll,
  SkeletonScreen,
  SkeletonTable,
  useConfirm,
  useToast,
} from '@/components/ui';
import { can } from '@/lib/perms';
import { exportMatrix } from '@/lib/export';
import {
  RollCallSheet,
  RollCallSheetRow,
  SheetCell,
  SheetColumn,
  SheetMeeting,
  SheetTickName,
} from '@/lib/types';
import { columnTickState, sheetTicks, type ColumnTickState } from '@/lib/sheet';
import { sheetTickKey } from '@/lib/labels';
import { churchParts, fromChurchInput, toChurchInput } from '@/lib/time';
import { useT } from '@/lib/i18n';
import { EventType } from '@tog/shared';

/**
 * 崇拜与祷告会 — ONE roll-call sheet for the month.
 *
 * Its columns come from the calendar and from the meetings themselves, in date
 * order: every Sunday of the month with its two ticks (会前 / 主日), and each
 * meeting someone added — a 31 August night prayer meeting — with the one tick
 * a single occasion has. Nothing creates a Sunday, and a meeting's column
 * appears the moment the meeting does.
 *
 * The page never learns that those two live in different tables: the API hands
 * each column an opaque `key`, the page ticks it, and the server decides where
 * that lands (`lib/sheet.ts` + `/api/attendance/sheet`).
 *
 * With the congregation switcher on 全部堂会 the sheet simply lists every
 * member; narrowing it narrows the member list and the meetings alike.
 */
export default function EventsPage() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const perms = can(useMe().role);

  // Which month, defaulting to Malaysia's own calendar — on a UTC Worker the
  // first 8 hours of a new month still read as the old one (rule G6a).
  const nowParts = churchParts(new Date());
  const [year, setYear] = useState(nowParts.year);
  const [month, setMonth] = useState(nowParts.month);

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<SheetMeeting | null>(null);

  usePageChrome({ title: t('events.title') }, [t]);

  // useFetch appends the viewed hall itself (withHallParam), so the query here
  // carries only the month.
  const sheet = useFetch<RollCallSheet>(`/attendance/sheet?year=${year}&month=${month}`);
  const columns = sheet.data?.columns ?? [];
  const rows = sheet.data?.rows ?? [];
  // One total column per tick the sheet actually holds — a month with no
  // hand-added meeting has no 到场 column to total.
  const ticks = useMemo(() => sheetTicks(columns), [columns]);

  /** How many of the sheet's columns this member carries a given tick on. */
  const countOf = (row: RollCallSheetRow, tick: SheetTickName) =>
    columns.filter((c) => c.ticks.includes(tick) && row.cells[c.key]?.[tick]).length;

  const toggle = async (row: RollCallSheetRow, column: SheetColumn, tick: SheetTickName) => {
    const current = row.cells[column.key] ?? {};
    // Send the whole cell, so the server never has to merge a partial one.
    const next: SheetCell = {};
    for (const name of column.ticks) next[name] = !!current[name];
    next[tick] = !next[tick];
    try {
      // A list of one — the same shape the column shortcut below sends, so a
      // single tick and 全员到齐 go down exactly the same path.
      await api.put('/attendance/sheet', {
        column: column.key,
        member_ids: [row.member.id],
        ...next,
      });
      sheet.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  /** A column's own heading: a Sunday's date, or the meeting's name. */
  const columnLabel = (c: SheetColumn) => c.meeting?.title ?? c.date.slice(5);

  /** What one sub-column is called in a confirmation: "08-02 · Pre-service". */
  const tickLabel = (c: SheetColumn, tick: SheetTickName) =>
    `${columnLabel(c)} · ${t(sheetTickKey(tick))}`;

  /**
   * Every sub-column's all / none / some state, and how many ticks it holds —
   * derived once per sheet rather than per header cell (rule G5). The count is
   * what the untick confirmation quotes: a warning has to name the records it
   * is about to throw away, not describe them.
   */
  const columnStates = useMemo(() => {
    const map = new Map<string, { state: ColumnTickState; ticked: number }>();
    for (const c of columns) {
      for (const tick of c.ticks) {
        const flags = rows.map((r) => !!r.cells[c.key]?.[tick]);
        map.set(`${c.key}|${tick}`, {
          state: columnTickState(flags),
          ticked: flags.filter(Boolean).length,
        });
      }
    }
    return map;
  }, [columns, rows]);

  /**
   * 全员到齐 — fill (or clear) one whole sub-column.
   *
   * Everybody already ticked means the press CLEARS the column, which destroys
   * real records, so that direction goes through the shared confirmation with
   * the number of ticks it will remove (rule G3). Filling one needs no
   * confirmation: nothing is lost.
   *
   * The members are grouped by what their OTHER tick in this column already
   * says, so filling 主日 can never rewrite somebody's 会前 — which is exactly
   * what one flat "set the whole cell for everyone" call would have done. That
   * is at most two requests for a Sunday and one for a meeting; never one per
   * member.
   */
  const toggleColumn = async (column: SheetColumn, tick: SheetTickName) => {
    const here = columnStates.get(`${column.key}|${tick}`);
    if (!here || rows.length === 0) return;
    const next = here.state !== 'all';
    if (!next) {
      const ok = await confirm({
        title: t('sheet.tickAll.title'),
        message: t('sheet.tickAll.message', {
          column: tickLabel(column, tick),
          n: here.ticked,
        }),
        confirmText: t('sheet.tickAll.confirm'),
        danger: true,
      });
      if (!ok) return;
    }
    const groups = new Map<string, { cell: SheetCell; ids: string[] }>();
    for (const r of rows) {
      const current = r.cells[column.key] ?? {};
      const cell: SheetCell = {};
      for (const name of column.ticks) cell[name] = name === tick ? next : !!current[name];
      const shape = column.ticks.map((name) => (cell[name] ? '1' : '0')).join('');
      const group = groups.get(shape);
      if (group) group.ids.push(r.member.id);
      else groups.set(shape, { cell, ids: [r.member.id] });
    }
    try {
      await Promise.all(
        [...groups.values()].map((g) =>
          api.put('/attendance/sheet', { column: column.key, member_ids: g.ids, ...g.cell }),
        ),
      );
      sheet.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
      sheet.reload();
    }
  };

  const exportSheet = () => {
    if (!sheet.data) return;
    const headers = [
      t('members.col.member'),
      ...columns.flatMap((c) =>
        c.ticks.map((tick) => `${columnLabel(c)} ${t(sheetTickKey(tick))}`),
      ),
      ...ticks.map((tick) => `${t('events.col.total')} ${t(sheetTickKey(tick))}`),
    ];
    const matrix = rows.map((r) => [
      r.member.full_name,
      ...columns.flatMap((c) => c.ticks.map((tick) => (r.cells[c.key]?.[tick] ? '✓' : ''))),
      ...ticks.map((tick) => countOf(r, tick)),
    ]);
    exportMatrix(
      t('events.exportFile', { year, month: String(month).padStart(2, '0') }),
      t('events.sheet'),
      headers,
      matrix,
    );
  };

  const deleteMeeting = async (meeting: SheetMeeting): Promise<boolean> => {
    const ok = await confirm({
      title: t('events.delete.title'),
      message: t('events.delete.message', { name: meeting.title }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return false;
    try {
      await api.delete(`/events/${meeting.id}`);
      sheet.reload();
      toast(t('events.toast.deleted'));
      return true;
    } catch (err) {
      toast((err as Error).message, 'error');
      return false;
    }
  };

  return (
    <>
      <ErrorBanner message={sheet.error} />

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
              <button className="btn" onClick={() => setAddOpen(true)}>{t('events.addMeeting')}</button>
            )}
          </>
        }
      />

      {/* The sheet is wide by nature, so it scrolls inside its own card exactly
          like the life-group one; the page body never scrolls sideways. */}
      <div className="card">
        <div className="card-head">
          <div>
            <h3>{t('events.sheet')}</h3>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{t('events.sheetSub')}</div>
          </div>
        </div>

        {sheet.initialLoading ? (
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
                  {columns.map((c) => {
                    const meeting = c.meeting;
                    return (
                      <th key={c.key} colSpan={c.ticks.length} className="tnum" style={{ textAlign: 'center' }}>
                        {meeting && perms.write ? (
                          // A meeting's own name is where it is edited from —
                          // the sheet is the only place it is listed now.
                          <button
                            className="btn ghost sm"
                            onClick={() => setEditing(meeting)}
                            title={t('events.edit.title')}
                          >
                            {meeting.title}
                          </button>
                        ) : (
                          columnLabel(c)
                        )}
                        {meeting && (
                          <div className="faint" style={{ fontSize: 10.5, fontWeight: 400 }}>
                            {c.date.slice(5)}
                          </div>
                        )}
                      </th>
                    );
                  })}
                  <th colSpan={ticks.length} style={{ textAlign: 'center' }}>{t('events.col.total')}</th>
                </tr>
                <tr>
                  {/* Under the date, each sub-column carries its own check-all
                      — a Sunday has two ticks, so 会前 and 主日 are filled
                      independently. Hidden from a read-only account, whose
                      press could only ever be refused (rule G2). */}
                  {columns.map((c) => (
                    <Fragment key={c.key}>
                      {c.ticks.map((tick) => {
                        const here = columnStates.get(`${c.key}|${tick}`);
                        return (
                          <th key={tick} style={{ textAlign: 'center' }}>
                            <div>{t(sheetTickKey(tick))}</div>
                            {perms.write && (
                              <SheetTickAll
                                state={here?.state ?? 'none'}
                                onToggle={() => toggleColumn(c, tick)}
                                disabled={rows.length === 0}
                                title={t(
                                  here?.state === 'all' ? 'sheet.tickAll.uncheck' : 'sheet.tickAll.check',
                                  { column: tickLabel(c, tick) },
                                )}
                              />
                            )}
                          </th>
                        );
                      })}
                    </Fragment>
                  ))}
                  {ticks.map((tick) => (
                    <th key={tick} style={{ textAlign: 'center' }}>{t(sheetTickKey(tick))}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.member.id}>
                    <td><strong>{r.member.full_name}</strong></td>
                    {columns.map((c) => (
                      <Fragment key={c.key}>
                        {c.ticks.map((tick) => (
                          <td key={tick} style={{ textAlign: 'center' }}>
                            <SheetTick
                              checked={!!r.cells[c.key]?.[tick]}
                              onToggle={() => toggle(r, c, tick)}
                              disabled={!perms.write}
                              title={`${columnLabel(c)} · ${t(sheetTickKey(tick))}`}
                            />
                          </td>
                        ))}
                      </Fragment>
                    ))}
                    {ticks.map((tick) => (
                      <td key={tick} className="tnum" style={{ textAlign: 'center', fontWeight: 600 }}>
                        {countOf(r, tick)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(addOpen || editing) && (
        <MeetingModal
          meeting={editing}
          onClose={() => {
            setAddOpen(false);
            setEditing(null);
          }}
          onSaved={() => {
            const wasEdit = !!editing;
            setAddOpen(false);
            setEditing(null);
            sheet.reload();
            toast(wasEdit ? t('events.toast.updated') : t('events.toast.created'));
          }}
          onDelete={
            editing && perms.delete
              ? async () => {
                  if (await deleteMeeting(editing)) setEditing(null);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

/**
 * Add / edit one hand-added meeting. A name and a date is all it takes — the
 * sheet's Sunday columns cover the standing services, so nothing here asks for
 * a type, a location or a recurrence. An existing meeting keeps its own time of
 * day: the field only moves the date, so a 20:00 prayer meeting does not
 * silently become a midnight one.
 *
 * Deleting it takes its ticks with it, which is why that button goes through
 * the shared confirmation (rule G3) in the page above.
 */
function MeetingModal({
  meeting,
  onClose,
  onSaved,
  onDelete,
}: {
  meeting: SheetMeeting | null;
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { hallId } = useHallScope();
  const stored = toChurchInput(meeting?.starts_at);
  const [form, setForm] = useState({
    title: meeting?.title ?? '',
    date: stored.slice(0, 10),
    // Editing keeps the meeting's own hall; creating defaults to the hall being
    // viewed (and to 全堂 only when viewing all congregations).
    hall_id: meeting ? meeting.hall_id : hallId || null,
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
      if (meeting) await api.patch(`/events/${meeting.id}`, payload);
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
    <Modal title={meeting ? t('events.edit.title') : t('events.new.title')} onClose={onClose}>
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
