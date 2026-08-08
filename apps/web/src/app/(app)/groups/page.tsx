'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe, useHallScope } from '@/components/AppShell';
import {
  ChevronRightIcon,
  ErrorBanner,
  ExportButton,
  Field,
  HallSelect,
  Modal,
  PageBar,
  RowChevron,
  SkeletonScreen,
  SkeletonTable,
  SortTh,
  TagsInput,
  useToast,
} from '@/components/ui';
import { can } from '@/lib/perms';
import { exportRows } from '@/lib/export';
import { GroupRow, MemberRow } from '@/lib/types';
import {
  formatMeetingTime,
  groupHealthClass,
  groupHealthKey,
  groupHealthStatus,
  meetingSchedule,
  weekdayKey,
  WEEKDAY_OPTIONS,
} from '@/lib/labels';
import { useT } from '@/lib/i18n';
import { GroupPosition, Weekday } from '@tog/shared';

export default function GroupsPage() {
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const perms = can(useMe().role);
  // Only worth a column when the rows can actually differ: an account pinned to
  // one hall, or a view narrowed to one hall with the switcher, would see the
  // same value repeated on every row.
  const { locked: hallLocked, hallId } = useHallScope();
  const showHall = !hallLocked && !hallId;
  const groups = useFetch<GroupRow[]>('/groups');
  const members = useFetch<MemberRow[]>('/members');
  const [addOpen, setAddOpen] = useState(false);
  const [q, setQ] = useState('');
  const [tagFilter, setTagFilter] = useState('all');
  const [weekdayFilter, setWeekdayFilter] = useState<Weekday | 'all'>('all');

  usePageChrome({ title: t('groups.title') }, [t]);

  // Leader + member counts + health status derived once from the
  // already-fetched member list (G5: no extra request just to know who
  // leads each group, or how many are new).
  const rows = useMemo(() => {
    const groupList = groups.data ?? [];
    const memberList = members.data ?? [];
    return groupList.map((g) => {
      const inGroup = memberList.filter((m) => m.group_id === g.id);
      const leader = inGroup.find((m) => m.group_position === GroupPosition.Leader);
      const newMemberCount = inGroup.filter((m) => m.group_position === GroupPosition.NewMember).length;
      return {
        id: g.id,
        name: g.name,
        hallName: g.hall?.name ?? null,
        tags: g.tags ?? [],
        meetingDay: g.meeting_day,
        // `schedule` stays the one-line summary used by search, export and the
        // mobile tiles; the desktop cell splits it over two lines.
        schedule: meetingSchedule(g, t),
        scheduleDayTime: [g.meeting_day ? t(weekdayKey(g.meeting_day)) : '', formatMeetingTime(g.meeting_time)]
          .filter(Boolean)
          .join(' '),
        scheduleLocation: g.location ?? '',
        leaderName: leader?.full_name ?? null,
        memberCount: inGroup.length,
        newMemberCount,
        status: groupHealthStatus(inGroup.length, newMemberCount),
      };
    });
  }, [groups.data, members.data, t]);

  // Distinct tags across every group, for both the filter dropdown and the
  // add-group tag-suggestion autocomplete.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    (groups.data ?? []).forEach((g) => (g.tags ?? []).forEach((t) => set.add(t)));
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
  }, [groups.data]);

  const filteredRows = useMemo(() => {
    const term = q.trim();
    return rows.filter((g) => {
      if (tagFilter !== 'all' && !g.tags.includes(tagFilter)) return false;
      if (weekdayFilter !== 'all' && g.meetingDay !== weekdayFilter) return false;
      if (term && !`${g.name}${g.leaderName ?? ''}${g.schedule}`.includes(term)) return false;
      return true;
    });
  }, [rows, q, tagFilter, weekdayFilter]);

  const { sorted, sortKey, sortDir, toggleSort } = useSortableRows(
    filteredRows,
    (g, key) => {
      switch (key) {
        case 'leader':
          return g.leaderName ?? undefined;
        case 'count':
          return g.memberCount;
        case 'new':
          return g.newMemberCount;
        case 'hall':
          // The column can disappear (single-hall view) while it is the active
          // sort key — fall back to the default so rows are never ordered by
          // something the user can no longer see.
          return showHall ? g.hallName ?? undefined : g.name;
        case 'status':
          return (['splittable', 'need_members', 'balanced'] as const).indexOf(g.status);
        default:
          return g.name;
      }
    },
    { key: 'name', dir: 'asc' },
  );

  const exportGroups = () => {
    exportRows(
      t('groups.title'),
      t('groups.col.name'),
      sorted.map((g) => ({
        [t('export.name')]: g.name,
        [t('export.hall')]: g.hallName ?? '',
        [t('export.leader')]: g.leaderName ?? t('common.vacant'),
        [t('export.members')]: g.memberCount,
        [t('export.newMembers')]: g.newMemberCount,
        [t('export.status')]: t(groupHealthKey(g.status)),
        [t('export.schedule')]: g.schedule,
        [t('export.tags')]: g.tags.join(', '),
      })),
    );
  };

  // Real chrome first: the filters and buttons work against an empty list,
  // so only the rows below wait on the fetch (nothing shifts when it lands).
  return (
    <>
      <ErrorBanner message={groups.error || members.error} />

      <PageBar
        filters={
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('groups.searchPlaceholder')} />
            <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
              <option value="all">{t('groups.filter.tag')}</option>
              {allTags.map((tag) => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
            <select
              value={weekdayFilter}
              onChange={(e) => setWeekdayFilter(e.target.value as Weekday | 'all')}
            >
              <option value="all">{t('groups.filter.weekday')}</option>
              {WEEKDAY_OPTIONS.map((d) => (
                <option key={d} value={d}>{t(weekdayKey(d))}</option>
              ))}
            </select>
          </>
        }
        actions={
          <>
            <ExportButton onClick={exportGroups} disabled={sorted.length === 0} />
            {perms.write && (
              <button className="btn" onClick={() => setAddOpen(true)}>{t('groups.add')}</button>
            )}
          </>
        }
      />

      {groups.initialLoading ? (
        <SkeletonScreen>
          <SkeletonTable rows={8} columns={showHall ? 9 : 8} />
        </SkeletonScreen>
      ) : (
        <>
          {/* Desktop — table */}
          <div className="card only-desktop" style={{ padding: 6 }}>
            <div className="table-wrap">
              <table className="table-fixed">
                <thead>
                  <tr>
                    {/* Columns size to their own content (G7a). The congregation
                        column only appears when more than one hall is in view. */}
                    <SortTh sortKey="name" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('groups.col.name')}</SortTh>
                    {showHall && (
                      <SortTh sortKey="hall" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('hall.label')}</SortTh>
                    )}
                    <SortTh sortKey="leader" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('groups.col.leader')}</SortTh>
                    <SortTh sortKey="count" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('groups.col.count')}</SortTh>
                    <SortTh sortKey="new" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('groups.col.newCount')}</SortTh>
                    <SortTh sortKey="status" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('groups.col.status')}</SortTh>
                    <th>{t('groups.col.schedule')}</th>
                    <th>{t('groups.field.tags')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((g) => (
                    <tr key={g.id}>
                      <td>
                        <strong>{g.name}</strong>
                      </td>
                      {showHall && <td className="muted">{g.hallName ?? '—'}</td>}
                      <td>
                        {g.leaderName ? <strong>{g.leaderName}</strong> : <span className="faint">{t('common.vacant')}</span>}
                      </td>
                      <td className="muted tnum">{g.memberCount}</td>
                      <td className="muted tnum">{g.newMemberCount}</td>
                      <td>
                        <span className={`badge ${groupHealthClass(g.status)}`}>{t(groupHealthKey(g.status))}</span>
                      </td>
                      <td className="muted">
                        {g.scheduleDayTime || g.scheduleLocation ? (
                          <>
                            {g.scheduleDayTime && <div>{g.scheduleDayTime}</div>}
                            {g.scheduleLocation && (
                              <div className="faint" style={{ fontSize: 12.5 }}>{g.scheduleLocation}</div>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {g.tags.length > 0 ? (
                          <div className="flex gap-4 flex-wrap">
                            {g.tags.map((tag) => (
                              <span key={tag} className="chip on" style={{ padding: '2px 8px', fontSize: 11, cursor: 'default' }}>
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <RowChevron title={t('groups.viewDetail')} onClick={() => router.push(`/groups/${g.id}`)} />
                      </td>
                    </tr>
                  ))}
                  {sorted.length === 0 && (
                    <tr>
                      <td colSpan={showHall ? 9 : 8} className="empty-inline">
                        {q.trim() || tagFilter !== 'all' || weekdayFilter !== 'all'
                          ? t('groups.empty')
                          : t('groups.emptyNew')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile — list tiles */}
          <div className="only-mobile">
            {sorted.map((g) => (
              <div key={g.id} className="mtile" onClick={() => router.push(`/groups/${g.id}`)}>
                <div className="mtile-row1">
                  <div style={{ minWidth: 0 }}>
                    <strong>{g.name}</strong>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      {' '}
                      {t('groups.leaderInline', { name: g.leaderName ?? t('common.vacant') })}
                    </span>
                  </div>
                  <span className="mtile-cta"><ChevronRightIcon /></span>
                </div>
                <div className="mtile-line flex items-center gap-8 flex-wrap">
                  <span>
                    {t('groups.memberLine', {
                      n: g.memberCount,
                      newCount: g.newMemberCount,
                      schedule: g.schedule ? ` · ${g.schedule}` : '',
                    })}
                  </span>
                  <span className={`badge ${groupHealthClass(g.status)}`}>{t(groupHealthKey(g.status))}</span>
                </div>
                {g.tags.length > 0 && (
                  <div className="flex gap-4 flex-wrap" style={{ marginTop: 6 }}>
                    {g.tags.map((tag) => (
                      <span key={tag} className="chip on" style={{ padding: '2px 8px', fontSize: 11, cursor: 'default' }}>
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {sorted.length === 0 && (
              <div className="empty-inline">
                {q.trim() || tagFilter !== 'all' || weekdayFilter !== 'all'
                  ? t('groups.empty')
                  : t('groups.emptyNew')}
              </div>
            )}
          </div>
        </>
      )}

      {addOpen && (
        <AddGroupModal
          allTags={allTags}
          onClose={() => setAddOpen(false)}
          onSaved={(id) => {
            setAddOpen(false);
            groups.reload();
            toast(t('groups.toast.created'));
            router.push(`/groups/${id}`);
          }}
        />
      )}
    </>
  );
}

function AddGroupModal({
  allTags,
  onClose,
  onSaved,
}: {
  allTags: string[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const { halls, hallId } = useHallScope();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [meetingDay, setMeetingDay] = useState<Weekday | ''>('');
  const [meetingTime, setMeetingTime] = useState('');
  const [location, setLocation] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [hall, setHall] = useState<string | null>(hallId || null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // A group always belongs to exactly one hall (DB NOT NULL).
  const effectiveHallId = hall ?? (halls.length === 1 ? halls[0].id : null);

  const save = async () => {
    if (!name.trim()) {
      setErr(t('groups.err.name'));
      return;
    }
    if (!effectiveHallId) {
      setErr(t('members.err.hall'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const g = await api.post<GroupRow>('/groups', {
        name: name.trim(),
        description: desc || undefined,
        meeting_day: meetingDay || undefined,
        meeting_time: meetingTime || undefined,
        location: location || undefined,
        tags,
        hall_id: effectiveHallId,
      });
      onSaved(g.id);
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('groups.new.title')} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <div className="form-row">
        <Field label={t('groups.field.name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('groups.namePlaceholder')} />
        </Field>
        <Field label={t('hall.label')}>
          <HallSelect value={effectiveHallId} onChange={setHall} />
        </Field>
      </div>
      <Field label={t('groups.field.desc')}>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t('groups.descPlaceholder')} />
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
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder={t('groups.locationPlaceholder')} />
      </Field>
      <Field label={t('groups.field.tags')}>
        <TagsInput value={tags} onChange={setTags} suggestions={allTags} placeholder={t('groups.tagsPlaceholder')} />
      </Field>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>
  );
}
