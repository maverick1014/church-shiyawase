'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe, useHallScope } from '@/components/AppShell';
import { ErrorBanner, Field, HallSelect, Loading, Modal, SortTh, TagsInput, useToast } from '@/components/ui';
import { can } from '@/lib/perms';
import { GroupRow, MemberRow } from '@/lib/types';
import {
  GROUP_HEALTH_LABELS,
  groupHealthClass,
  groupHealthStatus,
  meetingScheduleZh,
  WEEKDAY_LABELS,
  WEEKDAY_OPTIONS,
} from '@/lib/labels';
import { GroupPosition, Weekday } from '@tog/shared';

export default function GroupsPage() {
  const router = useRouter();
  const toast = useToast();
  const perms = can(useMe().role);
  // Only worth a column when the account can actually see more than one hall.
  const { locked: hallLocked } = useHallScope();
  const groups = useFetch<GroupRow[]>('/groups');
  const members = useFetch<MemberRow[]>('/members');
  const [addOpen, setAddOpen] = useState(false);
  const [q, setQ] = useState('');
  const [tagFilter, setTagFilter] = useState('all');
  const [weekdayFilter, setWeekdayFilter] = useState<Weekday | 'all'>('all');

  usePageChrome(
    {
      title: '小组管理',
      subtitle: '全部小组一览 · 点击查看详情',
      action: perms.write ? (
        <button className="btn" onClick={() => setAddOpen(true)}>
          ＋ 新增小组
        </button>
      ) : undefined,
    },
    [perms.write],
  );

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
        schedule: meetingScheduleZh(g),
        leaderName: leader?.full_name ?? null,
        memberCount: inGroup.length,
        newMemberCount,
        status: groupHealthStatus(inGroup.length, newMemberCount),
      };
    });
  }, [groups.data, members.data]);

  // Distinct tags across every group, for both the filter dropdown and the
  // "＋ 新增小组" tag-suggestion autocomplete.
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
          return g.hallName ?? undefined;
        case 'status':
          return (['splittable', 'need_members', 'balanced'] as const).indexOf(g.status);
        default:
          return g.name;
      }
    },
    { key: 'name', dir: 'asc' },
  );

  if (groups.initialLoading) return <Loading />;

  return (
    <>
      <ErrorBanner message={groups.error || members.error} />

      <div className="flex gap-8 flex-wrap mb-16">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="🔍 搜索小组 / 组长…"
          style={{ maxWidth: 240, flex: 1, minWidth: 140 }}
        />
        <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="all">全部标签</option>
          {allTags.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          value={weekdayFilter}
          onChange={(e) => setWeekdayFilter(e.target.value as Weekday | 'all')}
          style={{ maxWidth: 140 }}
        >
          <option value="all">全部星期</option>
          {WEEKDAY_OPTIONS.map((d) => (
            <option key={d} value={d}>{WEEKDAY_LABELS[d]}</option>
          ))}
        </select>
      </div>

      {/* Desktop — table */}
      <div className="card only-desktop" style={{ padding: 6 }}>
        <div className="table-wrap">
          <table className="table-fixed">
            <thead>
              <tr>
                {/* 小组名称 / 组长 / 聚会时间地点 share the width equally;
                    组员人数 / 新成员 / 状态 stay narrow utility columns. */}
                <SortTh sortKey="name" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>小组名称</SortTh>
                {!hallLocked && (
                  <SortTh sortKey="hall" activeKey={sortKey} dir={sortDir} onSort={toggleSort} style={{ width: 96 }}>堂会</SortTh>
                )}
                <SortTh sortKey="leader" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>组长</SortTh>
                <SortTh sortKey="count" activeKey={sortKey} dir={sortDir} onSort={toggleSort} style={{ width: 88 }}>组员人数</SortTh>
                <SortTh sortKey="new" activeKey={sortKey} dir={sortDir} onSort={toggleSort} style={{ width: 82 }}>新成员</SortTh>
                <SortTh sortKey="status" activeKey={sortKey} dir={sortDir} onSort={toggleSort} style={{ width: 92 }}>状态</SortTh>
                <th>聚会时间 / 地点</th>
                <th style={{ width: 52 }} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((g) => (
                <tr key={g.id}>
                  <td>
                    <strong>{g.name}</strong>
                    {g.tags.length > 0 && (
                      <div className="flex gap-4 flex-wrap" style={{ marginTop: 4 }}>
                        {g.tags.map((t) => (
                          <span key={t} className="chip on" style={{ padding: '2px 8px', fontSize: 11, cursor: 'default' }}>
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  {!hallLocked && <td className="muted">{g.hallName ?? '—'}</td>}
                  <td>
                    {g.leaderName ? <strong>{g.leaderName}</strong> : <span className="faint">空缺</span>}
                  </td>
                  <td className="muted tnum">{g.memberCount}</td>
                  <td className="muted tnum">{g.newMemberCount}</td>
                  <td>
                    <span className={`badge ${groupHealthClass(g.status)}`}>{GROUP_HEALTH_LABELS[g.status]}</span>
                  </td>
                  <td className="muted">{g.schedule || '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="icon-btn" title="查看详情" onClick={() => router.push(`/groups/${g.id}`)}>›</button>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={hallLocked ? 7 : 8} className="faint" style={{ textAlign: 'center', padding: 28 }}>
                    {q.trim() || tagFilter !== 'all' || weekdayFilter !== 'all'
                      ? '没有符合条件的小组。'
                      : '尚无小组，点右上角「＋ 新增小组」创建。'}
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
                <span className="muted" style={{ fontSize: 12.5 }}> · 组长 {g.leaderName ?? '空缺'}</span>
              </div>
              <span className="mtile-cta">详情 →</span>
            </div>
            <div className="mtile-line flex items-center gap-8 flex-wrap">
              <span>{g.memberCount} 位组员（新成员 {g.newMemberCount}）{g.schedule ? ` · ${g.schedule}` : ''}</span>
              <span className={`badge ${groupHealthClass(g.status)}`}>{GROUP_HEALTH_LABELS[g.status]}</span>
            </div>
            {g.tags.length > 0 && (
              <div className="flex gap-4 flex-wrap" style={{ marginTop: 6 }}>
                {g.tags.map((t) => (
                  <span key={t} className="chip on" style={{ padding: '2px 8px', fontSize: 11, cursor: 'default' }}>
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {sorted.length === 0 && (
          <div className="faint" style={{ textAlign: 'center', padding: 28 }}>
            {q.trim() || tagFilter !== 'all' || weekdayFilter !== 'all'
              ? '没有符合条件的小组。'
              : '尚无小组，点右上角「＋ 新增小组」创建。'}
          </div>
        )}
      </div>

      {addOpen && (
        <AddGroupModal
          allTags={allTags}
          onClose={() => setAddOpen(false)}
          onSaved={(id) => {
            setAddOpen(false);
            groups.reload();
            toast('已新增小组');
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
      setErr('请填写小组名称');
      return;
    }
    if (!effectiveHallId) {
      setErr('请选择堂会');
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
    <Modal title="新增小组" onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <div className="form-row">
        <Field label="小组名称">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：迦南小组" />
        </Field>
        <Field label="堂会">
          <HallSelect value={effectiveHallId} onChange={setHall} />
        </Field>
      </div>
      <Field label="简介">
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="新家庭小组" />
      </Field>
      <div className="form-row">
        <Field label="聚会日">
          <select value={meetingDay} onChange={(e) => setMeetingDay(e.target.value as Weekday | '')}>
            <option value="">未定</option>
            {WEEKDAY_OPTIONS.map((d) => (
              <option key={d} value={d}>{WEEKDAY_LABELS[d]}</option>
            ))}
          </select>
        </Field>
        <Field label="聚会时间">
          <input type="time" className={meetingTime ? undefined : 'date-empty'} value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} />
        </Field>
      </div>
      <Field label="地点">
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Emily家" />
      </Field>
      <Field label="标签">
        <TagsInput value={tags} onChange={setTags} suggestions={allTags} placeholder="例如：职青、晚上…" />
      </Field>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </Modal>
  );
}
