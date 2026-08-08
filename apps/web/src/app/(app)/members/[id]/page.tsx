'use client';

import { useParams, useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import { Avatar, BackButton, EntityHeader, ErrorBanner, Field, HallSelect, Loading, Modal, ProgressBar, RoleBadge, SortTh, useConfirm, useToast } from '@/components/ui';
import { PairProgressModal } from '@/components/PairProgressModal';
import { can } from '@/lib/perms';
import { EnrollmentRow, GroupDetail, GroupRow, MemberRow, PairRow } from '@/lib/types';
import { ChurchRole, GroupPosition, LEADERSHIP_POSITIONS, MemberStatus, Gender } from '@tog/shared';
import {
  categoryBadgeClass,
  CHURCH_ROLE_OPTIONS,
  churchRoleKey,
  enrollmentStatusClass,
  enrollmentStatusKey,
  formatDate,
  genderKey,
  GENDER_OPTIONS,
  GROUP_POSITION_OPTIONS,
  MEMBER_STATUS_OPTIONS,
  memberRole,
  memberStatusKey,
  positionKey,
  trainingCategoryLabel,
} from '@/lib/labels';
import { useT } from '@/lib/i18n';

export default function MemberDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const tr = useT();

  const member = useFetch<MemberRow>(`/members/${id}`);
  const record = useFetch<EnrollmentRow[]>(`/members/${id}/trainings`);
  const allPairs = useFetch<PairRow[]>('/discipleship/pairs');
  const toast = useToast();
  const confirm = useConfirm();
  const perms = can(useMe().role);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [popupPair, setPopupPair] = useState<string | null>(null);

  // Hooks must run unconditionally on every render (rules of hooks) — this
  // has to sit above the loading/error early-returns below, not after them.
  const records = record.data ?? [];
  const { sorted: sortedRecords, sortKey: recSortKey, sortDir: recSortDir, toggleSort: toggleRecSort } =
    useSortableRows(
      records,
      (row, key) => {
        switch (key) {
          case 'category':
            return trainingCategoryLabel(row.training?.category ?? null, tr) || undefined;
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
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
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

  if (member.initialLoading) return <Loading />;
  if (member.error || !member.data)
    return <ErrorBanner message={member.error ?? tr('member.notFound')} />;

  const m = member.data;
  const role = memberRole(m);
  const pairs = (allPairs.data ?? []).filter(
    (p) => p.mentor_id === m.id || p.trainee_id === m.id,
  );

  const facts = [
    { k: tr('members.field.email'), v: m.email ?? '—' },
    { k: tr('members.field.phone'), v: m.phone ?? '—' },
    { k: tr('member.field.gender'), v: m.gender ? tr(genderKey(m.gender)) : '—' },
    { k: tr('members.col.group'), v: m.group?.name ?? tr('members.filter.ungrouped') },
    { k: tr('members.col.status'), v: tr(memberStatusKey(m.status)) },
    { k: tr('member.field.joined'), v: formatDate(m.joined_at) },
    { k: tr('member.field.birthday'), v: formatDate(m.date_of_birth) },
    { k: tr('member.field.household'), v: m.household?.name ?? '—' },
  ];

  return (
    <>
      <BackButton onClick={() => router.push('/members')} />

      <div className="card">
        <EntityHeader
          avatar={<Avatar name={m.full_name} url={m.avatar_url} size="passport" />}
          title={m.full_name}
          badges={<RoleBadge role={role} />}
          sub={
            <>
              {m.chinese_name ? `${m.chinese_name} · ` : ''}
              {m.group?.name ?? tr('members.filter.ungrouped')}
            </>
          }
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

        <div className="grid g4" style={{ marginTop: 18 }}>
          {facts.map((f) => (
            <div key={f.k} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}>
              <div className="muted" style={{ fontSize: 11.5 }}>{f.k}</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{f.v}</div>
            </div>
          ))}
        </div>

        <div className="section-label" style={{ margin: '24px 0 12px' }}>{tr('member.trainingRecord')}</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh sortKey="course" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort}>{tr('member.col.course')}</SortTh>
                <SortTh sortKey="category" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort}>{tr('member.col.category')}</SortTh>
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
                    <span className={`badge ${categoryBadgeClass(row.training?.category ?? null)}`}>
                      {trainingCategoryLabel(row.training?.category ?? null, tr) || '—'}
                    </span>
                  </td>
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
                  <td colSpan={5} className="empty-inline">
                    {tr('member.noTraining')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="section-label" style={{ margin: '24px 0 12px' }}>{tr('disc.title')}</div>
        {pairs.length === 0 ? (
          <div className="faint" style={{ fontSize: 13 }}>{tr('member.noPairs')}</div>
        ) : (
          pairs.map((p) => {
            const asMentor = p.mentor_id === m.id;
            const other = asMentor ? p.trainee?.full_name : p.mentor?.full_name;
            return (
              <div
                key={p.id}
                className="flex items-center gap-12 flex-wrap"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginBottom: 8, cursor: 'pointer' }}
                onClick={() => setPopupPair(p.id)}
              >
                <span className="badge b-brand">{asMentor ? tr('disc.col.mentor') : tr('disc.col.trainee')}</span>
                <strong>{other}</strong>
                <div className="grow" />
                <span className="badge b-warn">{tr('member.viewProgress')}</span>
              </div>
            );
          })
        )}
      </div>

      {editOpen && (
        <EditMemberModal
          member={m}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            member.reload();
            toast(tr('member.toast.saved'));
          }}
        />
      )}

      {popupPair && <PairProgressModal pairId={popupPair} onClose={() => setPopupPair(null)} />}
    </>
  );
}

function EditMemberModal({
  member,
  onClose,
  onSaved,
}: {
  member: MemberRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    full_name: member.full_name ?? '',
    chinese_name: member.chinese_name ?? '',
    phone: member.phone ?? '',
    email: member.email ?? '',
    gender: member.gender ?? '',
    date_of_birth: member.date_of_birth ?? '',
    joined_at: member.joined_at ?? '',
    status: member.status,
    notes: member.notes ?? '',
    church_role: member.church_role,
    hall_id: member.hall_id as string | null,
    group_id: member.group_id ?? '',
    group_position: member.group_position ?? GroupPosition.NewMember,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = useT();
  const toast = useToast();

  const allGroups = useFetch<GroupRow[]>('/groups');
  // Sibling members of whichever group is currently SELECTED (not necessarily
  // the member's original group) — used to auto-demote whoever currently
  // holds a leadership slot when someone new is assigned to it (one holder
  // per leadership position per group).
  const groupDetail = useFetch<GroupDetail>(form.group_id ? `/groups/${form.group_id}` : null);

  const changeGroup = (groupId: string) => {
    setForm({
      ...form,
      group_id: groupId,
      group_position:
        groupId === (member.group_id ?? '')
          ? member.group_position ?? GroupPosition.NewMember
          : GroupPosition.NewMember,
    });
  };

  const save = async () => {
    if (!form.full_name.trim()) {
      setErr(t('members.err.name'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      if (form.group_id && LEADERSHIP_POSITIONS.includes(form.group_position)) {
        const incumbent = (groupDetail.data?.members ?? []).find(
          (m) => m.id !== member.id && m.group_position === form.group_position,
        );
        if (incumbent) {
          await api.patch(`/members/${incumbent.id}`, { group_position: GroupPosition.CoreMember });
        }
      }
      await api.patch(`/members/${member.id}`, {
        full_name: form.full_name.trim(),
        chinese_name: form.chinese_name || null,
        phone: form.phone || null,
        email: form.email || null,
        gender: form.gender || null,
        date_of_birth: form.date_of_birth || null,
        joined_at: form.joined_at || null,
        status: form.status,
        notes: form.notes || null,
        church_role: form.church_role,
        hall_id: form.hall_id,
        group_id: form.group_id || null,
        group_position: form.group_id ? form.group_position : null,
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('member.edit.title')} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <div className="form-row">
        <Field label={t('members.field.name')}>
          <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </Field>
        <Field label={t('members.field.nickname')}>
          <input value={form.chinese_name} onChange={(e) => setForm({ ...form, chinese_name: e.target.value })} />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('members.field.phone')}>
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="012-000 0000" />
        </Field>
        <Field label={t('members.field.email')}>
          <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@grace.org" />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('member.field.gender')}>
          <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value as Gender | '' })}>
            <option value="">{t('common.unset')}</option>
            {GENDER_OPTIONS.map((g) => (
              <option key={g} value={g}>{t(genderKey(g))}</option>
            ))}
          </select>
        </Field>
        <Field label={t('members.col.status')}>
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as MemberStatus })}>
            {MEMBER_STATUS_OPTIONS.map((st) => (
              <option key={st} value={st}>{t(memberStatusKey(st))}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('member.field.birthday')}>
          <input type="date" className={form.date_of_birth ? undefined : 'date-empty'} value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} />
        </Field>
        <Field label={t('member.field.joined')}>
          <input type="date" className={form.joined_at ? undefined : 'date-empty'} value={form.joined_at} onChange={(e) => setForm({ ...form, joined_at: e.target.value })} />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('hall.label')}>
          <HallSelect value={form.hall_id} onChange={(id) => setForm({ ...form, hall_id: id })} />
        </Field>
        <Field label={t('members.field.group')}>
          <select value={form.group_id} onChange={(e) => changeGroup(e.target.value)}>
            <option value="">{t('members.filter.ungrouped')}</option>
            {(allGroups.data ?? []).map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('members.field.churchRole')}>
          <select value={form.church_role} onChange={(e) => setForm({ ...form, church_role: e.target.value as ChurchRole })}>
            {CHURCH_ROLE_OPTIONS.map((cr) => (
              <option key={cr} value={cr}>{t(churchRoleKey(cr))}</option>
            ))}
          </select>
        </Field>
        {/* Only meaningful once a group is chosen — hidden rather than shown
            disabled, so there's nothing implying a rank that doesn't apply. */}
        {form.group_id && (
          <Field label={t('members.field.groupRole')}>
            <select
              value={form.group_position}
              onChange={(e) => setForm({ ...form, group_position: e.target.value as GroupPosition })}
            >
              {GROUP_POSITION_OPTIONS.map((p) => (
                <option key={p} value={p}>{t(positionKey(p))}</option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <Field label={t('member.field.notes')}>
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
      </Field>
      <div className="hint" style={{ marginBottom: 6 }}>
        {form.group_id ? t('member.hint.leadership') : t('member.hint.noGroup')}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>
  );
}
