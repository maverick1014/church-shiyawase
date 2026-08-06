'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner, Field, Modal, PasswordInput, useToast } from './ui';
import { useT } from '@/lib/i18n';

/** Self-service password change — any logged-in user; verifies the current password. */
export function ChangePasswordModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (next.length < 8) return setErr(t('password.err.tooShort'));
    if (next !== confirmPw) return setErr(t('password.err.mismatch'));
    setSaving(true);
    setErr(null);
    try {
      await api.post('/auth/password', { current, password: next });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('password.title')} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <Field label={t('password.current')}>
        <PasswordInput value={current} onChange={setCurrent} autoComplete="current-password" />
      </Field>
      <Field label={t('password.new')}>
        <PasswordInput value={next} onChange={setNext} placeholder={t('settings.passwordHint')} autoComplete="new-password" />
      </Field>
      <Field label={t('password.confirm')}>
        <PasswordInput value={confirmPw} onChange={setConfirmPw} autoComplete="new-password" />
      </Field>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('password.update')}</button>
      </div>
    </Modal>
  );
}
