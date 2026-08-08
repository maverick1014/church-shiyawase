'use client';

import { useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { usePageChrome } from '@/components/AppShell';
import {
  Avatar,
  EntityHeader,
  ErrorBanner,
  FactGrid,
  Field,
  Loading,
  Modal,
  RoleBadge,
  useConfirm,
  useToast,
} from '@/components/ui';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
import { MemberRow, SelfProfile } from '@/lib/types';
import {
  accountRoleClass,
  accountRoleKey,
  accountStatusClass,
  accountStatusKey,
  churchDisplayRole,
  formatDate,
  formatDateTime,
  genderKey,
  GENDER_OPTIONS,
} from '@/lib/labels';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n';
import { Gender, Language, LANGUAGES } from '@tog/shared';

/**
 * 我的资料 — the one page every signed-in account can open, whatever its role,
 * and the only page a `readonly` account may write on. It reads and writes
 * `/auth/me/profile`, which derives "me" from the session cookie and accepts
 * only the member fields plus the interface language: the permission role,
 * congregation and account status are shown here but refused by the server if
 * sent back, so this page can never become a self-promotion path (rule G2).
 *
 * The member fields live here rather than behind a link to /members/[id]
 * because a read-only account has no way to edit them there — and because a
 * member without an email could not be given a login at all, which is exactly
 * the field this page lets them fill in themselves.
 */
export default function MyProfilePage() {
  const t = useT();
  const toast = useToast();
  const profile = useFetch<SelfProfile>('/auth/me/profile');
  const [editOpen, setEditOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  usePageChrome({ title: t('profile.title') }, [t]);

  if (profile.initialLoading) return <Loading />;
  if (profile.error || !profile.data)
    return <ErrorBanner message={profile.error ?? t('profile.notFound')} />;

  const p = profile.data;
  const m = p.member;

  const details = [
    { label: t('profile.field.loginEmail'), value: p.email },
    { label: t('members.field.phone'), value: m?.phone ?? '—' },
    { label: t('member.field.gender'), value: m?.gender ? t(genderKey(m.gender)) : '—' },
    { label: t('member.field.birthday'), value: formatDate(m?.date_of_birth) },
    { label: t('members.col.group'), value: m?.group?.name ?? t('members.filter.ungrouped') },
    { label: t('member.field.joined'), value: formatDate(m?.joined_at) },
    { label: t('settings.language'), value: t(`language.${p.language}` as MessageKey) },
    {
      label: t('profile.field.lastLogin'),
      value: p.last_sign_in_at ? formatDateTime(p.last_sign_in_at) : t('common.never'),
    },
  ];

  // Set by an administrator, never by the owner — shown so the user knows what
  // they have, with the hint below explaining who can change it.
  const account = [
    {
      label: t('settings.col.accountRole'),
      value: (
        <span className={`badge ${accountRoleClass(p.account_role)}`}>
          {t(accountRoleKey(p.account_role))}
        </span>
      ),
    },
    { label: t('hall.label'), value: p.hall?.name ?? t('hall.unlimited') },
    {
      label: t('settings.accountStatus'),
      value: (
        <span className={`badge ${accountStatusClass(p.status)}`}>
          {t(accountStatusKey(p.status))}
        </span>
      ),
    },
  ];

  return (
    <>
      <div className="card">
        <EntityHeader
          avatar={<Avatar name={m?.full_name ?? p.email} url={m?.avatar_url} size="passport" />}
          title={m?.full_name ?? p.email}
          badges={
            <>
              <span className={`badge ${accountRoleClass(p.account_role)}`}>
                {t(accountRoleKey(p.account_role))}
              </span>
              {m && <RoleBadge role={churchDisplayRole(m.church_role)} />}
            </>
          }
          sub={t('profile.signedInAs', { email: p.email })}
          actions={
            <>
              {m && (
                <button className="btn" onClick={() => setEditOpen(true)}>
                  {t('profile.edit')}
                </button>
              )}
              <button className="btn ghost" onClick={() => setPwOpen(true)}>
                {t('password.title')}
              </button>
            </>
          }
        />

        {!m && <div className="hint" style={{ marginTop: 16 }}>{t('profile.noMember')}</div>}

        <div className="section-label" style={{ margin: '24px 0 12px' }}>{t('profile.myDetails')}</div>
        <FactGrid facts={details} />

        <div className="section-label" style={{ margin: '24px 0 12px' }}>{t('profile.account')}</div>
        <FactGrid facts={account} />
        <div className="hint" style={{ marginTop: 12 }}>{t('profile.adminHint')}</div>
      </div>

      {editOpen && m && (
        <EditMyProfileModal
          profile={p}
          member={m}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            profile.reload();
            toast(t('profile.toast.saved'));
          }}
        />
      )}

      {pwOpen && (
        <ChangePasswordModal
          onClose={() => setPwOpen(false)}
          onSaved={() => {
            setPwOpen(false);
            toast(t('settings.toast.passwordChanged'));
          }}
        />
      )}
    </>
  );
}

/**
 * Every field on this form is on the server's self-service allow-list. Anything
 * else — role, congregation, status — is refused with a 403 there, so the form
 * simply has no control for it.
 */
function EditMyProfileModal({
  profile,
  member,
  onClose,
  onSaved,
}: {
  profile: SelfProfile;
  member: MemberRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState({
    full_name: member.full_name ?? '',
    chinese_name: member.chinese_name ?? '',
    email: member.email ?? profile.email,
    phone: member.phone ?? '',
    gender: member.gender ?? '',
    date_of_birth: member.date_of_birth ?? '',
    language: profile.language,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!form.full_name.trim()) return setErr(t('members.err.name'));
    // The address is the sign-in name, so it may be changed but never cleared.
    if (!form.email.trim()) return setErr(t('profile.err.email'));
    // The interface language is read once, at page load (`/auth/me`), so the
    // strings already on screen stay in the old language until a reload — offer
    // one, but only when the language actually changed (same as 用户管理).
    const languageChanged = form.language !== profile.language;
    setSaving(true);
    setErr(null);
    let saved = false;
    try {
      await api.patch('/auth/me/profile', {
        full_name: form.full_name.trim(),
        chinese_name: form.chinese_name || null,
        email: form.email.trim(),
        phone: form.phone || null,
        gender: form.gender || null,
        date_of_birth: form.date_of_birth || null,
        language: form.language,
      });
      saved = true;
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
    if (!saved || !languageChanged) return;
    const reloadNow = await confirm({
      title: t('settings.language.reload.title'),
      message: t('settings.language.reload.message'),
      confirmText: t('settings.language.reload.confirm'),
      cancelText: t('settings.language.reload.later'),
    });
    if (reloadNow) window.location.reload();
    else toast(t('settings.language.reload.toast'));
  };

  return (
    <Modal title={t('profile.edit.title')} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <div className="form-row">
        <Field label={t('members.field.name')}>
          <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </Field>
        <Field label={t('members.field.nickname')}>
          <input value={form.chinese_name} onChange={(e) => setForm({ ...form, chinese_name: e.target.value })} />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('profile.field.loginEmail')}>
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            autoComplete="email"
          />
        </Field>
        <Field label={t('members.field.phone')}>
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
      </div>
      <div className="hint" style={{ marginBottom: 14 }}>{t('profile.emailHint')}</div>
      <div className="form-row">
        <Field label={t('member.field.gender')}>
          <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value as Gender | '' })}>
            <option value="">{t('common.unset')}</option>
            {GENDER_OPTIONS.map((g) => (
              <option key={g} value={g}>{t(genderKey(g))}</option>
            ))}
          </select>
        </Field>
        <Field label={t('member.field.birthday')}>
          <input
            type="date"
            className={form.date_of_birth ? undefined : 'date-empty'}
            value={form.date_of_birth}
            onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
          />
        </Field>
      </div>
      <Field label={t('settings.language')}>
        <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value as Language })}>
          {LANGUAGES.map((code) => (
            <option key={code} value={code}>{t(`language.${code}` as MessageKey)}</option>
          ))}
        </select>
      </Field>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>
  );
}
