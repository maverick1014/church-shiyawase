'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import {
  ErrorBanner,
  ExportButton,
  Field,
  Modal,
  ModuleDisabled,
  PageBar,
  RoleRestricted,
  SkeletonCards,
  SkeletonScreen,
  useConfirm,
  useToast,
} from '@/components/ui';
import { can } from '@/lib/perms';
import { useModuleEnabled } from '@/lib/church';
import { exportRows } from '@/lib/export';
import { formatDateRange } from '@/lib/labels';
import { endOfChurchDate, startOfChurchDate } from '@/lib/time';
import { HappinessTermRow } from '@/lib/types';
import { useT } from '@/lib/i18n';
import { AccountRole, MODULE_HAPPINESS } from '@tog/shared';

/**
 * 幸福小组 catalog — one card per term (期), bucketed exactly the way
 * 培训&活动's own catalog buckets its rows (rule G4: the same card grid,
 * the same section-label-then-grid shape), not the table this page used to
 * be. A term is CURRENT if today falls in [starts_on, ends_on] (or either
 * end is unset — an open-ended term reads as always current), UPCOMING if
 * it hasn't started yet, and ENDED once its end date has passed; several
 * terms may be current or upcoming at once (0022: terms deliberately
 * overlap), so this is a three-way split rather than trainings' two.
 */
export default function HappinessTermsPage() {
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const me = useMe();
  const perms = can(me.role);
  // `happiness` is not in a group_leader's allowed API prefixes at all.
  const isGroupLeader = me.role === AccountRole.GroupLeader;

  // An add-on module: the nav entry is already gone when it is off, so this
  // only catches a bookmark or a pasted link (rule G2) — nothing below may
  // fetch, or the page would paint the API's own refusal as an error banner
  // instead of the reason.
  const happinessOn = useModuleEnabled(MODULE_HAPPINESS);
  const terms = useFetch<HappinessTermRow[]>(happinessOn && !isGroupLeader ? '/happiness/terms' : null);

  const [formTerm, setFormTerm] = useState<HappinessTermRow | 'new' | null>(null);

  usePageChrome({ title: t('happy.title') }, [t]);

  const now = new Date();
  const list = terms.data ?? [];
  const { current, upcoming, ended } = useMemo(() => {
    const c: HappinessTermRow[] = [];
    const u: HappinessTermRow[] = [];
    const e: HappinessTermRow[] = [];
    for (const term of list) {
      const endsAfter = endOfChurchDate(term.ends_on);
      if (endsAfter !== null && endsAfter <= now) {
        e.push(term);
        continue;
      }
      const startsAt = startOfChurchDate(term.starts_on);
      if (startsAt !== null && startsAt > now) u.push(term);
      else c.push(term);
    }
    const byNoDesc = (a: HappinessTermRow, b: HappinessTermRow) => b.term_no - a.term_no;
    return { current: c.sort(byNoDesc), upcoming: u.sort(byNoDesc), ended: e.sort(byNoDesc) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  const exportTerms = () => {
    exportRows(
      t('happy.title'),
      t('happy.term.col.no'),
      [...current, ...upcoming, ...ended].map((term) => ({
        [t('happy.term.col.no')]: term.term_no,
        [t('happy.term.col.name')]: term.name ?? '',
        [t('happy.term.col.dates')]: formatDateRange(term.starts_on, term.ends_on),
        [t('happy.term.col.weeks')]: term.weeks,
        [t('happy.term.col.groups')]: term.group_count,
      })),
    );
  };

  const deleteTerm = async (term: HappinessTermRow) => {
    const ok = await confirm({
      title: t('happy.term.delete.title'),
      message: t('happy.term.delete.message', { no: term.term_no, n: term.group_count }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/happiness/terms/${term.id}`);
      terms.reload();
      toast(t('happy.term.toast.deleted'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (isGroupLeader) return <RoleRestricted />;
  if (!happinessOn) return <ModuleDisabled name={t('module.happiness.name')} />;

  const renderCards = (items: HappinessTermRow[], faded?: boolean) => (
    <div className="grid g3">
      {items.map((term) => (
        <div className="card" key={term.id} style={{ display: 'flex', flexDirection: 'column', opacity: faded ? 0.86 : 1 }}>
          <span className="badge b-accent" style={{ alignSelf: 'flex-start' }}>
            {t('happy.term.pageTitle', { no: term.term_no })}
          </span>
          <h3
            style={{ margin: '12px 0 2px', fontSize: 16, cursor: 'pointer' }}
            className="serif"
            onClick={() => router.push(`/happiness/${term.id}`)}
          >
            {term.name || t('happy.term.pageTitle', { no: term.term_no })}
          </h3>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            {formatDateRange(term.starts_on, term.ends_on)} · {t('happy.term.weeksLabel', { n: term.weeks })} · {t('happy.term.groupCount', { n: term.group_count })}
          </div>
          <div className="grow" />
          <div className="flex gap-8 mt-14">
            <button className="btn sm grow" onClick={() => router.push(`/happiness/${term.id}`)}>{t('happy.term.viewGroups')}</button>
            {perms.write && <button className="btn ghost sm" onClick={() => setFormTerm(term)}>{t('happy.term.edit')}</button>}
            {perms.delete && (
              <button className="btn ghost sm" style={{ color: 'var(--crit)' }} onClick={() => deleteTerm(term)}>
                {t('common.delete')}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <ErrorBanner message={terms.error} />

      <PageBar
        actions={
          <>
            <ExportButton onClick={exportTerms} disabled={list.length === 0} />
            {perms.write && (
              <button className="btn" onClick={() => setFormTerm('new')}>{t('happy.term.add')}</button>
            )}
          </>
        }
      />

      <div className="section-label mb-14">
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--good)', display: 'inline-block' }} />
        {t('happy.term.current')}
      </div>
      {terms.initialLoading ? (
        <SkeletonScreen>
          <SkeletonCards count={3} lines={3} />
        </SkeletonScreen>
      ) : current.length ? (
        renderCards(current)
      ) : (
        <div className="empty">{t('happy.term.emptyCurrent')}</div>
      )}

      <div className="section-label" style={{ margin: '28px 0 14px' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--brand)', display: 'inline-block' }} />
        {t('happy.term.upcoming')}
      </div>
      {terms.initialLoading ? (
        <SkeletonCards count={3} lines={3} />
      ) : upcoming.length ? (
        renderCards(upcoming)
      ) : (
        <div className="empty">{t('happy.term.emptyUpcoming')}</div>
      )}

      <div className="section-label" style={{ margin: '28px 0 14px' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--faint)', display: 'inline-block' }} />
        {t('happy.term.ended')}
      </div>
      {terms.initialLoading ? (
        <SkeletonCards count={3} lines={3} />
      ) : ended.length ? (
        renderCards(ended, true)
      ) : (
        <div className="empty">{t('happy.term.emptyEnded')}</div>
      )}

      {formTerm && (
        <TermModal
          term={formTerm === 'new' ? null : formTerm}
          onClose={() => setFormTerm(null)}
          onSaved={(created) => {
            setFormTerm(null);
            terms.reload();
            toast(created ? t('happy.term.toast.created') : t('happy.term.toast.saved'));
          }}
        />
      )}
    </>
  );
}

function TermModal({
  term,
  onClose,
  onSaved,
}: {
  term: HappinessTermRow | null;
  onClose: () => void;
  onSaved: (created: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [name, setName] = useState(term?.name ?? '');
  const [weeks, setWeeks] = useState(term ? String(term.weeks) : '8');
  const [startsOn, setStartsOn] = useState(term?.starts_on ?? '');
  const [endsOn, setEndsOn] = useState(term?.ends_on ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setErr(t('happy.term.err.name'));
      return;
    }
    const weeksN = Number(weeks);
    if (!Number.isInteger(weeksN) || weeksN < 1 || weeksN > 52) {
      setErr(t('happy.term.err.weeks'));
      return;
    }
    setSaving(true);
    setErr(null);
    const dto = {
      name: name.trim(),
      weeks: weeksN,
      starts_on: startsOn || null,
      ends_on: endsOn || null,
    };
    try {
      if (term) {
        await api.patch(`/happiness/terms/${term.id}`, dto);
        onSaved(false);
      } else {
        await api.post('/happiness/terms', dto);
        onSaved(true);
      }
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={term ? t('happy.term.edit.title') : t('happy.term.new.title')} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <div className="form-row">
        <Field label={t('happy.term.field.name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('happy.term.namePlaceholder')} />
        </Field>
        <Field label={t('happy.term.field.weeks')}>
          <input type="number" min={1} max={52} step={1} value={weeks} onChange={(e) => setWeeks(e.target.value)} />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('happy.term.field.startsOn')}>
          <input type="date" className={startsOn ? undefined : 'date-empty'} value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </Field>
        <Field label={t('happy.term.field.endsOn')}>
          <input type="date" className={endsOn ? undefined : 'date-empty'} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </Field>
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>
  );
}
