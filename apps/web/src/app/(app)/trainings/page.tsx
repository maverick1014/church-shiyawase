'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import { ErrorBanner, PageBar, SkeletonCards, SkeletonScreen, useConfirm, useToast } from '@/components/ui';
import { TrainingModal } from '@/components/TrainingModal';
import { can } from '@/lib/perms';
import { MemberRow, TrainingRow } from '@/lib/types';
import { categoryBadgeClass, formatDate, trainingCategoryLabel } from '@/lib/labels';
import { endOfChurchDate } from '@/lib/time';
import { useT } from '@/lib/i18n';

export default function TrainingsPage() {
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const perms = can(useMe().role);
  const trainings = useFetch<TrainingRow[]>('/trainings');
  const members = useFetch<MemberRow[]>('/members');
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<TrainingRow | null>(null);

  usePageChrome({ title: t('trainings.title') }, [t]);

  const now = new Date();
  const list = trainings.data ?? [];
  const { active, ended } = useMemo(() => {
    const a: TrainingRow[] = [];
    const e: TrainingRow[] = [];
    for (const course of list) {
      // ends_on is a DATE and covers its whole Malaysian day — comparing
      // against new Date(ends_on) retired the course at 08:00 that morning,
      // because a bare date parses as UTC midnight.
      const endsAfter = endOfChurchDate(course.ends_on);
      const isEnded = !!endsAfter && endsAfter <= now;
      if (isEnded || !course.is_enrollable) e.push(course);
      else a.push(course);
    }
    return { active: a, ended: e };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  const del = async (course: TrainingRow): Promise<boolean> => {
    const ok = await confirm({
      title: t('trainings.delete.title'),
      message: t('trainings.delete.message', { name: course.name }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return false;
    try {
      await api.delete(`/trainings/${course.id}`);
      trainings.reload();
      toast(t('trainings.toast.deleted'));
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
          <div className="flex-between">
            <span className={`badge ${categoryBadgeClass(course.category)}`}>
              {trainingCategoryLabel(course.category, t) || t('trainings.defaultCategory')}
            </span>
            <span className={`badge ${course.is_enrollable ? 'b-good' : 'b-gray'}`}>
              {course.is_enrollable ? t('trainings.open') : t('trainings.closed')}
            </span>
          </div>
          <h3 style={{ margin: '12px 0 2px', fontSize: 16, cursor: 'pointer' }} className="serif" onClick={() => router.push(`/trainings/${course.id}`)}>
            {course.name}
          </h3>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {t('trainings.trainer', { name: course.trainer?.full_name ?? t('common.pending') })}
            {' · '}
            {t('trainings.sessions', { n: course.total_sessions })}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            {t('trainings.dateRange', {
              from: formatDate(course.starts_on),
              to: formatDate(course.ends_on),
            })}
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

  // The add button and both section headings are static, so they render at
  // once and only the two catalog grids below them wait on the fetch.
  return (
    <>
      <ErrorBanner message={trainings.error} />

      {perms.write && (
        <PageBar
          actions={<button className="btn" onClick={() => setAddOpen(true)}>{t('trainings.add')}</button>}
        />
      )}

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

      {(addOpen || editing) && (
        <TrainingModal
          members={members.data ?? []}
          initial={editing ?? undefined}
          onClose={() => {
            setAddOpen(false);
            setEditing(null);
          }}
          onSaved={(id) => {
            const wasEdit = !!editing;
            setAddOpen(false);
            setEditing(null);
            trainings.reload();
            toast(wasEdit ? t('trainings.toast.updated') : t('trainings.toast.created'));
            if (!wasEdit) router.push(`/trainings/${id}`);
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

