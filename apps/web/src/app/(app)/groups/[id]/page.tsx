'use client';

import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import { ErrorBanner, ExportButton, Field, HallSelect, Loading, RoleBadge, SortTh, TagsInput, useConfirm, useToast } from '@/components/ui';
import { can } from '@/lib/perms';
import { exportMatrix } from '@/lib/export';
import { GroupAttendanceResponse, GroupDetail, GroupRow, MemberRow } from '@/lib/types';
import {
  ATTENDANCE_LABELS,
  GROUP_POSITION_OPTIONS,
  roleDot,
  roleTagStyle,
  positionZh,
  WEEKDAY_LABELS,
  WEEKDAY_OPTIONS,
} from '@/lib/labels';
import { AttendanceStatus, GroupPosition, LEADERSHIP_POSITIONS, Weekday } from '@tog/shared';

export default function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const perms = can(useMe().role);

  const detail = useFetch<GroupDetail>(`/groups/${id}`);
  const members = useFetch<MemberRow[]>('/members');
  const allGroups = useFetch<GroupRow[]>('/groups');

  usePageChrome({ title: '小组详情', subtitle: '小组资料 · 带领团队 · 组员名单 · 每周出席' }, [id]);

  const refreshAll = () => {
    detail.reload();
    members.reload();
  };

  // Distinct tags across every group, for the tag-input autocomplete.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    (allGroups.data ?? []).forEach((g) => (g.tags ?? []).forEach((t) => set.add(t)));
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
  }, [allGroups.data]);

  if (detail.initialLoading) return <Loading />;
  if (detail.error || !detail.data) return <ErrorBanner message={detail.error ?? '找不到小组'} />;

  return (
    <>
      <button className="back-btn" onClick={() => router.push('/groups')}>
        ‹ 返回小组列表
      </button>

      <GroupPanel
        group={detail.data}
        allMembers={members.data ?? []}
        allTags={allTags}
        onChanged={refreshAll}
        onDeleted={() => {
          toast('已删除小组');
          router.push('/groups');
        }}
      />
    </>
  );
}

function GroupPanel({
  group,
  allMembers,
  allTags,
  onChanged,
  onDeleted,
}: {
  group: GroupDetail;
  allMembers: MemberRow[];
  allTags: string[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const perms = can(useMe().role);
  const [name, setName] = useState(group.name);
  const [desc, setDesc] = useState(group.description ?? '');
  const [meetingDay, setMeetingDay] = useState<Weekday | ''>(group.meeting_day ?? '');
  const [meetingTime, setMeetingTime] = useState(group.meeting_time?.slice(0, 5) ?? '');
  const [location, setLocation] = useState(group.location ?? '');
  const [tags, setTags] = useState<string[]>(group.tags ?? []);
  const [hall, setHall] = useState<string | null>(group.hall_id ?? null);
  const [addSel, setAddSel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const groupMembers = group.members;

  const leadFilled = LEADERSHIP_POSITIONS.filter((p) =>
    groupMembers.some((m) => m.group_position === p),
  ).length;

  const unassigned = useMemo(
    () => allMembers.filter((m) => m.group_id !== group.id),
    [allMembers, group.id],
  );

  // "大到小" — leadership ranks first, matching GROUP_POSITION_OPTIONS' own
  // promotion order (leader ... new member).
  const positionRank = (pos: GroupPosition | null) =>
    (GROUP_POSITION_OPTIONS as readonly GroupPosition[]).indexOf(pos ?? GroupPosition.NewMember);

  const { sorted: sortedGroupMembers, sortKey: memberSortKey, sortDir: memberSortDir, toggleSort: toggleMemberSort } =
    useSortableRows(
      groupMembers,
      (m, key) => (key === 'name' ? m.full_name : positionRank(m.group_position)),
      { key: 'position', dir: 'asc' },
    );

  const saveGroup = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/groups/${group.id}`, {
        name,
        description: desc || null,
        meeting_day: meetingDay || null,
        meeting_time: meetingTime || null,
        location: location || null,
        tags,
        hall_id: hall,
      });
      toast('已保存设定');
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const deleteGroup = async () => {
    const ok = await confirm({
      title: '删除小组',
      message: `删除「${group.name}」？组员将变为未分组。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/groups/${group.id}`);
      onDeleted();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    }
  };

  const addMember = async () => {
    if (!addSel) return;
    try {
      await api.patch(`/members/${addSel}`, {
        group_id: group.id,
        group_position: GroupPosition.NewMember,
      });
      setAddSel('');
      toast('已加入本组');
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    }
  };

  const removeMember = async (memberId: string) => {
    const name = groupMembers.find((m) => m.id === memberId)?.full_name ?? '该成员';
    const ok = await confirm({
      title: '移出小组',
      message: `将 ${name} 移出本组？其身份与在组职位会一并清除。`,
      confirmText: '移出',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.patch(`/members/${memberId}`, { group_id: null, group_position: null });
      toast('已移出本组');
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    }
  };

  // The only place a member's identity is assigned from this page: picking who
  // holds each of the 3 leadership slots. Everything else (核心成员/普通成员/新
  // 成员) is set on the member's own profile page instead — keeps this page simple.
  const assignLeadership = async (pos: GroupPosition, memberId: string) => {
    setErr(null);
    try {
      const incumbent = groupMembers.find((m) => m.group_position === pos);
      if (incumbent && incumbent.id !== memberId) {
        await api.patch(`/members/${incumbent.id}`, { group_position: GroupPosition.CoreMember });
      }
      if (memberId) {
        await api.patch(`/members/${memberId}`, { group_position: pos });
      }
      toast('已更新带领团队');
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    }
  };

  const renderTriNode = (pos: GroupPosition, style: React.CSSProperties) => {
    const holder = groupMembers.find((m) => m.group_position === pos);
    const roleZh = positionZh(pos);
    return (
      <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, background: 'var(--surface)', padding: '3px 8px', borderRadius: 8, ...style }}>
        <span
          className={`badge ${holder ? '' : 'b-gray'}`}
          style={holder ? { ...roleTagStyle(roleZh), fontWeight: 700 } : { fontWeight: 700 }}
        >
          {holder && <i className="dot" style={{ background: roleDot(roleZh) }} />}
          {roleZh}
        </span>
        {perms.write ? (
          <select
            className="sm"
            value={holder?.id ?? ''}
            onChange={(e) => assignLeadership(pos, e.target.value)}
            style={{ maxWidth: 132, textAlign: 'center' }}
          >
            <option value="">空缺</option>
            {groupMembers.map((m) => (
              <option key={m.id} value={m.id}>{m.full_name}</option>
            ))}
          </select>
        ) : (
          <strong style={{ fontSize: 13, color: holder ? 'var(--ink)' : 'var(--faint)' }}>
            {holder?.full_name ?? '空缺'}
          </strong>
        )}
      </div>
    );
  };

  return (
    <>
      {err && <ErrorBanner message={err} />}
      <div className="grid" style={{ gridTemplateColumns: '360px 1fr', gap: 16, alignItems: 'start' }} data-glayout>
        {/* Left — group info + 铁三角 */}
        <div className="card">
          <div className="card-head">
            <h3>小组资料 · 带领团队</h3>
          </div>
          <Field label="小组名称">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="堂会">
            <HallSelect value={hall} onChange={setHall} />
          </Field>
          <Field label="简介">
            <input value={desc} onChange={(e) => setDesc(e.target.value)} />
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
            <input value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
          <Field label="标签">
            <TagsInput value={tags} onChange={setTags} suggestions={allTags} placeholder="例如：职青、晚上…" />
          </Field>

          <div className="flex-between" style={{ margin: '16px 0 4px' }}>
            <div className="section-label">
              铁三角 <span style={{ fontWeight: 400, fontSize: 12 }} className="muted">· 带领团队</span>
            </div>
            <span className="faint" style={{ fontSize: 11.5 }}>{leadFilled} / 3 就位</span>
          </div>
          <div style={{ position: 'relative', height: 150, margin: '2px 0 4px' }}>
            <svg viewBox="0 0 300 150" preserveAspectRatio="none" width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
              <path d="M150 28 L54 122 L246 122 Z" fill="var(--brand)" fillOpacity="0.04" stroke="var(--border)" strokeWidth="1.5" strokeDasharray="5 5" />
            </svg>
            {renderTriNode(GroupPosition.Leader, { top: 8, left: '50%', transform: 'translateX(-50%)' })}
            {renderTriNode(GroupPosition.AssistantLeader, { bottom: 6, left: 0 })}
            {renderTriNode(GroupPosition.InternLeader, { bottom: 6, right: 0 })}
          </div>

          <div className="hint" style={{ margin: '12px 0 14px' }}>
            💡 在此指派组长 / 副组长 / 实习组长；指派新的领袖会自动将原领袖降为核心成员。
          </div>
          {perms.write && (
            <div className="flex gap-8">
              <button className="btn" onClick={saveGroup} disabled={busy}>保存设定</button>
              {perms.delete && <button className="btn ghost" onClick={deleteGroup}>删除小组</button>}
            </div>
          )}
        </div>

        {/* Right — member list */}
        <div className="card">
          <div className="card-head">
            <h3>组员名单 <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>（{groupMembers.length} 人）</span></h3>
          </div>
          {perms.write && (
            <div className="flex gap-8 mb-14">
              <select value={addSel} onChange={(e) => setAddSel(e.target.value)} style={{ flex: 1 }}>
                <option value="">选择成员加入本组…</option>
                {unassigned.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name}
                    {m.group ? `（${m.group.name}）` : ''}
                  </option>
                ))}
              </select>
              <button className="btn accent" onClick={addMember} disabled={!addSel}>＋ 添加成员</button>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh sortKey="name" activeKey={memberSortKey} dir={memberSortDir} onSort={toggleMemberSort}>姓名</SortTh>
                  <SortTh sortKey="position" activeKey={memberSortKey} dir={memberSortDir} onSort={toggleMemberSort}>身份</SortTh>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sortedGroupMembers.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.full_name}</strong>
                    </td>
                    <td>
                      <RoleBadge role={positionZh(m.group_position)} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {perms.write && (
                        <button className="btn ghost" onClick={() => removeMember(m.id)}>移除</button>
                      )}
                    </td>
                  </tr>
                ))}
                {sortedGroupMembers.length === 0 && (
                  <tr>
                    <td colSpan={3} className="empty-inline">
                      本组暂无成员，从上方选择加入。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <WeeklyAttendance groupId={group.id} />
    </>
  );
}

/** The Sundays of a given month — the fixed weeks for that year/month combo. */
function weeksOfMonth(year: number, month1to12: number) {
  const out: { no: number; date: string; day: number }[] = [];
  const d = new Date(year, month1to12 - 1, 1);
  while (d.getDay() !== 0) d.setDate(d.getDate() + 1); // first Sunday
  let n = 1;
  while (d.getMonth() === month1to12 - 1) {
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
    out.push({ no: n, date, day: d.getDate() });
    d.setDate(d.getDate() + 7);
    n++;
  }
  return out;
}

function WeeklyAttendance({ groupId }: { groupId: string }) {
  const toast = useToast();
  const perms = can(useMe().role);
  const { data, initialLoading, reload } = useFetch<GroupAttendanceResponse>(
    `/groups/${groupId}/attendance`,
  );

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  // Weeks are fixed by the year+month (each Sunday of that month) — not editable.
  const weeks = useMemo(() => weeksOfMonth(year, month), [year, month]);

  // Year options: this year, last year, plus any year that already has records.
  const years = useMemo(() => {
    const set = new Set<number>([now.getFullYear(), now.getFullYear() - 1]);
    (data?.meetings ?? []).forEach((m) => set.add(Number(m.meeting_date.slice(0, 4))));
    return [...set].filter((y) => y > 0).sort((a, b) => b - a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // date → meeting id, and member → (date → status), so a week column can look
  // up its cell regardless of which meetings currently exist.
  const meetingIdByDate = useMemo(() => {
    const m = new Map<string, string>();
    (data?.meetings ?? []).forEach((mt) => m.set(mt.meeting_date.slice(0, 10), mt.id));
    return m;
  }, [data]);

  const statusByMemberDate = useMemo(() => {
    const dateOf = new Map<string, string>();
    (data?.meetings ?? []).forEach((mt) => dateOf.set(mt.id, mt.meeting_date.slice(0, 10)));
    const map = new Map<string, Map<string, AttendanceStatus | null>>();
    (data?.rows ?? []).forEach((r) => {
      const inner = new Map<string, AttendanceStatus | null>();
      r.cells.forEach((c) => {
        const ds = dateOf.get(c.meeting_id);
        if (ds) inner.set(ds, c.status);
      });
      map.set(r.member.id, inner);
    });
    return map;
  }, [data]);

  const presentCount = (memberId: string) => {
    const inner = statusByMemberDate.get(memberId);
    return weeks.filter((w) => inner?.get(w.date) === AttendanceStatus.Present).length;
  };

  const { sorted: sortedAttendanceRows, sortKey: attSortKey, sortDir: attSortDir, toggleSort: toggleAttSort } =
    useSortableRows(
      data?.rows ?? [],
      (r, key) => (key === 'count' ? presentCount(r.member.id) : r.member.full_name),
      { key: 'name', dir: 'asc' },
    );

  const toggle = async (dateStr: string, memberId: string, present: boolean) => {
    const next = present ? AttendanceStatus.Absent : AttendanceStatus.Present;
    try {
      let mid = meetingIdByDate.get(dateStr);
      if (!mid) {
        // The week's meeting row is created lazily the first time it's marked.
        const meeting = await api.post<{ id: string }>(`/groups/${groupId}/meetings`, {
          meeting_date: dateStr,
        });
        mid = meeting.id;
      }
      await api.post(`/groups/meetings/${mid}/attendance`, {
        records: [{ member_id: memberId, status: next }],
      });
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const exportGrid = () => {
    if (!data) return;
    const headers = ['成员', ...weeks.map((w) => `第${w.no}周(${w.day}日)`), '出席次数'];
    const matrix = sortedAttendanceRows.map((r) => {
      const inner = statusByMemberDate.get(r.member.id);
      const cells = weeks.map((w) => {
        const s = inner?.get(w.date);
        return s ? ATTENDANCE_LABELS[s] : '';
      });
      return [r.member.full_name, ...cells, presentCount(r.member.id)];
    });
    exportMatrix(`小组每周出席_${year}年${month}月`, '出席', headers, matrix);
  };

  return (
    <div className="card mt-16">
      <div className="card-head">
        <div>
          <h3>每周出席</h3>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
            按年 / 月查看 · 每周固定为当月主日 · 勾选表示当周出席
          </div>
        </div>
        <ExportButton onClick={exportGrid} disabled={!data} title="导出每周出席" />
      </div>

      <div className="flex gap-8 mb-14 flex-wrap">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 'auto' }}>
          {years.map((y) => (
            <option key={y} value={y}>{y} 年</option>
          ))}
        </select>
        <select value={month} onChange={(e) => setMonth(Number(e.target.value))} style={{ width: 'auto' }}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((mo) => (
            <option key={mo} value={mo}>{mo} 月</option>
          ))}
        </select>
      </div>

      {initialLoading ? (
        <Loading />
      ) : !data || data.rows.length === 0 ? (
        <div className="empty">本组暂无成员。</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh sortKey="name" activeKey={attSortKey} dir={attSortDir} onSort={toggleAttSort}>成员</SortTh>
                {weeks.map((w) => (
                  <th key={w.date} style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                    第{w.no}周
                    <div className="faint" style={{ fontSize: 10.5, fontWeight: 400 }}>{w.day}日</div>
                  </th>
                ))}
                <SortTh sortKey="count" activeKey={attSortKey} dir={attSortDir} onSort={toggleAttSort} align="center">出席</SortTh>
              </tr>
            </thead>
            <tbody>
              {sortedAttendanceRows.map((r) => {
                const inner = statusByMemberDate.get(r.member.id);
                return (
                  <tr key={r.member.id}>
                    <td><strong>{r.member.full_name}</strong></td>
                    {weeks.map((w) => {
                      const present = inner?.get(w.date) === AttendanceStatus.Present;
                      return (
                        <td key={w.date} style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={present}
                            onChange={() => toggle(w.date, r.member.id, present)}
                            disabled={!perms.write}
                            style={{ width: 18, height: 18, cursor: perms.write ? 'pointer' : 'default', accentColor: 'var(--brand)' }}
                            title={present ? '出席' : '未出席'}
                          />
                        </td>
                      );
                    })}
                    <td style={{ textAlign: 'center', fontWeight: 600 }}>
                      {presentCount(r.member.id)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
