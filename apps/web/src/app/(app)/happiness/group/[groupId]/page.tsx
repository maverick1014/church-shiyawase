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
  ErrorBanner,
  ExportButton,
  Field,
  HallSelect,
  MemberName,
  RoleRestricted,
  SheetTick,
  SheetTickAll,
  SheetTotals,
  SkeletonCard,
  SkeletonScreen,
  SkeletonTable,
  SortTh,
  useConfirm,
  useFormGuard,
  useToast,
} from '@/components/ui';
import { can, Perms } from '@/lib/perms';
import { exportMatrix } from '@/lib/export';
import { HappinessAttendanceResponse, HappinessGroupDetail, MemberRow } from '@/lib/types';
import { columnTickState } from '@/lib/sheet';
import { weekdayKey, WEEKDAY_OPTIONS } from '@/lib/labels';
import { useT } from '@/lib/i18n';
import { AccountRole, ChurchRole, Weekday } from '@tog/shared';

export default function HappinessGroupDetailPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const me = useMe();
  const perms = can(me.role);

  const detail = useFetch<HappinessGroupDetail>(`/happiness/groups/${groupId}`);
  const attendance = useFetch<HappinessAttendanceResponse>(`/happiness/groups/${groupId}/attendance`);
  const allMembers = useFetch<MemberRow[]>('/members');

  usePageChrome({ title: detail.data?.name ?? t('happy.group.title') }, [detail.data, t]);

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
          <div
            className="grid mt-16"
            style={{ gridTemplateColumns: '360px 1fr', gap: 16, alignItems: 'start' }}
            data-glayout
          >
            <SkeletonCard lines={6} />
            <SkeletonTable rows={4} columns={3} bare />
          </div>
        </SkeletonScreen>
      </>
    );
  if (detail.error || !detail.data) return <ErrorBanner message={detail.error ?? t('happy.group.notFound')} />;

  return (
    <>
      <BackButton fallbackHref={`/happiness/${detail.data.term_id}`} />

      <GroupPanel
        group={detail.data}
        attendance={attendance}
        allMembers={allMembers.data ?? []}
        perms={perms}
        onChanged={() => detail.reload()}
        onDeleted={() => {
          toast(t('happy.group.toast.deleted'));
          router.push(`/happiness/${detail.data!.term_id}`);
        }}
      />
    </>
  );
}

function GroupPanel({
  group,
  attendance,
  allMembers,
  perms,
  onChanged,
  onDeleted,
}: {
  group: HappinessGroupDetail;
  attendance: ReturnType<typeof useFetch<HappinessAttendanceResponse>>;
  allMembers: MemberRow[];
  perms: Perms;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();

  const [name, setName] = useState(group.name);
  const [hall, setHall] = useState<string | null>(group.hall_id);
  const [leaderId, setLeaderId] = useState(group.leader_id ?? '');
  const [meetingDay, setMeetingDay] = useState<Weekday | ''>(group.meeting_day ?? '');
  const [meetingTime, setMeetingTime] = useState(group.meeting_time?.slice(0, 5) ?? '');
  const [location, setLocation] = useState(group.location ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [addSel, setAddSel] = useState('');
  const [visitorOpen, setVisitorOpen] = useState(false);
  const [vName, setVName] = useState('');
  const [vEnglishName, setVEnglishName] = useState('');
  const [vPhone, setVPhone] = useState('');
  const [vSaving, setVSaving] = useState(false);
  // A full-page form: no ✕ to intercept, so the guard is the browser's own
  // prompt for a refresh, re-baselined on save so a form that saved and stayed
  // open stops claiming unsaved work (rule G4).
  const { markClean } = useFormGuard({ name, hall, leaderId, meetingDay, meetingTime, location });

  const roster = group.members;
  const weeks = attendance.data?.weeks ?? group.term?.weeks ?? 8;
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
    () => allMembers.filter((m) => !roster.some((r) => r.id === m.id)),
    [allMembers, roster],
  );

  const saveGroup = async () => {
    if (!name.trim()) {
      setErr(t('happy.group.err.name'));
      return;
    }
    if (!hall) {
      setErr(t('members.err.hall'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api.patch(`/happiness/groups/${group.id}`, {
        name: name.trim(),
        hall_id: hall,
        leader_id: leaderId || null,
        meeting_day: meetingDay || null,
        meeting_time: meetingTime || null,
        location: location.trim() || null,
      });
      markClean();
      toast(t('happy.group.toast.saved'));
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const deleteGroup = async () => {
    const ok = await confirm({
      title: t('happy.group.delete.title'),
      message: t('happy.group.delete.message', { name: group.name, n: roster.length }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/happiness/groups/${group.id}`);
      onDeleted();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    }
  };

  const addMember = async () => {
    if (!addSel) return;
    try {
      await api.post(`/happiness/groups/${group.id}/members`, { member_id: addSel });
      setAddSel('');
      toast(t('happy.group.toast.joined'));
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // The actual point of 幸福小组: somebody a leader just met has no member
  // record yet. Rather than sending them off to /members first, this creates
  // one on the spot — as a 访客 (0021, an ordinary church role, not a status)
  // in the GROUP's own hall — and lands them straight on this roster.
  const createVisitor = async () => {
    if (!vName.trim()) {
      toast(t('members.err.name'), 'error');
      return;
    }
    setVSaving(true);
    try {
      const created = await api.post<MemberRow>('/members', {
        full_name: vName.trim(),
        english_name: vEnglishName.trim() || null,
        phone: vPhone.trim() || null,
        church_role: ChurchRole.Visitor,
        hall_id: group.hall_id,
      });
      await api.post(`/happiness/groups/${group.id}/members`, { member_id: created.id });
      setVName('');
      setVEnglishName('');
      setVPhone('');
      setVisitorOpen(false);
      toast(t('happy.group.toast.visitorCreated'));
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setVSaving(false);
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
      await api.delete(`/happiness/groups/${group.id}/members/${memberId}`);
      toast(t('happy.group.toast.removed'));
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const toggleCell = async (memberId: string, week: number, present: boolean) => {
    try {
      await api.put(`/happiness/groups/${group.id}/attendance`, {
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
      await api.put(`/happiness/groups/${group.id}/attendance`, {
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
    const headers = [t('members.col.member'), ...weekList.map((w) => weekLabel(w))];
    const matrix: (string | number)[][] = sortedRoster.map((m) => [
      m.full_name,
      ...weekList.map((w) => (presenceByMember.get(m.id)?.has(w) ? '✓' : '')),
    ]);
    matrix.push([t('sheet.totalPeople'), ...totals.map((x) => x.value)]);
    exportMatrix(t('happy.attendance.exportFile', { group: group.name }), t('happy.attendance.title'), headers, matrix);
  };

  return (
    <>
      {err && <ErrorBanner message={err} />}

      {/* Attendance first — mirrors groups/[id]/page.tsx's own "roll-call
          first" layout (rule G4): once a group is set up, marking who came is
          what a leader opens this page for. */}
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

      <div className="grid mt-16" style={{ gridTemplateColumns: '360px 1fr', gap: 16, alignItems: 'start' }} data-glayout>
        {/* Left — editable group info, the same shape groups/[id]'s own left
            panel uses: plain Fields plus a Save button, no separate modal. */}
        <div className="card">
          <div className="card-head">
            <h3>{t('happy.group.info')}</h3>
          </div>
          <Field label={t('happy.group.field.name')}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('happy.group.namePlaceholder')} />
          </Field>
          <Field label={t('hall.label')}>
            <HallSelect value={hall} onChange={setHall} />
          </Field>
          <Field label={t('happy.group.field.leader')}>
            <Combobox
              value={leaderId}
              onChange={setLeaderId}
              options={allMembers.map((m) => ({ value: m.id, label: m.full_name, sub: m.english_name }))}
              placeholder={t('happy.group.leaderPlaceholder')}
              ariaLabel={t('happy.group.field.leader')}
            />
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

          {(perms.write || perms.delete) && (
            <div className="flex gap-8" style={{ marginTop: 14 }}>
              {perms.write && (
                <button className="btn" onClick={saveGroup} disabled={saving}>{t('group.saveSettings')}</button>
              )}
              {perms.delete && (
                <button className="btn danger" onClick={deleteGroup}>{t('happy.group.delete.title')}</button>
              )}
            </div>
          )}
        </div>

        {/* Right — roster */}
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
          {perms.write && !visitorOpen && (
            <button className="btn ghost sm mb-14" onClick={() => setVisitorOpen(true)}>
              {t('happy.group.newVisitor')}
            </button>
          )}
          {perms.write && visitorOpen && (
            <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 14 }}>
              <div className="faint mb-14" style={{ fontSize: 12 }}>{t('happy.group.newVisitor.hint')}</div>
              <div className="form-row">
                <Field label={t('members.field.name')}>
                  <input value={vName} onChange={(e) => setVName(e.target.value)} />
                </Field>
                <Field label={t('members.field.englishName')}>
                  <input value={vEnglishName} onChange={(e) => setVEnglishName(e.target.value)} />
                </Field>
              </div>
              <Field label={t('members.field.phone')}>
                <input value={vPhone} onChange={(e) => setVPhone(e.target.value)} />
              </Field>
              <div className="flex gap-8">
                <button className="btn accent" onClick={createVisitor} disabled={vSaving}>
                  {vSaving ? t('common.saving') : t('happy.group.newVisitor')}
                </button>
                <button className="btn ghost" onClick={() => setVisitorOpen(false)}>{t('common.cancel')}</button>
              </div>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh sortKey="name" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('members.field.name')}</SortTh>
                  <th>{t('happy.group.col.role')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sortedRoster.map((m) => (
                  <tr key={m.id}>
                    <td><MemberName member={m} /></td>
                    <td>
                      <RosterRoleCell
                        groupId={group.id}
                        memberId={m.id}
                        role={m.happiness_role}
                        editable={perms.write}
                        onSaved={onChanged}
                      />
                    </td>
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
      </div>
    </>
  );
}

/**
 * The roster row's OWN role within THIS happiness group (0027) — free text,
 * never `members.church_role`/`group_position`, which belong to a different
 * membership entirely and have no bearing on how this church runs its 幸福小组.
 * Committed on blur, the same "don't write on every keystroke" rule the
 * shared TagsInput follows for its own chip text.
 */
function RosterRoleCell({
  groupId,
  memberId,
  role,
  editable,
  onSaved,
}: {
  groupId: string;
  memberId: string;
  role: string | null;
  editable: boolean;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [value, setValue] = useState(role ?? '');

  if (!editable) {
    return role ? <span>{role}</span> : <span className="faint">—</span>;
  }

  const commit = async () => {
    const next = value.trim();
    if (next === (role ?? '')) return;
    try {
      await api.patch(`/happiness/groups/${groupId}/members/${memberId}`, { role: next || null });
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
      setValue(role ?? '');
    }
  };

  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      placeholder={t('happy.group.rolePlaceholder')}
      style={{ width: 130 }}
    />
  );
}
