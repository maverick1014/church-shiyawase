'use client';

import { useState } from 'react';
import { copyText } from '@/lib/clipboard';
import { useT } from '@/lib/i18n';
import type { LeaderAccountEvent } from '@/lib/types';
import { Modal, useToast } from './ui';

/**
 * Shared handling for a `leader_account_event` that rides in on a member
 * write's response (rule G4) — every call site that can promote/demote a
 * 小组长 uses this ONE hook rather than re-rolling the three-way branch:
 * `MemberEditModal` (used by both the member-detail page and the groups
 * roster's edit button), the groups roster's own leadership picker, and the
 * add-member form.
 *
 * `created` is shown in a MODAL, never a toast — a toast disappears before
 * anyone could copy a password off it, and this is the ONE place this
 * plaintext is ever shown (rule G6). `disabled` / `skipped_no_email` are
 * toasts: nothing on either needs to be copied.
 */
export function useLeaderAccountEvent() {
  const t = useT();
  const toast = useToast();
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  const handleLeaderAccountEvent = (event: LeaderAccountEvent | undefined, memberName?: string) => {
    if (!event) return;
    if (event.event === 'created') {
      setCreated({ email: event.email, password: event.password });
    } else if (event.event === 'disabled') {
      toast(t('leaderAccount.toast.disabled', { name: memberName ?? event.email }));
    } else if (event.event === 'skipped_no_email') {
      toast(t('leaderAccount.toast.noEmail', { name: memberName ?? '' }), 'error');
    }
  };

  const leaderAccountModal = created ? (
    <LeaderAccountCreatedModal
      email={created.email}
      password={created.password}
      onClose={() => setCreated(null)}
    />
  ) : null;

  return { handleLeaderAccountEvent, leaderAccountModal };
}

function LeaderAccountCreatedModal({
  email,
  password,
  onClose,
}: {
  email: string;
  password: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();

  const copy = async () => {
    const text = `${email} / ${password}`;
    const ok = await copyText(text);
    if (ok) toast(t('leaderAccount.modal.copied'));
    else toast(t('common.copyFailed', { link: text }), 'error');
  };

  return (
    <Modal title={t('leaderAccount.modal.title')} onClose={onClose}>
      <p style={{ fontSize: 13, lineHeight: 1.7, marginTop: 0 }}>{t('leaderAccount.modal.body')}</p>
      <div
        className="card"
        style={{ background: 'var(--surface-2)', padding: 14, display: 'grid', gap: 10, marginBottom: 12 }}
      >
        <div>
          <div className="muted" style={{ fontSize: 12 }}>{t('leaderAccount.modal.email')}</div>
          <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>{email}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>{t('leaderAccount.modal.password')}</div>
          <div style={{ fontWeight: 600, fontFamily: 'monospace', letterSpacing: 0.5 }}>{password}</div>
        </div>
      </div>
      <div className="hint" style={{ marginBottom: 14 }}>{t('leaderAccount.modal.warning')}</div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={copy}>{t('leaderAccount.modal.copy')}</button>
        <button className="btn" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Modal>
  );
}
