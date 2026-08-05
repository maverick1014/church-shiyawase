'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import { ErrorBanner, ExportButton, Field, Loading, Modal, SortTh, useConfirm, useToast } from '@/components/ui';
import { can } from '@/lib/perms';
import { exportMatrix } from '@/lib/export';
import { EnrollmentRow, MemberRow, NamelistResponse, SessionRow, TrainingDetail } from '@/lib/types';
import {
  categoryBadgeClass,
  ENROLLMENT_STATUS_LABELS,
  enrollmentStatusClass,
  formatDate,
  formatDateTime,
  memberRoleZh,
} from '@/lib/labels';
import { EnrollmentStatus } from '@tog/shared';
import { TrainingModal } from '@/components/TrainingModal';

export default function TrainingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
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
      (r, key) => (key === 'role' ? memberRoleZh(r.member) : r.member.full_name),
      { key: 'name', dir: 'asc' },
    );

  usePageChrome({ title: '培训详情', subtitle: '场次 · 报名审核 · 核对名单' }, [id]);

  if (detail.initialLoading) return <Loading />;
  if (detail.error || !detail.data) return <ErrorBanner message={detail.error ?? '找不到课程'} />;

  const t = detail.data;
  const pending = t.enrollments.filter((e) => e.status === EnrollmentStatus.Pending).length;

  // Real attendance rate for the 报名审核 bar: attended sessions / total sessions,
  // read from the 核对名单 (only approved+ enrollees appear there, so a pending
  // enrollee correctly shows 0%).
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
      toast('已通过报名');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const enrollMember = async (memberId: string) => {
    if (!memberId) return;
    try {
      await api.post(`/trainings/${id}/enroll`, { member_id: memberId });
      detail.reload();
      toast('已加入报名');
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
      title: '删除场次',
      message: `删除「${s.title ?? `第 ${s.session_number} 课`}」？该场次的出席记录将一并移除。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/trainings/sessions/${s.id}`);
      detail.reload();
      namelist.reload();
      toast('已删除场次');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const removeEnrollment = async (e: EnrollmentRow, pendingReject: boolean) => {
    const ok = await confirm({
      title: pendingReject ? '拒绝报名' : '移除报名',
      message: pendingReject
        ? `拒绝 ${e.member?.full_name ?? '该成员'} 的报名申请？`
        : `将 ${e.member?.full_name ?? '该成员'} 移出本课程？其出席记录将一并移除。`,
      confirmText: pendingReject ? '拒绝' : '移除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/trainings/enrollments/${e.id}`);
      detail.reload();
      namelist.reload();
      toast(pendingReject ? '已拒绝报名' : '已移除报名');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const del = async () => {
    const ok = await confirm({
      title: '删除课程',
      message: `删除「${t.name}」？报名与名单记录将一并移除。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/trainings/${id}`);
      toast('已删除课程');
      router.push('/trainings');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const exportNamelist = () => {
    if (!nl) return;
    const headers = [
      '报名成员',
      '身份',
      ...nl.sessions.map((s) => `第${s.session_number}课 ${s.title ?? ''}`.trim()),
      '出席场次',
    ];
    const matrix = sortedNamelist.map((r) => [
      r.member.full_name,
      memberRoleZh(r.member),
      ...r.attendance.map((a) => (a.attended ? '出席' : '缺席')),
      r.attendance.filter((a) => a.attended).length,
    ]);
    exportMatrix(`${t.name}_核对名单`, '名单', headers, matrix);
  };

  const copyEnrollLink = () => {
    const link = `${window.location.origin}/enroll/${id}`;
    navigator.clipboard?.writeText(link).then(
      () => toast('报名链接已复制，可发给大家'),
      () => toast(link),
    );
  };

  return (
    <>
      <button className="back-btn" onClick={() => router.push('/trainings')}>‹ 返回课程目录</button>

      <div className="card">
        <div className="flex-between flex-wrap">
          <div>
            <div className="flex items-center gap-10 flex-wrap">
              <span className={`badge ${categoryBadgeClass(t.category)}`}>{t.category ?? '课程'}</span>
              <span className={`badge ${t.is_enrollable ? 'b-good' : 'b-gray'}`}>{t.is_enrollable ? '开放报名' : '已截止'}</span>
            </div>
            <h2 style={{ margin: '10px 0 3px', fontSize: 22 }} className="serif">{t.name}</h2>
            <div className="muted" style={{ fontSize: 12.5 }}>
              讲师：{t.trainer?.full_name ?? '待定'} · 共 {t.total_sessions} 场次 · {formatDate(t.starts_on)} 至 {formatDate(t.ends_on)}
            </div>
          </div>
          <div className="flex gap-8">
            {t.is_enrollable && (
              <button className="btn ghost" onClick={copyEnrollLink} title="复制可发给成员的自助报名链接">🔗 报名链接</button>
            )}
            {perms.write && <button className="btn ghost" onClick={() => setEditOpen(true)}>编辑课程</button>}
          </div>
        </div>
      </div>

      <div className="grid g2 mt-16">
        {/* Sessions */}
        <div className="card">
          <div className="card-head">
            <h3>课程场次</h3>
            {perms.write && <button className="btn ghost sm" onClick={() => setSessionOpen(true)}>＋ 加场次</button>}
          </div>
          {t.sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-12" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }} className="serif">
                {s.session_number}
              </div>
              <div className="grow" style={{ minWidth: 0 }}>
                <strong style={{ fontSize: 13 }}>{s.title ?? `第 ${s.session_number} 课`}</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  {s.scheduled_at ? formatDateTime(s.scheduled_at) : '待定'} · {s.location ?? '—'}
                </div>
              </div>
              {perms.write && (
                <button className="btn ghost sm" style={{ flexShrink: 0 }} onClick={() => setEditSession(s)}>编辑</button>
              )}
              {perms.delete && (
                <button className="btn danger sm" style={{ flexShrink: 0 }} onClick={() => delSession(s)}>删除</button>
              )}
            </div>
          ))}
          {t.sessions.length === 0 && (
            <div className="empty-inline">尚无场次，点「＋ 加场次」开始安排。</div>
          )}
        </div>

        {/* Enrollment approval */}
        <div className="card">
          <div className="card-head">
            <h3>报名审核</h3>
            <span className="muted" style={{ fontSize: 12 }}>{t.enrollments.length} 报名 · {pending} 待审</span>
          </div>
          {perms.write && (
            <div className="flex gap-8 mb-14">
              <select defaultValue="" onChange={(e) => { enrollMember(e.target.value); e.target.value = ''; }} style={{ flex: 1 }}>
                <option value="">加入报名成员…</option>
                {(members.data ?? [])
                  .filter((m) => !t.enrollments.some((e) => e.member_id === m.id))
                  .map((m) => (
                    <option key={m.id} value={m.id}>{m.full_name}</option>
                  ))}
              </select>
            </div>
          )}
          <div style={{ maxHeight: 296, overflowY: 'auto' }}>
            {t.enrollments.map((e) => {
              const att = attendanceOf(e.member_id);
              return (
              <div key={e.id} className="flex items-center gap-10" style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 13 }}>{e.member?.full_name ?? '—'}</strong>
                  <div className="muted" style={{ fontSize: 11.5 }}>{e.member ? memberRoleZh(e.member) : ''}</div>
                </div>
                <div className="flex items-center gap-6" style={{ flex: 'none' }} title={`出席 ${att.attended}/${att.total} 场`}>
                  <div className="bar thin" style={{ width: 64 }}>
                    <span style={{ width: `${att.pct}%` }} />
                  </div>
                  <span className="faint tnum" style={{ fontSize: 11, minWidth: 26 }}>{att.attended}/{att.total}</span>
                </div>
                {/* Fixed-width, right-aligned so the bar to its left always lands
                    in the same spot regardless of which buttons this row shows. */}
                <div className="flex items-center gap-6" style={{ width: 172, flexShrink: 0, justifyContent: 'flex-end' }}>
                  <span className={`badge ${enrollmentStatusClass(e.status)}`} style={{ flexShrink: 0 }}>
                    {ENROLLMENT_STATUS_LABELS[e.status] ?? e.status}
                  </span>
                  {perms.write && e.status === EnrollmentStatus.Pending && (
                    <button className="btn good sm" style={{ flexShrink: 0 }} onClick={() => approve(e.id)}>通过</button>
                  )}
                  {perms.delete && e.status === EnrollmentStatus.Pending && (
                    <button className="btn danger sm" style={{ flexShrink: 0 }} onClick={() => removeEnrollment(e, true)}>拒绝</button>
                  )}
                  {perms.delete && e.status !== EnrollmentStatus.Pending && (
                    <button className="btn danger sm" style={{ flexShrink: 0 }} onClick={() => removeEnrollment(e, false)}>移除</button>
                  )}
                </div>
              </div>
              );
            })}
            {t.enrollments.length === 0 && (
              <div className="empty-inline">尚无报名。</div>
            )}
          </div>
        </div>
      </div>

      {/* Namelist grid */}
      <div className="card mt-16">
        <div className="card-head">
          <div>
            <h3>核对名单</h3>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>逐场次核对出席，点击方格切换 ✓ · 空 缺席</div>
          </div>
          <ExportButton onClick={exportNamelist} disabled={!nl || nl.rows.length === 0} title="导出名单" />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh sortKey="name" activeKey={nlSortKey} dir={nlSortDir} onSort={toggleNlSort}>报名成员</SortTh>
                <SortTh sortKey="role" activeKey={nlSortKey} dir={nlSortDir} onSort={toggleNlSort}>身份</SortTh>
                {(nl?.sessions ?? []).map((s) => (
                  <th key={s.id} style={{ textAlign: 'center' }}>
                    第 {s.session_number} 课<br /><span style={{ fontWeight: 400 }}>{s.title ?? ''}</span>
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
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{memberRoleZh(r.member)}</td>
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
                    通过报名后，成员将出现在核对名单中。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex gap-12 flex-wrap muted mt-14" style={{ fontSize: 12 }}>
          <span className="flex items-center gap-6"><i style={{ width: 12, height: 12, borderRadius: 3, display: 'inline-block', background: 'var(--good)' }} /> 已出席</span>
          <span className="flex items-center gap-6"><i style={{ width: 12, height: 12, borderRadius: 3, display: 'inline-block', background: 'var(--surface-2)', border: '1px dashed var(--border)' }} /> 缺席</span>
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
            toast('已更新课程');
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
            toast(editSession ? '已更新场次' : '已加入场次');
          }}
        />
      )}
    </>
  );
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
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
  const toast = useToast();
  const [form, setForm] = useState({
    session_number: session?.session_number ?? nextNumber,
    title: session?.title ?? '',
    scheduled_at: toLocalInput(session?.scheduled_at ?? null),
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
        scheduled_at: form.scheduled_at ? new Date(form.scheduled_at).toISOString() : null,
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
    <Modal title={session ? '编辑场次' : '新增场次'} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      {/* 标题 is the primary field (full width); the shorter 第几课 + 时间 share
          one row; 地点 gets its own full-width row — a tidy 1 / 2 / 1 layout. */}
      <Field label="课程标题">
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="得救确据" />
      </Field>
      <div className="form-row">
        <Field label="第几课">
          <input type="number" min={1} value={form.session_number} onChange={(e) => setForm({ ...form, session_number: Number(e.target.value) })} />
        </Field>
        <Field label="时间">
          <input type="datetime-local" className={form.scheduled_at ? undefined : 'date-empty'} value={form.scheduled_at} onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })} />
        </Field>
      </div>
      <Field label="地点">
        <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="副堂" />
      </Field>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </Modal>
  );
}
