'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import { ErrorBanner, PageBar, SkeletonCards, SkeletonScreen, useConfirm, useToast } from '@/components/ui';
import { TrainingModal } from '@/components/TrainingModal';
import { can } from '@/lib/perms';
import { TrainingRow } from '@/lib/types';
import {
  formatMoney,
  hasFee,
  trainingKindClass,
  trainingKindKey,
  trainingMeta,
} from '@/lib/labels';
import { endOfChurchDate } from '@/lib/time';
import { useT } from '@/lib/i18n';
import { TRAINING_KINDS, TrainingKind } from '@tog/shared';

/**
 * 培训&活动 — one catalog, two shapes (`kind`, migration 0014).
 *
 * A COURSE runs over several sessions; an ACTIVITY is one occasion people sign
 * up for and get ticked off at (兄弟团爬山, 姐妹团做蛋糕). They are the same
 * record — sign-ups and a roll call — so they share this page, the detail page
 * and the public sign-up link; only the wording and the shape-specific fields
 * differ, and the filter here lets one be read without the other.
 */
export default function TrainingsPage() {
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const perms = can(useMe().role);
  const trainings = useFetch<TrainingRow[]>('/trainings');
  // Which shape to CREATE — also what tells the modal apart from an edit.
  const [adding, setAdding] = useState<TrainingKind | null>(null);
  const [editing, setEditing] = useState<TrainingRow | null>(null);
  // '' = both. The stored code, never a label, so it survives a language
  // switch (rule G8).
  const [kindFilter, setKindFilter] = useState<TrainingKind | ''>('');

  usePageChrome({ title: t('trainings.title') }, [t]);

  const now = new Date();
  const list = trainings.data ?? [];
  const { active, ended } = useMemo(() => {
    const a: TrainingRow[] = [];
    const e: TrainingRow[] = [];
    for (const course of list) {
      if (kindFilter && course.kind !== kindFilter) continue;
      // ends_on is a DATE and covers its whole Malaysian day — comparing
      // against new Date(ends_on) retired the course at 08:00 that morning,
      // because a bare date parses as UTC midnight. An activity stores its one
      // day as both starts_on and ends_on, so the same test retires it the day
      // after it happened.
      const endsAfter = endOfChurchDate(course.ends_on);
      const isEnded = !!endsAfter && endsAfter <= now;
      if (isEnded || !course.is_enrollable) e.push(course);
      else a.push(course);
    }
    return { active: a, ended: e };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, kindFilter]);

  const del = async (course: TrainingRow): Promise<boolean> => {
    const isActivity = course.kind === TrainingKind.Activity;
    const ok = await confirm({
      title: isActivity ? t('trainings.deleteActivity.title') : t('trainings.delete.title'),
      message: t('trainings.delete.message', { name: course.name }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return false;
    try {
      await api.delete(`/trainings/${course.id}`);
      trainings.reload();
      toast(isActivity ? t('trainings.toast.activityDeleted') : t('trainings.toast.deleted'));
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    }
  };

  const renderCards = (items: TrainingRow[], faded?: boolean) => (
    <div className="grid g3">
      {items.map((course) => (
        <div className="card" key={course.id} style={{ display: 'flex', flexDirection: 'column', opacity: faded ? 0.86 : 1 }}>
          <div className="flex-between flex-wrap gap-8">
            <div className="flex items-center gap-6 flex-wrap">
              <span className={`badge ${trainingKindClass(course.kind)}`}>
                {t(trainingKindKey(course.kind))}
              </span>
              {/* 报名费 — only a paid row says anything, so a free one reads
                  exactly as it did before (0016). */}
              {hasFee(course.fee) && (
                <span className="badge b-accent">
                  {t('trainings.fee', { amount: formatMoney(course.fee) })}
                </span>
              )}
            </div>
            <span className={`badge ${course.is_enrollable ? 'b-good' : 'b-gray'}`}>
              {course.is_enrollable ? t('trainings.open') : t('trainings.closed')}
            </span>
          </div>
          <h3 style={{ margin: '12px 0 2px', fontSize: 16, cursor: 'pointer' }} className="serif" onClick={() => router.push(`/trainings/${course.id}`)}>
            {course.name}
          </h3>
          {/* The same "who and when" line the detail page shows, built once in
              lib/labels.ts so the two can never drift (rule G4). */}
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            {trainingMeta(course, t).join(' · ')}
          </div>
          <div className="grow" />
          <div className="flex gap-8 mt-14">
            <button className="btn sm grow" onClick={() => router.push(`/trainings/${course.id}`)}>{t('trainings.roster')}</button>
            {perms.write && <button className="btn ghost sm" onClick={() => setEditing(course)}>{t('common.edit')}</button>}
          </div>
        </div>
      ))}
    </div>
  );

  // The bar and both section headings are static, so they render at once and
  // only the two catalog grids below them wait on the fetch.
  return (
    <>
      <ErrorBanner message={trainings.error} />

      <PageBar
        filters={
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as TrainingKind | '')}
            aria-label={t('trainings.filter.allKinds')}
          >
            <option value="">{t('trainings.filter.allKinds')}</option>
            {TRAINING_KINDS.map((k) => (
              <option key={k} value={k}>
                {k === TrainingKind.Activity ? t('trainings.filter.activities') : t('trainings.filter.courses')}
              </option>
            ))}
          </select>
        }
        actions={
          perms.write ? (
            <>
              <button className="btn ghost" onClick={() => setAdding(TrainingKind.Activity)}>{t('trainings.addActivity')}</button>
              <button className="btn" onClick={() => setAdding(TrainingKind.Course)}>{t('trainings.add')}</button>
            </>
          ) : undefined
        }
      />

      <div className="section-label mb-14">
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--good)', display: 'inline-block' }} />
        {t('trainings.active')} <span className="faint" style={{ fontWeight: 400 }}>{t('trainings.activeSub')}</span>
      </div>
      {trainings.initialLoading ? (
        <SkeletonScreen>
          <SkeletonCards count={3} lines={3} />
        </SkeletonScreen>
      ) : active.length ? (
        renderCards(active)
      ) : (
        <div className="empty">{t('trainings.emptyActive')}</div>
      )}

      <div className="section-label" style={{ margin: '28px 0 14px' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--faint)', display: 'inline-block' }} />
        {t('trainings.ended')} <span className="faint" style={{ fontWeight: 400 }}>{t('trainings.endedSub')}</span>
      </div>
      {/* Bare skeletons, not a second <SkeletonScreen>: the live region above
          has already announced the wait, and announcing it twice is noise. */}
      {trainings.initialLoading ? (
        <SkeletonCards count={3} lines={3} />
      ) : ended.length ? (
        renderCards(ended, true)
      ) : (
        <div className="empty">{t('trainings.emptyEnded')}</div>
      )}

      {(adding || editing) && (
        <TrainingModal
          initial={editing ?? undefined}
          kind={adding ?? undefined}
          onClose={() => {
            setAdding(null);
            setEditing(null);
          }}
          onSaved={(saved) => {
            const edited = editing;
            // The SAVED row's kind, never the one the modal opened on: a row
            // that was just converted has to be reported as what it now is.
            const isActivity = saved.kind === TrainingKind.Activity;
            setAdding(null);
            setEditing(null);
            trainings.reload();
            if (edited)
              toast(isActivity ? t('trainings.toast.activityUpdated') : t('trainings.toast.updated'));
            else {
              toast(isActivity ? t('trainings.toast.activityCreated') : t('trainings.toast.created'));
              router.push(`/trainings/${saved.id}`);
            }
          }}
          onDelete={
            editing && perms.delete
              ? async () => {
                  if (await del(editing)) setEditing(null);
                }
              : undefined
          }
        />
      )}
    </>
  );
}
