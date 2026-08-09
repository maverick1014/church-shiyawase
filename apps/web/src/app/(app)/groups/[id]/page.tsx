'use client';

import { useParams, useRouter } from 'next/navigation';
import { Fragment, useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import { BackButton, Combobox, ErrorBanner, ExportButton, Field, HallSelect, MemberName, MonthPicker, RoleBadge, SheetTick, SheetTickAll, SheetTotals, SkeletonCard, SkeletonScreen, SkeletonTable, SortTh, TagsInput, useConfirm, useToast } from '@/components/ui';
import { MemberEditModal } from '@/components/MemberEditModal';
import { useLeaderAccountEvent } from '@/components/LeaderAccountEvent';
import { can } from '@/lib/perms';
import { exportMatrix } from '@/lib/export';
import {
  GroupAttendanceResponse,
  GroupDetail,
  GroupRow,
  MemberRow,
  RollCallSheet,
  RollCallSheetRow,
  SheetCell,
  SheetColumn,
  SheetTickName,
} from '@/lib/types';
import {
  GROUP_POSITION_OPTIONS,
  roleDot,
  roleTagStyle,
  positionKey,
  sheetTickKey,
  weekdayKey,
  WEEKDAY_OPTIONS,
} from '@/lib/labels';
import { columnTickState, sheetColumnStates, sheetColumnWrites, type ColumnTickState } from '@/lib/sheet';
import { churchParts } from '@/lib/time';
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
  const { handleLeaderAccountEvent, leaderAccountModal } = useLeaderAccountEvent();
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
  // The roster row currently open in the shared member-edit modal (rule G4) —
  // one editor for the whole app, not a second copy of the form here.
  const [editMemberId, setEditMemberId] = useState<string | null>(null);

  const groupMembers = group.members;

  const leadFilled = LEADERSHIP_POSITIONS.filter((p) =>
    groupMembers.some((m) => m.group_position === p),
  ).length;

  const unassigned = useMemo(
    () => allMembers.filter((m) => m.group_id !== group.id),
    [allMembers, group.id],
  );

  // Full row for whichever roster member is currently being edited — the
  // roster table itself only carries the narrower `GroupDetail.members` shape.
  const editingMember = useMemo(
    () => allMembers.find((m) => m.id === editMemberId) ?? null,
    [allMembers, editMemberId],
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
      const updated = await api.patch<MemberRow>(`/members/${addSel}`, {
        group_id: group.id,
        group_position: GroupPosition.NewMember,
      });
      setAddSel('');
      toast(t('group.toast.joined'));
      handleLeaderAccountEvent(updated.leader_account_event, updated.full_name);
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
      const updated = await api.patch<MemberRow>(`/members/${memberId}`, { group_id: null, group_position: null });
      toast(t('group.toast.removed'));
      // Removing 小组长 from the group entirely is a demotion exactly like
      // reassigning their seat — the account (if auto-provisioned) is
      // disabled the same way (`syncGroupLeaderAccount`).
      handleLeaderAccountEvent(updated.leader_account_event, who);
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
        const demoted = await api.patch<MemberRow>(`/members/${incumbent.id}`, {
          group_position: GroupPosition.CoreMember,
        });
        // Only meaningful when `pos` is specifically Leader (every other
        // leadership seat is out of `syncGroupLeaderAccount`'s scope), but
        // the event is simply absent otherwise — nothing extra to branch on.
        handleLeaderAccountEvent(demoted.leader_account_event, incumbent.full_name);
      }
      if (memberId) {
        const promoted = await api.patch<MemberRow>(`/members/${memberId}`, { group_position: pos });
        handleLeaderAccountEvent(promoted.leader_account_event, promoted.full_name);
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
            options={groupMembers.map((m) => ({
              value: m.id,
              label: m.full_name,
              sub: m.english_name,
            }))}
            placeholder={t('common.vacant')}
            ariaLabel={t(positionKey(pos))}
          />
        ) : (
          // One line on purpose: a seat of the 铁三角 is a fixed box in the
          // triangle's grid, and the picker that replaces it for an account
          // that may write is a single-line control — a two-line name here
          // would make the three corners three different heights. The roster
          // table below carries both names for everybody in the group.
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
                  sub: m.english_name,
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
                      <MemberName member={m} />
                    </td>
                    <td>
                      <RoleBadge role={m.group_position ?? 'ungrouped'} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {perms.write && (
                        <div className="flex gap-6" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn ghost sm" onClick={() => setEditMemberId(m.id)}>{t('common.edit')}</button>
                          <button className="btn danger" onClick={() => removeMember(m.id)}>{t('common.remove')}</button>
                        </div>
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

      {editingMember && (
        <MemberEditModal
          member={editingMember}
          onClose={() => setEditMemberId(null)}
          onSaved={(leaderEvents) => {
            setEditMemberId(null);
            toast(t('member.toast.saved'));
            leaderEvents?.forEach(({ event, name }) => handleLeaderAccountEvent(event, name));
            onChanged();
          }}
        />
      )}
      {leaderAccountModal}
    </>
  );
}

/**
 * The card's roll-call table: ONE column per Sunday of the month, each
 * carrying three ticks — 小组, 会前, 主日 — rather than two blocks side by
 * side. The three read from two different places but tick on one calendar:
 *
 *   会前 / 主日  — the SAME sheet 崇拜与祷告会 draws, asked for this group's
 *                 roster (`GET /attendance/sheet?group_id=`). A tick here
 *                 quotes back the same column key, so it lands in the same
 *                 `sunday_attendance` row — filed under the member's own
 *                 congregation, server-side. Two doors, one record.
 *   小组         — this group's OWN meeting for that week
 *                 (`group_meetings` / `group_attendance`), lazily created the
 *                 first time somebody is ticked. It is filed under the
 *                 SUNDAY of that week rather than the group's own meeting
 *                 day, because the point of merging the columns is that a
 *                 group's week and the church's week are now the same week —
 *                 whichever evening the group actually met.
 *
 * `sheetColumnStates`/`sheetColumnWrites` (lib/sheet.ts) still do the counting
 * for 会前/主日, exactly as the services sheet's own table does (rule G4); 小组
 * is one tick on one table, so its own state is derived locally in the same
 * shape those two helpers already use.
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
  // The services sheet, narrowed to this group's roster — its rows are the
  // card's rows, and its Sunday columns are the card's ONLY columns.
  const sheet = useFetch<RollCallSheet>(
    `/attendance/sheet?year=${year}&month=${month}&group_id=${group.id}`,
  );
  const sundays = useMemo(() => sheet.data?.columns ?? [], [sheet.data]);
  const rows = useMemo(() => sheet.data?.rows ?? [], [sheet.data]);

  // Year options: this year, last year, plus any year that already has records.
  const years = useMemo(() => {
    const set = new Set<number>([nowParts.year, nowParts.year - 1]);
    (data?.meetings ?? []).forEach((m) => set.add(Number(m.meeting_date.slice(0, 4))));
    return [...set].filter((y) => y > 0).sort((a, b) => b - a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // date → meeting id, and member → (date → status). A week's meeting is now
  // filed under the SUNDAY of that week, so this map is keyed the same way
  // the sheet's own Sunday columns are.
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

  /**
   * 小组's own all / none / some state and headcount, one date at a time —
   * the same question `sheetColumnStates` answers for 会前/主日, computed
   * locally because 小组 lives in a different table (rule G5: counted once,
   * read by the check-all, its confirmation, and the totals row).
   */
  const weekStates = useMemo(() => {
    const map = new Map<string, { state: ColumnTickState; present: number }>();
    for (const c of sundays) {
      const flags = rows.map(
        (r) => statusByMemberDate.get(r.member.id)?.get(c.date) === AttendanceStatus.Present,
      );
      map.set(c.date, { state: columnTickState(flags), present: flags.filter(Boolean).length });
    }
    return map;
  }, [sundays, rows, statusByMemberDate]);

  /** The same question for 会前/主日 — the shared helper the services sheet uses. */
  const sundayStates = useMemo(() => sheetColumnStates(sundays, rows), [sundays, rows]);

  // The footer reads left to right exactly as the header does: 小组, 会前, 主日
  // under every date in turn.
  const totals = useMemo(
    () =>
      sundays.flatMap((c) => [
        { key: `${c.key}|group`, value: weekStates.get(c.date)?.present ?? 0 },
        ...c.ticks.map((tick) => ({
          key: `${c.key}|${tick}`,
          value: sundayStates.get(`${c.key}|${tick}`)?.ticked ?? 0,
        })),
      ]),
    [sundays, weekStates, sundayStates],
  );

  const { sorted: sortedAttendanceRows, sortKey: attSortKey, sortDir: attSortDir, toggleSort: toggleAttSort } =
    useSortableRows(rows, (r) => r.member.full_name, { key: 'name', dir: 'asc' });

  /** The week's meeting row, created lazily the first time it is marked —
      dated to the SUNDAY of that week. */
  const meetingFor = async (dateStr: string) => {
    const existing = meetingIdByDate.get(dateStr);
    if (existing) return existing;
    const meeting = await api.post<{ id: string }>(`/groups/${group.id}/meetings`, {
      meeting_date: dateStr,
    });
    return meeting.id;
  };

  /**
   * One Sunday cell — down the SAME path the services sheet uses, with the
   * column key the server handed out, so the server decides where it lands.
   * The whole cell is sent, so the server never has to merge a partial one.
   */
  const toggleSunday = async (row: RollCallSheetRow, column: SheetColumn, tick: SheetTickName) => {
    const current = row.cells[column.key] ?? {};
    const next: SheetCell = {};
    for (const name of column.ticks) next[name] = !!current[name];
    next[tick] = !next[tick];
    try {
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

  /** What one 会前/主日 sub-column is called in a title or a confirmation. */
  const sundayLabel = (c: SheetColumn, tick: SheetTickName) =>
    `${c.date.slice(5)} · ${t(sheetTickKey(tick))}`;

  /** What one date's 小组 sub-column is called — named the same way, so a
      clearing confirmation identifies WHICH week's meeting it is about to
      empty, not just that it is a 小组 column somewhere on the sheet. */
  const groupLabel = (date: string) => `${date.slice(5)} · ${t('group.sheet.groupTick')}`;

  /**
   * 全员到齐 for one 会前/主日 sub-column — the services sheet's own shortcut,
   * asked of this group's roster. Clearing throws real records away and asks
   * first (rule G3); filling asks nothing.
   */
  const toggleSundayColumn = async (column: SheetColumn, tick: SheetTickName) => {
    const here = sundayStates.get(`${column.key}|${tick}`);
    if (!here || rows.length === 0) return;
    const next = here.state !== 'all';
    if (!next) {
      const ok = await confirm({
        title: t('sheet.tickAll.title'),
        message: t('sheet.tickAll.message', { column: sundayLabel(column, tick), n: here.ticked }),
        confirmText: t('sheet.tickAll.confirm'),
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await Promise.all(
        sheetColumnWrites(column, tick, next, rows).map((g) =>
          api.put('/attendance/sheet', { column: column.key, member_ids: g.ids, ...g.cell }),
        ),
      );
      sheet.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
      sheet.reload();
    }
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

  /**
   * 全员到齐 for one date's 小组 column.
   *
   * Same two rules as the services sheet: clearing a column throws real
   * records away, so it asks first and names how many marks go (rule G3);
   * filling one asks nothing. One request either way — this endpoint has
   * always taken a LIST of records, so the whole roster rides in the same
   * call a single tick uses.
   */
  const toggleWeek = async (dateStr: string, weekLabel: string) => {
    const roster = rows;
    if (roster.length === 0) return;
    const here = weekStates.get(dateStr);
    if (!here) return;
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
    // The same columns the card shows, in the same order — 小组 then 会前/主日
    // under every date — and the same totals row under them.
    const headers = [
      t('members.col.member'),
      ...sundays.flatMap((c) => [
        `${c.date.slice(5)} ${t('group.sheet.groupTick')}`,
        ...c.ticks.map((tick) => `${c.date.slice(5)} ${t(sheetTickKey(tick))}`),
      ]),
    ];
    const matrix: (string | number)[][] = sortedAttendanceRows.map((r) => {
      const inner = statusByMemberDate.get(r.member.id);
      return [
        r.member.full_name,
        ...sundays.flatMap((c) => [
          inner?.get(c.date) === AttendanceStatus.Present ? '✓' : '',
          ...c.ticks.map((tick) => (r.cells[c.key]?.[tick] ? '✓' : '')),
        ]),
      ];
    });
    matrix.push([t('sheet.totalPeople'), ...totals.map((x) => x.value)]);
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

      {/* The card's own toolbar: the month on the left, export in the right
          corner — the same halves a PageBar has, so this row reads like every
          list page's (rule G7a). This is the CARD's row; the page bar belongs
          to the page.

          The gap is a spacer rather than `justify-content: space-between`,
          because MonthPicker is TWO selects: spreading the row would have put
          the year at the left edge, the month floating in the middle and the
          export at the right, instead of a month picker and an action. */}
      <div className="flex gap-8 mb-14 flex-wrap">
        <MonthPicker
          year={year}
          month={month}
          years={years}
          onChange={(next) => {
            setYear(next.year);
            setMonth(next.month);
          }}
        />
        <div className="grow" />
        <ExportButton onClick={exportGrid} disabled={!data} title={t('group.exportTitle')} />
      </div>

      {/* Said out loud, above the table: 会前/主日 are the church's own Sunday
          record, not a copy of it kept by this group. */}
      <div className="faint mb-14" style={{ fontSize: 12 }}>{t('group.sheet.shared')}</div>

      {/* An empty sheet and a sheet that failed to load are not the same
          answer, so a failure says so instead of reading as "no members". */}
      <ErrorBanner message={sheet.error} />

      {initialLoading || sheet.initialLoading ? (
        <SkeletonScreen>
          <SkeletonTable rows={5} columns={6} bare />
        </SkeletonScreen>
      ) : rows.length === 0 ? (
        <div className="empty">{t('group.noMembers')}</div>
      ) : (
        <div className="table-wrap">
          <table className="sheet-table">
            <thead>
              {/* One block per date — the SAME shape 崇拜与祷告会 draws its own
                  sheet in, just with a third sub-column (小组) ahead of
                  会前/主日. A leader must never wonder whether the box they are
                  ticking is the group's own night or the church's Sunday. */}
              <tr>
                <SortTh sortKey="name" activeKey={attSortKey} dir={attSortDir} onSort={toggleAttSort} rowSpan={2}>{t('members.col.member')}</SortTh>
                {sundays.map((c) => (
                  <th key={c.key} colSpan={3} className="tnum" style={{ textAlign: 'center' }}>
                    {c.date.slice(5)}
                  </th>
                ))}
              </tr>
              <tr>
                {sundays.map((c) => {
                  const groupHere = weekStates.get(c.date);
                  return (
                    <Fragment key={c.key}>
                      <th style={{ textAlign: 'center' }}>
                        <div>{t('group.sheet.groupTick')}</div>
                        {perms.write && (
                          <SheetTickAll
                            state={groupHere?.state ?? 'none'}
                            onToggle={() => toggleWeek(c.date, groupLabel(c.date))}
                            disabled={rows.length === 0}
                            title={t(
                              groupHere?.state === 'all' ? 'sheet.tickAll.uncheck' : 'sheet.tickAll.check',
                              { column: groupLabel(c.date) },
                            )}
                          />
                        )}
                      </th>
                      {/* A Sunday's two ticks are filled independently, so each
                          gets its own check-all — the services sheet's own
                          shape. */}
                      {c.ticks.map((tick) => {
                        const here = sundayStates.get(`${c.key}|${tick}`);
                        return (
                          <th key={tick} style={{ textAlign: 'center' }}>
                            <div>{t(sheetTickKey(tick))}</div>
                            {perms.write && (
                              <SheetTickAll
                                state={here?.state ?? 'none'}
                                onToggle={() => toggleSundayColumn(c, tick)}
                                disabled={rows.length === 0}
                                title={t(
                                  here?.state === 'all' ? 'sheet.tickAll.uncheck' : 'sheet.tickAll.check',
                                  { column: sundayLabel(c, tick) },
                                )}
                              />
                            )}
                          </th>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sortedAttendanceRows.map((r) => {
                const inner = statusByMemberDate.get(r.member.id);
                return (
                  <tr key={r.member.id}>
                    <td><MemberName member={r.member} /></td>
                    {sundays.map((c) => {
                      const present = inner?.get(c.date) === AttendanceStatus.Present;
                      return (
                        <Fragment key={c.key}>
                          <td style={{ textAlign: 'center' }}>
                            <SheetTick
                              checked={present}
                              onToggle={() => toggle(c.date, r.member.id, present)}
                              disabled={!perms.write}
                              // Named like a Sunday's: the date first, then
                              // what the box says about it.
                              title={`${c.date.slice(5)} · ${t(present ? 'group.attended' : 'group.notAttended')}`}
                            />
                          </td>
                          {c.ticks.map((tick) => (
                            <td key={tick} style={{ textAlign: 'center' }}>
                              <SheetTick
                                checked={!!r.cells[c.key]?.[tick]}
                                onToggle={() => toggleSunday(r, c, tick)}
                                disabled={!perms.write}
                                title={sundayLabel(c, tick)}
                              />
                            </td>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
            {/* How many people each occasion drew, under its own column —
                the same footer the other two sheets draw (rule G4). */}
            <SheetTotals counts={totals} />
          </table>
        </div>
      )}
    </div>
  );
}
