'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { compressImage } from '@/lib/imageCompress';
import {
  ErrorBanner,
  Field,
  HallSelect,
  Modal,
  useConfirm,
  useFormGuard,
  useToast,
} from '@/components/ui';
import { useHallScope } from '@/lib/hall';
import { TrainingRow } from '@/lib/types';
import { hasFee, TRAINING_CATEGORY_OPTIONS, trainingCategoryKey } from '@/lib/labels';
import { useT } from '@/lib/i18n';
import { Gender, TrainingKind } from '@tog/shared';

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
 * `kind` is FIXED at creation (0024 retires the course↔activity conversion
 * this form used to offer): the segmented shape picker only shows up while
 * CREATING a row, and an existing row shows its shape as plain read-only
 * text — there is no path left in this form that can change it, which is
 * the point ("easier, and will not confuse").
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
  // Fixed once the row exists (0024) — and there is nothing left in this
  // form that could change it even at creation: the two catalog buttons
  // ("+ Add training" / "+ Add activity") already say which shape, so a
  // second picker inside the form asked the same question the button
  // answer had just answered.
  const kind = initial ? initial.kind : (newKind ?? TrainingKind.Course);
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
    // '' = open to all (stores NULL); a training's gender restriction is
    // meaningfully binary in this church's actual use (兄弟团爬山 / 姐妹团做蛋糕),
    // so "other" is deliberately not an option here even though the column
    // itself is the same gender_type members.gender uses.
    gender: initial?.gender ?? '',
    // An activity's own classification (0027) — never a course's, so it is
    // ignored on save when this row isn't one.
    category: initial?.category ?? '',
    fee: initial?.fee === null || initial?.fee === undefined ? '' : String(initial.fee),
    payment_instructions: initial?.payment_instructions ?? '',
    is_enrollable: initial?.is_enrollable ?? true,
    // Editing keeps the course's own hall; creating defaults to the hall being
    // viewed (and to the open-to-all option only when viewing all halls).
    hall_id: initial ? initial.hall_id : hallId || null,
  });
  // The QR lives on the row, not in the form: it is uploaded straight away
  // like every other image in this app (rule G4) once the row exists. While
  // CREATING there is no row yet, so a picked file waits here — compressed,
  // ready to go — and is chained onto the training the moment it is created.
  const [qrUrl, setQrUrl] = useState(initial?.payment_qr_url ?? null);
  const [qrFile, setQrFile] = useState<File | null>(null);
  const [qrPreview, setQrPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A picked QR file is part of the edit, so it counts towards dirtiness —
  // by name, since a File has no useful JSON form (rule G4).
  const { close } = useFormGuard({ form, qrUrl, qrFile: qrFile?.name ?? null }, onClose);
  const toast = useToast();
  const qrRef = useRef<HTMLInputElement>(null);
  // A fee turns the payment block on. Typed rather than stored, so clearing
  // the field hides it again immediately (rule G5).
  const paid = hasFee(form.fee);

  // The create-mode preview is a local object URL — release it on unmount or
  // whenever a new file replaces it, so a run of picks doesn't leak blobs.
  useEffect(() => () => { if (qrPreview) URL.revokeObjectURL(qrPreview); }, [qrPreview]);

  const save = async () => {
    if (!form.name.trim()) {
      setErr(t('trainings.err.name'));
      return;
    }
    setSaving(true);
    setErr(null);
    const body = {
      name: form.name.trim(),
      // Only a CREATE sends `kind` — an edit never can any more (0024), and
      // the server no longer honours it on PATCH.
      ...(!initial ? { kind } : {}),
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
      gender: form.gender || null,
      // A course clears it too — categorising an activity is meaningless for
      // the other shape, and a stale value from an earlier CREATE attempt
      // (before the shape was picked) must never survive onto a course.
      category: activity ? (form.category || null) : null,
      fee: form.fee.trim(),
      payment_instructions: paid ? form.payment_instructions.trim() : '',
      is_enrollable: form.is_enrollable,
      hall_id: form.hall_id,
    };
    try {
      const saved = initial
        ? await api.patch<TrainingRow>(`/trainings/${initial.id}`, body)
        : await api.post<TrainingRow>('/trainings', body);
      // The QR picked before the row existed — chain it on now. A failure
      // here must not undo the training that was just created; it just needs
      // to be said plainly, so the church knows to add it from Edit.
      if (!initial && qrFile) {
        try {
          const fd = new FormData();
          fd.append('file', qrFile);
          await api.upload<TrainingRow>(`/trainings/${saved.id}/payment-qr`, fd);
        } catch {
          toast(t('trainings.toast.qrFailedAfterCreate', { name: saved.name }), 'error');
        }
      }
      onSaved(saved);
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  // The same upload path a member's photo and the church logo take: straight
  // to the row, so the QR is never half-saved with the form (rule G4) — for
  // an EXISTING row. While creating, there is no row yet: compress and hold
  // the file locally, and `save()` above chains the actual upload once the
  // id exists.
  const onPickQr = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setUploading(true);
    setErr(null);
    try {
      const file = await compressImage(picked);
      if (initial) {
        const fd = new FormData();
        fd.append('file', file);
        const row = await api.upload<TrainingRow>(`/trainings/${initial.id}/payment-qr`, fd);
        setQrUrl(row.payment_qr_url);
        toast(t('trainings.toast.qr'));
      } else {
        setQrFile(file);
        setQrPreview((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(file);
        });
      }
    } catch (e2) {
      setErr((e2 as Error).message);
      toast((e2 as Error).message, 'error');
    } finally {
      setUploading(false);
      if (qrRef.current) qrRef.current.value = '';
    }
  };

  // Discarding a QR picked before the row exists — nothing has left the
  // browser yet, so this is a plain removal rather than a confirmed delete.
  const removePickedQr = () => {
    if (qrPreview) URL.revokeObjectURL(qrPreview);
    setQrFile(null);
    setQrPreview(null);
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
    <Modal title={title} onClose={close}>
      {err && <ErrorBanner message={err} />}
      <Field label={activity ? t('trainings.field.activityName') : t('trainings.field.name')}>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder={activity ? t('trainings.activityNamePlaceholder') : t('trainings.namePlaceholder')}
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
          {/* Where it happens, beside who may come to it — a meeting point
              pairs more naturally with the hall it belongs to than it did
              standing alone. */}
          <div className="form-row">
            <Field label={t('trainings.field.location')}>
              <input
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder={t('trainings.locationPlaceholder')}
              />
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
          {/* An activity's own classification (0027) — never a course's,
              which is why this select only appears in this branch. Fixed,
              short list: a pastor reading a year of these back has to see
              the same handful of words every time, not free text. */}
          <Field label={t('trainings.field.category')}>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="">{t('trainings.category.unset')}</option>
              {TRAINING_CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>{t(trainingCategoryKey(c))}</option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <>
          {/* How many sessions it runs, beside who may come — the two shorter
              fields share a row; the date range gets its own. */}
          <div className="form-row">
            <Field label={t('trainings.field.sessions')}>
              <input type="number" min={1} value={form.total_sessions} onChange={(e) => setForm({ ...form, total_sessions: Number(e.target.value) })} />
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
          <div className="form-row">
            <Field label={t('trainings.field.startsOn')}>
              <input type="date" className={form.starts_on ? undefined : 'date-empty'} value={form.starts_on} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} />
            </Field>
            <Field label={t('trainings.field.endsOn')}>
              <input type="date" className={form.ends_on ? undefined : 'date-empty'} value={form.ends_on} onChange={(e) => setForm({ ...form, ends_on: e.target.value })} />
            </Field>
          </div>
        </>
      )}

      <div className="form-row">
        {/* Who may come — deliberately binary (see the form-state comment
            above); NULL/'' means open to everyone. */}
        <Field label={t('trainings.field.gender')}>
          <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
            <option value="">{t('trainings.gender.any')}</option>
            <option value={Gender.Male}>{t('gender.male')}</option>
            <option value={Gender.Female}>{t('gender.female')}</option>
          </select>
        </Field>
        {/* 报名费 — an empty fee means free, and everything below it stays
            out of the way. A fee that IS set has to say how to pay it, or
            the public page would ask for a receipt without saying where to
            send the money. */}
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
      </div>
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
            {/* Editing an existing row uploads straight away (rule G4);
                creating one has nowhere to upload TO yet, so the picked (and
                already-compressed) file waits here and `save()` chains the
                actual upload onto the row the moment it exists — one action
                from the church's side either way. */}
            <div className="flex items-center gap-12 flex-wrap">
              {(initial ? qrUrl : qrPreview) && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={initial ? qrUrl! : qrPreview!}
                  alt={t('training.qrAlt')}
                  style={{ width: 72, height: 72, objectFit: 'contain', borderRadius: 8, border: '1px solid var(--border)', background: '#fff' }}
                />
              )}
              <button className="btn ghost" onClick={() => qrRef.current?.click()} disabled={uploading}>
                {uploading
                  ? t('trainings.qr.uploading')
                  : (initial ? qrUrl : qrPreview)
                    ? t('trainings.qr.change')
                    : t('trainings.qr.upload')}
              </button>
              {initial
                ? qrUrl && <button className="btn ghost" onClick={removeQr}>{t('trainings.qr.remove')}</button>
                : qrPreview && <button className="btn ghost" onClick={removePickedQr}>{t('trainings.qr.remove')}</button>}
              <input ref={qrRef} type="file" accept="image/*" onChange={onPickQr} style={{ display: 'none' }} />
            </div>
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
        <button className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>
  );
}
