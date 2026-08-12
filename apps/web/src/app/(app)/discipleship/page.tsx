'use client';

import { useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import { Combobox, ErrorBanner, ExportButton, Field, MemberName, Modal, ModuleDisabled, PageBar, RoleRestricted, Skeleton, SkeletonScreen, SkeletonTable, SkeletonText, SortTh, useConfirm, useFormGuard, useToast } from '@/components/ui';
import { PairProgressModal } from '@/components/PairProgressModal';
import { can } from '@/lib/perms';
import { useModuleEnabled } from '@/lib/church';
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
import { AccountRole, DisplayRole, MODULE_DISCIPLESHIP } from '@tog/shared';

type Filter = 'active' | 'done' | 'pending';

interface Node {
  pair: PairRow;
  ov?: OverviewRow;
  depth: number;
  pct: number;
  days: number;
  total: number;
}

/** Stable empty list, so `nodes` doesn't re-memo on every render. */
const NO_PAIRS: PairRow[] = [];

export default function DiscipleshipPage() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const me = useMe();
  const perms = can(me.role);
  // `discipleship` is not in a group_leader's allowed API prefixes at all —
  // every fetch below is gated off for it too, exactly as it already is for
  // a switched-off module, so a group_leader session never fires a request
  // this role is refused anyway.
  const isGroupLeader = me.role === AccountRole.GroupLeader;
  // 四十天守望 is an ADD-ON module: a church may not run it at all. The nav
  // entry is already gone when it is off, so this only catches a bookmark or a
  // pasted link — and nothing below may fetch, or the page would paint an
  // error banner from the API's own (correct) refusal instead of the reason.
  const discipleshipOn = useModuleEnabled(MODULE_DISCIPLESHIP);
  // NAMING: everything a user reads calls this a MODULE (模块); the wire and
  // the database still say "program" (`/discipleship/programs`, `program_id`,
  // `ProgramRow`) because renaming those is a migration's worth of churn for
  // nothing visible. This line is the boundary — an API row goes in, module
  // wording comes out. (Not to be confused with the ADD-ON module above: that
  // is the whole 四十天守望 section, this is one 守望模块 inside it.)
  const modules = useFetch<ProgramRow[]>(discipleshipOn && !isGroupLeader ? '/discipleship/programs' : null);
  // Deliberately unfiltered: the page shows ONE module's pairs but needs every
  // module's pair count, for the module list and for the delete confirmation's
  // blast radius — so it is fetched once and grouped here rather than costing
  // a round-trip per module.
  const pairs = useFetch<PairRow[]>(discipleshipOn && !isGroupLeader ? '/discipleship/pairs' : null);
  const members = useFetch<MemberRow[]>(discipleshipOn && !isGroupLeader ? '/members' : null);
  // Same option shape AddPairModal's own two pickers already build (rule G4)
  // — reused here for the relay chart's own member-search scope.
  const memberOptions = useMemo(
    () => (members.data ?? []).map((m) => ({
      value: m.id,
      label: m.full_name,
      sub: m.english_name,
      hint: t(roleKey(memberRole(m))),
    })),
    [members.data, t],
  );

  const [filter, setFilter] = useState<Filter>('active');
  const [popup, setPopup] = useState<Node | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  /** The create form, shown only from the empty state below. */
  const [moduleForm, setModuleForm] = useState(false);
  /** Which module is being viewed. Nothing is persisted across reloads. */
  const [picked, setPicked] = useState<string | null>(null);

  const moduleList = modules.data ?? [];
  // The default is the first module; an unknown picked id falls back to it too.
  const activeModule = moduleList.find((m) => m.id === picked) ?? moduleList[0];
  const programId = activeModule?.id;

  const overview = useFetch<OverviewRow[]>(
    discipleshipOn && programId ? `/discipleship/programs/${programId}/overview` : null,
  );

  const pairsByModule = useMemo(() => {
    const m = new Map<string, PairRow[]>();
    for (const p of pairs.data ?? []) {
      const arr = m.get(p.program_id);
      if (arr) arr.push(p);
      else m.set(p.program_id, [p]);
    }
    return m;
  }, [pairs.data]);
  const modulePairs = (programId && pairsByModule.get(programId)) || NO_PAIRS;

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

  const onModuleCreated = (saved: ProgramRow) => {
    setModuleForm(false);
    // Land on the module that was just created — the whole point of the empty
    // state's button.
    setPicked(saved.id);
    modules.reload();
    toast(t('disc.module.toast.created'));
  };

  const ovByPair = useMemo(() => {
    const m = new Map<string, OverviewRow>();
    (overview.data ?? []).forEach((o) => m.set(o.pair_id, o));
    return m;
  }, [overview.data]);

  const nodes = useMemo<Node[]>(() => {
    const list = modulePairs;
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
      // The overview row knows the module's length; before it lands, fall back
      // to the selected module's own figure rather than a hard-coded 40 — a
      // module is free to be any number of days.
      const total = ov?.total_days ?? activeModule?.total_days ?? 40;
      const days = ov?.days_completed ?? 0;
      return { pair: p, ov, depth: depthOf(p), pct: Number(ov?.percent_complete ?? 0), days, total };
    });
  }, [modulePairs, ovByPair, activeModule]);

  const classify = (n: Node): Filter =>
    n.pct >= 100 ? 'done' : n.days > 0 ? 'active' : 'pending';

  const counts = {
    active: nodes.filter((n) => classify(n) === 'active').length,
    done: nodes.filter((n) => classify(n) === 'done').length,
    pending: nodes.filter((n) => classify(n) === 'pending').length,
  };

  // Scoping the chain to one member (0115): their own ancestor chain reads as
  // ONE lineage — who led them, who led that person — never the rest of that
  // mentor's roster, so it walks a single parent link at a time. Their own
  // descendants are the opposite: everyone they lead, and everyone THOSE
  // people lead, however the branching actually goes — so it is the same
  // reachability walk `buildForest` already does for a root, just started
  // from the picked member instead of from a trainee-less one. Both walks
  // narrow the PAIR set fed into `buildForest`, so the existing tree layout
  // and rendering need no change at all — only which pairs it ever sees.
  const [scopeId, setScopeId] = useState('');
  const scopedNodes = useMemo(() => {
    if (!scopeId) return nodes;
    const byTrainee = new Map(nodes.map((n) => [n.pair.trainee_id, n]));
    const byMentor = new Map<string, Node[]>();
    for (const n of nodes) {
      const arr = byMentor.get(n.pair.mentor_id) ?? [];
      arr.push(n);
      byMentor.set(n.pair.mentor_id, arr);
    }
    const picked = new Set<Node>();

    let up = scopeId;
    const seenUp = new Set<string>();
    while (!seenUp.has(up)) {
      seenUp.add(up);
      const edge = byTrainee.get(up);
      if (!edge) break;
      picked.add(edge);
      up = edge.pair.mentor_id;
    }

    const queue = [scopeId];
    const seenDown = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seenDown.has(id)) continue;
      seenDown.add(id);
      for (const edge of byMentor.get(id) ?? []) {
        picked.add(edge);
        queue.push(edge.pair.trainee_id);
      }
    }

    return nodes.filter((n) => picked.has(n));
  }, [nodes, scopeId]);

  const forest = useMemo(() => buildForest(scopedNodes), [scopedNodes]);
  const doneList = nodes.filter((n) => classify(n) === 'done');
  const pendingList = nodes.filter((n) => classify(n) === 'pending');

  // Trainee is the default sort — the same primary identity the table used to
  // sort by implicitly when mentor and trainee still shared one cell. Mentor
  // is its own key now that it is its own column.
  const { sorted: sortedNodes, sortKey: nodeSortKey, sortDir: nodeSortDir, toggleSort: toggleNodeSort } =
    useSortableRows(
      nodes,
      (n, key) => {
        switch (key) {
          case 'pct':
            return n.pct;
          case 'status':
            return t(pairStatusKey(n.pair.status));
          case 'mentor':
            return n.pair.mentor?.full_name;
          default:
            return n.pair.trainee?.full_name;
        }
      },
      { key: 'trainee', dir: 'asc' },
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
                  {/* The ONE place a person is drawn on one line: a chart node
                      is a fixed box (NODEW / NODEH / ROWH below) and the curves
                      between nodes are anchored to that height, so a second
                      line of name would move every connector off its box. The
                      names are all here in the pair rows underneath it. */}
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
  const booting = pairs.initialLoading || modules.initialLoading;

  // Outside a group_leader's scope entirely — checked before the module
  // state, so its own reason wins over "module is off" if somehow both apply.
  if (isGroupLeader) return <RoleRestricted />;

  // The module is switched off for this church — say so plainly. The API
  // refuses every /discipleship path regardless (rule G2); this is the reason,
  // not the enforcement.
  if (!discipleshipOn) return <ModuleDisabled name={t('module.discipleship.name')} />;

  // A church with no 守望 module at all is a different state from a slow
  // fetch — decide it only once the modules have actually arrived. This is the
  // one place a module is created from, and it is kept precisely because a row
  // that goes missing (a data cleanup, a restore) would otherwise leave the
  // whole feature unreachable except from raw SQL. That already happened once.
  if (!booting && !programId) {
    return (
      <>
        <ErrorBanner message={modules.error} />
        <PageBar
          actions={
            perms.write ? (
              <button className="btn" onClick={() => setModuleForm(true)}>{t('disc.module.add')}</button>
            ) : undefined
          }
        />
        <div className="empty">
          {perms.write ? t('disc.noModule') : t('disc.noModule.readonly')}
        </div>
        {moduleForm && (
          <ModuleFormModal onClose={() => setModuleForm(false)} onCreated={onModuleCreated} />
        )}
      </>
    );
  }

  return (
    <>
      <ErrorBanner message={pairs.error || overview.error || modules.error} />

      <PageBar
        filters={
          // One module is the normal case and gets no selector at all. From two
          // up, the picker is a dropdown and so belongs in the filters half —
          // never among the actions (rule G7a).
          moduleList.length > 1 ? (
            <select
              aria-label={t('disc.module.selector')}
              value={programId ?? ''}
              onChange={(e) => setPicked(e.target.value)}
            >
              {moduleList.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          ) : undefined
        }
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
          {/* Scoping the tree to one member (0115) is a chart control, not a
              page-wide filter, so it lives on the chart's own card-head and
              only when the tree is actually the thing on screen — searching
              is idle noise on the flat done/pending lists below. */}
          {filter === 'active' && (
            <div style={{ width: 220, flexShrink: 0 }}>
              <Combobox
                value={scopeId}
                onChange={setScopeId}
                options={memberOptions}
                placeholder={t('disc.chain.scopePlaceholder')}
                ariaLabel={t('disc.chain.scopePlaceholder')}
                size="sm"
              />
            </div>
          )}
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
                <div className="empty">
                  {scopeId ? t('disc.chain.scopeEmpty') : t('disc.emptyActive')}
                </div>
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
        <SkeletonTable rows={5} columns={6} />
      ) : (
        <div className="card">
          {/* Desktop — table */}
          <div className="table-wrap only-desktop">
            <table>
              <thead>
                <tr>
                  <SortTh sortKey="trainee" activeKey={nodeSortKey} dir={nodeSortDir} onSort={toggleNodeSort}>{t('disc.col.trainee')}</SortTh>
                  <SortTh sortKey="mentor" activeKey={nodeSortKey} dir={nodeSortDir} onSort={toggleNodeSort}>{t('disc.col.mentor')}</SortTh>
                  <SortTh sortKey="pct" activeKey={nodeSortKey} dir={nodeSortDir} onSort={toggleNodeSort} style={{ width: 200 }}>{t('disc.col.progress')}</SortTh>
                  <SortTh sortKey="status" activeKey={nodeSortKey} dir={nodeSortDir} onSort={toggleNodeSort}>{t('groups.col.status')}</SortTh>
                  <th>{t('disc.col.remark')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sortedNodes.map((n) => (
                  <tr key={n.pair.id}>
                    {/* Mentor and trainee are their own columns now — each is
                        just the one name, no arrow needed once they're not
                        sharing a cell. */}
                    <td><MemberName member={n.pair.trainee} fallback="" /></td>
                    <td><MemberName member={n.pair.mentor} fallback="" /></td>
                    <td>
                      <div className="progress-row">
                        <div className="bar"><span style={{ width: `${n.pct}%` }} /></div>
                        <span className="pct">{n.days}/{n.total}</span>
                      </div>
                    </td>
                    <td><span className={`badge ${pairStatusClass(n.pair.status)}`}>{t(pairStatusKey(n.pair.status))}</span></td>
                    {/* Free text and can run long, unlike every other column
                        here — bounded and ellipsised, full text still reachable
                        through the native `title` tooltip (same pattern the
                        members list uses for its own remark column). */}
                    <td className="muted cell-remark" title={n.pair.remark ?? undefined}>
                      {n.pair.remark ?? ''}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {/* One button: the dialog it opens now edits progress
                          directly, so there is nothing left for a separate
                          "Form" shortcut to do that this doesn't already. */}
                      <button className="btn ghost sm" onClick={() => setPopup(n)}>{t('disc.progressBtn')}</button>
                    </td>
                  </tr>
                ))}
                {sortedNodes.length === 0 && (
                  <tr><td colSpan={6} className="empty-inline">{t('disc.empty')}</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile — list tiles: trainee ← mentor, then progress · status · remark */}
          <div className="only-mobile" style={{ marginTop: 4 }}>
            {sortedNodes.map((n) => (
              <div key={n.pair.id} className="mtile" onClick={() => setPopup(n)}>
                <div className="mtile-row1">
                  <div className="flex items-baseline gap-6 flex-wrap" style={{ minWidth: 0 }}>
                    <MemberName member={n.pair.trainee} fallback="" />
                    <span className="faint">←</span>
                    <span className="faint"><MemberName member={n.pair.mentor} fallback="" /></span>
                  </div>
                </div>
                <div className="mtile-line" style={{ marginTop: 9 }}>
                  <div className="bar" style={{ flex: 1 }}><span style={{ width: `${n.pct}%` }} /></div>
                  <span className="pct" style={{ whiteSpace: 'nowrap' }}>{n.days}/{n.total}</span>
                  <span className={`badge ${pairStatusClass(n.pair.status)}`}>{t(pairStatusKey(n.pair.status))}</span>
                </div>
                {n.pair.remark && (
                  <div className="mtile-line cell-remark" title={n.pair.remark}>
                    {n.pair.remark}
                  </div>
                )}
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
          canEdit={perms.write}
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
          totalDays={activeModule?.total_days ?? 40}
          members={members.data ?? []}
          // The unique constraint is (program_id, trainee_id), so only the
          // selected module's pairs may hide a member from the trainee list —
          // somebody paired under another module is still free here.
          existing={modulePairs}
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

/* ---- The 守望模块, created once ------------------------------------------
 * A module is the definition a pair hangs off: its name and how many days the
 * pair follows. It is CREATED here and never edited or deleted from the app.
 *
 * There was a manager on this page — a Modules button over a list dialog with
 * an edit form and a delete on every row. It came from a misreading of what
 * the church meant by "module" (they meant the add-on switches on 教会设置),
 * and its delete cascaded away every pair under a module and every day of
 * their records behind one confirmation. It is gone, along with the API routes
 * it called.
 *
 * What is kept is exactly this form, reachable only from the page's empty
 * state: with no module at all the whole feature has nothing to hang pairs on,
 * and without a way to make the first one the page is unrecoverable from the
 * UI — a hole this app has already fallen into once.
 * ---------------------------------------------------------------------- */

function ModuleFormModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (saved: ProgramRow) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [form, setForm] = useState({
    name: '',
    description: '',
    // Kept as a string so the field can be cleared while typing; validated below.
    total_days: '40',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Asks before ✕ or Cancel discards this, and arms the browser's own prompt
  // for a refresh (rule G4 — one guard, every form).
  const { close } = useFormGuard({ form }, onClose);

  const save = async () => {
    const name = form.name.trim();
    if (!name) {
      setErr(t('disc.module.err.name'));
      return;
    }
    // The table carries `check (total_days >= 1)`, so a bad figure would come
    // back as a Postgres error — check it here so the user reads it in their
    // own language, and still surface the server's word if it refuses anyway.
    const days = Number(form.total_days);
    if (!Number.isInteger(days) || days < 1) {
      setErr(t('disc.module.err.days'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      onCreated(
        await api.post<ProgramRow>('/discipleship/programs', {
          name,
          description: form.description.trim() || null,
          total_days: days,
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('disc.module.new.title')} onClose={close}>
      {err && <ErrorBanner message={err} />}
      <Field label={t('disc.module.field.name')}>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder={t('disc.module.namePlaceholder')}
        />
      </Field>
      <Field label={t('disc.module.field.description')}>
        <input
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder={t('disc.module.descriptionPlaceholder')}
        />
      </Field>
      <Field label={t('disc.module.field.totalDays')}>
        <input
          type="number"
          min={1}
          step={1}
          value={form.total_days}
          onChange={(e) => setForm({ ...form, total_days: e.target.value })}
        />
      </Field>
      <div className="hint" style={{ marginBottom: 6 }}>{t('disc.module.daysHint')}</div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </Modal>
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
                <MemberName member={n.pair.trainee} fallback="" style={{ fontSize: 13.5 }} />
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
  const [backfillDays, setBackfillDays] = useState('0');
  const [remark, setRemark] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Asks before ✕ or Cancel discards the pair being set up, and arms the
  // browser's prompt for a refresh (rule G4 — one guard, every form).
  const { close } = useFormGuard({ mentorId, traineeId, backfillDays, remark }, onClose);

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
        remark: remark.trim() || null,
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
    <Modal title={t('disc.new.title')} onClose={close} size="wide">
      {err && <ErrorBanner message={err} />}
      <p className="muted" style={{ margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.6 }}>
        {t('disc.new.intro')}
      </p>
      {/* Both pickers are type-to-search: with the whole church in the list,
          scrolling to find one person is the slow way (rule G4). One row,
          mentor ➜ trainee — the same shape the progress modal's own header
          reads a finished pair in, just with pickers instead of names.
          flex-wrap keeps it usable at phone width (rule G7). */}
      <div className="flex items-end gap-10 flex-wrap" style={{ marginBottom: 14 }}>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <Field label={t('disc.field.mentor')}>
            <Combobox
              value={mentorId}
              onChange={setMentorId}
              options={members.map((m) => ({
                value: m.id,
                label: m.full_name,
                sub: m.english_name,
                hint: t(roleKey(memberRole(m))),
              }))}
              placeholder={t('disc.chooseMember')}
              ariaLabel={t('disc.field.mentor')}
            />
          </Field>
        </div>
        <div style={{ flexShrink: 0, color: 'var(--accent)', fontWeight: 700, fontSize: 16, paddingBottom: 10 }}>➜</div>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <Field label={t('disc.field.traineeHint')}>
            <Combobox
              value={traineeId}
              onChange={setTraineeId}
              options={members
                .filter((m) => !takenTrainees.has(m.id) && m.id !== mentorId)
                .map((m) => ({
                  value: m.id,
                  label: m.full_name,
                  sub: m.english_name,
                  hint: t(roleKey(memberRole(m))),
                }))}
              placeholder={t('disc.chooseMember')}
              ariaLabel={t('disc.field.traineeHint')}
            />
          </Field>
        </div>
      </div>
      <Field label={t('disc.field.remark')}>
        <textarea
          rows={2}
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
          placeholder={t('disc.field.remarkPlaceholder')}
        />
      </Field>
      <Field label={t('disc.field.backfillLabel')}>
        <input
          type="number"
          min={0}
          max={totalDays}
          value={backfillDays}
          onChange={(e) => setBackfillDays(e.target.value)}
        />
      </Field>
      <div className="modal-actions">
        <button className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('disc.create')}</button>
      </div>
    </Modal>
  );
}
