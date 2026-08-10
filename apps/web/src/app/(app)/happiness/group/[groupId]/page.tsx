'use client';

import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import {
  BackButton,
  Combobox,
  EntityHeader,
  ErrorBanner,
  ExportButton,
  FactGrid,
  MemberName,
  RoleBadge,
  RoleRestricted,
  SheetTick,
  SheetTickAll,
  SheetTotals,
  SkeletonCard,
  SkeletonScreen,
  SkeletonTable,
  SortTh,
  useConfirm,
  useToast,
} from '@/components/ui';
import { can } from '@/lib/perms';
import { exportMatrix } from '@/lib/export';
import { HappinessAttendanceResponse, HappinessGroupDetail, MemberRow } from '@/lib/types';
import { columnTickState } from '@/lib/sheet';
import { formatMeetingTime, memberRole, weekdayKey } from '@/lib/labels';
import { useT } from '@/lib/i18n';
import { AccountRole } from '@tog/shared';

export default function HappinessGroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const me = useMe();
  const perms = can(me.role);

  const detail = useFetch<HappinessGroupDetail>(`/happiness/groups/${groupId}`);
  const attendance = useFetch<HappinessAttendanceResponse>(`/happiness/groups/${groupId}/attendance`);
  const allMembers = useFetch<MemberRow[]>('/members');
  const [addSel, setAddSel] = useState('');

  usePageChrome({ title: t('happy.group.title') }, [t]);

  const roster = useMemo(() => detail.data?.members ?? [], [detail.data]);
  const weeks = attendance.data?.weeks ?? detail.data?.term?.weeks ?? 8;
  const weekList = useMemo(() => Array.from({ length: weeks }, (_, i) => i + 1), [weeks]);

  const presenceByMember = useMemo(() => {
    const map = new Map<string, Set<number>>();
    for (const rec of attendance.data?.records ?? []) {
      const set = map.get(rec.member_id) ?? new Set<number>();
      set.add(rec.week_number);
      map.set(rec.member_id, set);
    }
    return map;
  }, [attendance.data]);

  const { sorted: sortedRoster, sortKey, sortDir, toggleSort } = useSortableRows(
    roster,
    (m) => m.full_name,
    { key: 'name', dir: 'asc' },
  );

  const weekStates = useMemo(() => {
    const map = new Map<number, { state: ReturnType<typeof columnTickState>; present: number }>();
    for (const w of weekList) {
      const flags = roster.map((m) => presenceByMember.get(m.id)?.has(w) ?? false);
      map.set(w, { state: columnTickState(flags), present: flags.filter(Boolean).length });
    }
    return map;
  }, [weekList, roster, presenceByMember]);

  const totals = useMemo(
    () => weekList.map((w) => ({ key: String(w), value: weekStates.get(w)?.present ?? 0 })),
    [weekList, weekStates],
  );

  // Reuses the export dictionary's own "Week {n}" — this is the one column
  // label the sheet and its export both need, so it is written once rather
  // than twice (rule G4/G8): a week is a week whether it heads a `<th>` or a
  // spreadsheet column.
  const weekLabel = (w: number) => t('export.week', { n: w });

  const unassigned = useMemo(
    () => (allMembers.data ?? []).filter((m) => !roster.some((r) => r.id === m.id)),
    [allMembers.data, roster],
  );

  const reloadAll = () => {
    detail.reload();
    attendance.reload();
  };

  const addMember = async () => {
    if (!addSel) return;
    try {
      await api.post(`/happiness/groups/${groupId}/members`, { member_id: addSel });
      setAddSel('');
      toast(t('happy.group.toast.joined'));
      detail.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const removeMember = async (memberId: string) => {
    const who = roster.find((m) => m.id === memberId)?.full_name ?? t('happy.group.thisMember');
    const ok = await confirm({
      title: t('happy.group.removeMember.title'),
      message: t('happy.group.removeMember.message', { name: who }),
      confirmText: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/happiness/groups/${groupId}/members/${memberId}`);
      toast(t('happy.group.toast.removed'));
      reloadAll();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const toggleCell = async (memberId: string, week: number, present: boolean) => {
    try {
      await api.put(`/happiness/groups/${groupId}/attendance`, {
        week_number: week,
        member_id: memberId,
        present: !present,
      });
      attendance.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const toggleColumn = async (week: number) => {
    if (roster.length === 0) return;
    const here = weekStates.get(week);
    if (!here) return;
    const next = here.state !== 'all';
    if (!next) {
      const ok = await confirm({
        title: t('sheet.tickAll.title'),
        message: t('sheet.tickAll.message', { column: weekLabel(week), n: here.present }),
        confirmText: t('sheet.tickAll.confirm'),
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api.put(`/happiness/groups/${groupId}/attendance`, {
        week_number: week,
        member_ids: roster.map((m) => m.id),
        present: next,
      });
      attendance.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
      attendance.reload();
    }
  };

  const exportSheet = () => {
    if (!detail.data) return;
    const headers = [t('members.col.member'), ...weekList.map((w) => weekLabel(w))];
    const matrix: (string | number)[][] = sortedRoster.map((m) => [
      m.full_name,
      ...weekList.map((w) => (presenceByMember.get(m.id)?.has(w) ? '✓' : '')),
    ]);
    matrix.push([t('sheet.totalPeople'), ...totals.map((x) => x.value)]);
    exportMatrix(t('happy.attendance.exportFile', { group: detail.data.name }), t('happy.attendance.title'), headers, matrix);
  };

  // `happiness` is outside a group_leader's allowed API prefixes — reachable
  // here only by a bookmark, the catalog it is normally opened from being
  // itself `RoleRestricted`.
  if (me.role === AccountRole.GroupLeader) return <RoleRestricted />;

  if (detail.initialLoading)
    return (
      <>
        <BackButton fallbackHref="/happiness" />
        <SkeletonScreen>
          <SkeletonCard lines={3} />
          <SkeletonTable rows={4} columns={3} bare />
          <SkeletonTable rows={5} columns={8} bare />
        </SkeletonScreen>
      </>
    );
  if (detail.error || !detail.data) return <ErrorBanner message={detail.error ?? t('happy.group.notFound')} />;

  const g = detail.data;
  const facts = [
    { label: t('happy.term.col.no'), value: g.term ? g.term.term_no : '—' },
    { label: t('hall.label'), value: g.hall?.name ?? '—' },
    { label: t('happy.group.col.leader'), value: g.leader ? <MemberName member={g.leader} /> : t('common.vacant') },
    {
      label: t('happy.group.col.schedule'),
      value:
        [g.meeting_day ? t(weekdayKey(g.meeting_day)) : '', formatMeetingTime(g.meeting_time), g.location]
          .filter(Boolean)
          .join(' · ') || '—',
    },
  ];

  return (
    <>
      <BackButton fallbackHref={`/happiness/${g.term_id}`} />

      <div className="card">
        <EntityHeader title={g.name} sub={g.term?.name ?? t('happy.term.pageTitle', { no: g.term?.term_no ?? '' })} avatar={null} />
        <FactGrid facts={facts} style={{ marginTop: 18 }} />
      </div>

      <div className="grid mt-16" style={{ gridTemplateColumns: '360px 1fr', gap: 16, alignItems: 'start' }} data-glayout>
        {/* Roster */}
        <div className="card">
          <div className="card-head">
            <h3>{t('group.roster')} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>{t('happy.group.rosterCount', { n: roster.length })}</span></h3>
          </div>
          {perms.write && (
            <div className="flex gap-8 mb-14">
              <Combobox
                value={addSel}
                onChange={setAddSel}
                options={unassigned.map((m) => ({ value: m.id, label: m.full_name, sub: m.english_name }))}
                placeholder={t('happy.group.addMemberPlaceholder')}
                ariaLabel={t('happy.group.addMember')}
                style={{ flex: 1 }}
              />
              <button className="btn accent" onClick={addMember} disabled={!addSel}>{t('happy.group.addMember')}</button>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh sortKey="name" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('members.field.name')}</SortTh>
                  <th>{t('members.col.role')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sortedRoster.map((m) => (
                  <tr key={m.id}>
                    <td><MemberName member={m} /></td>
                    <td><RoleBadge role={memberRole(m)} /></td>
                    <td style={{ textAlign: 'right' }}>
                      {perms.write && (
                        <button className="btn danger" onClick={() => removeMember(m.id)}>{t('common.remove')}</button>
                      )}
                    </td>
                  </tr>
                ))}
                {sortedRoster.length === 0 && (
                  <tr><td colSpan={3} className="empty-inline">{t('happy.group.emptyRoster')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Attendance */}
        <div className="card">
          <div className="card-head">
            <div>
              <h3>{t('happy.attendance.title')}</h3>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{t('happy.attendance.sub', { n: weeks })}</div>
            </div>
          </div>
          <div className="flex gap-8 mb-14 flex-wrap">
            <div className="grow" />
            <ExportButton onClick={exportSheet} disabled={roster.length === 0} title={t('happy.attendance.exportTitle')} />
          </div>

          <ErrorBanner message={attendance.error} />

          {attendance.initialLoading ? (
            <SkeletonScreen>
              <SkeletonTable rows={5} columns={weeks} bare />
            </SkeletonScreen>
          ) : roster.length === 0 ? (
            <div className="empty">{t('happy.attendance.empty')}</div>
          ) : (
            <div className="sheet-wrap">
              <table className="sheet-table">
                <thead>
                  <tr>
                    <th>{t('members.col.member')}</th>
                    {weekList.map((w) => (
                      <th key={w} style={{ textAlign: 'center' }}>
                        <div>{weekLabel(w)}</div>
                        {perms.write && (
                          <SheetTickAll
                            state={weekStates.get(w)?.state ?? 'none'}
                            onToggle={() => toggleColumn(w)}
                            disabled={roster.length === 0}
                            title={t(
                              weekStates.get(w)?.state === 'all' ? 'sheet.tickAll.uncheck' : 'sheet.tickAll.check',
                              { column: weekLabel(w) },
                            )}
                          />
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedRoster.map((m) => (
                    <tr key={m.id}>
                      <td><MemberName member={m} /></td>
                      {weekList.map((w) => {
                        const present = presenceByMember.get(m.id)?.has(w) ?? false;
                        return (
                          <td key={w} style={{ textAlign: 'center' }}>
                            <SheetTick
                              checked={present}
                              onToggle={() => toggleCell(m.id, w, present)}
                              disabled={!perms.write}
                              title={`${weekLabel(w)} · ${t(present ? 'happy.attendance.present' : 'happy.attendance.notPresent')}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
                <SheetTotals counts={totals} />
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
