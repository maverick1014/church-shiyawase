'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe, useHallScope } from '@/components/AppShell';
import {
  BackButton,
  ChevronRightIcon,
  Combobox,
  ErrorBanner,
  ExportButton,
  FactGrid,
  Field,
  HallSelect,
  MemberName,
  Modal,
  PageBar,
  RoleRestricted,
  RowChevron,
  SkeletonCard,
  SkeletonScreen,
  SkeletonTable,
  SortTh,
  useConfirm,
  useToast,
} from '@/components/ui';
import { can } from '@/lib/perms';
import { exportRows } from '@/lib/export';
import { formatDate, weekdayKey, WEEKDAY_OPTIONS } from '@/lib/labels';
import { HappinessGroupRow, HappinessTermRow, MemberRow } from '@/lib/types';
import { useT } from '@/lib/i18n';
import { AccountRole, Weekday } from '@tog/shared';

export default function HappinessTermGroupsPage() {
  const { termId } = useParams<{ termId: string }>();
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const me = useMe();
  const perms = can(me.role);
  const { locked: hallLocked, hallId } = useHallScope();
  const showHall = !hallLocked && !hallId;

  const term = useFetch<HappinessTermRow>(`/happiness/terms/${termId}`);
  const groups = useFetch<HappinessGroupRow[]>(`/happiness/groups?term_id=${termId}`);
  const members = useFetch<MemberRow[]>('/members');

  const [formGroup, setFormGroup] = useState<HappinessGroupRow | 'new' | null>(null);

  usePageChrome(
    { title: term.data ? t('happy.term.pageTitle', { no: term.data.term_no }) : t('happy.title') },
    [term.data, t],
  );

  const { sorted, sortKey, sortDir, toggleSort } = useSortableRows(
    groups.data ?? [],
    (g, key) => {
      switch (key) {
        case 'hall':
          return g.hall?.name ?? '';
        case 'leader':
          return g.leader?.full_name ?? '';
        case 'roster':
          return g.roster_count;
        default:
          return g.name;
      }
    },
    { key: 'name', dir: 'asc' },
  );

  const exportGroups = () => {
    exportRows(
      t('happy.title'),
      t('happy.group.col.name'),
      sorted.map((g) => ({
        [t('happy.group.col.name')]: g.name,
        [t('hall.label')]: g.hall?.name ?? '',
        [t('happy.group.col.leader')]: g.leader?.full_name ?? '',
        [t('groups.field.day')]: g.meeting_day ? t(weekdayKey(g.meeting_day)) : '',
        [t('groups.field.time')]: g.meeting_time?.slice(0, 5) ?? '',
        [t('groups.field.location')]: g.location ?? '',
        [t('happy.group.col.roster')]: g.roster_count,
      })),
    );
  };

  const deleteGroup = async (g: HappinessGroupRow) => {
    const ok = await confirm({
      title: t('happy.group.delete.title'),
      message: t('happy.group.delete.message', { name: g.name, n: g.roster_count }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/happiness/groups/${g.id}`);
      groups.reload();
      toast(t('happy.group.toast.deleted'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // `happiness` is outside a group_leader's allowed API prefixes — reachable
  // here only by a bookmark, the catalog it is normally opened from being
  // itself `RoleRestricted`.
  if (me.role === AccountRole.GroupLeader) return <RoleRestricted />;

  if (term.initialLoading)
    return (
      <>
        <BackButton fallbackHref="/happiness" />
        <SkeletonScreen>
          <SkeletonCard lines={3} />
          <SkeletonTable rows={5} columns={6} />
        </SkeletonScreen>
      </>
    );
  if (term.error || !term.data) return <ErrorBanner message={term.error ?? t('happy.term.notFound')} />;

  const facts = [
    { label: t('happy.term.col.no'), value: term.data.term_no },
    { label: t('happy.term.col.name'), value: term.data.name || <span className="faint">—</span> },
    { label: t('happy.term.col.dates'), value: `${formatDate(term.data.starts_on)} – ${formatDate(term.data.ends_on)}` },
    { label: t('happy.term.col.weeks'), value: term.data.weeks },
  ];

  return (
    <>
      <BackButton fallbackHref="/happiness" />

      <div className="card">
        <FactGrid facts={facts} />
      </div>

      <ErrorBanner message={groups.error || members.error} />

      <PageBar
        actions={
          <>
            <ExportButton onClick={exportGroups} disabled={sorted.length === 0} />
            {perms.write && (
              <button className="btn" onClick={() => setFormGroup('new')}>{t('happy.group.add')}</button>
            )}
          </>
        }
      />

      {groups.initialLoading ? (
        <SkeletonScreen>
          <SkeletonTable rows={5} columns={showHall ? 7 : 6} />
        </SkeletonScreen>
      ) : (
        <>
          <div className="card only-desktop" style={{ padding: 6 }}>
            <div className="table-wrap">
              <table className="table-fixed">
                <thead>
                  <tr>
                    <SortTh sortKey="name" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('happy.group.col.name')}</SortTh>
                    {showHall && (
                      <SortTh sortKey="hall" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('hall.label')}</SortTh>
                    )}
                    <SortTh sortKey="leader" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('happy.group.col.leader')}</SortTh>
                    <th>{t('happy.group.col.schedule')}</th>
                    <SortTh sortKey="roster" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('happy.group.col.roster')}</SortTh>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((g) => (
                    <tr key={g.id} onClick={() => router.push(`/happiness/group/${g.id}`)} style={{ cursor: 'pointer' }}>
                      <td><strong>{g.name}</strong></td>
                      {showHall && <td className="muted">{g.hall?.name ?? '—'}</td>}
                      <td>
                        {g.leader ? <MemberName member={g.leader} /> : <span className="faint">{t('common.vacant')}</span>}
                      </td>
                      <td className="muted">
                        {g.meeting_day || g.meeting_time || g.location ? (
                          <>
                            <div>{[g.meeting_day ? t(weekdayKey(g.meeting_day)) : '', g.meeting_time?.slice(0, 5)].filter(Boolean).join(' ')}</div>
                            {g.location && <div className="faint" style={{ fontSize: 12.5 }}>{g.location}</div>}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="muted tnum">{g.roster_count}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                        {perms.write && (
                          <button className="btn ghost sm" style={{ marginRight: 6 }} onClick={() => setFormGroup(g)}>
                            {t('happy.group.edit')}
                          </button>
                        )}
                        {perms.delete && (
                          <button className="btn ghost sm" style={{ color: 'var(--crit)', marginRight: 6 }} onClick={() => deleteGroup(g)}>
                            {t('common.delete')}
                          </button>
                        )}
                        <RowChevron title={t('happy.group.viewDetail')} onClick={() => router.push(`/happiness/group/${g.id}`)} />
                      </td>
                    </tr>
                  ))}
                  {sorted.length === 0 && (
                    <tr><td colSpan={showHall ? 6 : 5} className="empty-inline">{t('happy.group.empty')}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="only-mobile">
            {sorted.map((g) => (
              <div key={g.id} className="mtile" onClick={() => router.push(`/happiness/group/${g.id}`)}>
                <div className="mtile-row1">
                  <div style={{ minWidth: 0 }}>
                    <strong>{g.name}</strong>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      {' '}
                      {g.leader ? g.leader.full_name : t('common.vacant')}
                    </span>
                  </div>
                  <span className="mtile-cta"><ChevronRightIcon /></span>
                </div>
                <div className="mtile-line flex items-center gap-8 flex-wrap">
                  <span>
                    {[g.meeting_day ? t(weekdayKey(g.meeting_day)) : '', g.meeting_time?.slice(0, 5), g.location]
                      .filter(Boolean)
                      .join(' · ') || t('common.unset')}
                    {' · '}
                    {t('happy.group.rosterCount', { n: g.roster_count })}
                  </span>
                </div>
                {(perms.write || perms.delete) && (
                  <div className="flex gap-10" style={{ marginTop: 8 }}>
                    {perms.write && (
                      <button className="tile-action" onClick={(e) => { e.stopPropagation(); setFormGroup(g); }}>
                        {t('happy.group.edit')}
                      </button>
                    )}
                    {perms.delete && (
                      <button
                        className="tile-action"
                        style={{ color: 'var(--crit)' }}
                        onClick={(e) => { e.stopPropagation(); deleteGroup(g); }}
                      >
                        {t('common.delete')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {sorted.length === 0 && <div className="empty-inline">{t('happy.group.empty')}</div>}
          </div>
        </>
      )}

      {formGroup && (
        <GroupModal
          termId={termId}
          group={formGroup === 'new' ? null : formGroup}
          members={members.data ?? []}
          onClose={() => setFormGroup(null)}
          onSaved={(created) => {
            setFormGroup(null);
            groups.reload();
            toast(created ? t('happy.group.toast.created') : t('happy.group.toast.saved'));
          }}
        />
      )}
    </>
  );
}

function GroupModal({
  termId,
  group,
  members,
  onClose,
  onSaved,
}: {
  termId: string;
  group: HappinessGroupRow | null;
  members: MemberRow[];
  onClose: () => void;
  onSaved: (created: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const { halls, hallId } = useHallScope();
  const [name, setName] = useState(group?.name ?? '');
  const [leaderId, setLeaderId] = useState(group?.leader_id ?? '');
  const [hall, setHall] = useState<string | null>(group?.hall_id ?? (hallId || null));
  const [meetingDay, setMeetingDay] = useState<Weekday | ''>(group?.meeting_day ?? '');
  const [meetingTime, setMeetingTime] = useState(group?.meeting_time?.slice(0, 5) ?? '');
  const [location, setLocation] = useState(group?.location ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const effectiveHallId = hall ?? (halls.length === 1 ? halls[0].id : null);

  const save = async () => {
    if (!name.trim()) {
      setErr(t('happy.group.err.name'));
      return;
    }
    if (!effectiveHallId) {
      setErr(t('members.err.hall'));
      return;
    }
    setSaving(true);
    setErr(null);
    const dto = {
      term_id: termId,
      name: name.trim(),
      leader_id: leaderId || null,
      hall_id: effectiveHallId,
      meeting_day: meetingDay || null,
      meeting_time: meetingTime || null,
      location: location.trim() || null,
    };
    try {
      if (group) {
        await api.patch(`/happiness/groups/${group.id}`, dto);
        onSaved(false);
      } else {
        await api.post('/happiness/groups', dto);
        onSaved(true);
      }
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={group ? t('happy.group.edit.title') : t('happy.group.new.title')} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <div className="form-row">
        <Field label={t('happy.group.field.name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('happy.group.namePlaceholder')} />
        </Field>
        <Field label={t('hall.label')}>
          <HallSelect value={effectiveHallId} onChange={setHall} />
        </Field>
      </div>
      <Field label={t('happy.group.field.leader')}>
        <Combobox
          value={leaderId}
          onChange={setLeaderId}
          options={members.map((m) => ({ value: m.id, label: m.full_name, sub: m.english_name }))}
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
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>
  );
}
