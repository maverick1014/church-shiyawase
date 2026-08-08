'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import { BackButton, ErrorBanner, ExportButton, Field, LinkIcon, Modal, SkeletonCard, SkeletonScreen, SortTh, useConfirm, useToast } from '@/components/ui';
import { can } from '@/lib/perms';
import { exportMatrix } from '@/lib/export';
import { EnrollmentRow, MemberRow, NamelistResponse, SessionRow, TrainingDetail } from '@/lib/types';
import {
  categoryBadgeClass,
  enrollmentStatusClass,
  enrollmentStatusKey,
  formatDate,
  formatDateTime,
  memberRole,
  roleKey,
  trainingCategoryLabel,
  trainingKindClass,
  trainingKindKey,
} from '@/lib/labels';
import { fromChurchInput, toChurchInput } from '@/lib/time';
import { useT } from '@/lib/i18n';
import { EnrollmentStatus, TrainingKind } from '@tog/shared';
import { TrainingModal } from '@/components/TrainingModal';

export default function TrainingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const tr = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const perms = can(useMe().role);

  const detail = useFetch<TrainingDetail>(`/trainings/${id}`);
  const namelist = useFetch<NamelistResponse>(`/trainings/${id}/namelist`);
  const members = useFetch<MemberRow[]>('/members');

  const [editOpen, setEditOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [editSession, setEditSession] = useState<SessionRow | null>(null);

  // Hooks must run unconditionally on every render (rules of hooks) — this
  // has to sit above the loading/error early-returns below, not after them.
  const nl = namelist.data;
  const { sorted: sortedNamelist, sortKey: nlSortKey, sortDir: nlSortDir, toggleSort: toggleNlSort } =
    useSortableRows(
      nl?.rows ?? [],
      (r, key) => (key === 'role' ? tr(roleKey(memberRole(r.member))) : r.member.full_name),
      { key: 'name', dir: 'asc' },
    );

  // 培训&活动: the same page serves a course and a one-off activity. An
  // activity's single session is plumbing (it is what the attendance sheet
  // ticks), so nothing about it is shown as a "session list" — its date lives
  // on the record itself and is edited in the activity form.
  const isActivity = detail.data?.kind === TrainingKind.Activity;
  usePageChrome(
    { title: isActivity ? tr('training.activityTitle') : tr('training.title') },
    [id, tr, isActivity],
  );

  // Course header card over the sessions/roster pair — the same three boxes
  // the loaded page draws.
  if (detail.initialLoading)
    return (
      <>
        <BackButton onClick={() => router.push('/trainings')} />
        <SkeletonScreen>
          <SkeletonCard lines={2} />
          <div className="grid g2 mt-16">
            <SkeletonCard lines={5} />
            <SkeletonCard lines={5} />
          </div>
        </SkeletonScreen>
      </>
    );
  if (detail.error || !detail.data)
    return <ErrorBanner message={detail.error ?? tr('training.notFound')} />;

  const t = detail.data;
  const pending = t.enrollments.filter((e) => e.status === EnrollmentStatus.Pending).length;

  // Real attendance rate for the enrolment-review bar: attended / total
  // sessions, read from the attendance sheet (only approved+ enrollees appear
  // there, so a pending enrollee correctly shows 0%).
  const sessionTotal = nl?.sessions.length ?? 0;
  const attendanceOf = (memberId: string) => {
    const row = nl?.rows.find((r) => r.member.id === memberId);
    const attended = row ? row.attendance.filter((a) => a.attended).length : 0;
    return { attended, total: sessionTotal, pct: sessionTotal ? Math.round((attended / sessionTotal) * 100) : 0 };
  };

  const approve = async (enrollmentId: string) => {
    try {
      await api.patch(`/trainings/enrollments/${enrollmentId}`, {
        status: EnrollmentStatus.Approved,
      });
      detail.reload();
      namelist.reload();
      toast(tr('training.toast.approved'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const enrollMember = async (memberId: string) => {
    if (!memberId) return;
    try {
      await api.post(`/trainings/${id}/enroll`, { member_id: memberId });
      detail.reload();
      toast(tr('training.toast.enrolled'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const toggleTick = async (sessionId: string, memberId: string, attended: boolean) => {
    try {
      await api.post(`/trainings/sessions/${sessionId}/attendance`, {
        records: [{ member_id: memberId, attended }],
      });
      namelist.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const delSession = async (s: SessionRow) => {
    const ok = await confirm({
      title: tr('training.session.delete.title'),
      message: tr('training.session.delete.message', {
        name: s.title ?? tr('training.session.default', { n: s.session_number }),
      }),
      confirmText: tr('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/trainings/sessions/${s.id}`);
      detail.reload();
      namelist.reload();
      toast(tr('training.toast.sessionDeleted'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const removeEnrollment = async (e: EnrollmentRow, pendingReject: boolean) => {
    const who = e.member?.full_name ?? tr('training.thisMember');
    const ok = await confirm({
      title: pendingReject ? tr('training.reject.title') : tr('training.removeEnrollee.title'),
      message: pendingReject
        ? tr('training.reject.message', { name: who })
        : tr('training.removeEnrollee.message', { name: who }),
      confirmText: pendingReject ? tr('training.reject') : tr('common.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/trainings/enrollments/${e.id}`);
      detail.reload();
      namelist.reload();
      toast(pendingReject ? tr('training.toast.rejected') : tr('training.toast.removedEnrollee'));
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const del = async () => {
    const ok = await confirm({
      title: isActivity ? tr('trainings.deleteActivity.title') : tr('trainings.delete.title'),
      message: tr('trainings.delete.message', { name: t.name }),
      confirmText: tr('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/trainings/${id}`);
      toast(isActivity ? tr('trainings.toast.activityDeleted') : tr('trainings.toast.deleted'));
      router.push('/trainings');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const exportNamelist = () => {
    if (!nl) return;
    const headers = [
      tr('training.col.enrollee'),
      tr('export.role'),
      ...nl.sessions.map((s) =>
        isActivity
          ? tr('training.col.attendedActivity')
          : `${tr('export.session', { n: s.session_number })} ${s.title ?? ''}`.trim(),
      ),
      tr('training.exportSessionCount'),
    ];
    const matrix = sortedNamelist.map((r) => [
      r.member.full_name,
      tr(roleKey(memberRole(r.member))),
      ...r.attendance.map((a) => (a.attended ? tr('training.legend.present') : tr('training.legend.absent'))),
      r.attendance.filter((a) => a.attended).length,
    ]);
    exportMatrix(
      tr('training.exportFile', { name: t.name }),
      tr('trainings.roster'),
      headers,
      matrix,
    );
  };

  const copyEnrollLink = () => {
    const link = `${window.location.origin}/enroll/${id}`;
    navigator.clipboard?.writeText(link).then(
      () => toast(tr('training.toast.linkCopied')),
      () => toast(link),
    );
  };

  return (
    <>
      <BackButton onClick={() => router.push('/trainings')} />

      <div className="card">
        <div className="flex-between flex-wrap">
          <div>
            <div className="flex items-center gap-10 flex-wrap">
              <span className={`badge ${trainingKindClass(t.kind)}`}>{tr(trainingKindKey(t.kind))}</span>
              <span className={`badge ${categoryBadgeClass(t.category)}`}>
                {trainingCategoryLabel(t.category, tr) || tr('trainings.defaultCategory')}
              </span>
              <span className={`badge ${t.is_enrollable ? 'b-good' : 'b-gray'}`}>
                {t.is_enrollable ? tr('trainings.open') : tr('trainings.closed')}
              </span>
            </div>
            <h2 style={{ margin: '10px 0 3px', fontSize: 22 }} className="serif">{t.name}</h2>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {isActivity
                ? tr('training.summaryActivity', {
                    trainer: t.trainer?.full_name ?? tr('common.pending'),
                    date: formatDate(t.starts_on),
                  })
                : tr('training.summary', {
                    trainer: t.trainer?.full_name ?? tr('common.pending'),
                    sessions: t.total_sessions,
                    from: formatDate(t.starts_on),
                    to: formatDate(t.ends_on),
                  })}
            </div>
          </div>
          <div className="flex gap-8">
            {t.is_enrollable && (
              <button className="btn ghost" onClick={copyEnrollLink} title={tr('training.enrollLinkTitle')}>
                <LinkIcon />
                {tr('training.enrollLink')}
              </button>
            )}
            {perms.write && (
              <button className="btn ghost" onClick={() => setEditOpen(true)}>
                {isActivity ? tr('training.editActivity') : tr('training.editCourse')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* An activity has ONE occasion and no session list, so it drops to a
          single full-width card instead of leaving half the row empty. */}
      <div className={isActivity ? 'mt-16' : 'grid g2 mt-16'}>
        {!isActivity && (
        <div className="card">
          <div className="card-head">
            <h3>{tr('training.sessionList')}</h3>
            {perms.write && <button className="btn ghost sm" onClick={() => setSessionOpen(true)}>{tr('training.addSession')}</button>}
          </div>
          {t.sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-12" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }} className="serif">
                {s.session_number}
              </div>
              <div className="grow">
                <strong style={{ fontSize: 13 }}>
                  {s.title ?? tr('training.session.default', { n: s.session_number })}
                </strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  {s.scheduled_at ? formatDateTime(s.scheduled_at) : tr('training.session.tbd')} · {s.location ?? '—'}
                </div>
              </div>
              {perms.write && (
                <button className="btn ghost sm" style={{ flexShrink: 0 }} onClick={() => setEditSession(s)}>{tr('common.edit')}</button>
              )}
              {perms.delete && (
                <button className="btn danger sm" style={{ flexShrink: 0 }} onClick={() => delSession(s)}>{tr('common.delete')}</button>
              )}
            </div>
          ))}
          {t.sessions.length === 0 && (
            <div className="empty-inline">{tr('training.noSessions')}</div>
          )}
        </div>
        )}

        {/* Enrollment approval */}
        <div className="card">
          <div className="card-head">
            <h3>{tr('training.review')}</h3>
            <span className="muted" style={{ fontSize: 12 }}>
              {tr('training.reviewCount', { total: t.enrollments.length, pending })}
            </span>
          </div>
          {perms.write && (
            <div className="flex gap-8 mb-14">
              <select defaultValue="" onChange={(e) => { enrollMember(e.target.value); e.target.value = ''; }} style={{ flex: 1 }}>
                <option value="">{tr('training.addEnrollee')}</option>
                {(members.data ?? [])
                  .filter((m) => !t.enrollments.some((e) => e.member_id === m.id))
                  .map((m) => (
                    <option key={m.id} value={m.id}>{m.full_name}</option>
                  ))}
              </select>
            </div>
          )}
          <div className="enrol-list">
            {t.enrollments.map((e) => {
              const att = attendanceOf(e.member_id);
              return (
              <div key={e.id} className="enrol-row flex items-center gap-10" style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                <div className="grow">
                  <strong style={{ fontSize: 13 }}>{e.member?.full_name ?? '—'}</strong>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {e.member ? tr(roleKey(memberRole(e.member))) : ''}
                  </div>
                </div>
                <div
                  className="flex items-center gap-6"
                  style={{ flex: 'none' }}
                  title={tr('training.attendanceOf', { attended: att.attended, total: att.total })}
                >
                  <div className="bar thin" style={{ width: 64 }}>
                    <span style={{ width: `${att.pct}%` }} />
                  </div>
                  <span className="faint tnum" style={{ fontSize: 11, minWidth: 26 }}>{att.attended}/{att.total}</span>
                </div>
                {/* Right-aligned, and a fixed width on desktop only, so the bar
                    to its left always lands in the same spot regardless of
                    which buttons this row shows. The fixed width must not
                    apply on a phone: "Pending review + Approve + Reject" is
                    wider than 172px, and because this was flex-shrink:0 the
                    overflow set the row's min-content — which propagated up
                    through the grid and scrolled the whole page sideways. */}
                <div className="row-actions flex items-center gap-6">
                  <span className={`badge ${enrollmentStatusClass(e.status)}`} style={{ flexShrink: 0 }}>
                    {tr(enrollmentStatusKey(e.status))}
                  </span>
                  {perms.write && e.status === EnrollmentStatus.Pending && (
                    <button className="btn good sm" style={{ flexShrink: 0 }} onClick={() => approve(e.id)}>{tr('training.approve')}</button>
                  )}
                  {perms.delete && e.status === EnrollmentStatus.Pending && (
                    <button className="btn danger sm" style={{ flexShrink: 0 }} onClick={() => removeEnrollment(e, true)}>{tr('training.reject')}</button>
                  )}
                  {perms.delete && e.status !== EnrollmentStatus.Pending && (
                    <button className="btn danger sm" style={{ flexShrink: 0 }} onClick={() => removeEnrollment(e, false)}>{tr('common.remove')}</button>
                  )}
                </div>
              </div>
              );
            })}
            {t.enrollments.length === 0 && (
              <div className="empty-inline">{tr('training.noEnrollees')}</div>
            )}
          </div>
        </div>
      </div>

      {/* Namelist grid */}
      <div className="card mt-16">
        <div className="card-head">
          <div>
            <h3>{tr('training.namelist')}</h3>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              {isActivity ? tr('training.namelistSubActivity') : tr('training.namelistSub')}
            </div>
          </div>
          <ExportButton onClick={exportNamelist} disabled={!nl || nl.rows.length === 0} title={tr('training.exportTitle')} />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh sortKey="name" activeKey={nlSortKey} dir={nlSortDir} onSort={toggleNlSort}>{tr('training.col.enrollee')}</SortTh>
                <SortTh sortKey="role" activeKey={nlSortKey} dir={nlSortDir} onSort={toggleNlSort}>{tr('members.col.role')}</SortTh>
                {(nl?.sessions ?? []).map((s) => (
                  <th key={s.id} style={{ textAlign: 'center' }}>
                    {isActivity
                      ? tr('training.col.attendedActivity')
                      : tr('training.col.session', { n: s.session_number })}
                    {!isActivity && (
                      <>
                        <br /><span style={{ fontWeight: 400 }}>{s.title ?? ''}</span>
                      </>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedNamelist.map((r) => (
                <tr key={r.member.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <strong>{r.member.full_name}</strong>
                  </td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{tr(roleKey(memberRole(r.member)))}</td>
                  {r.attendance.map((a) => (
                    <td key={a.session_id} style={{ textAlign: 'center' }}>
                      <span
                        className={`tick ${a.attended ? 'on' : 'off'}`}
                        onClick={perms.write ? () => toggleTick(a.session_id, r.member.id, !a.attended) : undefined}
                        style={{ cursor: perms.write ? 'pointer' : 'default' }}
                      >
                        {a.attended ? '✓' : ''}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
              {sortedNamelist.length === 0 && (
                <tr>
                  <td colSpan={2 + (nl?.sessions.length ?? 0)} className="empty-inline">
                    {tr('training.namelistEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex gap-12 flex-wrap muted mt-14" style={{ fontSize: 12 }}>
          <span className="flex items-center gap-6"><i style={{ width: 12, height: 12, borderRadius: 3, display: 'inline-block', background: 'var(--good)' }} /> {tr('training.legend.present')}</span>
          <span className="flex items-center gap-6"><i style={{ width: 12, height: 12, borderRadius: 3, display: 'inline-block', background: 'var(--surface-2)', border: '1px dashed var(--border)' }} /> {tr('training.legend.absent')}</span>
        </div>
      </div>

      {editOpen && (
        <TrainingModal
          members={members.data ?? []}
          initial={t}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            detail.reload();
            toast(isActivity ? tr('trainings.toast.activityUpdated') : tr('trainings.toast.updated'));
          }}
          onDelete={perms.delete ? del : undefined}
        />
      )}
      {(sessionOpen || editSession) && (
        <SessionModal
          trainingId={id}
          session={editSession}
          nextNumber={(t.sessions[t.sessions.length - 1]?.session_number ?? 0) + 1}
          onClose={() => {
            setSessionOpen(false);
            setEditSession(null);
          }}
          onSaved={() => {
            setSessionOpen(false);
            setEditSession(null);
            detail.reload();
            namelist.reload();
            toast(editSession ? tr('training.toast.sessionUpdated') : tr('training.toast.sessionAdded'));
          }}
        />
      )}
    </>
  );
}

function SessionModal({
  trainingId,
  session,
  nextNumber,
  onClose,
  onSaved,
}: {
  trainingId: string;
  session?: SessionRow | null;
  nextNumber: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [form, setForm] = useState({
    session_number: session?.session_number ?? nextNumber,
    title: session?.title ?? '',
    scheduled_at: toChurchInput(session?.scheduled_at ?? null),
    location: session?.location ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const payload = {
        session_number: Number(form.session_number),
        title: form.title || null,
        scheduled_at: fromChurchInput(form.scheduled_at),
        location: form.location || null,
      };
      if (session) await api.patch(`/trainings/sessions/${session.id}`, payload);
      else await api.post(`/trainings/${trainingId}/sessions`, payload);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={session ? t('training.session.edit') : t('training.session.new')} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      {/* Title is the primary field (full width); the shorter session-number +
          time share one row; location gets its own — a tidy 1 / 2 / 1 layout. */}
      <Field label={t('training.session.title')}>
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('training.session.titlePlaceholder')} />
      </Field>
      <div className="form-row">
        <Field label={t('training.session.number')}>
          <input type="number" min={1} value={form.session_number} onChange={(e) => setForm({ ...form, session_number: Number(e.target.value) })} />
        </Field>
        <Field label={t('training.session.time')}>
          <input type="datetime-local" className={form.scheduled_at ? undefined : 'date-empty'} value={form.scheduled_at} onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })} />
        </Field>
      </div>
      <Field label={t('events.field.location')}>
        <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder={t('training.session.locationPlaceholder')} />
      </Field>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>
  );
}
