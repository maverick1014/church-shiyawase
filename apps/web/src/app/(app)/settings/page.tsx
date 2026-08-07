'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import {
  Avatar,
  ChevronRightIcon,
  ErrorBanner,
  Field,
  HallSelect,
  InfoPopover,
  Loading,
  Modal,
  PageBar,
  PasswordInput,
  RoleBadge,
  RowChevron,
  SortTh,
  Switch,
  useConfirm,
  useToast,
} from '@/components/ui';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
import { AccountRow, MemberRow } from '@/lib/types';
import {
  ACCOUNT_ROLE_OPTIONS,
  ACCOUNT_ROLE_PERMISSION_KEYS,
  accountRoleClass,
  accountRoleKey,
  accountStatusClass,
  accountStatusKey,
  churchDisplayRole,
  formatDateTime,
  memberRole,
  roleKey,
} from '@/lib/labels';
import { useT } from '@/lib/i18n';
import { AccountRole, AccountStatus, Language, LANGUAGES } from '@tog/shared';
import type { MessageKey } from '@/lib/i18n';

export default function SettingsPage() {
  const t = useT();
  const me = useMe();
  const isSuperAdmin = me.role === AccountRole.SuperAdmin;
  const toast = useToast();
  const accounts = useFetch<AccountRow[]>(isSuperAdmin ? '/accounts' : null);
  const members = useFetch<MemberRow[]>(isSuperAdmin ? '/members' : null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [myPwOpen, setMyPwOpen] = useState(false);

  usePageChrome({ title: t('settings.title') }, [t]);

  const list = accounts.data ?? [];
  const selected = list.find((a) => a.id === detailId) ?? null;

  const { sorted: sortedAccounts, sortKey: acctSortKey, sortDir: acctSortDir, toggleSort: toggleAcctSort } =
    useSortableRows(
      list,
      (u, key) => {
        switch (key) {
          case 'role':
            return u.member ? t(roleKey(churchDisplayRole(u.member.church_role))) : undefined;
          case 'account_role':
            return t(accountRoleKey(u.account_role));
          case 'email':
            return u.email;
          case 'status':
            return t(accountStatusKey(u.status));
          case 'last_login':
            return u.last_sign_in_at ?? undefined;
          default:
            return u.member?.full_name;
        }
      },
      { key: 'name', dir: 'asc' },
    );

  const reload = () => {
    accounts.reload();
  };

  // User management is super_admin-only; others may still change their own password.
  if (!isSuperAdmin) {
    return (
      <>
        <div className="empty">{t('settings.onlySuperAdmin')}</div>
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button className="btn ghost" onClick={() => setMyPwOpen(true)}>{t('settings.changeMyPassword')}</button>
        </div>
        {myPwOpen && (
          <ChangePasswordModal
            onClose={() => setMyPwOpen(false)}
            onSaved={() => {
              setMyPwOpen(false);
              toast(t('settings.toast.passwordChanged'));
            }}
          />
        )}
      </>
    );
  }

  if (accounts.initialLoading) return <Loading />;

  if (selected) {
    return (
      <AccountDetail
        account={selected}
        onBack={() => setDetailId(null)}
        onSaved={() => {
          reload();
          toast(t('settings.toast.saved'));
        }}
        onDeleted={() => {
          setDetailId(null);
          reload();
          toast(t('settings.toast.deleted'));
        }}
      />
    );
  }

  return (
    <>
      <ErrorBanner message={accounts.error} />

      {/* The permission matrix is reference material, so it rides in the action
          row behind an icon rather than pushing the account list down. There is
          no search box: with a handful of accounts it would be furniture. */}
      <PageBar
        actions={
          <>
            <InfoPopover label={t('settings.permissions')}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{t('settings.permissions')}</div>
              {ACCOUNT_ROLE_OPTIONS.map((ar) => (
                <div key={ar} style={{ marginBottom: 12 }}>
                  <span className={`badge ${accountRoleClass(ar)}`}>{t(accountRoleKey(ar))}</span>
                  <ul style={{ margin: '7px 0 0', paddingLeft: 16, fontSize: 12, color: 'var(--muted)', lineHeight: 1.7 }}>
                    {ACCOUNT_ROLE_PERMISSION_KEYS[ar].map((k) => (
                      <li key={k}>{t(k)}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </InfoPopover>
            <button className="btn ghost" onClick={() => setMyPwOpen(true)}>
              {t('settings.changeMyPassword')}
            </button>
            <button className="btn" onClick={() => setAddOpen(true)}>{t('settings.add')}</button>
          </>
        }
      />

      {/* Desktop — table */}
      <div className="card only-desktop" style={{ padding: 6 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh sortKey="name" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>{t('settings.col.account')}</SortTh>
                <SortTh sortKey="role" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>{t('settings.col.churchRole')}</SortTh>
                <SortTh sortKey="account_role" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>{t('settings.col.accountRole')}</SortTh>
                <SortTh sortKey="email" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>{t('settings.col.email')}</SortTh>
                <SortTh sortKey="status" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>{t('members.col.status')}</SortTh>
                <SortTh sortKey="last_login" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>{t('settings.col.lastLogin')}</SortTh>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedAccounts.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.member?.full_name ?? '—'}</strong></td>
                  <td>
                    {u.member ? <RoleBadge role={churchDisplayRole(u.member.church_role)} /> : '—'}
                  </td>
                  <td><span className={`badge ${accountRoleClass(u.account_role)}`}>{t(accountRoleKey(u.account_role))}</span></td>
                  <td className="muted">{u.email}</td>
                  <td><span className={`badge ${accountStatusClass(u.status)}`}>{t(accountStatusKey(u.status))}</span></td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{u.last_sign_in_at ? formatDateTime(u.last_sign_in_at) : t('common.never')}</td>
                  <td style={{ textAlign: 'right' }}>
                    <RowChevron title={t('settings.manageAccount')} onClick={() => setDetailId(u.id)} />
                  </td>
                </tr>
              ))}
              {sortedAccounts.length === 0 && (
                <tr><td colSpan={7} className="empty-inline">{t('settings.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile — list tiles, same pattern as the member and group lists */}
      <div className="only-mobile">
        {sortedAccounts.map((u) => (
          <div key={u.id} className="mtile" onClick={() => setDetailId(u.id)}>
            <div className="mtile-row1">
              <div className="flex items-center gap-8 flex-wrap" style={{ minWidth: 0 }}>
                <strong>{u.member?.full_name ?? '—'}</strong>
                {u.member && <RoleBadge role={churchDisplayRole(u.member.church_role)} />}
              </div>
              <span className="mtile-cta"><ChevronRightIcon /></span>
            </div>
            <div className="mtile-line">{u.email}</div>
            <div className="mtile-line flex items-center gap-8 flex-wrap">
              <span className={`badge ${accountRoleClass(u.account_role)}`}>{t(accountRoleKey(u.account_role))}</span>
              <span className={`badge ${accountStatusClass(u.status)}`}>{t(accountStatusKey(u.status))}</span>
              <span>{u.last_sign_in_at ? formatDateTime(u.last_sign_in_at) : t('settings.neverSignedIn')}</span>
            </div>
          </div>
        ))}
        {sortedAccounts.length === 0 && (
          <div className="empty-inline">{t('settings.empty')}</div>
        )}
      </div>

      {addOpen && (
        <AddAccountModal
          members={members.data ?? []}
          existing={list}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            reload();
            toast(t('settings.toast.created'));
          }}
        />
      )}

      {myPwOpen && (
        <ChangePasswordModal
          onClose={() => setMyPwOpen(false)}
          onSaved={() => {
            setMyPwOpen(false);
            toast(t('settings.toast.passwordChanged'));
          }}
        />
      )}
    </>
  );
}

function NotifyRow({ title, sub, on, set }: { title: string; sub: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="flex-between" style={{ padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div className="muted" style={{ fontSize: 11.5 }}>{sub}</div>
      </div>
      <Switch on={on} onToggle={() => set(!on)} />
    </div>
  );
}

function AccountDetail({
  account,
  onBack,
  onSaved,
  onDeleted,
}: {
  account: AccountRow;
  onBack: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const t = useT();
  // Login email always follows the linked member's own profile — never
  // independently editable — so the two can never drift apart.
  const email = account.member?.email ?? account.email;
  const [role, setRole] = useState<AccountRole>(account.account_role);
  // null = full access (may see and manage every hall).
  const [hall, setHall] = useState<string | null>(account.hall_id ?? null);
  const [status, setStatus] = useState<AccountStatus>(account.status);
  const [language, setLanguage] = useState(account.language);
  const [nDisc, setNDisc] = useState(account.notify_discipleship);
  const [nWeekly, setNWeekly] = useState(account.notify_weekly);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const resetPassword = async () => {
    if (pw.length < 8) {
      setErr(t('password.err.tooShort'));
      return;
    }
    setPwBusy(true);
    setErr(null);
    try {
      await api.post(`/accounts/${account.id}/password`, { password: pw });
      setPw('');
      toast(
        t('settings.toast.passwordResetFor', {
          name: account.member?.full_name ?? t('settings.thisAccount'),
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setPwBusy(false);
    }
  };

  const del = async () => {
    const ok = await confirm({
      title: t('settings.delete.title'),
      message: t('settings.delete.message', {
        name: account.member?.full_name ?? t('settings.thisAccount'),
      }),
      confirmText: t('settings.deleteAccount'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/accounts/${account.id}`);
      onDeleted();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    }
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/accounts/${account.id}`, {
        account_role: role,
        hall_id: hall,
        status,
        language,
        notify_discipleship: nDisc,
        notify_weekly: nWeekly,
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <button className="back-btn" onClick={onBack}>{t('settings.back')}</button>
      {err && <ErrorBanner message={err} />}

      <div className="card">
        <div className="flex items-center gap-12 flex-wrap">
          <Avatar name={account.member?.full_name ?? null} size="lg" />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="flex items-center gap-10 flex-wrap">
              <h2 style={{ margin: 0, fontSize: 20 }} className="serif">{account.member?.full_name}</h2>
              <span className={`badge ${accountRoleClass(role)}`}>{t(accountRoleKey(role))}</span>
              {account.member && <RoleBadge role={churchDisplayRole(account.member.church_role)} />}
            </div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
              {t('settings.linkedTo', { email: account.email })}
            </div>
          </div>
          {account.member && (
            <button className="btn ghost" onClick={() => router.push(`/members/${account.member!.id}`)}>
              {t('settings.viewMemberProfile')}
            </button>
          )}
        </div>

        <div className="grid g2" style={{ marginTop: 18 }}>
          <Field label={t('settings.emailFromMember')}>
            <input value={email} readOnly disabled style={{ color: 'var(--muted)' }} />
          </Field>
          <Field label={t('settings.col.accountRole')}>
            <select value={role} onChange={(e) => setRole(e.target.value as AccountRole)}>
              {ACCOUNT_ROLE_OPTIONS.map((ar) => (
                <option key={ar} value={ar}>{t(accountRoleKey(ar))}</option>
              ))}
            </select>
          </Field>
          <Field label={t('hall.label')}>
            <HallSelect value={hall} onChange={setHall} allowAll allLabel={t('hall.unlimited')} />
          </Field>
          <div className="hint" style={{ gridColumn: '1 / -1' }}>{t('settings.hallHint')}</div>
          <div style={{ gridColumn: '1 / -1' }} className="flex-between" >
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '11px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.accountStatus')}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{t('settings.accountStatusSub')}</div>
              </div>
              <Switch
                on={status === AccountStatus.Active}
                onToggle={() => setStatus(status === AccountStatus.Active ? AccountStatus.Disabled : AccountStatus.Active)}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="grid g2 mt-16">
        <div className="card">
          <h3 style={{ marginBottom: 4 }}>{t('settings.security')}</h3>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>{t('settings.resetHint')}</div>
          <Field label={t('settings.newPassword')}>
            <PasswordInput value={pw} onChange={setPw} placeholder={t('settings.passwordHint')} autoComplete="new-password" />
          </Field>
          <button className="btn ghost block" onClick={resetPassword} disabled={pwBusy || pw.length < 8}>
            {pwBusy ? t('settings.resetting') : t('settings.resetPassword')}
          </button>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 14 }}>{t('settings.preferences')}</h3>
          <Field label={t('settings.language')}>
            {/* The options come from the shipped dictionaries, so a language can
                never be selected that the app has no translations for. */}
            <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
              {LANGUAGES.map((code) => (
                <option key={code} value={code}>{t(`language.${code}` as MessageKey)}</option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      {/* Notifications are hidden until email/push delivery is actually
          implemented — the toggles didn't send anything, just stored a flag. */}

      <div className="card flex-between flex-wrap mt-16">
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--crit)' }}>{t('settings.deleteAccount')}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>{t('settings.deleteAccountSub')}</div>
        </div>
        <button className="btn danger" onClick={del}>{t('settings.deleteAccount')}</button>
      </div>

      <div className="flex-between flex-wrap mt-16">
        <button className="btn ghost" onClick={onBack}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? t('common.saving') : t('settings.saveAccount')}</button>
      </div>
    </div>
  );
}

function AddAccountModal({
  members,
  existing,
  onClose,
  onSaved,
}: {
  members: MemberRow[];
  existing: AccountRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const takenMembers = new Set(existing.map((a) => a.member_id));
  const [memberId, setMemberId] = useState('');
  const [role, setRole] = useState<AccountRole>(AccountRole.Coworker);
  // null = full access (every hall).
  const [hall, setHall] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selectedMember = members.find((m) => m.id === memberId) ?? null;
  // The login email always follows the member's own profile — never a
  // separately typed value — so the two can never drift apart.
  const email = selectedMember?.email ?? '';

  const save = async () => {
    if (!memberId) {
      setErr(t('settings.err.member'));
      return;
    }
    if (!email) {
      setErr(t('settings.noEmailWarning'));
      return;
    }
    if (password.length < 8) {
      setErr(t('settings.err.password'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api.post('/accounts', {
        member_id: memberId,
        email,
        account_role: role,
        hall_id: hall,
        password,
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('settings.new.title')} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <p className="muted" style={{ margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.6 }}>
        {t('settings.new.intro')}
      </p>
      <Field label={t('settings.linkMember')}>
        <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
          <option value="">{t('settings.chooseMember')}</option>
          {members
            .filter((m) => !takenMembers.has(m.id))
            .map((m) => (
              <option key={m.id} value={m.id}>
                {t('disc.memberOption', { name: m.full_name, role: t(roleKey(memberRole(m))) })}
              </option>
            ))}
        </select>
      </Field>
      <div className="form-row">
        <Field label={t('settings.emailFromMember')}>
          <input value={email} readOnly disabled placeholder={t('settings.noEmailPlaceholder')} style={{ color: 'var(--muted)' }} />
        </Field>
        <Field label={t('settings.col.accountRole')}>
          <select value={role} onChange={(e) => setRole(e.target.value as AccountRole)}>
            {ACCOUNT_ROLE_OPTIONS.map((ar) => (
              <option key={ar} value={ar}>{t(accountRoleKey(ar))}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={t('hall.label')}>
        <HallSelect value={hall} onChange={setHall} allowAll allLabel={t('hall.unlimited')} />
      </Field>
      {memberId && !email && (
        <div className="hint" style={{ marginBottom: 14 }}>{t('settings.noEmailWarning')}</div>
      )}
      <Field label={t('settings.initialPassword')}>
        <PasswordInput value={password} onChange={setPassword} placeholder={t('settings.initialPasswordHint')} autoComplete="new-password" />
      </Field>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving || !memberId || !email}>{saving ? t('common.saving') : t('settings.create')}</button>
      </div>
    </Modal>
  );
}
