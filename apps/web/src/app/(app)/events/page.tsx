'use client';

import { useEffect, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { usePageChrome, useMe, useHallScope } from '@/components/AppShell';
import { ErrorBanner, Field, HallSelect, Loading, Modal, useConfirm, useToast } from '@/components/ui';
import { can } from '@/lib/perms';
import { EventDetail, EventRow, MemberRow } from '@/lib/types';
import {
  ATTENDANCE_LABELS,
  eventBadgeClass,
  EVENT_TYPE_LABELS,
  EVENT_TYPE_OPTIONS,
  formatDateTime,
} from '@/lib/labels';
import { AttendanceStatus, EventType, MemberStatus } from '@tog/shared';

export default function EventsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const perms = can(useMe().role);
  const events = useFetch<EventRow[]>('/events');
  const members = useFetch<MemberRow[]>('/members');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<EventRow | null>(null);

  usePageChrome(
    {
      title: '聚会与出席',
      subtitle: '崇拜 · 祷告会 · 团契 · 逐一点名',
      action: perms.write ? (
        <button className="btn" onClick={() => setAddOpen(true)}>
          ＋ 新增聚会
        </button>
      ) : undefined,
    },
    [perms.write],
  );

  const list = events.data ?? [];
  const now = new Date();
  const sorted = [...list].sort((a, b) => +new Date(b.starts_at) - +new Date(a.starts_at));

  const delEvent = async (e: EventRow): Promise<boolean> => {
    const ok = await confirm({
      title: '删除聚会',
      message: `删除「${e.title}」及其出席记录？`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return false;
    try {
      await api.delete(`/events/${e.id}`);
      events.reload();
      toast('已删除聚会');
      return true;
    } catch (err) {
      toast((err as Error).message, 'error');
      return false;
    }
  };

  if (events.initialLoading) return <Loading />;

  return (
    <>
      <ErrorBanner message={events.error} />

      <div className="grid g3">
        {sorted.map((e) => {
          const upcoming = new Date(e.starts_at) >= now;
          return (
            <div className="card" key={e.id}>
              <div className="flex-between">
                <span className={`badge ${eventBadgeClass(e.event_type)}`}>
                  {EVENT_TYPE_LABELS[e.event_type] ?? e.event_type}
                </span>
                <span className="muted" style={{ fontSize: 12 }}>{upcoming ? '即将' : '已结束'}</span>
              </div>
              <h3 style={{ margin: '12px 0 2px', fontSize: 16 }} className="serif">{e.title}</h3>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {formatDateTime(e.starts_at)}{e.location ? ` · ${e.location}` : ''}
              </div>
              <div className="flex-between mt-14">
                <span className="muted" style={{ fontSize: 12 }}>{e.description ?? ''}</span>
                <div className="flex gap-6">
                  {perms.write && (
                    <button className="btn ghost sm" onClick={() => setEditing(e)}>编辑</button>
                  )}
                  <button className="btn sm" onClick={() => setActiveId(e.id)}>点名</button>
                </div>
              </div>
            </div>
          );
        })}
        {sorted.length === 0 && <div className="empty">尚无聚会，点右上角「＋ 新增聚会」创建。</div>}
      </div>

      {activeId && (
        <AttendancePanel
          key={activeId}
          eventId={activeId}
          members={(members.data ?? []).filter((m) => m.status === MemberStatus.Active)}
          onClose={() => setActiveId(null)}
          onSaved={() => {
            toast('已保存点名');
            setActiveId(null);
          }}
        />
      )}

      {(addOpen || editing) && (
        <EventModal
          event={editing}
          onClose={() => {
            setAddOpen(false);
            setEditing(null);
          }}
          onSaved={() => {
            setAddOpen(false);
            setEditing(null);
            events.reload();
            toast(editing ? '已更新聚会' : '已新增聚会');
          }}
          onDelete={
            editing && perms.delete
              ? async () => {
                  if (await delEvent(editing)) setEditing(null);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

function AttendancePanel({
  eventId,
  members,
  onClose,
  onSaved,
}: {
  eventId: string;
  members: MemberRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const detail = useFetch<EventDetail>(`/events/${eventId}`);
  const toast = useToast();
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!detail.data) return;
    const init: Record<string, AttendanceStatus> = {};
    for (const a of detail.data.attendance) init[a.member_id] = a.status;
    setMarks(init);
  }, [detail.data]);

  const set = (memberId: string, status: AttendanceStatus) =>
    setMarks((m) => ({ ...m, [memberId]: status }));

  const marked = Object.keys(marks).length;

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const records = members
        .filter((m) => marks[m.id])
        .map((m) => ({ member_id: m.id, status: marks[m.id] }));
      await api.post(`/events/${eventId}/attendance`, { records });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} size="wide">
      {err && <ErrorBanner message={err} />}
      <div className="flex-between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h3 className="serif" style={{ margin: 0, fontSize: 18 }}>{detail.data?.title ?? '出席点名'} · 出席点名</h3>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
            逐一标记出席 / 请假 / 缺席，完成后一次保存
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} title="关闭">✕</button>
      </div>

      {detail.loading ? (
        <div style={{ padding: 24 }}><Loading /></div>
      ) : (
        <div style={{ maxHeight: '54vh', overflowY: 'auto', margin: '14px 0 4px' }}>
          {members.map((m) => {
            const cur = marks[m.id];
            return (
              <div key={m.id} className="flex-between" style={{ padding: '10px 4px', borderBottom: '1px solid var(--border)' }}>
                <strong>{m.full_name}</strong>
                <div className="seg">
                  <button
                    className={cur === AttendanceStatus.Present ? 'on-good' : ''}
                    onClick={() => set(m.id, AttendanceStatus.Present)}
                  >
                    {ATTENDANCE_LABELS[AttendanceStatus.Present]}
                  </button>
                  <button
                    className={cur === AttendanceStatus.Excused ? 'on-warn' : ''}
                    onClick={() => set(m.id, AttendanceStatus.Excused)}
                  >
                    {ATTENDANCE_LABELS[AttendanceStatus.Excused]}
                  </button>
                  <button
                    className={cur === AttendanceStatus.Absent ? 'on-crit' : ''}
                    onClick={() => set(m.id, AttendanceStatus.Absent)}
                  >
                    {ATTENDANCE_LABELS[AttendanceStatus.Absent]}
                  </button>
                </div>
              </div>
            );
          })}
          {members.length === 0 && <div className="faint" style={{ textAlign: 'center', padding: 20 }}>暂无在册成员可点名。</div>}
        </div>
      )}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>关闭</button>
        <button className="btn accent" onClick={save} disabled={saving || detail.loading}>
          保存点名（{marked}）
        </button>
      </div>
    </Modal>
  );
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function EventModal({
  event,
  onClose,
  onSaved,
  onDelete,
}: {
  event: EventRow | null;
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => void;
}) {
  const toast = useToast();
  const { hallId } = useHallScope();
  const [form, setForm] = useState({
    title: event?.title ?? '',
    event_type: (event?.event_type ?? EventType.Service) as EventType,
    location: event?.location ?? '',
    starts_at: toLocalInput(event?.starts_at ?? null),
    // Editing keeps the event's own hall; creating defaults to the hall being
    // viewed (and to 全堂 / 联合聚会 only when viewing 全部堂会).
    hall_id: event ? event.hall_id : hallId || null,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!form.title.trim() || !form.starts_at) {
      setErr('请填写标题与开始时间');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const payload = {
        title: form.title.trim(),
        event_type: form.event_type,
        location: form.location || null,
        starts_at: new Date(form.starts_at).toISOString(),
        hall_id: form.hall_id,
      };
      if (event) await api.patch(`/events/${event.id}`, payload);
      else await api.post('/events', payload);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={event ? '编辑聚会' : '新增聚会'} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <Field label="标题">
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="例如：周三祷告会" />
      </Field>
      <div className="form-row">
        <Field label="类型">
          <select value={form.event_type} onChange={(e) => setForm({ ...form, event_type: e.target.value as EventType })}>
            {EVENT_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>{EVENT_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </Field>
        <Field label="地点">
          <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="大堂 / 副堂" />
        </Field>
      </div>
      <div className="form-row">
        <Field label="开始时间">
          <input type="datetime-local" className={form.starts_at ? undefined : 'date-empty'} value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
        </Field>
        <Field label="堂会">
          <HallSelect
            value={form.hall_id}
            onChange={(id) => setForm({ ...form, hall_id: id })}
            allowAll
            allLabel="全堂 / 联合聚会"
          />
        </Field>
      </div>
      <div className="modal-actions">
        {onDelete && (
          <button
            className="btn ghost"
            style={{ color: 'var(--crit)', borderColor: 'var(--crit-soft)', marginRight: 'auto' }}
            onClick={onDelete}
          >
            删除聚会
          </button>
        )}
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </Modal>
  );
}
