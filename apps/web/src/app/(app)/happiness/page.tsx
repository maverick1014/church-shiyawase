'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import {
  ChevronRightIcon,
  ErrorBanner,
  ExportButton,
  Field,
  Modal,
  ModuleDisabled,
  PageBar,
  RoleRestricted,
  RowChevron,
  SkeletonScreen,
  SkeletonTable,
  SortTh,
  useConfirm,
  useToast,
} from '@/components/ui';
import { can } from '@/lib/perms';
import { useModuleEnabled } from '@/lib/church';
import { exportRows } from '@/lib/export';
import { formatDate } from '@/lib/labels';
import { HappinessTermRow } from '@/lib/types';
import { useT } from '@/lib/i18n';
import { AccountRole, MODULE_HAPPINESS } from '@tog/shared';

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

  const { sorted, sortKey, sortDir, toggleSort } = useSortableRows(
    terms.data ?? [],
    (term, key) => {
      switch (key) {
        case 'name':
          return term.name ?? '';
        case 'weeks':
          return term.weeks;
        case 'groups':
          return term.group_count;
        case 'starts':
          return term.starts_on ?? '';
        default:
          return term.term_no;
      }
    },
    { key: 'no', dir: 'desc' },
  );

  const exportTerms = () => {
    exportRows(
      t('happy.title'),
      t('happy.term.col.no'),
      sorted.map((term) => ({
        [t('happy.term.col.no')]: term.term_no,
        [t('happy.term.col.name')]: term.name ?? '',
        [t('happy.term.col.dates')]: `${formatDate(term.starts_on)} – ${formatDate(term.ends_on)}`,
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

  return (
    <>
      <ErrorBanner message={terms.error} />

      <PageBar
        actions={
          <>
            <ExportButton onClick={exportTerms} disabled={sorted.length === 0} />
            {perms.write && (
              <button className="btn" onClick={() => setFormTerm('new')}>{t('happy.term.add')}</button>
            )}
          </>
        }
      />

      {terms.initialLoading ? (
        <SkeletonScreen>
          <SkeletonTable rows={6} columns={5} />
        </SkeletonScreen>
      ) : (
        <>
          {/* Desktop — table */}
          <div className="card only-desktop" style={{ padding: 6 }}>
            <div className="table-wrap">
              <table className="table-fixed">
                <thead>
                  <tr>
                    <SortTh sortKey="no" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('happy.term.col.no')}</SortTh>
                    <SortTh sortKey="name" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('happy.term.col.name')}</SortTh>
                    <SortTh sortKey="starts" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('happy.term.col.dates')}</SortTh>
                    <SortTh sortKey="weeks" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('happy.term.col.weeks')}</SortTh>
                    <SortTh sortKey="groups" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('happy.term.col.groups')}</SortTh>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((term) => (
                    <tr key={term.id} onClick={() => router.push(`/happiness/${term.id}`)} style={{ cursor: 'pointer' }}>
                      <td className="tnum"><strong>{term.term_no}</strong></td>
                      <td>{term.name || <span className="faint">—</span>}</td>
                      <td className="muted">{formatDate(term.starts_on)} – {formatDate(term.ends_on)}</td>
                      <td className="muted tnum">{term.weeks}</td>
                      <td className="muted tnum">{term.group_count}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                        {perms.write && (
                          <button className="btn ghost sm" style={{ marginRight: 6 }} onClick={() => setFormTerm(term)}>
                            {t('happy.term.edit')}
                          </button>
                        )}
                        {perms.delete && (
                          <button className="btn ghost sm" style={{ color: 'var(--crit)', marginRight: 6 }} onClick={() => deleteTerm(term)}>
                            {t('common.delete')}
                          </button>
                        )}
                        <RowChevron title={t('happy.term.viewGroups')} onClick={() => router.push(`/happiness/${term.id}`)} />
                      </td>
                    </tr>
                  ))}
                  {sorted.length === 0 && (
                    <tr><td colSpan={6} className="empty-inline">{t('happy.term.empty')}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile — list tiles */}
          <div className="only-mobile">
            {sorted.map((term) => (
              <div key={term.id} className="mtile" onClick={() => router.push(`/happiness/${term.id}`)}>
                <div className="mtile-row1">
                  <div style={{ minWidth: 0 }}>
                    <strong>{t('happy.term.pageTitle', { no: term.term_no })}</strong>
                    {term.name && <span className="muted" style={{ fontSize: 12.5 }}> {term.name}</span>}
                  </div>
                  <span className="mtile-cta"><ChevronRightIcon /></span>
                </div>
                <div className="mtile-line flex items-center gap-8 flex-wrap">
                  <span>
                    {formatDate(term.starts_on)} – {formatDate(term.ends_on)} · {t('happy.term.weeksLabel', { n: term.weeks })} · {t('happy.term.groupCount', { n: term.group_count })}
                  </span>
                </div>
                {(perms.write || perms.delete) && (
                  <div className="flex gap-10" style={{ marginTop: 8 }}>
                    {perms.write && (
                      <button className="tile-action" onClick={(e) => { e.stopPropagation(); setFormTerm(term); }}>
                        {t('happy.term.edit')}
                      </button>
                    )}
                    {perms.delete && (
                      <button
                        className="tile-action"
                        style={{ color: 'var(--crit)' }}
                        onClick={(e) => { e.stopPropagation(); deleteTerm(term); }}
                      >
                        {t('common.delete')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {sorted.length === 0 && <div className="empty-inline">{t('happy.term.empty')}</div>}
          </div>
        </>
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
  const [termNo, setTermNo] = useState(term ? String(term.term_no) : '');
  const [name, setName] = useState(term?.name ?? '');
  const [weeks, setWeeks] = useState(term ? String(term.weeks) : '8');
  const [startsOn, setStartsOn] = useState(term?.starts_on ?? '');
  const [endsOn, setEndsOn] = useState(term?.ends_on ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    const no = Number(termNo);
    if (!termNo || !Number.isInteger(no) || no < 1) {
      setErr(t('happy.term.err.no'));
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
      term_no: no,
      name: name.trim() || null,
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
        <Field label={t('happy.term.field.no')}>
          <input type="number" min={1} step={1} value={termNo} onChange={(e) => setTermNo(e.target.value)} />
        </Field>
        <Field label={t('happy.term.field.weeks')}>
          <input type="number" min={1} max={52} step={1} value={weeks} onChange={(e) => setWeeks(e.target.value)} />
        </Field>
      </div>
      <Field label={t('happy.term.field.name')}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('happy.term.namePlaceholder')} />
      </Field>
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
