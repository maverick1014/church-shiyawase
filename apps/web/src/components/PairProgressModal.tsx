'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { PairDetail, PairRow, ProgressRow } from '@/lib/types';
import { memberRole, pairStatusClass, pairStatusKey, roleKey } from '@/lib/labels';
import { copyText } from '@/lib/clipboard';
import { useT } from '@/lib/i18n';
import { ErrorBanner, Field, MemberName, Modal, Skeleton, SkeletonScreen, useConfirm, useFormGuard, useToast } from './ui';

/** The dialog's own shape while `pair` is still loading — same header /
 *  progress-bar / day-grid layout the real content lands in, so the modal
 *  never resizes when the fetch resolves. 40 days is the common case; the
 *  grid is decorative, so it doesn't need the real program's exact count. */
function SkeletonPairProgress() {
  return (
    <SkeletonScreen>
      <div className="flex" style={{ alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Skeleton width="58%" height={16} />
          <Skeleton width="38%" height={11} style={{ marginTop: 10 }} />
        </div>
      </div>
      <div className="progress-row mt-14">
        <Skeleton height={8} radius={4} />
        <Skeleton width={30} height={11} />
      </div>
      <Skeleton width="42%" height={11} style={{ margin: '16px 0 8px' }} />
      <div className="day-grid">
        {Array.from({ length: 40 }, (_, i) => (
          <Skeleton key={i} radius={6} style={{ height: 'auto', aspectRatio: '1' }} />
        ))}
      </div>
    </SkeletonScreen>
  );
}

/** What a day's editable fields look like in local state, before Save. */
interface DayForm {
  completed: boolean;
  notes: string;
  entry_date: string;
  entry_time: string;
}

const EMPTY_DAY_FORM: DayForm = { completed: false, notes: '', entry_date: '', entry_time: '' };

function dayFormOf(row: ProgressRow | undefined): DayForm {
  return {
    completed: row?.completed ?? false,
    notes: row?.notes ?? '',
    // Postgres `time`/`date` read back as "HH:MM:SS"/"YYYY-MM-DD…"; the
    // inputs want "HH:MM"/"YYYY-MM-DD".
    entry_date: row?.entry_date?.slice(0, 10) ?? '',
    entry_time: row?.entry_time?.slice(0, 5) ?? '',
  };
}

/**
 * Self-contained 40-day progress dialog for a discipleship pair. Fetches the
 * pair detail (and the pair list for the lineage chain) so any page can open
 * it with just a pairId — no shared page navigation required. Each day cell is
 * clickable, and staff can now fill in or correct that day's entry directly
 * here — checkbox, notes, and when it happened — rather than only reading
 * what the mentor already sent in through the public form.
 *
 * This is also the ONE dialog "the form" opens into for staff, whether they
 * click "Progress" or (formerly) "Form" on the pastor-overview row: since
 * staff can edit an entry right here, a separate "Open form" that navigated
 * to the public /d/[token] page had nothing left to do that this doesn't —
 * that public page still exists, unchanged, for an actual mentor with no
 * login to use from a shared link, which is exactly what Share still copies.
 *
 * Deleting a pair lives here rather than in the list row: it sits behind an
 * extra tap, away from the links a user opens every day. Callers pass
 * `onDelete` only when the role may delete; without it the button is absent.
 *
 * `canEdit` gates the remark field, the day's editable controls and the Save
 * button — the server already refuses a write from a `readonly` account
 * (rule G2's server half), but rendering the controls anyway would be a
 * button that only ever 403s (the client half G2 also requires). A caller
 * that cannot write sees the same information as plain, read-only text.
 */
export function PairProgressModal({
  pairId,
  canEdit,
  onClose,
  onDelete,
}: {
  pairId: string;
  canEdit: boolean;
  onClose: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const pair = useFetch<PairDetail>(`/discipleship/pairs/${pairId}`);
  const allPairs = useFetch<PairRow[]>('/discipleship/pairs');
  const [selDay, setSelDay] = useState<number | null>(null);
  const [dayForm, setDayForm] = useState<DayForm>(EMPTY_DAY_FORM);
  const [remarkDraft, setRemarkDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const p = pair.data;

  // Re-seed the editable fields from the server whenever the fetched pair
  // object changes — on the first load, and again after this modal's own
  // Save reloads it, so the fields reflect exactly what was just persisted
  // rather than staying on the pre-save draft.
  useEffect(() => {
    if (!p) return;
    setRemarkDraft(p.remark ?? '');
    if (selDay != null) setDayForm(dayFormOf(p.progress.find((r) => r.day_number === selDay)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p]);

  const total = p?.program?.total_days ?? 40;
  const progressByDay = new Map<number, ProgressRow>();
  (p?.progress ?? []).forEach((r) => progressByDay.set(r.day_number, r));
  const doneDays = new Set((p?.progress ?? []).filter((r) => r.completed).map((r) => r.day_number));
  const done = doneDays.size;
  const pct = total ? Math.round((done / total) * 100) : 0;

  // Edits are held locally until Save — never auto-saved on a keystroke or a
  // toggle — so "dirty" is a plain comparison against what the server last
  // said, not a flag tracked separately.
  const remarkDirty = !!p && remarkDraft !== (p.remark ?? '');
  const originalDay = selDay != null ? progressByDay.get(selDay) : undefined;
  const dayDirty =
    selDay != null &&
    !!p &&
    JSON.stringify(dayForm) !== JSON.stringify(dayFormOf(originalDay));

  // This modal already knows exactly what is unsaved, so the guard reuses
  // those two flags rather than snapshotting the same state a second time —
  // `useFormGuard` takes any value, and a pair of booleans is a fine one.
  const { close } = useFormGuard({ remarkDirty, dayDirty }, onClose);

  const link = p && typeof window !== 'undefined' ? `${window.location.origin}/d/${p.form_token}` : '';
  // Same copy path as the sign-up link on 培训&活动 — one helper, and a
  // message whether or not the browser could do it (rule G4).
  const copy = async () => {
    const ok = await copyText(link);
    if (ok) toast(t('disc.progress.linkCopied'));
    else toast(t('common.copyFailed', { link }), 'error');
  };

  // Picking a day never silently throws away unsaved edits on the one just
  // left — it asks first, the same as any other place in this app where a
  // navigation would otherwise cost the user something they typed (rule G3's
  // spirit, even though nothing is deleted server-side here).
  const pickDay = async (dnum: number) => {
    if (selDay != null && dnum !== selDay && dayDirty) {
      const ok = await confirm({
        title: t('disc.progress.unsavedTitle'),
        message: t('disc.progress.unsavedMessage', { n: selDay }),
        confirmText: t('disc.progress.discardConfirm'),
        danger: true,
      });
      if (!ok) return;
    }
    setSelDay(dnum);
    setDayForm(dayFormOf(progressByDay.get(dnum)));
  };

  const save = async () => {
    if (!p || (!remarkDirty && !dayDirty)) return;
    setSaving(true);
    try {
      const calls: Promise<unknown>[] = [];
      if (remarkDirty)
        calls.push(api.patch(`/discipleship/pairs/${pairId}`, { remark: remarkDraft.trim() || null }));
      if (selDay != null && dayDirty)
        calls.push(
          api.post(`/discipleship/pairs/${pairId}/progress`, {
            day_number: selDay,
            completed: dayForm.completed,
            notes: dayForm.notes.trim() || null,
            entry_date: dayForm.entry_date || null,
            entry_time: dayForm.entry_time || null,
          }),
        );
      await Promise.all(calls);
      pair.reload();
      allPairs.reload();
      toast(t('disc.progress.toast.saved'));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
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
    <Modal onClose={close} size="wide">
      {pair.loading || !p ? (
        pair.error ? <ErrorBanner message={pair.error} /> : <SkeletonPairProgress />
      ) : (
        <>
          {/* Header: names on the left (wrap within their own column), close
              button pinned to the top-right so it never drops to a new row. */}
          <div className="flex" style={{ alignItems: 'flex-start', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="flex items-center gap-8 flex-wrap">
                <MemberName member={p.mentor} fallback="" style={{ fontSize: 16 }} />
                <span style={{ color: 'var(--accent)', fontWeight: 700 }}>➜</span>
                <MemberName member={p.trainee} fallback="" style={{ fontSize: 16 }} />
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                {t('disc.progress.direction')}
                {p.trainee ? ` · ${t(roleKey(memberRole(p.trainee)))}` : ''}
                <span className={`badge ${pairStatusClass(p.status)}`} style={{ marginLeft: 8 }}>
                  {t(pairStatusKey(p.status))}
                </span>
              </div>
            </div>
            <button className="icon-btn" style={{ flexShrink: 0 }} onClick={close} title={t('common.close')}>✕</button>
          </div>

          {/* Staff's own note about the pair — editable here, saved with the
              rest (rule G5: one field, one place, not a display-only copy of
              something editable elsewhere). A caller that cannot write only
              ever sees it if there is one to see — an empty remark is a fact,
              not a blank control to stare at (same reasoning as an empty
              serving_roles list elsewhere in this app). */}
          {canEdit ? (
            <Field label={t('disc.field.remark')}>
              <textarea
                rows={2}
                value={remarkDraft}
                onChange={(e) => setRemarkDraft(e.target.value)}
                placeholder={t('disc.field.remarkPlaceholder')}
              />
            </Field>
          ) : (
            p.remark && (
              <div className="muted" style={{ fontSize: 13, marginBottom: 14, whiteSpace: 'pre-wrap' }}>
                {t('disc.field.remark')}: {p.remark}
              </div>
            )
          )}

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
                  onClick={() => pickDay(dnum)}
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
                  {!canEdit && originalDay?.entry_date ? ` · ${originalDay.entry_date.slice(0, 10)}` : ''}
                </strong>
                <span className={`badge ${
                  canEdit
                    ? dayForm.completed ? 'b-good' : 'b-warn'
                    : originalDay ? (originalDay.completed ? 'b-good' : 'b-warn') : 'b-gray'
                }`}>
                  {canEdit
                    ? dayForm.completed ? t('disc.progress.completed') : t('disc.progress.notCompleted')
                    : originalDay
                      ? originalDay.completed ? t('disc.progress.completed') : t('disc.progress.notCompleted')
                      : t('disc.progress.notFilled')}
                </span>
              </div>
              {canEdit ? (
                <>
                  {/* Held in local state until Save is pressed — nothing here
                      writes on a keystroke or a toggle. */}
                  <label className="flex items-center gap-8" style={{ fontSize: 13, fontWeight: 500, margin: '10px 0 8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={dayForm.completed}
                      onChange={(e) => setDayForm({ ...dayForm, completed: e.target.checked })}
                      style={{ width: 16, height: 16, accentColor: 'var(--brand)' }}
                    />
                    {t('disc.progress.completed')}
                  </label>
                  <div className="form-row">
                    <Field label={t('disc.progress.entryDate')}>
                      <input
                        type="date"
                        className={dayForm.entry_date ? undefined : 'date-empty'}
                        value={dayForm.entry_date}
                        onChange={(e) => setDayForm({ ...dayForm, entry_date: e.target.value })}
                      />
                    </Field>
                    <Field label={t('disc.progress.entryTime')}>
                      {/* A bare `time` is a Malaysian wall-clock reading — no
                          zone conversion (rule G6a). */}
                      <input
                        type="time"
                        className={dayForm.entry_time ? undefined : 'date-empty'}
                        value={dayForm.entry_time}
                        onChange={(e) => setDayForm({ ...dayForm, entry_time: e.target.value })}
                      />
                    </Field>
                  </div>
                  <Field label={t('disc.progress.notes')}>
                    <textarea
                      rows={3}
                      value={dayForm.notes}
                      onChange={(e) => setDayForm({ ...dayForm, notes: e.target.value })}
                    />
                  </Field>
                </>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--ink)', marginTop: 8, lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>
                  {originalDay?.notes ? (
                    originalDay.notes
                  ) : (
                    <span className="faint">
                      {originalDay ? t('disc.progress.noNote') : t('disc.progress.notFilledBody')}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {lineage.length > 1 && (
            <div style={{ marginTop: 18 }}>
              <div className="section-label" style={{ marginBottom: 8 }}>{t('disc.progress.lineage')}</div>
              {/* The lineage is a row of BADGES — a chip is one line by
                  definition, and this chain can be six people long, so the
                  Chinese name alone stands for each of them here. The header
                  above carries both names for the pair being looked at. */}
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

          {/* One row: Delete (only when the role may), Share, Save (only when
              the role may write at all) — the same shape every other modal's
              footer uses (rule G4). */}
          <div className="modal-actions">
            {onDelete && (
              <button className="btn danger" style={{ marginRight: 'auto' }} onClick={onDelete}>
                {t('common.delete')}
              </button>
            )}
            <button className="btn ghost" onClick={copy}>{t('disc.progress.copyLink')}</button>
            {canEdit && (
              <button className="btn" onClick={save} disabled={saving || (!remarkDirty && !dayDirty)}>
                {saving ? t('common.saving') : t('common.save')}
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
