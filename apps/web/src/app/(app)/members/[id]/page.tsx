'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { compressImage } from '@/lib/imageCompress';
import { usePageChrome, useMe } from '@/components/AppShell';
import { Avatar, BackButton, EntityHeader, ErrorBanner, FactGrid, MemberName, ProgressBar, RoleBadge, SkeletonDetail, SkeletonScreen, SortTh, useConfirm, useToast } from '@/components/ui';
import { PairProgressModal } from '@/components/PairProgressModal';
import { MemberEditModal } from '@/components/MemberEditModal';
import { useLeaderAccountEvent } from '@/components/LeaderAccountEvent';
import { can } from '@/lib/perms';
import { useModuleEnabled } from '@/lib/church';
import { EnrollmentRow, MemberRow, PairRow } from '@/lib/types';
import { MODULE_DISCIPLESHIP } from '@tog/shared';
import {
  enrollmentStatusClass,
  enrollmentStatusKey,
  formatDate,
  genderKey,
  memberRole,
  memberStatusKey,
} from '@/lib/labels';
import { useT } from '@/lib/i18n';

export default function MemberDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const tr = useT();

  const member = useFetch<MemberRow>(`/members/${id}`);
  const record = useFetch<EnrollmentRow[]>(`/members/${id}/trainings`);
  // The 守望 section only exists for a church that runs the add-on module —
  // and when it doesn't, this fetch must not go out either (the API refuses
  // every /discipleship path, which would surface as an error banner here).
  const discipleshipOn = useModuleEnabled(MODULE_DISCIPLESHIP);
  const allPairs = useFetch<PairRow[]>(discipleshipOn ? '/discipleship/pairs' : null);
  const toast = useToast();
  const confirm = useConfirm();
  const perms = can(useMe().role);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { handleLeaderAccountEvent, leaderAccountModal } = useLeaderAccountEvent();
  const [popupPair, setPopupPair] = useState<string | null>(null);

  // Hooks must run unconditionally on every render (rules of hooks) — this
  // has to sit above the loading/error early-returns below, not after them.
  const records = record.data ?? [];
  const { sorted: sortedRecords, sortKey: recSortKey, sortDir: recSortDir, toggleSort: toggleRecSort } =
    useSortableRows(
      records,
      (row, key) => {
        switch (key) {
          case 'status':
            return tr(enrollmentStatusKey(row.status));
          case 'completed':
            return row.completed_at ?? undefined;
          default:
            return row.training?.name;
        }
      },
      { key: 'course', dir: 'asc' },
    );

  usePageChrome({ title: tr('member.title') }, [id, tr]);

  const onPickAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setUploading(true);
    try {
      const file = await compressImage(picked);
      const fd = new FormData();
      fd.append('file', file);
      await api.upload(`/members/${id}/avatar`, fd);
      toast(tr('member.toast.avatar'));
      member.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // Back works without the record, so it goes up with the skeleton: the user
  // can leave again while the profile is still loading.
  if (member.initialLoading)
    return (
      <>
        <BackButton onClick={() => router.push('/members')} />
        <SkeletonScreen>
          <SkeletonDetail />
        </SkeletonScreen>
      </>
    );
  if (member.error || !member.data)
    return <ErrorBanner message={member.error ?? tr('member.notFound')} />;

  const m = member.data;
  const role = memberRole(m);
  const pairs = (allPairs.data ?? []).filter(
    (p) => p.mentor_id === m.id || p.trainee_id === m.id,
  );

  const serving = m.serving_roles ?? [];

  // The facts are grouped into several smaller FactGrids under section
  // headers, rather than one long undifferentiated grid — FactGrid itself is
  // unchanged (rule G4), it is simply called more than once. 教会身份 is
  // deliberately not repeated here: it is already the badge in the header
  // above.
  const contactFacts = [
    { label: tr('members.field.email'), value: m.email ?? '—' },
    { label: tr('members.field.phone'), value: m.phone ?? '—' },
    { label: tr('member.field.gender'), value: m.gender ? tr(genderKey(m.gender)) : '—' },
    { label: tr('member.field.birthday'), value: formatDate(m.date_of_birth) },
    { label: tr('members.field.address'), value: m.address ?? '—' },
  ];
  const churchFacts = [
    { label: tr('hall.label'), value: m.hall?.name ?? '—' },
    { label: tr('members.col.group'), value: m.group?.name ?? tr('members.filter.ungrouped') },
    { label: tr('members.col.status'), value: tr(memberStatusKey(m.status)) },
    { label: tr('member.field.joined'), value: formatDate(m.joined_at) },
    { label: tr('member.field.groupJoinedAt'), value: formatDate(m.group_joined_at) },
  ];
  const ministryFacts = [
    {
      label: tr('members.field.serving'),
      // Nothing at all when they serve nowhere: an empty list is a fact about
      // this person, not a value the church has yet to fill in, and a "—" here
      // would read as the second.
      value: serving.length > 0
        ? (
            <span className="flex gap-6 flex-wrap">
              {serving.map((r) => (
                <span key={r} className="badge b-brand">{r}</span>
              ))}
            </span>
          )
        : '',
    },
  ];
  const notesFacts = [{ label: tr('member.field.notes'), value: m.notes ?? '—' }];
  const referralFacts = [
    {
      label: tr('members.field.referrer'),
      // The embed is null for almost everybody, so it is guarded rather than
      // assumed (rule G6) — and when there IS one, it is a way to get to them:
      // "who brought this person" is a question you ask about the referrer next.
      value: m.referrer ? (
        <Link href={`/members/${m.referrer.id}`}>
          <MemberName member={m.referrer} />
        </Link>
      ) : (
        tr('members.noReferrer')
      ),
    },
  ];

  return (
    <>
      <BackButton onClick={() => router.push('/members')} />

      <div className="card">
        {/* The header is the one place a member IS the page, so it carries the
            same two-line name every list shows (rule G4) — the English name
            moved out of the subtitle and under the Chinese one. */}
        <EntityHeader
          avatar={<Avatar name={m.full_name} url={m.avatar_url} size="passport" />}
          title={<MemberName member={m} />}
          badges={<RoleBadge role={role} />}
          sub={m.group?.name ?? tr('members.filter.ungrouped')}
          below={
            <>
              {perms.write && (
                <button
                  className="btn ghost sm"
                  style={{ marginTop: 8 }}
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading
                    ? tr('member.uploading')
                    : m.avatar_url
                      ? tr('member.changeAvatar')
                      : tr('member.uploadAvatar')}
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                onChange={onPickAvatar}
                style={{ display: 'none' }}
              />
            </>
          }
          actions={
            <>
            {perms.write && <button className="btn" onClick={() => setEditOpen(true)}>{tr('member.editProfile')}</button>}
            {perms.delete && (
              <button
                className="btn danger"
                onClick={async () => {
                  const ok = await confirm({
                    title: tr('member.delete.title'),
                    message: tr('member.delete.message', { name: m.full_name }),
                    confirmText: tr('common.delete'),
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    await api.delete(`/members/${m.id}`);
                    toast(tr('member.toast.deleted'));
                    router.push('/members');
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
              >
                {tr('common.delete')}
              </button>
            )}
            </>
          }
        />

        <div className="section-label" style={{ margin: '18px 0 10px' }}>{tr('member.section.contact')}</div>
        <FactGrid facts={contactFacts} />

        <div className="section-label" style={{ margin: '20px 0 10px' }}>{tr('member.section.church')}</div>
        <FactGrid facts={churchFacts} />

        <div className="section-label" style={{ margin: '20px 0 10px' }}>{tr('member.section.ministry')}</div>
        <FactGrid facts={ministryFacts} />

        <div className="section-label" style={{ margin: '20px 0 10px' }}>{tr('member.field.notes')}</div>
        <FactGrid facts={notesFacts} />

        <div className="section-label" style={{ margin: '20px 0 10px' }}>{tr('member.section.referral')}</div>
        <FactGrid facts={referralFacts} />

        <div className="section-label" style={{ margin: '24px 0 12px' }}>{tr('member.trainingRecord')}</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh sortKey="course" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort}>{tr('member.col.course')}</SortTh>
                <SortTh sortKey="status" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort}>{tr('members.col.status')}</SortTh>
                <th style={{ width: 200 }}>{tr('member.col.progress')}</th>
                <SortTh sortKey="completed" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort}>{tr('member.col.completed')}</SortTh>
              </tr>
            </thead>
            <tbody>
              {sortedRecords.map((row) => (
                <tr key={row.id}>
                  <td><strong>{row.training?.name ?? '—'}</strong></td>
                  <td>
                    <span className={`badge ${enrollmentStatusClass(row.status)}`}>
                      {tr(enrollmentStatusKey(row.status))}
                    </span>
                  </td>
                  <td><ProgressBar percent={row.progress} /></td>
                  <td className="muted tnum">{formatDate(row.completed_at)}</td>
                </tr>
              ))}
              {sortedRecords.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty-inline">
                    {tr('member.noTraining')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {discipleshipOn && (
        <>
        <div className="section-label" style={{ margin: '24px 0 12px' }}>{tr('disc.title')}</div>
        {pairs.length === 0 ? (
          <div className="faint" style={{ fontSize: 13 }}>{tr('member.noPairs')}</div>
        ) : (
          pairs.map((p) => {
            const asMentor = p.mentor_id === m.id;
            const other = asMentor ? p.trainee : p.mentor;
            // "Leading X" / "Led by X" — one sentence per pair, aligned with
            // how /discipleship itself and PairProgressModal phrase the same
            // relationship (the ➜ arrow, `disc.progress.direction`).
            return (
              <div
                key={p.id}
                className="flex items-center gap-10 flex-wrap"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginBottom: 8, cursor: 'pointer' }}
                onClick={() => setPopupPair(p.id)}
              >
                <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{asMentor ? '➜' : '←'}</span>
                <span style={{ fontSize: 13.5 }}>
                  {tr(asMentor ? 'member.pair.leading' : 'member.pair.ledBy', {
                    name: other?.full_name ?? '',
                  })}
                </span>
                <div className="grow" />
                <span className="badge b-warn">{tr('member.viewProgress')}</span>
              </div>
            );
          })
        )}
        </>
        )}
      </div>

      {editOpen && (
        <MemberEditModal
          member={m}
          onClose={() => setEditOpen(false)}
          onSaved={(leaderEvents) => {
            setEditOpen(false);
            member.reload();
            toast(tr('member.toast.saved'));
            leaderEvents?.forEach(({ event, name }) => handleLeaderAccountEvent(event, name));
          }}
        />
      )}
      {leaderAccountModal}

      {popupPair && (
        <PairProgressModal pairId={popupPair} canEdit={perms.write} onClose={() => setPopupPair(null)} />
      )}
    </>
  );
}
