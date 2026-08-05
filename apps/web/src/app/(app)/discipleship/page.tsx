'use client';

import { useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import { ErrorBanner, Field, Loading, Modal, SortTh, useConfirm, useToast } from '@/components/ui';
import { PairProgressModal } from '@/components/PairProgressModal';
import { can } from '@/lib/perms';
import { MemberRow, OverviewRow, PairRow, ProgramRow } from '@/lib/types';
import {
  memberRoleZh,
  PAIR_STATUS_LABELS,
  pairStatusClass,
  roleDot,
  roleTagStyle,
} from '@/lib/labels';
import { PairStatus } from '@tog/shared';

type Filter = 'active' | 'done' | 'pending';

interface Node {
  pair: PairRow;
  ov?: OverviewRow;
  depth: number;
  pct: number;
  days: number;
  total: number;
}

export default function DiscipleshipPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const perms = can(useMe().role);
  const programs = useFetch<ProgramRow[]>('/discipleship/programs');
  const programId = programs.data?.[0]?.id;
  const pairs = useFetch<PairRow[]>('/discipleship/pairs');
  const overview = useFetch<OverviewRow[]>(
    programId ? `/discipleship/programs/${programId}/overview` : null,
  );
  const members = useFetch<MemberRow[]>('/members');

  const [filter, setFilter] = useState<Filter>('active');
  const [popup, setPopup] = useState<Node | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  usePageChrome(
    {
      title: '四十天守望',
      subtitle: '四十天一对一守望 · 世代培育 · 牧者实时总览',
      action: perms.write ? (
        <button className="btn" onClick={() => setAddOpen(true)} disabled={!programId}>
          ＋ 新增配对
        </button>
      ) : undefined,
    },
    [perms.write, programId],
  );

  const delPair = async (n: Node) => {
    const ok = await confirm({
      title: '删除配对',
      message: `删除 ${n.pair.trainee?.full_name} ← ${n.pair.mentor?.full_name} 的配对？其守望进度记录将一并移除。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/discipleship/pairs/${n.pair.id}`);
      pairs.reload();
      overview.reload();
      toast('已删除配对');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const ovByPair = useMemo(() => {
    const m = new Map<string, OverviewRow>();
    (overview.data ?? []).forEach((o) => m.set(o.pair_id, o));
    return m;
  }, [overview.data]);

  const nodes = useMemo<Node[]>(() => {
    const list = pairs.data ?? [];
    const byId = new Map(list.map((p) => [p.id, p]));
    const depthOf = (p: PairRow): number => {
      let d = 0;
      let cur: PairRow | undefined = p;
      const seen = new Set<string>();
      while (cur?.parent_pair_id && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.parent_pair_id);
        d++;
        if (d > 20) break;
      }
      return d;
    };
    return list.map((p) => {
      const ov = ovByPair.get(p.id);
      const total = ov?.total_days ?? 40;
      const days = ov?.days_completed ?? 0;
      return { pair: p, ov, depth: depthOf(p), pct: Number(ov?.percent_complete ?? 0), days, total };
    });
  }, [pairs.data, ovByPair]);

  const classify = (n: Node): Filter =>
    n.pct >= 100 ? 'done' : n.days > 0 ? 'active' : 'pending';

  const counts = {
    active: nodes.filter((n) => classify(n) === 'active').length,
    done: nodes.filter((n) => classify(n) === 'done').length,
    pending: nodes.filter((n) => classify(n) === 'pending').length,
  };

  const forest = useMemo(() => buildForest(nodes), [nodes]);
  const doneList = nodes.filter((n) => classify(n) === 'done');
  const pendingList = nodes.filter((n) => classify(n) === 'pending');

  const { sorted: sortedNodes, sortKey: nodeSortKey, sortDir: nodeSortDir, toggleSort: toggleNodeSort } =
    useSortableRows(
      nodes,
      (n, key) => {
        switch (key) {
          case 'pct':
            return n.pct;
          case 'status':
            return PAIR_STATUS_LABELS[n.pair.status] ?? n.pair.status;
          default:
            return n.pair.trainee?.full_name;
        }
      },
      { key: 'name', dir: 'asc' },
    );

  const renderForest = (full = false) => (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        marginTop: 16,
        ...(full ? { flex: 1, minHeight: 0 } : {}),
      }}
    >
      {forest.map((tree, ti) => (
        <div
          key={ti}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 12,
            background: 'var(--surface-2)',
            padding: '12px 14px',
            ...(full ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : {}),
          }}
        >
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            <strong className="serif" style={{ fontSize: 14, color: 'var(--ink)' }}>{tree.rootName}</strong>
            {' · '}{tree.rootRole} · 起点
          </div>
          <div className="table-wrap" style={full ? { flex: 1, overflow: 'auto' } : undefined}>
            <div style={{ position: 'relative', width: tree.width, height: tree.height, minWidth: '100%' }}>
              <svg width={tree.width} height={tree.height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
                <path d={tree.path} fill="none" stroke="var(--border)" strokeWidth={1.5} />
              </svg>
              {tree.nodes.map((tn) => (
                <div
                  key={tn.id}
                  onClick={tn.node ? () => setPopup(tn.node!) : undefined}
                  style={{
                    position: 'absolute',
                    left: tn.left,
                    top: tn.top,
                    width: NODEW,
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    background: 'var(--surface)',
                    padding: '9px 12px',
                    cursor: tn.node ? 'pointer' : 'default',
                    boxShadow: 'var(--shadow)',
                  }}
                >
                  <div className="flex-between gap-6">
                    <strong className="serif" style={{ fontSize: 13.5 }}>{tn.name}</strong>
                    <span className="dot" style={{ background: roleDot(tn.role) }} />
                  </div>
                  <span className="badge" style={{ ...roleTagStyle(tn.role), fontSize: 10.5, marginTop: 3 }}>{tn.role}</span>
                  {tn.node ? (
                    <div className="flex items-center gap-6" style={{ marginTop: 7 }}>
                      <div className="bar thin"><span style={{ width: `${tn.node.pct}%` }} /></div>
                      <span className="faint" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>{tn.node.days}/{tn.node.total}</span>
                    </div>
                  ) : (
                    <div className="faint" style={{ fontSize: 10, marginTop: 7 }}>牧者 · 起点</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  if (pairs.initialLoading || programs.initialLoading) return <Loading />;

  if (!programId) {
    return <div className="empty">尚未建立守望计划。请先在数据库中创建 discipleship_programs 记录。</div>;
  }

  return (
    <>
      <ErrorBanner message={pairs.error || overview.error} />

      <div className="hint mb-16">
        ✝ <strong>四十天一对一守望</strong>：牧者先带领小组长，小组长再带领副组长，被带领过的人接续带下一位，直到人人都走过这段旅程。带领者每日填表更新，牧者可<strong>实时掌握全局</strong>。
      </div>

      {/* Cascade / relay chart */}
      <div className="card">
        <div className="card-head">
          <div>
            <h3>培育链 · 接棒图</h3>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>世代培育树 · 出师者自成起点 · <strong style={{ color: 'var(--ink)' }}>点标签筛选状态</strong></div>
          </div>
          <div className="flex gap-6 flex-wrap">
            {(['active', 'done', 'pending'] as Filter[]).map((f) => (
              <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
                {f === 'active' ? '在训' : f === 'done' ? '已出师' : '待开始'} {counts[f]}
              </button>
            ))}
            {filter === 'active' && forest.length > 0 && (
              <button className="chip" onClick={() => setFullscreen(true)} title="全屏查看">
                ⛶ 全屏
              </button>
            )}
          </div>
        </div>

        {filter === 'active' &&
          (forest.length === 0 ? (
            <div className="empty">目前没有进行中的配对。点右上角「＋ 新增配对」开始接棒。</div>
          ) : (
            <>
              <div className="only-mobile faint" style={{ fontSize: 11.5, marginTop: 10 }}>
                👉 图表可左右滑动查看 · 或点「⛶ 全屏」
              </div>
              {renderForest(false)}
            </>
          ))}

        {filter === 'done' && <DiscList list={doneList} kind="done" onOpen={setPopup} />}
        {filter === 'pending' && <DiscList list={pendingList} kind="pending" onOpen={setPopup} />}
      </div>

      {/* Pastor overview */}
      <div className="card mt-16">
        <div className="card-head">
          <div>
            <h3>牧者总览</h3>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>点「进度」查看 40 天详情与链接 · 点「表单」直接打开填写页</div>
          </div>
          <span className="badge b-good">● 实时</span>
        </div>
        {/* Desktop — table */}
        <div className="table-wrap only-desktop">
          <table>
            <thead>
              <tr>
                <SortTh sortKey="name" activeKey={nodeSortKey} dir={nodeSortDir} onSort={toggleNodeSort}>配对（被带领 ← 带领）</SortTh>
                <SortTh sortKey="pct" activeKey={nodeSortKey} dir={nodeSortDir} onSort={toggleNodeSort} style={{ width: 200 }}>进度</SortTh>
                <SortTh sortKey="status" activeKey={nodeSortKey} dir={nodeSortDir} onSort={toggleNodeSort}>状态</SortTh>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedNodes.map((n) => (
                <tr key={n.pair.id}>
                  <td>
                    <strong>{n.pair.trainee?.full_name}</strong>
                    <span className="faint"> ← {n.pair.mentor?.full_name}</span>
                  </td>
                  <td>
                    <div className="progress-row">
                      <div className="bar"><span style={{ width: `${n.pct}%` }} /></div>
                      <span className="pct">{n.days}/{n.total}</span>
                    </div>
                  </td>
                  <td><span className={`badge ${pairStatusClass(n.pair.status)}`}>{PAIR_STATUS_LABELS[n.pair.status] ?? n.pair.status}</span></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn ghost sm" style={{ marginRight: 6 }} onClick={() => setPopup(n)}>进度</button>
                    <button className="btn ghost sm" style={{ color: 'var(--brand)', marginRight: 6 }} onClick={() => window.open(`/d/${n.pair.form_token}`, '_blank')}>🔗 表单</button>
                    {perms.delete && (
                      <button className="btn danger sm" onClick={() => delPair(n)}>删除</button>
                    )}
                  </td>
                </tr>
              ))}
              {sortedNodes.length === 0 && (
                <tr><td colSpan={4} className="empty-inline">尚无配对。</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile — list tiles: 被带领 ← 带领 + 表单, then progress · status */}
        <div className="only-mobile" style={{ marginTop: 4 }}>
          {sortedNodes.map((n) => (
            <div key={n.pair.id} className="mtile" onClick={() => setPopup(n)}>
              <div className="mtile-row1">
                <div style={{ minWidth: 0 }}>
                  <strong>{n.pair.trainee?.full_name}</strong>
                  <span className="faint"> ← {n.pair.mentor?.full_name}</span>
                </div>
                <div className="flex gap-10" style={{ flexShrink: 0 }}>
                  <button
                    className="tile-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      window.open(`/d/${n.pair.form_token}`, '_blank');
                    }}
                  >
                    🔗 表单
                  </button>
                  {perms.delete && (
                    <button
                      className="tile-action crit"
                      onClick={(e) => {
                        e.stopPropagation();
                        delPair(n);
                      }}
                    >
                      删除
                    </button>
                  )}
                </div>
              </div>
              <div className="mtile-line" style={{ marginTop: 9 }}>
                <div className="bar" style={{ flex: 1 }}><span style={{ width: `${n.pct}%` }} /></div>
                <span className="pct" style={{ whiteSpace: 'nowrap' }}>{n.days}/{n.total}</span>
                <span className={`badge ${pairStatusClass(n.pair.status)}`}>{PAIR_STATUS_LABELS[n.pair.status] ?? n.pair.status}</span>
              </div>
            </div>
          ))}
          {sortedNodes.length === 0 && (
            <div className="empty-inline">尚无配对。</div>
          )}
        </div>
      </div>

      {popup && (
        <PairProgressModal pairId={popup.pair.id} onClose={() => setPopup(null)} />
      )}

      {fullscreen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 90,
            background: 'var(--paper)',
            display: 'flex',
            flexDirection: 'column',
            padding: '18px 22px 22px',
          }}
        >
          <div className="flex-between" style={{ paddingBottom: 12 }}>
            <div>
              <h3 className="serif" style={{ margin: 0, fontSize: 18 }}>培育链 · 接棒图</h3>
              <div className="muted" style={{ fontSize: 12 }}>世代培育树 · 全屏查看</div>
            </div>
            <button className="icon-btn" onClick={() => setFullscreen(false)} title="退出全屏">✕</button>
          </div>
          {renderForest(true)}
        </div>
      )}

      {addOpen && programId && (
        <AddPairModal
          programId={programId}
          totalDays={programs.data?.[0]?.total_days ?? 40}
          members={members.data ?? []}
          existing={pairs.data ?? []}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            pairs.reload();
            overview.reload();
            toast('已新增配对');
          }}
        />
      )}
    </>
  );
}

/* ---- Cascade forest (generational tree with SVG connectors) ------------- */
interface TreeNode {
  id: string;
  name: string;
  role: string;
  isRoot: boolean;
  node?: Node;
  left: number;
  top: number;
}
interface Tree {
  rootName: string;
  rootRole: string;
  width: number;
  height: number;
  nodes: TreeNode[];
  path: string;
}

const NODEW = 160;
const NODEH = 80;
const GAPX = 96;
const ROWH = 128;

function buildForest(nodes: Node[]): Tree[] {
  const kids = new Map<string, { id: string; node: Node }[]>();
  const info = new Map<string, { name: string; role: string }>();
  const asTrainee = new Set<string>();
  for (const n of nodes) {
    const m = n.pair.mentor;
    const t = n.pair.trainee;
    if (!m || !t) continue;
    info.set(m.id, { name: m.full_name, role: memberRoleZh(m) });
    info.set(t.id, { name: t.full_name, role: memberRoleZh(t) });
    const arr = kids.get(m.id) ?? [];
    arr.push({ id: t.id, node: n });
    kids.set(m.id, arr);
    asTrainee.add(t.id);
  }
  const nodeByTrainee = new Map<string, Node>();
  for (const arr of kids.values()) for (const c of arr) nodeByTrainee.set(c.id, c.node);
  const roots = [...kids.keys()].filter((id) => !asTrainee.has(id));

  const trees: Tree[] = [];
  for (const rootId of roots) {
    const pos = new Map<string, { col: number; row: number }>();
    let rowc = 0;
    let maxCol = 0;
    const layout = (id: string, depth: number, seen: Set<string>): number => {
      if (seen.has(id)) return rowc++;
      seen.add(id);
      maxCol = Math.max(maxCol, depth);
      const ch = kids.get(id) ?? [];
      let row: number;
      if (!ch.length) row = rowc++;
      else {
        const rs = ch.map((c) => layout(c.id, depth + 1, seen));
        row = (rs[0] + rs[rs.length - 1]) / 2;
      }
      pos.set(id, { col: depth, row });
      return row;
    };
    layout(rootId, 0, new Set());

    const maxRow = Math.max(0, ...[...pos.values()].map((p) => p.row));
    const width = (maxCol + 1) * NODEW + maxCol * GAPX;
    const height = maxRow * ROWH + NODEH;
    const treeNodes: TreeNode[] = [...pos.entries()].map(([id, p]) => ({
      id,
      name: info.get(id)?.name ?? '',
      role: info.get(id)?.role ?? '未分组',
      isRoot: id === rootId,
      node: nodeByTrainee.get(id),
      left: p.col * (NODEW + GAPX),
      top: p.row * ROWH,
    }));

    let path = '';
    for (const [pid, arr] of kids.entries()) {
      const pp = pos.get(pid);
      if (!pp) continue;
      for (const c of arr) {
        const cp = pos.get(c.id);
        if (!cp) continue;
        const sx = pp.col * (NODEW + GAPX) + NODEW;
        const sy = pp.row * ROWH + NODEH / 2;
        const ex = cp.col * (NODEW + GAPX);
        const ey = cp.row * ROWH + NODEH / 2;
        const mx = (sx + ex) / 2;
        path += `M${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey} `;
      }
    }
    trees.push({
      rootName: info.get(rootId)?.name ?? '',
      rootRole: info.get(rootId)?.role ?? '',
      width,
      height,
      nodes: treeNodes,
      path,
    });
  }
  return trees;
}

function DiscList({
  list,
  kind,
  onOpen,
}: {
  list: Node[];
  kind: 'done' | 'pending';
  onOpen: (n: Node) => void;
}) {
  if (list.length === 0) {
    return (
      <div className="empty" style={{ marginTop: 16 }}>
        {kind === 'done' ? '尚无出师者。' : '没有待开始的配对。'}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 16 }}>
      {list.map((n) => {
        const role = n.pair.trainee ? memberRoleZh(n.pair.trainee) : '未分组';
        return (
          <div
            key={n.pair.id}
            onClick={() => onOpen(n)}
            className="flex items-center gap-12"
            style={{ padding: '11px 4px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
          >
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="flex items-center gap-8 flex-wrap">
                <strong style={{ fontSize: 13.5 }}>{n.pair.trainee?.full_name}</strong>
                <span className="badge" style={{ ...roleTagStyle(role), fontSize: 10.5 }}>{role}</span>
              </div>
              <div className="faint" style={{ fontSize: 11.5, marginTop: 1 }}>
                {kind === 'done'
                  ? `曾由 ${n.pair.mentor?.full_name} 带领`
                  : `由 ${n.pair.mentor?.full_name} 带领 · 尚未开始`}
              </div>
            </div>
            <span
              className="badge"
              style={
                kind === 'done'
                  ? { background: 'var(--good-soft)', color: 'var(--good)' }
                  : { background: 'var(--surface-2)', color: 'var(--faint)', border: '1px solid var(--border)' }
              }
            >
              {kind === 'done' ? `已出师 ${n.days}/${n.total}` : `待开始 ${n.days}/${n.total}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function AddPairModal({
  programId,
  totalDays,
  members,
  existing,
  onClose,
  onSaved,
}: {
  programId: string;
  totalDays: number;
  members: MemberRow[];
  existing: PairRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [mentorId, setMentorId] = useState('');
  const [traineeId, setTraineeId] = useState('');
  const [backfillDays, setBackfillDays] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const takenTrainees = new Set(existing.map((p) => p.trainee_id));

  const save = async () => {
    if (!mentorId || !traineeId) {
      setErr('请选择带领者与被带领者');
      return;
    }
    if (mentorId === traineeId) {
      setErr('带领者与被带领者不能是同一人');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      // Link into the cascade: the mentor's own pair (as trainee) becomes parent.
      const parent = existing.find((p) => p.trainee_id === mentorId);
      await api.post('/discipleship/pairs', {
        program_id: programId,
        mentor_id: mentorId,
        trainee_id: traineeId,
        parent_pair_id: parent?.id,
        backfill_days: backfillDays ? Number(backfillDays) : undefined,
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
    <Modal title="新增守望配对" onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <p className="muted" style={{ margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.6 }}>
        建立一个新的四十天守望配对。选择<strong style={{ color: 'var(--ink)' }}>带领者</strong>与<strong style={{ color: 'var(--ink)' }}>被带领者</strong>，系统会依带领者已有的配对自动接入接棒图。
      </p>
      <Field label="带领者">
        <select value={mentorId} onChange={(e) => setMentorId(e.target.value)}>
          <option value="">选择成员…</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>{m.full_name}（{memberRoleZh(m)}）</option>
          ))}
        </select>
      </Field>
      <div style={{ textAlign: 'center', color: 'var(--accent)', fontSize: 16, fontWeight: 700, margin: '-2px 0 8px' }}>↓</div>
      <Field label="被带领者（已在配对中的不显示）">
        <select value={traineeId} onChange={(e) => setTraineeId(e.target.value)}>
          <option value="">选择成员…</option>
          {members
            .filter((m) => !takenTrainees.has(m.id) && m.id !== mentorId)
            .map((m) => (
              <option key={m.id} value={m.id}>{m.full_name}（{memberRoleZh(m)}）</option>
            ))}
        </select>
      </Field>
      <Field label={`已完成天数（选填 — 若线下已守望至第几天，直接从该天承接进度，最多 ${totalDays} 天）`}>
        <input
          type="number"
          min={0}
          max={totalDays}
          value={backfillDays}
          onChange={(e) => setBackfillDays(e.target.value)}
          placeholder="0"
        />
      </Field>
      <div className="hint" style={{ marginBottom: 6 }}>
        {backfillDays && Number(backfillDays) > 0
          ? `🕊 新配对建立时会将第 1 至第 ${Math.min(Number(backfillDays), totalDays)} 天标记为已完成，之后从第 ${Math.min(Number(backfillDays), totalDays) + 1} 天继续填写。`
          : `🕊 新配对从第 1 天开始（进度 0 / ${totalDays}）。开始填写后即出现在接棒图中。`}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? '保存中…' : '建立配对'}</button>
      </div>
    </Modal>
  );
}
