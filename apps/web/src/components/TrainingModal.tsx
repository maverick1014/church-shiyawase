'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner, Field, HallSelect, Modal, useToast } from '@/components/ui';
import { useHallScope } from '@/lib/hall';
import { MemberRow, TrainingRow } from '@/lib/types';
import { TRAINING_CATEGORIES, trainingCategoryLabel } from '@/lib/labels';
import { useT } from '@/lib/i18n';
import { TrainingKind } from '@tog/shared';

/**
 * Add / edit one row of 培训&活动 — a course or a one-off activity.
 *
 * Both shapes are the same record (migration 0014), so this is one form with
 * one save path; only the fields that genuinely differ branch:
 *
 *   course   — how many sessions, and the range it runs over (start / end).
 *   activity — a single DATE, which is stored as both `starts_on` and
 *              `ends_on` so "has it finished?" is the same question for both
 *              shapes and nothing has to special-case the catalog.
 *
 * `kind` is fixed at creation and never offered as a field: an activity's
 * single occasion is a session row the API creates with it, so flipping the
 * shape of an existing row would leave that plumbing behind.
 */
export function TrainingModal({
  members,
  initial,
  kind: newKind,
  onClose,
  onSaved,
  onDelete,
}: {
  members: MemberRow[];
  initial?: TrainingRow;
  /** Which shape to CREATE. Editing takes the row's own kind instead. */
  kind?: TrainingKind;
  onClose: () => void;
  onSaved: (id: string) => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const { hallId } = useHallScope();
  const kind = initial?.kind ?? newKind ?? TrainingKind.Course;
  const activity = kind === TrainingKind.Activity;
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    category: initial?.category ?? TRAINING_CATEGORIES[0],
    total_sessions: initial?.total_sessions ?? 3,
    trainer_id: initial?.trainer_id ?? '',
    starts_on: initial?.starts_on?.slice(0, 10) ?? '',
    ends_on: initial?.ends_on?.slice(0, 10) ?? '',
    is_enrollable: initial?.is_enrollable ?? true,
    // Editing keeps the course's own hall; creating defaults to the hall being
    // viewed (and to the open-to-all option only when viewing all halls).
    hall_id: initial ? initial.hall_id : hallId || null,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  const save = async () => {
    if (!form.name.trim()) {
      setErr(t('trainings.err.name'));
      return;
    }
    setSaving(true);
    setErr(null);
    const body = {
      name: form.name.trim(),
      kind,
      category: form.category,
      // An activity is one occasion — the server forces this too (rule G2), so
      // a stale client can never leave a two-session activity behind.
      total_sessions: activity ? 1 : Number(form.total_sessions) || 1,
      trainer_id: form.trainer_id || undefined,
      starts_on: form.starts_on || undefined,
      // One day, so an activity starts and ends on the same date.
      ends_on: (activity ? form.starts_on : form.ends_on) || undefined,
      is_enrollable: form.is_enrollable,
      hall_id: form.hall_id,
    };
    try {
      const saved = initial
        ? await api.patch<TrainingRow>(`/trainings/${initial.id}`, body)
        : await api.post<TrainingRow>('/trainings', body);
      onSaved(saved.id);
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const title = initial
    ? activity ? t('trainings.edit.activityTitle') : t('trainings.edit.title')
    : activity ? t('trainings.new.activityTitle') : t('trainings.new.title');

  return (
    <Modal title={title} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <Field label={activity ? t('trainings.field.activityName') : t('trainings.field.name')}>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder={activity ? t('trainings.activityNamePlaceholder') : t('trainings.namePlaceholder')}
        />
      </Field>
      <div className="form-row">
        <Field label={t('trainings.field.category')}>
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {TRAINING_CATEGORIES.map((c) => (
              <option key={c} value={c}>{trainingCategoryLabel(c, t)}</option>
            ))}
          </select>
        </Field>
        {activity ? (
          <Field label={t('trainings.field.date')}>
            <input
              type="date"
              className={form.starts_on ? undefined : 'date-empty'}
              value={form.starts_on}
              onChange={(e) => setForm({ ...form, starts_on: e.target.value })}
            />
          </Field>
        ) : (
          <Field label={t('trainings.field.sessions')}>
            <input type="number" value={form.total_sessions} onChange={(e) => setForm({ ...form, total_sessions: Number(e.target.value) })} />
          </Field>
        )}
      </div>
      <div className="form-row">
        <Field label={activity ? t('trainings.field.host') : t('trainings.field.trainer')}>
          <select value={form.trainer_id} onChange={(e) => setForm({ ...form, trainer_id: e.target.value })}>
            <option value="">{t('common.pending')}</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.full_name}</option>
            ))}
          </select>
        </Field>
        <Field label={t('hall.label')}>
          <HallSelect
            value={form.hall_id}
            onChange={(id) => setForm({ ...form, hall_id: id })}
            allowAll
            allLabel={t('hall.allOpen')}
          />
        </Field>
      </div>
      {!activity && (
        <div className="form-row">
          <Field label={t('trainings.field.startsOn')}>
            <input type="date" className={form.starts_on ? undefined : 'date-empty'} value={form.starts_on} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} />
          </Field>
          <Field label={t('trainings.field.endsOn')}>
            <input type="date" className={form.ends_on ? undefined : 'date-empty'} value={form.ends_on} onChange={(e) => setForm({ ...form, ends_on: e.target.value })} />
          </Field>
        </div>
      )}
      <label className="flex items-center gap-8" style={{ fontSize: 13, fontWeight: 500, margin: '4px 0 18px', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={form.is_enrollable}
          onChange={(e) => setForm({ ...form, is_enrollable: e.target.checked })}
          style={{ width: 16, height: 16, accentColor: 'var(--brand)' }}
        />
        {t('trainings.field.enrollable')}
      </label>
      <div className="modal-actions">
        {onDelete && (
          <button
            className="btn danger"
            style={{ marginRight: 'auto' }}
            onClick={onDelete}
          >
            {activity ? t('trainings.deleteActivity') : t('trainings.delete')}
          </button>
        )}
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>
  );
}
