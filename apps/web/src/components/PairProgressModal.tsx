'use client';

import { useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { PairDetail, PairRow, ProgressRow } from '@/lib/types';
import { formatDate, memberRole, pairStatusClass, pairStatusKey, roleKey } from '@/lib/labels';
import { copyText } from '@/lib/clipboard';
import { useT } from '@/lib/i18n';
import { ErrorBanner, Loading, Modal, useToast } from './ui';

/**
 * Self-contained 40-day progress dialog for a discipleship pair. Fetches the
 * pair detail (and the pair list for the lineage chain) so any page can open
 * it with just a pairId — no shared page navigation required. Each day cell is
 * clickable so a pastor / leader can read that day's remark and follow up.
 *
 * Deleting a pair lives here rather than in the list row: it sits behind an
 * extra tap, away from the links a user opens every day. Callers pass
 * `onDelete` only when the role may delete; without it the button is absent.
 */
export function PairProgressModal({
  pairId,
  onClose,
  onDelete,
}: {
  pairId: string;
  onClose: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const pair = useFetch<PairDetail>(`/discipleship/pairs/${pairId}`);
  const allPairs = useFetch<PairRow[]>('/discipleship/pairs');
  const [selDay, setSelDay] = useState<number | null>(null);

  const p = pair.data;
  const total = p?.program?.total_days ?? 40;
  const progressByDay = new Map<number, ProgressRow>();
  (p?.progress ?? []).forEach((r) => progressByDay.set(r.day_number, r));
  const doneDays = new Set((p?.progress ?? []).filter((r) => r.completed).map((r) => r.day_number));
  const done = doneDays.size;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const sel = selDay ? progressByDay.get(selDay) : undefined;

  const link = p && typeof window !== 'undefined' ? `${window.location.origin}/d/${p.form_token}` : '';
  // Same copy path as the sign-up link on 培训&活动 — one helper, and a
  // message whether or not the browser could do it (rule G4).
  const copy = async () => {
    const ok = await copyText(link);
    if (ok) toast(t('disc.progress.linkCopied'));
    else toast(t('common.copyFailed', { link }), 'error');
  };

  // Walk the lineage up to the root of the relay chain.
  const byId = new Map((allPairs.data ?? []).map((x) => [x.id, x]));
  const lineage: PairRow[] = [];
  let cur: PairRow | undefined = allPairs.data?.find((x) => x.id === pairId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    lineage.unshift(cur);
    cur = cur.parent_pair_id ? byId.get(cur.parent_pair_id) : undefined;
  }

  return (
    <Modal onClose={onClose} size="wide">
      {pair.loading || !p ? (
        pair.error ? <ErrorBanner message={pair.error} /> : <div style={{ padding: 24 }}><Loading /></div>
      ) : (
        <>
          {/* Header: names on the left (wrap within their own column), close
              button pinned to the top-right so it never drops to a new row. */}
          <div className="flex" style={{ alignItems: 'flex-start', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="flex items-center gap-8 flex-wrap">
                <strong className="serif" style={{ fontSize: 16 }}>{p.mentor?.full_name}</strong>
                <span style={{ color: 'var(--accent)', fontWeight: 700 }}>➜</span>
                <strong className="serif" style={{ fontSize: 16 }}>{p.trainee?.full_name}</strong>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                {t('disc.progress.direction')}
                {p.trainee ? ` · ${t(roleKey(memberRole(p.trainee)))}` : ''}
                <span className={`badge ${pairStatusClass(p.status)}`} style={{ marginLeft: 8 }}>
                  {t(pairStatusKey(p.status))}
                </span>
              </div>
            </div>
            <button className="icon-btn" style={{ flexShrink: 0 }} onClick={onClose} title={t('common.close')}>✕</button>
          </div>

          <div className="progress-row mt-14">
            <div className="bar"><span style={{ width: `${pct}%` }} /></div>
            <span className="pct">{pct}%</span>
          </div>
          <div className="muted" style={{ fontSize: 13, margin: '16px 0 8px' }}>
            {t('disc.progress.grid', { done, total })}
          </div>
          <div className="day-grid">
            {Array.from({ length: total }, (_, i) => {
              const dnum = i + 1;
              const hasNote = !!progressByDay.get(dnum)?.notes;
              return (
                <div
                  key={i}
                  className={`day-cell clickable ${doneDays.has(dnum) ? 'done' : ''} ${
                    selDay === dnum ? 'sel' : ''
                  }`}
                  onClick={() => setSelDay(dnum)}
                  title={
                    hasNote
                      ? t('disc.progress.dayNote', { n: dnum })
                      : t('disc.progress.day', { n: dnum })
                  }
                >
                  {dnum}
                  {hasNote && <span className="note-star">★</span>}
                </div>
              );
            })}
          </div>

          {selDay && (
            <div
              style={{
                marginTop: 12,
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '12px 14px',
              }}
            >
              <div className="flex-between" style={{ alignItems: 'center', gap: 8 }}>
                <strong style={{ fontSize: 14 }}>
                  {t('disc.progress.day', { n: selDay })}
                  {sel?.entry_date ? ` · ${formatDate(sel.entry_date)}` : ''}
                </strong>
                <span className={`badge ${sel ? (sel.completed ? 'b-good' : 'b-warn') : 'b-gray'}`}>
                  {sel
                    ? sel.completed
                      ? t('disc.progress.completed')
                      : t('disc.progress.notCompleted')
                    : t('disc.progress.notFilled')}
                </span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--ink)', marginTop: 8, lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>
                {sel?.notes ? (
                  sel.notes
                ) : (
                  <span className="faint">
                    {sel ? t('disc.progress.noNote') : t('disc.progress.notFilledBody')}
                  </span>
                )}
              </div>
            </div>
          )}

          {lineage.length > 1 && (
            <div style={{ marginTop: 18 }}>
              <div className="section-label" style={{ marginBottom: 8 }}>{t('disc.progress.lineage')}</div>
              <div className="flex items-center gap-8 flex-wrap">
                {lineage.map((x, i) => (
                  <div key={x.id} className="flex items-center gap-8">
                    {i === 0 && <span className="badge b-brand">{x.mentor?.full_name}</span>}
                    <span style={{ color: 'var(--accent)', fontWeight: 700 }}>➜</span>
                    <span className={`badge ${x.id === pairId ? 'b-accent' : 'b-gray'}`}>
                      {x.trainee?.full_name}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="field mt-16">
            <label className="field-label">{t('disc.progress.linkLabel')}</label>
            <input readOnly value={link} style={{ background: 'var(--surface-2)', color: 'var(--muted)' }} />
          </div>
          <div className="flex gap-8">
            <button className="btn grow" onClick={copy}>{t('disc.progress.copyLink')}</button>
            <button className="btn accent grow" onClick={() => window.open(`/d/${p.form_token}`, '_blank')}>
              {t('disc.progress.openForm')}
            </button>
          </div>
          {onDelete && (
            <div className="flex mt-14" style={{ justifyContent: 'flex-end' }}>
              <button className="btn danger" onClick={onDelete}>{t('common.delete')}</button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
