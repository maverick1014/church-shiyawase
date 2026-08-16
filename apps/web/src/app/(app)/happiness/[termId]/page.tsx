'use client';

import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
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
  Skeleton,
  SkeletonCard,
  SkeletonScreen,
  SkeletonTable,
  SortTh,
  useFormGuard,
  useMemberOptions,
  useToast,
} from '@/components/ui';
import { can } from '@/lib/perms';
import { exportRows } from '@/lib/export';
import { formatDate, weekdayKey, WEEKDAY_OPTIONS } from '@/lib/labels';
import { HappinessGroupRow, HappinessTermRow, MemberRow, TermBestRow } from '@/lib/types';
import { useT } from '@/lib/i18n';
import { AccountRole, Weekday } from '@tog/shared';

export default function HappinessTermGroupsPage() {
  const { termId } = useParams<{ termId: string }>();
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const me = useMe();
  const perms = can(me.role);
  const { locked: hallLocked, hallId } = useHallScope();
  const showHall = !hallLocked && !hallId;

  const term = useFetch<HappinessTermRow>(`/happiness/terms/${termId}`);
  const groups = useFetch<HappinessGroupRow[]>(`/happiness/groups?term_id=${termId}`);
  const members = useFetch<MemberRow[]>('/members');

  const [addOpen, setAddOpen] = useState(false);
  // The one filter the life-groups list page has that this term-scoped list
  // didn't (rule G4/G7a): a group by name or its leader's name, lowercased
  // on both sides so a leader is found as "grace" as often as "Grace".
  const [q, setQ] = useState('');

  usePageChrome(
    // A term IS its name (church feedback): 第几期 is server-assigned bookkeeping
    // that still orders the list, but nobody reads a term by its number.
    { title: term.data?.name || t('happy.title') },
    [term.data, t],
  );

  const filteredGroups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return groups.data ?? [];
    return (groups.data ?? []).filter((g) =>
      `${g.name}${g.leader?.full_name ?? ''}${g.leader?.english_name ?? ''}`.toLowerCase().includes(needle));
  }, [groups.data, q]);

  const { sorted, sortKey, sortDir, toggleSort } = useSortableRows(
    filteredGroups,
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

  // `happiness` is outside a group_leader's allowed API prefixes — reachable
  // here only by a bookmark, the catalog it is normally opened from being
  // itself `RoleRestricted`.
  if (me.role === AccountRole.GroupLeader) return <RoleRestricted />;

  if (term.initialLoading)
    return (
      <>
        <BackButton fallbackHref="/happiness" />
        <SkeletonScreen>
          {/* Mirrors what actually renders below: the facts card with its own
              mb-16, then the page bar, then the list. Without the margin and
              the bar the table sat ~70px higher than the real one and the whole
              page jumped when the fetch landed. */}
          <SkeletonCard lines={2} className="mb-16" />
          <div className="page-bar">
            <div className="page-bar-filters"><Skeleton width={150} height={36} /></div>
            <div className="page-bar-actions">
              <Skeleton width={40} height={36} />
              <Skeleton width={110} height={36} />
            </div>
          </div>
          <SkeletonTable rows={5} columns={6} />
        </SkeletonScreen>
      </>
    );
  if (term.error || !term.data) return <ErrorBanner message={term.error ?? t('happy.term.notFound')} />;

  // 期号 is already the page title — repeating it here would be the same fact
  // twice. Paired the way the term is actually thought of: what it's called
  // and how long it runs, then when it starts and ends as their own rows
  // rather than one combined range string.
  const facts = [
    { label: t('happy.term.col.name'), value: term.data.name || <span className="faint">—</span> },
    { label: t('happy.term.col.weeks'), value: term.data.weeks },
    { label: t('happy.term.field.startsOn'), value: formatDate(term.data.starts_on) },
    { label: t('happy.term.field.endsOn'), value: formatDate(term.data.ends_on) },
  ];

  return (
    <>
      <BackButton fallbackHref="/happiness" />

      <div className="card mb-16">
        <FactGrid facts={facts} />
      </div>

      {/* The term's overall BEST namelist, above the groups (church feedback:
          "at the top there should have a name list — they can see the overall
          best name list for this session"). A term is run as one thing, and
          the question a leader asks at the top of it is who the whole 期 is
          reaching — which no single group's own page can answer.

          One request rather than one per group (rule G5), and it is only
          DRAWN when it has somebody in it: an empty namelist card standing
          above every term's group list is noise, and a term that has not
          started yet has nothing to say here. */}
      <TermBestList termId={termId} termName={term.data.name} />

      <ErrorBanner message={groups.error || members.error} />

      <PageBar
        filters={<input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('happy.group.searchPlaceholder')} />}
        actions={
          <>
            <ExportButton onClick={exportGroups} disabled={sorted.length === 0} />
            {perms.write && (
              <button className="btn" onClick={() => setAddOpen(true)}>{t('happy.group.add')}</button>
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
                      <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
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
                {/* The canonical tile, same as /groups' own (rule G4): name
                    and its tag on the first row, one fact per row below. */}
                {/* The life-group tile's shape exactly (rule G4) — name, then
                    leader, then the count — but with NO tag on the first row: a
                    life group's tag is its health status, and a 幸福小组 has no
                    equivalent worth pinning there. The roster count reads as a
                    fact on its own line instead, where the member count sits on
                    a life-group tile. */}
                <div className="mtile-row1">
                  <strong style={{ minWidth: 0 }}>{g.name}</strong>
                  <span className="mtile-cta"><ChevronRightIcon /></span>
                </div>
                <div className="mtile-line">
                  {t('groups.leaderInline', { name: g.leader ? g.leader.full_name : t('common.vacant') })}
                </div>
                <div className="mtile-line">
                  {[
                    t('happy.group.rosterCount', { n: g.roster_count }),
                    [g.meeting_day ? t(weekdayKey(g.meeting_day)) : '', g.meeting_time?.slice(0, 5), g.location]
                      .filter(Boolean)
                      .join(' · '),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
            ))}
            {sorted.length === 0 && <div className="empty-inline">{t('happy.group.empty')}</div>}
          </div>
        </>
      )}

      {addOpen && (
        <AddGroupModal
          termId={termId}
          members={members.data ?? []}
          onClose={() => setAddOpen(false)}
          onSaved={(id) => {
            setAddOpen(false);
            toast(t('happy.group.toast.created'));
            router.push(`/happiness/group/${id}`);
          }}
        />
      )}
    </>
  );
}

// Create-only, matching groups/page.tsx's own AddGroupModal (rule G4): once a
// group exists, editing and deleting it both happen on its own detail page
// (happiness/group/[groupId]/page.tsx) rather than through a second copy of
// this form reachable from the list.
function AddGroupModal({
  termId,
  members,
  onClose,
  onSaved,
}: {
  termId: string;
  members: MemberRow[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const t = useT();
  /** Every member picker's options come from one builder (rule G4). */
  const memberOptions = useMemberOptions();
  const toast = useToast();
  const { halls, hallId } = useHallScope();
  const [name, setName] = useState('');
  const [leaderId, setLeaderId] = useState('');
  const [hall, setHall] = useState<string | null>(hallId || null);
  const [meetingDay, setMeetingDay] = useState<Weekday | ''>('');
  const [meetingTime, setMeetingTime] = useState('');
  const [location, setLocation] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Asks before ✕ or Cancel discards this, and arms the browser's own prompt
  // for a refresh (rule G4 — one guard, every form).
  const { close } = useFormGuard({ name, leaderId, hall, meetingDay, meetingTime, location }, onClose);

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
    try {
      const g = await api.post<HappinessGroupRow>('/happiness/groups', {
        term_id: termId,
        name: name.trim(),
        leader_id: leaderId || null,
        hall_id: effectiveHallId,
        meeting_day: meetingDay || null,
        meeting_time: meetingTime || null,
        location: location.trim() || null,
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
    <Modal title={t('happy.group.new.title')} onClose={close}>
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
          options={memberOptions(members)}
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
        <button className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>
  );
}

/**
 * BEST 名单 — every BEST on any roster in this 期, and which group has them.
 *
 * Its own component with its own fetch rather than a slice of the page's:
 * the answer comes from one endpoint (`GET /happiness/terms/:id/best`) that
 * walks the term's groups server-side past the hall gate, so the page above
 * neither knows nor has to assemble it. Renders NOTHING at all while loading
 * or when the term has no BEST yet — a card that flickers in empty above the
 * group list, on every term, is worse than one that simply is not there.
 *
 * The row shows the name, a phone and the GROUP: a namelist read at the top of
 * a term is read to answer "who is being reached, and who is reaching them".
 * No role badge — every row here is a BEST by definition, so a column of
 * identical tags says nothing (the same rule the roster row follows).
 */
function TermBestList({ termId, termName }: { termId: string; termName: string | null }) {
  const t = useT();
  const router = useRouter();
  const { data, error } = useFetch<TermBestRow[]>(`/happiness/terms/${termId}/best`);
  const rows = data ?? [];

  const exportBest = () => {
    exportRows(
      termName || t('happy.title'),
      t('happy.best.title'),
      rows.map((r) => ({
        [t('export.name')]: r.member.full_name,
        [t('members.field.englishName')]: r.member.english_name ?? '',
        [t('export.phone')]: r.member.phone ?? '',
        [t('happy.best.col.group')]: r.group.name ?? '',
      })),
    );
  };

  // A failed read is reported; an empty one is simply absent (see above).
  if (error) return <ErrorBanner message={error} />;
  if (rows.length === 0) return null;

  return (
    <div className="card mb-16">
      <div className="card-head">
        <strong>{t('happy.best.title')} ({rows.length})</strong>
        <ExportButton onClick={exportBest} />
      </div>

      <div className="table-wrap only-desktop">
        <table>
          <thead>
            <tr>
              <th>{t('members.field.name')}</th>
              <th>{t('members.col.contact')}</th>
              <th>{t('happy.best.col.group')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.group.id}:${r.member.id}`}>
                <td><MemberName member={r.member} /></td>
                <td className="muted tnum">{r.member.phone ?? '—'}</td>
                <td className="muted">{r.group.name ?? '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  <RowChevron
                    title={t('members.viewProfile')}
                    onClick={() => router.push(`/members/${r.member.id}`)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The canonical tile (rule G7): what the row IS on row 1 with its one
          identifying tag pinned right — here the GROUP, since every row is a
          BEST and the group is what tells them apart — and the phone on a
          line of its own below. */}
      <div className="only-mobile">
        {rows.map((r) => (
          <div
            key={`${r.group.id}:${r.member.id}`}
            className="mtile"
            onClick={() => router.push(`/members/${r.member.id}`)}
          >
            <div className="mtile-row1">
              <MemberName member={r.member} />
              <div className="flex items-center gap-8" style={{ flexShrink: 0 }}>
                <span className="muted">{r.group.name ?? '—'}</span>
                <span className="mtile-cta"><ChevronRightIcon /></span>
              </div>
            </div>
            {r.member.phone && <div className="mtile-line">{r.member.phone}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
