'use client';

import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  ErrorBanner,
  Field,
  HallSelect,
  Modal,
  Segmented,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useHallScope } from '@/lib/hall';
import { NamelistResponse, TrainingDetail, TrainingRow } from '@/lib/types';
import { hasFee } from '@/lib/labels';
import { useT } from '@/lib/i18n';
import { TrainingKind } from '@tog/shared';

/**
 * Add / edit one row of 培训&活动 — a course or a one-off activity.
 *
 * Both shapes are the same record (migration 0014), so this is one form with
 * one save path; only the fields that genuinely differ branch:
 *
 *   course   — how many sessions, and the range it runs over (start / end).
 *   activity — a single DATE plus a TIME and a MEETING POINT, all three stored
 *              on the training row itself (0016). The date is written to both
 *              `starts_on` and `ends_on` so "has it finished?" is the same
 *              question for both shapes, and the time and place live beside it
 *              rather than on the activity's single session row — that row is
 *              plumbing the API creates for the roll call, and putting the
 *              time on it would give one occasion two places to be edited.
 *
 * `kind` is CONVERTIBLE (0016): a course that turned out to be one afternoon
 * becomes an activity, and an activity that grew becomes a course. Only one
 * direction destroys anything — an activity is one occasion, so a course's
 * sessions above the first go — and that direction asks first, naming exactly
 * what it deletes (rule G3). The server owns the invariant either way.
 */
export function TrainingModal({
  initial,
  kind: newKind,
  onClose,
  onSaved,
  onDelete,
}: {
  initial?: TrainingRow;
  /** Which shape to CREATE. Editing starts from the row's own kind. */
  kind?: TrainingKind;
  onClose: () => void;
  /** The row as it was SAVED — its `kind` is the shape it now is. */
  onSaved: (saved: TrainingRow) => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const confirm = useConfirm();
  const { hallId } = useHallScope();
  const [kind, setKind] = useState<TrainingKind>(
    initial?.kind ?? newKind ?? TrainingKind.Course,
  );
  const activity = kind === TrainingKind.Activity;
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    total_sessions: initial?.total_sessions ?? 3,
    pic: initial?.pic ?? '',
    pic_contact: initial?.pic_contact ?? '',
    starts_on: initial?.starts_on?.slice(0, 10) ?? '',
    ends_on: initial?.ends_on?.slice(0, 10) ?? '',
    // Postgres `time` reads back as "HH:MM:SS"; the input wants "HH:MM".
    start_time: initial?.start_time?.slice(0, 5) ?? '',
    location: initial?.location ?? '',
    fee: initial?.fee === null || initial?.fee === undefined ? '' : String(initial.fee),
    payment_instructions: initial?.payment_instructions ?? '',
    is_enrollable: initial?.is_enrollable ?? true,
    // Editing keeps the course's own hall; creating defaults to the hall being
    // viewed (and to the open-to-all option only when viewing all halls).
    hall_id: initial ? initial.hall_id : hallId || null,
  });
  // The QR lives on the row, not in the form: it is uploaded straight away
  // like every other image in this app (rule G4), so this only tracks what the
  // saved row currently carries.
  const [qrUrl, setQrUrl] = useState(initial?.payment_qr_url ?? null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const qrRef = useRef<HTMLInputElement>(null);
  // A fee turns the payment block on. Typed rather than stored, so clearing
  // the field hides it again immediately (rule G5).
  const paid = hasFee(form.fee);

  /**
   * Turning a course into an activity keeps ONLY its first session. Ask before
   * that costs anybody a roll call, and say exactly how much goes — read from
   * the server at the moment of the decision rather than kept in state.
   */
  const confirmConversion = async (): Promise<boolean> => {
    if (!initial || initial.kind !== TrainingKind.Course || !activity) return true;
    const [detail, namelist] = await Promise.all([
      api.get<TrainingDetail>(`/trainings/${initial.id}`),
      api.get<NamelistResponse>(`/trainings/${initial.id}/namelist`),
    ]);
    const sessions = detail.sessions ?? [];
    if (sessions.length <= 1) return true; // nothing is lost
    const doomed = new Set(sessions.slice(1).map((s) => s.id));
    const ticks = (namelist.rows ?? []).reduce(
      (n, row) =>
        n + (row.attendance ?? []).filter((a) => a.attended && doomed.has(a.session_id)).length,
      0,
    );
    return confirm({
      title: t('trainings.convert.title'),
      message: t('trainings.convert.message', {
        name: initial.name,
        sessions: doomed.size,
        ticks,
      }),
      confirmText: t('trainings.convert.confirm'),
      danger: true,
    });
  };

  const save = async () => {
    if (!form.name.trim()) {
      setErr(t('trainings.err.name'));
      return;
    }
    if (!(await confirmConversion())) return;
    setSaving(true);
    setErr(null);
    const body = {
      name: form.name.trim(),
      kind,
      // An activity is one occasion — the server forces this too (rule G2), so
      // a stale client can never leave a two-session activity behind.
      total_sessions: activity ? 1 : Number(form.total_sessions) || 1,
      pic: form.pic.trim(),
      pic_contact: form.pic_contact.trim(),
      starts_on: form.starts_on || undefined,
      // One day, so an activity starts and ends on the same date.
      ends_on: (activity ? form.starts_on : form.ends_on) || undefined,
      // Time and place belong to an occasion, so a course clears them rather
      // than keeping values nothing on its page can show.
      start_time: activity ? form.start_time : '',
      location: activity ? form.location.trim() : '',
      fee: form.fee.trim(),
      payment_instructions: paid ? form.payment_instructions.trim() : '',
      is_enrollable: form.is_enrollable,
      hall_id: form.hall_id,
    };
    try {
      const saved = initial
        ? await api.patch<TrainingRow>(`/trainings/${initial.id}`, body)
        : await api.post<TrainingRow>('/trainings', body);
      onSaved(saved);
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  // The same upload path a member's photo and the church logo take: straight
  // to the row, so the QR is never half-saved with the form (rule G4).
  const onPickQr = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !initial) return;
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const row = await api.upload<TrainingRow>(`/trainings/${initial.id}/payment-qr`, fd);
      setQrUrl(row.payment_qr_url);
      toast(t('trainings.toast.qr'));
    } catch (e2) {
      setErr((e2 as Error).message);
      toast((e2 as Error).message, 'error');
    } finally {
      setUploading(false);
      if (qrRef.current) qrRef.current.value = '';
    }
  };

  // Discarding the uploaded image is irreversible from here, so it asks first
  // (rule G3) — the same shape as removing the church logo.
  const removeQr = async () => {
    if (!initial) return;
    const ok = await confirm({
      title: t('trainings.qr.remove.title'),
      message: t('trainings.qr.remove.message'),
      confirmText: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.patch(`/trainings/${initial.id}`, { payment_qr_url: null });
      setQrUrl(null);
      toast(t('trainings.toast.qrRemoved'));
    } catch (e) {
      toast((e as Error).message, 'error');
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
      {/* Which shape this row is — the one segmented control (rule G4), keyed
          by the stored code so a language switch cannot change it (G8). */}
      <Field label={t('trainings.field.kind')}>
        <Segmented
          value={kind}
          onChange={setKind}
          label={t('trainings.field.kind')}
          block
          options={[
            { value: TrainingKind.Course, label: t('trainingKind.course') },
            { value: TrainingKind.Activity, label: t('trainingKind.activity') },
          ]}
        />
      </Field>
      <div className="form-row">
        <Field label={t('trainings.field.pic')}>
          {/* Free text, never a member picker: the person in charge is often an
              outside speaker or a camp organiser with no member record. */}
          <input
            value={form.pic}
            onChange={(e) => setForm({ ...form, pic: e.target.value })}
            placeholder={t('trainings.picPlaceholder')}
          />
        </Field>
        <Field label={t('trainings.field.picContact')}>
          <input
            value={form.pic_contact}
            onChange={(e) => setForm({ ...form, pic_contact: e.target.value })}
            placeholder={t('trainings.picContactPlaceholder')}
            inputMode="tel"
          />
        </Field>
      </div>
      {activity ? (
        <>
          <div className="form-row">
            <Field label={t('trainings.field.date')}>
              <input
                type="date"
                className={form.starts_on ? undefined : 'date-empty'}
                value={form.starts_on}
                onChange={(e) => setForm({ ...form, starts_on: e.target.value })}
              />
            </Field>
            <Field label={t('trainings.field.time')}>
              {/* A bare `time` is a Malaysian wall-clock reading — no zone
                  conversion, so it cannot render an hour out (rule G6a). */}
              <input
                type="time"
                className={form.start_time ? undefined : 'date-empty'}
                value={form.start_time}
                onChange={(e) => setForm({ ...form, start_time: e.target.value })}
              />
            </Field>
          </div>
          <Field label={t('trainings.field.location')}>
            <input
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              placeholder={t('trainings.locationPlaceholder')}
            />
          </Field>
        </>
      ) : (
        <>
          <div className="form-row">
            <Field label={t('trainings.field.sessions')}>
              <input type="number" min={1} value={form.total_sessions} onChange={(e) => setForm({ ...form, total_sessions: Number(e.target.value) })} />
            </Field>
            <Field label={t('trainings.field.startsOn')}>
              <input type="date" className={form.starts_on ? undefined : 'date-empty'} value={form.starts_on} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} />
            </Field>
          </div>
          <Field label={t('trainings.field.endsOn')}>
            <input type="date" className={form.ends_on ? undefined : 'date-empty'} value={form.ends_on} onChange={(e) => setForm({ ...form, ends_on: e.target.value })} />
          </Field>
        </>
      )}
      <Field label={t('hall.label')}>
        <HallSelect
          value={form.hall_id}
          onChange={(id) => setForm({ ...form, hall_id: id })}
          allowAll
          allLabel={t('hall.allOpen')}
        />
      </Field>

      {/* 报名费 — an empty fee means free, and everything below it stays out of
          the way. A fee that IS set has to say how to pay it, or the public
          page would ask for a receipt without saying where to send the money. */}
      <Field label={t('trainings.field.fee')}>
        <input
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          value={form.fee}
          onChange={(e) => setForm({ ...form, fee: e.target.value })}
          placeholder={t('trainings.free')}
        />
      </Field>
      {!paid && <div className="hint" style={{ marginBottom: 14 }}>{t('trainings.feeHint')}</div>}
      {paid && (
        <>
          <Field label={t('trainings.field.paymentInstructions')}>
            <textarea
              rows={3}
              value={form.payment_instructions}
              onChange={(e) => setForm({ ...form, payment_instructions: e.target.value })}
              placeholder={t('trainings.paymentInstructionsPlaceholder')}
            />
          </Field>
          <Field label={t('trainings.field.paymentQr')}>
            {initial ? (
              <div className="flex items-center gap-12 flex-wrap">
                {qrUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={qrUrl}
                    alt={t('training.qrAlt')}
                    style={{ width: 72, height: 72, objectFit: 'contain', borderRadius: 8, border: '1px solid var(--border)', background: '#fff' }}
                  />
                )}
                <button className="btn ghost" onClick={() => qrRef.current?.click()} disabled={uploading}>
                  {uploading ? t('trainings.qr.uploading') : qrUrl ? t('trainings.qr.change') : t('trainings.qr.upload')}
                </button>
                {qrUrl && (
                  <button className="btn ghost" onClick={removeQr}>{t('trainings.qr.remove')}</button>
                )}
                <input ref={qrRef} type="file" accept="image/*" onChange={onPickQr} style={{ display: 'none' }} />
              </div>
            ) : (
              // No row yet, so nothing to hang an upload on — the create flow
              // opens the detail page, where Edit offers it.
              <div className="hint">{t('trainings.qr.saveFirst')}</div>
            )}
          </Field>
        </>
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
