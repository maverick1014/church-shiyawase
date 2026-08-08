'use client';

import { useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import { ErrorBanner, ExportButton, Field, LinkIcon, Modal, PageBar, Skeleton, SkeletonScreen, SkeletonTable, SkeletonText, SortTh, useConfirm, useToast } from '@/components/ui';
import { PairProgressModal } from '@/components/PairProgressModal';
import { can } from '@/lib/perms';
import { exportRows } from '@/lib/export';
import { MemberRow, OverviewRow, PairRow, ProgramRow } from '@/lib/types';
import {
  memberRole,
  pairStatusClass,
  pairStatusKey,
  roleDot,
  roleKey,
  roleTagStyle,
} from '@/lib/labels';
import { useT, type Translate } from '@/lib/i18n';
import { DisplayRole } from '@tog/shared';

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
  const t = useT();
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

  usePageChrome({ title: t('disc.title') }, [t]);

  const delPair = async (n: Node): Promise<boolean> => {
    const ok = await confirm({
      title: t('disc.delete.title'),
      message: t('disc.delete.message', {
        trainee: n.pair.trainee?.full_name ?? '',
        mentor: n.pair.mentor?.full_name ?? '',
      }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return false;
    try {
      await api.delete(`/discipleship/pairs/${n.pair.id}`);
      pairs.reload();
      overview.reload();
      toast(t('disc.toast.deleted'));
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
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
            return t(pairStatusKey(n.pair.status));
          default:
            return n.pair.trainee?.full_name;
        }
      },
      { key: 'name', dir: 'asc' },
    );

  const exportPairs = () => {
    exportRows(
      t('disc.title'),
      t('disc.col.pair'),
      sortedNodes.map((n) => ({
        [t('export.trainee')]: n.pair.trainee?.full_name ?? '',
        [t('export.mentor')]: n.pair.mentor?.full_name ?? '',
        [t('export.days')]: `${n.days}/${n.total}`,
        [t('export.progress')]: `${n.pct}%`,
        [t('export.status')]: t(pairStatusKey(n.pair.status)),
      })),
    );
  };

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
            {' · '}
            {t('disc.rootLine', { role: t(roleKey(tree.rootRole)) })}
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
                  <span className="badge" style={{ ...roleTagStyle(tn.role), fontSize: 10.5, marginTop: 3 }}>
                    {t(roleKey(tn.role))}
                  </span>
                  {tn.node ? (
                    <div className="flex items-center gap-6" style={{ marginTop: 7 }}>
                      <div className="bar thin"><span style={{ width: `${tn.node.pct}%` }} /></div>
                      <span className="faint" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>{tn.node.days}/{tn.node.total}</span>
                    </div>
                  ) : (
                    <div className="faint" style={{ fontSize: 10, marginTop: 7 }}>{t('disc.rootNode')}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  // The chain and the pastor overview both hang off these two fetches; the
  // page's action row does not, so it renders straight away and only the two
  // sections below it are skeletons.
  const booting = pairs.initialLoading || programs.initialLoading;

  // A church with no 守望 program at all is a different state from a slow
  // fetch — decide it only once the programs have actually arrived.
  if (!booting && !programId) {
    return <div className="empty">{t('disc.noProgram')}</div>;
  }

  return (
    <>
      <ErrorBanner message={pairs.error || overview.error} />

      <PageBar
        actions={
          <>
            <ExportButton onClick={exportPairs} disabled={nodes.length === 0} />
            {perms.write && (
              <button className="btn" onClick={() => setAddOpen(true)} disabled={!programId}>
                {t('disc.add')}
              </button>
            )}
          </>
        }
      />

      {/* Cascade / relay chart */}
      <div className="section-label mb-14">
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--brand)', display: 'inline-block' }} />
        {t('disc.chain')}
      </div>
      <div className="card">
        <div className="card-head">
          <div className="flex gap-6 flex-wrap">
            {(['active', 'done', 'pending'] as Filter[]).map((f) => (
              <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
                {f === 'active'
                  ? t('disc.filter.active')
                  : f === 'done'
                    ? t('disc.filter.done')
                    : t('disc.filter.pending')}{' '}
                {counts[f]}
              </button>
            ))}
            {filter === 'active' && forest.length > 0 && (
              <button className="chip" onClick={() => setFullscreen(true)} title={t('disc.fullscreen')}>
                {t('disc.fullscreenChip')}
              </button>
            )}
          </div>
        </div>

        {booting ? (
          <SkeletonScreen>
            <div className="flex gap-10 flex-wrap" style={{ marginTop: 10 }}>
              {[132, 132, 132].map((w, i) => (
                <Skeleton key={i} width={w} height={62} radius={10} />
              ))}
            </div>
            <SkeletonText lines={2} style={{ marginTop: 14 }} />
          </SkeletonScreen>
        ) : (
          <>
            {filter === 'active' &&
              (forest.length === 0 ? (
                <div className="empty">{t('disc.emptyActive')}</div>
              ) : (
                <>
                  <div className="only-mobile faint" style={{ fontSize: 11.5, marginTop: 10 }}>
                    {t('disc.swipeHint')}
                  </div>
                  {renderForest(false)}
                </>
              ))}

            {filter === 'done' && <DiscList list={doneList} kind="done" onOpen={setPopup} t={t} />}
            {filter === 'pending' && <DiscList list={pendingList} kind="pending" onOpen={setPopup} t={t} />}
          </>
        )}
      </div>

      {/* Pastor overview */}
      <div className="section-label mb-14" style={{ marginTop: 28 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--good)', display: 'inline-block' }} />
        {t('disc.pastorOverview')}
      </div>
      {booting ? (
        // The skeleton brings its own card on desktop and its own tiles on a
        // phone, so it stands in for the whole panel rather than nesting a
        // second card inside this one.
        <SkeletonTable rows={5} columns={4} />
      ) : (
        <div className="card">
          {/* Desktop — table */}
          <div className="table-wrap only-desktop">
            <table>
              <thead>
                <tr>
                  <SortTh sortKey="name" activeKey={nodeSortKey} dir={nodeSortDir} onSort={toggleNodeSort}>{t('disc.col.pair')}</SortTh>
                  <SortTh sortKey="pct" activeKey={nodeSortKey} dir={nodeSortDir} onSort={toggleNodeSort} style={{ width: 200 }}>{t('disc.col.progress')}</SortTh>
                  <SortTh sortKey="status" activeKey={nodeSortKey} dir={nodeSortDir} onSort={toggleNodeSort}>{t('groups.col.status')}</SortTh>
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
                    <td><span className={`badge ${pairStatusClass(n.pair.status)}`}>{t(pairStatusKey(n.pair.status))}</span></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn ghost sm" style={{ marginRight: 6 }} onClick={() => setPopup(n)}>{t('disc.progressBtn')}</button>
                      <button className="btn ghost sm" style={{ color: 'var(--brand)' }} onClick={() => window.open(`/d/${n.pair.form_token}`, '_blank')}><LinkIcon size={14} />{t('disc.form')}</button>
                    </td>
                  </tr>
                ))}
                {sortedNodes.length === 0 && (
                  <tr><td colSpan={4} className="empty-inline">{t('disc.empty')}</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile — list tiles: trainee ← mentor + form, then progress · status */}
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
                      <LinkIcon size={14} />
                      {t('disc.form')}
                    </button>
                  </div>
                </div>
                <div className="mtile-line" style={{ marginTop: 9 }}>
                  <div className="bar" style={{ flex: 1 }}><span style={{ width: `${n.pct}%` }} /></div>
                  <span className="pct" style={{ whiteSpace: 'nowrap' }}>{n.days}/{n.total}</span>
                  <span className={`badge ${pairStatusClass(n.pair.status)}`}>{t(pairStatusKey(n.pair.status))}</span>
                </div>
              </div>
            ))}
            {sortedNodes.length === 0 && (
              <div className="empty-inline">{t('disc.empty')}</div>
            )}
          </div>
        </div>
      )}

      {popup && (
        <PairProgressModal
          pairId={popup.pair.id}
          onClose={() => setPopup(null)}
          onDelete={
            perms.delete
              ? async () => {
                  // Only close once the delete is confirmed — backing out of the
                  // confirmation must leave the dialog where it was.
                  if (await delPair(popup)) setPopup(null);
                }
              : undefined
          }
        />
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
              <h3 className="serif" style={{ margin: 0, fontSize: 18 }}>{t('disc.chain')}</h3>
              <div className="muted" style={{ fontSize: 12 }}>{t('disc.chainSub')}</div>
            </div>
            <button className="icon-btn" onClick={() => setFullscreen(false)} title={t('disc.exitFullscreen')}>✕</button>
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
            toast(t('disc.toast.created'));
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
  /** DisplayRole code — the label is resolved at render time. */
  role: DisplayRole;
  isRoot: boolean;
  node?: Node;
  left: number;
  top: number;
}
interface Tree {
  rootName: string;
  rootRole: DisplayRole;
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
  const info = new Map<string, { name: string; role: DisplayRole }>();
  const asTrainee = new Set<string>();
  for (const n of nodes) {
    const m = n.pair.mentor;
    const t = n.pair.trainee;
    if (!m || !t) continue;
    info.set(m.id, { name: m.full_name, role: memberRole(m) });
    info.set(t.id, { name: t.full_name, role: memberRole(t) });
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
      role: info.get(id)?.role ?? DisplayRole.Ungrouped,
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
      rootRole: info.get(rootId)?.role ?? DisplayRole.Ungrouped,
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
  t,
}: {
  list: Node[];
  kind: 'done' | 'pending';
  onOpen: (n: Node) => void;
  t: Translate;
}) {
  if (list.length === 0) {
    return (
      <div className="empty" style={{ marginTop: 16 }}>
        {kind === 'done' ? t('disc.emptyDone') : t('disc.emptyPending')}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 16 }}>
      {list.map((n) => {
        const role = n.pair.trainee ? memberRole(n.pair.trainee) : DisplayRole.Ungrouped;
        return (
          <div
            key={n.pair.id}
            onClick={() => onOpen(n)}
            className="flex items-center gap-12"
            style={{ padding: '11px 4px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
          >
            <div className="grow">
              <div className="flex items-center gap-8 flex-wrap">
                <strong style={{ fontSize: 13.5 }}>{n.pair.trainee?.full_name}</strong>
                <span className="badge" style={{ ...roleTagStyle(role), fontSize: 10.5 }}>{t(roleKey(role))}</span>
              </div>
              <div className="faint" style={{ fontSize: 11.5, marginTop: 1 }}>
                {kind === 'done'
                  ? t('disc.doneBy', { name: n.pair.mentor?.full_name ?? '' })
                  : t('disc.pendingBy', { name: n.pair.mentor?.full_name ?? '' })}
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
              {kind === 'done'
                ? t('disc.doneBadge', { days: n.days, total: n.total })
                : t('disc.pendingBadge', { days: n.days, total: n.total })}
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
  const t = useT();
  const toast = useToast();
  const [mentorId, setMentorId] = useState('');
  const [traineeId, setTraineeId] = useState('');
  const [backfillDays, setBackfillDays] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const takenTrainees = new Set(existing.map((p) => p.trainee_id));

  const save = async () => {
    if (!mentorId || !traineeId) {
      setErr(t('disc.err.pick'));
      return;
    }
    if (mentorId === traineeId) {
      setErr(t('disc.err.same'));
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
    <Modal title={t('disc.new.title')} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <p className="muted" style={{ margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.6 }}>
        {t('disc.new.intro')}
      </p>
      <Field label={t('disc.field.mentor')}>
        <select value={mentorId} onChange={(e) => setMentorId(e.target.value)}>
          <option value="">{t('disc.chooseMember')}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {t('disc.memberOption', { name: m.full_name, role: t(roleKey(memberRole(m))) })}
            </option>
          ))}
        </select>
      </Field>
      <div style={{ textAlign: 'center', color: 'var(--accent)', fontSize: 16, fontWeight: 700, margin: '-2px 0 8px' }}>↓</div>
      <Field label={t('disc.field.traineeHint')}>
        <select value={traineeId} onChange={(e) => setTraineeId(e.target.value)}>
          <option value="">{t('disc.chooseMember')}</option>
          {members
            .filter((m) => !takenTrainees.has(m.id) && m.id !== mentorId)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {t('disc.memberOption', { name: m.full_name, role: t(roleKey(memberRole(m))) })}
              </option>
            ))}
        </select>
      </Field>
      <Field label={t('disc.field.backfillLabel', { total: totalDays })}>
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
          ? t('disc.backfillOn', {
              n: Math.min(Number(backfillDays), totalDays),
              next: Math.min(Number(backfillDays), totalDays) + 1,
            })
          : t('disc.backfillOff', { total: totalDays })}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('disc.create')}</button>
      </div>
    </Modal>
  );
}
