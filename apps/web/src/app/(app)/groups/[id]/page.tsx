'use client';

import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import { BackButton, Combobox, ErrorBanner, ExportButton, Field, HallSelect, MonthPicker, RoleBadge, SheetTick, SheetTickAll, SkeletonCard, SkeletonScreen, SkeletonTable, SortTh, TagsInput, useConfirm, useToast } from '@/components/ui';
import { can } from '@/lib/perms';
import { exportMatrix } from '@/lib/export';
import { GroupAttendanceResponse, GroupDetail, GroupRow, MemberRow } from '@/lib/types';
import {
  attendanceKey,
  GROUP_POSITION_OPTIONS,
  roleDot,
  roleTagStyle,
  positionKey,
  weekdayIndex,
  weekdayKey,
  WEEKDAY_OPTIONS,
} from '@/lib/labels';
import { columnTickState } from '@/lib/sheet';
import { churchParts, weekdayDatesOfMonth } from '@/lib/time';
import { useT } from '@/lib/i18n';
import { AttendanceStatus, GroupPosition, LEADERSHIP_POSITIONS, Weekday } from '@tog/shared';

export default function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const perms = can(useMe().role);

  const detail = useFetch<GroupDetail>(`/groups/${id}`);
  const members = useFetch<MemberRow[]>('/members');
  const allGroups = useFetch<GroupRow[]>('/groups');

  usePageChrome({ title: t('group.title') }, [id, t]);

  const refreshAll = () => {
    detail.reload();
    members.reload();
  };

  // Distinct tags across every group, for the tag-input autocomplete.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    (allGroups.data ?? []).forEach((g) => (g.tags ?? []).forEach((t) => set.add(t)));
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
  }, [allGroups.data]);

  // The roll-call card sits above the two-column profile/roster split — the
  // skeleton mirrors that stack, including the same collapse-on-tablet grid.
  if (detail.initialLoading)
    return (
      <>
        <BackButton onClick={() => router.push('/groups')} />
        <SkeletonScreen>
          <SkeletonCard lines={4} />
          <div
            className="grid mt-16"
            style={{ gridTemplateColumns: '360px 1fr', gap: 16, alignItems: 'start' }}
            data-glayout
          >
            <SkeletonCard lines={6} />
            <SkeletonCard lines={6} />
          </div>
        </SkeletonScreen>
      </>
    );
  if (detail.error || !detail.data) return <ErrorBanner message={detail.error ?? t('group.notFound')} />;

  return (
    <>
      <BackButton onClick={() => router.push('/groups')} />

      <GroupPanel
        group={detail.data}
        allMembers={members.data ?? []}
        allTags={allTags}
        onChanged={refreshAll}
        onDeleted={() => {
          toast(t('group.toast.deleted'));
          router.push('/groups');
        }}
      />
    </>
  );
}

function GroupPanel({
  group,
  allMembers,
  allTags,
  onChanged,
  onDeleted,
}: {
  group: GroupDetail;
  allMembers: MemberRow[];
  allTags: string[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const perms = can(useMe().role);
  const [name, setName] = useState(group.name);
  const [desc, setDesc] = useState(group.description ?? '');
  const [meetingDay, setMeetingDay] = useState<Weekday | ''>(group.meeting_day ?? '');
  const [meetingTime, setMeetingTime] = useState(group.meeting_time?.slice(0, 5) ?? '');
  const [location, setLocation] = useState(group.location ?? '');
  const [tags, setTags] = useState<string[]>(group.tags ?? []);
  const [hall, setHall] = useState<string | null>(group.hall_id ?? null);
  const [addSel, setAddSel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const groupMembers = group.members;

  const leadFilled = LEADERSHIP_POSITIONS.filter((p) =>
    groupMembers.some((m) => m.group_position === p),
  ).length;

  const unassigned = useMemo(
    () => allMembers.filter((m) => m.group_id !== group.id),
    [allMembers, group.id],
  );

  // Highest rank first — matching GROUP_POSITION_OPTIONS' own promotion order
  // (leader … new member).
  const positionRank = (pos: GroupPosition | null) =>
    (GROUP_POSITION_OPTIONS as readonly GroupPosition[]).indexOf(pos ?? GroupPosition.NewMember);

  const { sorted: sortedGroupMembers, sortKey: memberSortKey, sortDir: memberSortDir, toggleSort: toggleMemberSort } =
    useSortableRows(
      groupMembers,
      (m, key) => (key === 'name' ? m.full_name : positionRank(m.group_position)),
      { key: 'position', dir: 'asc' },
    );

  const saveGroup = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/groups/${group.id}`, {
        name,
        description: desc || null,
        meeting_day: meetingDay || null,
        meeting_time: meetingTime || null,
        location: location || null,
        tags,
        hall_id: hall,
      });
      toast(t('group.toast.saved'));
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const deleteGroup = async () => {
    const ok = await confirm({
      title: t('group.delete.title'),
      message: t('group.delete.message', { name: group.name }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/groups/${group.id}`);
      onDeleted();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    }
  };

  const addMember = async () => {
    if (!addSel) return;
    try {
      await api.patch(`/members/${addSel}`, {
        group_id: group.id,
        group_position: GroupPosition.NewMember,
      });
      setAddSel('');
      toast(t('group.toast.joined'));
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    }
  };

  const removeMember = async (memberId: string) => {
    const who = groupMembers.find((m) => m.id === memberId)?.full_name ?? t('group.thisMember');
    const ok = await confirm({
      title: t('group.removeMember.title'),
      message: t('group.removeMember.message', { name: who }),
      confirmText: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.patch(`/members/${memberId}`, { group_id: null, group_position: null });
      toast(t('group.toast.removed'));
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    }
  };

  // The only place a member's identity is assigned from this page: picking who
  // holds each of the 3 leadership slots. Every other rank (core / regular /
  // new member) is set on the member's own profile page — keeps this simple.
  const assignLeadership = async (pos: GroupPosition, memberId: string) => {
    setErr(null);
    try {
      const incumbent = groupMembers.find((m) => m.group_position === pos);
      if (incumbent && incumbent.id !== memberId) {
        await api.patch(`/members/${incumbent.id}`, { group_position: GroupPosition.CoreMember });
      }
      if (memberId) {
        await api.patch(`/members/${memberId}`, { group_position: pos });
      }
      toast(t('group.toast.leadership'));
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    }
  };

  /*
   * One seat of the 铁三角. The node is a plain grid item — never absolutely
   * positioned — so however long its role label runs ("Penolong ketua" and
   * "Assistant leader" are three times the width of 副组长) it can only ever
   * push its own box taller, not slide on top of a neighbour or the triangle.
   * The corner it occupies and the triangle behind it are decided in CSS
   * (`.trio*` in globals.css), from the block's own width.
   */
  const renderTriNode = (pos: GroupPosition, apex = false) => {
    const holder = groupMembers.find((m) => m.group_position === pos);
    return (
      <div className={apex ? 'trio-node trio-apex' : 'trio-node'}>
        <span className={`badge trio-role ${holder ? '' : 'b-gray'}`} style={holder ? roleTagStyle(pos) : undefined}>
          {holder && <i className="dot" style={{ background: roleDot(pos) }} />}
          {t(positionKey(pos))}
        </span>
        {perms.write ? (
          // Type-to-search like every other member field (rule G4): a large
          // group's roster is no nicer to scroll here than anywhere else.
          <Combobox
            size="sm"
            className="trio-pick"
            value={holder?.id ?? ''}
            onChange={(id) => assignLeadership(pos, id)}
            options={groupMembers.map((m) => ({ value: m.id, label: m.full_name }))}
            placeholder={t('common.vacant')}
            ariaLabel={t(positionKey(pos))}
          />
        ) : (
          <strong className={`trio-name${holder ? '' : ' vacant'}`}>
            {holder?.full_name ?? t('common.vacant')}
          </strong>
        )}
      </div>
    );
  };

  return (
    <>
      {err && <ErrorBanner message={err} />}

      {/* Roll-call first: once a group is set up, marking attendance is what
          leaders open this page for. Profile + roster follow below. */}
      <WeeklyAttendance group={group} />

      <div className="grid mt-16" style={{ gridTemplateColumns: '360px 1fr', gap: 16, alignItems: 'start' }} data-glayout>
        {/* Left — group info + leadership trio */}
        <div className="card">
          <div className="card-head">
            <h3>{t('group.info')}</h3>
          </div>
          <Field label={t('groups.field.name')}>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('hall.label')}>
            <HallSelect value={hall} onChange={setHall} />
          </Field>
          <Field label={t('groups.field.desc')}>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} />
          </Field>
          <div className="form-row">
            <Field label={t('groups.field.day')}>
              <select value={meetingDay} onChange={(e) => setMeetingDay(e.target.value as Weekday | '')}>
                <option value="">{t('groups.dayUnset')}</option>
                {WEEKDAY_OPTIONS.map((d) => (
                  <option key={d} value={d}>{t(weekdayKey(d))}</option>
                ))}
              </select>
            </Field>
            <Field label={t('groups.field.time')}>
              <input type="time" className={meetingTime ? undefined : 'date-empty'} value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} />
            </Field>
          </div>
          <Field label={t('groups.field.location')}>
            <input value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
          <Field label={t('groups.field.tags')}>
            <TagsInput value={tags} onChange={setTags} suggestions={allTags} placeholder={t('groups.tagsPlaceholder')} />
          </Field>

          <div className="flex-between flex-wrap trio-head">
            <div className="section-label">
              {t('group.triangle')} <span className="muted trio-sub">{t('group.triangleSub')}</span>
            </div>
            <span className="faint trio-count">{t('group.filled', { n: leadFilled })}</span>
          </div>
          <div className="trio">
            <div className="trio-grid">
              {/* Decoration only: the triangle the three seats sit on. It is
                  stretched to whatever box the grid ends up being (hence the
                  percentage viewBox and `preserveAspectRatio="none"`), so it
                  follows the layout instead of assuming a fixed 300×150 box
                  the way the old absolutely-positioned version did.
                  `non-scaling-stroke` keeps the dashes even under that
                  non-uniform stretch. */}
              <svg className="trio-frame" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                <path
                  d="M50 10 L3 97 L97 97 Z"
                  fill="var(--brand)"
                  fillOpacity="0.07"
                  stroke="var(--border)"
                  strokeWidth="1.5"
                  strokeDasharray="5 5"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              {renderTriNode(GroupPosition.Leader, true)}
              {renderTriNode(GroupPosition.AssistantLeader)}
              {renderTriNode(GroupPosition.InternLeader)}
            </div>
          </div>

          <div className="hint" style={{ margin: '12px 0 14px' }}>{t('group.hint')}</div>
          {perms.write && (
            <div className="flex gap-8">
              <button className="btn" onClick={saveGroup} disabled={busy}>{t('group.saveSettings')}</button>
              {perms.delete && <button className="btn danger" onClick={deleteGroup}>{t('group.delete.title')}</button>}
            </div>
          )}
        </div>

        {/* Right — member list */}
        <div className="card">
          <div className="card-head">
            <h3>{t('group.roster')} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>{t('group.rosterCount', { n: groupMembers.length })}</span></h3>
          </div>
          {perms.write && (
            <div className="flex gap-8 mb-14">
              <Combobox
                value={addSel}
                onChange={setAddSel}
                options={unassigned.map((m) => ({
                  value: m.id,
                  label: m.full_name,
                  hint: m.group?.name,
                }))}
                placeholder={t('group.addMemberPlaceholder')}
                ariaLabel={t('group.addMember')}
                style={{ flex: 1 }}
              />
              <button className="btn accent" onClick={addMember} disabled={!addSel}>{t('group.addMember')}</button>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh sortKey="name" activeKey={memberSortKey} dir={memberSortDir} onSort={toggleMemberSort}>{t('members.field.name')}</SortTh>
                  <SortTh sortKey="position" activeKey={memberSortKey} dir={memberSortDir} onSort={toggleMemberSort}>{t('members.col.role')}</SortTh>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sortedGroupMembers.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.full_name}</strong>
                    </td>
                    <td>
                      <RoleBadge role={m.group_position ?? 'ungrouped'} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {perms.write && (
                        <button className="btn danger" onClick={() => removeMember(m.id)}>{t('common.remove')}</button>
                      )}
                    </td>
                  </tr>
                ))}
                {sortedGroupMembers.length === 0 && (
                  <tr>
                    <td colSpan={3} className="empty-inline">
                      {t('group.emptyRoster')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The columns of one month's sheet: the dates this group meets on, plus every
 * date it has already been rolled on.
 *
 * Both halves matter. The generated half followed Sunday no matter what day the
 * group actually met, so a Tuesday group was rolled against Sundays. The
 * recorded half is what keeps a month that already has ticks from moving when
 * someone later changes 聚会星期 — the meetings that happened are facts, and a
 * new meeting day only decides where the *empty* columns fall.
 */
function weeksOfMonth(
  year: number,
  month1to12: number,
  weekday: number,
  recorded: string[] = [],
): { no: number; date: string; day: number }[] {
  // Which dates a month holds is shared with the Sunday sheet — one helper in
  // lib/time.ts rather than the same walk twice (rule G4).
  const dates = new Set<string>(weekdayDatesOfMonth(year, month1to12, weekday));
  const prefix = `${year}-${String(month1to12).padStart(2, '0')}-`;
  for (const r of recorded) if (r.startsWith(prefix)) dates.add(r);

  return [...dates]
    .sort()
    .map((date, i) => ({ no: i + 1, date, day: Number(date.slice(8, 10)) }));
}

/**
 * The group's roll-call card: the group's OWN meetings
 * (`group_meetings` / `group_attendance`), one column per date it meets on
 * plus every date it has already been rolled on.
 *
 * It is deliberately only that. A member's Sunday attendance is one fact taken
 * once, on the 崇拜与祷告会 sheet — reading the same rows back here under a tab
 * gave two places to look at the same thing and neither was the obvious one.
 */
function WeeklyAttendance({ group }: { group: GroupDetail }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const perms = can(useMe().role);

  // Which month "now" is defaults to Malaysia's calendar, not the runtime's —
  // on a UTC Worker the first 8 hours of a new month still read as the old one.
  const nowParts = churchParts(new Date());
  const [year, setYear] = useState(nowParts.year);
  const [month, setMonth] = useState(nowParts.month);

  const { data, initialLoading, reload } = useFetch<GroupAttendanceResponse>(
    `/groups/${group.id}/attendance`,
  );

  // The columns are the group's own meeting day for that month, plus any date
  // it was already rolled on — so a month with ticks keeps its dates when
  // someone changes 聚会星期 later, and only the empty columns move.
  const weeks = useMemo(
    () =>
      weeksOfMonth(
        year,
        month,
        weekdayIndex(group.meeting_day),
        (data?.meetings ?? []).map((m) => m.meeting_date.slice(0, 10)),
      ),
    [year, month, group.meeting_day, data],
  );

  // Year options: this year, last year, plus any year that already has records.
  const years = useMemo(() => {
    const set = new Set<number>([nowParts.year, nowParts.year - 1]);
    (data?.meetings ?? []).forEach((m) => set.add(Number(m.meeting_date.slice(0, 4))));
    return [...set].filter((y) => y > 0).sort((a, b) => b - a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // date → meeting id, and member → (date → status), so a week column can look
  // up its cell regardless of which meetings currently exist.
  const meetingIdByDate = useMemo(() => {
    const m = new Map<string, string>();
    (data?.meetings ?? []).forEach((mt) => m.set(mt.meeting_date.slice(0, 10), mt.id));
    return m;
  }, [data]);

  const statusByMemberDate = useMemo(() => {
    const dateOf = new Map<string, string>();
    (data?.meetings ?? []).forEach((mt) => dateOf.set(mt.id, mt.meeting_date.slice(0, 10)));
    const map = new Map<string, Map<string, AttendanceStatus | null>>();
    (data?.rows ?? []).forEach((r) => {
      const inner = new Map<string, AttendanceStatus | null>();
      r.cells.forEach((c) => {
        const ds = dateOf.get(c.meeting_id);
        if (ds) inner.set(ds, c.status);
      });
      map.set(r.member.id, inner);
    });
    return map;
  }, [data]);

  const presentCount = (memberId: string) => {
    const inner = statusByMemberDate.get(memberId);
    return weeks.filter((w) => inner?.get(w.date) === AttendanceStatus.Present).length;
  };

  const { sorted: sortedAttendanceRows, sortKey: attSortKey, sortDir: attSortDir, toggleSort: toggleAttSort } =
    useSortableRows(
      data?.rows ?? [],
      (r, key) => (key === 'count' ? presentCount(r.member.id) : r.member.full_name),
      { key: 'name', dir: 'asc' },
    );

  /** The week's meeting row, created lazily the first time it is marked. */
  const meetingFor = async (dateStr: string) => {
    const existing = meetingIdByDate.get(dateStr);
    if (existing) return existing;
    const meeting = await api.post<{ id: string }>(`/groups/${group.id}/meetings`, {
      meeting_date: dateStr,
    });
    return meeting.id;
  };

  const toggle = async (dateStr: string, memberId: string, present: boolean) => {
    const next = present ? AttendanceStatus.Absent : AttendanceStatus.Present;
    try {
      const mid = await meetingFor(dateStr);
      // A list of one — the same call the column shortcut below makes, so a
      // single tick and 全员到齐 can never take different paths.
      await api.post(`/groups/meetings/${mid}/attendance`, {
        records: [{ member_id: memberId, status: next }],
      });
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  /** Who is marked present on one week, and whether that is all / none / some. */
  const weekState = (dateStr: string) => {
    const flags = (data?.rows ?? []).map(
      (r) => statusByMemberDate.get(r.member.id)?.get(dateStr) === AttendanceStatus.Present,
    );
    return { state: columnTickState(flags), present: flags.filter(Boolean).length };
  };

  /**
   * 全员到齐 for one week's column.
   *
   * Same two rules as the services sheet: clearing a column throws real records
   * away, so it asks first and names how many marks go (rule G3); filling one
   * asks nothing. One request either way — this endpoint has always taken a
   * LIST of records, so the whole roster rides in the same call a single tick
   * uses.
   */
  const toggleWeek = async (dateStr: string, weekLabel: string) => {
    const roster = data?.rows ?? [];
    if (roster.length === 0) return;
    const here = weekState(dateStr);
    const next = here.state !== 'all';
    if (!next) {
      const ok = await confirm({
        title: t('sheet.tickAll.title'),
        message: t('sheet.tickAll.message', { column: weekLabel, n: here.present }),
        confirmText: t('sheet.tickAll.confirm'),
        danger: true,
      });
      if (!ok) return;
    }
    const status = next ? AttendanceStatus.Present : AttendanceStatus.Absent;
    try {
      const mid = await meetingFor(dateStr);
      await api.post(`/groups/meetings/${mid}/attendance`, {
        records: roster.map((r) => ({ member_id: r.member.id, status })),
      });
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
      reload();
    }
  };

  const exportGrid = () => {
    if (!data) return;
    const headers = [
      t('members.col.member'),
      ...weeks.map((w) => `${t('group.week', { n: w.no })} (${t('group.dayOfMonth', { n: w.day })})`),
      t('group.attended'),
    ];
    const matrix = sortedAttendanceRows.map((r) => {
      const inner = statusByMemberDate.get(r.member.id);
      const cells = weeks.map((w) => {
        const s = inner?.get(w.date);
        return s ? t(attendanceKey(s)) : '';
      });
      return [r.member.full_name, ...cells, presentCount(r.member.id)];
    });
    exportMatrix(
      t('group.exportFile', { year, month: String(month).padStart(2, '0') }),
      t('group.attended'),
      headers,
      matrix,
    );
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>{t('group.weekly')}</h3>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{t('group.weeklySub')}</div>
        </div>
      </div>

      {/* The card's own toolbar: the month it is showing, then export at the
          end — the same order every page bar puts them in (rule G7a). This is
          the CARD's row; the page bar belongs to the page. */}
      {/* Month picker left, export in the right corner — the same halves a
          PageBar has, so this card's row reads like every list page's
          (rule G7a). It sat next to the picker before, which put the one
          action on a different side here than everywhere else. */}
      <div className="flex-between gap-8 mb-14 flex-wrap">
        <MonthPicker
          year={year}
          month={month}
          years={years}
          onChange={(next) => {
            setYear(next.year);
            setMonth(next.month);
          }}
        />
        <ExportButton onClick={exportGrid} disabled={!data} title={t('group.exportTitle')} />
      </div>

      {initialLoading ? (
        <SkeletonScreen>
          <SkeletonTable rows={5} columns={6} bare />
        </SkeletonScreen>
      ) : !data || data.rows.length === 0 ? (
        <div className="empty">{t('group.noMembers')}</div>
      ) : (
        <div className="table-wrap">
          <table className="sheet-table">
            <thead>
              <tr>
                <SortTh sortKey="name" activeKey={attSortKey} dir={attSortDir} onSort={toggleAttSort}>{t('members.col.member')}</SortTh>
                {/* Under the date: the week's own check-all. 全员到齐 is the
                    normal case, and ticking a roster one person at a time is
                    the thing this page is asked to stop making people do.
                    Hidden from a read-only account (rule G2). */}
                {weeks.map((w) => {
                  const label = t('group.week', { n: w.no });
                  const here = weekState(w.date);
                  return (
                    <th key={w.date} style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                      {label}
                      <div className="faint" style={{ fontSize: 10.5, fontWeight: 400 }}>{t('group.dayOfMonth', { n: w.day })}</div>
                      {perms.write && (
                        <SheetTickAll
                          state={here.state}
                          onToggle={() => toggleWeek(w.date, label)}
                          disabled={(data?.rows ?? []).length === 0}
                          title={t(
                            here.state === 'all' ? 'sheet.tickAll.uncheck' : 'sheet.tickAll.check',
                            { column: label },
                          )}
                        />
                      )}
                    </th>
                  );
                })}
                <SortTh sortKey="count" activeKey={attSortKey} dir={attSortDir} onSort={toggleAttSort} align="center">{t('group.attended')}</SortTh>
              </tr>
            </thead>
            <tbody>
              {sortedAttendanceRows.map((r) => {
                const inner = statusByMemberDate.get(r.member.id);
                return (
                  <tr key={r.member.id}>
                    <td><strong>{r.member.full_name}</strong></td>
                    {weeks.map((w) => {
                      const present = inner?.get(w.date) === AttendanceStatus.Present;
                      return (
                        <td key={w.date} style={{ textAlign: 'center' }}>
                          <SheetTick
                            checked={present}
                            onToggle={() => toggle(w.date, r.member.id, present)}
                            disabled={!perms.write}
                            title={present ? t('group.attended') : t('group.notAttended')}
                          />
                        </td>
                      );
                    })}
                    <td style={{ textAlign: 'center', fontWeight: 600 }}>
                      {presentCount(r.member.id)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
